import { NextResponse } from "next/server";
import { dispatchAgent, pickVersion } from "@/lib/livekit";
import { db } from "@/lib/supabase";
import type { AgentVersion } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const { agentId, accountId, phone: rawPhone } = await req.json().catch(() => ({}));
  if (!agentId) return NextResponse.json({ error: "agentId is required." }, { status: 400 });

  let targetPhone = rawPhone ? String(rawPhone).trim() : undefined;
  let targetAccountId = accountId;

  if (targetPhone && !targetAccountId) {
    const { data: matched } = await db()
      .from("accounts")
      .select("id")
      .eq("phone", targetPhone)
      .maybeSingle();
    if (matched) targetAccountId = matched.id;
  }

  if (!targetAccountId) {
    const { data: firstAcc } = await db().from("accounts").select("id, phone").order("created_at").limit(1).maybeSingle();
    targetAccountId = firstAcc?.id;
    if (!targetPhone) targetPhone = firstAcc?.phone;
  }

  const [{ data: account }, { data: versions }] = await Promise.all([
    db().from("accounts").select("id, phone").eq("id", targetAccountId).maybeSingle(),
    db().from("agent_versions").select("*").eq("agent_id", agentId),
  ]);

  if (!account) return NextResponse.json({ error: "Account not found." }, { status: 404 });
  const finalPhone = targetPhone || account.phone;
  if (!finalPhone) return NextResponse.json({ error: "A valid phone number is required." }, { status: 400 });

  const version = pickVersion((versions ?? []) as AgentVersion[]);
  if (!version) return NextResponse.json({ error: "This agent has no saved version." }, { status: 400 });

  // Contact rules come from one SQL function shared with the agent worker.
  const { data: rule, error: ruleErr } = await db().rpc("can_contact", { p_account_id: targetAccountId });
  if (ruleErr) return NextResponse.json({ error: ruleErr.message }, { status: 500 });
  const verdict = Array.isArray(rule) ? rule[0] : rule;

  const base = {
    agent_id: agentId,
    agent_version_id: version.id,
    account_id: targetAccountId,
    direction: "outbound",
    source: "live",
    phone: finalPhone,
  };

  if (!verdict?.allowed) {
    // Blocked attempts are recorded too: the audit trail shows the rule working.
    const { data: blocked } = await db().from("calls")
      .insert({ ...base, status: "blocked", blocked_reason: verdict?.reason ?? "blocked", ended_at: new Date().toISOString() })
      .select("id").single();
    return NextResponse.json({ error: `Not dialed: ${verdict?.reason ?? "contact rules"}.`, callId: blocked?.id }, { status: 409 });
  }

  // Prevent double-clicks / concurrent calls on the same account
  const { data: activeCall } = await db()
    .from("calls")
    .select("id")
    .eq("account_id", targetAccountId)
    .in("status", ["queued", "dialing", "in_progress"])
    .gt("created_at", new Date(Date.now() - 60_000).toISOString())
    .limit(1)
    .maybeSingle();
  if (activeCall) {
    return NextResponse.json({ error: "A call is already in progress for this account. Please wait for it to complete." }, { status: 409 });
  }

  const room = `out-${crypto.randomUUID().slice(0, 12)}`;
  const { data: call, error } = await db().from("calls")
    .insert({ ...base, status: "queued", room_name: room }).select("id").single();
  if (error || !call) return NextResponse.json({ error: error?.message ?? "Could not create call." }, { status: 500 });

  try {
    await dispatchAgent(room, {
      call_id: call.id, agent_version_id: version.id, account_id: targetAccountId, direction: "outbound", phone: finalPhone,
    });
  } catch (e) {
    await db().from("calls").update({ status: "failed", outcome: "dispatch_failed", summary: { error: String(e) } }).eq("id", call.id);
    return NextResponse.json({ error: `Agent dispatch failed: ${(e as Error).message}`, callId: call.id }, { status: 502 });
  }
  return NextResponse.json({ callId: call.id });
}
