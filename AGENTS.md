# AGENTS.md

Instructions for AI coding agents working in this repository. Read this fully before changing code.
Human-oriented docs: `README.md` (what and why), `SETUP.md` (accounts and deploy), `docs/DESIGN.md` (decisions,
threat model, known limits).

## What this project is

A take-home technical assessment for **Lupitor** (enterprise voice agents for regulated industries). The brief:

1. A full-stack voice agent platform: agent hosting on **LiveKit**, a UI to create and edit voice agents, a UI to see
   every call per agent, and a DaaS database that is **never cleared** (reviewers want to see the test history).
2. A collection voice agent for the fictional bank **Goldman Stanley**, over telephony, with identity verification
   tools, which the caller **must not be able to manipulate into lowering the minimum acceptable amount**.

Reviewers value originality and robustness. The core idea: **the LLM talks, deterministic code decides.**

## Layout

```
agent/                 Python 3.12, LiveKit Agents 1.x worker (agent_name from AGENT_NAME env)
  main.py              entrypoint: dispatch metadata, compliance gate, dialing, session, logging, recording
  core/                pure Python, NO livekit imports; unit-tested
    policy.py          OfferEngine: settlement ladder, proposals, payment plans, commit-by-offer_id
    guard.py           ResponseGuard + SentenceBuffer: screens every LLM sentence before TTS
    verification.py    Verifier: DOB + ZIP or keypad SSN4, server-side compare, 3-strike lockout
    toolkit.py         CollectionsToolkit: all tool behaviour, shared by voice agent AND red team
    prompts.py         stage instructions + verbatim scripts (disclosure, read-back, voicemail...)
    db.py              Supabase access + EventSink (batched, off the audio path)
    config.py          AgentConfig from agent_versions.config
  flows/               LiveKit Agent classes
    collections.py     GuardedAgent (llm_node guard), VerificationAgent -> NegotiationAgent handoff, KeypadBuffer
    generic.py         GenericAgent for the "generic" template
  redteam/             attacker-LLM harness against a text twin of the agent; results stored in DB
  tests/test_core.py   deterministic tests for core/
web/                   Next.js 15 App Router, React 19, TypeScript, plain CSS (no Tailwind)
  app/actions.ts       server actions (create agent, save version, traffic split, inbound routing)
  app/api/calls/*      outbound dial, browser test token, event polling
  components/          CallTimeline (live transcript + guard stamps), TestCall, DialPanel, AgentForm...
  lib/                 supabase (server-only), livekit (dispatch, tokens, weighted version pick), types
supabase/schema.sql    tables, append-only triggers, can_contact() compliance function
supabase/seed.sql      policies, fictional accounts, two agents (run ONCE)
```

## Invariants: never break these

These are the product. If a change would violate one, stop and ask the user instead.

1. **The settlement floor never reaches the LLM.** Not in prompts, tool descriptions, tool outputs, or error messages.
   `OfferEngine.floor_for_audit()` exists only for red-team scoring; never call it from a tool path.
2. **Commit is by `offer_id` only.** `confirm_arrangement` must never accept an amount. Only engine-issued offers can be
   committed, and `OfferEngine.commit` re-checks the floor.
3. **Low proposals must not move the ladder.** `evaluate_proposal` below the current offer returns the current offer
   unchanged. Only `next_offer()` descends, and it is capped by `max_concessions_per_call`.
4. **Every LLM sentence passes through `ResponseGuard`** (in `GuardedAgent.llm_node`). Do not remove or bypass it to fix
   latency or streaming bugs; fix the integration instead.
5. **No disclosure before verification.** Negotiation tools live only on `NegotiationAgent`. Before verification the
   guard blocks amounts and debt vocabulary.
6. **Verification values never go to the LLM.** The verifier returns a status only. Keypad digits (DTMF or the browser
   `dtmf` data topic) go from `KeypadBuffer` straight to the verifier.
7. **Scripts are verbatim.** Disclosure, read-back, voicemail, lockout and escalation text is spoken with
   `session.say()` from `core/prompts.py`, not generated.
8. **Hardship, dispute, identity theft, attorney and cease-contact requests escalate.** Never add a discount path for them.
9. **The database is append-only.** Never write DELETE/TRUNCATE, never drop or recreate tables, never add migrations
   that remove data. Triggers enforce this for `calls`, `call_events`, `arrangements` and `redteam_runs`.
   `agent_versions.config` is immutable; edits create a new version.
10. **Contact rules live in SQL `can_contact()`** and are checked by both the web API and the worker. Keep one source of truth.
11. **Offer policies are not part of agent config.** The agent editor must never read or write `offer_policies`.
12. **Secrets stay in `.env` / `.env.local` / platform secret stores.** Never hardcode keys, never print them in logs.
13. `core/` must stay free of LiveKit imports so it remains unit-testable and shared with the red team.

## Commands

```bash
# agent
cd agent && source .venv/bin/activate
pytest                                      # must stay green; add tests for any core/ change
python main.py download-files               # VAD + turn detector weights (once)
python main.py dev                          # local worker against LiveKit Cloud
python -m redteam.run --personas all        # adversarial runs, written to the DB
python -m redteam.run --no-db --personas fake_supervisor   # quick run, nothing stored
lk agent deploy                             # redeploy to LiveKit Cloud after changes

# web
cd web
npm run dev
npm run typecheck
npm run build                               # run before pushing; Vercel builds the same way
```

## Verifying a change

- Changes to `core/`: add or update a test in `agent/tests/test_core.py`, run `pytest`.
- Changes to negotiation, prompts, guard or tools: also run
  `python -m redteam.run --personas fake_supervisor,prompt_injector,floor_prober,hardship` and confirm all pass.
- Changes to `web/`: `npm run typecheck && npm run build`.
- Changes to `supabase/schema.sql`: must be idempotent (`if not exists`, `create or replace`) and must not remove data.
  Apply new statements in the Supabase SQL editor; never re-run `seed.sql`.

## Known unverified areas (likely first-run fixes)

This code was written without network access to LiveKit or Supabase. Expect small API mismatches here first:

- `flows/collections.py::GuardedAgent.llm_node`: constructing `llm.ChatChunk` / `llm.ChoiceDelta` and yielding `str`
  chunks. If the installed livekit-agents version differs, adapt the chunk handling but keep invariant 4.
- LiveKit Inference model strings in `core/config.py` and `web/lib/types.ts`
  (`openai/gpt-4.1-mini`, `deepgram/nova-3:en`, `cartesia/sonic-2:<voice_id>`). If rejected, switch to available
  strings or to provider plugins.
- `main.py`: `session.on(...)` event names and fields (`conversation_item_added`, `function_tools_executed` with
  `.zipped()`, `metrics_collected`), `RoomInputOptions`, `preemptive_generation`, `rtc.SipDTMF.digit`,
  `ctx.add_shutdown_callback` signature.
- Tools return `None` to suppress a follow-up LLM turn after `end_call`; confirm this behaviour in the installed version.
- `supabase-py` with the new `sb_secret_...` key format; the legacy `service_role` JWT is the safe choice.

When fixing these, prefer checking the installed package source (`pip show livekit-agents`, then read the module)
over guessing. The LiveKit CLI can also search docs: `lk docs search "<topic>"`.

## Style

- Python: type hints, dataclasses, small pure functions in `core/`. No new heavy dependencies without reason.
- TypeScript: server components by default; `"use client"` only for interactive pieces. The Supabase service key is
  server-only (`lib/supabase.ts` imports `server-only`); never import it into a client component.
- UI copy: sentence case, plain verbs, errors say what happened and what to do. Colors come from CSS variables in
  `web/app/globals.css`; the red "stamp" treatment is reserved for guard blocks.

## Test data

Fictional accounts from `seed.sql`. The main test identity is **Dana Whitfield**: born 1988-03-14, ZIP 10027,
SSN last 4 is 4417, balance $4,120.60, prime portfolio. The prime ladder is 100% / 90% / 82% / 75% with at most
2 concessions per call, so the agent cannot go below $3,378.89 on a single call. Test accounts 1 to 3 use the
Europe/Istanbul timezone and the developer's own phone number.
