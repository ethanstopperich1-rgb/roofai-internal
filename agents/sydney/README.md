# Sydney — Noland's Roofing Voice Agent (Demo)

A LiveKit Agents demo of "Sydney", an inbound voice receptionist for Noland's
Roofing. Single-agent, monolithic, mocked tools — built for a client pitch,
not production traffic.

## Stack

- **Framework:** LiveKit Agents 1.x (Python)
- **LLM:** OpenAI `gpt-4o-mini`
- **STT:** Deepgram `nova-3` with `language="multi"` (English + Spanish auto-detect)
- **TTS:** Cartesia `sonic-3`, voice = "Southern Woman"
- **Turn detection:** LiveKit multilingual semantic model
- **Noise cancellation:** LiveKit Cloud BVC

## Prerequisites

- Python 3.11+
- Accounts: [LiveKit Cloud](https://livekit.io/), [OpenAI](https://platform.openai.com/),
  [Deepgram](https://deepgram.com/), [Cartesia](https://cartesia.ai/)

## Setup

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

cp .env.example .env
# fill in all six API keys
```

Then download the turn-detection / VAD model files (one-time):

```bash
python agent.py download-files
```

## Run

**Console mode** — talk to Sydney directly in the terminal, no LiveKit room needed:

```bash
python agent.py console
```

**Dev mode** — runs as a LiveKit worker. Open the
[Agent Playground](https://agents-playground.livekit.io/) and connect to your
LiveKit project to dial in:

```bash
python agent.py dev
```

## Tests

```bash
pytest tests/
```

The smoke test hits OpenAI, so it costs a few cents per run. It verifies Sydney
asks about active water intrusion when a caller mentions a leak.

## Voice

Pinned to Cartesia's "Southern Woman" voice
(`f9836c6e-a0bd-460e-9d3c-f7299fa60f94`). To swap, browse
[play.cartesia.ai/voices](https://play.cartesia.ai/voices) and replace
`CARTESIA_VOICE_ID` in `agent.py`.

## What's mocked vs. real

| Tool | Status | Production target |
|------|--------|-------------------|
| `transfer_to_human` | Prints to stdout | LiveKit SIP transfer + on-call paging |
| `book_inspection` | Prints to stdout, returns fake confirmation | JobNimbus appointment + contact create |
| `log_lead` | Prints to stdout | JobNimbus contact + lead source tagging |

All three log a clearly-bordered banner to stdout so you can watch them fire
during a demo call. The system prompt lives in
[`prompts/sydney_system_prompt.md`](prompts/sydney_system_prompt.md) — iterate
there without touching Python.

## Known limitations / v2 roadmap

- Mocked tools (see table above).
- Single monolithic agent. Production should split into greeting → qualifier →
  scheduler with LiveKit workflow handoffs.
- No real SMS confirmation. Add Twilio or Sendblue after `book_inspection`.
- No real human transfer. Wire LiveKit SIP for warm transfer.
- No analytics, no recording, no admin UI. Demo only.

## Project layout

```
.
├── agent.py                       entrypoint + AgentSession wiring
├── tools.py                       three mocked function tools
├── prompts/
│   └── sydney_system_prompt.md    Sydney's personality + flows + guardrails
├── tests/
│   └── test_sydney.py             smoke test against the real LLM
├── requirements.txt
├── .env.example
└── README.md
```
