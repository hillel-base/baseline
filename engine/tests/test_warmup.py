"""A practice server's first scan open: its files are read in parallel, and a warm-up at start reads every practice scan's files
once (the tutorial case first) so a visitor's first open comes from the cache. Measured on server 1 (2026-10-28): a cold open took
30-35 s, of which a local decode of the same 281 files is 1.3 s; the rest is the mounted bucket answering one file at a time."""
from lung_engine.scans import prefetch, warm_order


def test_prefetch_reads_every_file_once_and_waits_while_paused(tmp_path):
    for i in range(5):
        (tmp_path / f"{i}.dcm").write_bytes(bytes([i]) * 3000)
    (tmp_path / "notes.txt").write_text("x")  # not a DICOM file: left alone
    calls = []
    assert prefetch(tmp_path, workers=3, pause=lambda: calls.append(1)) == 5
    assert len(calls) == 5  # the pause hook is asked before each file


def test_prefetch_skips_a_file_it_cannot_read_and_reads_the_rest(tmp_path):
    for i in range(4):
        (tmp_path / f"{i}.dcm").write_bytes(b"x" * 100)
    (tmp_path / "2.dcm").chmod(0)  # a bucket read error (PermissionError, EIO): left to the normal read, which reports it
    try:
        assert prefetch(tmp_path, workers=2) == 3
    finally:
        (tmp_path / "2.dcm").chmod(0o644)


def test_prefetch_of_a_missing_folder_reads_nothing(tmp_path):
    assert prefetch(tmp_path / "gone") == 0


def test_warm_order_puts_the_tutorial_case_first_then_the_rest_sorted():
    practice = {"RIDER-3", "RIDER-1", "RIDER-2619750334", "RIDER-2"}
    assert warm_order(practice, "RIDER-2619750334") == [
        "RIDER-2619750334_test", "RIDER-2619750334_retest", "RIDER-1_test", "RIDER-1_retest", "RIDER-2_test", "RIDER-2_retest",
        "RIDER-3_test", "RIDER-3_retest"]
    assert warm_order({"RIDER-1"}, "RIDER-2619750334") == ["RIDER-1_test", "RIDER-1_retest"]  # a server without the case


import threading as _threading

from fastapi.testclient import TestClient

from conftest import BallSegmenter
from test_server_mode import A, SCAN, clock, server_env, USERS  # noqa: F401 (fixtures)
from lung_engine import app as app_module
from lung_engine.app import create_app


def _make(dicom_series, runs_dir):
    return TestClient(create_app(data_root=dicom_series, segmenter_factory=BallSegmenter, runs_dir=runs_dir, verify_user=USERS.get),
                      base_url="http://localhost")


def test_a_practice_server_prefetches_a_scans_folder_before_reading_it(server_env, clock, dicom_series, runs_dir, monkeypatch):
    seen = []
    monkeypatch.setattr(app_module, "prefetch", lambda d, *a, **k: seen.append(d.name) or 0)
    assert _make(dicom_series, runs_dir).get(SCAN, headers=A).status_code == 200
    assert seen == ["ct_test"]


def test_the_local_engine_never_prefetches(dicom_series, runs_dir, monkeypatch):
    monkeypatch.delenv("LUNG_SERVER", raising=False)
    seen = []
    monkeypatch.setattr(app_module, "prefetch", lambda d, *a, **k: seen.append(d) or 0)
    c = TestClient(create_app(data_root=dicom_series, segmenter_factory=BallSegmenter, runs_dir=runs_dir), base_url="http://localhost")
    assert c.get(SCAN).status_code == 200 and seen == []


def test_the_warm_up_runs_only_when_asked_and_reads_every_practice_scan(server_env, clock, dicom_series, runs_dir, monkeypatch, capsys):
    _make(dicom_series, runs_dir)  # LUNG_WARMUP unset: no warm-up thread
    assert not [t for t in _threading.enumerate() if t.name == "warm-up"]
    monkeypatch.setenv("LUNG_WARMUP", "1")
    _make(dicom_series, runs_dir)
    for t in [t for t in _threading.enumerate() if t.name == "warm-up"]:
        t.join(30)
    out = capsys.readouterr().out
    assert "warm-up: 2 scans," in out and "files read in" in out  # RIDER-TEST01's test and retest (the practice set in these tests)
