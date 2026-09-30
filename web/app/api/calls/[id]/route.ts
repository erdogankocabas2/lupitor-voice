import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const after = Number(new URL(req.url).searchParams.get("after") ?? 0) || 0;
  const [{ data: call }, { data: events }] = await Promise.all([
    db().from("calls").select("status").eq("id", id).maybeSingle(),
    db().from("call_events").select("*").eq("call_id", id).gt("id", after).order("id").limit(500),
  ]);
  if (!call) return NextResponse.json({ error: "Call not found." }, { status: 404 });
  return NextResponse.json({ status: call.status, events: events ?? [] });
}
