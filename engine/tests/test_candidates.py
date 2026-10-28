import json
import os
import sys
import time
import threading
import pytest
from fastapi.testclient import TestClient
from conftest import BallSegmenter
from lung_engine.app import create_app
from lung_engine.candidates import FinderError, FinderMissing, NoFinder, SubprocessFinder, to_voxels
from lung_engine.scans import load_scan

SID = "RIDER-TEST01_test"


@pytest.fixture
def scan(dicom_series):
    return load_scan(dicom_series, SID)


def test_to_voxels(scan):
    # fixture: x,y spacing 0.7, z spacing 1.25, origin 0, so index = mm / spacing; z = 0 is image number 8
    finds = [(7.0, 14.0, 5.0, 0.9),     # x=10, y=20, z=4
             (0.7, 0.7, 0.0, 0.6),      # x=1, y=1, z=0
             (7.0, 14.0, 5.0, 0.42),    # below the cut
             (7.0, 14.0, 5.0, 0.43),    # at the cut: kept
             (500.0, 14.0, 5.0, 0.99),  # outside x
             (7.0, 14.0, 50.0, 0.99)]   # outside z
    got = to_voxels(scan, finds)
    assert [(c["z"], c["y"], c["x"], c["score"], c["image"]) for c in got] == [(4, 20, 10, 0.9, 4), (0, 1, 1, 0.6, 8), (4, 20, 10, 0.43, 4)]


def test_to_voxels_rounds_and_falls_back_to_z_plus_1(scan):
    scan.instance_numbers = None
    got = to_voxels(scan, [(0.0, 0.0, 2.5, 0.123456), (0.0, 0.0, 2.5, 0.8765432)], cut=0.1)
    assert [(c["score"], c["image"]) for c in got] == [(0.877, 3), (0.123, 3)]


class FakeFinder:
    name = "fake"

    def __init__(self, hold=None):
        self.hold, self.started, self.cancels = hold, threading.Event(), 0

    def find(self, scan):
        n = self.cancels
        self.started.set()
        if self.hold:
            assert self.hold.wait(10)
        if self.cancels > n:  # cancelled during this run
            raise FinderError("exit code -9")
        return [(7.0, 14.0, 5.0, 0.8), (0.7, 0.7, 0.0, 0.2)]

    def cancel(self):
        self.cancels += 1
        if self.hold:
            self.hold.set()


def make(dicom_series, runs_dir, finder):
    return TestClient(create_app(data_root=dicom_series, segmenter_factory=BallSegmenter, runs_dir=runs_dir, finder=finder), base_url="http://localhost")


def test_post_then_get_and_event(dicom_series, runs_dir, log_path):
    c = make(dicom_series, runs_dir, FakeFinder())
    assert c.get(f"/api/scans/{SID}/candidates").status_code == 404
    r = c.post(f"/api/scans/{SID}/candidates")
    assert r.json() == [{"z": 4, "y": 20, "x": 10, "score": 0.8, "image": 4}]
    assert c.get(f"/api/scans/{SID}/candidates").json() == r.json()
    e = json.loads(log_path.read_text().splitlines()[-1])
    assert (e["action"], e["count"], e["cut"], e["finder"], e["scan"]) == ("candidates_found", 1, 0.43, "fake", SID) and e["seconds"] >= 0


def test_no_finder_is_503(client):
    assert client.post(f"/api/scans/{SID}/candidates").status_code == 503
    r = client.get(f"/api/scans/{SID}/candidates")
    assert r.status_code == 503 and r.json()["detail"] == "No nodule finder is installed in this engine."


def test_finder_missing_raised_is_503(dicom_series, runs_dir):
    class Gone(NoFinder):
        pass
    assert make(dicom_series, runs_dir, Gone()).post(f"/api/scans/{SID}/candidates").status_code == 503


def test_copilot_off_is_403_and_silent(dicom_series, runs_dir, log_path, monkeypatch):
    monkeypatch.setenv("LUNG_COPILOT", "off")
    c = make(dicom_series, runs_dir, FakeFinder())
    for r in (c.post(f"/api/scans/{SID}/candidates"), c.get(f"/api/scans/{SID}/candidates")):
        assert r.status_code == 403 and r.json()["detail"] == "The co-pilot is off for this session."
    assert not log_path.exists() or log_path.read_text() == ""


def test_a_run_for_another_scan_cancels_the_old_one(dicom_series, runs_dir, log_path):
    import shutil
    shutil.copytree(dicom_series / "RIDER-TEST01" / "ct_test", dicom_series / "RIDER-TEST01" / "ct_retest")
    f = FakeFinder(threading.Event())
    c = make(dicom_series, runs_dir, f)
    first = {}
    t = threading.Thread(target=lambda: first.update(r=c.post(f"/api/scans/{SID}/candidates")))
    t.start()
    assert f.started.wait(10)
    r = c.post("/api/scans/RIDER-TEST01_retest/candidates")
    t.join(10)
    assert f.cancels == 1 and r.status_code == 200 and first["r"].status_code == 500  # the page that asked first has switched scans and ignores it
    assert [json.loads(l)["scan"] for l in log_path.read_text().splitlines() if '"candidates_found"' in l] == ["RIDER-TEST01_retest"]


def test_second_request_is_409_and_clicks_still_work(dicom_series, runs_dir):
    hold = threading.Event()
    f = FakeFinder(hold)
    c = make(dicom_series, runs_dir, f)
    first = {}
    t = threading.Thread(target=lambda: first.update(r=c.post(f"/api/scans/{SID}/candidates")))
    t.start()
    try:
        assert f.started.wait(10)
        r = c.post(f"/api/scans/{SID}/candidates")
        assert r.status_code == 409 and r.json()["detail"] == "The finder is already running."
        assert c.post(f"/api/scans/{SID}/nodules", json={"z": 4, "y": 32, "x": 32}).status_code == 200
    finally:
        hold.set()
        t.join(10)
    assert first["r"].status_code == 200
    assert c.post(f"/api/scans/{SID}/candidates").status_code == 200  # the lock was released


def test_to_voxels_keeps_a_point_on_the_last_voxel_and_drops_one_just_past_it(scan):
    nz, ny, nx = scan.array.shape
    last = (nx - 1) * 0.7  # centre of the last voxel column
    past = nx * 0.7        # one voxel beyond the volume
    out = to_voxels(scan, [(last, 0.0, 0.0, 0.9), (past, 0.0, 0.0, 0.9)])
    assert [(c["z"], c["y"], c["x"]) for c in out] == [(0, 0, nx - 1)]


def test_the_route_and_to_voxels_share_one_cut():
    from lung_engine import candidates
    assert candidates.CUT == 0.43 and candidates.to_voxels.__defaults__ == (candidates.CUT,)


def test_the_finder_gets_the_engines_own_volume_in_runs_and_it_is_deleted(scan, runs_dir, tmp_path):
    body = ("import SimpleITK as sitk, numpy as np\nimg = sitk.ReadImage(a[a.index('--image') + 1])\n"
            "open(out.replace('.json', '.seen'), 'w').write(a[a.index('--image') + 1])\n"
            "json.dump({'finder': 'f', 'candidates': [{'x': p[0], 'y': p[1], 'z': p[2], 'score': 0.9} for p in [img.TransformIndexToPhysicalPoint((10, 20, 4))]],"
            " 'size': list(img.GetSize()), 'sum': int(sitk.GetArrayFromImage(img).astype(np.int64).sum())}, open(out, 'w'))")
    f = SubprocessFinder(runs_dir, fake_cmd(tmp_path, body))
    got = f.find(scan)
    assert to_voxels(scan, got) == [{"z": 4, "y": 20, "x": 10, "score": 0.9, "image": 4}]  # the same geometry as the engine's own image
    assert list(runs_dir.rglob("*.mha")) == [] and list(runs_dir.iterdir()) == []  # nothing left in runs/
    bad = SubprocessFinder(runs_dir, fake_cmd(tmp_path, "sys.exit(3)"))
    with pytest.raises(FinderError):
        bad.find(scan)
    assert list(runs_dir.iterdir()) == []


def fake_cmd(tmp_path, body):
    (tmp_path / "fake.py").write_text("import sys, json, time\na = sys.argv\nout = a[a.index('--out') + 1]\n" + body)
    return [sys.executable, str(tmp_path / "fake.py")]


def test_subprocess_finder_success(scan, runs_dir, tmp_path):
    cmd = fake_cmd(tmp_path, "json.dump({'finder': 'fake 1', 'candidates': [{'x': 7, 'y': 14, 'z': 5, 'score': 0.8}], 'seconds': 1}, open(out, 'w'))")
    f = SubprocessFinder(runs_dir, cmd)
    assert f.find(scan) == [(7.0, 14.0, 5.0, 0.8)] and f.name == "fake 1"


@pytest.mark.parametrize("body, text", [("time.sleep(5)", "longer than 0.5 s"), ("open(out, 'w').write('not json')", "JSONDecodeError"),
                                         ("sys.exit(3)", "exit code 3"), ("json.dump({'finder': 'x'}, open(out, 'w'))", "KeyError")])
def test_subprocess_finder_failures(scan, runs_dir, tmp_path, body, text):
    with pytest.raises(FinderError, match=text):
        SubprocessFinder(runs_dir, fake_cmd(tmp_path, body), timeout=0.5).find(scan)


def test_route_turns_finder_error_into_500_and_the_reason_into_the_engine_log(dicom_series, runs_dir, tmp_path, caplog):
    f = SubprocessFinder(runs_dir, fake_cmd(tmp_path, "sys.stderr.write('boom'); sys.exit(3)"))
    r = make(dicom_series, runs_dir, f).post(f"/api/scans/{SID}/candidates")
    assert r.status_code == 500 and r.json() == {"detail": "The finder did not run. The engine's log has the details."}
    assert "exit code 3: boom" in caplog.text


def test_lung_finder_env_selects_subprocess(dicom_series, runs_dir, monkeypatch):
    monkeypatch.setenv("LUNG_FINDER", "subprocess")
    c = TestClient(create_app(data_root=dicom_series, segmenter_factory=BallSegmenter, runs_dir=runs_dir), base_url="http://localhost")
    assert c.get(f"/api/scans/{SID}/candidates").status_code == 404  # not the 503 of NoFinder


def test_timeout_kills_the_whole_process_tree(scan, runs_dir, tmp_path):
    pidfile = tmp_path / "grandchild.pid"
    body = (f"import subprocess\nc = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])\n"
            f"open({str(pidfile)!r}, 'w').write(str(c.pid))\ntime.sleep(60)")
    with pytest.raises(FinderError, match="longer than"):
        SubprocessFinder(runs_dir, fake_cmd(tmp_path, body), timeout=1.5).find(scan)
    pid = int(pidfile.read_text())
    for _ in range(50):
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return
        time.sleep(0.1)
    os.kill(pid, 9)
    pytest.fail("the grandchild survived the timeout")


def test_copilot_status(dicom_series, runs_dir, monkeypatch):
    assert make(dicom_series, runs_dir, FakeFinder()).get("/api/copilot").json() == {"enabled": True, "finder": "fake"}
    assert make(dicom_series, runs_dir, None).get("/api/copilot").json() == {"enabled": False, "finder": None}
    monkeypatch.setenv("LUNG_COPILOT", "off")
    assert make(dicom_series, runs_dir, FakeFinder()).get("/api/copilot").json() == {"enabled": False, "finder": None}


def test_finder_command_env(dicom_series, runs_dir, monkeypatch, tmp_path):
    cmd = fake_cmd(tmp_path, "json.dump({'finder': 'fake 2', 'candidates': [], 'seconds': 1}, open(out, 'w'))")
    monkeypatch.setenv("LUNG_FINDER", "subprocess")
    monkeypatch.setenv("LUNG_FINDER_TEST_COMMAND", " ".join(cmd))
    assert make(dicom_series, runs_dir, None).post(f"/api/scans/{SID}/candidates").json() == []


def test_candidate_events_are_allow_listed(client, log_path):
    ok = dict(scan="RIDER-TEST01_test", rank=2, score=0.81)
    for a in ("candidate_accept", "candidate_reject", "undo_candidate_reject"):
        for drop in ("scan", "rank", "score"):  # each needs all three
            assert client.post("/api/events", json={"action": a, **{k: v for k, v in ok.items() if k != drop}}).status_code == 422
        assert client.post("/api/events", json=dict(action=a, **ok)).json() == {}
        e = json.loads(log_path.read_text().splitlines()[-1])
        assert (e["action"], e["rank"], e["score"]) == (a, 2, 0.81)
    lines = len(log_path.read_text().splitlines())
    for bad in (dict(rank=0), dict(rank=501), dict(rank=1.5), dict(rank="1"), dict(score=1.5), dict(score=-0.1), dict(score="0.5"), dict(score=True)):
        assert client.post("/api/events", json=dict(action="candidate_accept", **{**ok, **bad})).status_code == 422
    assert len(log_path.read_text().splitlines()) == lines


def test_an_opened_folder_scan_gets_the_same_marks_as_the_data_scan(dicom_series, runs_dir, tmp_path, log_path):
    body = ("import SimpleITK as sitk\nimg = sitk.ReadImage(a[a.index('--image') + 1])\n"
            "json.dump({'finder': 'f', 'candidates': [{'x': p[0], 'y': p[1], 'z': p[2], 'score': 0.9} for p in [img.TransformIndexToPhysicalPoint((10, 20, 4))]]}, open(out, 'w'))")
    c = TestClient(create_app(data_root=dicom_series, segmenter_factory=BallSegmenter, runs_dir=runs_dir, browse_root=dicom_series.resolve(),
                              finder=SubprocessFinder(runs_dir, fake_cmd(tmp_path, body))), base_url="http://localhost")
    series = c.get("/api/folders", params={"path": "RIDER-TEST01/ct_test"}).json()["series"][0]["uid_hash"]
    sid = c.post("/api/folders/open", json={"path": "RIDER-TEST01/ct_test", "series": series}).json()["id"]
    folder, data = c.post(f"/api/scans/{sid}/candidates"), c.post(f"/api/scans/{SID}/candidates")
    assert folder.status_code == data.status_code == 200 and folder.json() == data.json() == [{"z": 4, "y": 20, "x": 10, "score": 0.9, "image": 4}]


def test_engine_start_deletes_leftover_finder_folders(runs_dir):
    (runs_dir / "finder-old" ).mkdir(parents=True)
    (runs_dir / "finder-old" / "scan.mha").write_text("x")  # e.g. after a watchdog exit mid-run
    (runs_dir / "outlines").mkdir()
    SubprocessFinder(runs_dir)
    assert sorted(p.name for p in runs_dir.iterdir()) == ["outlines"]


def test_cancel_tolerates_a_finder_that_just_exited(runs_dir, monkeypatch):
    import lung_engine.candidates as cand

    class Ended:  # poll() said running, then it exited before killpg
        pid = 999_999
        def poll(self):
            return None

    def gone(pid, sig):
        raise ProcessLookupError
    monkeypatch.setattr(cand.os, "killpg", gone)
    f = SubprocessFinder(runs_dir)
    f.proc = Ended()
    f.cancel()  # no error


def test_record_lists_the_suggestions_inside_the_accepted_outline(dicom_series, runs_dir, log_path):
    class Two(FakeFinder):
        def find(self, scan):  # voxel (z4, y32, x34) lies inside the ball outline of a click at (4, 32, 32); (4, 32, 40) does not
            return [(34 * 0.7, 32 * 0.7, 4 * 1.25, 0.9), (40 * 0.7, 32 * 0.7, 4 * 1.25, 0.8)]
    c = make(dicom_series, runs_dir, Two())
    rec = lambda: c.post("/api/nodule/record", json=dict(scan=SID, nodule=c.post(f"/api/scans/{SID}/nodules", json=dict(z=4, y=32, x=32)).json()["nodule"]))
    assert "suggestions" not in rec().json()  # no finder run on this scan: the reply is as before
    assert [(m["z"], m["y"], m["x"]) for m in c.post(f"/api/scans/{SID}/candidates").json()] == [(4, 32, 34), (4, 32, 40)]
    n = c.post(f"/api/scans/{SID}/nodules", json=dict(z=4, y=32, x=32)).json()["nodule"]
    r = c.post("/api/nodule/record", json=dict(scan=SID, nodule=n))
    assert r.json()["suggestions"] == [1]  # ranks in the list's order, whoever started the outline
    assert c.post("/api/nodule/record", json=dict(scan=SID, nodule=n)).json() == r.json()  # a retry after a lost reply: the same answer
    assert json.loads([l for l in log_path.read_text().splitlines() if '"record"' in l][-1])["suggestions"] == [1]


def test_a_foreign_site_cannot_start_or_cancel_a_run(dicom_series, runs_dir, log_path):
    # POST .../candidates has no body, so another website could send it as a "simple" request, with no preflight
    f = FakeFinder()
    c = make(dicom_series, runs_dir, f)
    url = f"/api/scans/{SID}/candidates"
    for h in ({"Origin": "https://evil.example"}, {"Origin": "null"}, {"Sec-Fetch-Site": "cross-site"}, {"Origin": "https://evil.example", "Sec-Fetch-Site": "same-site"}):
        r = c.post(url, headers=h)
        assert r.status_code == 403 and "access-control-allow-origin" not in r.headers, h
    assert not f.started.is_set() and (not log_path.exists() or "candidates_found" not in log_path.read_text())
    for h in ({}, {"Origin": "http://localhost", "Sec-Fetch-Site": "same-origin"}):  # the engine's own page
        assert c.post(url, headers=h).status_code == 200, h
    hosted = {"Origin": "https://lung-measure.base44.app", "Sec-Fetch-Site": "cross-site"}  # the hosted page (the allowed origin), with the scan's code
    code = c.get("/api/scans", headers=hosted).json()[0]["id"]
    assert c.post(f"/api/scans/{code}/candidates", headers=hosted).status_code == 200


def test_a_cancel_while_the_run_is_starting_stops_it_at_once(scan, runs_dir, tmp_path, monkeypatch):
    import lung_engine.candidates as cand
    writing, go = threading.Event(), threading.Event()
    real = cand.sitk.WriteImage

    def slow_write(*a):  # the run is still writing its volume: no process yet
        writing.set()
        assert go.wait(10)
        real(*a)
    monkeypatch.setattr(cand.sitk, "WriteImage", slow_write)
    f = SubprocessFinder(runs_dir, fake_cmd(tmp_path, "time.sleep(30)"))
    out = {}
    t = threading.Thread(target=lambda: out.update(e=pytest.raises(FinderError, f.find, scan)))
    t0 = time.perf_counter()
    t.start()
    assert writing.wait(10)
    f.cancel()  # before the process exists
    go.set()
    t.join(10)
    assert not t.is_alive() and "e" in out and time.perf_counter() - t0 < 5  # killed as soon as it started, not after its 30 s


def test_the_finder_never_gets_the_engines_uv_environment(scan, runs_dir, tmp_path, monkeypatch):
    # On the practice server the engine runs with UV_PROJECT_ENVIRONMENT set (its own venv); handed on, `uv run --directory finder`
    # would install the finder's packages into the engine's environment. The finder keeps its own (finder/.venv).
    monkeypatch.setenv("UV_PROJECT_ENVIRONMENT", "/home/user/venv")
    cmd = fake_cmd(tmp_path, "import os\njson.dump({'finder': os.environ.get('UV_PROJECT_ENVIRONMENT', 'unset'), 'candidates': []}, open(out, 'w'))")
    f = SubprocessFinder(runs_dir, cmd)
    assert f.find(scan) == [] and f.name == "unset"
