"use client";

import Link from "next/link";
import { useState } from "react";
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

  function press(key: string) {
    room.localParticipant.publishData(new TextEncoder().encode(key), { reliable: true, topic: "dtmf" });
  }

  return (
    <>
      <BarVisualizer state={state} trackRef={audioTrack} barCount={7} />
      <p className="voice-state" aria-live="polite" style={{ textAlign: "center" }}>{STATE_TEXT[state] ?? state}</p>
      {keypad && (
        <div>
          <h3>Keypad</h3>
          <p className="muted small">When the agent asks for the last four digits of your Social Security number, type them here. They go to the verifier, not to the model.</p>
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
