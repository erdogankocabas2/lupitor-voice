import { DEFAULT_TTS, LLM_OPTIONS, STT_OPTIONS, type AgentConfig } from "@/lib/types";

type Props = {
  action: (form: FormData) => Promise<void>;
  config?: AgentConfig;
  template: "collections" | "generic";
  mode: "create" | "version";
  agentId?: string;
};

export default function AgentForm({ action, config = {}, template, mode, agentId }: Props) {
  return (
    <form action={action} className="form">
      {agentId && <input type="hidden" name="agent_id" value={agentId} />}

      {mode === "create" && (
        <>
          <div className="form-row">
            <label>
              Name
              <input name="name" required placeholder="Goldman Stanley Collections" />
            </label>
            <label>
              Template
              <select name="template" defaultValue={template}>
                <option value="collections">Collections (verification, offer engine, guardrails)</option>
                <option value="generic">Generic (instructions only)</option>
              </select>
            </label>
          </div>
          <label>
            Description <span className="hint">Optional</span>
            <input name="description" />
          </label>
        </>
      )}

      <div className="form-row">
        <label>
          Agent name spoken on calls
          <input name="persona_name" defaultValue={config.persona_name ?? "Alex"} />
        </label>
        <label>
          Company
          <input name="company" defaultValue={config.company ?? "Goldman Stanley"} />
        </label>
      </div>

      <div className="form-row">
        <label>
          Callback number <span className="hint">Left in voicemails and lockout messages</span>
          <input name="callback_number" defaultValue={config.callback_number ?? "+1 555 010 0199"} />
        </label>
        <label>
          Greeting <span className="hint">Generic template only; collections greetings are fixed scripts</span>
          <input name="greeting" defaultValue={config.greeting ?? ""} />
        </label>
      </div>

      <div className="form-row">
        <label>
          Language model
          <select name="llm" defaultValue={config.llm ?? LLM_OPTIONS[0]}>
            {LLM_OPTIONS.map((o) => <option key={o}>{o}</option>)}
          </select>
        </label>
        <label>
          Speech recognition
          <select name="stt" defaultValue={config.stt ?? STT_OPTIONS[0]}>
            {STT_OPTIONS.map((o) => <option key={o}>{o}</option>)}
          </select>
        </label>
      </div>

      <label>
        Voice <span className="hint">LiveKit Inference TTS string, provider/model:voice_id</span>
        <input name="tts" defaultValue={config.tts ?? DEFAULT_TTS} />
      </label>

      <label>
        Additional instructions
        <span className="hint">
          {template === "collections"
            ? "Tone and phrasing only. Offers, floors and contact rules are enforced in code and cannot be changed here."
            : "What the agent should do on calls."}
        </span>
        <textarea name="extra_instructions" defaultValue={config.extra_instructions ?? ""} />
      </label>

      {mode === "version" && (
        <>
          <label>
            What changed <span className="hint">Shown in the version history</span>
            <input name="notes" placeholder="Shorter disclosure lead-in" />
          </label>
          <label className="check">
            <input type="checkbox" name="make_live" /> Send all traffic to this version
          </label>
        </>
      )}

      <div className="actions">
        <button className="btn" type="submit">{mode === "create" ? "Create agent" : "Save as new version"}</button>
      </div>
    </form>
  );
}
