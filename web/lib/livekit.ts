import "server-only";
import { AccessToken, AgentDispatchClient, RoomServiceClient } from "livekit-server-sdk";
import type { AgentVersion } from "./types";

function env() {
  const url = process.env.LIVEKIT_URL;
  const key = process.env.LIVEKIT_API_KEY;
  const secret = process.env.LIVEKIT_API_SECRET;
  if (!url || !key || !secret) throw new Error("LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET must be set");
  return { url, http: url.replace(/^ws/, "http"), key, secret, agentName: process.env.AGENT_NAME || "lupitor-agent" };
}

export type DispatchMeta = {
  call_id: string;
  agent_version_id: string;
  account_id?: string | null;
  direction: "outbound" | "browser";
  phone?: string;
};

export async function dispatchAgent(room: string, meta: DispatchMeta) {
  const e = env();
  await new RoomServiceClient(e.http, e.key, e.secret).createRoom({ name: room, emptyTimeout: 120, maxParticipants: 4 });
  await new AgentDispatchClient(e.http, e.key, e.secret).createDispatch(room, e.agentName, {
    metadata: JSON.stringify(meta),
  });
}

export async function participantToken(room: string, identity: string) {
  const e = env();
  const at = new AccessToken(e.key, e.secret, { identity, ttl: "20m" });
  at.addGrant({ room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true });
  return { token: await at.toJwt(), url: e.url };
}

/** Silent supervisor token for real-time call observance. */
export async function observerToken(room: string, identity: string) {
  const e = env();
  const at = new AccessToken(e.key, e.secret, { identity, ttl: "30m" });
  at.addGrant({ room, roomJoin: true, canPublish: false, canSubscribe: true, canPublishData: false, hidden: true });
  return { token: await at.toJwt(), url: e.url };
}

/** Weighted random pick across versions that have traffic (A/B split). */
export function pickVersion(versions: AgentVersion[]): AgentVersion | undefined {
  const live = versions.filter((v) => v.traffic_weight > 0);
  if (live.length === 0) return [...versions].sort((a, b) => b.version - a.version)[0];
  let r = Math.random() * live.reduce((s, v) => s + v.traffic_weight, 0);
  for (const v of live) {
    r -= v.traffic_weight;
    if (r <= 0) return v;
  }
  return live[live.length - 1];
}
