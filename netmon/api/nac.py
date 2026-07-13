"""NAC (PacketFence) linked view — serves the PF collector's cached snapshot.

PF is a linked live view, not merged into the device registry (§9), so this
reads the in-memory snapshot the PfCollector refreshes rather than the DB.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request

from netmon.api.deps import require_role
from netmon.models.schemas import Role

router = APIRouter(tags=["nac"])


@router.get("/api/nac")
def nac(request: Request, _user=Depends(require_role(Role.viewer))) -> dict:
    pf = getattr(request.app.state, "pf", None)
    if pf is None:
        return {"enabled": False}
    snap = pf.snapshot
    # `ok`/`fetched_at` convey staleness to the UI (never stale-as-fresh).
    return {"enabled": True, **snap}
