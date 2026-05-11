"""Sydney's three function tools.

`transfer_to_human` is REAL when the routing env vars are set — it dials the
appropriate on-call human via the LiveKit outbound SIP trunk and bridges them
into the caller's room. If the env vars are missing it falls back to a stdout
banner so the demo still works without escalation numbers configured.

`book_inspection` and `log_lead` are still mocked stdout banners. Production
work is to replace them with JobNimbus API calls + Sendblue/Twilio SMS
confirmation. Both leave clearly marked TODO PRODUCTION blocks below.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Annotated

from livekit import agents, api, rtc
from livekit.agents import function_tool

logger = logging.getLogger("sydney.tools")


def _banner(title: str, payload: dict) -> None:
    print("\n" + "=" * 60)
    print(f"  TOOL FIRED: {title}")
    print("=" * 60)
    print(json.dumps(payload, indent=2))
    print("=" * 60 + "\n", flush=True)


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
    target = ESCALATION_NUMBERS.get(reason, "") or ESCALATION_NUMBERS.get("general", "")

    payload = {
        "reason": reason,
        "priority": priority,
        "caller_summary": caller_summary,
        "target": target or "<unset>",
        "trunk": SIP_OUTBOUND_TRUNK_ID or "<unset>",
    }
    _banner("transfer_to_human", payload)

    # Mock fallback — keeps the demo working without real numbers.
    if not target or not SIP_OUTBOUND_TRUNK_ID:
        logger.warning(
            "transfer_to_human in MOCK mode (target=%r trunk=%r) — set "
            "ESCALATION_%s_PHONE and SIP_OUTBOUND_TRUNK_ID for real bridging",
            target, SIP_OUTBOUND_TRUNK_ID, reason.upper(),
        )
        return {"status": "transferred_mock", "queue": reason, "priority": priority}

    # Real bridge: dial the on-call human into the same room as the caller.
    # Both stay in the room; Sydney's session can then exit so the humans talk
    # freely. Pattern follows livekit-examples/warm_handoff.
    try:
        ctx = agents.get_job_context()
        if ctx is None:
            logger.warning("transfer_to_human: no job context, falling back to mock")
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
        return {
            "status": "transfer_failed",
            "queue": reason,
            "error": "specialist_unavailable",
            "sip_status_code": sip_code,
        }
    except Exception as e:
        logger.warning("transfer_to_human unexpected: %s", e)
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
    payload = {
        "name": name, "phone": phone, "email": email, "address": address,
        "date": date, "time_window": time_window, "office": office,
        "service_type": service_type, "notes": notes,
    }
    _banner("book_inspection", payload)
    return {
        "status": "booked",
        "confirmation_number": "NL-DEMO-12345",
        "office": office,
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
    payload = {
        "name": name, "phone": phone, "email": email, "address": address,
        "notes": notes, "lead_type": lead_type,
    }
    _banner("log_lead", payload)
    return {"status": "logged", "lead_id": "LEAD-DEMO-98765"}


ALL_TOOLS = [transfer_to_human, book_inspection, log_lead]
