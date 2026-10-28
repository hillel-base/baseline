"""Download the practice patients (RIDER test/retest CT; RIDER-LungCT-Seg for the 3 development patients) from NCI Imaging Data Commons.

Usage: python -m lung_engine.fetch --data DIR [--all]  (idc-index, anonymous, same files as TCIA)
       python -m lung_engine.fetch --weights            (the nnInteractive model weights, the engine's own download)
Layout the engine reads: <data>/<patient>/{ct_test,ct_retest}/*.dcm, plus {lungctseg_test,lungctseg_retest} for the 3 development patients.
DATA RULE: only the patients below are ever selected or downloaded. By default PRACTICE, 8 patients: the 3 development PATIENTS
with their expert outlines (RIDER-LungCT-Seg), and 5 more with their CT only. --all adds the other 20 (CT only): ALL, 28 patients,
the same as the practice server. The study's results are final, so the timed and held-out patients are public practice cases now.
Expert outlines stay limited to the 3 development PATIENTS (select_seg). A CT-only patient's CT is the series that its
RIDER-LungCT-Seg test or retest segmentation points to, read from IDC's seg_index: that segmentation is never downloaded, but the
seg_index itself is, once (public metadata on every IDC segmentation, about 6.5 MB, from IDC's release on GitHub).
"""
import argparse, glob, os, re, shutil, sys
from pathlib import Path

from .events import REPO

PATIENTS = ("RIDER-2541949645", "RIDER-1286684383", "RIDER-2619750334")  # development patients: CT and expert outlines
# the default: 5 more (3 small, 3 medium, 2 large with the 3 above), CT only
PRACTICE = PATIENTS + ("RIDER-1867199702", "RIDER-1825099523", "RIDER-1346917136", "RIDER-2357766186", "RIDER-1225316081")
# app.py's practice set is ALL: a patient listed here keeps its name as its study code on the hosted page (Base44 gets it)
ALL = PRACTICE + (  # --all: the practice server's other 20, CT only
    "RIDER-1129164940", "RIDER-1332496276", "RIDER-1344011628", "RIDER-1500037140", "RIDER-1532432635", "RIDER-1760553574",
    "RIDER-1801720707", "RIDER-2016615262", "RIDER-2073083717", "RIDER-2151469008", "RIDER-2539508879", "RIDER-2655999012",
    "RIDER-2669524182", "RIDER-2799584460", "RIDER-3023568408", "RIDER-3115188676", "RIDER-3152132495", "RIDER-3160137230",
    "RIDER-6324870494", "RIDER-9763310455")
DIRS = ("ct_test", "ct_retest", "lungctseg_test", "lungctseg_retest")
GB_DEV, GB_CT, ROOM_GB = 0.31, 0.26, 1.0  # per patient, from IDC's series sizes (2.1 GB for the 8, 7.2 GB for the 28), plus room


def need_gb(todo) -> float:
    """Free disk the download of the patients in `todo` needs."""
    return round(ROOM_GB + sum(GB_DEV if p in PATIENTS else GB_CT for p in todo), 1)


def _seg_rows(index, patients):
    df = index[index.PatientID.isin(patients) & (index.Modality == "SEG")]
    return df[df.SeriesDescription.fillna("").str.match(r"RIDER-\d+_\d+_(RE)?TEST$")]


def select_seg(index):
    """The test/retest lung-CT segmentations of the three development patients; the name filter comes before anything is downloaded."""
    return _seg_rows(index, PATIENTS)


def select_ct(index, seg_index, patients) -> dict:
    """(patient, side) -> the CT series that patient's test/retest segmentation points to, from the two indexes only (nothing downloaded)."""
    m = _seg_rows(index, patients).merge(seg_index[["SeriesInstanceUID", "segmented_SeriesInstanceUID"]], on="SeriesInstanceUID")
    return {(r.PatientID, "retest" if r.SeriesDescription.endswith("RETEST") else "test"): r.segmented_SeriesInstanceUID for r in m.itertuples()}


def keep_ct(index, refs, todo):
    """Safeguard: of the CT series a segmentation points to, keep only those whose PatientID is a patient in `todo`."""
    ok = index[index.PatientID.isin(todo) & (index.Modality == "CT")].SeriesInstanceUID
    return {k: v for k, v in refs.items() if v in set(ok)}


def missing(data: Path, patients=PRACTICE) -> list[str]:
    return [p for p in patients if not all(glob.glob(str(data / p / d / "*.dcm")) for d in (DIRS if p in PATIENTS else DIRS[:2]))]


def _client():
    from idc_index import index
    return index.IDCClient()


def _download(c, uids, dest: Path):
    uids = list(uids)
    if not uids:  # never an empty selection: it must not reach idc-index
        return
    c.download_from_selection(downloadDir=str(dest), seriesInstanceUID=uids, dirTemplate="%SeriesInstanceUID", quiet=True)


def fetch_patients(data: Path, todo: list[str]):
    import pydicom
    c = _client()
    sel = select_seg(c.index)
    sel = sel[sel.PatientID.isin(todo)]
    stage = data / ".download"
    _download(c, sel.SeriesInstanceUID, stage)
    cts = {}
    for _, s in sel.iterrows():
        side = "retest" if s.SeriesDescription.endswith("RETEST") else "test"
        src = stage / s.SeriesInstanceUID
        ref = pydicom.dcmread(glob.glob(str(src / "*.dcm"))[0], stop_before_pixels=True).ReferencedSeriesSequence[0].SeriesInstanceUID
        cts[(s.PatientID, side)] = ref
        dst = data / s.PatientID / f"lungctseg_{side}"
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.rmtree(dst, ignore_errors=True)
        os.replace(src, dst)
    if others := [p for p in todo if p not in PATIENTS]:
        try:
            c.fetch_index("seg_index")  # a small file from GitHub: it says which CT series each practice patient has
        except Exception:  # any network library's error: a first install gets one plain line, not a traceback
            c.seg_index = None
        if getattr(c, "seg_index", None) is None:
            sys.exit("Could not reach the public data index. Check the internet connection and run the same command again.")
        cts.update(select_ct(c.index, c.seg_index, others))
    cts = keep_ct(c.index, cts, todo)
    _download(c, set(cts.values()), stage)
    for (patient, side), ref in cts.items():
        dst = data / patient / f"ct_{side}"
        dst.parent.mkdir(parents=True, exist_ok=True)  # a CT-only patient has no folder yet
        shutil.rmtree(dst, ignore_errors=True)
        os.replace(stage / ref, dst)
    shutil.rmtree(stage, ignore_errors=True)


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--data")
    ap.add_argument("--weights", action="store_true")
    ap.add_argument("--all", action="store_true", help="all 28 practice patients (about 7.2 GB), not the default 8 (about 2.1 GB)")
    a = ap.parse_args(argv)
    if a.weights:
        from nnInteractive.model_management import ensure_model_available, get_default_model_id
        ensure_model_available(get_default_model_id())
        return
    data = Path(a.data or os.environ.get("LUNG_DATA_DIR") or REPO / "data" / "rider").resolve()
    todo = missing(data, ALL if a.all else PRACTICE)
    if not todo:
        print("practice scans: all present, nothing to download")
        return
    data.mkdir(parents=True, exist_ok=True)
    free, need = shutil.disk_usage(data).free / 1e9, need_gb(todo)
    if free < need:
        sys.exit(f"Not enough free disk space: {free:.1f} GB free, {need} GB needed for the practice scans. Free some space and run again.")
    print(f"practice scans: downloading {len(todo)} patient(s)", flush=True)
    fetch_patients(data, todo)
    left = missing(data, todo)
    if left:
        sys.exit(f"Practice scans incomplete after download: {left}")
    print("practice scans: done")


if __name__ == "__main__":
    main()
