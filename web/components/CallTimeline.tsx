"use client";

import { useEffect, useRef, useState } from "react";
import { clock, label, usd } from "@/lib/format";
import { LIVE_STATUSES, type CallEvent } from "@/lib/types";

type Props = { callId: string; initialEvents: CallEvent[]; initialStatus: string; showTools?: boolean };

export default function CallTimeline({ callId, initialEvents, initialStatus, showTools = true }: Props) {
  const [events, setEvents] = useState<CallEvent[]>(initialEvents);
  const [status, setStatus] = useState(initialStatus);
  const [fresh, setFresh] = useState<Set<number>>(new Set());
  const lastId = useRef(initialEvents.at(-1)?.id ?? 0);
  const live = LIVE_STATUSES.includes(status);

  useEffect(() => {
    if (!live) return;
    const t = setInterval(async () => {
      const res = await fetch(`/api/calls/${callId}?after=${lastId.current}`, { cache: "no-store" });
      if (!res.ok) return;
      const body: { status: string; events: CallEvent[] } = await res.json();
      if (body.events.length) {
        lastId.current = body.events.at(-1)!.id;
        setEvents((prev) => [...prev, ...body.events]);
        setFresh(new Set(body.events.map((e) => e.id)));
      }
      setStatus(body.status);
    }, 1500);
    return () => clearInterval(t);
  }, [callId, live]);

  const visible = events.filter((e) => e.type !== "metric" && (showTools || e.type !== "tool"));
  if (!visible.length) {
    return <div className="empty">{live ? "Waiting for the conversation to start" : "No events were recorded for this call."}</div>;
  }

  return (
    <div className="timeline" aria-live={live ? "polite" : undefined}>
      {visible.map((e) => (
        <Row key={e.id} e={e} fresh={fresh.has(e.id)} />
      ))}
      {live && <p className="muted small" style={{ paddingTop: 10 }}>Live. New lines appear as they happen.</p>}
    </div>
  );
}

function Row({ e, fresh }: { e: CallEvent; fresh: boolean }) {
  const p = e.payload ?? {};
  const time = <div className="tl-time">{clock(e.ts)}</div>;

  if (e.type === "transcript") {
    const agent = p.role === "assistant";
    return (
      <div className="tl-row">
        {time}
        <div className={`tl-who ${agent ? "agent" : ""}`}>{agent ? "Agent" : "Customer"}</div>
        <div className="tl-body">{p.text}{p.interrupted ? <span className="muted small"> (interrupted)</span> : null}</div>
      </div>
    );
  }

  if (e.type === "guard") {
    return (
      <div className="tl-row">
        {time}
        <div className="tl-who system">Guard</div>
        <div className="tl-body">
          <div className={`stamp ${fresh ? "fresh" : ""}`}>
            <div className="stamp-title">Blocked before it was spoken</div>
            <del>{p.original}</del>
            <span className="said">Said instead: {p.replacement}</span>
            <div className="why">{(p.reasons ?? []).map((r: string) => label(r.split(":")[0])).join(", ")}</div>
          </div>
        </div>
      </div>
    );
  }

  if (e.type === "policy") {
    return (
      <div className="tl-row">
        {time}
        <div className="tl-who system">Offer engine</div>
        <div className="tl-body"><div className="tl-ledger">{policyText(p)}</div></div>
      </div>
    );
  }

  if (e.type === "arrangement") {
    return (
      <div className="tl-row">
        {time}
        <div className="tl-who agent">Committed</div>
        <div className="tl-body">
          <div className="tl-arrangement">
            <strong>Promise to pay {usd(p.total)}</strong>
            <div className="small">
              {p.installments > 1 ? `${p.installments} payments of ${usd(p.installment_amount)}` : "One payment"}, first due {p.first_due}. Reference {p.offer_id}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (e.type === "escalation") {
    return (
      <div className="tl-row">
        {time}
        <div className="tl-who system">Escalated</div>
        <div className="tl-body"><div className="tl-escalation">{label(p.reason)}{p.notes ? `: ${p.notes}` : ""}</div></div>
      </div>
    );
  }

  if (e.type === "tool") {
    return (
      <div className="tl-row system">
        {time}
        <div className="tl-who system">Tool</div>
        <div className="tl-body">
          <details className="tool">
            <summary>{p.name}</summary>
            <pre>{JSON.stringify(p.arguments ?? {}, null, 1)}{"\n\n"}{String(p.output ?? "")}</pre>
          </details>
        </div>
      </div>
    );
  }

  return (
    <div className="tl-row system">
      {time}
      <div className="tl-who system">{e.type === "verification" ? "Identity" : e.type === "dtmf" ? "Keypad" : "System"}</div>
      <div className="tl-body">{systemText(e.type, p)}</div>
    </div>
  );
}

function policyText(p: Record<string, any>): string {
  switch (p.action) {
    case "current_offer":
      return `Offer on the table: ${usd(p.total)} (${p.offer_id})`;
    case "request_lower":
      return p.granted ? `Lower offer approved: ${usd(p.total)} (${p.offer_id})` : "Lower offer refused: no further concession allowed on this call";
    case "evaluate_proposal":
      return p.accepted ? `Customer's ${usd(p.proposed)} accepted` : `Customer's ${usd(p.proposed)} rejected; offer stays at ${usd(p.total)}`;
    case "payment_plan":
      return p.offer_id ? `Plan approved: ${p.months} months, total ${usd(p.total)} (${p.offer_id})` : `Plan for ${p.months} months refused: ${p.note}`;
    case "commit_rejected":
      return `Commit refused for ${p.offer_id}: ${p.error}`;
    case "blocked_unverified_tool":
      return "Negotiation tool called before verification; refused";
    default:
      return JSON.stringify(p);
  }
}

function systemText(type: string, p: Record<string, any>): string {
  if (type === "verification") {
    if (p.step === "lookup") return p.found ? "Account found by phone number" : "No account for that number";
    const map: Record<string, string> = {
      verified: "Verified",
      failed: `Did not match, ${p.attempts_left} attempts left`,
      locked: "Locked after repeated failures",
      invalid_input: "Could not read the details; asked again",
    };
    return `${map[p.status] ?? p.status} (${String(p.method ?? "").replace("dob+", "date of birth and ").replace("ssn4_keypad", "keypad digits")})`;
  }
  if (type === "dtmf") return p.status === "collecting" ? "Waiting for keypad digits" : p.status === "received" ? "Digits received (never shown to the model)" : "No digits entered";
  if (type === "state") {
    if (p.stage) return `Stage: ${label(p.stage)}`;
    if (p.outcome) return `Outcome: ${label(p.outcome)}`;
    if (p.blocked) return `Call blocked: ${p.blocked}`;
    if (p.transfer) return `Transfer ${p.transfer}`;
    if (p.agent_version != null) return `Running v${p.agent_version}, ${label(p.direction)}`;
  }
  return JSON.stringify(p);
}
