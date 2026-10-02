import Link from "next/link";
import { db } from "@/lib/supabase";
import { label, when } from "@/lib/format";

export const dynamic = "force-dynamic";

type Run = {
  id: string; call_id: string | null; agent_version_id: string | null; persona: string; passed: boolean;
  failures: string[]; metrics: Record<string, any>; created_at: string;
  agent_versions: { version: number; agents: { name: string } | null } | null;
};

function pct(n: number, d: number) {
  return d ? Math.round((n / d) * 100) : 0;
}

export default async function RedTeamPage() {
  const { data } = await db()
    .from("redteam_runs")
    .select("*, agent_versions(version, agents(name))")
    .order("created_at", { ascending: false })
    .limit(1000);
  const runs = (data ?? []) as unknown as Run[];

  const byVersion = new Map<string, { name: string; runs: number; passed: number; guard: number; spoken: number; belowFloor: number }>();
  const byPersona = new Map<string, { runs: number; passed: number }>();
  for (const r of runs) {
    const key = r.agent_version_id ?? "none";
    const name = r.agent_versions ? `${r.agent_versions.agents?.name ?? "Agent"} v${r.agent_versions.version}` : "Local run";
    const v = byVersion.get(key) ?? { name, runs: 0, passed: 0, guard: 0, spoken: 0, belowFloor: 0 };
    v.runs += 1;
    v.passed += r.passed ? 1 : 0;
    v.guard += Number(r.metrics?.raw_guard_blocks ?? 0);
    v.spoken += Number(r.metrics?.spoken_violations ?? 0);
    v.belowFloor += r.failures.includes("committed_below_floor") ? 1 : 0;
    byVersion.set(key, v);
    const p = byPersona.get(r.persona) ?? { runs: 0, passed: 0 };
    p.runs += 1;
    p.passed += r.passed ? 1 : 0;
    byPersona.set(r.persona, p);
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Red team</h1>
          <p className="muted">
            An attacker model calls the collection agent across {byPersona.size || 31} adversarial personas (standard
            and extreme sets): fake supervisors, prompt injection, floor probing, third parties, emergency hardship,
            cross-lingual attacks and more. Every run is kept.
          </p>
        </div>
      </div>

      {!runs.length ? (
        <div className="empty">No runs yet. From the agent folder run: python -m redteam.run --personas all --repeat 3</div>
      ) : (
        <div className="stack">
          <div className="panel table-wrap">
            <h2>By version</h2>
            <table>
              <thead>
                <tr><th>Version</th><th>Runs</th><th>Passed</th><th>Below-floor deals</th><th>Unapproved amounts spoken</th><th>Unsafe sentences caught by guard</th></tr>
              </thead>
              <tbody>
                {[...byVersion.values()].map((v) => (
                  <tr key={v.name}>
                    <td><strong>{v.name}</strong></td>
                    <td className="num">{v.runs}</td>
                    <td className="num" style={{ minWidth: 140 }}>
                      {pct(v.passed, v.runs)}%
                      <div className="bar" aria-hidden><span style={{ width: `${pct(v.passed, v.runs)}%` }} /></div>
                    </td>
                    <td className="num">{v.belowFloor}</td>
                    <td className="num">{v.spoken}</td>
                    <td className="num">{v.guard}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="grid-2">
            <div className="panel table-wrap">
              <h2>By persona</h2>
              <table>
                <thead><tr><th>Persona</th><th>Runs</th><th>Passed</th></tr></thead>
                <tbody>
                  {[...byPersona.entries()].map(([k, p]) => (
                    <tr key={k}><td>{label(k)}</td><td className="num">{p.runs}</td><td className="num">{pct(p.passed, p.runs)}%</td></tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="panel table-wrap">
              <h2>Recent runs</h2>
              <table>
                <thead><tr><th>When</th><th>Persona</th><th>Result</th></tr></thead>
                <tbody>
                  {runs.slice(0, 25).map((r) => (
                    <tr key={r.id} className="row-link">
                      <td className="num">{r.call_id ? <Link href={`/calls/${r.call_id}`}>{when(r.created_at)}</Link> : when(r.created_at)}</td>
                      <td>{label(r.persona)}</td>
                      <td>
                        {r.passed ? <span className="pill ok">Passed</span> : <span className="pill bad">Failed</span>}
                        {r.failures.length > 0 && <div className="muted small">{r.failures.map((f) => label(f.split(":")[0])).join(", ")}</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
