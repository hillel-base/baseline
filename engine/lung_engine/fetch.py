"""Download the three practice patients (RIDER test/retest CT + RIDER-LungCT-Seg) from NCI Imaging Data Commons.

Usage: python -m lung_engine.fetch --data DIR      (idc-index, anonymous, same files as TCIA)
       python -m lung_engine.fetch --weights       (the nnInteractive model weights, the engine's own download)
Layout the engine reads: <data>/<patient>/{ct_test,ct_retest,lungctseg_test,lungctseg_retest}/*.dcm
DATA RULE: only the three PATIENTS below are ever selected or downloaded.
"""
import argparse, glob, os, re, shutil, sys
from pathlib import Path

from .events import REPO

PATIENTS = ("RIDER-2541949645", "RIDER-1286684383", "RIDER-2619750334")
DIRS = ("ct_test", "ct_retest", "lungctseg_test", "lungctseg_retest")
NEED_GB = 1.5


def select_seg(index):
    """The test/retest lung-CT segmentations of the three patients; the name filter comes before anything is downloaded."""
    df = index[index.PatientID.isin(PATIENTS) & (index.Modality == "SEG")]
    return df[df.SeriesDescription.fillna("").str.match(r"RIDER-\d+_\d+_(RE)?TEST$")]


def keep_ct(index, refs, todo):
    """Safeguard: of the CT series a segmentation points to, keep only those whose PatientID is a development patient in `todo`."""
    ok = index[index.PatientID.isin(todo) & (index.Modality == "CT")].SeriesInstanceUID
    return {k: v for k, v in refs.items() if v in set(ok)}


def missing(data: Path) -> list[str]:
    return [p for p in PATIENTS if not all(glob.glob(str(data / p / d / "*.dcm")) for d in DIRS)]


def _client():
    from idc_index import index
    return index.IDCClient()


def _download(c, uids, dest: Path):
    c.download_from_selection(downloadDir=str(dest), seriesInstanceUID=list(uids), dirTemplate="%SeriesInstanceUID", quiet=True)


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
    cts = keep_ct(c.index, cts, todo)
    _download(c, set(cts.values()), stage)
    for (patient, side), ref in cts.items():
        dst = data / patient / f"ct_{side}"
        shutil.rmtree(dst, ignore_errors=True)
        os.replace(stage / ref, dst)
    shutil.rmtree(stage, ignore_errors=True)


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--data")
    ap.add_argument("--weights", action="store_true")
    a = ap.parse_args(argv)
    if a.weights:
        from nnInteractive.model_management import ensure_model_available, get_default_model_id
        ensure_model_available(get_default_model_id())
        return
    data = Path(a.data or os.environ.get("LUNG_DATA_DIR") or REPO / "data" / "rider").resolve()
    todo = missing(data)
    if not todo:
        print("practice scans: all present, nothing to download")
        return
    data.mkdir(parents=True, exist_ok=True)
    free = shutil.disk_usage(data).free / 1e9
    if free < NEED_GB:
        sys.exit(f"Not enough free disk space: {free:.1f} GB free, {NEED_GB} GB needed for the practice scans. Free some space and run again.")
    print(f"practice scans: downloading {len(todo)} patient(s)", flush=True)
    fetch_patients(data, todo)
    left = missing(data)
    if left:
        sys.exit(f"Practice scans incomplete after download: {left}")
    print("practice scans: done")


if __name__ == "__main__":
    main()
