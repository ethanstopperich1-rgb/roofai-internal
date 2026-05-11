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
    JobProcess,
    RoomInputOptions,
    WorkerOptions,
    cli,
    inference,
)
from livekit.agents.llm import FallbackAdapter as FallbackLLM
from livekit.agents.stt import FallbackAdapter as FallbackSTT
from livekit.agents.tts import FallbackAdapter as FallbackTTS
from livekit.plugins import ai_coustics, silero  # noqa: F401  (noise_cancellation kept available)
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
# Recording-disclosure opener — gated on SYDNEY_RECORDING_ENABLED.
#
# Florida is a TWO-PARTY consent state (Fla. Stat. §934.03). Several
# other Voxaris-target states are also two-party (CA, IL, MD, MA, MT,
# NV, NH, PA, WA). Saying "this call may be recorded" when we are NOT
# actually recording is misleading; saying it without two-party consent
# while we ARE recording is illegal in those states.
#
# Safe defaults:
#   - SYDNEY_RECORDING_ENABLED unset → no recording, no disclosure
#   - SYDNEY_RECORDING_ENABLED=true → opener carries disclosure, and the
#     entrypoint MUST also start a LiveKit room egress (not implemented
#     in this commit — wiring TBD). Setting this flag without wiring
#     egress just lies to the caller, so the flag is OFF by default.
_RECORDING_ENABLED = os.environ.get("SYDNEY_RECORDING_ENABLED", "false").lower() == "true"

_RECORDING_DISCLOSURE = (
    "This call may be recorded for quality. " if _RECORDING_ENABLED else ""
)

OPENER_BUSINESS_HOURS = (
    "Thanks for calling Noland's Roofing, this is Sydney, your virtual "
    "booking assistant. " + _RECORDING_DISCLOSURE +
    "How can I help you today?"
)

OPENER_AFTER_HOURS = (
    "Thanks for calling Noland's Roofing, this is Sydney, your virtual "
    "booking assistant. " + _RECORDING_DISCLOSURE +
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


def prewarm(proc: JobProcess) -> None:
    """Prewarm hook — runs ONCE per worker process at startup.

    Loads silero VAD into JobProcess.userdata so every subsequent call
    on this process can reuse it. Without this, the entrypoint pays a
    200-500ms ONNX load tax on EVERY incoming call. Matches Cassie +
    Deedy + Andie's pattern.
    """
    proc.userdata["vad"] = silero.VAD.load()
    logger.info("sydney worker prewarmed: silero VAD loaded")


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

    # ─── STT — Deepgram Nova-3 multilingual primary, Nova-2 fallback ─────────
    # Single-provider Sydney was a SPOF — Deepgram outage = no STT, dead call.
    stt = FallbackSTT([
        inference.STT(model="deepgram/nova-3", language="multi"),
        inference.STT(model="deepgram/nova-2"),
    ])

    # ─── LLM — gpt-4o-mini primary, gpt-4.1-mini fallback ────────────────────
    # Temp 0.7 preserved — Sydney's "warm receptionist" persona wants natural
    # variation. (Cassie/Deedy run at 0.3 for OPC-script compliance — different
    # use case.) max_tokens=180 caps responses to ~2-3 sentences per turn.
    llm = FallbackLLM([
        inference.LLM(
            model="openai/gpt-4o-mini",
            extra_kwargs={"temperature": 0.7, "max_tokens": 180},
        ),
        inference.LLM(
            model="openai/gpt-4.1-mini",
            extra_kwargs={"temperature": 0.7, "max_tokens": 180},
        ),
    ])

    # ─── TTS — Cartesia Sonic-3 "Southern Woman" primary (CLIENT-LOCKED) ─────
    # Voice ID f9836c6e + speed 1.15 are confirmed by client — do NOT change.
    # Fallback 1: Cartesia Sonic-2 with the SAME voice ID — degraded model,
    #             same voice, no audible drift if Sonic-3 5xx's.
    # Fallback 2: Rime Arcana luna — different vendor, last-resort fallback.
    #             Slight voice drift but ensures the call doesn't go silent.
    tts = FallbackTTS([
        inference.TTS(
            model="cartesia/sonic-3",
            voice=CARTESIA_VOICE_ID,
            extra_kwargs={"speed": 1.15},
        ),
        inference.TTS(
            model="cartesia/sonic-2",
            voice=CARTESIA_VOICE_ID,
            extra_kwargs={"speed": 1.15},
        ),
        inference.TTS(model="rime/arcana", voice="luna"),
    ])

    session = AgentSession(
        stt=stt,
        llm=llm,
        tts=tts,
        # VAD prewarmed once per JobProcess via prewarm() — saves ~200-500ms
        # ONNX load per call. Inline silero.VAD.load() was hot-loading the
        # model on every dispatch.
        vad=ctx.proc.userdata["vad"],
        turn_detection=MultilingualModel(),
        # ─── Latency optimizations aligned with Cassie + Deedy + Andie ───────
        # preemptive_generation: LLM starts generating BEFORE the caller's
        # turn-end fires. Response is mostly ready by the time turn-detection
        # confirms. Bigger perceived-latency win than any single STT/TTS tweak.
        preemptive_generation=True,
        # Barge-in: caller can interrupt Sydney mid-sentence. 2+ words OR 400ms
        # of speech before it triggers — backchannels ("uh-huh") don't cut her off.
        allow_interruptions=True,
        min_interruption_words=2,
        min_interruption_duration=0.4,
        # Word-aligned transcript for live dashboard view — zero latency cost.
        use_tts_aligned_transcript=True,
        # IVR detection: if the caller is actually a phone tree (not a human),
        # exit cleanly instead of trying to book an inspection with a robot.
        ivr_detection=True,
    )

    # ─── Hard call limits (defense-in-depth against runaway calls) ──────────
    # max_tokens=180 caps EACH LLM turn but doesn't bound the call. A stuck
    # caller (drunk, confused, malicious) can keep Sydney engaged indefinitely
    # — at LK Cloud Inference rates, a 30-minute loop can burn $5+ per call.
    # Two ceilings: wall-clock duration + total user turn count.
    import asyncio as _asyncio
    import time as _time

    MAX_CALL_DURATION_SEC = int(os.environ.get("SYDNEY_MAX_CALL_DURATION_SEC", "900"))
    MAX_TURNS = int(os.environ.get("SYDNEY_MAX_TURNS", "80"))
    _call_start = _time.monotonic()
    _user_turns = 0

    async def _enforce_call_duration_cap() -> None:
        """Sleep until the max-duration ceiling, then end the call cleanly.

        Runs as a background task off entrypoint(). Cancelled in the
        shutdown handler if the call ends naturally first."""
        await _asyncio.sleep(MAX_CALL_DURATION_SEC)
        logger.warning(
            "sydney hit MAX_CALL_DURATION_SEC=%d on room=%s — ending call",
            MAX_CALL_DURATION_SEC, ctx.room.name,
        )
        try:
            await session.say(
                "I want to make sure we get you to the right person — let me "
                "have a teammate call you back so we can take care of this "
                "properly. Thanks so much for calling Noland's.",
                allow_interruptions=False,
            )
        except Exception:
            pass
        ctx.shutdown()

    duration_task = _asyncio.create_task(_enforce_call_duration_cap())

    # Per-call usage telemetry + turn count enforcement.
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

    @session.on("user_input_transcribed")
    def _on_user_turn(ev) -> None:  # type: ignore[no-untyped-def]
        """Count user turns. End the call when MAX_TURNS exceeded.

        Used in conjunction with the wall-clock cap above so a fast looper
        can't blow the budget by jamming turns faster than the duration cap
        catches them.
        """
        nonlocal _user_turns
        # Only count COMPLETE user turns (not interim transcripts).
        if not getattr(ev, "is_final", True):
            return
        _user_turns += 1
        if _user_turns >= MAX_TURNS:
            logger.warning(
                "sydney hit MAX_TURNS=%d on room=%s after %.0fs — ending call",
                MAX_TURNS, ctx.room.name, _time.monotonic() - _call_start,
            )
            _asyncio.create_task(_say_and_shutdown())

    async def _say_and_shutdown() -> None:
        try:
            await session.say(
                "Sounds like we've got a lot to cover — let me have a teammate "
                "call you back so they can give you their full attention. Thanks "
                "for calling Noland's.",
                allow_interruptions=False,
            )
        except Exception:
            pass
        ctx.shutdown()

    # Shutdown summary — runs whether the call ended cleanly or not. Logs
    # the disconnect reason + cost-ceiling state for every call.
    async def _on_shutdown() -> None:
        reason = str(getattr(ctx, "shutdown_reason", "unknown"))
        elapsed = _time.monotonic() - _call_start
        logger.info(
            "shutdown room=%s reason=%s elapsed=%.1fs turns=%d",
            ctx.room.name, reason, elapsed, _user_turns,
        )
        # Cancel the wall-clock timer if the call ended for any other reason.
        if not duration_task.done():
            duration_task.cancel()

    ctx.add_shutdown_callback(_on_shutdown)

    await session.start(
        agent=SydneyAgent(),
        room=ctx.room,
        room_input_options=RoomInputOptions(
            # Upgraded from Krisp BVCTelephony() to ai-coustics QUAIL_VF_L.
            # Per LK docs (transport/media/noise-cancellation), QUAIL_VF_L
            # lands at 11.8% WER vs Krisp BVC's 23.5% on agent-pipeline
            # workloads — explicitly optimized for STT accuracy + turn
            # detection in noisy environments (convention floors, busy
            # showrooms, callers in noisy backyards inspecting damage).
            noise_cancellation=ai_coustics.audio_enhancement(
                model=ai_coustics.EnhancerModel.QUAIL_VF_L,
            ),
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
            prewarm_fnc=prewarm,
            agent_name="sydney",
            initialize_process_timeout=60.0,
            num_idle_processes=1,
        )
    )
