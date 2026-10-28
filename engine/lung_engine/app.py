import html
import json
import logging
import os
import re
import secrets
import shlex
import shutil
import threading
import time
from collections import OrderedDict
from pathlib import Path
from typing import Annotated, Callable, Literal


import anyio
from fastapi import APIRouter, Body, FastAPI, HTTPException, Query, Request, Response
from fastapi.responses import HTMLResponse, JSONResponse, PlainTextResponse
from pydantic import BaseModel, ConfigDict, Field, StrictFloat, StrictInt, model_validator
from fastapi.staticfiles import StaticFiles
from starlette.middleware.cors import CORSMiddleware
from starlette.middleware.gzip import GZipMiddleware
from starlette.middleware.trustedhost import TrustedHostMiddleware

from . import signin
from .candidates import CUT, FinderError, FinderMissing, NoFinder, SubprocessFinder, to_voxels
from .followup import map_index, register
from .events import REPO, EventLog
from .fetch import ALL as PUBLIC
from .outline import SNAP_HU, AlreadyRecorded, Empty, NoChange, NoNodule, Recorded, NothingToUndo, OnAir, OutlineSession, OutsideBox, write_mask
from .scans import FOLDER_ID, Scan, baseline_days, folder_series, head_dir, list_scans, load_folder_scan, load_scan, prefetch, study_date, valid_scan_id, warm_order
from .study_index import TooManyFiles, display_name, index_folder, label, timeline


class Point(BaseModel):
    z: int
    y: int
    x: int


class Which(BaseModel):  # the nodule a correction or Undo is for, as the page last saw it
    scan: str
    nodule: int


class Click(Point, Which):
    positive: bool


class SliceReq(BaseModel):  # POST /api/slice: one URL for every slice, so a practice server's page pays one CORS preflight, not one per slice
    scan: str
    z: StrictInt


YX = tuple[Annotated[float, Field(allow_inf_nan=False)], Annotated[float, Field(allow_inf_nan=False)]]  # voxel row, column; decimals allowed


class Stroke(Which):  # one brush stroke on slice z, sent on pointer-up
    z: int
    points: list[YX] = Field(min_length=1, max_length=1000)
    radius: int = Field(ge=1, le=15)  # image pixels
    mode: Literal["paint", "erase"]
    snap: bool = False


class Axes(Which):  # hand-set end points on axis_z
    long_line: tuple[YX, YX]
    short_line: tuple[YX, YX]


class RecordReq(Which):  # follows: the earlier row's outline_file this nodule was matched to; map_distance_mm: proposal to first click
    follows: str | None = Field(None, max_length=200)
    map_distance_mm: StrictFloat | None = Field(None, ge=0)


MAX_ENTRIES = 5000
UNREADABLE = "This folder's images could not be read."


class OpenFolder(BaseModel):
    path: str = ""
    series: str


class UiEvent(BaseModel):  # UI-only actions the page reports; nothing else gets into the log
    model_config = ConfigDict(extra="forbid")
    action: Literal["copy_row", "export_csv", "screenshot", "discard", "delete_row", "clear_table", "restore_table", "start_over", "zoom", "zoom_fit", "zoom_area", "undo_delete_row",
                    "followup_confirm", "followup_moved", "undo_record", "save_failed", "candidate_accept", "candidate_reject", "undo_candidate_reject"]
    scan: str | None = Field(None, max_length=100)
    nodule: StrictInt | None = Field(None, ge=0)
    rows: StrictInt | None = Field(None, ge=0)
    file: str | None = Field(None, max_length=200)
    scale: StrictInt | StrictFloat | None = Field(None, ge=1, le=16)
    follows: str | None = Field(None, max_length=200)  # the earlier row's outline_file
    distance_mm: StrictFloat | None = Field(None, ge=0)  # followup_moved: the proposal to the click
    undoes: str | None = Field(None, max_length=200)  # undo_record: the outline_file of the record it removes
    reason: str | None = Field(None, max_length=60, pattern=r"^[\w .-]+$")  # save_failed: the error's HTTP status or class only, never the payload or an email
    rank: StrictInt | None = Field(None, ge=1, le=500)  # candidate_accept, candidate_reject and undo_candidate_reject: place in the list and its score
    score: StrictInt | StrictFloat | None = Field(None, ge=0, le=1)

    @model_validator(mode="after")
    def followup_fields(self):  # the evaluation reads these lines: a follow-up, undo_record or save_failed event without its fields is refused
        need = {"followup_confirm": ("scan", "follows"), "followup_moved": ("scan", "follows", "distance_mm"), "undo_record": ("scan", "nodule", "undoes"),
                "save_failed": ("reason",), **dict.fromkeys(("candidate_accept", "candidate_reject", "undo_candidate_reject"), ("scan", "rank", "score"))}.get(self.action, ())
        if any(getattr(self, k) is None for k in need):
            raise ValueError(f"{self.action} needs {', '.join(need)}")
        return self


OUTSIDE_VOLUME = "That click is outside the scan."
OUTSIDE = "That click is outside the working box of this nodule. Start a new nodule to outline something else."
ON_AIR = "No outline here: that point is air. Click on the nodule itself."
ON_AIR_ADD = "That point is air, so it cannot be added. Click on the nodule itself."
FINAL = "This nodule is already recorded. Start a new nodule to change it."
APP_ORIGIN = "https://lung-measure.base44.app"  # the hosted page
MODEL = "nnInteractive 2.6.0 (CC BY-NC-SA 4.0)"
MAP_FAILED = "Could not align this scan to the earlier one."
STROKE_OUTSIDE = "That stroke is outside the working box of this nodule."
NO_CHANGE = "That stroke changed nothing."
SNAP_KEPT_OUT = f" Snap to tissue keeps out pixels below \u2212{-SNAP_HU} HU."
AXES_OUTSIDE = "Those axis end points are outside the working box of this nodule."
FOLDERS_LOCAL_ONLY = "Folders open only on the page the engine serves on this computer."
GONE = "This nodule is no longer open in the engine (another tab or a restart). Click the nodule to start again."
SIGN_IN = "Sign in to use the practice server."
FINDER_FAILED = "The finder did not run. The engine's log has the details."
TUTORIAL = "RIDER-2619750334"  # the tutorial's practice case (web/src/tutorial.ts CASE): a practice server warms it first
PRACTICE = ",".join(PUBLIC)  # the 28 public RIDER practice patients; a server sets LUNG_PRACTICE_PATIENTS
BY_ENV = "The study folder is set by LUNG_STUDY_DIR on this computer."
STUDY_GONE = "The study folder cannot be found. Choose it again with Change folder…"
STUDY_UNREADABLE = "The study folder cannot be read. Choose it again with Change folder…"
STUDY_FAILED = "The study folder could not be read."
MAX_STUDY_FILES = 20_000  # files read in one GET /api/patients; cache hits do not count
PICKER = "/picker"  # the Patients panel alone, for the hosted page's frame; exactly this path (picker.html itself, or a case variant, gets frame-ancestors 'none')


def cross_origin(request: Request) -> bool:
    """Another site or another port asks (the hosted page): it gets codes, no names, no study date. The engine's own page sends no Origin, or its own."""
    o = request.headers.get("origin")
    return request.headers.get("sec-fetch-site") in ("cross-site", "same-site") or (o is not None and o != f"{request.url.scheme}://{request.headers.get('host', '')}")


def create_app(data_root: Path | None = None, segmenter_factory: Callable | None = None,
               runs_dir: Path | None = None, width: str | None = None, browse_root: Path | None = None,
               verify_user: Callable[[str], dict | None] | None = None, finder=None) -> FastAPI:
    copilot_on = os.environ.get("LUNG_COPILOT", "on") != "off"
    finder_lock = threading.Lock()  # apart from the outline session: a running finder never blocks clicks
    finding = {"scan": None}  # the scan the finder runs on now
    candidates: dict[str, list[dict]] = {}
    width = width or os.environ.get("LUNG_WIDTH", "edge")
    if width not in ("edge", "centre"):
        raise ValueError("LUNG_WIDTH must be edge or centre.")
    data_root = Path(data_root or os.environ.get("LUNG_DATA_DIR", REPO / "data" / "rider"))
    runs_dir = Path(runs_dir or os.environ.get("LUNG_RUNS_DIR", REPO / "runs"))
    browse_root = Path(browse_root or os.environ.get("LUNG_BROWSE_ROOT") or Path.home()).resolve()
    folder_file = runs_dir / "folder_scans.json"  # scan id -> [folder, series hash]; read by the engine only, never logged
    study_file = runs_dir / "study_folder.json"  # {"path": the study folder the panel set, relative to browse_root}
    study_env = os.environ.get("LUNG_STUDY_DIR")  # when set, it wins over the panel's choice
    study_scans_file = runs_dir / "study_scans.json"  # F- id -> {"patient": the index's patient_key, "day": the timeline's day}; local only, never logged
    over_cap: set[Path] = set()  # study roots that went over MAX_STUDY_FILES in this run: answered at once, never read again
    too_many = lambda: f"The study folder holds more than {MAX_STUDY_FILES:,} files. Choose a smaller folder."
    root_itself = ("Choose a folder inside your home folder, not the home folder itself." if browse_root == Path.home().resolve()
                   else "Choose a folder inside the allowed area, not the whole area itself.")
    finder = finder or (SubprocessFinder(runs_dir, shlex.split(os.environ.get("LUNG_FINDER_TEST_COMMAND", "")) or None) if os.environ.get("LUNG_FINDER") == "subprocess" else NoFinder())
    events = EventLog(runs_dir / "events.jsonl")
    try:
        folder_scans: dict[str, list[str]] = json.loads(folder_file.read_text()) if folder_file.exists() else {}
    except ValueError:  # not JSON: start empty (the next open rewrites the file)
        folder_scans = {}
        events.log("folder_scans_unreadable")
    try:
        study_scans: dict[str, dict] = json.loads(study_scans_file.read_text()) if study_scans_file.exists() else {}
    except ValueError:  # damaged: the next GET /api/patients writes it again
        study_scans = {}
    cache: OrderedDict[str, Scan] = OrderedDict()  # last 2 scans stay in memory
    lock = threading.Lock()  # FastAPI runs sync routes in a threadpool
    visitor = threading.Event()  # set while a visitor's own scan loads on a practice server: the warm-up waits meanwhile
    if segmenter_factory is None:
        from .nni import NNISegmenter  # imports torch; the tests pass a fake instead
        segmenter_factory = NNISegmenter
    recorded_files: dict[tuple[str, int], str] = {}  # (scan, nodule) -> outline file, so a repeated Record gets the same answer
    recorded_marks: dict[tuple[str, int], dict] = {}  # (scan, nodule) -> {"suggestions": ranks} when the scan had a finder run
    record_lock = threading.Lock()  # the file write sits between two session calls: serialise Record
    segmenter = segmenter_factory()
    session = OutlineSession(segmenter, width == "edge")  # built once: loading the model takes seconds
    logging.getLogger("uvicorn.access").disabled = True  # its lines would print each folder path; covers every way of starting the engine
    transforms: dict[tuple[str, str], object] = {}  # (from, to) -> transform
    pair_locks: dict[tuple[str, str], threading.Lock] = {}  # one registration per pair, also for parallel first requests
    app = FastAPI()
    server = os.environ.get("LUNG_SERVER") == "1"  # practice server: Base44 sign-in, one user at a time, practice scans only
    practice = {p.strip() for p in os.environ.get("LUNG_PRACTICE_PATIENTS", PRACTICE).split(",")} - {""}
    idle_min = int(os.environ.get("LUNG_IDLE_MIN", "10"))
    holder = {"id": None, "at": 0.0}  # the user who holds the engine, and the time of their last call
    held_by_other = lambda uid: holder["id"] not in (None, uid) and signin.now() - holder["at"] < idle_min * 60
    verify = verify_user or signin.base44_verifier()
    cached = getattr(verify, "cached", lambda token: None)  # a plain function (a test's fake) keeps no answers
    misses = anyio.CapacityLimiter(4)  # Base44 calls get their own few threads: a flood of made-up tokens cannot take the routes' pool

    async def signed_in(request) -> dict | None:
        scheme, _, token = request.headers.get("authorization", "").partition(" ")
        if scheme.lower() != "bearer" or not (token := token.strip()):
            return None
        user = cached(token) or await anyio.to_thread.run_sync(verify, token, limiter=misses)  # the Base44 call can take 5 s
        return user if user and signin.allowed(user) else None

    if server:
        @app.middleware("http")  # inside CORS, so the page can read a 401 or 423; inside TrustedHost, so a foreign host never reaches Base44
        async def sign_in_and_hold(request, call_next):
            m, path = request.method, request.url.path
            if m == "OPTIONS" or (m == "GET" and path == "/api/info") or (m in ("GET", "HEAD") and path == "/"):
                return await call_next(request)
            user = await signed_in(request)
            if user is None:
                return JSONResponse({"detail": SIGN_IN}, 401)
            if held_by_other(user["id"]):
                events.log("busy_refused", path=request.url.path)  # the path only: never the token or the user
                return JSONResponse({"detail": f"Someone else is using the practice server. It is free again after {idle_min} minutes without use."}, 423)
            holder.update(id=user["id"], at=signin.now())
            return await call_next(request)

        @app.post("/api/session/release", status_code=204)
        def release():  # the guard has just made the caller the holder
            holder["id"] = None

        @app.api_route("/", methods=["GET", "HEAD"], response_class=PlainTextResponse)  # Hugging Face's start-up check; no token, no data
        def home():
            return "OK"  # exactly this: a fixed 200 "OK", no scans, no version, no model action
    space_host = os.environ.get("SPACE_HOST") if server else None  # set by Hugging Face; a Space without server mode then answers 400
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=["localhost", "127.0.0.1"] + ([space_host] if space_host else []))  # blocks DNS rebinding
    if server:  # a slice is 512 KB of raw int16 and the download through Hugging Face's proxy dominates (measured): gzip cuts about 45%. Loopback: none
        app.add_middleware(GZipMiddleware, minimum_size=1024, compresslevel=6)  # level 6: about the same size as 9 on RIDER slices, in a third of the time
    origin = os.environ.get("LUNG_ALLOWED_ORIGIN", APP_ORIGIN)  # empty turns CORS off; Starlette answers only this exact origin
    if server and origin != APP_ORIGIN:  # a practice server answers only the hosted app: never "*", another site or no CORS
        raise ValueError(f"Server mode answers only {APP_ORIGIN}: leave LUNG_ALLOWED_ORIGIN unset or set it to exactly that.")
    if "*" in origin:  # it is also /picker's frame-ancestors and the frame's postMessage target: one exact address, never a wildcard
        raise ValueError(f"LUNG_ALLOWED_ORIGIN must be one exact address, such as {APP_ORIGIN}, never \"*\": got {origin!r}.")
    if origin:
        app.add_middleware(CORSMiddleware, allow_origins=[origin], allow_methods=["GET", "POST"],
                           allow_headers=["Content-Type"] + (["Authorization"] if server else []), allow_private_network=True,  # Chrome's Private Network Access
                           max_age=600)  # the browser keeps a preflight 10 min: with one slice URL, one preflight per 10 min (POST /api/slice)

        @app.middleware("http")  # outermost: Starlette lists methods and private-network even when it refuses an origin; send nothing
        async def refuse_other_preflight(request, call_next):
            if request.method == "OPTIONS" and "access-control-request-method" in request.headers and request.headers.get("origin") != origin:
                return Response("Disallowed CORS origin", 400)
            return await call_next(request)
    @app.middleware("http")  # outermost of all: folder names are often patient names; a cross-origin page (the hosted page, and Base44's scripts in it) gets none
    async def folders_on_own_page_only(request, call_next):
        p = request.scope["path"]  # the routed path, the one the router matches
        named = p.startswith("/api/folders") or (p.startswith("/api/patients") and not server)  # a practice server lists public practice patients only
        # Another site may load /picker only as a frame (a top-level frame navigation); frame-ancestors lets only the hosted page do so. Its own fetches are same-origin.
        framed = p == PICKER and request.method == "GET" and request.headers.get("sec-fetch-dest") == "iframe"
        if (named or p == PICKER) and cross_origin(request) and not framed:
            return JSONResponse({"detail": FOLDERS_LOCAL_ONLY}, 403)  # no CORS headers: the other page cannot even read the refusal
        response = await call_next(request)
        if named:  # no <img> or <script> on another page may load them either (no-cors)
            response.headers["Cross-Origin-Resource-Policy"] = "same-origin"
        response.headers.setdefault("Content-Security-Policy", "frame-ancestors 'none'")  # only /picker names a page that may frame it
        return response

    def make_ref(file: str, what: str):
        """A random 8-hex code per key, kept in runs/<file>: study records then need not carry the real name."""
        path, ref_lock = runs_dir / file, threading.Lock()

        def ref(key: str) -> str:
            with ref_lock:
                refs = None
                if path.exists():
                    try:
                        refs = json.loads(path.read_text())
                        ok = isinstance(refs, dict) and all(isinstance(k, str) and isinstance(v, str) for k, v in refs.items())
                    except ValueError:  # includes bad UTF-8
                        ok = False
                    if not ok:  # never hand out new refs: that would split one scan's (or patient's) records across two refs
                        raise HTTPException(500, f"The {what} reference file is damaged: runs/{file}. Restore it from {file}.bak next to it, or move it away to start new references.")
                refs = refs or {}
                if key not in refs:
                    if path.exists():
                        shutil.copyfile(path, path.with_name(f"{file}.bak"))  # a parsed file only
                    while (new := secrets.token_hex(4)) in refs.values():  # two keys never share a code
                        pass
                    refs[key] = new
                    tmp = path.with_suffix(".tmp")
                    tmp.write_text(json.dumps(refs))
                    tmp.replace(path)
                return refs[key]
        return ref

    scan_ref, patient_ref = make_ref("scan_refs.json", "scan"), make_ref("patient_refs.json", "patient")

    def hidden(scan_id: str) -> bool:  # a data-folder id that may carry a name: a cross-origin caller must use its D- code
        return not server and not FOLDER_ID.fullmatch(scan_id) and scan_id.rpartition("_")[0] not in practice

    def code(scan_id: str) -> str:
        """The id as the hosted page sees it: a D- code for a hidden scan, else the id itself."""
        return "D-" + scan_ref(scan_id) if hidden(scan_id) else scan_id

    def shown(scan_id: str, request: Request) -> str:
        """The id a caller may see: a cross-origin caller gets a D- code for a hidden scan."""
        return code(scan_id) if cross_origin(request) else scan_id

    def refs_file() -> dict:
        try:
            return json.loads((runs_dir / "scan_refs.json").read_text())
        except (OSError, ValueError):
            return {}

    def resolve(scan_id: str, request: Request) -> str:
        """A D- code to the internal id (read back from scan_refs.json); a hidden internal id from a cross-origin caller is as unknown as a made-up code."""
        if re.fullmatch(r"D-[0-9a-f]{8}", scan_id):
            try:
                return next(k for k, v in refs_file().items() if v == scan_id[2:])
            except (StopIteration, AttributeError):
                raise HTTPException(404, "unknown scan")
        if hidden(scan_id) and cross_origin(request):
            raise HTTPException(404, "unknown scan")
        return scan_id

    def file_out(f: str, scan_id: str, request: Request) -> str:
        """An outline file name for the caller, built from the shown id (the file on disk keeps its name; it always starts outlines/<internal id>_n)."""
        own = f"outlines/{scan_id}_n"
        if not f.startswith(own):
            raise HTTPException(500, "Unexpected outline file name.")
        return f"outlines/{shown(scan_id, request)}_n" + f[len(own):]

    def file_in(f: str | None, request: Request) -> str | None:
        """The reverse of file_out, for a name the page sends back."""
        m = f and re.match(r"outlines/(D-[0-9a-f]{8})_n", f)
        return f"outlines/{resolve(m[1], request)}_n" + f[m.end():] if m else f

    @app.get("/api/info")
    async def info(request: Request):  # async: a cached token is answered on the event loop, a miss waits on its own limiter
        out = {"commit": events.commit, "model": MODEL, "width_method": width, "device": getattr(segmenter, "device", "unknown")}
        if server:  # needs no token; with the holder's own token (the page reloaded), not busy
            user = await signed_in(request)
            busy = {"busy": held_by_other(user and user["id"]), "idle_min": idle_min}
            # without a sign-in: only what the page's readiness check needs
            return {**out, "server": busy} if user else {"commit": events.commit, "server": busy}
        return {**out, "picker": (dist / "picker.html").is_file()}  # only when /picker can answer (an unbuilt checkout 404s it: the hosted page then keeps the drop-down)

    def known_id(scan_id: str) -> bool:  # the id's shape; in server mode, practice patients only
        return valid_scan_id(scan_id) and (not server or scan_id.rpartition("_")[0] in practice)

    def refuse(reason, p, positive, message, scan=None, nodule=None):
        s = session.scan  # read once: a failed start can drop it meanwhile
        scan = scan or (s and s.id)  # no scan before the first nodule
        events.log("click_refused", **({"scan": scan} if scan else {}), **({"nodule": nodule} if nodule is not None else {}),
                   z=p.z, y=p.y, x=p.x, positive=positive, reason=reason)
        raise HTTPException(400, message)

    def get_scan(scan_id: str) -> Scan:
        if not known_id(scan_id):
            raise HTTPException(404, "unknown scan")
        with lock:
            if scan_id not in cache:
                try:
                    if scan_id in folder_scans:
                        try:
                            d = inside(folder_scans[scan_id][0])  # the root may have changed since the id was made
                        except HTTPException:
                            raise FileNotFoundError(scan_id)
                        cache[scan_id] = load_folder_scan(scan_id, d, folder_scans[scan_id][1])
                    else:
                        if server:  # the mounted bucket answers many files at once far faster than one by one (prefetch)
                            visitor.set()
                            p, _, sr = scan_id.rpartition("_")
                            prefetch(data_root / p / f"ct_{sr}")
                        cache[scan_id] = load_scan(data_root, scan_id)
                except FileNotFoundError:
                    raise HTTPException(404, "unknown scan")
                except RuntimeError:  # SimpleITK's error text can hold the file path: send none
                    raise HTTPException(400, UNREADABLE)
                finally:
                    visitor.clear()
                while len(cache) > 2:
                    cache.popitem(last=False)
            cache.move_to_end(scan_id)
            return cache[scan_id]

    def inside(path: str) -> Path:
        p = (browse_root / path).resolve()  # an absolute path replaces the root; resolve follows symlinks; then check
        if not p.is_relative_to(browse_root):
            raise HTTPException(400, "That folder is outside the allowed area.")
        if not p.is_dir():
            raise HTTPException(404, "That folder does not exist.")
        try:
            with os.scandir(p) as it:  # one pass: cap the size, and refuse a file link that leaves the root (GDCM would read it)
                for n, e in enumerate(it, 1):
                    if n > MAX_ENTRIES:
                        raise HTTPException(400, f"This folder holds too many files to list (over {MAX_ENTRIES}). Open a folder nearer the scan.")
                    if e.is_symlink() and e.is_file() and not Path(e.path).resolve().is_relative_to(browse_root):
                        raise HTTPException(400, "That folder is outside the allowed area.")
        except PermissionError:
            raise HTTPException(403, "That folder cannot be read.")
        return p

    rel = lambda q: "" if q == browse_root else q.relative_to(browse_root).as_posix()

    def save(path: Path, obj):  # whole or not at all: a crash mid-write leaves the old file
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(obj))
        os.replace(tmp, path)

    def folder_ids(pairs: list[list[str]]) -> list[str]:
        """An F- id per [folder, series hash], kept in runs/folder_scans.json: the same folder and series always get the same id."""
        with lock:
            have = {tuple(v): k for k, v in folder_scans.items()}
            n = len(folder_scans)
            for pair in pairs:
                if tuple(pair) not in have:
                    while (sid := "F-" + secrets.token_hex(4)) in folder_scans:  # two series never share an id
                        pass
                    folder_scans[sid], have[tuple(pair)] = pair, sid
            if len(folder_scans) > n:
                save(folder_file, folder_scans)
            return [have[tuple(p)] for p in pairs]

    def save_outline(s: Scan, mask, nodule: int, kind: str) -> Path:
        path, i = runs_dir / "outlines" / f"{s.id}_n{nodule}_{kind}.nii.gz", 1
        while path.exists():  # never overwrite an earlier file, from an earlier run or this one: one file per Record
            path, i = path.with_name(f"{s.id}_n{nodule}_{events.run}{'' if i == 1 else f'-{i}'}_{kind}.nii.gz"), i + 1
        write_mask(s, mask, path)
        return path

    @app.get("/api/scans")
    def scans(request: Request):
        if server:
            return [s for s in list_scans(data_root) if s["patient"] in practice]
        out = list_scans(data_root)
        if cross_origin(request):
            out = sorted(({"id": shown(s["id"], request), "patient": patient_ref(s["patient"]), "series": s["series"]} if hidden(s["id"]) else s for s in out), key=lambda s: s["id"])  # by shown id: the order gives nothing away
        with lock:  # a first study index adds many ids at once
            opened = sorted(folder_scans) if cross_origin(request) else list(folder_scans)  # by code: the order gives nothing away
        return out + [{"id": i, "patient": "Opened folders", "series": i} for i in opened]

    folder_api = APIRouter()  # left out in server mode: no folder opening there

    @folder_api.get("/api/folders")
    def folders(path: str = ""):
        p = inside(path)
        try:
            names = sorted(d.name for d in p.iterdir() if not d.name.startswith(".") and d.is_dir() and d.resolve().is_relative_to(browse_root))
        except PermissionError:
            raise HTTPException(403, "That folder cannot be read.")
        try:
            series = folder_series(p)
        except RuntimeError:
            raise HTTPException(400, UNREADABLE)
        return {"path": rel(p), "parent": None if p == browse_root else rel(p.parent), "folders": names,
                "series": [{k: v for k, v in s.items() if k != "_uid"} for s in series]}

    @folder_api.post("/api/folders/open")
    def open_folder(o: OpenFolder, request: Request):
        p = inside(o.path)
        try:
            found = [s["uid_hash"] for s in folder_series(p)]
        except RuntimeError:
            raise HTTPException(400, UNREADABLE)
        if o.series not in found:
            raise HTTPException(404, "That series is not in this folder.")
        return scan_info(folder_ids([[str(p), o.series]])[0], request)  # the same reply as GET /api/scans/{id}, study date rule included

    def study_patients(root: Path) -> list[dict]:
        """The study folder's patients, from the index in runs/ (headers only); each series gets its F- id, so /api/scans/{id} opens it."""
        if root in over_cap:
            raise TooManyFiles
        t0, files = time.perf_counter(), [0]
        try:
            entries = index_folder(root, runs_dir / "study_index.json", lambda n: files.__setitem__(0, n), MAX_STUDY_FILES)
        except TooManyFiles:
            over_cap.add(root)
            raise
        for e, sid in zip(entries, folder_ids([[str(root / e["folder"]), e["series_uid_hash"]] for e in entries])):
            e["id"] = sid
        tl = timeline(entries)
        meta = {}
        for p in tl:  # timepoint: the order of the scan's study day among the patient's dated days (Baseline 0)
            days = sorted({s["day"] for s in p["scans"] if s["day"] is not None})
            undated = [s["id"] for s in p["scans"] if s["day"] is None]  # a blanked date (anonymisation): each its own timepoint after the dated
            tp = lambda s: days.index(s["day"]) if s["day"] is not None else len(days) + undated.index(s["id"])  # days, never 0 beside a Baseline
            meta |= {s["id"]: {"patient": p["patient_key"], "day": s["day"], "timepoint": tp(s)} for s in p["scans"]}
        with lock:  # scan info reads these: a study scan's record carries its patient's code and day, also after a restart
            if any(study_scans.get(k) != v for k, v in meta.items()):
                study_scans.update(meta)
                save(study_scans_file, study_scans)
        out = [{"key": patient_ref(p["patient_key"]), "name": display_name(p["scans"][0]["patient_name"]) or p["patient_key"], "source": "study",
                "scans": [{"id": s["id"], "code": code(s["id"]), "timepoint": s["timepoint"], "date": s["study_date"], "day": s["day"], "label": label(s),
                           "slice_mm": s["slice_mm"], "images": s["images"]} for s in p["scans"]]} for p in tl]
        events.log("study_index", patients=len(out), scans=len(entries), files=files[0], seconds=round(time.perf_counter() - t0, 1))  # counts only
        return sorted(out, key=lambda p: (p["name"], p["key"]))

    def data_patients() -> list[dict]:
        """The data folder's patients (ct_test is the Baseline, ct_retest the Follow-up), from one header per series, no pixels."""
        by: dict[str, list[dict]] = {}
        for s in list_scans(data_root):
            if not server or s["patient"] in practice:
                by.setdefault(s["patient"], []).append(s)
        out = []
        for n, (p, ss) in enumerate(sorted(by.items()), 1):
            scans = []
            for s in sorted(ss, key=lambda s: s["series"] != "test"):
                d = data_root / p / f"ct_{s['series']}"
                date = study_date(d)
                try:
                    images = sum(not f.startswith(".") for f in os.listdir(d))
                except OSError:  # a broken link from a half-done fetch: listed, as /api/scans lists it
                    images = 0
                scans.append({"id": s["id"], "code": code(s["id"]), "timepoint": "Baseline" if s["series"] == "test" else "Follow-up",
                              "date": None if server else date,  # the hosted page never gets a study date
                              "day": None if date is None else baseline_days(data_root, p, date), "label": f"{s['series'].capitalize()} scan",
                              "slice_mm": None, "images": images})
            out.append({"key": p if p in practice else patient_ref(p), "name": f"Practice patient {n}" if server else p, "source": "data", "scans": scans})
        return out

    def study_path() -> str | None:
        """LUNG_STUDY_DIR, else the folder the panel set (relative to the browse root), else None."""
        if study_env:
            return study_env
        try:
            return json.loads(study_file.read_text())["path"]
        except (OSError, ValueError, KeyError, TypeError):  # never set, or damaged: no study folder until the panel sets one
            return None

    def study_root(path: str) -> Path:
        p = inside(path)
        if p == browse_root:  # the whole home folder: the index would read every file in it
            raise HTTPException(400, root_itself)
        return p

    @app.get("/api/patients")
    def patients():  # names: the engine's own page only (the guard above), except the practice server's public patients
        if server or (path := study_path()) is None:
            return {"folder": {"path": None, "from": None, "error": None}, "patients": data_patients()}
        folder, out = {"path": None if Path(path).is_absolute() else path, "from": "LUNG_STUDY_DIR" if study_env else "panel", "error": None}, []
        try:
            root = study_root(path)
            folder["path"], out = rel(root), study_patients(root)
        except HTTPException as e:  # gone, unreadable, or the browse root changed: the data folder is still listed
            folder["error"] = {404: STUDY_GONE, 403: STUDY_UNREADABLE}.get(e.status_code, e.detail)
            if study_env:  # the panel offers no Change then: point to the variable
                folder["error"] = folder["error"].replace("Choose it again with Change folder…", "Check LUNG_STUDY_DIR on this computer.")
        except TooManyFiles:
            folder["error"] = too_many()
        except Exception as e:  # one bad file must never take the data patients with it
            events.log("study_index_failed", reason=type(e).__name__)  # the type only: the message can hold a path or a name
            folder["error"] = STUDY_FAILED
        return {"folder": folder, "patients": out + data_patients()}

    @folder_api.post("/api/patients/folder")
    def set_study_folder(path: str = Body(embed=True)):
        if study_env:
            raise HTTPException(409, BY_ENV)
        try:
            root = study_root(path)
            over_cap.discard(root)  # the user may have made it smaller: try again
            study_patients(root)  # before saving: an over-cap folder is refused and the old one stays
            save(study_file, {"path": rel(root)})
        except TooManyFiles:
            raise HTTPException(400, too_many())
        except HTTPException:  # already a plain line
            raise
        except Exception as e:  # never a traceback text with a path or a name: the type only goes to the log
            events.log("study_index_failed", reason=type(e).__name__)
            raise HTTPException(500, STUDY_FAILED)
        return patients()  # from the cache just written

    if not server:
        app.include_router(folder_api)

    @app.get("/api/scans/{scan_id}")
    def scan_info(scan_id: str, request: Request):
        scan_id = resolve(scan_id, request)
        s = get_scan(scan_id)
        ref = scan_ref(scan_id)  # before the log line: a damaged refs file logs nothing
        m = study_scans.get(scan_id)  # a study-folder scan: the patient and day the index gave it
        code = patient_ref(m["patient"]) if m else s.patient if s.patient in practice else patient_ref(s.patient)
        events.log("open_scan", scan=scan_id)
        out = {"id": shown(s.id, request), "scan_ref": ref, "study_code": code, "patient": code if hidden(s.id) and cross_origin(request) else s.patient, "series": s.series,
               "shape": list(s.array.shape), "spacing": list(s.spacing),
               "instance_numbers": s.instance_numbers, "series_number": s.series_number, "study_date": s.study_date,
               "days_from_baseline": (m["day"] or 0) if m else baseline_days(data_root, s.patient, s.study_date),
               "timepoint": m.get("timepoint") if m else None,  # a study scan's order; None: the page's own rule (RIDER test 0, retest 1)
               "slice_thickness_mm": s.slice_thickness_mm,
               "head_dir": head_dir(s)}
        if cross_origin(request):  # the hosted page never gets the study date
            del out["study_date"]
        return out

    @app.get("/api/scans/{scan_id}/slices/{z}")
    def slice_bytes(scan_id: str, z: int, request: Request):
        s = get_scan(resolve(scan_id, request))
        if not 0 <= z < s.array.shape[0]:
            raise HTTPException(404, "slice out of range")
        return Response(s.array[z].astype("<i2").tobytes(), media_type="application/octet-stream")

    @app.post("/api/slice")
    def slice_post(b: SliceReq, request: Request):  # the same bytes and errors as the GET above (the token's preflight is per URL)
        return slice_bytes(b.scan, b.z, request)

    @app.get("/api/scans/{to}/map")
    def map_point(to: str, z: int, y: int, x: int, request: Request, src: str = Query(alias="from")):
        src, to = resolve(src, request), resolve(to, request)
        for sid in (src, to):
            if not known_id(sid):
                raise HTTPException(404, "unknown scan")
        a, b = get_scan(src), get_scan(to)  # the lock is held only while loading, never while registering
        if not all(0 <= c < n for c, n in zip((z, y, x), a.array.shape)):
            raise HTTPException(400, OUTSIDE_VOLUME)
        t0 = time.perf_counter()
        with pair_locks.setdefault((src, to), threading.Lock()):  # setdefault is atomic under the GIL
            if (src, to) not in transforms:
                try:
                    transforms[(src, to)] = register(a.image, b.image)
                except Exception as e:  # the reason without paths: SimpleITK messages carry its source file names
                    reason = " ".join(w for w in f"{type(e).__name__}: {e}".split() if "/" not in w and "\\" not in w)[:200]
                    events.log("map_failed", scan=to, src=src, reason=reason)
                    raise HTTPException(500, MAP_FAILED) from e
        out, outside = map_index(transforms[(src, to)], a.image, b.image, (z, y, x), report=True)
        seconds = round(time.perf_counter() - t0, 1)
        flag = {"outside": True} if outside else {}  # the point fell outside the follow-up scan; z, y, x are clamped to it
        events.log("map", scan=to, src=src, z=z, y=y, x=x, to_z=out[0], to_y=out[1], to_x=out[2], seconds=seconds, **flag)
        return {"z": out[0], "y": out[1], "x": out[2], "seconds": seconds, **flag}

    @app.post("/api/scans/{scan_id}/nodules")
    def start_nodule(scan_id: str, p: Point, request: Request):
        scan_id = resolve(scan_id, request)
        s = get_scan(scan_id)
        if not all(0 <= c < n for c, n in zip((p.z, p.y, p.x), s.array.shape)):
            refuse("outside_volume", p, True, OUTSIDE_VOLUME, scan_id)
        try:
            out, first = session.start(s, (p.z, p.y, p.x))
        except OnAir:
            refuse("air", p, True, ON_AIR, scan_id)
        path = save_outline(s, first, out["nodule"], "first")
        events.log("nodule_start", scan=scan_id, nodule=out["nodule"], z=p.z, y=p.y, x=p.x, positive=True,
                   seconds=out["seconds"], at_window_edge=out["at_window_edge"], width_method=out["width_method"], outline_file=path.relative_to(runs_dir).as_posix())
        return {**out, "scan": shown(out["scan"], request)}

    @app.post("/api/nodule/clicks")
    def click(c: Click, request: Request):
        c.scan = resolve(c.scan, request)
        try:
            out = session.click((c.z, c.y, c.x), c.positive, (c.scan, c.nodule))
        except NoNodule:
            refuse("no_nodule", c, c.positive, GONE, c.scan, c.nodule)
        except Recorded:
            raise HTTPException(409, FINAL)
        except OutsideBox:
            refuse("outside_box", c, c.positive, OUTSIDE, nodule=c.nodule)
        except OnAir:
            refuse("air", c, True, ON_AIR_ADD, nodule=c.nodule)
        events.log("click", scan=out["scan"], nodule=out["nodule"], z=c.z, y=c.y, x=c.x, positive=c.positive,
                   seconds=out["seconds"], at_window_edge=out["at_window_edge"])
        return {**out, "scan": shown(out["scan"], request)}

    @app.post("/api/nodule/undo")
    def undo(w: Which, request: Request):
        w.scan = resolve(w.scan, request)
        try:
            out = session.undo((w.scan, w.nodule))
        except NoNodule:
            events.log("click_refused", scan=w.scan, nodule=w.nodule, reason="no_nodule")
            raise HTTPException(400, GONE)
        except Recorded:
            raise HTTPException(409, FINAL)
        except NothingToUndo:
            raise HTTPException(409, "Nothing to undo.")
        events.log("undo", scan=out["scan"], nodule=out["nodule"])
        return {**out, "scan": shown(out["scan"], request)}

    @app.post("/api/nodule/paint")
    def paint(b: Stroke, request: Request):
        b.scan = resolve(b.scan, request)
        try:
            out, voxels = session.stroke([(b.z, y, x) for y, x in b.points], b.radius, b.mode == "erase", b.snap, (b.scan, b.nodule))
        except NoNodule:
            events.log("click_refused", scan=b.scan, nodule=b.nodule, reason="no_nodule")
            raise HTTPException(400, GONE)
        except Recorded:
            raise HTTPException(409, FINAL)
        except OutsideBox:
            raise HTTPException(400, STROKE_OUTSIDE)
        except NoChange as e:
            raise HTTPException(400, NO_CHANGE + (SNAP_KEPT_OUT if e.args[0] else ""))
        events.log(b.mode, scan=out["scan"], nodule=out["nodule"], z=b.z, radius=b.radius, voxels=voxels, snap=b.snap and b.mode == "paint")  # erase ignores snap
        return {**out, "scan": shown(out["scan"], request)}

    @app.post("/api/nodule/axes")
    def set_axes(b: Axes, request: Request):
        b.scan = resolve(b.scan, request)
        try:
            out, moved = session.set_axes(b.long_line, b.short_line, (b.scan, b.nodule))
        except NoNodule:
            events.log("click_refused", scan=b.scan, nodule=b.nodule, reason="no_nodule")
            raise HTTPException(400, GONE)
        except Recorded:
            raise HTTPException(409, FINAL)
        except Empty:
            raise HTTPException(400, "Nothing to measure: the outline is empty.")
        except OutsideBox:
            raise HTTPException(400, AXES_OUTSIDE)
        for which, before, after in moved:
            events.log("axis_drag", scan=out["scan"], nodule=out["nodule"], which=which, before_mm=before, after_mm=after)
        return {**out, "scan": shown(out["scan"], request)}

    @app.post("/api/nodule/record")
    def record(w: RecordReq, request: Request):
        w.scan = resolve(w.scan, request)
        w.follows = file_in(w.follows, request)
        with record_lock:
            try:
                out, full, scan = session.record((w.scan, w.nodule))
            except NoNodule:
                events.log("click_refused", scan=w.scan, nodule=w.nodule, reason="no_nodule")
                raise HTTPException(400, GONE)
            except Empty:
                raise HTTPException(400, "Nothing to record: the outline is empty.")
            except AlreadyRecorded:  # a retry after a lost reply: same file, no new event
                return {"outline_file": file_out(recorded_files[(w.scan, w.nodule)], w.scan, request), **recorded_marks.get((w.scan, w.nodule), {})}
            try:
                f = save_outline(scan, full, out["nodule"], "accepted").relative_to(runs_dir).as_posix()
            except BaseException:  # a failed write must not leave the nodule unrecordable
                session.unrecord((w.scan, w.nodule))
                raise
            recorded_files[(w.scan, w.nodule)] = f  # before the log line: if logging fails the nodule stays recorded and a retry answers
            marks = candidates.get(w.scan)  # the scan's last finder run: the ranks (1 = first in its list) whose voxel the accepted outline holds, whoever started it
            recorded_marks[(w.scan, w.nodule)] = inside = {} if marks is None else {"suggestions": [i + 1 for i, m in enumerate(marks) if full[m["z"], m["y"], m["x"]]]}
            events.log("record", scan=out["scan"], nodule=out["nodule"], outline_file=f, clicks=len(out["clicks"]),
                       corrections=max(0, len(out["clicks"]) - 1), series_number=scan.series_number, slice_thickness_mm=scan.slice_thickness_mm, slice_spacing_mm=scan.spacing[2],
                       **{k: out[k] for k in ("volume_ml", "long_mm", "short_mm", "depth_mm", "width_method", "axis_z", "long_line", "short_line", "at_window_edge", "painted", "axes_edited")},
                       **w.model_dump(include={"follows", "map_distance_mm"}, exclude_none=True), **inside)
            return {"outline_file": file_out(f, w.scan, request), **inside}

    @app.post("/api/events")
    def ui_event(e: UiEvent, request: Request):
        e.scan, e.file, e.follows, e.undoes = e.scan and resolve(e.scan, request), file_in(e.file, request), file_in(e.follows, request), file_in(e.undoes, request)  # the log keeps the internal names
        if e.scan and not known_id(e.scan):  # shape only: loading a CT here would evict the open scan from the cache
            raise HTTPException(404, "unknown scan")
        events.log(e.action, **e.model_dump(exclude={"action"}, exclude_none=True))
        return {}

    def copilot_ready():
        if not copilot_on:
            raise HTTPException(403, "The co-pilot is off for this session.")
        if isinstance(finder, NoFinder):
            raise HTTPException(503, "No nodule finder is installed in this engine.")

    @app.get("/api/copilot")
    def copilot():
        on = copilot_on and not isinstance(finder, NoFinder)
        return {"enabled": on, "finder": finder.name if on else None}

    def own_or_allowed(request: Request):
        """A POST with no body is a "simple" request: another website could send it without a preflight. Only the engine's own page and the allowed origin pass."""
        o = request.headers.get("origin")
        if (o is not None and o not in (f"{request.url.scheme}://{request.headers.get('host', '')}", origin)) or (o is None and request.headers.get("sec-fetch-site") == "cross-site"):
            raise HTTPException(403, "Only the engine's own page or the lab app can run the finder.")  # CORS adds no header for a foreign origin

    @app.post("/api/scans/{scan_id}/candidates")
    def find_candidates(scan_id: str, request: Request):
        own_or_allowed(request)
        scan_id = resolve(scan_id, request)
        copilot_ready()
        s = get_scan(scan_id)
        if not finder_lock.acquire(blocking=False):
            if finding["scan"] == scan_id:
                raise HTTPException(409, "The finder is already running.")
            finder.cancel()  # a run for another scan: its page has moved on, so this one takes over
            if not finder_lock.acquire(timeout=10):
                raise HTTPException(409, "The finder is already running.")
        finding["scan"] = scan_id
        try:
            t0, cut = time.perf_counter(), CUT
            try:
                found = to_voxels(s, finder.find(s), cut)
            except FinderMissing:
                raise HTTPException(503, "No nodule finder is installed in this engine.")
            except FinderError as e:  # its own words go to the engine's console only, never to a page
                logging.getLogger("uvicorn.error").warning("The finder did not run: %s", e)
                raise HTTPException(500, FINDER_FAILED)
            candidates[scan_id] = found
            events.log("candidates_found", scan=scan_id, count=len(found), cut=cut,
                       seconds=round(time.perf_counter() - t0, 2), finder=finder.name)
            return found
        finally:
            finding["scan"] = None
            finder_lock.release()

    @app.get("/api/scans/{scan_id}/candidates")
    def get_candidates(scan_id: str, request: Request):
        scan_id = resolve(scan_id, request)
        copilot_ready()
        if scan_id not in candidates:
            raise HTTPException(404, "No suggestions yet: press Find nodules.")
        return candidates[scan_id]

    dist = REPO / "web" / "dist"
    if not server:
        @app.get(PICKER, response_class=HTMLResponse)
        def picker():
            """The Patients panel alone (web/picker.html), framed by the hosted page only; it posts to that page's exact origin, written into the page here."""
            try:
                page = (dist / "picker.html").read_text()
            except OSError:
                raise HTTPException(404, "The page is not built. Run npm run build in web/.")
            return HTMLResponse(page.replace("__LUNG_PARENT__", html.escape(origin)), headers={
                "Content-Security-Policy": "frame-ancestors " + (origin or "'none'"), "Referrer-Policy": "no-referrer",
                "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store"})
    if dist.exists() and not server:  # the server has no page: the hosted page is the page
        app.mount("/", StaticFiles(directory=dist, html=True))
    if server and os.environ.get("LUNG_WARMUP") == "1":  # space/start.sh: read every practice scan's files once, so a first open is fast
        def wait_for_visitor():
            while visitor.is_set():
                time.sleep(0.2)

        def warm():
            t0, order, n = time.perf_counter(), warm_order(practice, TUTORIAL), 0
            for sid in order:
                p, _, sr = sid.rpartition("_")
                n += prefetch(data_root / p / f"ct_{sr}", workers=4, pause=wait_for_visitor)
                if sid == f"{TUTORIAL}_test":
                    try:
                        get_scan(sid)  # the tutorial's Baseline is decoded into the cache too: its first open is instant
                    except HTTPException:
                        pass
                    print(f"warm-up: the tutorial case is ready after {time.perf_counter() - t0:.0f} s", flush=True)
            print(f"warm-up: {len(order)} scans, {n} files read in {time.perf_counter() - t0:.0f} s", flush=True)

        threading.Thread(target=warm, daemon=True, name="warm-up").start()
    return app
