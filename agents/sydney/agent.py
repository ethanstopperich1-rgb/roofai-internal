"""Sydney — Noland's Roofing voice agent demo.

Uses LiveKit Cloud Inference for LLM/STT/TTS — no separate OpenAI/Deepgram/
Cartesia keys required. Provider calls and billing flow through your LiveKit
project.

Run modes:
  python agent.py console   # talk to Sydney in your terminal
  python agent.py dev       # run as a worker; calls to the LK number ring here
"""

from __future__ import annotations

import logging
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from dotenv import load_dotenv

from livekit.agents import (
    Agent,
    AgentSession,
    JobContext,
    RoomInputOptions,
    WorkerOptions,
    cli,
    inference,
)
from livekit.plugins import noise_cancellation, silero
from livekit.plugins.turn_detector.multilingual import MultilingualModel

from tools import ALL_TOOLS

load_dotenv()

logger = logging.getLogger("sydney")
logging.basicConfig(level=logging.INFO)

# Default to v2 (5-phase Cassie-style structure + voice realism). Override
# with PROMPT_VERSION=v1 to fall back to the original prompt.
import os
_PROMPT_VERSION = os.environ.get("PROMPT_VERSION", "v2").lower()
_PROMPT_FILE = (
    "sydney_system_prompt.md" if _PROMPT_VERSION == "v1"
    else "sydney_system_prompt_v2.md"
)
PROMPT_PATH = Path(__file__).parent / "prompts" / _PROMPT_FILE
SYSTEM_PROMPT = PROMPT_PATH.read_text(encoding="utf-8")

# Cartesia "Southern Woman" voice ID. Confirmed by client.
CARTESIA_VOICE_ID = "f9836c6e-a0bd-460e-9d3c-f7299fa60f94"

# Verbatim openers — fed straight to TTS via session.say() so we skip the
# LLM round-trip on the first response. Matches the pattern in Noland's
# system prompt and saves ~1-2s of first-response latency.
OPENER_BUSINESS_HOURS = (
    "Thanks for calling Noland's Roofing, this is Sydney, your virtual "
    "booking assistant. This call may be recorded for quality. "
    "How can I help you today?"
)

OPENER_AFTER_HOURS = (
    "Thanks for calling Noland's Roofing, this is Sydney, your virtual "
    "booking assistant. This call may be recorded for quality. "
    "Our offices are closed right now, but I can get you on the schedule "
    "or take down your info and have someone reach out first thing. "
    "What's going on?"
)


def pick_opener() -> str:
    """Business-hours opener Mon-Fri 8am-5pm Eastern, after-hours otherwise."""
    now = datetime.now(ZoneInfo("America/New_York"))
    is_weekday = now.weekday() < 5  # 0=Mon, 6=Sun
    is_business_hours = 8 <= now.hour < 17
    return OPENER_BUSINESS_HOURS if (is_weekday and is_business_hours) else OPENER_AFTER_HOURS


class SydneyAgent(Agent):
    def __init__(self) -> None:
        super().__init__(instructions=SYSTEM_PROMPT, tools=ALL_TOOLS)


async def entrypoint(ctx: JobContext) -> None:
    await ctx.connect()

    # Wait for the SIP/PSTN caller to actually land in the room before
    # spinning up the session. Without this, session.start can race the
    # SIP leg and end up with no participant to talk to — caller hears
    # ringing forever.
    try:
        await ctx.wait_for_participant()
    except Exception as e:
        logger.warning("no participant arrived: %s", e)
        ctx.shutdown()
        return

    session = AgentSession(
        llm=inference.LLM(
            model="openai/gpt-4o-mini",
            extra_kwargs={"temperature": 0.7},
        ),
        stt=inference.STT(model="deepgram/nova-3", language="multi"),
        tts=inference.TTS(
            model="cartesia/sonic-3",
            voice=CARTESIA_VOICE_ID,
            # Cartesia speed is a MULTIPLIER, not a delta. 1.0 = natural
            # pace; 1.15 = ~15% faster. Anything below 1.0 slows speech;
            # anything above speeds it up. The "Southern Woman" voice is
            # on the slower end by design, so we nudge it up to feel
            # like a working receptionist, not a sleepy storyteller.
            extra_kwargs={"speed": 1.15},
        ),
        vad=silero.VAD.load(),
        turn_detection=MultilingualModel(),
        # IVR detection: if the caller is actually a phone tree (not a
        # human), the model recognizes it and won't try to book an
        # inspection with a robot. Same flag Andie uses.
        ivr_detection=True,
    )

    # Per-call usage telemetry. Logs token counts, TTS chars, STT seconds
    # for every turn so we can attribute cost + latency per call. Hooks for
    # a future dashboard: pipe into a /api/agent/events POST when ready.
    @session.on("session_usage_updated")
    def _on_usage(ev) -> None:  # type: ignore[no-untyped-def]
        u = getattr(ev, "usage", ev)
        logger.info(
            "usage room=%s llm_in=%s llm_out=%s tts_chars=%s stt_secs=%s",
            ctx.room.name,
            getattr(u, "llm_prompt_tokens", None),
            getattr(u, "llm_completion_tokens", None),
            getattr(u, "tts_characters_count", None),
            getattr(u, "stt_audio_duration", None),
        )

    # Shutdown summary — runs whether the call ended cleanly or not. Logs
    # the disconnect reason for every call so we can audit drop patterns.
    async def _on_shutdown() -> None:
        reason = str(getattr(ctx, "shutdown_reason", "unknown"))
        logger.info("shutdown room=%s reason=%s", ctx.room.name, reason)

    ctx.add_shutdown_callback(_on_shutdown)

    await session.start(
        agent=SydneyAgent(),
        room=ctx.room,
        room_input_options=RoomInputOptions(
            # BVCTelephony is the SIP/PSTN-tuned NC variant. The plain
            # BVC() is for WebRTC calls and breaks the audio negotiation
            # on phone calls.
            noise_cancellation=noise_cancellation.BVCTelephony(),
        ),
    )

    # Skip the LLM for the verbatim opener. session.say() pipes the text
    # straight to TTS — saves ~1-2s of first-response latency vs running
    # generate_reply just to have the LLM regurgitate a fixed greeting.
    # The text is added to chat_ctx so the LLM still has it as the first
    # turn for subsequent context.
    await session.say(pick_opener(), allow_interruptions=True)


if __name__ == "__main__":
    # agent_name="sydney" → explicit dispatch only. The dispatch rule for
    # +13219851104 names this agent, so calls land here.
    # initialize_process_timeout=60 + num_idle_processes=1 mirrors Andie:
    # cgroup-throttled hosts spend 12-20s loading ONNX/Silero on a
    # fractional vCPU, blowing the default 10s timeout.
    cli.run_app(
        WorkerOptions(
            entrypoint_fnc=entrypoint,
            agent_name="sydney",
            initialize_process_timeout=60.0,
            num_idle_processes=1,
        )
    )
