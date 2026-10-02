import { NextResponse } from "next/server";
import { observerToken } from "@/lib/livekit";
import { db } from "@/lib/supabase";
import { LIVE_STATUSES } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { data: call } = await db()
    .from("calls")
    .select("id, status, room_name")
    .eq("id", id)
    .maybeSingle();

  if (!call) {
    return NextResponse.json({ error: "Call not found." }, { status: 404 });
  }

  if (!call.room_name) {
    return NextResponse.json({ error: "This call has no active audio room." }, { status: 400 });
  }

  if (!LIVE_STATUSES.includes(call.status)) {
    return NextResponse.json({ error: "Call is not currently live." }, { status: 400 });
  }

  try {
    const supervisorId = `supervisor-${crypto.randomUUID().slice(0, 8)}`;
    const { token, url } = await observerToken(call.room_name, supervisorId);
    return NextResponse.json({ token, url, room: call.room_name, callId: call.id });
  } catch (e) {
    return NextResponse.json({ error: `Could not create observer session: ${(e as Error).message}` }, { status: 500 });
  }
}
