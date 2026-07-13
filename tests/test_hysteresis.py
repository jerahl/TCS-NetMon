from netmon.poller.hysteresis import DOWN, UP, HysteresisTracker


def test_first_observation_settles_immediately():
    t = HysteresisTracker(fail_threshold=3, ok_threshold=2)
    tr = t.observe(1, "ping", True)
    assert tr is not None and tr.old == "unknown" and tr.new == UP
    assert t.settled(1, "ping") == UP


def test_down_requires_fail_threshold():
    t = HysteresisTracker(fail_threshold=3, ok_threshold=2)
    t.observe(1, "ping", True)  # -> up
    assert t.observe(1, "ping", False) is None  # fail 1
    assert t.observe(1, "ping", False) is None  # fail 2
    tr = t.observe(1, "ping", False)            # fail 3 -> down
    assert tr is not None and tr.old == UP and tr.new == DOWN
    assert t.settled(1, "ping") == DOWN


def test_up_requires_ok_threshold_and_streak_resets():
    t = HysteresisTracker(fail_threshold=3, ok_threshold=2)
    t.observe(1, "ping", True)
    t.observe(1, "ping", False)
    t.observe(1, "ping", False)
    t.observe(1, "ping", False)  # down
    assert t.observe(1, "ping", True) is None   # ok 1
    tr = t.observe(1, "ping", True)             # ok 2 -> up
    assert tr is not None and tr.new == UP


def test_intermittent_failures_do_not_flip():
    t = HysteresisTracker(fail_threshold=3, ok_threshold=2)
    t.observe(1, "ping", True)  # up
    t.observe(1, "ping", False)  # fail 1
    t.observe(1, "ping", True)   # resets fail streak; already up -> None
    assert t.observe(1, "ping", False) is None  # fail 1 again
    assert t.observe(1, "ping", False) is None  # fail 2
    assert t.settled(1, "ping") == UP           # never reached 3 consecutive


def test_seed_sets_settled_without_event():
    t = HysteresisTracker()
    t.seed(5, "ping", "down")
    assert t.settled(5, "ping") == DOWN
    # A single success shouldn't immediately flip a seeded (known) state.
    assert t.observe(5, "ping", True) is None


def test_dimensions_are_independent():
    t = HysteresisTracker(fail_threshold=1, ok_threshold=1)
    t.observe(1, "ping", True)
    t.observe(1, "snmp", False)
    assert t.settled(1, "ping") == UP
    assert t.settled(1, "snmp") == DOWN
