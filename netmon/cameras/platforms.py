"""Bosch model → CPP platform, from the vendor's own table.

Source: "Which CPP corresponds to certain cameras and encoders?", Keenfinity
(Bosch Security Systems) knowledge base, supplied by the owner 2026-09-08. Only
the models this estate actually runs are transcribed; each carries the CTNs the
article lists, because the *model name Milestone reports* is not the CTN and the
mapping between them is exactly what a reader will want to check.

**Why this file exists rather than trusting the live probe.** NetMon can ask a
camera which generation it is, by trying commands the RCP+ reference marks as
available on one generation only (`netmon.cameras.vendors.bosch`). That probe is
real evidence and it catches the case that matters most — a CPP14 image aimed at
older hardware — but it is **coarse in one direction**: the only legacy marker
available (`CONF_CPU_LOAD_VCA`) is documented for CPP6/CPP7/CPP7.3, and the
article shows this estate also runs **CPP4** cameras, which that row does not
cover at all. A CPP4 camera answering the legacy marker would be recorded as
"CPP6/7/7.3" and could then be offered a CPP7.3 image.

That is not hypothetical here: 247 `FLEXIDOME IP indoor 5000 HD` and 146
`FLEXIDOME IP outdoor 5000 HD` are CPP4 (NIN-50022-*, NDN-50022-*), and the
first probe pass recorded all of them as CPP6/7/7.3. The table is authoritative
for *which* generation; the probe is authoritative for *what the device answers
today*. Where they disagree, the table wins and the disagreement is worth
reading.
"""

from __future__ import annotations

#: Model string as Milestone reports it → CPP generation, per the vendor table.
#: The CTNs are the article's, kept so the mapping can be checked rather than
#: trusted.
PLATFORM_BY_MODEL: dict[str, str] = {
    # ── CPP7.3 ────────────────────────────────────────────────────────────
    # FLEXIDOME IP 4000i — NDI-4502-A, NDI-4502-AL, NDE-4502-A, NDE-4502-AL
    "FLEXIDOME IP 4000i": "CPP7.3",
    # FLEXIDOME IP 5000i — NDI-5503-A, NDI-5503-AL, NDE-5503-A, NDE-5503-AL.
    # The "-AL" variants are the IR ones, which Milestone reports as a separate
    # model name; same silicon, same firmware line.
    "FLEXIDOME IP 5000i": "CPP7.3",
    "FLEXIDOME IP 5000i IR": "CPP7.3",
    # FLEXIDOME IP 3000i IR — NDE-3502-AL
    "FLEXIDOME IP 3000i IR": "CPP7.3",

    # ── CPP7 ──────────────────────────────────────────────────────────────
    # DINION IP starlight 6000 HD — NBN-63013-B, NBN-63023-B. Note: *not* 7.3,
    # despite answering the same legacy probe marker.
    "DINION IP starlight 6000 HD": "CPP7",

    # ── CPP4 ──────────────────────────────────────────────────────────────
    # The ones the probe cannot distinguish from CPP7.3, and the reason this
    # file exists.
    # FLEXIDOME IP indoor 5000 HD — NIN-50022-A3, NIN-50022-V3, NIN-51022-V3
    "FLEXIDOME IP indoor 5000 HD": "CPP4",
    # FLEXIDOME IP outdoor 5000 HD — NDN-50022-A3, NDN-50022-V3
    "FLEXIDOME IP outdoor 5000 HD": "CPP4",
    # FLEXIDOME IP panoramic 5000 MP — NUC-52051-F0, NUC-52051-F0E
    "FLEXIDOME IP panoramic 5000 MP": "CPP4",

    # ── CPP14.1 ───────────────────────────────────────────────────────────
    # FLEXIDOME multi 7000i — NDM-7702-A, NDM-7703-A
    "FLEXIDOME multi 7000i": "CPP14.1",
    # FLEXIDOME multi 7000i IR — NDM-7702-AL, NDM-7703-AL
    "FLEXIDOME multi 7000i IR": "CPP14.1",
    "FLEXIDOME multi 7000i IR - 20MP": "CPP14.1",

    # ── CPP14.2 ───────────────────────────────────────────────────────────
    # FLEXIDOME indoor 5100i IR — NDV-5702-AL (and 5MP NDV-5703-AL)
    "FLEXIDOME indoor 5100i IR": "CPP14.2",
    "FLEXIDOME indoor 5100i IR - 5MP": "CPP14.2",
    # FLEXIDOME outdoor 5100i / IR — NDE-5702-A / NDE-5702-AL
    "FLEXIDOME outdoor 5100i": "CPP14.2",
    "FLEXIDOME outdoor 5100i IR": "CPP14.2",
    "FLEXIDOME outdoor 5100i IR - 5MP": "CPP14.2",
    # FLEXIDOME panoramic 5100i IR — NDS-5703-F360LE, NDS-5704-F360LE
    "FLEXIDOME panoramic 5100i IR": "CPP14.2",
}

#: What a live probe can actually prove. The marker commands identify a *band*,
#: not a point: answering the legacy marker rules out CPP13 and newer, and says
#: nothing about which of CPP4/6/7/7.3 the device is.
PROBE_FAMILIES: dict[str, tuple[str, ...]] = {
    "CPP14/15/16": ("CPP14", "CPP14.1", "CPP14.2", "CPP14.3", "CPP15", "CPP16"),
    "CPP13": ("CPP13",),
    "CPP6/7/7.3": ("CPP4", "CPP5", "CPP6", "CPP7", "CPP7.3"),
}


def platform_for(model: object) -> str | None:
    """The CPP generation for a Milestone model string, or None if unlisted."""
    return PLATFORM_BY_MODEL.get(str(model or "").strip())


def probe_agrees(probe: object, platform: object) -> bool | None:
    """Does a live probe verdict agree with a known platform?

    Returns None when either side is unknown. Used to *contradict*, never to
    confirm: the probe cannot narrow `CPP6/7/7.3` to a point, so a camera whose
    model is unlisted stays unknown however it answers.
    """
    family = PROBE_FAMILIES.get(str(probe or "").strip())
    plat = str(platform or "").strip()
    if not family or not plat:
        return None
    return plat in family


def compatible(image_platform: object, camera_platform: object) -> bool | None:
    """May an image built for one platform go to a camera on another?

    Exact match only, with one deliberate allowance: the vendor numbers CPP14
    sub-variants (14.1/14.2/14.3) that share a firmware line, so an image marked
    plainly `CPP14` is accepted for any of them. Everything else must match
    exactly — CPP7 and CPP7.3 are different generations however similar they
    look, and CPP4 is a different world again.

    None means one side is unknown, which callers treat as "cannot decide"
    rather than as permission.
    """
    want = str(image_platform or "").strip()
    have = str(camera_platform or "").strip()
    if not want or not have:
        return None
    if want == have:
        return True
    if want == "CPP14" and have.startswith("CPP14."):
        return True
    # Legacy images are often labelled with the probe's band rather than a
    # point. Accept that only when the camera's exact platform is inside it.
    family = PROBE_FAMILIES.get(want)
    if family:
        return have in family
    return False
