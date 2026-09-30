import Link from "next/link";
import { db } from "@/lib/supabase";
import { when } from "@/lib/format";
import type { Agent, AgentVersion } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function AgentsPage() {
  const [{ data: agents }, { data: versions }, { data: calls }] = await Promise.all([
    db().from("agents").select("*").is("archived_at", null).order("created_at"),
    db().from("agent_versions").select("id, agent_id, version, traffic_weight"),
    db().from("calls").select("agent_id, created_at, source").order("created_at", { ascending: false }).limit(2000),
  ]);

  const stats = new Map<string, { total: number; live: number; last?: string }>();
  for (const c of calls ?? []) {
    if (!c.agent_id) continue;
    const s = stats.get(c.agent_id) ?? { total: 0, live: 0 };
    s.total += 1;
    if (c.source === "live") s.live += 1;
    s.last ??= c.created_at;
    stats.set(c.agent_id, s);
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Agents</h1>
          <p className="muted">Each agent keeps every saved version. Traffic can be split between versions.</p>
        </div>
        <Link className="btn" href="/agents/new">New agent</Link>
      </div>

      {!agents?.length ? (
        <div className="empty">No agents yet. Create one, or run supabase/seed.sql to load the Goldman Stanley agent.</div>
      ) : (
        <div className="panel table-wrap">
          <table>
            <thead>
              <tr>
                <th>Agent</th>
                <th>Template</th>
                <th>Live versions</th>
                <th>Calls</th>
                <th>Last call</th>
                <th>Inbound line</th>
              </tr>
            </thead>
            <tbody>
              {(agents as Agent[]).map((a) => {
                const vs = ((versions ?? []) as AgentVersion[]).filter((v) => v.agent_id === a.id);
                const live = vs.filter((v) => v.traffic_weight > 0).map((v) => `v${v.version} ${v.traffic_weight}%`);
                const s = stats.get(a.id);
                return (
                  <tr key={a.id} className="row-link">
                    <td>
                      <Link href={`/agents/${a.id}`}><strong>{a.name}</strong></Link>
                      {a.description && <div className="muted small">{a.description}</div>}
                    </td>
                    <td>{a.template === "collections" ? "Collections" : "Generic"}</td>
                    <td className="num">{live.join(", ") || "None"}</td>
                    <td className="num">{s ? `${s.total} (${s.live} live)` : "0"}</td>
                    <td className="num">{when(s?.last)}</td>
                    <td>{a.handles_inbound ? <span className="pill ok">Answers inbound</span> : ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
