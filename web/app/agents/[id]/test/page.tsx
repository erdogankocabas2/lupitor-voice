import AgentHeader, { loadAgent } from "@/components/AgentHeader";
import TestCall from "@/components/TestCall";
import { db } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export default async function AgentTestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { agent, versions } = await loadAgent(id);
  const { data: accounts } = await db().from("accounts").select("id, full_name").order("created_at");
  return (
    <>
      <AgentHeader agent={agent} versions={versions} tab="test" />
      <TestCall agentId={id} template={agent.template} accounts={accounts ?? []} />
    </>
  );
}
