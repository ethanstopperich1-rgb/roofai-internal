"""
services/roof-lidar/freshness_check.py

Compare the 3DEP LiDAR capture date against Google Solar's imagery
date. When the satellite imagery is materially newer than the LiDAR
(>365 days), it's likely the structure has changed since the flight —
new roof, addition, or new construction. Flag the warning + demote
confidence so reps know to spot-check.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any


def compare_lidar_vs_imagery(
    *,
    lidar_capture_date: str | None,
    imagery_date: str | None,
) -> dict[str, Any]:
    """Return { flag: bool, message: str, days_delta: int|None }.

    flag=True when imagery is materially newer than LiDAR, otherwise False.
    """
    if not lidar_capture_date or not imagery_date:
        return {"flag": False, "message": "", "days_delta": None}

    try:
        lidar_dt = _parse(lidar_capture_date)
        imagery_dt = _parse(imagery_date)
    except Exception:
        return {"flag": False, "message": "", "days_delta": None}

    delta_days = (imagery_dt - lidar_dt).days
    if delta_days > 365:
        return {
            "flag": True,
            "message": (
                f"Imagery is {delta_days // 365} year(s) newer than LiDAR "
                f"({lidar_dt.date()} vs {imagery_dt.date()}). "
                "Roof may have changed since the LiDAR flight — verify in oblique inspection."
            ),
            "days_delta": delta_days,
        }
    return {"flag": False, "message": "", "days_delta": delta_days}


def _parse(s: str) -> datetime:
    # Accept ISO-8601 with or without time + ms; LAS LastModified is "+00:00"
    # ISO, Solar imageryDate is "YYYY-MM-DD" or "YYYY-MM".
    fmts = (
        "%Y-%m-%dT%H:%M:%S.%f%z",
        "%Y-%m-%dT%H:%M:%S%z",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%d",
        "%Y-%m",
    )
    for fmt in fmts:
        try:
            return datetime.strptime(s, fmt).replace(tzinfo=None)
        except ValueError:
            continue
    # Last resort — `fromisoformat` for Python 3.11+ tolerant parsing.
    return datetime.fromisoformat(s.replace("Z", "+00:00")).replace(tzinfo=None)
