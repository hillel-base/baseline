import pytest
import base64, json
import numpy as np, SimpleITK as sitk
from conftest import BallSegmenter
from lung_engine.demo import lung_png, reindex, subvolume
from lung_engine.outline import OutlineSession
from lung_engine.scans import load_scan


def started(dicom_series):
    scan = load_scan(dicom_series, "RIDER-TEST01_test")
    payload, _ = OutlineSession(BallSegmenter()).start(scan, (4, 32, 32))
    return scan, payload


def test_subvolume_and_reindex_shift_by_the_start(dicom_series):
    scan, p = started(dicom_series)
    z0, z1 = subvolume(scan, p)
    assert (z0, z1) == (0, 8)
    r = reindex(p, 1)
    assert r["bbox"][0] == p["bbox"][0] - 1 and r["bbox"][3] == p["bbox"][3] - 1 and r["bbox"][1:3] == p["bbox"][1:3]
    assert r["axis_z"] == p["axis_z"] - 1 and [c["z"] for c in r["clicks"]] == [c["z"] - 1 for c in p["clicks"]]
    assert {k: v for k, v in r.items() if k not in ("bbox", "axis_z", "clicks")} == {k: v for k, v in p.items() if k not in ("bbox", "axis_z", "clicks")}
    json.dumps(r)


def test_png_pixel_is_the_lung_window_of_its_hu(dicom_series, tmp_path):
    scan, _ = started(dicom_series)
    sitk.WriteImage(sitk.GetImageFromArray(lung_png(scan.array[4])), str(tmp_path / "4.png"))
    png = sitk.GetArrayFromImage(sitk.ReadImage(str(tmp_path / "4.png")))
    assert png.shape == (64, 64) and png.dtype == np.uint8
    assert png[32, 32] == lung_png(40) == 236 and png[0, 0] == lung_png(-1000) == 60
    assert list(lung_png([-1350, -1000, -600, 150, 400])) == [0, 60, 128, 255, 255]


def ball(shape, c, r):
    return sum((i - k) ** 2 for i, k in zip(np.indices(shape), c)) <= r ** 2


def fake_expert(shape=(8, 64, 64)):
    return ball(shape, (4, 32, 32), 6) & ~ball(shape, (4, 32, 32), 0)  # r=6 ball: bigger than the BallSegmenter's r=3


def record_one(dicom_series, out, expert):
    import sys
    sys.path.insert(0, str(__import__("pathlib").Path(__file__).parents[1] / "scripts"))
    from record_demo import record
    return record(dicom_series, out, BallSegmenter(), patients=["RIDER-TEST01"], expert_for=lambda *a: expert)


def test_record_writes_every_file_and_both_steps_share_one_sub_volume(dicom_series, tmp_path):
    out = tmp_path / "demo"
    (out / "RIDER-TEST01_test" / "slices").mkdir(parents=True)
    (out / "RIDER-TEST01_test" / "slices" / "stale.png").write_text("x")
    record_one(dicom_series, out, fake_expert())
    d = out / "RIDER-TEST01_test"
    assert len(list((d / "slices").glob("*.png"))) == 8 and not (d / "slices" / "stale.png").exists()
    assert json.loads((d / "meta.json").read_text())["instance_numbers"] == list(range(8, 0, -1))
    o = json.loads((d / "outline.json").read_text())
    assert o["case"] == "RIDER-TEST01_test" and [s["label"] for s in o["steps"]] == ["First click", "After 2 corrections"]
    a, b = (s["outline"] for s in o["steps"])
    assert a["bbox"][0] >= 0 and b["bbox"][3] <= 8 and len(a["clicks"]) == 1 and len(b["clicks"]) == 3
    assert b["clicks"][0] == a["clicks"][0] and b["volume_ml"] > a["volume_ml"]
    idx = json.loads((out / "index.json").read_text())
    assert idx["note"] == "Recorded results, not a live model" and len(idx["cases"]) == 1
    assert idx["cases"][0]["steps"][1]["dice"] > idx["cases"][0]["steps"][0]["dice"]


def session_on(dicom_series):
    scan = load_scan(dicom_series, "RIDER-TEST01_test")
    s = OutlineSession(BallSegmenter())
    s.start(scan, (4, 32, 32))
    return s


def test_correction_is_plus_when_the_missed_part_is_larger_and_minus_otherwise(dicom_series):
    from lung_engine.demo import correct
    s = session_on(dicom_series)
    assert correct(s, fake_expert() | ball((8, 64, 64), (4, 32, 32), 3), 1) == 1  # missed shell > excess (none)
    assert s.clicks[-1]["positive"]
    s = session_on(dicom_series)
    assert correct(s, ball((8, 64, 64), (4, 32, 32), 1), 1) == 1  # r=3 outline is all excess
    assert not s.clicks[-1]["positive"]


def test_a_refused_correction_falls_back_to_the_next_piece(dicom_series):
    from lung_engine.demo import correct
    s = session_on(dicom_series)
    big, small = ball((8, 64, 64), (4, 10, 10), 3), ball((8, 64, 64), (4, 50, 50), 2)
    arr = s.scan.array.copy()
    arr[small] = 40
    arr[big] = -1000  # the larger missed piece is air: a + click there is refused
    object.__setattr__(s.scan, "array", arr)
    expert = ball((8, 64, 64), (4, 32, 32), 3) | big | small
    assert correct(s, expert, 1) == 1
    c = s.clicks[-1]
    assert c["positive"] and abs(c["x"] - 50) <= 2  # fell back to the small piece


def test_correction_stops_when_nothing_is_accepted_or_nothing_differs(dicom_series):
    from lung_engine.demo import correct
    s = session_on(dicom_series)
    assert correct(s, ball((8, 64, 64), (4, 32, 32), 3)) == 0
    assert len(s.clicks) == 1


def test_subvolume_keeps_the_whole_z_range_of_a_tall_outline():
    from types import SimpleNamespace
    scan = SimpleNamespace(array=np.zeros((200, 1, 1)))
    assert subvolume(scan, {"bbox": [50, 0, 0, 120, 1, 1]}) == (45, 125)
    assert subvolume(scan, {"bbox": [2, 0, 0, 198, 1, 1]}) == (0, 200)


def test_subvolume_covers_the_union_and_reindex_refuses_an_uncovered_outline():
    from types import SimpleNamespace
    scan = SimpleNamespace(array=np.zeros((200, 1, 1)))
    a, b = {"bbox": [50, 0, 0, 60, 1, 1]}, {"bbox": [40, 0, 0, 70, 1, 1]}
    assert subvolume(scan, a, b) == (35, 75)
    with pytest.raises(AssertionError):
        reindex({**a, "clicks": [], "axis_z": 55}, 51)
