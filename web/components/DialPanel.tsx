"use client";

import Link from "next/link";
import { useState } from "react";

type AccountOption = { id: string; full_name: string; phone: string };

export default function DialPanel({ agentId, accounts }: { agentId: string; accounts: AccountOption[] }) {
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ callId?: string; error?: string } | null>(null);

  async function dial() {
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/calls/outbound", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId, accountId }),
      });
      const body = await res.json();
      setResult(res.ok ? { callId: body.callId } : { error: body.error ?? "The call could not be placed.", callId: body.callId });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel stack">
      <div>
        <h2>Place a phone call</h2>
        <p className="muted small">Calling hours and the weekly attempt limit are checked before dialing and again by the agent.</p>
      </div>
      <label>
        Account
        <select value={accountId} onChange={(e: { target: { value: string } }) => setAccountId(e.target.value)}>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>{a.full_name} ({a.phone})</option>
          ))}
        </select>
      </label>
      <div className="actions">
        <button className="btn" onClick={dial} disabled={busy || !accountId}>{busy ? "Dialing" : "Call now"}</button>
      </div>
      {result?.error && (
        <div className="notice bad" role="alert">
          {result.error}
          {result.callId && <> The attempt was logged. <Link href={`/calls/${result.callId}`}>View record</Link></>}
        </div>
      )}
      {result?.callId && !result.error && (
        <div className="notice" role="status">
          Dialing now. <Link href={`/calls/${result.callId}`}>Follow the call live</Link>
        </div>
      )}
    </div>
  );
}
