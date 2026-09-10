"""Separator-agnostic MAC matching — the helper the palette, the NAC filter and
the DDI lookup all key on.

It had no tests of its own, which is how "an IPv4 fragment is hex-shaped" went
unnoticed: `10.92.18` strips to `109218`, passed the hex test, and made every
subnet search scan every MAC in the estate to return nothing.
"""

import pytest

from netmon.macmatch import mac_expr, mac_norm


@pytest.mark.parametrize("q, expected", [
    # Whatever style is on the label.
    ("bcf310be9980", "bcf310be9980"),
    ("bc:f3:10:be:99:80", "bcf310be9980"),
    ("BC-F3-10-BE-99-80", "bcf310be9980"),
    ("bc f3 10 be 99 80", "bcf310be9980"),
    # Cisco's three groups of four. Dotted, but not dotted *decimal*.
    ("0200.5e10.0003", "02005e100003"),
    # A prefix is a legitimate query — an OUI, or the start of a label.
    ("bcf3", "bcf3"),
])
def test_a_mac_in_any_style_normalises(q, expected):
    assert mac_norm(q) == expected


@pytest.mark.parametrize("q", [
    "10.92.18",       # a subnet an operator is looking through
    "10.92.18.",      # mid-typing
    "192.168.1.1",    # a whole address
    "10.92",
    "1.2.3.4",
])
def test_an_ipv4_fragment_is_not_a_mac(q):
    """Dotted decimal is an address, not a device identifier.

    Every group is 1-3 decimal digits, which is what tells it apart from the
    Cisco MAC form. Treating it as a MAC cost a full computed-expression scan
    of `fdb_entries` and `pf_nodes` on every subnet search.
    """
    assert mac_norm(q) is None


@pytest.mark.parametrize("q", [
    "printer",        # a hostname
    "tms-cam",        # 'm' and 's' are not hex
    "bhs",
    "",
    None,
    "a",              # one character matches almost everything
])
def test_text_is_not_read_as_a_mac(q):
    assert mac_norm(q) is None


def test_four_digit_groups_stay_a_mac_candidate():
    """`1092.1800` is ambiguous; groups of four are the MAC shape, so it wins.

    Deliberate: nothing writes an IPv4 octet as four digits, and the Cisco form
    is real. Recorded because it is the one input where the rule has to choose.
    """
    assert mac_norm("1092.1800") == "10921800"


def test_bare_digits_without_dots_remain_a_candidate():
    """`10` is hex and could be the start of a MAC; only *dotted* decimal is
    ruled out."""
    assert mac_norm("10") == "10"


def test_mac_expr_normalises_the_stored_side():
    assert mac_expr("f.mac") == "REPLACE(LOWER(f.mac), ':', '')"
