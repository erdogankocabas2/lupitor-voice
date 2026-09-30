"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/supabase";
import type { AgentConfig } from "@/lib/types";

function configFrom(form: FormData): AgentConfig {
  const s = (k: string) => String(form.get(k) ?? "").trim();
  return {
    persona_name: s("persona_name") || "Alex",
    company: s("company") || "Goldman Stanley",
    callback_number: s("callback_number"),
    greeting: s("greeting"),
    llm: s("llm"),
    stt: s("stt"),
    tts: s("tts"),
    extra_instructions: s("extra_instructions"),
  };
}

export async function createAgent(form: FormData) {
  const name = String(form.get("name") ?? "").trim();
  const template = form.get("template") === "generic" ? "generic" : "collections";
  if (!name) throw new Error("Name is required");
  const { data: agent, error } = await db()
    .from("agents")
    .insert({ name, description: String(form.get("description") ?? "").trim() || null, template })
    .select()
    .single();
  if (error) throw new Error(error.message);
  const { error: vErr } = await db()
    .from("agent_versions")
    .insert({ agent_id: agent.id, version: 1, config: configFrom(form), notes: "Initial version", traffic_weight: 100 });
  if (vErr) throw new Error(vErr.message);
  redirect(`/agents/${agent.id}`);
}

/** Saving never edits a version: it appends a new one (versions are immutable in the database). */
export async function saveVersion(form: FormData) {
  const agentId = String(form.get("agent_id"));
  const makeLive = form.get("make_live") === "on";
  const { data: latest } = await db()
    .from("agent_versions")
    .select("version")
    .eq("agent_id", agentId)
    .order("version", { ascending: false })
    .limit(1)
    .single();
  const next = (latest?.version ?? 0) + 1;
  if (makeLive) {
    await db().from("agent_versions").update({ traffic_weight: 0 }).eq("agent_id", agentId);
  }
  const { error } = await db()
    .from("agent_versions")
    .insert({
      agent_id: agentId,
      version: next,
      config: configFrom(form),
      notes: String(form.get("notes") ?? "").trim() || null,
      traffic_weight: makeLive ? 100 : 0,
    });
  if (error) throw new Error(error.message);
  revalidatePath(`/agents/${agentId}`);
  redirect(`/agents/${agentId}/edit?saved=${next}`);
}

export async function setTraffic(form: FormData) {
  const agentId = String(form.get("agent_id"));
  const weights: { id: string; w: number }[] = [];
  for (const [k, v] of form.entries()) {
    if (k.startsWith("w_")) weights.push({ id: k.slice(2), w: Math.max(0, Math.min(100, Number(v) || 0)) });
  }
  const total = weights.reduce((s, x) => s + x.w, 0);
  if (total !== 100) redirect(`/agents/${agentId}/edit?traffic_error=${total}`);
  for (const { id, w } of weights) {
    await db().from("agent_versions").update({ traffic_weight: w }).eq("id", id).eq("agent_id", agentId);
  }
  revalidatePath(`/agents/${agentId}/edit`);
  redirect(`/agents/${agentId}/edit?traffic_saved=1`);
}

export async function setInbound(form: FormData) {
  const agentId = String(form.get("agent_id"));
  await db().from("agents").update({ handles_inbound: false }).neq("id", agentId);
  await db().from("agents").update({ handles_inbound: true }).eq("id", agentId);
  revalidatePath("/");
  redirect(`/agents/${agentId}/edit`);
}
