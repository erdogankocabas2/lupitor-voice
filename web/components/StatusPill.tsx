const TONE: Record<string, string> = {
  completed: "ok",
  in_progress: "warn",
  dialing: "warn",
  queued: "neutral",
  blocked: "bad",
  failed: "bad",
  no_answer: "neutral",
};

const TEXT: Record<string, string> = {
  completed: "Completed",
  in_progress: "Live",
  dialing: "Dialing",
  queued: "Queued",
  blocked: "Blocked by contact rules",
  failed: "Failed",
  no_answer: "No answer",
};

export default function StatusPill({ status }: { status: string }) {
  return <span className={`pill ${TONE[status] ?? "neutral"}`}>{TEXT[status] ?? status}</span>;
}
