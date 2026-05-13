"""Post Sydney call events to the Voxaris Pitch dashboard.

Sydney is a Python LiveKit worker; the dashboard lives in the Next.js
app at /api/agent/events. We POST structured JSON over HTTPS with an
HMAC-SHA256 signature so the endpoint can authenticate the caller
without sharing JWTs across runtimes.

Failure mode: every post is best-effort. A failed POST logs a warning
and returns — we never block call flow on telemetry. The /api/agent/
events endpoint itself is also idempotent (call_started upserts by
room_name) so retries on transient failures are safe but not required.

Env vars:
  AGENT_EVENTS_URL     full URL to /api/agent/events
                       (e.g. https://pitch.voxaris.io/api/agent/events)
  AGENT_EVENTS_SECRET  shared secret used to sign every POST. MUST
                       match the value set in Vercel for the receiver.
                       Disabled when unset — Sydney still runs, just
                       doesn't write to the dashboard.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import os
import urllib.request
from typing import Any

logger = logging.getLogger("sydney.events")

_URL = os.environ.get("AGENT_EVENTS_URL", "")
_SECRET = os.environ.get("AGENT_EVENTS_SECRET", "")


def _enabled() -> bool:
    return bool(_URL and _SECRET)


def _post_sync(payload: dict[str, Any]) -> None:
    """Synchronous POST. Called from asyncio.to_thread to keep the agent
    loop responsive — telemetry MUST NOT block voice latency."""
    if not _enabled():
        return
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    sig = "sha256=" + hmac.new(_SECRET.encode("utf-8"), body, hashlib.sha256).hexdigest()
    req = urllib.request.Request(
        _URL,
        data=body,
        headers={
            "Content-Type": "application/json",
            "X-Agent-Signature": sig,
        },
        method="POST",
    )
    try:
        # 5s ceiling — we're firing during call flow.
        with urllib.request.urlopen(req, timeout=5) as resp:
            if resp.status >= 400:
                logger.warning(
                    "agent-events POST returned %d for %s",
                    resp.status, payload.get("type"),
                )
    except Exception as e:
        logger.warning("agent-events POST failed for %s: %s", payload.get("type"), e)


async def post(payload: dict[str, Any]) -> None:
    """Fire-and-forget post. Never raises."""
    if not _enabled():
        return
    try:
        await asyncio.to_thread(_post_sync, payload)
    except Exception as e:
        logger.warning("agent-events post wrapper failed: %s", e)


# ─── In-memory outcome tracking ───────────────────────────────────────
#
# Tools fire from a different code path than agent.py's shutdown
# callback, so the agent can't directly observe which tool ran. The
# shared store below lets tools record their semantic outcome under
# the room name; agent.py's _on_shutdown reads it to set
# call_ended.outcome. Without this every call ended as "unknown" in
# the dashboard — even calls where Sydney clearly booked an inspection.

# Priority order (higher = stronger signal). When multiple tools fire
# in the same call (e.g. log_lead AFTER book_inspection), the highest
# priority wins.
_OUTCOME_PRIORITY = {
    "booked": 40,
    "transferred": 30,
    "logged_lead": 20,
    "wrong_number": 10,
    "no_show": 10,
}

# room_name → outcome string. Cleared by agent.py on call_ended so
# memory doesn't grow unbounded across the worker's lifetime.
_outcomes: dict[str, str] = {}


def record_outcome(room_name: str, outcome: str) -> None:
    """Record the strongest outcome observed for this room. Only stores
    the highest-priority value across repeat calls."""
    if not room_name or not outcome:
        return
    existing = _outcomes.get(room_name)
    if existing and _OUTCOME_PRIORITY.get(existing, 0) >= _OUTCOME_PRIORITY.get(outcome, 0):
        return
    _outcomes[room_name] = outcome


def pop_outcome(room_name: str) -> str | None:
    """Read + clear the outcome for this room. Called once per call by
    the agent shutdown handler."""
    return _outcomes.pop(room_name, None)
