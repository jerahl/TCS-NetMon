from netmon.poller.probes import parse_fping_output


def test_parse_fping_alive_and_unreachable():
    out = (
        "192.0.2.11 is alive\n"
        "192.0.2.2 is alive\n"
        "192.0.2.30 is unreachable\n"
    )
    parsed = parse_fping_output(out)
    assert parsed == {"192.0.2.11": True, "192.0.2.2": True, "192.0.2.30": False}


def test_parse_fping_ignores_noise_and_dedups():
    out = (
        "ICMP Host Unreachable from 10.0.0.1 for ICMP Echo\n"  # noise line
        "192.0.2.30 is unreachable\n"
        "192.0.2.30 is alive\n"  # later line wins
    )
    parsed = parse_fping_output(out)
    assert parsed == {"192.0.2.30": True}


def test_parse_fping_empty():
    assert parse_fping_output("") == {}
