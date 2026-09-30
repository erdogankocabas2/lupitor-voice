"""LiveKit worker. One worker ('lupitor-agent') serves every agent in the platform.

Dispatch metadata (set by the web app for outbound and browser calls):
  {"call_id", "agent_version_id", "account_id", "direction": "outbound"|"browser", "phone"}
Inbound SIP calls arrive with no metadata: the worker uses the agent marked
"handles inbound" and looks the caller up by phone number.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from typing import Optional

from dotenv import load_dotenv
from livekit import api, rtc
from livekit.agents import AgentSession, JobContext, JobProcess, RoomInputOptions, WorkerOptions, cli
from livekit.plugins import noise_cancellation, silero
from livekit.plugins.turn_detector.multilingual import MultilingualModel

from core.config import AgentConfig
from core.db import Database, EventSink, normalize_phone, now_iso
from core.toolkit import CollectionsToolkit
from flows.collections import CallState, VerificationAgent
from flows.generic import GenericAgent

load_dotenv()
log = logging.getLogger("worker")
AGENT_NAME = os.getenv("AGENT_NAME", "lupitor-agent")


def prewarm(proc: JobProcess):
    proc.userdata["vad"] = silero.VAD.load()


def _meta(ctx: JobContext) -> dict:
    try:
        return json.loads(ctx.job.metadata or "{}")
    except json.JSONDecodeError:
        return {}


async def _db(fn, *a, **kw):
    return await asyncio.to_thread(fn, *a, **kw)


async def start_recording(ctx: JobContext, call_id: str) -> Optional[str]:
    bucket = os.getenv("RECORDING_S3_BUCKET")
    if not bucket:
        return None
    path = f"calls/{call_id}.ogg"
    try:
        await ctx.api.egress.start_room_composite_egress(api.RoomCompositeEgressRequest(
            room_name=ctx.room.name, audio_only=True,
            file_outputs=[api.EncodedFileOutput(
                file_type=api.EncodedFileType.OGG, filepath=path,
                s3=api.S3Upload(
                    bucket=bucket, region=os.getenv("RECORDING_S3_REGION", ""),
                    access_key=os.environ["RECORDING_S3_ACCESS_KEY"], secret=os.environ["RECORDING_S3_SECRET"],
                    endpoint=os.getenv("RECORDING_S3_ENDPOINT", ""), force_path_style=True,
                ),
            )],
        ))
        return path
    except Exception:
        log.exception("recording could not be started")
        return None


async def entrypoint(ctx: JobContext):
    meta = _meta(ctx)
    db = Database.from_env()
    direction = meta.get("direction") or "inbound"
    call_id: Optional[str] = meta.get("call_id")
    sink = EventSink(db, call_id)
    sink.start()
    await ctx.connect()

    # ---- resolve agent version -------------------------------------------------
    version_row = await _db(db.get_version, meta["agent_version_id"]) if meta.get("agent_version_id") else None
    agent_row = None
    if version_row:
        agent_row = await _db(db.get_agent, version_row["agent_id"])
    else:
        agent_row = await _db(db.get_inbound_agent)
        version_row = await _db(db.pick_version, agent_row["id"]) if agent_row else None
    template = (agent_row or {}).get("template", "collections")
    cfg = AgentConfig.from_row(version_row, template) if version_row else AgentConfig.fallback()

    # ---- resolve account ---------------------------------------------------------
    account = await _db(db.get_account, meta["account_id"]) if meta.get("account_id") else None
    caller: Optional[rtc.RemoteParticipant] = None
    if direction == "inbound":
        caller = await ctx.wait_for_participant()
        number = caller.attributes.get("sip.phoneNumber", "")
        account = await _db(db.find_account_by_phone, number)
        call_id = await _db(db.create_call, agent_id=cfg.agent_id, agent_version_id=cfg.version_id,
                            account_id=account.id if account else None, room_name=ctx.room.name,
                            direction="inbound", source="live", phone=normalize_phone(number),
                            status="in_progress", started_at=now_iso(), answered_at=now_iso())
        sink.call_id = call_id

    # ---- compliance gate (authoritative; the web app checks too) ---------------------
    if direction == "outbound":
        allowed, reason = await _db(db.can_contact, account.id)
        if not allowed:
            await _db(db.update_call, call_id, status="blocked", blocked_reason=reason, ended_at=now_iso())
            sink.emit("state", {"blocked": reason})
            await sink.close()
            ctx.shutdown(reason)
            return

    started = time.monotonic()
    sink.emit("state", {"agent_version": cfg.version, "template": template, "direction": direction})

    # ---- build agent ---------------------------------------------------------------
    greet_now = direction != "outbound"  # outbound greets only after the callee answers
    toolkit: Optional[CollectionsToolkit] = None
    if template == "collections":
        toolkit = CollectionsToolkit(cfg, account, db.get_policy, db.find_account_by_phone, sink.emit)
        state = CallState(toolkit=toolkit, cfg=cfg, direction=direction, sink=sink,
                          caller_identity=caller.identity if caller else None)
        agent = VerificationAgent(state, greet=greet_now)

        @ctx.room.on("sip_dtmf_received")
        def _on_dtmf(ev: rtc.SipDTMF):
            state.keypad.push(ev.digit)

        @ctx.room.on("data_received")
        def _on_data(packet: rtc.DataPacket):
            if packet.topic == "dtmf":
                state.keypad.push(packet.data.decode(errors="ignore")[:1])
    else:
        agent = GenericAgent(cfg, sink, greet=greet_now)

    session = AgentSession(
        stt=cfg.stt, llm=cfg.llm, tts=cfg.tts,
        vad=ctx.proc.userdata["vad"],
        turn_detection=MultilingualModel(),
        preemptive_generation=True,
    )

    # ---- observability -------------------------------------------------------------
    @session.on("conversation_item_added")
    def _on_item(ev):
        item = ev.item
        role, text = getattr(item, "role", None), getattr(item, "text_content", None)
        if role in ("user", "assistant") and text:
            sink.emit("transcript", {"role": role, "text": text, "interrupted": bool(getattr(item, "interrupted", False))})

    @session.on("function_tools_executed")
    def _on_tools(ev):
        for call, output in ev.zipped():
            sink.emit("tool", {"name": call.name, "arguments": call.arguments,
                               "output": (output.output if output else None)})

    @session.on("metrics_collected")
    def _on_metrics(ev):
        m = ev.metrics
        kind = type(m).__name__
        value = {
            "LLMMetrics": getattr(m, "ttft", None),
            "TTSMetrics": getattr(m, "ttfb", None),
            "EOUMetrics": getattr(m, "end_of_utterance_delay", None),
        }.get(kind)
        if value is not None and value >= 0:
            sink.emit("metric", {"kind": kind, "ms": round(value * 1000)})

    final = {"status": "completed"}

    async def finalize(reason: str = ""):
        if final["status"] != "completed":  # dial failure already recorded
            await sink.close()
            return
        summary = toolkit.summary() if toolkit else {"outcome": "completed"}
        fields = dict(status="completed", ended_at=now_iso(), duration_seconds=int(time.monotonic() - started),
                      outcome=summary.get("outcome"), verified=summary.get("verified"), summary=summary)
        try:
            await _db(db.update_call, call_id, **fields)
            arr = toolkit.result.arrangement if toolkit else None
            if arr:
                await _db(db.insert_arrangement, call_id=call_id, account_id=toolkit.account.id,
                          offer_id=arr.offer_id, kind=arr.kind, total=str(arr.total),
                          installments=arr.installments, installment_amount=str(arr.installment_amount),
                          first_due=arr.first_due.isoformat())
        finally:
            await sink.close()

    ctx.add_shutdown_callback(finalize)

    nc = noise_cancellation.BVC() if direction == "browser" else noise_cancellation.BVCTelephony()
    session_started = asyncio.create_task(
        session.start(room=ctx.room, agent=agent, room_input_options=RoomInputOptions(noise_cancellation=nc))
    )

    # ---- outbound dialing ---------------------------------------------------------------
    if direction == "outbound":
        await _db(db.update_call, call_id, status="dialing", started_at=now_iso())
        try:
            await ctx.api.sip.create_sip_participant(api.CreateSIPParticipantRequest(
                room_name=ctx.room.name, sip_trunk_id=os.environ["SIP_OUTBOUND_TRUNK_ID"],
                sip_call_to=meta["phone"], participant_identity="callee",
                wait_until_answered=True,
            ))
        except api.TwirpError as e:
            code = (e.metadata or {}).get("sip_status_code", "")
            status = "no_answer" if code in ("408", "480", "486", "487", "603") else "failed"
            final["status"] = status
            await _db(db.update_call, call_id, status=status, ended_at=now_iso(),
                      outcome=status, summary={"sip_status": code, "error": e.message})
            session_started.cancel()
            ctx.shutdown(status)
            return
        await session_started
        caller = await ctx.wait_for_participant(identity="callee")
        if template == "collections":
            state.caller_identity = caller.identity
        await _db(db.update_call, call_id, status="in_progress", answered_at=now_iso())
        await agent.greet()
    else:
        await session_started
        if direction == "browser":
            await _db(db.update_call, call_id, status="in_progress", started_at=now_iso(), answered_at=now_iso())

    path = await start_recording(ctx, call_id)
    if path:
        await _db(db.update_call, call_id, recording_path=path)


if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint, prewarm_fnc=prewarm, agent_name=AGENT_NAME))
