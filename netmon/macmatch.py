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

_HEX = set("0123456789abcdef")
_SEP = str.maketrans("", "", ":-. ")


def mac_norm(q: str) -> str | None:
    """Bare lowercase hex if ``q`` is a plausible MAC fragment, else None."""
    stripped = (q or "").translate(_SEP).lower()
    if len(stripped) >= 2 and all(c in _HEX for c in stripped):
        return stripped
    return None


def mac_expr(col: str) -> str:
    """SQL for ``col`` with its colons stripped + lowercased — the stored-side
    of the normalised comparison. Portable across MariaDB and SQLite."""
    return f"REPLACE(LOWER({col}), ':', '')"
