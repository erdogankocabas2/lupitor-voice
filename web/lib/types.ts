export type AgentConfig = {
  persona_name?: string;
  company?: string;
  callback_number?: string;
  greeting?: string;
  llm?: string;
  stt?: string;
  tts?: string;
  extra_instructions?: string;
};

export type Agent = {
  id: string;
  name: string;
  description: string | null;
  template: "collections" | "generic";
  handles_inbound: boolean;
  created_at: string;
};

export type AgentVersion = {
  id: string;
  agent_id: string;
  version: number;
  config: AgentConfig;
  notes: string | null;
  traffic_weight: number;
  created_at: string;
};

export type Call = {
  id: string;
  agent_id: string | null;
  agent_version_id: string | null;
  account_id: string | null;
  room_name: string | null;
  direction: "outbound" | "inbound" | "browser" | "simulated";
  source: "live" | "test" | "redteam";
  phone: string | null;
  status: string;
  outcome: string | null;
  verified: boolean | null;
  blocked_reason: string | null;
  started_at: string | null;
  answered_at: string | null;
  ended_at: string | null;
  duration_seconds: number | null;
  recording_path: string | null;
  summary: Record<string, any>;
  created_at: string;
};

export type CallEvent = {
  id: number;
  call_id: string;
  ts: string;
  type: string;
  payload: Record<string, any>;
};

export type Account = {
  id: string;
  full_name: string;
  phone: string;
  balance: number;
  days_past_due: number;
  portfolio: string;
  timezone: string;
  product: string;
  account_last4: string;
};

export const LLM_OPTIONS = ["openai/gpt-4.1-mini", "openai/gpt-4.1", "openai/gpt-4o-mini", "google/gemini-2.5-flash"];
export const STT_OPTIONS = ["deepgram/nova-3:en", "assemblyai/universal-streaming:en"];
export const DEFAULT_TTS = "cartesia/sonic-2:9626c31c-bec5-4cca-baa8-f8ba9e84c8bc";
export const LIVE_STATUSES = ["queued", "dialing", "in_progress"];
