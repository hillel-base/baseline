import json
import re
import shutil

import pytest
from fastapi.testclient import TestClient
from conftest import BallSegmenter
from lung_engine.app import create_app

HOSTED = {"Origin": "https://lung-measure.base44.app", "Sec-Fetch-Site": "cross-site"}
CODE = re.compile(r"D-[0-9a-f]{8}")


def make(root, runs):
    return TestClient(create_app(data_root=root, segmenter_factory=BallSegmenter, runs_dir=runs), base_url="http://localhost")


@pytest.fixture
def jane(dicom_series, runs_dir):
    """A data folder whose patient folder bears a name, with a second series for the follow-up map."""
    (dicom_series / "RIDER-TEST01").rename(dicom_series / "Jane_Doe")
    shutil.copytree(dicom_series / "Jane_Doe" / "ct_test", dicom_series / "Jane_Doe" / "ct_retest")
    return dicom_series


def codes(c):
    rows = c.get("/api/scans", headers=HOSTED).json()
    return {r["series"]: r["id"] for r in rows}


def test_list_has_codes_only_for_a_cross_origin_caller(jane, runs_dir):
    c = make(jane, runs_dir)
    r = c.get("/api/scans", headers=HOSTED)
    assert "Jane" not in r.text and all(CODE.fullmatch(s["id"]) and re.fullmatch(r"[0-9a-f]{8}", s["patient"]) for s in r.json())
    assert {s["id"] for s in c.get("/api/scans").json()} == {"Jane_Doe_test", "Jane_Doe_retest"}  # the engine's own page is unchanged


def test_info_slice_click_record_and_map_work_with_codes(jane, runs_dir, log_path):
    c = make(jane, runs_dir)
    ids = codes(c)
    a, b = ids["test"], ids["retest"]
    i = c.get(f"/api/scans/{a}", headers=HOSTED)
    assert "Jane" not in i.text and i.json()["id"] == a and "study_date" not in i.json() and CODE.fullmatch(i.json()["id"])
    assert c.get(f"/api/scans/{a}/slices/4", headers=HOSTED).status_code == 200
    s = c.post("/api/slice", json=dict(scan=a, z=4), headers=HOSTED)
    assert s.status_code == 200 and s.content == c.get(f"/api/scans/{a}/slices/4", headers=HOSTED).content
    n = c.post(f"/api/scans/{a}/nodules", json=dict(z=4, y=32, x=32), headers=HOSTED)
    assert n.status_code == 200 and "Jane" not in n.text and n.json()["scan"] == a
    w = dict(scan=a, nodule=n.json()["nodule"])
    k = c.post("/api/nodule/clicks", json={**w, "z": 4, "y": 32, "x": 34, "positive": True}, headers=HOSTED)
    assert k.status_code == 200 and "Jane" not in k.text and k.json()["scan"] == a
    assert c.post("/api/nodule/undo", json=w, headers=HOSTED).status_code == 200
    assert c.post("/api/nodule/record", json=w, headers=HOSTED).status_code == 200
    assert c.post("/api/events", json={"action": "zoom", "scan": a, "scale": 2}, headers=HOSTED).status_code == 200
    m = c.get(f"/api/scans/{b}/map", params={"from": a, "z": 4, "y": 32, "x": 32}, headers=HOSTED)
    assert m.status_code == 200 and "Jane" not in m.text
    assert "Jane_Doe_test" in log_path.read_text() and a not in log_path.read_text()  # the local log keeps the internal id


def test_own_page_still_sees_the_name(jane, runs_dir):
    c = make(jane, runs_dir)
    i = c.get("/api/scans/Jane_Doe_test").json()
    assert i["id"] == "Jane_Doe_test" and i["patient"] == "Jane_Doe" and "study_date" in i


def test_made_up_code_is_404(jane, runs_dir):
    c = make(jane, runs_dir)
    codes(c)
    assert c.get("/api/scans/D-00000000", headers=HOSTED).status_code == 404
    assert c.post("/api/scans/D-00000000/nodules", json=dict(z=4, y=32, x=32), headers=HOSTED).status_code == 404
    assert c.post("/api/nodule/undo", json=dict(scan="D-00000000", nodule=1), headers=HOSTED).status_code == 404
    assert c.get("/api/scans/Jane_Doe_test/map", params={"from": "D-00000000", "z": 4, "y": 32, "x": 32}).status_code == 404


def test_code_survives_a_restart(jane, runs_dir):
    a = codes(make(jane, runs_dir))["test"]
    c2 = make(jane, runs_dir)
    assert c2.get(f"/api/scans/{a}", headers=HOSTED).json()["id"] == a


def test_public_rider_rows_are_unchanged_cross_origin(dicom_series, runs_dir):
    (dicom_series / "RIDER-TEST01").rename(dicom_series / "RIDER-1286684383")
    c = make(dicom_series, runs_dir)
    assert c.get("/api/scans", headers=HOSTED).json() == [{"id": "RIDER-1286684383_test", "patient": "RIDER-1286684383", "series": "test"}]


def test_server_mode_lists_practice_patients_unchanged(dicom_series, runs_dir, monkeypatch):
    (dicom_series / "RIDER-TEST01").rename(dicom_series / "RIDER-1286684383")
    monkeypatch.setenv("LUNG_SERVER", "1")
    monkeypatch.setenv("SPACE_HOST", "x.hf.space")
    c = TestClient(create_app(data_root=dicom_series, segmenter_factory=BallSegmenter, runs_dir=runs_dir,
                              verify_user=lambda t: {"id": "u", "email": "user-a"}), base_url="http://localhost")
    r = c.get("/api/scans", headers={**HOSTED, "Authorization": "Bearer t"})
    assert [s["id"] for s in r.json()] == ["RIDER-1286684383_test"]


def test_file_names_carry_codes_across_origins(jane, runs_dir, log_path):
    c = make(jane, runs_dir)
    ids = codes(c)
    a, b = ids["test"], ids["retest"]
    bodies = []

    def rec(scan, **extra):
        n = c.post(f"/api/scans/{scan}/nodules", json=dict(z=4, y=32, x=32), headers=HOSTED)
        r = c.post("/api/nodule/record", json=dict(scan=scan, nodule=n.json()["nodule"], **extra), headers=HOSTED)
        bodies.extend([n.text, r.text])
        assert r.status_code == 200
        return r.json()["outline_file"]

    f1 = rec(a)
    assert re.fullmatch(r"outlines/D-[0-9a-f]{8}_n1_accepted\.nii\.gz", f1)
    f2 = rec(b, follows=f1, map_distance_mm=1.0)
    e = c.post("/api/events", json={"action": "followup_confirm", "scan": b, "follows": f1}, headers=HOSTED)
    e2 = c.post("/api/events", json={"action": "delete_row", "scan": a, "file": f1}, headers=HOSTED)
    assert e.status_code == e2.status_code == 200
    assert all("Jane" not in t for t in bodies) and "Jane" not in e.text and "Jane" not in f2
    log = log_path.read_text()
    assert f'"follows": "outlines/Jane_Doe_test_n1_accepted.nii.gz"' in log and f'"file": "outlines/Jane_Doe_test_n1_accepted.nii.gz"' in log
    assert (runs_dir / "outlines" / "Jane_Doe_test_n1_accepted.nii.gz").exists()
    # same-origin: unchanged
    n = c.post("/api/scans/Jane_Doe_test/nodules", json=dict(z=4, y=32, x=32))
    r = c.post("/api/nodule/record", json=dict(scan="Jane_Doe_test", nodule=n.json()["nodule"]))
    assert r.json()["outline_file"].startswith("outlines/Jane_Doe_test_n")


def test_internal_name_ids_get_the_same_404_cross_origin(jane, runs_dir):
    c = make(jane, runs_dir)
    unknown = c.get("/api/scans/D-00000000", headers=HOSTED)
    for method, url, kw in [("get", "/api/scans/Jane_Doe_test", {}), ("get", "/api/scans/Jane_Doe_test/slices/4", {}),
                            ("post", "/api/slice", dict(json=dict(scan="Jane_Doe_test", z=4))),
                            ("post", "/api/scans/Jane_Doe_test/nodules", dict(json=dict(z=4, y=32, x=32))),
                            ("post", "/api/nodule/undo", dict(json=dict(scan="Jane_Doe_test", nodule=1))),
                            ("post", "/api/events", dict(json={"action": "zoom", "scan": "Jane_Doe_test", "scale": 2})),
                            ("get", "/api/scans/Jane_Doe_retest/map?from=Jane_Doe_test&z=4&y=32&x=32", {}),
                            ("post", "/api/nodule/clicks", dict(json=dict(scan="Jane_Doe_test", nodule=1, z=4, y=32, x=32, positive=True))),
                            ("post", "/api/nodule/paint", dict(json=dict(scan="Jane_Doe_test", nodule=1, z=4, points=[[1, 1]], radius=2, mode="paint"))),
                            ("post", "/api/nodule/axes", dict(json=dict(scan="Jane_Doe_test", nodule=1, long_line=[[1, 1], [2, 2]], short_line=[[1, 2], [2, 1]]))),
                            ("post", "/api/nodule/record", dict(json=dict(scan="Jane_Doe_test", nodule=1))),
                            ("post", "/api/scans/Jane_Doe_test/candidates", {}), ("get", "/api/scans/Jane_Doe_test/candidates", {}),
                            ("get", "/api/scans/nope_test", {})]:
        r = getattr(c, method)(url, headers=HOSTED, **kw)
        assert r.status_code == 404 and r.json() == unknown.json() and "Jane" not in r.text
    assert c.get("/api/scans/Jane_Doe_test").status_code == 200  # own page: unchanged


def test_finder_routes_take_codes_and_leak_no_name(jane, runs_dir, tmp_path, log_path):
    import sys
    from test_candidates import FakeFinder
    c = TestClient(create_app(data_root=jane, segmenter_factory=BallSegmenter, runs_dir=runs_dir, finder=FakeFinder()), base_url="http://localhost")
    a = codes(c)["test"]
    r = c.post(f"/api/scans/{a}/candidates", headers=HOSTED)
    assert r.status_code == 200 and r.json() == [{"z": 4, "y": 20, "x": 10, "score": 0.8, "image": 4}] and "Jane" not in r.text
    g = c.get(f"/api/scans/{a}/candidates", headers=HOSTED)
    assert g.json() == r.json() and "Jane" not in g.text
    for un in ("D-00000000", "Jane_Doe_test"):  # a made-up code, and the internal id from another origin: the same 404 as any unknown scan
        for method in ("post", "get"):
            assert getattr(c, method)(f"/api/scans/{un}/candidates", headers=HOSTED).json() == {"detail": "unknown scan"}
    assert c.get("/api/scans/Jane_Doe_test/candidates").json() == r.json()  # own page: by its own id
    n = c.post(f"/api/scans/{a}/nodules", json=dict(z=4, y=32, x=32), headers=HOSTED).json()["nodule"]
    rec = c.post("/api/nodule/record", json=dict(scan=a, nodule=n), headers=HOSTED)
    assert set(rec.json()) == {"outline_file", "suggestions"} and rec.json()["suggestions"] == [] and "Jane" not in rec.text  # ranks only
    assert "Jane_Doe_test" in log_path.read_text() and a not in log_path.read_text()  # the local log keeps the internal id
    # a failing finder's own words can carry the folder: another origin gets none of them
    from lung_engine.candidates import SubprocessFinder
    (tmp_path / "bad.py").write_text("import sys\nsys.stderr.write('cannot read Jane_Doe ' + sys.argv[sys.argv.index('--image') + 1])\nsys.exit(2)")
    c = TestClient(create_app(data_root=jane, segmenter_factory=BallSegmenter, runs_dir=runs_dir, finder=SubprocessFinder(runs_dir, [sys.executable, str(tmp_path / "bad.py")])), base_url="http://localhost")
    for r in (c.post(f"/api/scans/{a}/candidates", headers=HOSTED), c.post("/api/scans/Jane_Doe_test/candidates")):  # no page gets the finder's own words
        assert r.status_code == 500 and r.json() == {"detail": "The finder did not run. The engine's log has the details."}


def test_public_rider_ids_still_work_cross_origin(dicom_series, runs_dir):
    (dicom_series / "RIDER-TEST01").rename(dicom_series / "RIDER-1286684383")
    c = make(dicom_series, runs_dir)
    assert c.get("/api/scans/RIDER-1286684383_test", headers=HOSTED).status_code == 200


def routes(a, b):
    return [("get", f"/api/scans/{a}", {}), ("get", f"/api/scans/{a}/slices/4", {}), ("post", "/api/slice", dict(json=dict(scan=a, z=4))),
            ("post", f"/api/scans/{a}/nodules", dict(json=dict(z=4, y=32, x=32))),
            ("get", f"/api/scans/{b}/map?from={a}&z=4&y=32&x=32", {}),
            ("post", "/api/events", dict(json={"action": "zoom", "scan": a, "scale": 2}))]


def test_stale_code_and_dot_folder_leak_no_name(jane, runs_dir):
    c = make(jane, runs_dir)
    ids = codes(c)
    shutil.rmtree(jane / "Jane_Doe")
    for method, url, kw in routes(ids["test"], ids["retest"]):
        r = getattr(c, method)(url, headers=HOSTED, **kw)
        assert "Jane" not in r.text and (url == "/api/events" or (r.status_code == 404 and r.json() == {"detail": "unknown scan"})), url  # events checks the id's shape only
    (jane / ".Hidden_Name" / "ct_test").mkdir(parents=True)
    d = codes(c)  # the listing mints a code for the dot folder, which cannot load
    for code in set(d.values()):
        for method, url, kw in routes(code, code):
            r = getattr(c, method)(url, headers=HOSTED, **kw)
            assert "Hidden" not in r.text and "Jane" not in r.text
    for method, url, kw in routes(".Hidden_Name_test", ".Hidden_Name_test"):
        assert "Hidden" not in getattr(c, method)(url, headers=HOSTED, **kw).text
    assert "Hidden" not in c.get("/api/scans/.Hidden_Name_test").text  # own page too: no id in any 404 detail


def test_patient_folder_named_like_an_opened_folder_is_coded(dicom_series, runs_dir):
    (dicom_series / "RIDER-TEST01").rename(dicom_series / "F-Garcia_Maria")
    c = make(dicom_series, runs_dir)
    r = c.get("/api/scans", headers=HOSTED)
    assert "Garcia" not in r.text and CODE.fullmatch(r.json()[0]["id"])
    assert c.get("/api/scans/F-Garcia_Maria_test", headers=HOSTED).status_code == 404


def test_opened_folder_scan_keeps_its_id_as_patient(jane, runs_dir, monkeypatch):
    browse = jane.resolve()
    c = TestClient(create_app(data_root=jane, segmenter_factory=BallSegmenter, runs_dir=runs_dir, browse_root=browse), base_url="http://localhost")
    series = c.get("/api/folders", params={"path": "Jane_Doe/ct_test"}).json()["series"][0]["uid_hash"]
    sid = c.post("/api/folders/open", json={"path": "Jane_Doe/ct_test", "series": series}).json()["id"]
    i = c.get(f"/api/scans/{sid}", headers=HOSTED)
    assert i.status_code == 200 and i.json()["id"] == sid and i.json()["patient"] == sid


def test_damaged_refs_error_names_the_file_only(jane, runs_dir):
    c = make(jane, runs_dir)
    runs_dir.mkdir(exist_ok=True)
    (runs_dir / "scan_refs.json").write_text("{bad")
    d = c.get("/api/scans/Jane_Doe_test").json()["detail"]
    assert "scan_refs.json" in d and str(runs_dir) not in d and str(jane) not in d


def test_unknown_code_in_file_names_is_refused(jane, runs_dir):
    c = make(jane, runs_dir)
    a = codes(c)["test"]
    r = c.post("/api/events", json={"action": "delete_row", "scan": a, "file": "outlines/D-00000000_n1_accepted.nii.gz"}, headers=HOSTED)
    assert r.status_code == 404 and r.json() == {"detail": "unknown scan"}


def test_undoes_is_decoded_in_the_log(jane, runs_dir, log_path):
    c = make(jane, runs_dir)
    a = codes(c)["test"]
    n = c.post(f"/api/scans/{a}/nodules", json=dict(z=4, y=32, x=32), headers=HOSTED).json()["nodule"]
    f = c.post("/api/nodule/record", json=dict(scan=a, nodule=n), headers=HOSTED).json()["outline_file"]
    r = c.post("/api/events", json={"action": "undo_record", "scan": a, "nodule": n, "undoes": f}, headers=HOSTED)
    assert r.status_code == 200
    assert json.loads(log_path.read_text().splitlines()[-1])["undoes"] == "outlines/Jane_Doe_test_n1_accepted.nii.gz"


def test_a_new_code_is_never_one_already_used(jane, runs_dir, monkeypatch):
    import lung_engine.app as appmod
    draws = iter(["aaaaaaaa"] * 3 + ["bbbbbbbb", "cccccccc", "dddddddd"])
    monkeypatch.setattr(appmod.secrets, "token_hex", lambda n: next(draws))
    c = make(jane, runs_dir)
    refs = list(json.loads((runs_dir / "scan_refs.json").read_text()).values()) if (runs_dir / "scan_refs.json").exists() else []
    ids = c.get("/api/scans", headers=HOSTED).json()
    assert len({s["id"] for s in ids}) == 2 and not refs


def test_only_listed_patients_pass_uncoded(dicom_series, runs_dir):
    (dicom_series / "RIDER-TEST01").rename(dicom_series / "RIDER-1234567890")
    shutil.copytree(dicom_series / "RIDER-1234567890", dicom_series / "RIDER-1286684383")
    shutil.copytree(dicom_series / "RIDER-1234567890", dicom_series / "RIDER-1867199702")  # a CT-only practice patient (fetch.PRACTICE)
    c = make(dicom_series, runs_dir)
    rows = {r["series"] + r["patient"]: r for r in c.get("/api/scans", headers=HOSTED).json()}
    assert any(r["id"] == "RIDER-1286684383_test" for r in rows.values()) and not any("1234567890" in r["id"] + r["patient"] for r in rows.values())
    for p in ("RIDER-1286684383", "RIDER-1867199702"):  # its own name is its study code, so the hosted page saves a practice row
        assert c.get(f"/api/scans/{p}_test", headers=HOSTED).json()["study_code"] == p
    code = next(r["id"] for r in rows.values() if r["id"].startswith("D-"))
    i = c.get(f"/api/scans/{code}", headers=HOSTED)
    assert "1234567890" not in i.text and i.json()["study_code"] != "RIDER-1234567890"
    assert c.get("/api/scans/RIDER-1234567890_test", headers=HOSTED).status_code == 404


def test_coded_list_is_sorted_by_code(jane, runs_dir):
    for n in ("Aaa", "Zzz"):
        shutil.copytree(jane / "Jane_Doe", jane / n)
    ids = [s["id"] for s in make(jane, runs_dir).get("/api/scans", headers=HOSTED).json()]
    assert len(ids) == 6 and ids == sorted(ids)
