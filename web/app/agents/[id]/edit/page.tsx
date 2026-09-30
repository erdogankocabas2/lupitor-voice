import AgentForm from "@/components/AgentForm";
import AgentHeader, { loadAgent } from "@/components/AgentHeader";
import { saveVersion, setInbound, setTraffic } from "@/app/actions";
import { when } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function AgentEditPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ saved?: string; traffic_error?: string; traffic_saved?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const { agent, versions } = await loadAgent(id);
  const latest = versions[0];

  return (
    <>
      <AgentHeader agent={agent} versions={versions} tab="edit" />
      {sp.saved && <p className="notice" role="status">Saved as version {sp.saved}. Give it traffic below to put it on calls.</p>}
      {sp.traffic_error && <p className="notice bad" role="alert">Traffic must add up to 100%. It added up to {sp.traffic_error}%.</p>}
      {sp.traffic_saved && <p className="notice" role="status">Traffic split updated. New calls use it straight away.</p>}

      <div className="grid-side">
        <div className="panel">
          <h2>Edit configuration</h2>
          <p className="muted small">Starting from v{latest?.version}. Saving creates a new version; existing versions never change.</p>
          <AgentForm action={saveVersion} config={latest?.config} template={agent.template} mode="version" agentId={id} />
        </div>

        <div className="stack">
          <form action={setTraffic} className="panel form">
            <input type="hidden" name="agent_id" value={id} />
            <div>
              <h2>Versions and traffic</h2>
              <p className="muted small">Split calls between versions to compare them. Weights must total 100.</p>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Version</th><th>Saved</th><th>Traffic %</th></tr>
                </thead>
                <tbody>
                  {versions.map((v) => (
                    <tr key={v.id}>
                      <td>
                        <strong className="num">v{v.version}</strong>
                        {v.notes && <div className="muted small">{v.notes}</div>}
                      </td>
                      <td className="num small">{when(v.created_at)}</td>
                      <td style={{ width: 90 }}>
                        <input name={`w_${v.id}`} type="number" min={0} max={100} defaultValue={v.traffic_weight}
                          aria-label={`Traffic for version ${v.version}`} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="actions"><button className="btn ghost" type="submit">Update traffic</button></div>
          </form>

          <form action={setInbound} className="panel form">
            <input type="hidden" name="agent_id" value={id} />
            <div>
              <h2>Inbound number</h2>
              <p className="muted small">
                {agent.handles_inbound
                  ? "This agent answers calls to your LiveKit phone number."
                  : "Another agent answers the inbound number right now."}
              </p>
            </div>
            {!agent.handles_inbound && (
              <div className="actions"><button className="btn ghost" type="submit">Answer inbound calls with this agent</button></div>
            )}
          </form>
        </div>
      </div>
    </>
  );
}
