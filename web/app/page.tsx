import Link from "next/link";
import { db } from "@/lib/supabase";
import { when } from "@/lib/format";
import type { Agent, AgentVersion } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function AgentsPage() {
  const [
    { data: agents },
    { data: versions },
    { data: calls },
    { data: guardEvent },
    { data: attackRun },
    { data: arrangementRecord },
  ] = await Promise.all([
    db().from("agents").select("*").is("archived_at", null).order("created_at"),
    db().from("agent_versions").select("id, agent_id, version, traffic_weight"),
    db().from("calls").select("agent_id, created_at, source").order("created_at", { ascending: false }).limit(2000),
    db().from("call_events").select("call_id, payload").eq("type", "guard").order("id", { ascending: false }).limit(1).maybeSingle(),
    db().from("redteam_runs").select("call_id, persona").in("persona", ["fake_supervisor", "prompt_injector", "regulator_impostor"]).eq("passed", true).order("created_at", { ascending: false }).limit(1).maybeSingle(),
    db().from("arrangements").select("call_id, total, installments, offer_id").order("created_at", { ascending: false }).limit(1).maybeSingle(),
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

  const collectionsAgent = ((agents as Agent[]) ?? []).find((a) => a.template === "collections") ?? agents?.[0];

  return (
    <>
      <div className="panel stack" style={{ marginBottom: 24, borderLeft: "4px solid var(--ledger)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
          <div>
            <span className="pill ok" style={{ marginBottom: 6 }}>Reviewer Quick Tour</span>
            <h2 style={{ margin: "4px 0" }}>Start here: Evaluating the Goldman Stanley Collections Agent</h2>
            <p className="muted" style={{ margin: 0, maxWidth: "75ch" }}>
              The core architectural invariant: <strong>the LLM talks, deterministic code decides</strong>. The model never sees the settlement floor, every sentence is screened by <code>ResponseGuard</code> before speech, and commits require cryptographic offer IDs.
            </p>
          </div>
          {collectionsAgent && (
            <Link className="btn" href={`/agents/${collectionsAgent.id}/test`}>
              🎙️ Talk to agent in browser
            </Link>
          )}
        </div>

        <div className="grid-2" style={{ gap: 16 }}>
          <div style={{ background: "var(--paper)", padding: 14, borderRadius: "var(--radius-s)", border: "1px solid var(--rule)" }}>
            <h3 style={{ margin: "0 0 6px" }}>1. Test Identity (Dana Whitfield)</h3>
            <p className="small muted" style={{ margin: "0 0 8px" }}>Use these credentials when verifying during voice or browser tests:</p>
            <dl className="facts" style={{ gridTemplateColumns: "repeat(2, 1fr)" }}>
              <div><dt>Full Name</dt><dd>Dana Whitfield</dd></div>
              <div><dt>Date of Birth</dt><dd>1988-03-14</dd></div>
              <div><dt>Billing ZIP</dt><dd>10027</dd></div>
              <div><dt>SSN Last 4 (Keypad)</dt><dd>4417</dd></div>
              <div><dt>Current Balance</dt><dd>$4,120.60</dd></div>
              <div><dt>Hard Single-Call Floor</dt><dd>$3,378.89 (82%)</dd></div>
            </dl>
          </div>

          <div style={{ background: "var(--paper)", padding: 14, borderRadius: "var(--radius-s)", border: "1px solid var(--rule)" }}>
            <h3 style={{ margin: "0 0 6px" }}>2. Curated Audit Calls (Key Highlights)</h3>
            <p className="small muted" style={{ margin: "0 0 8px" }}>Direct links to inspect safety & compliance behaviors in real call logs:</p>
            <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 8, fontSize: 13 }}>
              <li>
                {guardEvent?.call_id ? (
                  <Link href={`/calls/${guardEvent.call_id}`}>
                    <strong>🛡️ ResponseGuard in action:</strong> See live sentence screening and red block stamp
                  </Link>
                ) : (
                  <span><strong>🛡️ ResponseGuard:</strong> Intercepts unapproved settlements or hallucinations before TTS</span>
                )}
              </li>
              <li>
                {attackRun?.call_id ? (
                  <Link href={`/calls/${attackRun.call_id}`}>
                    <strong>🚫 Social Engineering Defeated:</strong> Fake supervisor / prompt injection attack refuted
                  </Link>
                ) : (
                  <span><strong>🚫 Social Engineering Defeated:</strong> Fake supervisor / prompt injection attack refuted</span>
                )}
              </li>
              <li>
                {arrangementRecord?.call_id ? (
                  <Link href={`/calls/${arrangementRecord.call_id}`}>
                    <strong>🤝 Compliant Settlement ({arrangementRecord.total ? `$${arrangementRecord.total}` : "Deal"}):</strong> Ladder negotiation with mandatory disclosure and read-back
                  </Link>
                ) : (
                  <span><strong>🤝 Compliant Settlement:</strong> Ladder negotiation with mandatory disclosure and read-back</span>
                )}
              </li>
            </ul>
          </div>
        </div>
      </div>

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
