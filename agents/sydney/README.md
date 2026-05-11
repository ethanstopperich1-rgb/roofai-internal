# Sydney — Noland's Roofing Voice Agent

LiveKit Agents Python worker that handles inbound calls for Noland's Roofing
(4 FL offices). Greets, triages emergencies, schedules free inspections,
warmly transfers to humans on-call.

Lives alongside the Voxaris Pitch Next.js app in the same repo because they
share the same business workflow — Sydney captures leads, the rep tool
estimates roofs.

## Stack

- **Framework:** LiveKit Agents 1.x (Python 3.11+)
- **LLM / STT / TTS:** LiveKit Cloud Inference (provider billing flows
  through your LiveKit project — no separate OpenAI/Deepgram/Cartesia
  accounts needed for the agent itself).
  - LLM: `openai/gpt-4o-mini` primary, `openai/gpt-4.1-mini` fallback
  - STT: `deepgram/nova-3` multilingual primary, `deepgram/nova-2` fallback
  - TTS: `cartesia/sonic-3` "Southern Woman" primary, `cartesia/sonic-2`
    same-voice fallback, `rime/arcana` luna last-resort
- **Turn detection:** LiveKit multilingual semantic model
- **Noise cancellation:** ai-coustics QUAIL_VF_L (11.8% WER vs Krisp BVC 23.5%
  per LK docs, optimized for STT accuracy in noisy environments)
- **VAD:** Silero, prewarmed once per worker process

## Prerequisites

- Python 3.11+
- [LiveKit Cloud](https://livekit.io/) account
- (Optional) Direct provider keys for local console mode without LK Inference

## Setup

```bash
cd agents/sydney
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

cp .env.example .env
# Fill in LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET — that's all
# that's required for LK Cloud Inference to work.
```

Then download the turn-detection / VAD model files (one-time):

```bash
python agent.py download-files
```

## Run

**Console mode** — talk to Sydney directly in the terminal:

```bash
python agent.py console
```

**Dev mode** — runs as a LiveKit worker. Open the
[Agent Playground](https://agents-playground.livekit.io/) and connect to
your LiveKit project to dial in:

```bash
python agent.py dev
```

**Production (LiveKit Cloud Agents):**

```bash
# In agents/sydney/, with livekit.toml committed
lk agent create     # one-time
lk agent deploy     # subsequent deploys
```

## Phone number wiring

Sydney's inbound number is registered in `setup_sip.py` as
`+13219851104` (override with `INBOUND_NUMBER` env var for other deploys).
After deploying the agent, run setup_sip.py once to create the dispatch
rule that routes inbound calls into agent rooms:

```bash
python setup_sip.py
```

## Tests

```bash
pytest tests/
```

The smoke test hits OpenAI directly and verifies emergency-empathy behavior
on a "leak" mention.

## Tools

| Tool | Mode | Behavior |
|------|------|----------|
| `transfer_to_human` | Real-when-configured | Dials on-call human via LK SIP outbound trunk when `SIP_OUTBOUND_TRUNK_ID` + `ESCALATION_*_PHONE` env vars are set (must be E.164). Otherwise logs a redacted line. |
| `book_inspection` | **Mock** | Returns `status: "mock_booked"` + `confirmation_number: "MOCK-NL-DEMO-12345"` + `demo_mode: True`. The LLM uses `demo_mode` to avoid falsely confirming. **Production: wire to JobNimbus appointment + contact create, plus SMS confirmation via Sendblue/Twilio.** |
| `log_lead` | **Mock** | Returns `status: "mock_logged"` + `lead_id: "MOCK-LEAD-DEMO-98765"` + `demo_mode: True`. **Production: wire to JobNimbus contact + lead source tagging.** |

All three log a redacted structured line on invocation (SHA-256 first-12
of name/phone/email/address; full PII goes only to CRM downstream when
wired up).

## Voice

Pinned to Cartesia's "Southern Woman" voice
(`f9836c6e-a0bd-460e-9d3c-f7299fa60f94`). The Cartesia fallback (Sonic-2)
uses the SAME voice ID so callers hear no voice drift on the degraded
path. The Rime fallback is last-resort with audible voice drift —
better than silence.

## Safety / cost ceilings

- **Per-call wall-clock cap:** `SYDNEY_MAX_CALL_DURATION_SEC=900` (15 min)
- **Per-call user turn cap:** `SYDNEY_MAX_TURNS=80`
- **Per-turn LLM cap:** `max_tokens=180` (~2-3 sentences)

When a cap fires, Sydney politely tells the caller a teammate will follow
up, then ends the call. Defense-in-depth against stuck / malicious callers
burning inference budget.

## Recording

OFF by default. The opener does NOT promise recording unless
`SYDNEY_RECORDING_ENABLED=true` is set. Florida is a two-party consent
state (Fla. Stat. §934.03) — saying "this call may be recorded" while not
recording is misleading; saying it without consent while recording is
illegal. We don't currently wire LiveKit room egress for recording.

## Known limitations / v2 roadmap

- Mocked `book_inspection` + `log_lead` (see Tools table). Production
  needs JobNimbus integration.
- Single monolithic agent. Production should split into greeting →
  qualifier → scheduler with LK workflow handoffs.
- No real SMS confirmation post-booking. Add Twilio/Sendblue after wiring
  JobNimbus.
- No recording / egress. Add LiveKit egress + retention policy if needed.
- No admin dashboard for live call view + per-call cost attribution.

## Project layout

```
.
├── agent.py                          entrypoint + AgentSession wiring
├── tools.py                          transfer_to_human (real) + 2 mocks
├── setup_sip.py                      dispatch-rule wiring helper
├── prompts/
│   ├── sydney_system_prompt.md       v1 (217 lines)
│   └── sydney_system_prompt_v2.md    v2 (default — 5-phase structure)
├── tests/
│   └── test_sydney.py                smoke test (leak → emergency-empathy)
├── Dockerfile                        prewarmed-VAD container image
├── livekit.toml                      LK Cloud Agent deploy config
├── requirements.txt
├── .env.example
└── README.md
```
