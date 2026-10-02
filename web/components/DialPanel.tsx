"use client";

import Link from "next/link";
import { useState } from "react";

type AccountOption = { id: string; full_name: string; phone: string };

export default function DialPanel({ agentId, accounts }: { agentId: string; accounts: AccountOption[] }) {
  const [mode, setMode] = useState<"custom" | "account">("custom");
  const [customPhone, setCustomPhone] = useState("+905326382424");
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ callId?: string; error?: string } | null>(null);

  const effectivePhone = mode === "custom" ? customPhone.trim() : accounts.find((a) => a.id === accountId)?.phone;

  async function dial() {
    if (!effectivePhone) return;
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/calls/outbound", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId,
          accountId,
          phone: mode === "custom" ? customPhone.trim() : undefined,
        }),
      });
      const body = await res.json();
      setResult(res.ok ? { callId: body.callId } : { error: body.error ?? "The call could not be placed.", callId: body.callId });
    } catch (e) {
      setResult({ error: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel stack">
      <div>
        <h2>Place a phone call</h2>
        <p className="muted small">
          Enter any phone number to dial via SIP trunk, or pick an existing customer account.
        </p>
      </div>

      <div style={{ display: "flex", gap: 6, borderBottom: "1px solid var(--rule)", paddingBottom: 6 }}>
        <button
          type="button"
          className="btn ghost"
          style={{
            fontSize: 13,
            padding: "4px 10px",
            fontWeight: mode === "custom" ? 700 : 400,
            background: mode === "custom" ? "var(--ledger-soft)" : "transparent",
            color: mode === "custom" ? "var(--ledger)" : "var(--ink)",
          }}
          onClick={() => setMode("custom")}
        >
          Custom phone number
        </button>
        <button
          type="button"
          className="btn ghost"
          style={{
            fontSize: 13,
            padding: "4px 10px",
            fontWeight: mode === "account" ? 700 : 400,
            background: mode === "account" ? "var(--ledger-soft)" : "transparent",
            color: mode === "account" ? "var(--ledger)" : "var(--ink)",
          }}
          onClick={() => setMode("account")}
        >
          Saved accounts
        </button>
      </div>

      {mode === "custom" ? (
        <>
          <label>
            Phone number (E.164 format with country code)
            <input
              type="tel"
              placeholder="+905XXXXXXXXX"
              value={customPhone}
              onChange={(e) => setCustomPhone(e.target.value)}
            />
          </label>
          <label>
            Customer profile & debt context
            <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>{a.full_name} ({a.phone})</option>
              ))}
            </select>
          </label>
        </>
      ) : (
        <label>
          Account
          <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>{a.full_name} ({a.phone})</option>
            ))}
          </select>
        </label>
      )}

      <div className="actions">
        <button className="btn" onClick={dial} disabled={busy || !effectivePhone}>
          {busy ? "Dialing..." : `Call ${effectivePhone || "number"} now`}
        </button>
      </div>

      {result?.error && (
        <div className="notice bad" role="alert">
          {result.error}
          {result.callId && <> The attempt was logged. <Link href={`/calls/${result.callId}`}>View record</Link></>}
        </div>
      )}

      {result?.callId && !result.error && (
        <div className="notice" role="status">
          Dialing {effectivePhone}. <Link href={`/calls/${result.callId}`}>Follow the call live</Link>
        </div>
      )}
    </div>
  );
}
