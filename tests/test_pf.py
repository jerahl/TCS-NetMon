import asyncio

from netmon import db
from netmon.collectors.packetfence import PfCollector
from netmon.collectors.pf_client import PfError
from tests.conftest import create_core_tables


class FakePf:
    def __init__(self):
        self.nodes_data = []
        self.failures_data = []
        self.fail = None

    async def nodes(self, limit=1000):
        if self.fail:
            raise self.fail
        return self.nodes_data

    async def recent_auth_failures(self, limit=25):
        return self.failures_data


def _engine(tmp_path):
    e = db.make_engine(f"sqlite:///{tmp_path / 'pf.db'}")
    create_core_tables(e)
    return e


def test_pf_summary_counts(tmp_path):
    engine = _engine(tmp_path)
    fake = FakePf()
    fake.nodes_data = [{"status": "reg"}, {"status": "unreg"}, {"status": "reg"}]
    fake.failures_data = [{"mac": "aa:bb:cc:00:00:11", "reason": "eap"}]
    pf = PfCollector(engine, fake)
    n = asyncio.run(pf.run_once())
    assert n == 3
    assert pf.snapshot["ok"] is True
    assert pf.snapshot["registered"] == 2
    assert pf.snapshot["unregistered"] == 1
    assert len(pf.snapshot["auth_failures"]) == 1


def test_pf_unreachable_keeps_last_good_and_records_error(tmp_path):
    engine = _engine(tmp_path)
    fake = FakePf()
    fake.nodes_data = [{"status": "reg"}, {"status": "reg"}]
    pf = PfCollector(engine, fake)
    asyncio.run(pf.run_once())  # ok, registered=2

    fake.fail = PfError("PF unreachable")
    asyncio.run(pf.run_guarded())  # guarded: records health, no raise

    # Last-good snapshot retained, but flagged not-ok (visibly stale).
    assert pf.snapshot["ok"] is False
    assert pf.snapshot["registered"] == 2
    h = db.fetch_one(engine, "SELECT * FROM collector_health WHERE name='packetfence'")
    assert h["consecutive_failures"] == 1
    assert "unreachable" in (h["last_error"] or "")
