import AgentForm from "@/components/AgentForm";
import { createAgent } from "@/app/actions";

export default function NewAgentPage() {
  return (
    <>
      <div className="page-head">
        <div>
          <h1>New agent</h1>
          <p className="muted">Saved as version 1 with all traffic. Later edits become new versions.</p>
        </div>
      </div>
      <div className="panel">
        <AgentForm action={createAgent} template="collections" mode="create" />
      </div>
    </>
  );
}
