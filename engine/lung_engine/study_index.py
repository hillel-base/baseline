"""Study index: every CT series under a folder tree, from DICOM headers only (no pixels, no app state)."""
import json
import logging
import math
import os
import re
from datetime import date
from pathlib import Path

from pydicom import dcmread

from .scans import _hash

_VERSION = 2  # 2: axial CT images only; a version-1 cache may hold a screen save
log = logging.getLogger(__name__)
_TAGS = ["Modality", "ImageType", "PatientID", "PatientName", "StudyDate", "StudyInstanceUID",
         "SeriesInstanceUID", "SeriesNumber", "SeriesDescription", "ConvolutionKernel", "SliceThickness",
         "SOPClassUID", "ImageOrientationPatient", "BurnedInAnnotation"]
_CT_IMAGE = "1.2.840.10008.5.1.4.1.1.2"  # CT Image Storage
_CAPTURE = "1.2.840.10008.5.1.4.1.1.7"  # Secondary Capture Image Storage, and its multi-frame kinds (.7.1 to .7.4)
_DOSE = re.compile(r"dose[\W_]*(report|info|summary|record)", re.I)  # not "Low dose chest", a real CT


class TooManyFiles(Exception):
    """More files to read than the caller's limit."""


def _head(f: Path):
    try:
        ds = dcmread(f, stop_before_pixels=True, specific_tags=_TAGS)
        return ds if ds.get("SeriesInstanceUID") else None
    except Exception:  # not DICOM, damaged, or unreadable: skipped and counted by the caller
        return None


def _num(ds, tag: str, conv):
    """A header number, or None when it is missing or bad: one scanner's typo must not break the index."""
    try:
        v = conv(ds.get(tag))  # pydicom converts on access, so a bad value raises here
    except (TypeError, ValueError, OverflowError):
        return None
    return v if math.isfinite(v) else None  # "nan" would break the JSON reply


def _entry(ds, folder: str, images: int) -> dict:
    d = str(ds.get("StudyDate") or "")
    name = str(ds.get("PatientName") or "")
    return {
        "patient_key": str(ds.get("PatientID") or "") or name or folder,
        "patient_name": name,
        "study_date": f"{d[:4]}-{d[4:6]}-{d[6:8]}" if len(d) == 8 else None,
        "study_uid_hash": _hash(str(ds.get("StudyInstanceUID") or "")),
        "series_uid_hash": _hash(str(ds.SeriesInstanceUID)),
        "series_number": _num(ds, "SeriesNumber", int),
        "description": str(ds.get("SeriesDescription") or ""),
        "kernel": str(ds.get("ConvolutionKernel") or "") or None,
        "slice_mm": _num(ds, "SliceThickness", float),
        "images": images,
        "folder": folder,
    }


def _axial(ds) -> bool:
    """Row and column cosines within 0.1 of [1,0,0] and [0,1,0], up to sign. None or a bad value is not axial:
    a CT image must have it (Type 1), so its lack means a capture or a broken export."""
    try:
        iop = [abs(float(v)) for v in ds.get("ImageOrientationPatient")]
    except (TypeError, ValueError):
        return False
    return len(iop) == 6 and all(abs(a - b) <= 0.1 for a, b in zip(iop, (1, 0, 0, 0, 1, 0)))


def _keep(ds) -> bool:
    """Axial CT images only (no scout, capture, dose report or burned-in text): those can carry the patient's name in their pixels, and the hosted page shows slice pixels."""
    types = ds.get("ImageType") or []
    types = [str(t).strip().upper() for t in ([types] if isinstance(types, str) else types)]  # one value comes as a str
    sop = str(ds.get("SOPClassUID") or getattr(ds, "file_meta", {}).get("MediaStorageSOPClassUID", "") or "")
    # DERIVED or SECONDARY stays only as CT Image Storage: TCIA's processed CT is that (RIDER's ImageType is DERIVED, SECONDARY, PROCESSED)
    derived = {"DERIVED", "SECONDARY"} & set(types) and sop != _CT_IMAGE
    return (ds.get("Modality") == "CT" and not {"LOCALIZER", "SCREEN SAVE"} & set(types) and not derived and not sop.startswith(_CAPTURE)
            and str(ds.get("BurnedInAnnotation") or "").upper() != "YES"
            and not any(_DOSE.search(t) for t in [str(ds.get("SeriesDescription") or ""), *types]) and _axial(ds))


def _read_folder(d: Path, rel: str, root: Path, done: list, progress, limit) -> tuple[list[dict], int]:
    # Every header is read (about 0.36 ms each), so no series in a folder is merged or lost and `images` is
    # exact. The cache keeps later runs fast.
    groups: dict[str, list] = {}
    skipped = 0
    for f in sorted(d.iterdir()):
        if not f.is_file() or (f.is_symlink() and not f.resolve().is_relative_to(root)):
            continue
        if limit is not None and done[0] >= limit:
            raise TooManyFiles
        ds = _head(f)
        done[0] += 1
        if progress and done[0] % 100 == 0:
            progress(done[0])
        if ds is None:
            skipped += 1
        else:
            groups.setdefault(str(ds.SeriesInstanceUID), []).append(ds)
    return [_entry(g[0], rel, len(g)) for g in groups.values() if _keep(g[0])], skipped


def _stamp(d: Path, files: list[str]) -> list[float]:
    """Directory mtime and newest file mtime: an in-place overwrite changes only the second."""
    newest = 0.0
    for n in files:
        try:
            newest = max(newest, (d / n).stat().st_mtime)
        except OSError:
            pass
    return [d.stat().st_mtime, newest]


def index_folder(root: Path, cache: Path, progress=None, limit: int | None = None) -> list[dict]:
    """Every CT series under root (any folder layout), from DICOM headers only (no pixels).
    progress(n) is called now and then with the number of files read so far. Reading more than `limit` files
    (cache hits not counted) raises TooManyFiles, and the cache is left as it was."""
    root = root.resolve()
    try:
        old = json.loads(cache.read_text())
        old = old["folders"] if old.get("v") == _VERSION and isinstance(old["folders"], dict) else {}
    except (OSError, ValueError, KeyError, AttributeError):
        old = {}  # missing, damaged or old cache: rebuild, never fatal
    new, out, skipped, done = {}, [], 0, [0]
    # followlinks stays False: a linked folder is never entered, so nothing outside root is read
    for dirpath, _dirs, files in os.walk(root):
        d = Path(dirpath)
        rel = d.relative_to(root).as_posix()
        try:
            stamp = _stamp(d, files)
            hit = old.get(rel)
            if isinstance(hit, dict) and hit.get("stamp") == stamp and isinstance(hit.get("entries"), list):
                entries = hit["entries"]
            else:
                entries, n = _read_folder(d, rel, root, done, progress, limit)
                skipped += n
        except OSError:  # folder unreadable or removed mid-walk
            continue
        new[rel] = {"stamp": stamp, "entries": entries}  # empty folders too, so they are not re-read
        out += entries
    try:
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps({"v": _VERSION, "folders": new}))
    except OSError:
        log.warning("study index: cache not written")
    if progress:
        progress(done[0])
    log.info("study index: %d series, skipped %d unreadable files", len(out), skipped)
    return out


def display_name(pn: str) -> str:
    """A DICOM PN as "Family, Given" ("Doe^Jane^M^Dr" gives "Doe, Jane"); one part as is; other parts and the ideographic and phonetic groups dropped."""
    family, _, rest = pn.split("=")[0].partition("^")
    family, given = family.strip(), rest.split("^")[0].strip()
    return f"{family}, {given}" if family and given else family or given


def label(e: dict) -> str:
    if e.get("description"):
        return e["description"]
    parts = [f"Series {e['series_number']}" if e.get("series_number") is not None else None,
             e.get("kernel"),
             f"{e['slice_mm']:g} mm" if e.get("slice_mm") is not None else None,
             f"{e['images']} images" if e.get("images") is not None else None]
    return " · ".join(p for p in parts if p)


def timeline(entries: list[dict]) -> list[dict]:
    """Per patient: earliest date is Baseline, later ones Follow-up (day = whole days from baseline);
    undated scans are "Undated", day None, and sort last."""
    by: dict[str, list[dict]] = {}
    for e in entries:
        by.setdefault(e["patient_key"], []).append(e)
    out = []
    for key, es in by.items():
        es = sorted(es, key=lambda e: (e["study_date"] is None, e["study_date"] or "", e["series_uid_hash"]))
        dated = [e["study_date"] for e in es if e["study_date"]]
        base = date.fromisoformat(dated[0]) if dated else None
        scans = []
        for e in es:
            if e["study_date"] is None:
                tp, day = "Undated", None
            else:
                day = (date.fromisoformat(e["study_date"]) - base).days
                tp = "Baseline" if e["study_date"] == dated[0] else "Follow-up"
            scans.append({**e, "timepoint": tp, "day": day})
        out.append({"patient_key": key, "scans": scans})
    return out
