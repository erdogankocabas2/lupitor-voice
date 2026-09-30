import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/supabase";
import type { Agent, AgentVersion } from "@/lib/types";

export async function loadAgent(id: string) {
  const [{ data: agent }, { data: versions }] = await Promise.all([
    db().from("agents").select("*").eq("id", id).maybeSingle(),
    db().from("agent_versions").select("*").eq("agent_id", id).order("version", { ascending: false }),
  ]);
  if (!agent) notFound();
  return { agent: agent as Agent, versions: (versions ?? []) as AgentVersion[] };
}

export default function AgentHeader({ agent, versions, tab }: { agent: Agent; versions: AgentVersion[]; tab: "calls" | "edit" | "test" }) {
  const live = versions.filter((v) => v.traffic_weight > 0);
  const tabs = [
    { key: "calls", href: `/agents/${agent.id}`, label: "Calls" },
    { key: "edit", href: `/agents/${agent.id}/edit`, label: "Configuration" },
    { key: "test", href: `/agents/${agent.id}/test`, label: "Test in browser" },
  ];
  return (
    <>
      <div className="page-head">
        <div>
          <h1>{agent.name}</h1>
          <p className="muted">
            {agent.template === "collections" ? "Collections template" : "Generic template"}
            {", "}
            {live.length ? `serving ${live.map((v) => `v${v.version} at ${v.traffic_weight}%`).join(" and ")}` : "no live version"}
            {agent.handles_inbound ? ", answers the inbound number" : ""}
          </p>
        </div>
      </div>
      <nav className="tabs" aria-label="Agent sections">
        {tabs.map((t) => (
          <Link key={t.key} href={t.href} aria-current={tab === t.key ? "page" : undefined}>{t.label}</Link>
        ))}
      </nav>
    </>
  );
}
