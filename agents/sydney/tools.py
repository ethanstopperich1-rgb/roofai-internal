"""Sydney's three function tools.

`transfer_to_human` is REAL when the routing env vars are set — it dials the
appropriate on-call human via the LiveKit outbound SIP trunk and bridges them
into the caller's room. If the env vars are missing it falls back to a redacted
log line so the demo still works without escalation numbers configured.

`book_inspection` and `log_lead` are still mocked. Production work is to
replace them with JobNimbus API calls + Sendblue/Twilio SMS confirmation.
Both:
  - Return `status: "mock_*"` (e.g. mock_booked) — never plain `"booked"` —
    so the calling LLM can detect demo mode and tailor its next utterance
    rather than telling a real caller "you're confirmed."
  - Use confirmation/lead identifiers explicitly prefixed `MOCK-` so any
    downstream logs make it obvious these are not real CRM records.

Logging policy (post-review):
  - The previous `_banner` printed full PII (name/phone/email/address/notes)
    to stdout. Cloud logs are NOT a safe PII store. We now log a redacted
    line via the `sydney.tools` logger with:
      - first 12 chars of SHA-256 of any contact identifier (correlation
        without the underlying value)
      - structural metadata (lead_type, service_type, time_window, office)
      - lengths of free-text fields rather than the text itself
  - Full PII still flows to CRM downstreams when those are wired up; that's
    the only place it should land in production.
"""

from __future__ import annotations

import hashlib
import logging
import os
from typing import Annotated, Any

from livekit import agents, api, rtc
from livekit.agents import function_tool

logger = logging.getLogger("sydney.tools")

# Must match WorkerOptions.agent_name in agent.py for /api/agent/events routing.
_AGENT_EVENTS_NAME = os.environ.get("SYDNEY_AGENT_NAME_EVENTS", "sydney")

_TWILIO_PATH_HINT = (
    "PSTN leg is Twilio (Elastic SIP trunk); SIP response codes on failures "
    "usually indicate trunk IP ACL, origination/termination, or caller-ID."
)


async def _emit_tool_fired(tool: str, summary: dict[str, Any]) -> None:
    """Best-effort dashboard row in `events` — never blocks tool return."""
    ctx = agents.get_job_context()
    if ctx is None:
        return
    try:
        import events as _events
        from datetime import datetime

        summary = {**summary, "twilio_path_hint": _TWILIO_PATH_HINT}
        await _events.post(
            {
                "type": "tool_fired",
                "agent_name": _AGENT_EVENTS_NAME,
                "room_name": ctx.room.name,
                "tool": tool,
                "summary": summary,
                "at": datetime.utcnow().isoformat() + "Z",
            }
        )
    except Exception:
        pass


def _hash_fragment(value: str | None) -> str | None:
    """SHA-256 first 12 chars — enough to correlate log lines, opaque
    enough that the underlying value can't be recovered from the log.
    Empty / None passes through as None."""
    if not value:
        return None
    return hashlib.sha256(value.strip().lower().encode("utf-8")).hexdigest()[:12]


def _log_tool_call(title: str, redacted_summary: dict) -> None:
    """Structured single-line log of a tool invocation.

    `redacted_summary` MUST be already redacted by the caller — this
    helper does not strip PII itself. Designed for cloud log retention
    where any PII written is effectively persistent.
    """
    logger.info("tool_fired tool=%s summary=%s", title, redacted_summary)


# Routing — set in LK Cloud Agent secrets.
# Empty / unset means: tool falls back to mock-banner mode (still pitch-safe).
SIP_OUTBOUND_TRUNK_ID = os.environ.get("SIP_OUTBOUND_TRUNK_ID", "")
ESCALATION_NUMBERS = {
    "emergency": os.environ.get("ESCALATION_EMERGENCY_PHONE", ""),
    "warranty": os.environ.get("ESCALATION_WARRANTY_PHONE", ""),
    "sales": os.environ.get("ESCALATION_SALES_PHONE", ""),
    "general": os.environ.get("ESCALATION_GENERAL_PHONE", ""),
}

# Caller-ID we present to the on-call human. The Twilio number Sydney's
# project owns is the safest default — the human sees Noland's calling.
TRANSFER_CALLER_ID = os.environ.get("TRANSFER_CALLER_ID", "+13219851104")

# Allowlists — the LLM is schema-guided to send only these values, but a
# malicious / drifted model could pass anything. We hard-validate before
# any external dial, so a creative `reason` like "+15551234567" can't
# route the call to an attacker-controlled number.
VALID_REASONS = {"emergency", "warranty", "sales", "general"}
VALID_PRIORITIES = {"low", "normal", "urgent"}

# E.164 — leading "+", country code, up to 15 digits. Used to validate
# every routing number we read from env before we hand it to SIP.
import re as _re
_E164_RE = _re.compile(r"^\+[1-9]\d{1,14}$")


def _is_valid_e164(number: str | None) -> bool:
    return bool(number) and bool(_E164_RE.match(number or ""))


@function_tool
async def transfer_to_human(
    reason: Annotated[str, "One of: emergency, warranty, sales, general"],
    priority: Annotated[str, "One of: low, normal, urgent"],
    caller_summary: Annotated[str, "Short description of the caller's situation and what they need"],
) -> dict:
    """Connect the caller to a real human teammate.

    Use this when:
    - The caller has active water intrusion or any roofing emergency (priority="urgent").
    - The caller is an existing customer with a service or warranty issue.
    - The caller explicitly asks to speak to a person.
    - The situation is outside Sydney's scope (insurance pushback, complex pricing).

    Always tell the caller "let me get you to someone who can help, one moment"
    BEFORE invoking this tool.
    """
    # Hard-validate the LLM-supplied `reason` / `priority` against allowlists.
    # The schema annotation is a guideline — a malicious or drifted model
    # could pass arbitrary strings. Rejecting unknown values prevents:
    #   - routing to an attacker-controlled number via a creative `reason`
    #     that happens to match an env var
    #   - escalation-tier confusion ("urgent" vs "URGENT" vs "high")
    if reason not in VALID_REASONS:
        logger.warning("transfer_to_human rejected reason=%r (not in allowlist)", reason)
        reason = "general"
    if priority not in VALID_PRIORITIES:
        logger.warning("transfer_to_human normalized priority=%r → normal", priority)
        priority = "normal"

    target = ESCALATION_NUMBERS.get(reason, "") or ESCALATION_NUMBERS.get("general", "")

    # Validate the target number is E.164 before we hand it to SIP. A bad
    # env value (or operator typo) shouldn't result in a malformed dial.
    if target and not _is_valid_e164(target):
        logger.error(
            "transfer_to_human refusing to dial — ESCALATION_%s_PHONE is not "
            "E.164 (value rejected). Set a number like +15551234567.",
            reason.upper(),
        )
        target = ""

    # Validate caller-ID — must be E.164 AND an owned number. We can't
    # check ownership at runtime, but we CAN enforce the format.
    if not _is_valid_e164(TRANSFER_CALLER_ID):
        logger.error(
            "transfer_to_human refusing to dial — TRANSFER_CALLER_ID is not "
            "E.164 (got %r). Set a project-owned number like +13219851104.",
            TRANSFER_CALLER_ID,
        )
        target = ""

    # Redacted log — caller_summary may contain incidental PII (the caller
    # describing their situation). We log a length + hash for correlation,
    # not the contents. `target` is hashed too because cloud logs aren't a
    # safe place to keep on-call humans' personal numbers either.
    _log_tool_call("transfer_to_human", {
        "reason": reason,
        "priority": priority,
        "caller_summary_len": len(caller_summary or ""),
        "target_hash": _hash_fragment(target),
        "trunk_configured": bool(SIP_OUTBOUND_TRUNK_ID),
    })

    # Mock fallback — keeps the demo working without real numbers.
    if not target or not SIP_OUTBOUND_TRUNK_ID:
        logger.warning(
            "transfer_to_human in MOCK mode (target=%r trunk=%r) — set "
            "ESCALATION_%s_PHONE and SIP_OUTBOUND_TRUNK_ID for real bridging",
            target, SIP_OUTBOUND_TRUNK_ID, reason.upper(),
        )
        await _emit_tool_fired(
            "transfer_to_human",
            {
                "status": "transferred_mock",
                "queue": reason,
                "priority": priority,
                "trunk_configured": bool(SIP_OUTBOUND_TRUNK_ID),
                "target_configured": bool(target),
            },
        )
        return {"status": "transferred_mock", "queue": reason, "priority": priority}

    # Real bridge: dial the on-call human into the same room as the caller.
    # Both stay in the room; Sydney's session can then exit so the humans talk
    # freely. Pattern follows livekit-examples/warm_handoff.
    try:
        ctx = agents.get_job_context()
        if ctx is None:
            logger.warning("transfer_to_human: no job context, falling back to mock")
            await _emit_tool_fired(
                "transfer_to_human",
                {
                    "status": "transferred_mock",
                    "queue": reason,
                    "priority": priority,
                    "note": "no_job_context",
                },
            )
            return {"status": "transferred_mock", "queue": reason, "priority": priority}

        await ctx.api.sip.create_sip_participant(
            api.CreateSIPParticipantRequest(
                room_name=ctx.room.name,
                sip_trunk_id=SIP_OUTBOUND_TRUNK_ID,
                sip_call_to=target,
                sip_number=TRANSFER_CALLER_ID,
                participant_identity=f"specialist-{reason}",
                participant_name=f"Noland's {reason.title()} Specialist",
                krisp_enabled=True,
                # Block until the specialist actually picks up. If they don't,
                # we get a TwirpError below and the model can fall back to
                # offering the caller a callback or scheduler.
                wait_until_answered=True,
            )
        )
        logger.info(
            "transfer_to_human BRIDGED reason=%s target=%s room=%s",
            reason, target, ctx.room.name,
        )
        await _emit_tool_fired(
            "transfer_to_human",
            {
                "status": "transferred",
                "queue": reason,
                "priority": priority,
                "method": "dial_and_bridge",
                "target_hash": _hash_fragment(target),
            },
        )
        return {
            "status": "transferred",
            "queue": reason,
            "priority": priority,
            "method": "dial_and_bridge",
        }
    except api.TwirpError as e:
        sip_code = e.metadata.get("sip_status_code") if e.metadata else None
        logger.warning(
            "transfer_to_human dial FAILED reason=%s sip=%s msg=%s",
            reason, sip_code, e.message,
        )
        await _emit_tool_fired(
            "transfer_to_human",
            {
                "status": "transfer_failed",
                "queue": reason,
                "error": "specialist_unavailable",
                "sip_status_code": sip_code,
                "twirp_message": (e.message or "")[:240],
            },
        )
        return {
            "status": "transfer_failed",
            "queue": reason,
            "error": "specialist_unavailable",
            "sip_status_code": sip_code,
        }
    except Exception as e:
        logger.warning("transfer_to_human unexpected: %s", e)
        await _emit_tool_fired(
            "transfer_to_human",
            {
                "status": "transfer_failed",
                "queue": reason,
                "error": "unexpected",
                "detail": str(e)[:240],
            },
        )
        return {"status": "transfer_failed", "queue": reason, "error": str(e)}


# TODO PRODUCTION: Replace with JobNimbus appointment + contact create.
# JobNimbus API: https://documentation.jobnimbus.com/
# Also fire SMS confirmation via Sendblue or Twilio after success.
@function_tool
async def book_inspection(
    name: Annotated[str, "Caller's full name"],
    phone: Annotated[str, "Phone number, digits only"],
    email: Annotated[str, "Email address"],
    address: Annotated[str, "Property address including city, state, zip"],
    date: Annotated[str, "Appointment date in YYYY-MM-DD format"],
    time_window: Annotated[str, "Either 'morning' (9am-12pm) or 'afternoon' (1pm-5pm)"],
    office: Annotated[str, "One of: clermont, orange_city, bradenton, fort_myers"],
    service_type: Annotated[str, "One of: roof_repair, roof_replacement, renovation, storm_damage, other"],
    notes: Annotated[str, "Anything else relevant the specialist should know"],
) -> dict:
    """Schedule a free inspection on the calendar.

    Only call this AFTER you have read the appointment back to the caller and
    they confirmed it is correct. Do not call speculatively.
    """
    # Redacted log — full PII (name/phone/email/address/notes) is sent
    # straight to CRM when wired; cloud logs only get structural metadata
    # plus hashes for correlation.
    _log_tool_call("book_inspection", {
        "mode": "mock",
        "name_hash": _hash_fragment(name),
        "phone_hash": _hash_fragment(phone),
        "email_hash": _hash_fragment(email),
        "address_hash": _hash_fragment(address),
        "date": date,
        "time_window": time_window,
        "office": office,
        "service_type": service_type,
        "notes_len": len(notes or ""),
    })
    # status: "mock_booked" — NOT "booked" — so the LLM can detect demo
    # mode and avoid telling a real caller they're confirmed when no
    # JobNimbus record exists. Confirmation prefixed MOCK- for the same
    # reason on any downstream logging.
    return {
        "status": "mock_booked",
        "confirmation_number": "MOCK-NL-DEMO-12345",
        "office": office,
        "demo_mode": True,
    }


# TODO PRODUCTION: Replace with JobNimbus contact create + lead source tagging.
@function_tool
async def log_lead(
    name: Annotated[str, "Caller's name (use 'unknown' if not collected)"],
    phone: Annotated[str, "Phone number"],
    email: Annotated[str, "Email if collected, empty string otherwise"],
    address: Annotated[str, "Address if collected, empty string otherwise"],
    notes: Annotated[str, "Why we're logging this lead and any context"],
    lead_type: Annotated[str, "One of: new_inspection, warranty_callback, outside_area, vendor, dnc, other"],
) -> dict:
    """Save the caller's info to the CRM as a lead.

    Call this after book_inspection succeeds, OR at the end of any call where
    you collected contact info but did not book an appointment (outside service
    area, warranty handoff, vendor / wrong number, DNC request, etc.).
    """
    _log_tool_call("log_lead", {
        "mode": "mock",
        "name_hash": _hash_fragment(name),
        "phone_hash": _hash_fragment(phone),
        "email_hash": _hash_fragment(email),
        "address_hash": _hash_fragment(address),
        "notes_len": len(notes or ""),
        "lead_type": lead_type,
    })
    # status: "mock_logged" — NOT "logged" — see book_inspection comment.
    return {
        "status": "mock_logged",
        "lead_id": "MOCK-LEAD-DEMO-98765",
        "demo_mode": True,
    }


# ─── check_availability — Stage 5 of the outbound script ─────────────────
# Sydney's flow ends with: "Have her use a tool to check availability rather
# than guessing." This tool returns the next 5 business days of slot windows
# so Sydney can OFFER specific times ("I have Wednesday afternoon between
# 1-4, or Friday morning") instead of asking the caller what works for them.
#
# Demo behavior: hard-coded calendar — most slots open, a few "taken" so the
# response feels like a real calendar, not a script. Production will swap
# this for a JobNimbus / Google Calendar query that hits the actual office
# schedule. The mocked status flags ("mock_availability") let the LLM know
# it's still synthetic.
@function_tool
async def check_availability(
    office: Annotated[str, "One of: clermont, orange_city, bradenton, fort_myers"],
    earliest_date: Annotated[
        str,
        "Earliest date the caller can do, in YYYY-MM-DD. Use today's date if they said 'as soon as possible' or didn't specify.",
    ],
) -> dict:
    """Look up the next 5 business days of inspection slots for the office.

    Call this AFTER you've qualified the caller (Stage 3) and given them
    the value bridge (Stage 4). Use the returned `slots` array to OFFER
    two or three specific times — don't ask 'what works for you?'.
    """
    import datetime as _dt

    try:
        start = _dt.date.fromisoformat(earliest_date)
    except (ValueError, TypeError):
        start = _dt.date.today()

    # Build the next 5 business-day windows from `start`. Skip weekends.
    slots: list[dict] = []
    d = start
    while len(slots) < 5:
        if d.weekday() < 5:  # Mon=0..Fri=4
            slots.append({
                "date": d.isoformat(),
                "day_name": d.strftime("%A"),
                "windows": [
                    {"window": "morning", "label": "9 AM – 12 PM", "status": "open"},
                    {"window": "afternoon", "label": "1 PM – 4 PM", "status": "open"},
                ],
            })
        d += _dt.timedelta(days=1)

    # Add a touch of realistic friction so the calendar doesn't feel fake:
    # the first slot's morning is "taken" (someone always books first thing).
    if slots:
        slots[0]["windows"][0]["status"] = "taken"
    if len(slots) >= 3:
        slots[2]["windows"][1]["status"] = "taken"  # third day afternoon

    _log_tool_call("check_availability", {
        "office": office,
        "earliest_date": earliest_date,
        "slots_returned": len(slots),
        "mode": "mock",
    })

    return {
        "status": "mock_availability",
        "office": office,
        "slots": slots,
        "demo_mode": True,
    }


ALL_TOOLS = [transfer_to_human, check_availability, book_inspection, log_lead]
