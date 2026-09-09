"""Firmware version parsing and comparison (spec 20 S8 / D11).

Every string here is one this estate actually reports, taken from all 2,651
cameras on 2026-09-08. The cases that matter are the ones where a naive string
comparison would have made a firmware roll unsafe.
"""

import pytest

from netmon.cameras.firmware import (
    INDETERMINATE,
    MISMATCH,
    VERIFIED,
    canonical,
    parse,
    same_release,
    verify,
)


@pytest.mark.parametrize("raw,expected", [
    ("7.83.0027", (7, 83, 27)),      # 1,732 cameras report a dotted version
    ("6.60.0065", (6, 60, 65)),
    ("6.50.1", (6, 50, 1)),
    ("5.75.1.4", (5, 75, 1, 4)),     # Axis carries a fourth part
    ("783", (7, 83)),                # 888 cameras report Bosch's compact form
    ("900", (9, 0)),
    ("  660  ", (6, 60)),
])
def test_the_formats_this_estate_reports(raw, expected):
    assert parse(raw) == expected


@pytest.mark.parametrize("raw", ["03500623", "64500580", "", None, "6100", "v7.83", "latest"])
def test_an_unreadable_version_is_refused_not_guessed(raw):
    """None is a refusal, not a zero.

    Two cameras report eight-digit strings with no documented reading, and a
    four-digit compact value is ambiguous — 6.100 or 61.00? Inventing either
    would put a firmware push on a guess, so the caller must refuse the camera.
    """
    assert parse(raw) is None
    assert canonical(raw) is None


def test_compact_and_dotted_are_recognised_as_the_same_release():
    """`783` and `7.83.0027` are one firmware written two ways.

    11 of 38 models on this estate carry both formats, so this cannot be
    hardcoded per model. Without it, 888 cameras would be pushed firmware they
    already run.
    """
    assert same_release("783", "7.83.0027") is True
    assert same_release("7.83.0027", "783") is True
    assert same_release("660", "6.60.0065") is True
    assert same_release("783", "7.90.0123") is False


def test_an_unreadable_side_makes_the_skip_check_undecidable():
    assert same_release("03500623", "7.90.0123") is None
    assert same_release("7.90.0123", "") is None


def test_verification_demands_the_targets_full_precision():
    """The asymmetry that keeps a roll honest.

    Skipping may compare loosely — a false "already there" costs one avoided
    push. Verification may not: a camera reporting `790` cannot prove it is on
    `7.90.0123`, and calling that verified would report success for an upgrade
    nobody confirmed.
    """
    assert verify("7.90.0123", "7.90.0123") == VERIFIED
    assert verify("790", "7.90.0123") == INDETERMINATE
    assert verify("783", "7.90.0123") == MISMATCH
    assert verify("7.83.0027", "7.90.0123") == MISMATCH


def test_a_camera_that_did_not_move_is_a_mismatch_not_an_unknown():
    """The failure S8 condition 7 is built around: the device comes back on the
    old version. That must be distinguishable from "could not tell"."""
    assert verify("7.83.0027", "7.90.0123") == MISMATCH
    assert verify("03500623", "7.90.0123") == INDETERMINATE


def test_a_more_precise_report_than_the_target_still_verifies():
    """An image named `7.90` and a camera reporting `7.90.0123` agree as far as
    the target claims, which is all the target can ask for."""
    assert verify("7.90.0123", "7.90") == VERIFIED


def test_canonical_is_for_reading_not_comparing():
    assert canonical("783") == "7.83"
    assert canonical("7.83.0027") == "7.83.27"
