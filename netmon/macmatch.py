"""Separator-agnostic MAC matching, shared by the search palette and the NAC
nodes filter.

Operators type MACs in whatever style is on the label — ``bcf310be9980``,
``bc:f3:10:be:99:80``, ``BC-F3-10-BE-99-80``. Stored MACs are colon-lowercase
(``aa:bb:cc:dd:ee:ff``), so a query is matched by normalising both sides to
bare lowercase hex. A query that isn't hex-once-separators-are-stripped (a
hostname, an IP with dots) is *not* treated as a MAC, so text search is never
misread.
"""

from __future__ import annotations

import re

_HEX = set("0123456789abcdef")
_SEP = str.maketrans("", "", ":-. ")

#: Dotted decimal, possibly partial and possibly mid-typing ("10.92.18.").
#: Every group is 1-3 *decimal* digits, which is what separates it from the
#: Cisco MAC form `0200.5e10.0003` — groups of four, usually with hex letters.
_IPV4_FRAGMENT = re.compile(r"^\d{1,3}(?:\.\d{1,3})+\.?$")


def mac_norm(q: str) -> str | None:
    """Bare lowercase hex if ``q`` is a plausible MAC fragment, else None.

    An IPv4 fragment is rejected even though it survives the hex test. Stripping
    separators turns ``10.92.18`` into ``109218``, which is hex-shaped and was
    therefore treated as a MAC — so searching for a subnet ran a
    computed-expression scan over every MAC in `fdb_entries` and `pf_nodes` to
    return nothing. Dotted decimal is an address, not a device identifier, and
    saying so here fixes it for the palette, the NAC filter and the DDI lookup
    at once.
    """
    raw = (q or "").strip()
    if _IPV4_FRAGMENT.match(raw):
        return None
    stripped = raw.translate(_SEP).lower()
    if len(stripped) >= 2 and all(c in _HEX for c in stripped):
        return stripped
    return None


def mac_expr(col: str) -> str:
    """SQL for ``col`` with its colons stripped + lowercased — the stored-side
    of the normalised comparison. Portable across MariaDB and SQLite."""
    return f"REPLACE(LOWER({col}), ':', '')"
