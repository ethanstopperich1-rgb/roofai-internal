"""Smoke test for Sydney's emergency-empathy behavior.

Uses the LiveKit Agents test harness to drive a turn through the real LLM and
assert the agent acknowledges the leak and asks about active water intrusion
before doing anything else.

Requires OPENAI_API_KEY in the environment to run.
"""

from __future__ import annotations

import pytest
from dotenv import load_dotenv

from livekit.agents import AgentSession
from livekit.plugins import openai

from agent import SydneyAgent

load_dotenv()


@pytest.mark.asyncio
async def test_leak_triggers_active_water_check() -> None:
    """When a caller mentions a leak, Sydney must ask if water is currently
    coming in — that is the emergency-triage gate before anything else."""
    async with (
        AgentSession(llm=openai.LLM(model="gpt-4o-mini", temperature=0.3)) as session,
    ):
        await session.start(SydneyAgent())

        result = await session.run(user_input="hi I think I have a leak in my ceiling")

        result.expect.next_event().is_message(role="assistant").judge(
            llm=openai.LLM(model="gpt-4o-mini"),
            intent=(
                "The reply expresses brief empathy and asks whether water is "
                "actively coming in right now (or otherwise probes the urgency "
                "of the leak before moving to scheduling)."
            ),
        )
