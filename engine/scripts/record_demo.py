"""Record the Demo: per development case the first click and up to 2 corrections from the real engine, saved as files the hosted page replays.
Run under the GPU lock: uv run --directory engine python scripts/record_demo.py <data/rider> [<out>]"""
import glob
import json
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # so `python -I` finds lung_engine

import numpy as np
import pydicom
import SimpleITK as sitk

from lung_engine.demo import correct, deepest_voxels, full_mask, lung_png, reindex, subvolume
from lung_engine.events import REPO, _commit
from lung_engine.outline import OutlineSession
from lung_engine.scans import head_dir, load_scan

PATIENTS = ["RIDER-2541949645", "RIDER-1286684383", "RIDER-2619750334"]  # development set: small, medium, large
MAX_BYTES, MAX_FILES = 40_000_000, 1000
CREDIT = ["RIDER Lung CT. Zhao, B., Schwartz, L. H., Kris, M. G., & Riely, G. J. (2015). Coffee-break lung CT collection with scan images reconstructed at multiple imaging parameters (Version 3). The Cancer Imaging Archive. https://doi.org/10.7937/k9/tcia.2015.u1x8a5nr (CC BY 4.0)",
          "RIDER-LungCT-Seg. Wee, L., Aerts, H. J. W. L., Kalendralis, P., & Dekker, A. (2020). RIDER Lung CT Segmentation Labels from: Decoding tumour phenotype by noninvasive imaging using a quantitative radiomics approach [Data set]. The Cancer Imaging Archive. https://doi.org/10.7937/tcia.2020.jit9grk8 (CC BY 3.0)"]


def expert_mask(data, patient, ct):
    """The MANUAL segment of the DICOM SEG on the CT grid, bool (z,y,x)."""
    ds = pydicom.dcmread(glob.glob(str(data / patient / "lungctseg_test" / "*.dcm"))[0])
    frames = ds.pixel_array.reshape(-1, ds.Rows, ds.Columns)
    manual = [s.SegmentNumber for s in ds.SegmentSequence if s.get("SegmentAlgorithmType") == "MANUAL"]
    assert len(manual) == 1
    mask = np.zeros(ct.GetSize()[::-1], bool)
    for f, fg in zip(frames, ds.PerFrameFunctionalGroupsSequence):
        if fg.SegmentIdentificationSequence[0].ReferencedSegmentNumber == manual[0]:
            pos = [float(v) for v in fg.PlanePositionSequence[0].ImagePositionPatient]
            mask[ct.TransformPhysicalPointToIndex(pos)[2]] |= f.astype(bool)
    return mask


def dice(a, b) -> float:
    return round(2 * (a & b).sum() / (a.sum() + b.sum()), 3)


def numbers(payload, mask, expert) -> dict:
    return {"clicks": [[c["z"], c["y"], c["x"], "+" if c["positive"] else "-"] for c in payload["clicks"]],
            "volume_ml": payload["volume_ml"], "long_mm": payload["long_mm"], "short_mm": payload["short_mm"],
            "depth_mm": payload["depth_mm"], "dice": dice(mask, expert)}


def record(data: Path, out: Path, segmenter, edge=True, patients=PATIENTS, expert_for=expert_mask):
    session, cases = OutlineSession(segmenter, edge), []
    for patient in patients:
        scan = load_scan(data, f"{patient}_test")
        expert = expert_for(data, patient, scan.image)
        payload, first_mask = session.start(scan, deepest_voxels(expert)[0])  # the first click: the deepest voxel of the largest piece
        first = dict(payload, **numbers(payload, first_mask, expert))
        n = correct(session, expert)
        final = session._payload(0.0)
        final = dict(final, **numbers(final, full_mask(session), expert))
        z0, z1 = subvolume(scan, first, final)
        steps = [{"label": "First click", "clicks": first["clicks"], "outline": reindex(payload, z0)},
                 {"label": f"After {n} correction{'' if n == 1 else 's'}", "clicks": final["clicks"], "outline": reindex(session._payload(0.0), z0)}]
        d = out / scan.id
        shutil.rmtree(d / "slices", ignore_errors=True)  # no stale slices from an earlier, longer recording
        (d / "slices").mkdir(parents=True, exist_ok=True)
        for k, z in enumerate(range(z0, z1)):
            sitk.WriteImage(sitk.GetImageFromArray(lung_png(scan.array[z])), str(d / "slices" / f"{k}.png"))
        meta = {"id": scan.id, "patient": scan.patient, "series": scan.series, "shape": [z1 - z0, *scan.array.shape[1:]],
                "spacing": list(scan.spacing), "head_dir": head_dir(scan),
                "instance_numbers": scan.instance_numbers and scan.instance_numbers[z0:z1]}
        (d / "meta.json").write_text(json.dumps(meta))
        (d / "outline.json").write_text(json.dumps({"case": scan.id, "steps": steps}))
        cases.append({"id": scan.id, "slices": z1 - z0, "z0": z0, "steps": [{"label": st["label"], **{k: v[k] for v in [x] for k in
                      ("clicks", "volume_ml", "long_mm", "short_mm", "depth_mm", "dice")}} for st, x in zip(steps, [first, final])]})
        files = [f for f in out.rglob("*") if f.is_file()]
        size = sum(f.stat().st_size for f in files)
        print(cases[-1], f"total {size / 1e6:.1f} MB, {len(files)} files", flush=True)
        if size > MAX_BYTES or len(files) > MAX_FILES:
            sys.exit(f"stopped after {scan.id}: {size} bytes, {len(files)} files is over the limit ({MAX_BYTES} bytes, {MAX_FILES} files)")
    (out / "index.json").write_text(json.dumps({"cases": cases, "engine_commit": _commit(), "note": "Recorded results, not a live model",
                                                "attribution": CREDIT}))
    return cases


if __name__ == "__main__":
    from lung_engine.nni import NNISegmenter
    record(Path(sys.argv[1]), Path(sys.argv[2] if len(sys.argv) > 2 else REPO / "web/public/demo"), NNISegmenter())
