"""Server mode (the practice server): Base44 sign-in on every call, one user at a time, practice scans only."""
import http.server
import json
import shutil
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient

from conftest import BallSegmenter
from lung_engine import app as app_module, signin
from lung_engine.app import create_app

ORIGIN = "https://lung-measure.base44.app"
SIGN_IN = "Sign in to use the practice server."
BUSY = "Someone else is using the practice server. It is free again after 10 minutes without use."
USERS = {"good-a": {"id": "a", "email": "user-a", "role": "user"}, "good-b": {"id": "b", "email": "user-b", "role": "user"}}
A, B = {"Authorization": "Bearer good-a"}, {"Authorization": "Bearer good-b"}
SCAN = "/api/scans/RIDER-TEST01_test"
NODULES = SCAN + "/nodules"
CLICK = dict(z=4, y=32, x=32)


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


@pytest.fixture
def clock(monkeypatch):
    c = Clock()
    monkeypatch.setattr(signin, "now", c)
    return c


@pytest.fixture
def server_env(monkeypatch):
    monkeypatch.setenv("LUNG_SERVER", "1")
    monkeypatch.setenv("LUNG_PRACTICE_PATIENTS", "RIDER-TEST01")
    monkeypatch.delenv("LUNG_ALLOWED_ORIGIN", raising=False)
    monkeypatch.delenv("LUNG_IDLE_MIN", raising=False)
    monkeypatch.delenv("SPACE_HOST", raising=False)


def make(dicom_series, runs_dir, verify=USERS.get):
    return TestClient(create_app(data_root=dicom_series, segmenter_factory=BallSegmenter, runs_dir=runs_dir, verify_user=verify),
                      base_url="http://localhost")


@pytest.fixture
def srv(server_env, clock, dicom_series, runs_dir):
    return make(dicom_series, runs_dir)


def test_info_needs_no_token_and_reports_busy(srv, clock):
    i = srv.get("/api/info").json()
    assert i["server"] == {"busy": False, "idle_min": 10} and i["commit"] and "model" not in i  # no sign-in: version and busy only
    assert srv.get("/api/scans", headers=A).status_code == 200
    assert srv.get("/api/info").json()["server"]["busy"] is True
    assert srv.get("/api/info", headers=B).json()["server"]["busy"] is True
    assert srv.get("/api/info", headers=A).json()["server"]["busy"] is False  # the holder itself, on a reload of the page
    clock.t += 600
    assert srv.get("/api/info").json()["server"]["busy"] is False


@pytest.mark.parametrize("headers", [{}, {"Authorization": "Bearer made-up"}, {"Authorization": "Bearer "}, {"Authorization": "good-a"},
                                     {"Authorization": "Basic good-a"}])
def test_no_token_or_refused_token_is_401_with_text(srv, runs_dir, headers):
    calls = [srv.get("/api/scans", headers=headers), srv.get(SCAN, headers=headers),
             srv.post(NODULES, json=CLICK, headers=headers),
             srv.post("/api/nodule/clicks", json=dict(scan="RIDER-TEST01_test", nodule=1, positive=True, **CLICK), headers=headers),
             srv.post("/api/session/release", headers=headers), srv.post("/api/slice", json=dict(scan="RIDER-TEST01_test", z=4), headers=headers)]
    for r in calls:
        assert r.status_code == 401 and r.json() == {"detail": SIGN_IN}
    r = srv.get("/api/scans", headers={"Origin": ORIGIN, **headers})
    assert r.status_code == 401 and r.headers["access-control-allow-origin"] == ORIGIN  # the page can read it
    assert srv.get("/api/info", headers=headers).json()["server"]["busy"] is False  # a refused call takes no hold
    log = runs_dir / "events.jsonl"
    assert not log.exists() or "nodule_start" not in log.read_text()


def test_token_valid_earlier_is_refused_once_its_answer_expires(server_env, clock, dicom_series, runs_dir):
    ok = {"good-a": True}
    c = make(dicom_series, runs_dir, signin.Verifier(lambda t: USERS[t] if ok.get(t) else None))
    assert c.get("/api/scans", headers=A).status_code == 200
    ok["good-a"] = False  # Base44 now refuses it (signed out)
    clock.t += 299
    assert c.get("/api/scans", headers=A).status_code == 200  # the kept answer, at most 5 minutes old
    clock.t += 2
    r = c.post(NODULES, json=CLICK, headers=A)
    assert r.status_code == 401 and r.json() == {"detail": SIGN_IN}


def test_valid_token_reaches_practice_scans_only(srv, dicom_series):
    shutil.copytree(dicom_series / "RIDER-TEST01", dicom_series / "RIDER-TEST02")
    assert [s["patient"] for s in srv.get("/api/scans", headers=A).json()] == ["RIDER-TEST01"]
    assert srv.get(SCAN, headers=A).status_code == 200
    other = "/api/scans/RIDER-TEST02_test"
    for r in (srv.get(other, headers=A), srv.get(other + "/slices/4", headers=A), srv.post("/api/slice", json=dict(scan="RIDER-TEST02_test", z=4), headers=A),
              srv.post(other + "/nodules", json=CLICK, headers=A),
              srv.get(SCAN + "/map?from=RIDER-TEST02_test&z=4&y=32&x=32", headers=A),
              srv.get(other + "/map?from=RIDER-TEST01_test&z=4&y=32&x=32", headers=A),
              srv.post("/api/events", json={"action": "zoom", "scan": "RIDER-TEST02_test"}, headers=A),
              srv.get("/api/scans/F-0123abcd", headers=A)):
        assert r.status_code == 404
    assert srv.post(NODULES, json=CLICK, headers=A).status_code == 200
    s = srv.post("/api/slice", json=dict(scan="RIDER-TEST01_test", z=4), headers=A)
    assert s.status_code == 200 and s.content == srv.get(SCAN + "/slices/4", headers=A).content


def test_practice_patients_default_to_the_28_public_patients(server_env, clock, dicom_series, runs_dir, monkeypatch):
    monkeypatch.delenv("LUNG_PRACTICE_PATIENTS")
    for p in ("RIDER-2541949645", "RIDER-1286684383", "RIDER-2619750334", "RIDER-1867199702", "RIDER-1129164940", "RIDER-1234567890"):
        shutil.copytree(dicom_series / "RIDER-TEST01", dicom_series / p)
    c = make(dicom_series, runs_dir)
    assert {s["patient"] for s in c.get("/api/scans", headers=A).json()} == {"RIDER-2541949645", "RIDER-1286684383", "RIDER-2619750334", "RIDER-1867199702", "RIDER-1129164940"}
    assert c.get(SCAN, headers=A).status_code == 404


def test_second_user_gets_423_until_idle(srv, clock, runs_dir):
    assert srv.get("/api/scans", headers=A).status_code == 200
    for r in (srv.get("/api/scans", headers=B), srv.post(NODULES, json=CLICK, headers=B), srv.post("/api/session/release", headers=B)):
        assert r.status_code == 423 and r.json() == {"detail": BUSY}
    r = srv.get("/api/scans", headers={"Origin": ORIGIN, **B})
    assert r.status_code == 423 and r.headers["access-control-allow-origin"] == ORIGIN
    clock.t += 9 * 60
    assert srv.get(SCAN, headers=A).status_code == 200  # refreshes the hold
    clock.t += 9 * 60
    assert srv.get("/api/scans", headers=B).status_code == 423
    clock.t += 60  # 10 minutes since A's last call
    assert srv.get("/api/scans", headers=B).status_code == 200
    assert srv.get("/api/scans", headers=A).status_code == 423
    refused = [json.loads(l) for l in (runs_dir / "events.jsonl").read_text().splitlines() if '"busy_refused"' in l]
    assert refused and all(set(e) == {"t", "run", "commit", "action", "path"} for e in refused)


def test_idle_minutes_come_from_the_setting(server_env, clock, dicom_series, runs_dir, monkeypatch):
    monkeypatch.setenv("LUNG_IDLE_MIN", "3")
    c = make(dicom_series, runs_dir)
    assert c.get("/api/info").json()["server"]["idle_min"] == 3
    c.get("/api/scans", headers=A)
    assert "after 3 minutes" in c.get("/api/scans", headers=B).json()["detail"]
    clock.t += 180
    assert c.get("/api/scans", headers=B).status_code == 200


def test_release_frees_at_once(srv):
    assert srv.get("/api/scans", headers=A).status_code == 200
    r = srv.post("/api/session/release", headers=A)
    assert r.status_code == 204 and not r.content
    assert srv.get("/api/info").json()["server"]["busy"] is False
    assert srv.get("/api/scans", headers=B).status_code == 200


@pytest.fixture
def with_dist(tmp_path, monkeypatch):  # a built page, as after ./lung.sh setup with Node
    (tmp_path / "repo" / "web" / "dist").mkdir(parents=True)
    (tmp_path / "repo" / "web" / "dist" / "index.html").write_text("<html>page</html>")
    monkeypatch.setattr(app_module, "REPO", tmp_path / "repo")


def test_folder_routes_are_404_in_server_mode(server_env, clock, dicom_series, runs_dir, with_dist):
    srv = make(dicom_series, runs_dir)
    assert srv.get("/api/folders", headers=A).status_code == 404
    assert srv.post("/api/folders/open", json={"path": "", "series": "x"}, headers=A).status_code == 404
    assert srv.get("/index.html", headers=A).status_code == 404  # no page from the server


HOME = "OK"


def test_home_answers_the_startup_check_without_a_token(server_env, clock, dicom_series, runs_dir, with_dist):
    srv = make(dicom_series, runs_dir)
    r = srv.get("/")
    assert r.status_code == 200 and r.text == HOME and r.headers["content-type"].startswith("text/plain")
    r = srv.head("/")
    assert r.status_code == 200 and not r.content
    assert srv.get("/api/info").json()["server"]["busy"] is False  # takes no hold
    for path in ("/index.html", "/api/scans", "/docs", "/openapi.json"):
        assert srv.get(path).status_code == 401


@pytest.mark.parametrize("method", ["OPTIONS", "HEAD"])
@pytest.mark.parametrize("path", ["/api/scans", SCAN, SCAN + "/slices/4", "/api/folders"])
def test_options_and_head_on_protected_routes_give_no_data(srv, method, path):
    r = srv.request(method, path, headers={"Origin": ORIGIN})  # OPTIONS without Access-Control-Request-Method: not a preflight
    assert not 200 <= r.status_code < 300 and b"RIDER" not in r.content


def test_local_mode_is_unchanged_without_LUNG_SERVER(dicom_series, runs_dir, monkeypatch):
    monkeypatch.delenv("LUNG_SERVER", raising=False)
    monkeypatch.delenv("SPACE_HOST", raising=False)
    monkeypatch.setenv("LUNG_BROWSE_ROOT", str(dicom_series))
    c = make(dicom_series, runs_dir, verify=lambda t: None)  # a refusing verifier is never asked
    assert set(c.get("/api/info").json()) == {"commit", "model", "width_method", "device", "picker"}
    assert c.get("/api/scans").status_code == 200 and c.post(NODULES, json=CLICK).status_code == 200
    assert c.get("/api/folders").status_code == 200
    assert c.post("/api/session/release").status_code in (404, 405)
    pre = c.options("/api/scans", headers={"Origin": ORIGIN, "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization"})
    assert pre.status_code == 400  # Authorization is allowed only in server mode
    assert c.get("/api/scans", headers={"Host": "x.hf.space"}).status_code == 400
    monkeypatch.setenv("SPACE_HOST", "x.hf.space")  # a Space started without LUNG_SERVER=1 must not serve the local engine
    assert make(dicom_series, runs_dir).get("/api/scans", headers={"Host": "x.hf.space"}).status_code == 400


def test_floods_of_unknown_tokens_do_not_slow_the_holder(server_env, clock, dicom_series, runs_dir):
    gate = threading.Event()

    def check(token):  # Base44 answers known tokens at once and hangs on the rest
        if token in USERS:
            return USERS[token]
        gate.wait(10)

    app = create_app(data_root=dicom_series, segmenter_factory=BallSegmenter, runs_dir=runs_dir, verify_user=signin.Verifier(check))
    with TestClient(app, base_url="http://localhost") as c, ThreadPoolExecutor(70) as pool:
        assert c.get("/api/scans", headers=A).status_code == 200  # A holds the engine; its answer is kept
        junk = [pool.submit(c.get, "/api/scans", headers={"Authorization": f"Bearer junk-{i}"}) for i in range(60)]
        time.sleep(0.5)  # the misses reach the check and wait there
        try:
            t0 = time.monotonic()
            holder = [pool.submit(c.get, path, headers=A) for path in (SCAN, "/api/info")]
            codes = [f.result(timeout=3).status_code for f in holder]
            seconds = time.monotonic() - t0
        finally:
            gate.set()
        assert codes == [200, 200] and seconds < 1.5
        assert {f.result().status_code for f in junk} == {401}


def test_token_is_never_logged(srv, clock, runs_dir):
    srv.get("/api/scans", headers={"Authorization": "Bearer made-up-secret"})
    srv.post(NODULES, json=CLICK, headers=A)
    srv.post("/api/nodule/record", json=dict(scan="RIDER-TEST01_test", nodule=1), headers=A)
    srv.get("/api/scans", headers=B)
    clock.t += 600
    srv.get(SCAN, headers=B)
    log = (runs_dir / "events.jsonl").read_text()
    assert "nodule_start" in log and "busy_refused" in log
    for secret in ("good-a", "good-b", "made-up-secret", "user-a", "user-b"):
        assert secret not in log


def test_space_host_is_trusted(server_env, clock, dicom_series, runs_dir, monkeypatch):
    monkeypatch.setenv("SPACE_HOST", "owner-lung-practice.hf.space")
    c = make(dicom_series, runs_dir)
    assert c.get("/api/info", headers={"Host": "owner-lung-practice.hf.space"}).status_code == 200
    assert c.get("/api/info", headers={"Host": "evil.example"}).status_code == 400
    assert c.get("/api/scans", headers={"Host": "evil.example", **A}).status_code == 400  # the host check comes before the sign-in
    assert c.get("/api/info").status_code == 200  # localhost still works


def test_slice_route_preflight_is_kept_ten_minutes_or_more(srv):
    """One preflight covers every slice: the browser keeps it max-age seconds per URL (Chrome caps it at 2 hours)."""
    r = srv.options("/api/slice", headers={"Origin": ORIGIN, "Access-Control-Request-Method": "POST",
                                           "Access-Control-Request-Headers": "authorization, content-type"})
    assert r.status_code == 200 and r.headers["access-control-allow-origin"] == ORIGIN
    assert int(r.headers["access-control-max-age"]) >= 600
    assert "POST" in r.headers["access-control-allow-methods"]
    assert {"authorization", "content-type"} <= {h.strip().lower() for h in r.headers["access-control-allow-headers"].split(",")}
    assert srv.get("/api/info").json()["server"]["busy"] is False  # a preflight takes no hold


def test_authorization_header_allowed_in_cors_preflight(srv):
    r = srv.options("/api/scans", headers={"Origin": ORIGIN, "Access-Control-Request-Method": "GET",
                                          "Access-Control-Request-Headers": "authorization, content-type"})
    assert r.status_code == 200 and r.headers["access-control-allow-origin"] == ORIGIN
    assert "Authorization" in r.headers["access-control-allow-headers"]
    assert srv.options("/api/scans", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "GET"}).status_code == 400


# The Verifier and the Base44 check


def test_verifier_keeps_a_valid_answer_by_hash_only(clock):
    calls = []
    v = signin.Verifier(lambda t: calls.append(t) or {"id": "a"})
    assert v("tok") == v("tok") == {"id": "a"} and calls == ["tok"]
    assert "tok" not in json.dumps(list(v.cache)) and all(len(k) == 64 for k in v.cache)
    assert signin.allowed({"id": "a"}) is True


def test_verifier_never_keeps_a_refused_answer(clock):
    calls = []
    v = signin.Verifier(lambda t: calls.append(t) and None)
    assert v("bad") is None and v("bad") is None and calls == ["bad", "bad"]
    assert not v.cache


def test_verifier_asks_again_after_ttl(clock):
    calls = []
    v = signin.Verifier(lambda t: calls.append(t) or {"id": "a"}, ttl_s=300)
    v("tok")
    clock.t += 299
    v("tok")
    assert len(calls) == 1
    clock.t += 2
    v("tok")
    assert len(calls) == 2


class FakeBase44(http.server.BaseHTTPRequestHandler):
    elsewhere_hits = []

    def do_GET(self):
        auth = self.headers.get("Authorization")
        if self.path == "/elsewhere":  # answers a user to anyone: a followed redirect would get one
            FakeBase44.elsewhere_hits.append(auth)
            auth = "Bearer good"
        elif self.path != "/api/apps/app1/entities/User/me":
            self.send_response(404)
            self.end_headers()
            return
        if auth == "Bearer slow":
            time.sleep(1)
            self.send_response(200)
        elif auth == "Bearer moved":
            self.send_response(302)
            self.send_header("Location", "/elsewhere")
        elif auth == "Bearer good":
            body = json.dumps(USERS["good-a"]).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body)
            return
        elif auth == "Bearer noid":
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'{"email": "user-x"}')
            return
        else:
            self.send_response(403)
        self.end_headers()

    def log_message(self, *a):
        pass


@pytest.fixture
def base44():
    s = http.server.ThreadingHTTPServer(("127.0.0.1", 0), FakeBase44)
    s.daemon_threads = True
    threading.Thread(target=s.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{s.server_port}"
    s.shutdown()
    s.server_close()


def test_base44_check_answers_the_user_for_200_only(base44):
    v = signin.base44_verifier("app1", base44, timeout=2)
    assert v("good") == USERS["good-a"]
    FakeBase44.elsewhere_hits.clear()
    for t in ("bad", "moved", "noid"):
        assert v(t) is None
    assert FakeBase44.elsewhere_hits == []  # the redirect was not followed, so the token went nowhere else


def test_base44_check_times_out_to_none(base44):
    v = signin.base44_verifier("app1", base44, timeout=0.2)
    t0 = time.monotonic()
    assert v("slow") is None
    assert time.monotonic() - t0 < 0.9


def test_base44_check_down_is_none():
    assert signin.base44_verifier("app1", "http://127.0.0.1:9", timeout=0.5)("good") is None


def test_every_route_but_home_and_info_refuses_without_a_sign_in(server_env, clock, dicom_series, runs_dir, with_dist):
    """The approved exception is exactly "/" (fixed "OK") and /api/info; every other route the app has answers 401 without a token."""
    srv = make(dicom_series, runs_dir)
    assert srv.get("/").text == "OK" and srv.get("/?x=1").text == "OK"
    routes = [(r.path, sorted(r.methods - {"HEAD"})[0]) for r in srv.app.routes if hasattr(r, "methods") and r.path not in ("/", "/api/info")]
    assert len(routes) >= 10  # the scan, slice, nodule, record, events, map and session routes, the docs among them
    assert ("/api/slice", "POST") in routes  # the one-URL slice route is walked too
    r = srv.post("/api/slice", json=dict(scan="RIDER-TEST01_test", z=4))  # with a valid body: the sign-in comes first
    assert r.status_code == 401 and b"RIDER" not in r.content
    for path, method in routes:
        url = path.replace("{scan_id}", "RIDER-TEST01_test").replace("{to}", "RIDER-TEST01_test").replace("{z}", "4")
        r = srv.request(method, url)
        assert r.status_code == 401 and b"RIDER" not in r.content and r.text != "OK", (method, path)


def test_info_without_a_sign_in_gives_only_the_version_and_busy(server_env, clock, dicom_series, runs_dir):
    srv = make(dicom_series, runs_dir)
    assert srv.get("/api/info").json() == {"commit": srv.get("/api/info").json()["commit"], "server": {"busy": False, "idle_min": 10}}
    assert set(srv.get("/api/info", headers={"Authorization": "Bearer bad"}).json()) == {"commit", "server"}
    full = srv.get("/api/info", headers=A).json()
    assert set(full) == {"commit", "model", "width_method", "device", "server"}


@pytest.mark.parametrize("origin", ["*", "", "https://evil.example", "https://lung-measure.base44.app/", "http://lung-measure.base44.app"])
def test_server_mode_refuses_to_start_with_another_allowed_origin(server_env, dicom_series, runs_dir, monkeypatch, origin):
    monkeypatch.setenv("LUNG_ALLOWED_ORIGIN", origin)
    with pytest.raises(ValueError, match="Server mode answers only https://lung-measure.base44.app"):
        make(dicom_series, runs_dir)


def test_server_mode_starts_with_our_exact_origin(server_env, clock, dicom_series, runs_dir, monkeypatch):
    monkeypatch.setenv("LUNG_ALLOWED_ORIGIN", "https://lung-measure.base44.app")
    assert make(dicom_series, runs_dir).get("/").text == "OK"


def test_a_practice_server_gzips_slices_and_the_local_engine_does_not(srv, server_env, dicom_series, runs_dir, monkeypatch):
    # Measured on the real server (2026-10-28): each slice is 512 KB of raw int16 and the download through Hugging Face's proxy
    # dominates; gzip cuts it by about 45%. The local engine answers over loopback, where compression only costs time: unchanged.
    gz = {**A, "Accept-Encoding": "gzip"}
    post = srv.post("/api/slice", json=dict(scan="RIDER-TEST01_test", z=4), headers=gz)
    get = srv.get(SCAN + "/slices/4", headers=gz)
    for r in (post, get):
        assert r.status_code == 200 and r.headers.get("content-encoding") == "gzip" and "accept-encoding" in r.headers.get("vary", "").lower()
    monkeypatch.delenv("LUNG_SERVER")
    local = TestClient(create_app(data_root=dicom_series, segmenter_factory=BallSegmenter, runs_dir=runs_dir), base_url="http://localhost")
    plain = local.get(SCAN + "/slices/4", headers={"Accept-Encoding": "gzip"})
    assert plain.status_code == 200 and "content-encoding" not in plain.headers
    assert post.content == get.content == plain.content  # the client decodes it: the same int16 bytes
