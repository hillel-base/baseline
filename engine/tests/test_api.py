import base64
import json
import pytest
import numpy as np
import SimpleITK as sitk
from lung_engine.app import create_app
from fastapi.testclient import TestClient
from conftest import BallSegmenter
from lung_engine.followup import register


def test_unknown_scan_is_404(client):
    assert client.get("/api/scans/nope_test").status_code == 404


def test_slice_bytes(client):
    b = client.get("/api/scans/RIDER-TEST01_test/slices/4").content
    assert np.frombuffer(b, "<i2").reshape(64, 64)[32, 32] == 40


def test_slice_post_answers_the_same_bytes_and_errors_as_the_get(client):
    """POST /api/slice: one URL for every slice (a practice server's page then pays one CORS preflight, not one per slice)."""
    get = lambda scan, z: client.get(f"/api/scans/{scan}/slices/{z}")
    post = lambda body: client.post("/api/slice", json=body)
    for z in (0, 4, 7):
        g, p = get("RIDER-TEST01_test", z), post({"scan": "RIDER-TEST01_test", "z": z})
        assert p.status_code == g.status_code == 200 and p.content == g.content and p.headers["content-type"] == g.headers["content-type"]
    for scan, z in (("RIDER-TEST01_test", 8), ("RIDER-TEST01_test", -1), ("nope_test", 4)):
        g, p = get(scan, z), post({"scan": scan, "z": z})
        assert p.status_code == g.status_code == 404 and p.json() == g.json(), (scan, z)
    assert post({"scan": "../RIDER-TEST01_test", "z": 4}).json() == {"detail": "unknown scan"}  # a path in the body is only an unknown id
    for body in ({"scan": "RIDER-TEST01_test"}, {"z": 4}, {"scan": "RIDER-TEST01_test", "z": "4"}, {"scan": "RIDER-TEST01_test", "z": 4.5},
                 {"scan": "RIDER-TEST01_test", "z": True}, {"scan": 1, "z": 4}):
        assert post(body).status_code == 422, body


def test_slice_out_of_range_is_404(client):
    assert client.get("/api/scans/RIDER-TEST01_test/slices/8").status_code == 404


def test_scan_info_and_list(client):
    assert client.get("/api/scans").json() == [{"id": "RIDER-TEST01_test", "patient": "RIDER-TEST01", "series": "test"}]
    i = client.get("/api/scans/RIDER-TEST01_test").json()
    assert i["shape"] == [8, 64, 64] and i["spacing"] == [0.7, 0.7, 1.25]


def test_open_scan_is_logged(client, log_path):
    client.get("/api/scans/RIDER-TEST01_test")
    e = json.loads(log_path.read_text().splitlines()[-1])
    assert e["action"] == "open_scan" and e["scan"] == "RIDER-TEST01_test" and e["t"].endswith("Z") and e["commit"]
    assert e["patient"] == "RIDER-TEST01"


@pytest.mark.parametrize("sid", ["nope", ".._test", "RIDER-TEST01_other", ".hidden_test"])
def test_malformed_or_unsafe_scan_id_is_404(client, sid):
    assert client.get(f"/api/scans/{sid}").status_code == 404


def test_negative_z_is_404_and_a_404_writes_no_log_line(client, log_path):
    assert client.get("/api/scans/RIDER-TEST01_test/slices/-1").status_code == 404
    assert client.get("/api/scans/nope_test").status_code == 404
    assert not log_path.exists() or log_path.read_text() == ""


def test_foreign_host_header_is_rejected(client):
    assert client.get("/api/scans", headers={"Host": "evil.example"}).status_code == 400


def test_scan_meta_has_instance_numbers(client):
    assert client.get("/api/scans/RIDER-TEST01_test").json()["instance_numbers"][0] == 8


NODULES = "/api/scans/RIDER-TEST01_test/nodules"
CLICK = dict(z=4, y=32, x=32)
NOD = dict(scan="RIDER-TEST01_test", nodule=1)  # the first nodule a fresh engine starts


def test_api_first_click_outlines(client):
    o = client.post(NODULES, json=CLICK).json()
    assert o["volume_ml"] > 0 and o["axis_z"] == 4 and o["long_line"] and o["nodule"] == 1
    assert o["can_undo"] is True and o["clicks"] == [dict(**CLICK, positive=True)]


def test_api_empty_outline_is_zero_not_error(client_empty):
    o = client_empty.post(NODULES, json=CLICK).json()
    assert o["bbox"] is None and o["mask"] is None and o["volume_ml"] == 0 and o["long_mm"] == 0 and o["axis_z"] is None


def test_api_click_outside_volume_is_400(client):
    assert client.post(NODULES, json=dict(z=99, y=32, x=32)).status_code == 400


def test_api_correction_undo_and_outside_box(client):
    first = client.post(NODULES, json=CLICK).json()
    assert first["can_undo"] is True
    o = client.post("/api/nodule/clicks", json=dict(z=4, y=32, x=37, positive=True, **NOD)).json()
    assert o["volume_ml"] > first["volume_ml"] and o["can_undo"] is True
    u = client.post("/api/nodule/undo", json=NOD).json()
    assert u["volume_ml"] == first["volume_ml"] and len(u["clicks"]) == 1
    assert u["can_undo"] is False  # single level, as nnInteractive
    r = client.post("/api/nodule/clicks", json=dict(z=4, y=32, x=99, positive=True, **NOD))
    assert r.status_code == 400  # outside the volume


GONE = "This nodule is no longer open in the engine (another tab or a restart). Click the nodule to start again."


@pytest.mark.parametrize("nod", [dict(scan="RIDER-TEST01_other", nodule=1), dict(scan="RIDER-TEST01_test", nodule=2), None])
def test_correction_or_undo_for_a_nodule_the_engine_does_not_hold_is_400(client, log_path, nod):
    if nod:  # the engine holds nodule 1 of RIDER-TEST01_test; the request names another
        client.post(NODULES, json=CLICK)
    n = nod or NOD
    r = client.post(CLICKS, json=dict(z=4, y=32, x=32, positive=True, **n))
    assert r.status_code == 400 and r.json()["detail"] == GONE
    e = json.loads(log_path.read_text().splitlines()[-1])
    assert (e["action"], e["reason"], e["z"], e["y"], e["x"], e["nodule"]) == ("click_refused", "no_nodule", 4, 32, 32, n["nodule"])
    lines = len(log_path.read_text().splitlines())
    r = client.post("/api/nodule/undo", json=n)
    assert r.status_code == 400 and r.json()["detail"] == GONE
    assert len(log_path.read_text().splitlines()) == lines + 1
    assert json.loads(log_path.read_text().splitlines()[-1])["reason"] == "no_nodule"


def test_api_undo_the_first_click_gives_the_empty_outline(client):
    client.post(NODULES, json=CLICK)
    u = client.post("/api/nodule/undo", json=NOD).json()
    assert u["clicks"] == [] and u["bbox"] is None and u["volume_ml"] == 0 and u["can_undo"] is False
    r = client.post("/api/nodule/undo", json=NOD)
    assert r.status_code == 409 and r.json()["detail"] == "Nothing to undo."


def test_saved_first_outline_matches_the_payload_after_two_starts(client, runs_dir):
    for z, y, x in [(4, 32, 32), (3, 30, 35)]:  # both inside the +40 HU ball, not on air
        o = client.post(NODULES, json=dict(z=z, y=y, x=x)).json()
        z0, y0, x0, z1, y1, x1 = o["bbox"]
        bits = np.unpackbits(np.frombuffer(base64.b64decode(o["mask"]), np.uint8))
        sub = bits[:(z1 - z0) * (y1 - y0) * (x1 - x0)].reshape(z1 - z0, y1 - y0, x1 - x0).astype(bool)
        saved = sitk.GetArrayFromImage(sitk.ReadImage(str(runs_dir / f"outlines/RIDER-TEST01_test_n{o['nodule']}_first.nii.gz")))
        want = np.zeros((8, 64, 64), bool)
        want[z0:z1, y0:y1, x0:x1] = sub
        assert (saved.astype(bool) == want).all()


def test_nodule_numbers_count_per_scan(client):
    assert client.post(NODULES, json=CLICK).json()["nodule"] == 1
    assert client.post(NODULES, json=CLICK).json()["nodule"] == 2


def test_nodule_start_and_click_are_logged(client, log_path):
    client.post(NODULES, json=CLICK)
    client.post("/api/nodule/clicks", json=dict(z=4, y=32, x=40, positive=False, **NOD))
    start, click = [json.loads(l) for l in log_path.read_text().splitlines()]
    assert start["action"] == "nodule_start" and (start["z"], start["y"], start["x"]) == (4, 32, 32)
    assert start["positive"] is True and start["nodule"] == 1 and start["seconds"] >= 0
    assert click["action"] == "click" and click["positive"] is False and click["x"] == 40


def test_first_outline_saved_on_ct_grid(client, runs_dir):
    client.post(NODULES, json=CLICK)
    m = sitk.ReadImage(str(runs_dir / "outlines/RIDER-TEST01_test_n1_first.nii.gz"))
    assert m.GetSize() == (64, 64, 8) and np.allclose(m.GetSpacing(), (0.7, 0.7, 1.25))
    assert sitk.GetArrayFromImage(m)[4, 32, 32] == 1


def test_existing_outline_file_is_never_overwritten(client, runs_dir, log_path):
    f = runs_dir / "outlines/RIDER-TEST01_test_n1_first.nii.gz"
    f.parent.mkdir(parents=True)
    f.write_bytes(b"keep")
    client.post(NODULES, json=CLICK)
    run = json.loads(log_path.read_text().splitlines()[0])["run"]
    assert f.read_bytes() == b"keep" and (runs_dir / f"outlines/RIDER-TEST01_test_n1_{run}_first.nii.gz").exists()


def test_nodule_start_names_its_outline_file_even_after_a_restart(dicom_series, runs_dir, log_path):
    for _ in range(2):  # two engine runs in the same runs folder
        TestClient(create_app(data_root=dicom_series, segmenter_factory=BallSegmenter, runs_dir=runs_dir),
                   base_url="http://localhost").post(NODULES, json=CLICK)
    for line in log_path.read_text().splitlines():
        e = json.loads(line)
        assert (runs_dir / e["outline_file"]).exists()
    first, second = [json.loads(l) for l in log_path.read_text().splitlines()]
    assert first["outline_file"] == "outlines/RIDER-TEST01_test_n1_first.nii.gz"
    assert second["outline_file"] == f"outlines/RIDER-TEST01_test_n1_{second['run']}_first.nii.gz"


def test_edge_flag_is_in_the_payload_and_the_log(client, log_path):
    o = client.post(NODULES, json=CLICK).json()
    c = client.post("/api/nodule/clicks", json=dict(z=4, y=32, x=37, positive=True, **NOD)).json()
    assert o["at_window_edge"] is True  # the fixture's ball is cut by the 8-slice scan, so it touches the crop box
    assert [json.loads(l)["at_window_edge"] for l in log_path.read_text().splitlines()] == [o["at_window_edge"], c["at_window_edge"]]


CLICKS = "/api/nodule/clicks"


def test_minus_click_shrinks(client):
    a = client.post(NODULES, json=CLICK).json()
    b = client.post(CLICKS, json=dict(**CLICK, positive=False, **NOD)).json()
    assert b["volume_ml"] < a["volume_ml"]


def test_plus_click_grows(client):
    a = client.post(NODULES, json=CLICK).json()
    b = client.post(CLICKS, json=dict(z=4, y=32, x=38, positive=True, **NOD)).json()
    assert b["volume_ml"] > a["volume_ml"] and len(b["clicks"]) == 2


def test_click_outside_box_is_400(client):
    client.post(NODULES, json=CLICK)
    r = client.post(CLICKS, json=dict(z=4, y=32, x=99, positive=True, **NOD))
    assert r.status_code == 400 and r.json()["detail"].startswith("That click is outside the working box of this nodule.")


def test_undo_restores_and_is_single_level(client):
    a = client.post(NODULES, json=CLICK).json()
    client.post(CLICKS, json=dict(**CLICK, positive=False, **NOD))
    u = client.post("/api/nodule/undo", json=NOD).json()
    assert u["volume_ml"] == a["volume_ml"] and not u["can_undo"]
    assert client.post("/api/nodule/undo", json=NOD).status_code == 409


def test_clicks_logged_with_sign(client, log_path):
    client.post(NODULES, json=CLICK)
    client.post(CLICKS, json=dict(**CLICK, positive=False, **NOD))
    e = json.loads(log_path.read_text().splitlines()[-1])
    assert e["action"] == "click" and e["positive"] is False and e["seconds"] >= 0


def test_plus_click_on_air_is_refused_but_minus_is_allowed(client, log_path):
    client.post(NODULES, json=CLICK)
    air = dict(z=0, y=0, x=0)  # -1000 HU, inside the box
    r = client.post(CLICKS, json=dict(**air, positive=True, **NOD))
    assert r.status_code == 400 and r.json()["detail"] == "That point is air, so it cannot be added. Click on the nodule itself."
    assert json.loads(log_path.read_text().splitlines()[-1])["reason"] == "air"
    assert client.post(CLICKS, json=dict(**air, positive=False, **NOD)).status_code == 200


def test_refused_clicks_are_logged(client, log_path):
    client.post(NODULES, json=dict(z=0, y=0, x=0))  # air
    client.post(NODULES, json=dict(z=99, y=32, x=32))  # outside the volume
    client.post(CLICKS, json=dict(z=4, y=32, x=32, positive=True, **NOD))  # no nodule yet
    client.post(NODULES, json=CLICK)
    client.post(CLICKS, json=dict(z=4, y=32, x=99, positive=False, **NOD))  # outside the box
    lines = [json.loads(l) for l in log_path.read_text().splitlines()]
    refused = [l for l in lines if l["action"] == "click_refused"]
    assert [(l["reason"], l["z"], l["y"], l["x"]) for l in refused] == [
        ("air", 0, 0, 0), ("outside_volume", 99, 32, 32), ("no_nodule", 4, 32, 32), ("outside_box", 4, 32, 99)]
    assert [l.get("positive") for l in refused] == [True, True, True, False]
    assert [l.get("nodule") for l in refused] == [None, None, 1, 1]


def test_width_setting(dicom_series, runs_dir):
    def start(**kw):
        c = TestClient(create_app(data_root=dicom_series, segmenter_factory=BallSegmenter, runs_dir=runs_dir, **kw), base_url="http://localhost")
        return c.post(NODULES, json=CLICK).json()
    e, c = start(), start(width="centre")
    assert e["width_method"] == "edge to edge" and c["width_method"] == "centre to centre"
    assert e["long_mm"] > c["long_mm"] and e["depth_mm"] > c["depth_mm"]
    with pytest.raises(ValueError, match="LUNG_WIDTH must be edge or centre."):
        start(width="inch")


def test_width_method_is_logged_and_head_dir_is_reported(client, log_path):
    client.post(NODULES, json=CLICK)
    assert json.loads(log_path.read_text().splitlines()[-1])["width_method"] == "edge to edge"
    assert client.get("/api/scans/RIDER-TEST01_test").json()["head_dir"] == 1


@pytest.mark.data
def test_real_scan_head_dir_is_1(tmp_path):
    import os
    from pathlib import Path
    data = Path(os.environ.get("LUNG_DATA_DIR", Path(__file__).resolve().parents[2] / "data" / "rider"))
    if not (data / "RIDER-1286684383").is_dir():
        pytest.skip("RIDER data not found")
    c = TestClient(create_app(data_root=data, segmenter_factory=BallSegmenter, runs_dir=tmp_path), base_url="http://localhost")
    assert c.get("/api/scans/RIDER-1286684383_test").json()["head_dir"] == 1


RECORD = "/api/nodule/record"


def test_record_saves_accepted_outline(client, runs_dir, log_path):
    client.post(NODULES, json=CLICK)
    o = client.post(CLICKS, json=dict(z=4, y=32, x=37, positive=True, **NOD)).json()
    r = client.post(RECORD, json=NOD)
    assert r.status_code == 200 and r.json() == {"outline_file": "outlines/RIDER-TEST01_test_n1_accepted.nii.gz"}
    m = sitk.ReadImage(str(runs_dir / r.json()["outline_file"]))
    assert m.GetSize() == (64, 64, 8) and sitk.GetArrayFromImage(m).sum() > 0
    e = json.loads(log_path.read_text().splitlines()[-1])
    assert e["action"] == "record" and e["outline_file"] == r.json()["outline_file"] and e["clicks"] == 2
    for k in ("volume_ml", "long_mm", "short_mm", "depth_mm", "width_method", "axis_z", "long_line", "short_line", "at_window_edge"):
        assert e[k] == o[k]
    assert e["scan"] == "RIDER-TEST01_test" and e["nodule"] == 1
    assert (e["corrections"], e["series_number"], e["slice_thickness_mm"], e["slice_spacing_mm"]) == (1, 3, 1.25, 1.25)
    assert "2001" not in log_path.read_text() and "study_date" not in log_path.read_text()  # StudyDate 2001-02-03 stays local


def test_record_twice_returns_the_same_file_and_logs_once(client, runs_dir, log_path):
    client.post(NODULES, json=CLICK)
    first = client.post(RECORD, json=NOD)
    lines = len(log_path.read_text().splitlines())
    r = client.post(RECORD, json=NOD)
    assert r.status_code == 200 and r.json() == first.json()
    assert len(list((runs_dir / "outlines").glob("*_accepted.nii.gz"))) == 1
    assert len(log_path.read_text().splitlines()) == lines


def test_record_stays_recorded_when_the_log_fails(client, runs_dir, monkeypatch):
    import lung_engine.events as ev
    client.post(NODULES, json=CLICK)
    real = ev.EventLog.log
    def boom(self, action, **kw):
        if action == "record":
            raise OSError("log full")
        return real(self, action, **kw)
    monkeypatch.setattr(ev.EventLog, "log", boom)
    with pytest.raises(OSError):
        client.post(RECORD, json=NOD)
    r = client.post(RECORD, json=NOD)
    assert r.status_code == 200 and r.json()["outline_file"] == "outlines/RIDER-TEST01_test_n1_accepted.nii.gz"
    assert client.post(CLICKS, json=dict(z=4, y=32, x=37, positive=True, **NOD)).status_code == 409


def test_event_for_a_valid_looking_scan_never_loads_it(client, monkeypatch):
    import lung_engine.app as app_mod
    def boom(*a):
        raise AssertionError("loaded a scan")
    monkeypatch.setattr(app_mod, "load_scan", boom)
    assert client.post("/api/events", json=dict(action="discard", scan="RIDER-NOPE_test")).status_code == 200


def test_record_refusals(client, client_empty, log_path):
    r = client.post(RECORD, json=NOD)  # nothing open
    assert r.status_code == 400 and r.json()["detail"] == GONE
    client.post(NODULES, json=CLICK)
    r = client.post(RECORD, json=dict(scan="RIDER-TEST01_test", nodule=2))
    assert r.status_code == 400 and r.json()["detail"] == GONE
    e = json.loads(log_path.read_text().splitlines()[-1])
    assert (e["action"], e["reason"], e["nodule"]) == ("click_refused", "no_nodule", 2)
    client_empty.post(NODULES, json=CLICK)
    r = client_empty.post(RECORD, json=NOD)
    assert r.status_code == 400 and r.json()["detail"] == "Nothing to record: the outline is empty."


def test_record_after_restart_does_not_overwrite(dicom_series, runs_dir, log_path):
    for _ in range(2):
        c = TestClient(create_app(data_root=dicom_series, segmenter_factory=BallSegmenter, runs_dir=runs_dir), base_url="http://localhost")
        c.post(NODULES, json=CLICK)
        c.post(RECORD, json=NOD)
    recs = [json.loads(l) for l in log_path.read_text().splitlines() if '"record"' in l]
    assert recs[0]["outline_file"] == "outlines/RIDER-TEST01_test_n1_accepted.nii.gz"
    assert recs[1]["outline_file"] == f"outlines/RIDER-TEST01_test_n1_{recs[1]['run']}_accepted.nii.gz"
    assert all((runs_dir / e["outline_file"]).exists() for e in recs)


def test_a_second_record_of_the_same_scan_and_nodule_in_one_run_never_overwrites(client, runs_dir, log_path):
    client.post(NODULES, json=CLICK)
    run = json.loads(log_path.read_text().splitlines()[0])["run"]
    taken = [runs_dir / f"outlines/RIDER-TEST01_test_n1{s}_accepted.nii.gz" for s in ("", f"_{run}")]  # both names today's code would use
    for f in taken:
        f.write_bytes(b"keep")
    r = client.post(RECORD, json=NOD)
    assert r.status_code == 200 and r.json()["outline_file"] not in {f.relative_to(runs_dir).as_posix() for f in taken}
    assert all(f.read_bytes() == b"keep" for f in taken) and (runs_dir / r.json()["outline_file"]).exists()


def test_undo_record_event_is_allow_listed_and_typed(client, log_path):
    f = "outlines/RIDER-TEST01_test_n1_accepted.nii.gz"
    assert client.post("/api/events", json=dict(action="undo_record", scan="RIDER-TEST01_test", nodule=1, undoes=f)).json() == {}
    e = json.loads(log_path.read_text().splitlines()[-1])
    assert (e["action"], e["scan"], e["nodule"], e["undoes"], e["patient"]) == ("undo_record", "RIDER-TEST01_test", 1, f, "RIDER-TEST01")
    assert e["t"] and e["run"] and e["commit"]
    lines = len(log_path.read_text().splitlines())
    for bad in (dict(action="undo_record", scan="RIDER-TEST01_test", nodule=1), dict(action="undo_record", nodule=1, undoes=f), dict(action="undo_record", scan="RIDER-TEST01_test", undoes=f),
                dict(action="undo_record", scan="RIDER-TEST01_test", nodule=1, undoes="x" * 201), dict(action="undo_record", scan="RIDER-TEST01_test", nodule=1, undoes=3)):
        assert client.post("/api/events", json=bad).status_code == 422, bad
    assert len(log_path.read_text().splitlines()) == lines


def test_save_failed_event_carries_a_short_reason_only(client, log_path):
    for reason in ("403", "Error", "AxiosError", "TypeError"):  # an HTTP status or an error class
        assert client.post("/api/events", json=dict(action="save_failed", reason=reason)).json() == {}
        e = json.loads(log_path.read_text().splitlines()[-1])
        assert (e["action"], e["reason"]) == ("save_failed", reason) and e["t"] and e["run"]
    lines = len(log_path.read_text().splitlines())
    for bad in (dict(action="save_failed"), dict(action="save_failed", reason="x" * 61), dict(action="save_failed", reason="x@y"),
                dict(action="save_failed", reason='{"long_axis_mm": 3}'), dict(action="save_failed", reason="runs/outlines/x"), dict(action="save_failed", reason=403)):
        assert client.post("/api/events", json=bad).status_code == 422, bad
    assert len(log_path.read_text().splitlines()) == lines


def test_ui_events_are_allow_listed(client, log_path):
    r = client.post("/api/events", json=dict(action="copy_row", scan="RIDER-TEST01_test", nodule=1, rows=3, file="a.csv"))
    assert r.status_code == 200 and r.json() == {}
    e = json.loads(log_path.read_text().splitlines()[-1])
    assert (e["action"], e["scan"], e["nodule"], e["rows"], e["file"], e["patient"]) == ("copy_row", "RIDER-TEST01_test", 1, 3, "a.csv", "RIDER-TEST01")
    assert client.post("/api/events", json=dict(action="clear_table", rows=2)).json() == {}
    assert json.loads(log_path.read_text().splitlines()[-1])["rows"] == 2
    assert client.post("/api/events", json=dict(action="restore_table", rows=1)).json() == {}
    assert json.loads(log_path.read_text().splitlines()[-1])["action"] == "restore_table"
    assert client.post("/api/events", json=dict(action="start_over", scan="RIDER-TEST01_test", nodule=2)).json() == {}
    assert client.post("/api/events", json=dict(action="undo_delete_row", scan="RIDER-TEST01_test", nodule=2, file="outlines/x_n2_accepted.nii.gz")).json() == {}
    e = json.loads(log_path.read_text().splitlines()[-1])
    assert (e["action"], e["nodule"], e["file"]) == ("undo_delete_row", 2, "outlines/x_n2_accepted.nii.gz")
    for a, sc in (("zoom", 1.25), ("zoom_area", 4), ("zoom_fit", None)):
        assert client.post("/api/events", json=dict(action=a, scan="RIDER-TEST01_test", **({} if sc is None else {"scale": sc}))).json() == {}
    assert json.loads(log_path.read_text().splitlines()[-2])["scale"] == 4
    lines = len(log_path.read_text().splitlines())
    for bad in (dict(action="zoom", scale=0.5), dict(action="zoom", scale=17), dict(action="zoom", scale="2"), dict(action="zoom", scale=True), dict(action="rm -rf"), dict(action="discard", extra=1), dict(action="discard", nodule=-1), dict(action="discard", nodule=1.0), dict(action="discard", scan="a" * 101),
                dict(action="export_csv", file="x" * 201), dict(action="discard", scan="../x_test")):
        assert client.post("/api/events", json=bad).status_code in (404, 422)
    assert client.post("/api/events", json=dict(action="discard", scan="../x_test")).status_code == 404
    assert len(log_path.read_text().splitlines()) == lines


def test_failed_write_leaves_the_nodule_recordable(client, runs_dir, monkeypatch):
    import lung_engine.app as app_mod
    real, calls = app_mod.write_mask, []
    def flaky(*a):
        calls.append(1)
        if len(calls) == 2:  # call 1 is the first-outline file of the start
            raise OSError("disk full")
        real(*a)
    monkeypatch.setattr(app_mod, "write_mask", flaky)
    client.post(NODULES, json=CLICK)
    with pytest.raises(OSError):
        client.post(RECORD, json=NOD)
    assert client.post(RECORD, json=NOD).status_code == 200
    assert len(list((runs_dir / "outlines").glob("*_accepted.nii.gz"))) == 1


def test_recorded_nodule_is_final(client, log_path):
    client.post(NODULES, json=CLICK)
    client.post(RECORD, json=NOD)
    lines = len(log_path.read_text().splitlines())
    for path, body in ((CLICKS, dict(z=4, y=32, x=37, positive=True, **NOD)), ("/api/nodule/undo", NOD)):
        r = client.post(path, json=body)
        assert r.status_code == 409 and r.json()["detail"] == "This nodule is already recorded. Start a new nodule to change it."
    assert len(log_path.read_text().splitlines()) == lines


ORIGIN = "https://lung-measure.base44.app"
PREFLIGHT = {"Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type",
             "Access-Control-Request-Private-Network": "true"}


def _app_client(dicom_series, runs_dir, monkeypatch, origin=ORIGIN):
    monkeypatch.setenv("LUNG_ALLOWED_ORIGIN", origin)
    return TestClient(create_app(data_root=dicom_series, segmenter_factory=BallSegmenter, runs_dir=runs_dir), base_url="http://localhost")


def test_allowed_origin_preflight_and_get_carry_cors_headers(dicom_series, runs_dir, monkeypatch):
    c = _app_client(dicom_series, runs_dir, monkeypatch)
    r = c.options("/api/scans", headers={"Origin": ORIGIN, **PREFLIGHT})
    h = r.headers
    assert r.status_code == 200 and h["access-control-allow-origin"] == ORIGIN
    assert h["access-control-allow-methods"] == "GET, POST" and "Content-Type" in h["access-control-allow-headers"]  # Starlette adds the safelisted headers too
    assert h["access-control-allow-private-network"] == "true"
    assert c.get("/api/scans", headers={"Origin": ORIGIN}).headers["access-control-allow-origin"] == ORIGIN


DEFAULT = "https://lung-measure.base44.app"


@pytest.mark.parametrize("origin", ["https://evil.example.com", "https://lung-measure.base44.app.evil.com", "http://lung-measure.base44.app",
                                    "https://lung-measure-709ec964.base44.app", DEFAULT + "/", DEFAULT.upper(), "null"])  # the old address no longer works
def test_other_origins_get_no_cors_headers(dicom_series, runs_dir, monkeypatch, origin):
    c = _app_client(dicom_series, runs_dir, monkeypatch, origin=DEFAULT)
    pre = c.options("/api/scans", headers={"Origin": origin, **PREFLIGHT})
    assert pre.status_code == 400 and "access-control-allow-origin" not in pre.headers  # a browser needs allow-origin; Starlette still lists methods
    assert "access-control-allow-private-network" not in pre.headers
    assert "access-control-allow-origin" not in c.get("/api/scans", headers={"Origin": origin}).headers


def test_empty_allowed_origin_turns_cors_off(dicom_series, runs_dir, monkeypatch):
    c = _app_client(dicom_series, runs_dir, monkeypatch, origin="")
    r = c.get("/api/scans", headers={"Origin": ORIGIN})
    assert "access-control-allow-origin" not in r.headers


def test_default_origin_is_the_hosted_app(dicom_series, runs_dir, monkeypatch):
    monkeypatch.delenv("LUNG_ALLOWED_ORIGIN", raising=False)
    c = TestClient(create_app(data_root=dicom_series, segmenter_factory=BallSegmenter, runs_dir=runs_dir), base_url="http://localhost")
    o = "https://lung-measure.base44.app"
    assert c.get("/api/scans", headers={"Origin": o}).headers["access-control-allow-origin"] == o


def test_info_has_its_four_fields_and_loads_no_scan(client):
    i = client.get("/api/info").json()
    assert set(i) == {"commit", "model", "width_method", "device", "picker"}  # picker: this engine serves /picker
    assert i["model"] == "nnInteractive 2.6.0 (CC BY-NC-SA 4.0)" and i["width_method"] == "edge" and i["commit"]


def test_scan_ref_is_stable_across_apps_and_differs_between_scans(dicom_series, runs_dir, tmp_path):
    import shutil
    shutil.copytree(dicom_series / "RIDER-TEST01" / "ct_test", dicom_series / "RIDER-TEST02" / "ct_test")  # a second scan
    mk = lambda: TestClient(create_app(data_root=dicom_series, segmenter_factory=BallSegmenter, runs_dir=runs_dir), base_url="http://localhost")
    a, b = mk(), mk()
    r1 = a.get("/api/scans/RIDER-TEST01_test").json()["scan_ref"]
    r2 = a.get("/api/scans/RIDER-TEST02_test").json()["scan_ref"]
    assert len(r1) == 8 and int(r1, 16) >= 0 and r1 != r2
    assert b.get("/api/scans/RIDER-TEST01_test").json()["scan_ref"] == r1
    assert (runs_dir / "scan_refs.json").exists()


@pytest.mark.parametrize("bad", ["{not json", "[]", '{"a": 1}', "null"])
def test_damaged_refs_file_is_a_500_and_is_left_alone(client, runs_dir, log_path, bad):
    runs_dir.mkdir(exist_ok=True)
    f = runs_dir / "scan_refs.json"
    f.write_text(bad)
    r = client.get("/api/scans/RIDER-TEST01_test")
    assert r.status_code == 500 and r.json()["detail"] == (
        f"The scan reference file is damaged: runs/scan_refs.json. Restore it from scan_refs.json.bak next to it, or move it away to start new references.")
    assert f.read_text() == bad and not (runs_dir / "scan_refs.json.bak").exists() and not (runs_dir / "scan_refs.tmp").exists() and not log_path.exists()


def test_a_write_keeps_the_previous_file_as_bak(client, dicom_series, runs_dir):
    import shutil
    shutil.copytree(dicom_series / "RIDER-TEST01" / "ct_test", dicom_series / "RIDER-TEST02" / "ct_test")
    client.get("/api/scans/RIDER-TEST01_test")
    before = (runs_dir / "scan_refs.json").read_text()
    client.get("/api/scans/RIDER-TEST02_test")
    assert (runs_dir / "scan_refs.json.bak").read_text() == before != (runs_dir / "scan_refs.json").read_text()


def test_scan_meta_has_header_identity(client):
    m = client.get("/api/scans/RIDER-TEST01_test").json()
    assert (m["series_number"], m["study_date"], m["slice_thickness_mm"]) == (3, "2001-02-03", 1.25)


def test_map_route_caches_transform(client, monkeypatch):
    calls = []
    real = register
    monkeypatch.setattr("lung_engine.app.register", lambda f, m: calls.append(1) or real(f, m))
    url = "/api/scans/RIDER-TEST01_test/map?from=RIDER-TEST01_test"
    a = client.get(url + "&z=4&y=32&x=32")
    b = client.get(url + "&z=4&y=30&x=30")
    assert a.status_code == b.status_code == 200 and len(calls) == 1
    assert set(a.json()) == {"z", "y", "x", "seconds"}


def test_map_route_validates(client):
    t = "/api/scans/RIDER-TEST01_test/map"
    assert client.get(t + "?from=nope&z=4&y=32&x=32").status_code == 404
    assert client.get(t + "?from=RIDER-OTHER_test&z=4&y=32&x=32").status_code == 404
    assert client.get(t + "?from=RIDER-TEST01_test&z=99&y=32&x=32").status_code == 400


MAP = "/api/scans/RIDER-TEST01_test/map?from=RIDER-TEST01_test&z=4&y=32&x=32"


def test_parallel_first_map_requests_register_once(client, monkeypatch):
    import threading, time as t
    calls = []
    def slow(f, m):
        calls.append(1); t.sleep(0.3)
        return sitk.TranslationTransform(3, (0.0, 0.0, 0.0))
    monkeypatch.setattr("lung_engine.app.register", slow)
    client.get("/api/scans/RIDER-TEST01_test")  # load the scan first, so both requests reach the registration together
    got = []
    ts = [threading.Thread(target=lambda: got.append(client.get(MAP))) for _ in range(2)]
    for th in ts: th.start()
    for th in ts: th.join()
    assert [r.status_code for r in got] == [200, 200] and len(calls) == 1
    assert got[0].json()["z"] == got[1].json()["z"] == 4


def test_map_reply_says_outside_only_when_clamped(client, monkeypatch, log_path):
    monkeypatch.setattr("lung_engine.app.register", lambda f, m: sitk.TranslationTransform(3, (500.0, 0.0, 0.0)))
    r = client.get(MAP).json()
    assert r["outside"] is True and (r["z"], r["y"], r["x"]) == (4, 32, 63)
    e = json.loads(log_path.read_text().splitlines()[-1])
    assert (e["action"], e["outside"], e["to_x"]) == ("map", True, 63)


def test_map_reply_has_no_outside_flag_inside(client, monkeypatch):
    monkeypatch.setattr("lung_engine.app.register", lambda f, m: sitk.TranslationTransform(3, (0.7, 0.0, 0.0)))
    r = client.get(MAP).json()
    assert set(r) == {"z", "y", "x", "seconds"} and (r["z"], r["y"], r["x"]) == (4, 32, 33)


def test_registration_error_logs_map_failed_without_a_path(client, monkeypatch, log_path):
    def boom(f, m):
        raise RuntimeError("Exception thrown in SimpleITK /home/someone/src/sitkImageRegistrationMethod.cxx:123: metric failed")
    monkeypatch.setattr("lung_engine.app.register", boom)
    r = client.get(MAP)
    assert r.status_code == 500 and r.json()["detail"] == "Could not align this scan to the earlier one."
    e = json.loads(log_path.read_text().splitlines()[-1])
    assert (e["action"], e["scan"], e["src"]) == ("map_failed", "RIDER-TEST01_test", "RIDER-TEST01_test")
    assert e["reason"].startswith("RuntimeError: Exception thrown in SimpleITK") and "metric failed" in e["reason"] and "/" not in e["reason"]


def test_followup_events_are_allow_listed_and_typed(client, log_path):
    f = "outlines/RIDER-TEST01_test_n1_accepted.nii.gz"
    assert client.post("/api/events", json=dict(action="followup_confirm", scan="RIDER-TEST01_retest", follows=f)).json() == {}
    e = json.loads(log_path.read_text().splitlines()[-1])
    assert (e["action"], e["scan"], e["follows"], e["patient"]) == ("followup_confirm", "RIDER-TEST01_retest", f, "RIDER-TEST01")
    assert client.post("/api/events", json=dict(action="followup_moved", scan="RIDER-TEST01_retest", follows=f, distance_mm=7)).json() == {}
    e = json.loads(log_path.read_text().splitlines()[-1])
    assert (e["action"], e["follows"], e["distance_mm"]) == ("followup_moved", f, 7.0)
    lines = len(log_path.read_text().splitlines())
    for bad in (dict(action="followup_moved", scan="RIDER-TEST01_retest", follows=f, distance_mm=-1), dict(action="followup_moved", scan="RIDER-TEST01_retest", follows=f, distance_mm="3"),
                dict(action="followup_moved", scan="RIDER-TEST01_retest", follows=f, distance_mm=True), dict(action="followup_moved", scan="RIDER-TEST01_retest", follows=f),
                dict(action="followup_confirm", scan="RIDER-TEST01_retest"), dict(action="followup_confirm", follows=f), dict(action="followup_confirm", scan="RIDER-TEST01_retest", follows="x" * 201)):
        assert client.post("/api/events", json=bad).status_code == 422, bad
    assert len(log_path.read_text().splitlines()) == lines


def test_record_event_carries_follows_and_map_distance(client, log_path):
    client.post(NODULES, json=CLICK)
    f = "outlines/RIDER-TEST01_test_n1_accepted.nii.gz"
    assert client.post(RECORD, json=dict(**NOD, follows=f, map_distance_mm=0)).status_code == 200
    e = json.loads(log_path.read_text().splitlines()[-1])
    assert (e["action"], e["follows"], e["map_distance_mm"]) == ("record", f, 0.0)
    client.post(NODULES, json=CLICK)
    client.post(RECORD, json=dict(scan="RIDER-TEST01_test", nodule=2))
    e = json.loads(log_path.read_text().splitlines()[-1])
    assert e["action"] == "record" and "follows" not in e and "map_distance_mm" not in e
    for bad in (dict(map_distance_mm=-0.5), dict(map_distance_mm="1"), dict(follows="x" * 201)):
        assert client.post(RECORD, json=dict(scan="RIDER-TEST01_test", nodule=3, **bad)).status_code == 422


# Slice 5: paint, erase and hand-set axes. FROZEN: the payloads of the frozen path (start, + click, - click, undo),
# captured from the engine before slice 5; with no strokes the payload must stay the same plus painted and axes_edited.
FROZEN = json.loads(r'''
[{"nodule": 1, "scan": "RIDER-TEST01_test", "clicks": [{"z": 4, "y": 32, "x": 32, "positive": true}], "can_undo": true, "bbox": [1, 29, 29, 8, 36, 36], "mask": "AAAAgAAAADj58+OAAD58+fPgAh8+/vnwgA+fPnz4AAOPnz44AAAAAgAAAA==", "volume_ml": 0.08, "long_mm": 4.9, "short_mm": 4.9, "axis_z": 4, "depth_mm": 8.8, "width_method": "edge to edge", "long_line": [[32.0, 28.5], [32.0, 35.5]], "short_line": [[28.5, 32.0], [35.5, 32.0]], "at_window_edge": true}, {"nodule": 1, "scan": "RIDER-TEST01_test", "clicks": [{"z": 4, "y": 32, "x": 32, "positive": true}, {"z": 4, "y": 32, "x": 37, "positive": true}], "can_undo": true, "bbox": [1, 29, 29, 8, 36, 41], "mask": "AAAAAAEIAAAAAAAAOcf+f+f+OcAAAAf+f+f+f+f+AAEIf+f+//f+f+EIAAf+f+f+f+f+AAAAOcf+f+f+OcAAAAAAAAEIAAAAAAA=", "volume_ml": 0.15, "long_mm": 8.4, "short_mm": 4.9, "axis_z": 4, "depth_mm": 8.8, "width_method": "edge to edge", "long_line": [[32.0, 28.5], [32.0, 40.5]], "short_line": [[28.5, 32.0], [35.5, 32.0]], "at_window_edge": true}, {"nodule": 1, "scan": "RIDER-TEST01_test", "clicks": [{"z": 4, "y": 32, "x": 32, "positive": true}, {"z": 4, "y": 32, "x": 37, "positive": true}, {"z": 4, "y": 30, "x": 30, "positive": false}], "can_undo": true, "bbox": [1, 29, 30, 8, 36, 41], "mask": "AAAAABCAAAAAAAATg/j/f+c4AAAA/h/D+/9/4AACA/D+H+/7/xCAAD+H8P7/3/gAAAE4P4/3/nOAAAAAAABCAAAAAAA=", "volume_ml": 0.12, "long_mm": 8.0, "short_mm": 4.4, "axis_z": 4, "depth_mm": 8.8, "width_method": "edge to edge", "long_line": [[34.12, 29.42], [31.88, 40.58]], "short_line": [[29.42, 35.88], [35.58, 37.12]], "at_window_edge": true}, {"nodule": 1, "scan": "RIDER-TEST01_test", "clicks": [{"z": 4, "y": 32, "x": 32, "positive": true}, {"z": 4, "y": 32, "x": 37, "positive": true}], "can_undo": false, "bbox": [1, 29, 29, 8, 36, 41], "mask": "AAAAAAEIAAAAAAAAOcf+f+f+OcAAAAf+f+f+f+f+AAEIf+f+//f+f+EIAAf+f+f+f+f+AAAAOcf+f+f+OcAAAAAAAAEIAAAAAAA=", "volume_ml": 0.15, "long_mm": 8.4, "short_mm": 4.9, "axis_z": 4, "depth_mm": 8.8, "width_method": "edge to edge", "long_line": [[32.0, 28.5], [32.0, 40.5]], "short_line": [[28.5, 32.0], [35.5, 32.0]], "at_window_edge": true}]
''')
PAINT, AXES = "/api/nodule/paint", "/api/nodule/axes"


def test_frozen_path_payload_and_events_are_todays_plus_painted_and_axes_edited(client, log_path):
    got = [client.post(NODULES, json=CLICK).json(),
           client.post(CLICKS, json=dict(z=4, y=32, x=37, positive=True, **NOD)).json(),
           client.post(CLICKS, json=dict(z=4, y=30, x=30, positive=False, **NOD)).json(),
           client.post("/api/nodule/undo", json=NOD).json()]
    for g, want in zip(got, FROZEN):
        assert g.pop("seconds") >= 0
        assert g == want | dict(painted=0, axes_edited=False)
    client.post(RECORD, json=NOD)
    base = {"t", "run", "commit", "action", "patient", "scan", "nodule"}
    click = base | {"z", "y", "x", "positive", "seconds", "at_window_edge"}
    rec = base | {"outline_file", "clicks", "corrections", "series_number", "slice_thickness_mm", "slice_spacing_mm", "volume_ml", "long_mm",
                  "short_mm", "depth_mm", "width_method", "axis_z", "long_line", "short_line", "at_window_edge", "painted", "axes_edited"}
    assert [set(json.loads(l)) for l in log_path.read_text().splitlines()] == [
        click | {"width_method", "outline_file"}, click, click, base, rec]
    e = json.loads(log_path.read_text().splitlines()[-1])
    assert (e["painted"], e["axes_edited"]) == (0, False)


def test_paint_and_erase_routes_edit_the_outline_and_log(client, log_path):
    first = client.post(NODULES, json=CLICK).json()
    o = client.post(PAINT, json=dict(**NOD, z=4, points=[[32, 37], [32, 39]], radius=2, mode="paint", snap=False)).json()
    assert o["painted"] == 1 and o["volume_ml"] > first["volume_ml"] and o["axes_edited"] is False
    e = json.loads(log_path.read_text().splitlines()[-1])
    # 23 pixels within 2 of the line, 1 of them already in the ball's disk at x = 35
    assert {k: e[k] for k in ("action", "scan", "nodule", "z", "radius", "voxels", "snap")} == dict(
        action="paint", scan="RIDER-TEST01_test", nodule=1, z=4, radius=2, voxels=22, snap=False)
    r = client.post(PAINT, json=dict(**NOD, z=4, points=[[32, 32]], radius=1, mode="erase", snap=True)).json()
    e = json.loads(log_path.read_text().splitlines()[-1])
    assert r["painted"] == 2 and (e["action"], e["voxels"], e["snap"]) == ("erase", 5, False)  # erase ignores snap, and its event says so
    u = client.post("/api/nodule/undo", json=NOD).json()
    assert u["painted"] == 1 and u["mask"] == o["mask"] and json.loads(log_path.read_text().splitlines()[-1])["action"] == "undo"


def test_a_stroke_that_changes_nothing_is_400_logs_nothing_and_keeps_the_nodule(client, log_path):
    o = client.post(NODULES, json=CLICK).json()
    long_line = [[32, 28.5], [32, 36.5]]
    client.post(AXES, json=dict(**NOD, long_line=long_line, short_line=o["short_line"]))
    lines = len(log_path.read_text().splitlines())
    nothing = "That stroke changed nothing."
    for body, detail in ((dict(points=[[10, 10]], mode="paint", snap=True), nothing + " Snap to tissue keeps out pixels below \u2212750 HU."),  # air
                         (dict(points=[[32, 32]], mode="paint", snap=False), nothing),  # inside the outline
                         (dict(points=[[10, 10]], mode="erase", snap=True), nothing)):  # outside it
        r = client.post(PAINT, json=dict(**NOD, z=4, radius=1, **body))
        assert (r.status_code, r.json()["detail"]) == (400, detail), body
    assert len(log_path.read_text().splitlines()) == lines
    client.post(RECORD, json=NOD)
    e = json.loads(log_path.read_text().splitlines()[-1])
    assert (e["action"], e["painted"], e["axes_edited"], e["long_line"], e["volume_ml"]) == ("record", 0, True, long_line, o["volume_ml"])


def test_paint_route_refusals(client, log_path):
    client.post(NODULES, json=CLICK)
    ok = dict(**NOD, z=4, points=[[32, 37]], radius=3, mode="paint", snap=False)
    lines = len(log_path.read_text().splitlines())
    for bad in (dict(radius=0), dict(radius=16), dict(mode="fill"), dict(points=[]), dict(points=[[1]]), dict(points=[[1, 2, 3]]),
                dict(points=[[1, 2]] * 1001), dict(z="top")):
        assert client.post(PAINT, json=ok | bad).status_code == 422, bad
    for bad in (dict(z=99), dict(z=-1), dict(points=[[32, 90]])):  # nothing of the stroke inside the working box
        r = client.post(PAINT, json=ok | bad)
        assert r.status_code == 400 and r.json()["detail"] == "That stroke is outside the working box of this nodule.", bad
    assert len(log_path.read_text().splitlines()) == lines
    r = client.post(PAINT, json=ok | dict(nodule=2))
    assert r.status_code == 400 and r.json()["detail"] == GONE
    e = json.loads(log_path.read_text().splitlines()[-1])
    assert (e["action"], e["reason"], e["nodule"]) == ("click_refused", "no_nodule", 2)
    client.post(RECORD, json=NOD)
    lines = len(log_path.read_text().splitlines())
    for path, body in ((PAINT, ok), (AXES, dict(**NOD, long_line=[[32, 29], [32, 35]], short_line=[[29, 32], [35, 32]]))):
        r = client.post(path, json=body)
        assert r.status_code == 409 and r.json()["detail"] == "This nodule is already recorded. Start a new nodule to change it."
    assert len(log_path.read_text().splitlines()) == lines


def test_axes_route_sets_the_drawn_lengths_logs_axis_drag_and_the_row_keeps_them(client, log_path):
    o = client.post(NODULES, json=CLICK).json()
    long_line = [[32, 28.5], [32, 36.5]]  # one pixel longer than the outline's [[32, 28.5], [32, 35.5]]
    a = client.post(AXES, json=dict(**NOD, long_line=long_line, short_line=o["short_line"])).json()
    assert (a["axes_edited"], a["long_line"], a["long_mm"], a["short_mm"]) == (True, long_line, 5.6, o["short_mm"])
    drags = [json.loads(l) for l in log_path.read_text().splitlines() if '"axis_drag"' in l]
    assert [(e["which"], e["before_mm"], e["after_mm"], e["nodule"]) for e in drags] == [("long", 4.9, 5.6, 1)]
    u = client.post("/api/nodule/undo", json=NOD).json()
    assert u["axes_edited"] is False and u["long_mm"] == 4.9
    client.post(AXES, json=dict(**NOD, long_line=long_line, short_line=o["short_line"]))
    client.post(RECORD, json=NOD)
    e = json.loads(log_path.read_text().splitlines()[-1])
    assert (e["action"], e["axes_edited"], e["painted"], e["long_mm"], e["long_line"]) == ("record", True, 0, 5.6, long_line)


def test_axes_route_refusals(client, client_empty, log_path):
    o = client.post(NODULES, json=CLICK).json()
    ok = dict(**NOD, long_line=o["long_line"], short_line=o["short_line"])
    lines = len(log_path.read_text().splitlines())
    for bad in (dict(long_line=[[32, 28.5]]), dict(long_line=[[32, 28.5], [32, 35.5], [32, 36]]), dict(short_line=[[28.5, "x"], [35.5, 32]]), dict(short_line=None)):
        assert client.post(AXES, json=ok | bad).status_code == 422, bad
    r = client.post(AXES, json=ok | dict(long_line=[[32, 28.5], [32, 500]]))
    assert r.status_code == 400 and r.json()["detail"] == "Those axis end points are outside the working box of this nodule."
    assert len(log_path.read_text().splitlines()) == lines
    r = client.post(AXES, json=ok | dict(nodule=2))
    assert r.status_code == 400 and r.json()["detail"] == GONE
    assert json.loads(log_path.read_text().splitlines()[-1])["reason"] == "no_nodule"
    client_empty.post(NODULES, json=CLICK)
    r = client_empty.post(AXES, json=ok)
    assert r.status_code == 400 and r.json()["detail"] == "Nothing to measure: the outline is empty."


def _second(dicom_series, name, date=None, series="ct_test"):
    import shutil
    dst = dicom_series / name / series
    shutil.copytree(dicom_series / "RIDER-TEST01" / "ct_test", dst)
    if date:  # rewrite the StudyDate of every file
        for f in dst.glob("*.dcm"):
            img = sitk.ReadImage(str(f))
            img.SetMetaData("0008|0020", date)
            w = sitk.ImageFileWriter(); w.KeepOriginalImageUIDOn(); w.SetFileName(str(f)); w.Execute(img)


def test_study_code_is_the_public_rider_name_or_a_stable_random_code(dicom_series, runs_dir):
    _second(dicom_series, "RIDER-1286684383")
    _second(dicom_series, "Smith_John")
    mk = lambda: TestClient(create_app(data_root=dicom_series, segmenter_factory=BallSegmenter, runs_dir=runs_dir), base_url="http://localhost")
    a, b = mk(), mk()
    assert a.get("/api/scans/RIDER-1286684383_test").json()["study_code"] == "RIDER-1286684383"
    c1 = a.get("/api/scans/Smith_John_test").json()["study_code"]
    c2 = a.get("/api/scans/RIDER-TEST01_test").json()["study_code"]
    assert len(c1) == 8 and int(c1, 16) >= 0 and "Smith" not in c1 and c1 != c2  # RIDER-TEST01 is not 10 digits: it gets a code too
    assert b.get("/api/scans/Smith_John_test").json()["study_code"] == c1
    assert (runs_dir / "patient_refs.json").exists()


def test_damaged_patient_refs_file_is_a_500(client, runs_dir):
    runs_dir.mkdir(exist_ok=True)
    f = runs_dir / "patient_refs.json"
    f.write_text("{bad")
    r = client.get("/api/scans/RIDER-TEST01_test")
    assert r.status_code == 500 and "patient reference file is damaged" in r.json()["detail"] and f.read_text() == "{bad"


@pytest.mark.parametrize("origin,has_date", [(None, True), ("http://localhost", True), ("http://localhost:5173", False), ("http://127.0.0.1:4173", False),  # cross_origin: only the engine's own origin is local
                                             ("https://lung-measure.base44.app", False), ("http://localhost.evil.com:80", False), ("null", False)])
def test_study_date_goes_only_to_a_local_page(client, origin, has_date):
    m = client.get("/api/scans/RIDER-TEST01_test", headers={"Origin": origin} if origin else {}).json()
    assert ("study_date" in m) is has_date


def test_days_from_baseline_counts_from_the_earliest_series(dicom_series):
    _second(dicom_series, "RIDER-TEST01", date="20010213", series="ct_retest")  # 10 days after the test series (20010203)
    c = TestClient(create_app(data_root=dicom_series, segmenter_factory=BallSegmenter, runs_dir=dicom_series / "runs"), base_url="http://localhost")
    assert c.get("/api/scans/RIDER-TEST01_test").json()["days_from_baseline"] == 0
    assert c.get("/api/scans/RIDER-TEST01_retest").json()["days_from_baseline"] == 10
