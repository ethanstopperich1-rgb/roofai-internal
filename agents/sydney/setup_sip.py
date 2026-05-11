"""Wire the LiveKit Telephony number → Sydney agent.

The LiveKit-purchased number already has an inbound trunk on the LK side. We
just need a Dispatch Rule that drops every inbound call into a fresh room and
explicitly dispatches the `sydney` agent.

Idempotent — safe to re-run.

Run:
  source .venv/bin/activate
  python setup_sip.py
"""

from __future__ import annotations

import asyncio
import os

from dotenv import load_dotenv
from livekit import api
from livekit.protocol.sip import (
    CreateSIPDispatchRuleRequest,
    SIPDispatchRule,
    SIPDispatchRuleIndividual,
)

load_dotenv()

LIVEKIT_URL = os.environ["LIVEKIT_URL"]
LIVEKIT_API_KEY = os.environ["LIVEKIT_API_KEY"]
LIVEKIT_API_SECRET = os.environ["LIVEKIT_API_SECRET"]

AGENT_NAME = "sydney"
RULE_NAME = "nolands-sydney"
ROOM_PREFIX = "nolands-call-"
INBOUND_NUMBER = "+13219851104"


async def main() -> None:
    lkapi = api.LiveKitAPI(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
    try:
        # Reuse existing rule by name if present
        rules = await lkapi.sip.list_sip_dispatch_rule(api.ListSIPDispatchRuleRequest())
        existing = next((r for r in rules.items if r.name == RULE_NAME), None)
        if existing:
            print(f"  ✓ Reusing dispatch rule {existing.sip_dispatch_rule_id}")
            print(f"  Inbound numbers:   {list(existing.inbound_numbers)}")
            print(f"  Agents:            {[a.agent_name for a in existing.room_config.agents]}")
            return

        # Scope the rule by inbound number — DO NOT use empty trunk_ids,
        # that matches every trunk on the project and hijacks other agents.
        res = await lkapi.sip.create_sip_dispatch_rule(
            CreateSIPDispatchRuleRequest(
                name=RULE_NAME,
                inbound_numbers=[INBOUND_NUMBER],
                rule=SIPDispatchRule(
                    dispatch_rule_individual=SIPDispatchRuleIndividual(
                        room_prefix=ROOM_PREFIX,
                    ),
                ),
                room_config=api.RoomConfiguration(
                    agents=[api.RoomAgentDispatch(agent_name=AGENT_NAME)],
                ),
            )
        )
        print(f"  ✓ Created dispatch rule {res.sip_dispatch_rule_id}")
        print(f"  Inbound number:       {INBOUND_NUMBER}")
        print(f"  Rooms will be named:  {ROOM_PREFIX}<random>")
        print(f"  Agent dispatched:     {AGENT_NAME}")
    finally:
        await lkapi.aclose()


if __name__ == "__main__":
    asyncio.run(main())
