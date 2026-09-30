import Link from "next/link";
import { notFound } from "next/navigation";
import CallTimeline from "@/components/CallTimeline";
import StatusPill from "@/components/StatusPill";
import { duration, label, usd, when } from "@/lib/format";
import { db } from "@/lib/supabase";
import type { Call, CallEvent } from "@/lib/types";

export const dynamic = "force-dynamic";

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

export default async function CallPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { data: call } = await db().from("calls").select("*").eq("id", id).maybeSingle();
  if (!call) notFound();
  const c = call as Call;

  const [{ data: events }, { data: agent }, { data: version }, { data: account }, { data: arrangement }] = await Promise.all([
    db().from("call_events").select("*").eq("call_id", id).order("id").limit(2000),
    c.agent_id ? db().from("agents").select("id, name").eq("id", c.agent_id).maybeSingle() : Promise.resolve({ data: null }),
    c.agent_version_id ? db().from("agent_versions").select("version").eq("id", c.agent_version_id).maybeSingle() : Promise.resolve({ data: null }),
    c.account_id ? db().from("accounts").select("full_name, balance").eq("id", c.account_id).maybeSingle() : Promise.resolve({ data: null }),
    db().from("arrangements").select("*").eq("call_id", id).maybeSingle(),
  ]);
  const evs = (events ?? []) as CallEvent[];

  let recordingUrl: string | null = null;
  const bucket = process.env.RECORDINGS_BUCKET;
  if (c.recording_path && bucket) {
    const { data } = await db().storage.from(bucket).createSignedUrl(c.recording_path, 60 * 60);
    recordingUrl = data?.signedUrl ?? null;
  }

  const metric = (kind: string) => evs.filter((e) => e.type === "metric" && e.payload.kind === kind).map((e) => Number(e.payload.ms));
  const eou = median(metric("EOUMetrics"));
  const ttft = median(metric("LLMMetrics"));
  const ttfb = median(metric("TTSMetrics"));
  const guardBlocks = evs.filter((e) => e.type === "guard").length;

  return (
    <>
      <div className="page-head">
        <div>
          <p className="small muted" style={{ margin: 0 }}>
            {agent ? <Link href={`/agents/${agent.id}`}>{agent.name}</Link> : "Unknown agent"}
            {version ? ` v${version.version}` : ""}
          </p>
          <h1>{account?.full_name ?? c.phone ?? "Unknown caller"}</h1>
          <p className="muted">{label(c.direction)} call, {when(c.created_at)}{c.summary?.persona ? `, red-team persona ${label(String(c.summary.persona))}` : ""}</p>
        </div>
        <StatusPill status={c.status} />
      </div>

      {c.blocked_reason && <p className="notice bad">Not dialed: {c.blocked_reason}.</p>}

      <div className="grid-side">
        <div className="panel">
          <h2>Conversation</h2>
          <CallTimeline callId={c.id} initialEvents={evs} initialStatus={c.status} />
        </div>

        <div className="stack">
          <div className="panel">
            <dl className="facts">
              <div><dt>Outcome</dt><dd>{label(c.outcome) || "Pending"}</dd></div>
              <div><dt>Identity</dt><dd>{c.verified == null ? "Pending" : c.verified ? "Verified" : "Not verified"}</dd></div>
              <div><dt>Length</dt><dd>{duration(c.duration_seconds) || "Pending"}</dd></div>
              <div><dt>Balance</dt><dd>{usd(account?.balance)}</dd></div>
              <div><dt>Guard blocks</dt><dd>{guardBlocks}</dd></div>
              <div><dt>Phone</dt><dd>{c.phone ?? "Browser"}</dd></div>
            </dl>
          </div>

          {arrangement && (
            <div className="panel tl-arrangement">
              <h3>Promise to pay</h3>
              <p className="num" style={{ margin: 0 }}>
                {usd(arrangement.total)}{" "}
                {arrangement.installments > 1 ? `over ${arrangement.installments} payments of ${usd(arrangement.installment_amount)}` : "in one payment"}, first due {arrangement.first_due}.
              </p>
              <p className="muted small" style={{ margin: 0 }}>Reference {arrangement.offer_id}</p>
            </div>
          )}

          <div className="panel">
            <h3>Response time (median)</h3>
            {eou == null && ttft == null ? (
              <p className="muted small">Recorded on phone and browser calls. Red-team runs are text only.</p>
            ) : (
              <dl className="facts">
                <div><dt>End of turn</dt><dd>{eou ?? "n/a"} ms</dd></div>
                <div><dt>First token</dt><dd>{ttft ?? "n/a"} ms</dd></div>
                <div><dt>First audio</dt><dd>{ttfb ?? "n/a"} ms</dd></div>
              </dl>
            )}
          </div>

          <div className="panel">
            <h3>Recording</h3>
            {recordingUrl ? (
              <audio controls src={recordingUrl} style={{ width: "100%" }} />
            ) : (
              <p className="muted small">{c.recording_path ? "Set RECORDINGS_BUCKET to play recordings here." : "No recording for this call."}</p>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
