"""LiveKit runtime for the Goldman Stanley collection flow.

Two agents, one per stage. The negotiation tools do not exist until identity is
verified, and every sentence the LLM produces passes through ResponseGuard
inside llm_node, before TTS *and* before the transcript/chat history.
"""
from __future__ import annotations

import asyncio
import logging
import os
from dataclasses import dataclass, field
from typing import Literal, Optional

from livekit import api
from livekit.agents import Agent, RunContext, function_tool, get_job_context, llm

from core import prompts
from core.config import AgentConfig
from core.db import EventSink
from core.guard import ResponseGuard, SentenceBuffer
from core.toolkit import CollectionsToolkit, ToolResult

log = logging.getLogger("collections")


class KeypadBuffer:
    """Collects DTMF digits (phone) or keypad data messages (browser test page).
    Digits go straight to the verifier and never enter the LLM context."""

    def __init__(self) -> None:
        self._digits: list[str] = []
        self._done = asyncio.Event()
        self._active = False

    def push(self, key: str) -> None:
        if not self._active:
            return
        if key == "#":
            self._done.set()
        elif key.isdigit():
            self._digits.append(key)
            if len(self._digits) >= 4:
                self._done.set()

    async def collect(self, n: int = 4, timeout: float = 25.0) -> Optional[str]:
        self._digits, self._active = [], True
        self._done.clear()
        try:
            await asyncio.wait_for(self._done.wait(), timeout)
        except asyncio.TimeoutError:
            pass
        finally:
            self._active = False
        value = "".join(self._digits[:n])
        return value if len(value) == n else None


@dataclass
class CallState:
    toolkit: CollectionsToolkit
    cfg: AgentConfig
    direction: str
    sink: EventSink
    keypad: KeypadBuffer = field(default_factory=KeypadBuffer)
    caller_identity: Optional[str] = None
    background: set = field(default_factory=set)


async def hang_up() -> None:
    ctx = get_job_context()
    await ctx.api.room.delete_room(api.DeleteRoomRequest(room=ctx.room.name))


class GuardedAgent(Agent):
    def __init__(self, *, state: CallState, instructions: str, chat_ctx=None):
        super().__init__(instructions=instructions, chat_ctx=chat_ctx)
        self.state = state
        self._guard = ResponseGuard(state.toolkit.allowed_amounts, lambda: state.toolkit.verified)

    # -- output guard -----------------------------------------------------------
    def _screen(self, sentence: str) -> str:
        decision = self._guard.check(sentence)
        if not decision.ok:
            self.state.sink.emit("guard", {"original": decision.original, "replacement": decision.text,
                                           "reasons": decision.reasons, "stage": type(self).__name__})
        return decision.text

    async def llm_node(self, chat_ctx, tools, model_settings):
        buf = SentenceBuffer()
        async for chunk in Agent.default.llm_node(self, chat_ctx, tools, model_settings):
            if isinstance(chunk, str):
                for s in buf.push(chunk):
                    yield self._screen(s)
                continue
            if isinstance(chunk, llm.ChatChunk) and chunk.delta is not None:
                if chunk.delta.content:
                    for s in buf.push(chunk.delta.content):
                        yield self._screen(s)
                if chunk.delta.tool_calls:
                    yield llm.ChatChunk(
                        id=chunk.id,
                        delta=llm.ChoiceDelta(role="assistant", content=None, tool_calls=chunk.delta.tool_calls),
                        usage=chunk.usage,
                    )
                elif chunk.usage is not None:
                    yield llm.ChatChunk(id=chunk.id, usage=chunk.usage)
                continue
            yield chunk
        tail = buf.flush()
        if tail.strip():
            yield self._screen(tail)

    # -- runtime side effects of a ToolResult -----------------------------------------
    def _spawn(self, coro) -> None:
        task = asyncio.create_task(coro)
        self.state.background.add(task)
        task.add_done_callback(self.state.background.discard)

    def apply(self, res: ToolResult):
        """Speak scripts verbatim, then hang up or transfer in the background so the
        tool returns immediately (awaiting new speech inside a tool would deadlock)."""
        handle = self.session.say(res.script, allow_interruptions=False) if res.script else None
        if res.end_call:
            self._spawn(self._finish(handle, res.transfer))
            return None  # no further LLM turn
        return res.message

    async def _finish(self, handle, transfer: bool) -> None:
        if handle is not None:
            await handle
        await asyncio.sleep(0.5)
        number = os.getenv("HUMAN_TRANSFER_NUMBER")
        if transfer and number and self.state.caller_identity and self.state.direction != "browser":
            try:
                ctx = get_job_context()
                await ctx.api.sip.transfer_sip_participant(api.TransferSIPParticipantRequest(
                    room_name=ctx.room.name, participant_identity=self.state.caller_identity,
                    transfer_to=f"tel:{number}", play_dialtone=False,
                ))
                self.state.sink.emit("state", {"transfer": "completed"})
                return
            except Exception as e:  # fall through to hang up
                self.state.sink.emit("state", {"transfer": "failed", "error": str(e)[:200]})
        await hang_up()

    # -- tools shared by both stages ----------------------------------------------------
    @function_tool()
    async def escalate_to_human(
        self,
        context: RunContext,
        reason: Literal["hardship", "dispute", "identity_theft", "attorney", "cease_contact", "requested_human", "other"],
        notes: str = "",
    ):
        """Stop the collection flow and hand the customer to a person.

        Args:
            reason: Why the call is being escalated.
            notes: One short sentence of context for the specialist.
        """
        return self.apply(self.state.toolkit.escalate(reason, notes))

    @function_tool()
    async def end_call(self, context: RunContext, outcome: str = "completed"):
        """End the call after you have said goodbye.

        Args:
            outcome: Short outcome label, e.g. promise_to_pay, no_agreement, callback_requested.
        """
        self.state.toolkit.end_call(outcome)
        await context.wait_for_playout()
        self._spawn(hang_up())
        return None


class VerificationAgent(GuardedAgent):
    def __init__(self, state: CallState, greet: bool):
        tk = state.toolkit
        super().__init__(state=state, instructions=prompts.verification_instructions(
            state.cfg, tk.account, inbound=state.direction == "inbound"))
        self._greet_on_enter = greet

    async def on_enter(self):
        if self._greet_on_enter:
            await self.greet()

    async def greet(self):
        self.state.sink.emit("state", {"stage": "verification"})
        tk = self.state.toolkit
        if tk.account and self.state.direction == "outbound":
            self.session.say(prompts.greeting_outbound(self.state.cfg, tk.account))
        else:
            self.session.say(prompts.greeting_inbound(self.state.cfg))
            self.session.generate_reply(instructions="Ask for their date of birth to begin verification.")

    def _after_verify(self, res: ToolResult):
        if res.handoff == "negotiation":
            return NegotiationAgent(self.state, disclosure=res.script, chat_ctx=self.chat_ctx), "Identity verified."
        return self.apply(res)

    @function_tool()
    async def lookup_account(self, context: RunContext, phone_number: str):
        """Find the customer's account from the phone number on the account (inbound calls only).

        Args:
            phone_number: Phone number in international format, e.g. +15550100001.
        """
        return self.state.toolkit.lookup_account(phone_number).message

    @function_tool()
    async def verify_identity(self, context: RunContext, date_of_birth: str, zip_code: str):
        """Verify the caller with date of birth and billing ZIP code.

        Args:
            date_of_birth: Date of birth as YYYY-MM-DD.
            zip_code: Five-digit billing ZIP code.
        """
        return self._after_verify(self.state.toolkit.verify_identity(date_of_birth, zip_code=zip_code))

    @function_tool()
    async def verify_identity_with_keypad(self, context: RunContext, date_of_birth: str):
        """Verify with date of birth plus the last four SSN digits the caller types on the keypad.
        Call this right after asking them to type the digits.

        Args:
            date_of_birth: Date of birth as YYYY-MM-DD.
        """
        await context.wait_for_playout()
        self.state.sink.emit("dtmf", {"status": "collecting"})
        entered = await self.state.keypad.collect(4, timeout=25)
        self.state.sink.emit("dtmf", {"status": "received" if entered else "timeout"})
        if not entered:
            return "No keypad digits were received. Offer to verify with ZIP code instead."
        return self._after_verify(self.state.toolkit.verify_identity(date_of_birth, ssn_last4=entered))

    @function_tool()
    async def wrong_party_or_unavailable(
        self, context: RunContext, situation: Literal["wrong_number", "not_available", "refused_to_verify"]
    ):
        """Politely end the call when the account holder cannot be verified or reached.

        Args:
            situation: What happened.
        """
        return self.apply(self.state.toolkit.wrong_party(situation))

    @function_tool()
    async def voicemail_detected(self, context: RunContext):
        """Call when an answering machine or voicemail greeting is detected."""
        return self.apply(self.state.toolkit.voicemail())


class NegotiationAgent(GuardedAgent):
    def __init__(self, state: CallState, disclosure: Optional[str], chat_ctx=None):
        super().__init__(state=state, instructions=prompts.negotiation_instructions(state.cfg), chat_ctx=chat_ctx)
        self._disclosure = disclosure

    async def on_enter(self):
        self.state.sink.emit("state", {"stage": "negotiation"})
        if self._disclosure:
            self.session.say(self._disclosure, allow_interruptions=False)
        self.session.generate_reply(
            instructions="Call get_current_offer, then ask whether they can resolve the balance with that today."
        )

    @function_tool()
    async def get_current_offer(self, context: RunContext):
        """Get the approved offer currently on the table."""
        return self.state.toolkit.get_current_offer().message

    @function_tool()
    async def request_lower_settlement(self, context: RunContext, customer_reason: str):
        """Ask for the next approved settlement. Only after the customer declined the current offer.

        Args:
            customer_reason: The customer's stated reason, in a few words.
        """
        return self.state.toolkit.request_lower_settlement(customer_reason).message

    @function_tool()
    async def evaluate_customer_offer(self, context: RunContext, amount: float):
        """Check a one-time amount the customer proposed.

        Args:
            amount: The dollar amount the customer proposed, e.g. 2500.00.
        """
        return self.state.toolkit.evaluate_customer_offer(amount).message

    @function_tool()
    async def propose_payment_plan(self, context: RunContext, months: int):
        """Build a monthly payment plan for the full balance.

        Args:
            months: Number of monthly payments the customer asked for.
        """
        return self.state.toolkit.propose_payment_plan(months).message

    @function_tool()
    async def confirm_arrangement(self, context: RunContext, offer_id: str):
        """Commit the offer the customer clearly agreed to. The system reads the terms aloud.

        Args:
            offer_id: The offer_id from a previous tool result, e.g. OF-3FA91C.
        """
        return self.apply(self.state.toolkit.confirm_arrangement(offer_id))
