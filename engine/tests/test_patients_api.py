"""GET /api/patients and POST /api/patients/folder: the study folder's patients and the data folder's, on the engine's own page only."""
import json
import re
import shutil

import pytest
from fastapi.testclient import TestClient

from conftest import BallSegmenter
from test_api import _second
from test_server_mode import A, ORIGIN, SIGN_IN, clock, make as server_make, server_env  # noqa: F401 (fixtures)
from test_study_index import dcm, put
from lung_engine import app as app_module, study_index
from lung_engine.app import create_app

HOSTED = {"Origin": "https://lung-measure.base44.app", "Sec-Fetch-Site": "cross-site"}
OUTSIDE = "That folder is outside the allowed area."
BY_ENV = "The study folder is set by LUNG_STUDY_DIR on this computer."
F_ID = re.compile(r"F-[0-9a-f]{8}")


@pytest.fixture
def root(dicom_series, tmp_path, monkeypatch):
    """A browse root with a study folder: Alpha (two dates), Beta (undated), and a loadable 8-slice series."""
    monkeypatch.delenv("LUNG_STUDY_DIR", raising=False)
    r = tmp_path / "root"
    put(r / "study" / "alpha" / "one", pid="P1", name="Test^Alpha", series="1.1", date="20200101")
    put(r / "study" / "alpha2" / "two", pid="P1", name="Test^Alpha", series="1.2", date="20200111", study="9.9")
    put(r / "study" / "beta", pid="P2", name="Test^Beta", series="2.1", date="")
    shutil.copytree(dicom_series / "RIDER-TEST01" / "ct_test", r / "study" / "ct")
    _second(dicom_series, "RIDER-TEST01", series="ct_retest")
    (dicom_series / "RIDER-TEST01" / "ct_test" / ".DS_Store").write_text("x")  # a hidden file sorts first: the date reader skips it
    return r


def make(root, runs_dir, data):
    return TestClient(create_app(data_root=data, segmenter_factory=BallSegmenter, runs_dir=runs_dir, browse_root=root), base_url="http://localhost")


def by_name(j):
    return {p["name"]: p for p in j["patients"]}


def test_study_and_data_patients_in_one_reply(root, runs_dir, dicom_series, log_path):
    c = make(root, runs_dir, dicom_series)
    assert c.get("/api/patients").json() == {"folder": {"path": None, "from": None, "error": None}, "patients": c.get("/api/patients").json()["patients"]}
    r = c.post("/api/patients/folder", json={"path": "study"})
    assert r.status_code == 200
    j = c.get("/api/patients").json()
    assert j["folder"] == {"path": "study", "from": "panel", "error": None} and r.json() == j
    p = by_name(j)
    alpha = p["Test, Alpha"]
    assert alpha["source"] == "study" and re.fullmatch(r"[0-9a-f]{8}", alpha["key"]) and "P1" not in alpha["key"]
    assert [(s["timepoint"], s["date"], s["day"]) for s in alpha["scans"]] == [("Baseline", "2020-01-01", 0), ("Follow-up", "2020-01-11", 10)]
    s = alpha["scans"][0]
    assert F_ID.fullmatch(s["id"]) and s["label"] == "Series 3 · B30f · 1.25 mm · 2 images" and s["slice_mm"] == 1.25 and s["images"] == 2
    assert set(s) == {"id", "code", "timepoint", "date", "day", "label", "slice_mm", "images"} and s["code"] == s["id"]  # an F- id is already a code
    beta = p["Test, Beta"]["scans"]
    assert [(s["timepoint"], s["date"], s["day"]) for s in beta] == [("Undated", None, None)]
    data = p["RIDER-TEST01"]
    assert data["source"] == "data" and re.fullmatch(r"[0-9a-f]{8}", data["key"])
    assert all(re.fullmatch(r"D-[0-9a-f]{8}", s.pop("code")) for s in data["scans"])  # not a practice patient here: the hosted page sees D- codes
    assert data["scans"] == [{"id": "RIDER-TEST01_test", "timepoint": "Baseline", "date": "2001-02-03", "day": 0, "label": "Test scan", "slice_mm": None, "images": 8},
                             {"id": "RIDER-TEST01_retest", "timepoint": "Follow-up", "date": "2001-02-03", "day": 0, "label": "Retest scan", "slice_mm": None, "images": 8}]
    ev = [json.loads(l) for l in log_path.read_text().splitlines() if '"study_index"' in l]
    assert ev and set(ev[-1]) - {"t", "run", "commit", "action"} == {"patients", "scans", "files", "seconds"}
    assert (ev[0]["patients"], ev[0]["scans"], ev[0]["files"]) == (3, 4, 14)
    log = log_path.read_text()
    assert "Alpha" not in log and str(root) not in log and "study\"" not in log


def test_codes_are_stable_and_open_after_a_restart(root, runs_dir, dicom_series):
    c = make(root, runs_dir, dicom_series)
    c.post("/api/patients/folder", json={"path": str(root / "study")})  # an absolute path inside the root is kept relative
    ids = lambda c: sorted(s["id"] for p in c.get("/api/patients").json()["patients"] if p["source"] == "study" for s in p["scans"])
    first = ids(c)
    assert len(first) == 4 and first == ids(c)
    c2 = make(root, runs_dir, dicom_series)
    assert c2.get("/api/patients").json()["folder"] == {"path": "study", "from": "panel", "error": None} and ids(c2) == first
    ct = next(s["id"] for p in c2.get("/api/patients").json()["patients"] for s in p["scans"] if s["images"] == 8 and p["source"] == "study")
    assert c2.get(f"/api/scans/{ct}").json()["shape"] == [8, 64, 64]
    assert len(c2.get(f"/api/scans/{ct}/slices/3").content) == 64 * 64 * 2


def test_names_go_only_to_the_engines_own_page(root, runs_dir, dicom_series):
    c = make(root, runs_dir, dicom_series)
    c.post("/api/patients/folder", json={"path": "study"})
    for r in (c.get("/api/patients", headers=HOSTED), c.post("/api/patients/folder", json={"path": "study"}, headers=HOSTED),
              c.options("/api/patients", headers={**HOSTED, "Access-Control-Request-Method": "GET"}),
              c.get("/api/patients", headers={"Origin": "http://localhost:4173", "Sec-Fetch-Site": "same-site"})):
        assert r.status_code == 403 and "access-control-allow-origin" not in r.headers
        assert "Alpha" not in r.text and "RIDER" not in r.text and "study" not in r.text
    assert c.get("/api/patients", headers={"Origin": "http://localhost", "Sec-Fetch-Site": "same-origin"}).status_code == 200


def test_lung_study_dir_wins_and_post_is_409(root, runs_dir, dicom_series, monkeypatch):
    c = make(root, runs_dir, dicom_series)
    c.post("/api/patients/folder", json={"path": "study/beta"})
    monkeypatch.setenv("LUNG_STUDY_DIR", str(root / "study"))
    c = make(root, runs_dir, dicom_series)
    j = c.get("/api/patients").json()
    assert j["folder"] == {"path": "study", "from": "LUNG_STUDY_DIR", "error": None} and "Test, Alpha" in by_name(j)
    r = c.post("/api/patients/folder", json={"path": "study/beta"})
    assert r.status_code == 409 and r.json()["detail"] == BY_ENV


@pytest.mark.parametrize("path,status", [("..", 400), ("/etc", 400), ("study/../..", 400), ("nope", 404)])
def test_a_folder_outside_the_browse_root_is_refused(root, runs_dir, dicom_series, path, status):
    c = make(root, runs_dir, dicom_series)
    r = c.post("/api/patients/folder", json={"path": path})
    assert r.status_code == status and (status != 400 or r.json()["detail"] == OUTSIDE)
    assert c.get("/api/patients").json()["folder"] == {"path": None, "from": None, "error": None}


def test_a_practice_server_numbers_the_tutorial_case_first(server_env, clock, dicom_series, runs_dir, monkeypatch):
    """The tutorial's case (app.TUTORIAL) is Practice patient 1 on a practice server, so the tour starts at the top of the list; the rest keep their order."""
    from lung_engine.app import TUTORIAL
    before = "RIDER-1000000000"  # sorts before the tutorial's id, as 18 of the 28 public patients do
    monkeypatch.setenv("LUNG_PRACTICE_PATIENTS", f"RIDER-TEST01,{before},{TUTORIAL}")
    _second(dicom_series, before)
    _second(dicom_series, TUTORIAL)
    j = server_make(dicom_series, runs_dir).get("/api/patients", headers={"Origin": ORIGIN, **A}).json()
    assert [(p["name"], p["key"]) for p in j["patients"]] == [("Practice patient 1", TUTORIAL), ("Practice patient 2", before), ("Practice patient 3", "RIDER-TEST01")]


def test_server_mode_lists_practice_patients_only(server_env, clock, dicom_series, runs_dir, monkeypatch):
    monkeypatch.setenv("LUNG_PRACTICE_PATIENTS", "RIDER-TEST01,RIDER-TEST00")
    _second(dicom_series, "RIDER-TEST00")
    _second(dicom_series, "RIDER-TEST01", series="ct_retest")
    _second(dicom_series, "Jane_Doe")
    srv = server_make(dicom_series, runs_dir)
    r = srv.get("/api/patients", headers={"Origin": ORIGIN, **A})
    assert r.status_code == 200 and r.headers["access-control-allow-origin"] == ORIGIN  # the guard is off: the names are public
    j = r.json()
    assert j["folder"] == {"path": None, "from": None, "error": None} and "Jane" not in r.text
    assert [(p["name"], p["key"], p["source"]) for p in j["patients"]] == [("Practice patient 1", "RIDER-TEST00", "data"), ("Practice patient 2", "RIDER-TEST01", "data")]
    assert [(s["id"], s["code"], s["timepoint"], s["date"], s["day"]) for s in j["patients"][1]["scans"]] == [
        ("RIDER-TEST01_test", "RIDER-TEST01_test", "Baseline", None, 0), ("RIDER-TEST01_retest", "RIDER-TEST01_retest", "Follow-up", None, 0)]  # the hosted page never gets a study date
    assert srv.post("/api/patients/folder", json={"path": ""}, headers=A).status_code == 404
    r = srv.get("/api/patients")
    assert r.status_code == 401 and r.json() == {"detail": SIGN_IN}


def test_a_broken_data_link_is_listed_undated(root, runs_dir, dicom_series, tmp_path):
    (dicom_series / "RIDER-TEST02").mkdir()
    (dicom_series / "RIDER-TEST02" / "ct_test").symlink_to(tmp_path / "gone", target_is_directory=True)  # a half-done fetch
    r = make(root, runs_dir, dicom_series).get("/api/patients")
    assert r.status_code == 200 and by_name(r.json())["RIDER-TEST02"]["scans"][0] | {"id": None, "code": None} == {
        "id": None, "code": None, "timepoint": "Baseline", "date": None, "day": None, "label": "Test scan", "slice_mm": None, "images": 0}


GONE = "The study folder cannot be found. Choose it again with Change folder…"
UNREADABLE = "The study folder cannot be read. Choose it again with Change folder…"
HOME_ITSELF = "Choose a folder inside your home folder, not the home folder itself."
AREA_ITSELF = "Choose a folder inside the allowed area, not the whole area itself."


def retag(d, **tags):
    """Rewrite DICOM tags (sitk keys) in every file of folder d."""
    import SimpleITK as sitk
    for f in d.glob("*.dcm"):
        img = sitk.ReadImage(str(f))
        for k, v in tags.items():
            img.SetMetaData(k, v)
        w = sitk.ImageFileWriter(); w.KeepOriginalImageUIDOn(); w.SetFileName(str(f)); w.Execute(img)


def test_a_study_scan_carries_its_patient_day_and_timepoint_in_scan_info(root, runs_dir, dicom_series):
    """A measurement record links a follow-up to its baseline by study_code and day: the panel's patient, not the F- id.
    Its timepoint is the order of its study day among the patient's dated scans (Baseline 0, the first follow-up 1, a second series that day 1 too)."""
    for sub, date in (("base", "20010203"), ("later", "20010213"), ("later2", "20010213")):
        shutil.copytree(dicom_series / "RIDER-TEST01" / "ct_test", root / "study" / "jane" / sub)
        retag(root / "study" / "jane" / sub, **{"0010|0020": "P9", "0010|0010": "Doe^Jane", "0008|0020": date})
    retag(root / "study" / "jane" / "later2", **{"0020|000e": "1.2.826.0.1.3680043.8.498.2"})  # another series of the follow-up's study
    c = make(root, runs_dir, dicom_series)
    c.post("/api/patients/folder", json={"path": "study"})
    jane = by_name(c.get("/api/patients").json())["Doe, Jane"]
    assert [(s["timepoint"], s["day"]) for s in jane["scans"]] == [("Baseline", 0), ("Follow-up", 10), ("Follow-up", 10)]
    for c in (c, make(root, runs_dir, dicom_series)):  # also after a restart, before any GET /api/patients
        for s, n in zip(jane["scans"], (0, 1, 1)):
            for h in ({}, HOSTED):
                i = c.get(f"/api/scans/{s['id']}", headers=h).json()
                assert (i["study_code"], i["days_from_baseline"], i["timepoint"]) == (jane["key"], s["day"], n)
                assert "Jane" not in json.dumps(i) and ("study_date" in i) is (h == {})
    stored = json.loads((runs_dir / "study_scans.json").read_text())
    beta = by_name(c.get("/api/patients").json())["Test, Beta"]["scans"][0]
    assert stored[beta["id"]] == {"patient": "P2", "day": None, "timepoint": 0}  # Undated, and the patient's only scan: timepoint 0
    assert c.get(f"/api/scans/{beta['id']}", headers=HOSTED).json()["days_from_baseline"] is None  # undated: no day, never 0 (0 reads as "the same day")
    assert c.get("/api/scans/RIDER-TEST01_test").json()["timepoint"] is None  # a data-folder scan: the page's own test/retest rule


def test_an_undated_study_scan_never_shares_a_timepoint(root, runs_dir, dicom_series):
    """Anonymisation can blank the study date. An undated scan must not get timepoint 0 beside the Baseline: its Record would overwrite the
    Baseline cell in the Study table. It is numbered after the patient's dated days, in the panel's order."""
    put(root / "study" / "alpha3" / "three", pid="P1", name="Test^Alpha", series="1.3", date="", study="9.8")
    put(root / "study" / "beta2", pid="P2", name="Test^Beta", series="2.2", date="")
    c = make(root, runs_dir, dicom_series)
    c.post("/api/patients/folder", json={"path": "study"})
    j = by_name(c.get("/api/patients").json())
    stored = json.loads((runs_dir / "study_scans.json").read_text())
    tps = lambda name: [stored[s["id"]]["timepoint"] for s in j[name]["scans"]]
    assert [s["timepoint"] for s in j["Test, Alpha"]["scans"]] == ["Baseline", "Follow-up", "Undated"]
    assert tps("Test, Alpha") == [0, 1, 2]  # after the two dated days
    assert tps("Test, Beta") == [0, 1]  # all undated: each its own, in the panel's order


@pytest.mark.parametrize("how,line", [("gone", GONE), ("locked", UNREADABLE)])
def test_a_missing_or_unreadable_study_folder_still_lists_the_data_patients(root, runs_dir, dicom_series, how, line):
    c = make(root, runs_dir, dicom_series)
    c.post("/api/patients/folder", json={"path": "study"})
    if how == "gone":
        (root / "study").rename(root / "moved")
    else:
        (root / "study").chmod(0)
    try:
        r = c.get("/api/patients")
    finally:
        (root / "study").exists() and (root / "study").chmod(0o755)
    assert r.status_code == 200 and r.json()["folder"] == {"path": "study", "from": "panel", "error": line}
    assert [(p["name"], p["source"]) for p in r.json()["patients"]] == [("RIDER-TEST01", "data")]


def test_the_browse_root_itself_is_refused(root, runs_dir, dicom_series, monkeypatch):
    monkeypatch.delenv("LUNG_BROWSE_ROOT", raising=False)
    c = make(root, runs_dir, dicom_series)
    for path in ("", str(root), "study/.."):
        r = c.post("/api/patients/folder", json={"path": path})
        assert r.status_code == 400 and r.json()["detail"] == AREA_ITSELF  # the test's browse root is not the home folder
    monkeypatch.setenv("LUNG_STUDY_DIR", str(root))
    j = make(root, runs_dir, dicom_series).get("/api/patients").json()
    assert j["folder"]["error"] == AREA_ITSELF and [p["source"] for p in j["patients"]] == ["data"]
    monkeypatch.setattr(app_module.Path, "home", lambda: root)
    assert make(None, runs_dir, dicom_series).get("/api/patients").json()["folder"]["error"] == HOME_ITSELF


CAP5 = "The study folder holds more than 5 files. Choose a smaller folder."


def count_reads(monkeypatch):
    calls = []
    real = study_index.dcmread
    monkeypatch.setattr(study_index, "dcmread", lambda *a, **k: (calls.append(1), real(*a, **k))[1])
    return calls


def test_a_study_folder_over_the_file_cap_is_refused_and_the_old_one_stays(root, runs_dir, dicom_series, monkeypatch):
    monkeypatch.setattr(app_module, "MAX_STUDY_FILES", 5)
    c = make(root, runs_dir, dicom_series)
    assert c.post("/api/patients/folder", json={"path": "study/beta"}).status_code == 200  # 2 files: under the cap
    calls = count_reads(monkeypatch)
    r = c.post("/api/patients/folder", json={"path": "study"})
    assert r.status_code == 400 and r.json()["detail"] == CAP5 and len(calls) == 5
    assert json.loads((runs_dir / "study_folder.json").read_text()) == {"path": "study/beta"}
    assert c.get("/api/patients").json()["folder"] == {"path": "study/beta", "from": "panel", "error": None}


def test_lung_study_dir_over_the_cap_reads_the_headers_once(root, runs_dir, dicom_series, monkeypatch):
    monkeypatch.setattr(app_module, "MAX_STUDY_FILES", 5)
    monkeypatch.setenv("LUNG_STUDY_DIR", "study")
    c = make(root, runs_dir, dicom_series)
    calls = count_reads(monkeypatch)
    for n in (5, 5):  # the second GET answers at once: no header read
        j = c.get("/api/patients").json()
        assert j["folder"]["error"] == CAP5 and [p["source"] for p in j["patients"]] == ["data"] and len(calls) == n
    assert not (runs_dir / "study_index.json").exists()


def test_one_bad_header_never_breaks_the_reply(root, runs_dir, dicom_series):
    import pydicom
    from pydicom.dataelem import RawDataElement
    f = root / "study" / "beta" / "bad.dcm"
    dcm(f, pid="P2", name="Test^Beta", series="2.9")
    ds = pydicom.dcmread(f)
    for tag, vr, v in ((0x00180050, "DS", b"abcd"), (0x00200011, "IS", b"x ")):  # as a scanner wrote them: pydicom refuses to set these
        ds._dict[tag] = RawDataElement(tag, vr, len(v), v, 0, False, True)
    ds.save_as(f)
    c = make(root, runs_dir, dicom_series)
    r = c.post("/api/patients/folder", json={"path": "study"})
    assert r.status_code == 200 and r.json()["folder"]["error"] is None
    bad = next(s for s in by_name(r.json())["Test, Beta"]["scans"] if s["images"] == 1)
    assert (bad["slice_mm"], bad["label"]) == (None, "B30f · 1 images")


def test_an_index_failure_still_lists_the_data_patients(root, runs_dir, dicom_series, monkeypatch, log_path):
    c = make(root, runs_dir, dicom_series)
    c.post("/api/patients/folder", json={"path": "study"})
    def boom(*a, **k):
        raise KeyError(str(root / "study" / "Doe^Jane"))
    monkeypatch.setattr(app_module, "index_folder", boom)
    j = c.get("/api/patients").json()
    assert j["folder"] == {"path": "study", "from": "panel", "error": "The study folder could not be read."}
    assert [p["source"] for p in j["patients"]] == ["data"]
    assert "KeyError" in log_path.read_text() and "Jane" not in log_path.read_text() and str(root) not in log_path.read_text()


def test_a_code_from_the_folder_browser_is_reused(root, runs_dir, dicom_series):
    c = make(root, runs_dir, dicom_series)
    uid = c.get("/api/folders", params={"path": "study/ct"}).json()["series"][0]["uid_hash"]
    sid = c.post("/api/folders/open", json={"path": "study/ct", "series": uid}).json()["id"]
    j = c.post("/api/patients/folder", json={"path": "study"}).json()
    assert sid in [s["id"] for p in j["patients"] for s in p["scans"]]
    assert len(json.loads((runs_dir / "folder_scans.json").read_text())) == 4  # 4 study series, the opened one not twice


def test_a_missing_lung_study_dir_points_to_the_variable_not_to_change_folder(root, runs_dir, dicom_series, monkeypatch):
    monkeypatch.setenv("LUNG_STUDY_DIR", "gone")  # Change folder… is not offered then (POST answers 409)
    j = make(root, runs_dir, dicom_series).get("/api/patients").json()
    assert j["folder"] == {"path": "gone", "from": "LUNG_STUDY_DIR", "error": "The study folder cannot be found. Check LUNG_STUDY_DIR on this computer."}


def test_folder_scans_reach_a_cross_origin_caller_sorted_by_code(root, runs_dir, dicom_series):
    runs_dir.mkdir()
    (runs_dir / "folder_scans.json").write_text(json.dumps({"F-ffffffff": [str(root / "a"), "x"], "F-00000000": [str(root / "b"), "y"], "F-7777aaaa": [str(root / "c"), "z"]}))
    rows = make(root, runs_dir, dicom_series).get("/api/scans", headers=HOSTED).json()
    assert [r["id"] for r in rows if r["id"].startswith("F-")] == ["F-00000000", "F-7777aaaa", "F-ffffffff"]  # the order gives nothing away


@pytest.mark.parametrize("how", ["index", "save"])
def test_any_post_failure_is_a_plain_line(root, runs_dir, dicom_series, monkeypatch, log_path, how):
    c = make(root, runs_dir, dicom_series)
    c.post("/api/patients/folder", json={"path": "study/beta"})
    def boom(*a, **k):
        raise (KeyError if how == "index" else PermissionError)(str(root / "study" / "Doe^Jane"))
    monkeypatch.setattr(app_module, "index_folder", boom) if how == "index" else monkeypatch.setattr(app_module.os, "replace", boom)
    r = c.post("/api/patients/folder", json={"path": "study"})
    assert r.status_code == 500 and r.json() == {"detail": "The study folder could not be read."} and "Jane" not in r.text and str(root) not in r.text
    log = log_path.read_text()
    assert ("KeyError" if how == "index" else "PermissionError") in log and "Jane" not in log and str(root) not in log
    assert json.loads((runs_dir / "study_folder.json").read_text()) == {"path": "study/beta"}


def test_a_bad_path_is_a_plain_line(root, runs_dir, dicom_series):
    r = make(root, runs_dir, dicom_series).post("/api/patients/folder", json={"path": "study\x00Doe"})
    assert 400 <= r.status_code < 600 and set(r.json()) == {"detail"} and "Doe" not in r.text and str(root) not in r.text
