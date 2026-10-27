import os, shutil

import pytest
from fastapi.testclient import TestClient
from conftest import BallSegmenter
from lung_engine.app import create_app

OUTSIDE = "That folder is outside the allowed area."


@pytest.fixture
def root(dicom_series, tmp_path):
    r = tmp_path / "root"
    (r / "study" / "sub").mkdir(parents=True)
    shutil.copytree(dicom_series / "RIDER-TEST01" / "ct_test", r / "study" / "ct")
    (r / "plain.txt").write_text("x")
    return r


def make(root, runs_dir, data=None):
    return TestClient(create_app(data_root=data or root / "nodata", segmenter_factory=BallSegmenter, runs_dir=runs_dir,
                                 browse_root=root), base_url="http://localhost")


@pytest.fixture
def fc(root, runs_dir):
    return make(root, runs_dir)


def test_lists_folders_not_files(fc):
    j = fc.get("/api/folders").json()
    assert j == {"path": "", "parent": None, "folders": ["study"], "series": []}
    j = fc.get("/api/folders", params={"path": "study"}).json()
    assert j["path"] == "study" and j["parent"] == "" and j["folders"] == ["ct", "sub"] and j["series"] == []
    j = fc.get("/api/folders", params={"path": "study/ct"}).json()
    assert j["parent"] == "study" and len(j["series"]) == 1
    s = j["series"][0]
    assert s["images"] == 8 and set(s) == {"uid_hash", "description", "images"} and "1.2.826" not in str(j)


@pytest.mark.parametrize("p", ["..", "study/../..", "/etc", "study/../../root2"])
def test_escapes_refused(fc, p):
    r = fc.get("/api/folders", params={"path": p})
    assert r.status_code == 400 and r.json()["detail"] == OUTSIDE


def test_absolute_path_inside_root_allowed(fc, root):
    assert fc.get("/api/folders", params={"path": str(root / "study")}).json()["path"] == "study"


def test_symlink_out_refused_and_not_listed(root, runs_dir, tmp_path):
    (tmp_path / "elsewhere").mkdir()
    os.symlink(tmp_path / "elsewhere", root / "link")
    c = make(root, runs_dir)
    assert "link" not in c.get("/api/folders").json()["folders"]
    assert c.get("/api/folders", params={"path": "link"}).status_code == 400


def test_missing_folder_is_404_without_path(fc):
    r = fc.get("/api/folders", params={"path": "nope"})
    assert r.status_code == 404 and "nope" not in r.text


def test_open_registers_series_and_serves_it(fc):
    uid = fc.get("/api/folders", params={"path": "study/ct"}).json()["series"][0]["uid_hash"]
    m = fc.post("/api/folders/open", json={"path": "study/ct", "series": uid}).json()
    assert m["id"].startswith("F-") and len(m["id"]) == 10 and m["shape"] == [8, 64, 64]
    assert m["id"] in [s["id"] for s in fc.get("/api/scans").json()]
    assert len(fc.get(f"/api/scans/{m['id']}/slices/3").content) == 64 * 64 * 2
    o = fc.post(f"/api/scans/{m['id']}/nodules", json={"z": 3, "y": 32, "x": 32}).json()
    assert o["scan"] == m["id"] and o["volume_ml"] > 0


def test_open_refuses_escape_and_unknown_series(fc):
    assert fc.post("/api/folders/open", json={"path": "..", "series": "x"}).status_code == 400
    assert fc.post("/api/folders/open", json={"path": "study/ct", "series": "nope"}).status_code == 404


def test_id_survives_restart_and_log_has_no_path(root, runs_dir, log_path):
    c = make(root, runs_dir)
    uid = c.get("/api/folders", params={"path": "study/ct"}).json()["series"][0]["uid_hash"]
    sid = c.post("/api/folders/open", json={"path": "study/ct", "series": uid}).json()["id"]
    c.get(f"/api/scans/{sid}")
    c2 = make(root, runs_dir)
    assert c2.get(f"/api/scans/{sid}").json()["shape"] == [8, 64, 64]
    log = log_path.read_text()
    assert sid in log and str(root) not in log and "study" not in log and "1.2.826" not in log


def test_folder_scan_event_shape_is_accepted(fc):
    assert fc.post("/api/events", json={"action": "copy_row", "scan": "F-0123abcd_folder", "nodule": 1}).status_code == 200
    assert fc.post("/api/events", json={"action": "copy_row", "scan": "F-0123abcd/../x"}).status_code == 404


def test_folder_with_too_many_files_refused_on_list_and_open(root, fc):
    big = root / "big"
    big.mkdir()
    for i in range(5001):
        (big / f"{i}.x").touch()
    for r in (fc.get("/api/folders", params={"path": "big"}), fc.post("/api/folders/open", json={"path": "big", "series": "x"})):
        assert r.status_code == 400 and r.json()["detail"] == "This folder holds too many files to list (over 5000). Open a folder nearer the scan."


def test_file_link_out_of_root_refused(root, runs_dir, tmp_path):
    (tmp_path / "out.dcm").write_text("x")
    os.symlink(tmp_path / "out.dcm", root / "study" / "sub" / "l.dcm")
    assert make(root, runs_dir).get("/api/folders", params={"path": "study/sub"}).status_code == 400


def test_stored_scan_is_404_under_a_different_root(root, runs_dir, log_path, tmp_path):
    c = make(root, runs_dir)
    uid = c.get("/api/folders", params={"path": "study/ct"}).json()["series"][0]["uid_hash"]
    sid = c.post("/api/folders/open", json={"path": "study/ct", "series": uid}).json()["id"]
    other = tmp_path / "other"
    other.mkdir()
    r = make(other, runs_dir).get(f"/api/scans/{sid}")
    assert r.status_code == 404 and str(root) not in r.text and str(root) not in log_path.read_text()


def test_corrupt_folder_file_starts_empty(root, runs_dir, log_path):
    runs_dir.mkdir()
    (runs_dir / "folder_scans.json").write_text("{not json")
    assert make(root, runs_dir).get("/api/scans").json() == []
    assert "folder_scans_unreadable" in log_path.read_text() and str(root) not in log_path.read_text()


def test_access_log_is_off_and_prints_no_path(fc, caplog):
    import logging
    with caplog.at_level(logging.INFO, logger="uvicorn.access"):
        fc.get("/api/folders", params={"path": "study"})
        logging.getLogger("uvicorn.access").info('GET /api/folders?path=study HTTP/1.1')
    assert "study" not in caplog.text


def test_unreadable_images_give_400_without_path(root, fc, monkeypatch):
    uid = fc.get("/api/folders", params={"path": "study/ct"}).json()["series"][0]["uid_hash"]
    sid = fc.post("/api/folders/open", json={"path": "study/ct", "series": uid}).json()["id"]
    c = make(root, root.parent / "runs")  # fresh engine: nothing cached
    def boom(*a):
        raise RuntimeError(f"Exception thrown in SimpleITK ReadImageInformation: {root}/x.dcm")
    monkeypatch.setattr("lung_engine.app.load_folder_scan", boom)
    r = c.get(f"/api/scans/{sid}")
    assert r.status_code == 400 and r.json()["detail"] == "This folder's images could not be read." and str(root) not in r.text


HOSTED = {"Origin": "https://lung-measure.base44.app", "Sec-Fetch-Site": "cross-site"}


@pytest.mark.parametrize("headers", [HOSTED, {"Origin": "http://localhost:4173", "Sec-Fetch-Site": "same-site"},
                                     {"Origin": "https://evil.example"}, {"Sec-Fetch-Site": "cross-site"}])
def test_folder_routes_answer_only_the_engines_own_page(fc, root, headers):
    """Folder names are often patient names: a cross-origin page (the hosted page, and Base44's scripts in it) gets none."""
    for r in (fc.get("/api/folders?path=", headers=headers), fc.post("/api/folders/open", json={"path": "", "series": "x"}, headers=headers),
              fc.options("/api/folders", headers={**headers, "Access-Control-Request-Method": "GET"})):
        assert r.status_code == 403, (r.request.method, headers)
        assert "access-control-allow-origin" not in r.headers and "RIDER" not in r.text and "scan" not in r.text.replace("scans", "")


def test_folder_routes_work_on_the_engines_own_page(fc):
    same = {"Origin": "http://localhost", "Sec-Fetch-Site": "same-origin"}
    assert fc.get("/api/folders?path=", headers=same).status_code == 200
    assert fc.get("/api/folders?path=").status_code == 200  # no browser headers: curl and the tests
