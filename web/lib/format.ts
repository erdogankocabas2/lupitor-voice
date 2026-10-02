export function when(iso: string | null | undefined): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function duration(s: number | null | undefined): string {
  if (s == null) return "";
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function usd(v: number | string | null | undefined): string {
  if (v == null || v === "") return "";
  return Number(v).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

const LABELS: Record<string, string> = {
  in_progress: "In progress",
  no_agreement: "No agreement reached",
  caller_hangup: "Caller hung up",
  promise_to_pay: "Promise to pay",
  did_not_connect: "Did not connect",
  timed_out: "Timed out",
  wrong_number: "Wrong number",
  not_available: "Not available",
  refused_to_verify: "Refused verification",
  verification_failed: "Verification failed",
  escalated_hardship: "Escalated (Hardship)",
  escalated_dispute: "Escalated (Dispute)",
  escalated_identity_theft: "Escalated (Fraud)",
  escalated_attorney: "Escalated (Attorney)",
  escalated_cease_contact: "Escalated (Cease contact)",
  escalated_requested_human: "Escalated (Requested human)",
  escalated_crisis: "Escalated (988 Crisis)",
  escalated_other: "Escalated (Specialist)",
};

export function label(s: string | null | undefined): string {
  if (!s) return "";
  if (LABELS[s]) return LABELS[s];
  const t = s.replace(/_/g, " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export function formatCallFailure(summary: Record<string, any> | null | undefined): { short: string; detail: string } | null {
  if (!summary) return null;
  const err = String(summary.error || "");
  const sip = String(summary.sip_status || "");

  if (sip === "403" || err.includes("not included in whitelisted countries") || err.includes("TUR")) {
    return {
      short: "SIP 403: Telnyx TR izni yok",
      detail: "SIP 403 Forbidden: Telnyx Outbound Voice Profile only whitelisted USA/CAN. The dialed country (+90 Turkey) is not enabled on this profile.",
    };
  }
  if (err.includes("sip server required auth") || err.includes("no username or password")) {
    return {
      short: "SIP Trunk Auth Hatası",
      detail: "SIP Authentication Required: LiveKit SIP Trunk credentials were missing or rejected by the SIP carrier.",
    };
  }
  if (err.includes("timed out") || err.includes("did not connect") || err.includes("Connection timed out")) {
    return {
      short: "Bağlantı zaman aşımı",
      detail: "Connection Timed Out: Call was not answered or agent worker was offline before connecting.",
    };
  }
  if (err) {
    const clean = err.replace(/^twirp error [^:]*:\s*/i, "");
    return {
      short: clean.length > 28 ? clean.slice(0, 25) + "..." : clean,
      detail: clean,
    };
  }
  if (sip) {
    return {
      short: `SIP ${sip}`,
      detail: `SIP error code ${sip}`,
    };
  }
  return null;
}
