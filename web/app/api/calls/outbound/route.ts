import { NextResponse } from "next/server";
import { dispatchAgent, pickVersion } from "@/lib/livekit";
import { db } from "@/lib/supabase";
import type { AgentVersion } from "@/lib/types";

export async function POST(req: Request) {
  const { agentId, accountId } = await req.json().catch(() => ({}));
  if (!agentId || !accountId) return NextResponse.json({ error: "agentId and accountId are required." }, { status: 400 });

  const [{ data: account }, { data: versions }] = await Promise.all([
    db().from("accounts").select("id, phone").eq("id", accountId).maybeSingle(),
    db().from("agent_versions").select("*").eq("agent_id", agentId),
  ]);
  if (!account) return NextResponse.json({ error: "Account not found." }, { status: 404 });
  const version = pickVersion((versions ?? []) as AgentVersion[]);
  if (!version) return NextResponse.json({ error: "This agent has no saved version." }, { status: 400 });

  // Contact rules come from one SQL function shared with the agent worker.
  const { data: rule, error: ruleErr } = await db().rpc("can_contact", { p_account_id: accountId });
  if (ruleErr) return NextResponse.json({ error: ruleErr.message }, { status: 500 });
  const verdict = Array.isArray(rule) ? rule[0] : rule;

  const base = {
    agent_id: agentId, agent_version_id: version.id, account_id: accountId,
    direction: "outbound", source: "live", phone: account.phone,
  };

  if (!verdict?.allowed) {
    // Blocked attempts are recorded too: the audit trail shows the rule working.
    const { data: blocked } = await db().from("calls")
      .insert({ ...base, status: "blocked", blocked_reason: verdict?.reason ?? "blocked", ended_at: new Date().toISOString() })
      .select("id").single();
    return NextResponse.json({ error: `Not dialed: ${verdict?.reason ?? "contact rules"}.`, callId: blocked?.id }, { status: 409 });
  }

  const room = `out-${crypto.randomUUID().slice(0, 12)}`;
  const { data: call, error } = await db().from("calls")
    .insert({ ...base, status: "queued", room_name: room }).select("id").single();
  if (error || !call) return NextResponse.json({ error: error?.message ?? "Could not create call." }, { status: 500 });

  try {
    await dispatchAgent(room, {
      call_id: call.id, agent_version_id: version.id, account_id: accountId, direction: "outbound", phone: account.phone,
    });
  } catch (e) {
    await db().from("calls").update({ status: "failed", outcome: "dispatch_failed", summary: { error: String(e) } }).eq("id", call.id);
    return NextResponse.json({ error: `Agent dispatch failed: ${(e as Error).message}`, callId: call.id }, { status: 502 });
  }
  return NextResponse.json({ callId: call.id });
}
