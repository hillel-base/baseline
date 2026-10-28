import hashlib
import math
import os
import re
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

import numpy as np
import SimpleITK as sitk


@dataclass
class Scan:
    id: str
    patient: str
    series: str
    image: sitk.Image  # shares its pixels with `array`: never modify it in place
    array: np.ndarray  # int16 HU, (z, y, x), read-only: the image's own pixels
    spacing: tuple[float, float, float]  # x, y, z in mm
    instance_numbers: list[int] | None  # DICOM image number per z; None if missing or not unique
    series_number: int | None = None  # DICOM SeriesNumber of the first file
    study_date: str | None = None  # StudyDate as YYYY-MM-DD; local row only, never logged
    slice_thickness_mm: float | None = None  # header SliceThickness (the row also shows the spacing the measurements use)


class _Pixels:
    """The image's own buffer as a read-only array that keeps the image alive: one copy of the pixels, not two."""

    def __init__(self, img: sitk.Image):
        self.img, self.__array_interface__ = img, sitk.GetArrayViewFromImage(img).__array_interface__


FOLDER_ID = re.compile(r"F-[0-9a-f]{8}(_folder)?")  # the page names a folder scan patient_series: F-xxxxxxxx_folder


def list_scans(root: Path) -> list[dict]:
    """Directory listing only: no scan is opened."""
    out = [{"id": f"{d.parent.name}_{d.name[3:]}", "patient": d.parent.name, "series": d.name[3:]}
           for d in root.glob("*/ct_*") if d.name in ("ct_test", "ct_retest")]
    return sorted(out, key=lambda s: s["id"])


def valid_scan_id(scan_id: str) -> bool:
    """The id's shape only, no disk access. Trust boundary: the id comes from the URL, so it must not escape the data root."""
    if FOLDER_ID.fullmatch(scan_id):
        return True
    patient, _, series = scan_id.rpartition("_")
    return series in ("test", "retest") and bool(patient) and not patient.startswith(".") and "/" not in patient and "\\" not in patient


def head_dir(scan: Scan):
    """1 when a higher z is nearer the head, -1 when nearer the feet, None for a tilted series."""
    zz = scan.image.GetDirection()[8]
    return None if abs(zz) < 0.9 else (1 if zz > 0 else -1)


def prefetch(d: Path, workers: int = 16, pause=None) -> int:
    """Reads every .dcm file in folder d once, in parallel, so the series listing and the pixel read that follow come from the cache.
    A practice server's scans sit in a mounted bucket that answers each file slowly but many at once: a cold open took 30-35 s there,
    against 1.3 s to decode the same 281 files from a local disk (2026-10-28). `pause` is called before each file (the warm-up waits
    there while a visitor loads a scan). Returns the number of files read; a missing folder reads nothing, and a file that cannot be
    read is skipped (the normal read that follows reports it, as the plain "unreadable" line, and the warm-up goes on)."""
    try:
        files = [e.path for e in os.scandir(d) if e.is_file() and e.name.endswith(".dcm")]
    except OSError:
        return 0
    def one(f):
        if pause:
            pause()
        try:
            with open(f, "rb") as fh:
                while fh.read(1 << 20):
                    pass
            return 1
        except OSError:
            return 0
    with ThreadPoolExecutor(workers) as ex:
        return sum(ex.map(one, files))


def warm_order(practice: set[str], first: str) -> list[str]:
    """The practice scans a server warms at start: the tutorial case first (its Baseline, then its Follow-up), then the rest sorted."""
    order = ([first] if first in practice else []) + sorted(practice - {first})
    return [f"{p}_{s}" for p in order for s in ("test", "retest")]


def load_scan(root: Path, scan_id: str) -> Scan:
    if not valid_scan_id(scan_id):
        raise FileNotFoundError(scan_id)
    patient, _, series = scan_id.rpartition("_")
    d = root / patient / f"ct_{series}"
    if not d.is_dir():
        raise FileNotFoundError(scan_id)
    return _read(_files(d), scan_id, patient, series)


def _files(d: Path, uid: str = "") -> tuple[str, ...]:
    return sitk.ImageSeriesReader.GetGDCMSeriesFileNames(str(d), uid) if uid else sitk.ImageSeriesReader.GetGDCMSeriesFileNames(str(d))


def _read(files, scan_id: str, patient: str, series: str) -> Scan:
    r = sitk.ImageSeriesReader()
    r.SetFileNames(files)
    r.MetaDataDictionaryArrayUpdateOn()  # per-slice tags, read in the same pass as the pixels
    r.SetOutputPixelType(sitk.sitkInt16)  # GDCM applies the rescale; the default int32 doubles the memory
    img = sitk.Clamp(r.Execute(), sitk.sitkInt16, -1024, 3071)
    try:
        inst = [int(r.GetMetaData(z, "0020|0013")) for z in range(img.GetDepth())]
    except (RuntimeError, ValueError):  # tag missing or not an integer
        inst = None
    if inst is not None and len(set(inst)) != len(inst):
        inst = None
    return Scan(scan_id, patient, series, img, np.asarray(_Pixels(img)), img.GetSpacing(), inst,
                *(_tag(r, t, f) for t, f in (("0020|0011", int), ("0008|0020", _date), ("0018|0050", float))))


def _hash(uid: str) -> str:
    return hashlib.sha256(uid.encode()).hexdigest()[:12]  # the page never sees the DICOM UID


def folder_series(d: Path) -> list[dict]:
    """DICOM series directly in folder d, from file headers only (no pixels read)."""
    out = []
    for uid in sitk.ImageSeriesReader.GetGDCMSeriesIDs(str(d)):
        files = _files(d, uid)
        desc = ""
        try:
            f = sitk.ImageFileReader()
            f.SetFileName(files[0])
            f.ReadImageInformation()
            desc = f.GetMetaData("0008|103e").strip() if f.HasMetaDataKey("0008|103e") else ""
        except RuntimeError:
            pass
        out.append({"uid_hash": _hash(uid), "description": desc, "images": len(files), "_uid": uid})
    return sorted(out, key=lambda s: (s["description"], s["uid_hash"]))


def load_folder_scan(scan_id: str, d: Path, uid_hash: str) -> Scan:
    for s in folder_series(d):
        if s["uid_hash"] == uid_hash:
            return _read(_files(d, s["_uid"]), scan_id, scan_id, "folder")  # no patient name: the id stands in
    raise FileNotFoundError(scan_id)


def study_date(d: Path) -> str | None:
    """StudyDate of a series folder as YYYY-MM-DD, from the first file whose header reads (no pixels). None when there is no file, no tag or a bad date."""
    try:
        files = sorted(f for f in d.iterdir() if not f.name.startswith("."))  # one file, not GDCM's scan of the whole folder (about 0.5 s a series)
    except OSError:
        return None
    for f in files:
        r = sitk.ImageFileReader()
        r.SetImageIO("GDCMImageIO")  # DICOM only: a PNG would read, without a StudyDate
        r.SetFileName(str(f))
        try:
            r.ReadImageInformation()
        except RuntimeError:  # not DICOM: try the next file
            continue
        try:
            return _date(r.GetMetaData("0008|0020"))
        except (RuntimeError, ValueError):
            return None
    return None


def baseline_days(root: Path, patient: str, date: str | None) -> int:
    """Whole days from the patient's earliest test/retest study date to `date`. Reads one header in each series folder, never pixels. 0 when a date is missing."""
    if date is None:
        return 0
    dates = [study_date(d) for d in (root / patient / "ct_test", root / patient / "ct_retest") if d.is_dir()]
    if not dates or None in dates:
        return 0
    return (datetime.strptime(date, "%Y-%m-%d") - datetime.strptime(min(dates), "%Y-%m-%d")).days


def _date(v: str) -> str:
    return datetime.strptime(v.strip(), "%Y%m%d").strftime("%Y-%m-%d")


def _tag(r: sitk.ImageSeriesReader, tag: str, conv):
    """First file's header value converted, None when missing or unparsable."""
    try:
        v = conv(r.GetMetaData(0, tag))
    except (RuntimeError, ValueError):
        return None
    return None if isinstance(v, float) and not math.isfinite(v) else v  # "nan"/"inf" would break the JSON reply
