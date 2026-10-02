import { NextResponse } from "next/server";
import { dispatchAgent, participantToken, pickVersion } from "@/lib/livekit";
import { db } from "@/lib/supabase";
import type { AgentVersion } from "@/lib/types";

export async function POST(req: Request) {
  const { agentId, accountId } = await req.json().catch(() => ({}));
  if (!agentId) return NextResponse.json({ error: "agentId is required." }, { status: 400 });

  const { data: versions } = await db().from("agent_versions").select("*").eq("agent_id", agentId);
  const version = pickVersion((versions ?? []) as AgentVersion[]);
  if (!version) return NextResponse.json({ error: "This agent has no saved version." }, { status: 400 });

  const room = `test-${crypto.randomUUID().slice(0, 12)}`;
  if (accountId) {
    const { data: activeCall } = await db()
      .from("calls")
      .select("id")
      .eq("account_id", accountId)
      .in("status", ["queued", "in_progress"])
      .gt("created_at", new Date(Date.now() - 45_000).toISOString())
      .limit(1)
      .maybeSingle();
    if (activeCall) {
      return NextResponse.json({ error: "A test call is already active for this account. Please wait or end it." }, { status: 409 });
    }
  }

  const { data: call, error } = await db().from("calls").insert({
    agent_id: agentId, agent_version_id: version.id, account_id: accountId || null,
    direction: "browser", source: "test", status: "queued", room_name: room,
  }).select("id").single();
  if (error || !call) return NextResponse.json({ error: error?.message ?? "Could not create call." }, { status: 500 });

  try {
    await dispatchAgent(room, { call_id: call.id, agent_version_id: version.id, account_id: accountId || null, direction: "browser" });
    const { token, url } = await participantToken(room, `tester-${call.id.slice(0, 8)}`);
    return NextResponse.json({ token, url, callId: call.id });
  } catch (e) {
    await db().from("calls").update({ status: "failed", outcome: "dispatch_failed", summary: { error: String(e) } }).eq("id", call.id);
    return NextResponse.json({ error: `Agent dispatch failed: ${(e as Error).message}` }, { status: 502 });
  }
}
