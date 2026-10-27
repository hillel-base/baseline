"""One real nnInteractive click on the RIDER-1286684383 test scan (development set), compared to the expert outline."""
import glob
import os

os.environ["PYTORCH_ENABLE_MPS_FALLBACK"] = "1"  # as the server sets it, before torch is imported
import time
from pathlib import Path

import numpy as np
import pytest
import SimpleITK as sitk
from scipy import ndimage

DATA = Path(os.environ.get("LUNG_DATA_DIR", Path(__file__).resolve().parents[2] / "data" / "rider"))
PATIENT = "RIDER-1286684383"

pytestmark = [pytest.mark.model, pytest.mark.data]


def expert_mask(ct, series="test"):
    """The one MANUAL segment of the DICOM SEG, on the CT grid."""
    import pydicom
    ds = pydicom.dcmread(glob.glob(str(DATA / PATIENT / f"lungctseg_{series}" / "*.dcm"))[0])
    frames = ds.pixel_array.reshape(-1, ds.Rows, ds.Columns)
    manual = [s.SegmentNumber for s in ds.SegmentSequence if s.get("SegmentAlgorithmType") == "MANUAL"]
    assert len(manual) == 1
    out = np.zeros(ct.GetSize()[::-1], bool)
    for f, fg in zip(frames, ds.PerFrameFunctionalGroupsSequence):
        if fg.SegmentIdentificationSequence[0].ReferencedSegmentNumber == manual[0]:
            pos = [float(v) for v in fg.PlanePositionSequence[0].ImagePositionPatient]
            out[ct.TransformPhysicalPointToIndex(pos)[2]] |= f.astype(bool)
    return out


def deepest(mask):
    """Voxel (z,y,x) deepest inside the largest connected piece of mask (on its bounding box: the full-volume
    distance transform needs ~5 GB)."""
    idx = np.argwhere(mask)
    lo = idx.min(0)
    sub = mask[tuple(slice(a, b + 1) for a, b in zip(lo, idx.max(0)))]
    lab, _ = ndimage.label(sub)
    big = lab == (np.argmax(np.bincount(lab.ravel())[1:]) + 1)
    d = ndimage.distance_transform_edt(np.pad(big, 1))[1:-1, 1:-1, 1:-1]
    return tuple(int(i + o) for i, o in zip(np.unravel_index(np.argmax(d), d.shape), lo))


def full(sess):
    m = np.zeros(sess.scan.array.shape, bool)
    m[tuple(slice(a, b) for a, b in zip(sess.lo, sess.hi))] = sess.mask
    return m


@pytest.fixture(scope="module")
def segmenter():
    """One model for the module, as the engine keeps one for its lifetime."""
    import torch
    if not (DATA / PATIENT / "lungctseg_test").is_dir():
        pytest.skip("RIDER data not found")
    if not (torch.backends.mps.is_available() or torch.cuda.is_available()):
        pytest.skip("no graphics chip")
    from nnInteractive.model_management import get_local_model_dir, get_default_model_id
    if not (get_local_model_dir(get_default_model_id()) / "inference_session_class.json").exists():
        pytest.skip("nnInteractive weights not downloaded")
    from lung_engine.nni import NNISegmenter
    return NNISegmenter()


@pytest.fixture(scope="module")
def scan(segmenter):
    """Loaded once, as the engine keeps loaded scans."""
    from lung_engine.scans import load_scan
    return load_scan(DATA, f"{PATIENT}_test")


def test_real_nninteractive_on_rider(segmenter, scan):
    from lung_engine.outline import OutlineSession

    assert segmenter.session.configuration_manager.patch_size == [160, 160, 160]  # spike S6
    expert = expert_mask(scan.image)
    sess = OutlineSession(segmenter)
    dice = lambda m: 2 * (expert & m).sum() / (expert.sum() + m.sum())
    click = deepest(expert)
    t = time.perf_counter()
    out, first_mask = sess.start(scan, click)
    seconds = time.perf_counter() - t
    first = dice(first_mask)
    # One click on this scan misses much of the tumour (spike S1: Dice 0.23), so correct it as the spike did:
    # up to two more clicks at the deepest point of the biggest error, + for missed tumour, - for excess.
    for _ in range(2):
        m = full(sess)
        missed, excess = expert & ~m, m & ~expert
        positive = missed.sum() >= excess.sum()
        out = sess.click(deepest(missed if positive else excess), positive)
    final = dice(full(sess))
    print(f"\nreal: Dice {first:.3f} after 1 click ({seconds:.1f} s), {final:.3f} after 3; edge {out['at_window_edge']}; "
          f"long {out['long_mm']} short {out['short_mm']} vol {out['volume_ml']}")
    assert seconds < 10 and final > 0.6


def test_clicks_on_air_keep_the_engine_alive(segmenter, scan, monkeypatch):
    """Regression: on air, autozoom ran the model 3 more times and the memory watchdog killed the engine.
    Tumour, air, air past the guard, tumour: one model run per start, the engine lives, the tumour returns.
    The watchdog in the engine is the memory check."""
    import math
    from lung_engine.outline import OnAir, OutlineSession

    sess = OutlineSession(segmenter)
    net, runs = segmenter.session.network, []
    fwd = net.forward
    monkeypatch.setattr(net, "forward", lambda x, *a, **k: (runs.append(1), fwd(x, *a, **k))[1])

    tumour, air = (161, 321, 330), (150, 4, 4)  # air: outside the body, -1024 HU
    first, _ = sess.start(scan, tumour)
    with pytest.raises(OnAir):
        sess.start(scan, air)
    with monkeypatch.context() as m:  # air the guard misses (outside air is often above -950 HU) reaches the model
        m.setattr("lung_engine.outline.AIR_HU", -2000)
        on_air, _ = sess.start(scan, air)
    third, _ = sess.start(scan, tumour)
    print(f"\nreal: {len(runs)} model runs; air past the guard outlines {on_air['volume_ml']} mL")
    assert len(runs) == 3  # one per start that reaches the model; autozoom made it 4 for the air start alone
    assert on_air["volume_ml"] < 1000 and all(math.isfinite(on_air[k]) for k in ("volume_ml", "long_mm", "short_mm"))
    assert first["volume_ml"] > 1 and (third["bbox"], third["volume_ml"]) == (first["bbox"], first["volume_ml"])


def test_real_minus_click_and_undo(segmenter, scan):
    from lung_engine.outline import NothingToUndo, OutlineSession

    expert = expert_mask(scan.image)
    sess = OutlineSession(segmenter)
    a, _ = sess.start(scan, (161, 321, 330))
    first = full(sess)
    excess = first & ~expert
    b = sess.click(deepest(excess), False)  # the deepest point of the biggest false-positive region
    after = full(sess)
    u = sess.undo()
    print(f"\nreal: volume {a['volume_ml']} mL after start, {b['volume_ml']} after the - click, {u['volume_ml']} after undo")
    assert b["volume_ml"] < a["volume_ml"] and (after != first).any()
    assert (full(sess) == first).all() and u["volume_ml"] == a["volume_ml"] and not u["can_undo"]
    with pytest.raises(NothingToUndo):
        sess.undo()


def test_real_followup_refinds_one_pair():
    """Align retest to test (RIDER-1286684383, development set); the test expert centroid, mapped,
    should land inside the retest MANUAL mask. Registration only: no model, no graphics chip."""
    from lung_engine.followup import map_index, register
    from lung_engine.scans import load_scan
    if not (DATA / PATIENT / "lungctseg_retest").is_dir():
        pytest.skip("RIDER data not found")
    a, b = load_scan(DATA, f"{PATIENT}_test"), load_scan(DATA, f"{PATIENT}_retest")
    src, dst = expert_mask(a.image), expert_mask(b.image, "retest")
    start = np.round(np.argwhere(src).mean(0)).astype(int)
    t0 = time.perf_counter()
    got = map_index(register(a.image, b.image), a.image, b.image, tuple(start))
    seconds = time.perf_counter() - t0
    target = np.argwhere(dst).mean(0)
    mm = np.linalg.norm((np.array(got) - target) * np.array(b.spacing)[::-1])
    print(f"\nreal: mapped {got}, retest expert centroid {np.round(target, 1)}, {mm:.1f} mm apart, {seconds:.1f} s, inside {dst[got]}")
    assert dst[got]
