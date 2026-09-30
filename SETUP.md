# Setup

About 60 to 90 minutes from zero accounts. Do the steps in order. Keep every key in `.env` files, never in code
or chat.

## 1. Supabase (database)

1. Create a project at supabase.com and wait for it to provision.
2. Open **SQL Editor** and run `supabase/schema.sql`, then `supabase/seed.sql`.
3. Put your own phone number on the test accounts (E.164 format, with `+90`):
   ```sql
   update accounts set phone = '+905XXXXXXXXX' where phone = '+900000000001';
   ```
   Repeat for `...002` and `...003` if you want more than one test account. Inbound calls are matched to an
   account by caller ID, so this is also what lets the agent recognise you when you call in.
4. From **Project settings > API**, copy the project URL and the `service_role` key.
5. Optional, for recordings: create a **private** Storage bucket named `recordings`, then generate S3 access keys under
   **Storage > S3 connection**.

## 2. LiveKit Cloud (agent hosting, speech, telephony)

1. Create a project at cloud.livekit.io. From **Settings > API keys**, copy the URL (`wss://...`), key and secret.
   STT, LLM and TTS run through LiveKit Inference with these same keys, so no separate Deepgram, OpenAI or Cartesia
   account is needed for calls.
2. Install the CLI (`brew install livekit-cli`, or see docs.livekit.io) and run `lk cloud auth`.

### Inbound: a number you call

1. **Telephony > Phone numbers**: buy a US number.
2. **Telephony > Dispatch rules**: create an *individual* rule for that number and set **Agent dispatch** to
   `lupitor-agent`. Every inbound call then gets its own room with the agent in it.
3. Calling a US number from Turkey is an international call. The browser test page is the free alternative.

### Outbound: the agent calls your Turkish number

LiveKit numbers are US only, so outbound to Turkey goes through a SIP trunk. Twilio is shown here; Telnyx works the
same way.

1. Twilio console: **Elastic SIP Trunking > Trunks > Create**.
   - **Termination**: set a termination URI (e.g. `lupitor-yourname.pstn.twilio.com`) and add a credential list
     (username and password).
   - **Numbers**: buy a Twilio number and attach it to the trunk. It becomes the caller ID.
2. Twilio **Geo permissions** for SIP trunking: enable **Turkey**. Without this, calls to +90 are rejected.
3. LiveKit **Telephony > SIP trunks > Outbound**: address = your termination URI, numbers = the Twilio number,
   plus the username and password from step 1. Copy the trunk ID (`ST_...`).

## 3. Agent worker

```bash
cd agent
python3.12 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env        # fill in LiveKit, SIP_OUTBOUND_TRUNK_ID, Supabase, OPENAI_API_KEY
python main.py download-files
pytest                      # deterministic tests, no network
python main.py dev          # runs the worker locally against LiveKit Cloud
```

Deploy to LiveKit Cloud when it works locally:

```bash
lk agent create --secrets-file .env    # builds the Dockerfile and deploys
```

If a CLI flag differs in your version, `lk agent --help` lists the current ones.

## 4. Web console

```bash
cd web
npm install
cp .env.example .env.local   # same LiveKit keys, Supabase URL and service key, RECORDINGS_BUCKET=recordings
npm run dev                  # http://localhost:3000
```

Deploy on Vercel: import the `web` folder, add the same environment variables, and set `CONSOLE_PASSWORD` so the
console is not public.

## 5. First run checklist

1. **Agents > Goldman Stanley Collections > Test in browser**: pick Dana Whitfield and verify with born
   1988-03-14 and ZIP 10027, or say you'll use the keypad and type 4417. Try to talk the price down.
2. **Place a phone call** to your own account from the agent page. If it is between 21:00 and 08:00 in the account's
   timezone, the call is blocked and the blocked attempt is logged. That is the contact rule working.
3. Call the US number from your phone to test inbound.
4. Run the red team: `python -m redteam.run --personas all --repeat 3`, then open **Red team**.
5. **Configuration**: save a v2 with a different tone, split traffic 50/50, and place a few calls.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Browser test says dispatch failed | `AGENT_NAME` differs between web and worker, or the worker is not running |
| Outbound call never rings | Twilio geo permission for Turkey, wrong trunk credentials, or number not in E.164 |
| Agent joins but stays silent | LiveKit Inference model string not available on your plan; change `llm`/`stt`/`tts` in the agent configuration |
| Error mentioning `llm_node` or `ChatChunk` | LiveKit Agents API changed; pin `livekit-agents` to the 1.2 line or adapt `flows/collections.py::GuardedAgent.llm_node` |
| Inbound caller not recognised | Their number is not on any account; the agent will ask for the number on the account |
