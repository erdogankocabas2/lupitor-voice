import Link from "next/link";
import AgentHeader, { loadAgent } from "@/components/AgentHeader";
import DialPanel from "@/components/DialPanel";
import StatusPill from "@/components/StatusPill";
import { duration, label, when } from "@/lib/format";
import { db } from "@/lib/supabase";
import type { Call } from "@/lib/types";

export const dynamic = "force-dynamic";

const SOURCES = [
  { key: "all", label: "All" },
  { key: "live", label: "Phone" },
  { key: "test", label: "Browser tests" },
  { key: "redteam", label: "Red team" },
];

export default async function AgentCallsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ source?: string }>;
}) {
  const { id } = await params;
  const { source = "all" } = await searchParams;
  const { agent, versions } = await loadAgent(id);

  let q = db().from("calls").select("*").eq("agent_id", id).order("created_at", { ascending: false }).limit(200);
  if (source !== "all") q = q.eq("source", source);
  const [{ data: calls }, { data: accounts }] = await Promise.all([
    q,
    db().from("accounts").select("id, full_name, phone").order("created_at"),
  ]);
  const versionNo = new Map(versions.map((v) => [v.id, v.version]));
  const accountName = new Map(((accounts ?? []) as { id: string; full_name: string }[]).map((a) => [a.id, a.full_name]));

  return (
    <>
      <AgentHeader agent={agent} versions={versions} tab="calls" />
      <div className="grid-side">
        <div className="panel">
          <div className="actions" style={{ justifyContent: "space-between", marginBottom: 12 }}>
            <h2 style={{ margin: 0 }}>Calls</h2>
            <div className="actions small">
              {SOURCES.map((s) => (
                <Link key={s.key} href={`/agents/${id}?source=${s.key}`} aria-current={source === s.key ? "page" : undefined}
                  style={{ fontWeight: source === s.key ? 700 : 400 }}>
                  {s.label}
                </Link>
              ))}
            </div>
          </div>
          {!calls?.length ? (
            <div className="empty">No calls here yet. Place a call, or open Test in browser.</div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Customer</th>
                    <th>Type</th>
                    <th>Version</th>
                    <th>Status</th>
                    <th>Outcome</th>
                    <th>Length</th>
                  </tr>
                </thead>
                <tbody>
                  {(calls as Call[]).map((c) => (
                    <tr key={c.id} className="row-link">
                      <td className="num"><Link href={`/calls/${c.id}`}>{when(c.created_at)}</Link></td>
                      <td>{(c.account_id && accountName.get(c.account_id)) || c.phone || "Unknown caller"}</td>
                      <td>{label(c.direction)}{c.summary?.persona ? <div className="muted small">{label(String(c.summary.persona))}</div> : null}</td>
                      <td className="num">{c.agent_version_id ? `v${versionNo.get(c.agent_version_id)}` : ""}</td>
                      <td><StatusPill status={c.status} /></td>
                      <td>{label(c.outcome ?? c.blocked_reason)}</td>
                      <td className="num">{duration(c.duration_seconds)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <DialPanel agentId={id} accounts={accounts ?? []} />
      </div>
    </>
  );
}
