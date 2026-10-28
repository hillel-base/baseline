"""The engine serves /picker, the Patients panel alone, for the hosted page's frame; the name-bearing JSON routes stay the engine's own page's."""
import re

import pytest
from fastapi.testclient import TestClient

from conftest import BallSegmenter
from test_api import _second
from test_server_mode import A, clock, make as server_make, server_env  # noqa: F401 (fixtures)
from lung_engine import app as app_module
from lung_engine.app import create_app

HOSTED = "https://lung-measure.base44.app"
FRAME = {"Sec-Fetch-Site": "cross-site", "Sec-Fetch-Dest": "iframe", "Sec-Fetch-Mode": "navigate"}  # what Chrome sends for the hosted page's <iframe src=…/picker>
FETCH = {"Origin": HOSTED, "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Dest": "empty", "Sec-Fetch-Mode": "cors"}  # a script's fetch on the hosted page
PAGE = '<!doctype html><meta name="lung-parent" content="__LUNG_PARENT__"><title>Patients</title><div id="root"></div>'


@pytest.fixture
def built(tmp_path, monkeypatch):
    """A built page with its picker.html, where the engine looks for it (web/dist under the repo)."""
    repo = tmp_path / "repo"
    (repo / "web" / "dist").mkdir(parents=True)
    (repo / "web" / "dist" / "picker.html").write_text(PAGE)
    (repo / "web" / "dist" / "index.html").write_text("<!doctype html><title>Baseline</title>")
    monkeypatch.setattr(app_module, "REPO", repo)
    monkeypatch.delenv("LUNG_ALLOWED_ORIGIN", raising=False)
    monkeypatch.delenv("LUNG_STUDY_DIR", raising=False)
    return repo


def make(data, runs_dir, browse_root=None):
    return TestClient(create_app(data_root=data, segmenter_factory=BallSegmenter, runs_dir=runs_dir, browse_root=browse_root), base_url="http://localhost:8000")


def test_picker_headers_for_the_hosted_frame(built, dicom_series, runs_dir):
    c = make(dicom_series, runs_dir)
    for h in (FRAME, {}):  # the hosted page's frame, and the engine's own page
        r = c.get("/picker", headers=h)
        assert r.status_code == 200 and r.headers["content-type"].startswith("text/html")
        assert r.headers["content-security-policy"] == f"frame-ancestors {HOSTED}"
        assert (r.headers["referrer-policy"], r.headers["x-content-type-options"], r.headers["cache-control"]) == ("no-referrer", "nosniff", "no-store")
        assert "access-control-allow-origin" not in r.headers
        assert f'<meta name="lung-parent" content="{HOSTED}">' in r.text  # the frame posts to this exact origin, never "*"


def test_frame_ancestors_is_the_allowed_origin(built, dicom_series, runs_dir, monkeypatch):
    monkeypatch.setenv("LUNG_ALLOWED_ORIGIN", "http://localhost:4173")
    r = make(dicom_series, runs_dir).get("/picker", headers=FRAME)
    assert r.headers["content-security-policy"] == "frame-ancestors http://localhost:4173" and 'content="http://localhost:4173"' in r.text
    monkeypatch.setenv("LUNG_ALLOWED_ORIGIN", "")  # CORS off: no page may frame it
    assert make(dicom_series, runs_dir).get("/picker", headers=FRAME).headers["content-security-policy"] == "frame-ancestors 'none'"


@pytest.mark.parametrize("dest", ["document", "script", "image", "empty", "object", "embed"])
def test_another_site_may_only_frame_the_picker(built, dicom_series, runs_dir, dest):
    r = make(dicom_series, runs_dir).get("/picker", headers={**FRAME, "Sec-Fetch-Dest": dest})
    assert r.status_code == 403 and "access-control-allow-origin" not in r.headers and "lung-parent" not in r.text


def test_the_guard_still_refuses_a_cross_site_fetch_of_the_patients(built, dicom_series, runs_dir):
    c = make(dicom_series, runs_dir)
    for h in (FETCH, FRAME, {"Sec-Fetch-Site": "same-site", "Sec-Fetch-Dest": "iframe"}):  # an iframe pointed at the JSON is no exception: only /picker is
        r = c.get("/api/patients", headers=h)
        assert r.status_code == 403 and "access-control-allow-origin" not in r.headers and "RIDER" not in r.text
    r = c.get("/api/patients", headers={"Sec-Fetch-Site": "same-origin", "Sec-Fetch-Dest": "empty"})  # the frame's own fetch
    assert r.status_code == 200 and "RIDER-TEST01" in r.text


@pytest.mark.parametrize("host", ["evil.example:8000", "localhost.evil.example:8000", "127.0.0.1.nip.io:8000", "[::1]:8000", ""])
def test_a_foreign_host_is_refused_dns_rebinding(built, dicom_series, runs_dir, tmp_path, host):
    """TrustedHostMiddleware already refuses any Host name but localhost and 127.0.0.1; this keeps it so on every name-bearing route."""
    (tmp_path / "browse" / "study").mkdir(parents=True)
    c = make(dicom_series, runs_dir, tmp_path / "browse")
    for m, path in (("GET", "/picker"), ("GET", "/api/patients"), ("GET", "/api/folders"), ("POST", "/api/patients/folder"), ("POST", "/api/folders/open")):
        r = c.request(m, path, headers={"host": host}, json={"path": "study", "series": "x"})
        assert r.status_code == 400 and r.text == "Invalid host header", (path, host)
    for host in ("localhost:8000", "127.0.0.1:8000"):
        assert c.get("/picker", headers={"host": host}).status_code == 200 and c.get("/api/patients", headers={"host": host}).status_code == 200


def test_the_json_routes_the_frame_calls_are_same_origin_only(built, dicom_series, runs_dir, tmp_path):
    (tmp_path / "browse" / "study").mkdir(parents=True)
    c = make(dicom_series, runs_dir, tmp_path / "browse")
    for r in (c.get("/api/patients"), c.get("/api/folders"), c.post("/api/patients/folder", json={"path": "study"}), c.post("/api/folders/open", json={"path": "study", "series": "x"})):
        assert r.headers["cross-origin-resource-policy"] == "same-origin", r.request.url  # an <img> or <script> on another page cannot load them
    assert "cross-origin-resource-policy" not in c.get("/api/scans").headers  # the hosted page reads the scan list (codes) by CORS


def test_each_scan_has_the_code_the_hosted_page_sees(built, dicom_series, runs_dir, monkeypatch):
    monkeypatch.setenv("LUNG_PRACTICE_PATIENTS", "RIDER-TEST01")
    _second(dicom_series, "Jane_Doe")
    c = make(dicom_series, runs_dir)
    scans = [s for p in c.get("/api/patients").json()["patients"] for s in p["scans"]]
    hosted = {s["id"] for s in c.get("/api/scans", headers=FETCH).json()}
    assert {s["code"] for s in scans} <= hosted  # shown() as if the caller were the hosted page
    by = {s["id"]: s["code"] for s in scans}
    assert by["RIDER-TEST01_test"] == "RIDER-TEST01_test"  # a public practice id stays
    assert re.fullmatch(r"D-[0-9a-f]{8}", by["Jane_Doe_test"])  # a data-folder name becomes its D- code
    info = c.get(f"/api/scans/{by['Jane_Doe_test']}", headers=FETCH).json()
    assert info["id"] == by["Jane_Doe_test"] and "Jane" not in str(info)


@pytest.mark.parametrize("path", ["/", "/index.html", "/picker.html", "/Picker.html", "/picker.HTML", "/PICKER", "/picker/", "/api/scans"])
def test_every_other_answer_may_be_framed_by_no_page(built, dicom_series, runs_dir, path):
    """Only /picker, exactly, names the hosted page; the engine's own page and any path variant of picker.html (a case-insensitive disk serves it) say 'none'."""
    c = make(dicom_series, runs_dir)
    for h in (FRAME, {}):
        r = c.get(path, headers=h)
        assert r.headers["content-security-policy"] == "frame-ancestors 'none'", (path, r.status_code)
        assert HOSTED not in r.text  # no variant learns the hosted page's origin: it would post to no one


def test_info_says_this_engine_serves_the_picker(built, dicom_series, runs_dir, server_env, clock, monkeypatch):
    srv = server_make(dicom_series, runs_dir)
    assert "picker" not in srv.get("/api/info", headers=A).json()  # a practice server shows its own panel, no frame
    monkeypatch.delenv("LUNG_SERVER")
    assert make(dicom_series, runs_dir).get("/api/info", headers=FETCH).json()["picker"] is True  # the hosted page shows the frame only then


def test_server_mode_serves_no_picker(server_env, clock, built, dicom_series, runs_dir):
    srv = server_make(dicom_series, runs_dir)
    assert srv.get("/picker", headers=A).status_code == 404


@pytest.mark.parametrize("origin", ["*", "https://*.base44.app"])
def test_a_wildcard_allowed_origin_is_refused_in_local_mode_too(origin, dicom_series, runs_dir, built, monkeypatch):
    # the allowed origin becomes frame-ancestors for /picker and the frame's postMessage target: never "*"
    monkeypatch.setenv("LUNG_ALLOWED_ORIGIN", origin)
    with pytest.raises(ValueError, match="one exact address"):
        create_app(data_root=dicom_series, segmenter_factory=BallSegmenter, runs_dir=runs_dir)


def test_info_says_picker_only_when_the_picker_page_is_built(dicom_series, runs_dir, tmp_path, monkeypatch, clock):
    # An engine from a clean checkout has no web/dist: /picker answers 404, so the hosted page must not wait 8 s on a broken frame.
    monkeypatch.setattr(app_module, "REPO", tmp_path / "unbuilt")
    monkeypatch.delenv("LUNG_ALLOWED_ORIGIN", raising=False)
    c = make(dicom_series, runs_dir)
    assert c.get("/picker").status_code == 404
    assert c.get("/api/info", headers=FETCH).json()["picker"] is False
    # A practice server never uses the frame (the page shows its own Patients panel from /api/patients) and its image has no web/dist:
    # its info has no "picker" at all, built page or not, so this change cannot turn anything off there.
    monkeypatch.setenv("LUNG_SERVER", "1"); monkeypatch.setenv("LUNG_PRACTICE_PATIENTS", "RIDER-TEST01"); monkeypatch.delenv("SPACE_HOST", raising=False)
    srv = server_make(dicom_series, runs_dir)
    assert "picker" not in srv.get("/api/info", headers=A).json() and srv.get("/api/patients", headers=A).status_code == 200
