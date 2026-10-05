"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { BarVisualizer, LiveKitRoom, RoomAudioRenderer, useRoomContext, useVoiceAssistant } from "@livekit/components-react";
import CallTimeline from "./CallTimeline";

type AccountOption = { id: string; full_name: string };
type Session = { token: string; url: string; callId: string };

const STATE_TEXT: Record<string, string> = {
  disconnected: "Disconnected",
  connecting: "Connecting",
  initializing: "Agent is joining",
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
};

export default function TestCall({ agentId, template, accounts }: { agentId: string; template: string; accounts: AccountOption[] }) {
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [session, setSession] = useState<Session | null>(null);
  const [ended, setEnded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function start() {
    setBusy(true);
    setError(null);
    setEnded(null);
    try {
      const res = await fetch("/api/calls/browser", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId, accountId: template === "collections" ? accountId : null }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Could not start the test call.");
      setSession(body);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!session) {
    return (
      <div className="panel stack" style={{ maxWidth: 560 }}>
        <div>
          <h2>Talk to this agent in your browser</h2>
          <p className="muted small">Uses your microphone. The call is logged as a browser test with the same transcript, tools and guard records as a phone call.</p>
        </div>
        {template === "collections" && (
          <label>
            Pretend to be
            <select value={accountId} onChange={(e: { target: { value: string } }) => setAccountId(e.target.value)}>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.full_name}</option>)}
            </select>
          </label>
        )}
        <div className="actions"><button className="btn" onClick={start} disabled={busy}>{busy ? "Starting" : "Start test call"}</button></div>
        {error && <div className="notice bad" role="alert">{error}</div>}
        {ended && <div className="notice" role="status">Call ended. <Link href={`/calls/${ended}`}>Open the full record</Link></div>}
      </div>
    );
  }

  return (
    <div className="grid-2">
      <LiveKitRoom
        serverUrl={session.url}
        token={session.token}
        connect
        audio
        video={false}
        onDisconnected={() => {
          setEnded(session.callId);
          setSession(null);
        }}
        className="panel stack"
      >
        <RoomAudioRenderer />
        <VoicePanel keypad={template === "collections"} />
      </LiveKitRoom>
      <div className="panel">
        <h2>Live record</h2>
        <CallTimeline callId={session.callId} initialEvents={[]} initialStatus="queued" />
      </div>
    </div>
  );
}

function VoicePanel({ keypad }: { keypad: boolean }) {
  const { state, audioTrack } = useVoiceAssistant();
  const room = useRoomContext();
  const [entered, setEntered] = useState<string>("");

  const press = useCallback((key: string) => {
    if (key === "clear") {
      setEntered("");
      room.localParticipant?.publishData(new TextEncoder().encode("clear"), { reliable: true, topic: "dtmf" });
      return;
    }
    if (key === "#") {
      room.localParticipant?.publishData(new TextEncoder().encode("#"), { reliable: true, topic: "dtmf" });
      return;
    }
    if (/^[0-9*]$/.test(key)) {
      setEntered((prev) => {
        const next = (prev + key).slice(0, 8); // Keep up to 8 digits
        room.localParticipant?.publishData(new TextEncoder().encode(key), { reliable: true, topic: "dtmf" });
        return next;
      });
    }
  }, [room]);

  const clear = useCallback(() => {
    press("clear");
  }, [press]);

  // Physical keyboard support for convenience
  useEffect(() => {
    if (!keypad) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (/^[0-9*#]$/.test(e.key)) {
        e.preventDefault();
        press(e.key);
      } else if (e.key === "Backspace" || e.key === "Escape") {
        e.preventDefault();
        clear();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keypad, press, clear]);

  return (
    <>
      <BarVisualizer state={state} trackRef={audioTrack} barCount={7} />
      <p className="voice-state" aria-live="polite" style={{ textAlign: "center" }}>{STATE_TEXT[state] ?? state}</p>
      {keypad && (
        <div style={{ marginTop: 8 }}>
          <h3>Code / PIN</h3>
          <p className="muted small">
            When prompted by the agent, enter your 4-digit SSN or code here. Keypad input goes straight to the verifier without entering LLM context.
          </p>

          {/* Keypad Display Box */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "8px 12px",
              background: "var(--paper)",
              borderRadius: "var(--radius-s)",
              border: "1px solid var(--rule)",
              marginTop: 10,
              marginBottom: 8,
              maxWidth: 220,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 11, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.5 }}>Code / PIN:</span>
              <span
                style={{
                  fontFamily: "monospace",
                  fontSize: 16,
                  fontWeight: 600,
                  letterSpacing: 4,
                  color: entered.length > 0 ? "var(--ink)" : "var(--muted)",
                }}
              >
                {entered.length > 0 ? entered : "____"}
              </span>
            </div>
            {entered.length > 0 && (
              <button
                type="button"
                className="btn ghost"
                style={{ fontSize: 11, padding: "2px 6px", minHeight: "auto", height: 22 }}
                onClick={clear}
                title="Clear entered digits"
              >
                Clear
              </button>
            )}
          </div>

          {entered.length >= 4 && (
            <div style={{ fontSize: 12, color: "var(--ok, #15803d)", marginBottom: 8, fontWeight: 500 }}>
              ✓ {entered.length} digits entered
            </div>
          )}

          <div className="keypad">
            {["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"].map((k) => (
              <button key={k} type="button" onClick={() => press(k)} aria-label={`Key ${k}`}>{k}</button>
            ))}
          </div>
        </div>
      )}
      <div className="actions">
        <button className="btn danger" type="button" onClick={() => room.disconnect()}>Hang up</button>
      </div>
    </>
  );
}
