"use client";

import { useEffect, useState } from "react";
import { LiveKitRoom, RoomAudioRenderer } from "@livekit/components-react";
import { LIVE_STATUSES } from "@/lib/types";

type Props = {
  callId: string;
  initialStatus: string;
};

type Session = {
  token: string;
  url: string;
  room: string;
};

export default function LiveObserver({ callId, initialStatus }: Props) {
  const [status, setStatus] = useState(initialStatus);
  const [session, setSession] = useState<Session | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);

  const isLive = LIVE_STATUSES.includes(status);

  // Poll status periodically if live to know when call finishes
  useEffect(() => {
    if (!isLive) return;
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/calls/${callId}?after=0`, { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        if (data.status) {
          setStatus(data.status);
          if (!LIVE_STATUSES.includes(data.status)) {
            setSession(null);
          }
        }
      } catch {
        // ignore polling errors
      }
    }, 2500);
    return () => clearInterval(interval);
  }, [callId, isLive]);

  async function startObserving() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/calls/${callId}/observe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to connect to live audio.");
      setSession(data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function stopObserving() {
    setSession(null);
  }

  if (!isLive && !session) {
    return null;
  }

  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      {!session ? (
        <button
          className="btn"
          style={{ background: "var(--ledger)", borderColor: "var(--ledger)", fontSize: 13, padding: "5px 12px" }}
          onClick={startObserving}
          disabled={busy}
          title="Join as hidden supervisor to listen to live audio"
        >
          {busy ? "Connecting..." : "🎧 Listen live"}
        </button>
      ) : (
        <LiveKitRoom
          serverUrl={session.url}
          token={session.token}
          connect
          audio={false}
          video={false}
          onDisconnected={stopObserving}
          style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
        >
          {!muted && <RoomAudioRenderer />}
          <span className="pill ok" style={{ animation: "pulse 2s infinite" }}>
            🔴 Listening live (Silent supervisor)
          </span>
          <button
            className="btn ghost"
            style={{ fontSize: 12, padding: "4px 8px" }}
            onClick={() => setMuted((m) => !m)}
          >
            {muted ? "Unmute" : "Mute"}
          </button>
          <button
            className="btn ghost danger"
            style={{ fontSize: 12, padding: "4px 8px" }}
            onClick={stopObserving}
          >
            Leave
          </button>
        </LiveKitRoom>
      )}
      {error && <span className="small muted" style={{ color: "var(--stamp)" }}>{error}</span>}
    </div>
  );
}
