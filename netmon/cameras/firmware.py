"""Camera firmware versions: parsing and comparison (spec 20 S8 / D11).

Pure functions. They exist because this estate does not report firmware in one
format, and S8's two safety conditions are both *string comparisons* against
what a camera reports:

* condition 3 — a push refuses a camera "whose current `firmware` already equals
  the target";
* condition 7 — an item is `verified` "only when the read path shows the new
  version".

Measured across all 2,651 cameras on 2026-09-08:

    dotted   1,732   7.83.0027 · 6.60.0065 · 6.50.1        Bosch and Axis
    compact    888   783 · 660 · 900 · 761                 Bosch only
    other       31   5.75.1.4 · 03500623 · 64500580        Axis / ONVIF

`783` and `7.83.0027` are the same firmware written two ways, and **11 of 38
models carry both formats**, so it is not a per-model rule that could be hardcoded
— it has to be handled per camera. Naive equality would therefore have skipped
nothing for the 888 compact cameras (re-pushing firmware they already run) and,
worse, marked a *successful* upgrade `failed` when the camera reported `790` and
the image said `7.90.0123`. Under condition 6 those failures count toward
`abort_pct`, so a healthy roll would have aborted itself.

The asymmetry below is the point:

* **Skipping** compares at the coarsest precision both strings carry. Erring
  toward "already at target" costs a push that was not needed; it cannot brick
  anything.
* **Verifying** demands the target's full precision. A camera that can only
  report `790` cannot prove it is at `7.90.0123`, so the answer is
  ``INDETERMINATE`` — never ``VERIFIED``. An unprovable upgrade is not a
  successful one (CLAUDE.md §4.5), and the batch item says which it was.

Anything unparseable — the eight-digit Axis/ONVIF strings, an empty column —
returns None and every caller must refuse rather than guess.
"""

from __future__ import annotations

import re

#: 7.83.0027 · 6.50.1 · 5.75.1.4 — two to four dotted numeric parts.
_DOTTED = re.compile(r"^(\d+)\.(\d+)(?:\.(\d+))?(?:\.(\d+))?$")

#: 783 · 660 · 900 — Bosch's compressed form: one digit of major, two of minor.
#: Exactly three digits, because that is the only compact form this estate
#: reports: all 16 distinct all-digit values are 3-digit (620…900), and the only
#: other all-digit strings are two 8-digit oddities (03500623, 64500580) with no
#: documented reading. A 4-digit value would be ambiguous — 6.100 or 61.00? — so
#: it deliberately falls through to None and the camera gets refused rather than
#: pushed on a guess.
_COMPACT = re.compile(r"^(\d)(\d{2})$")

VERIFIED = "verified"
INDETERMINATE = "indeterminate"
MISMATCH = "mismatch"


def parse(raw: object) -> tuple[int, ...] | None:
    """Firmware string → comparable tuple, or None when it cannot be read.

    None is a refusal, not a zero: the eight-digit strings 31 cameras report
    (``03500623``) have no documented reading, and inventing one would put a
    firmware push on a guess.
    """
    s = str(raw or "").strip()
    if not s:
        return None
    m = _DOTTED.match(s)
    if m:
        return tuple(int(g) for g in m.groups() if g is not None)
    m = _COMPACT.match(s)
    if m:
        return (int(m.group(1)), int(m.group(2)))
    return None


def canonical(raw: object) -> str | None:
    """A readable form for the UI: ``783`` and ``7.83.0027`` → ``7.83`` / ``7.83.27``."""
    parts = parse(raw)
    if parts is None:
        return None
    return ".".join(str(p) for p in parts)


def same_release(current: object, target: object) -> bool | None:
    """Is the camera already on the target release, at shared precision?

    Used for **skipping**, where a false "yes" costs an avoided push and a false
    "no" costs a needless one. None means one side is unreadable — the caller
    must refuse the camera rather than assume either way.
    """
    a, b = parse(current), parse(target)
    if a is None or b is None:
        return None
    n = min(len(a), len(b))
    return a[:n] == b[:n]


def verify(reported: object, target: object) -> str:
    """Did the camera actually land on the target? For **verification only**.

    Unlike :func:`same_release` this demands the target's full precision, and
    says ``INDETERMINATE`` rather than ``VERIFIED`` when the camera's own format
    cannot express it. A batch item must treat that as "not proven": it is the
    difference between a firmware roll that verified and one that merely did not
    obviously fail.
    """
    a, b = parse(reported), parse(target)
    if a is None or b is None:
        return INDETERMINATE
    n = min(len(a), len(b))
    if a[:n] != b[:n]:
        return MISMATCH
    if len(a) < len(b):
        # Agrees as far as it goes, but cannot show the build number the image
        # claims — e.g. camera says 790, image says 7.90.0123.
        return INDETERMINATE
    return VERIFIED
