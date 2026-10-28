import json
import os
from pathlib import Path

import numpy as np
import pydicom
import pytest
from pydicom.dataset import FileDataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, generate_uid

from lung_engine import study_index as si


def dcm(path: Path, *, pid="P1", name="Test^Alpha", date="20200101", study="1.2.3", series="1.2.3.4",
        modality="CT", image_type=("ORIGINAL", "PRIMARY", "AXIAL"), desc=None, number=3, kernel="B30f",
        thick=1.25, iop=(1, 0, 0, 0, 1, 0), sop="1.2.840.10008.5.1.4.1.1.2", burned=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    meta = FileMetaDataset()
    meta.TransferSyntaxUID = ExplicitVRLittleEndian
    meta.MediaStorageSOPClassUID = sop
    meta.MediaStorageSOPInstanceUID = generate_uid()
    ds = FileDataset(str(path), {}, file_meta=meta, preamble=b"\0" * 128)
    ds.PatientID, ds.PatientName, ds.StudyDate = pid, name, date
    ds.StudyInstanceUID, ds.SeriesInstanceUID = study, series
    ds.Modality, ds.SeriesNumber, ds.SOPClassUID = modality, number, sop
    if image_type is not None:
        ds.ImageType = image_type if isinstance(image_type, str) else list(image_type)
    if iop is not None:
        ds.ImageOrientationPatient = list(iop)
    if burned:
        ds.BurnedInAnnotation = burned
    if desc:
        ds.SeriesDescription = desc
    ds.ConvolutionKernel, ds.SliceThickness = kernel, thick
    ds.Rows = ds.Columns = 2
    ds.BitsAllocated, ds.BitsStored, ds.HighBit, ds.PixelRepresentation = 16, 16, 15, 0
    ds.SamplesPerPixel, ds.PhotometricInterpretation = 1, "MONOCHROME2"
    ds.PixelData = np.zeros((2, 2), np.uint16).tobytes()
    ds.save_as(path)


def put(folder: Path, n=2, **kw):
    for i in range(n):
        dcm(folder / f"{i}.dcm", **kw)


def test_one_patient_two_folder_names(tmp_path):
    put(tmp_path / "a", series="1.1")
    put(tmp_path / "b" / "deep", series="1.2", date="20200201", study="9.9")
    out = si.index_folder(tmp_path, tmp_path / "c.json")
    assert {e["patient_key"] for e in out} == {"P1"}
    assert len(out) == 2
    e = next(e for e in out if e["folder"] == "b/deep")
    assert e["study_date"] == "2020-02-01" and e["images"] == 2 and e["kernel"] == "B30f"
    assert e["slice_mm"] == 1.25 and e["patient_name"] == "Test^Alpha"
    assert len(e["series_uid_hash"]) == 12 and "1.2" not in e["series_uid_hash"].split()


def test_two_series_in_one_folder(tmp_path):
    dcm(tmp_path / "f" / "a1.dcm", series="1.1")
    dcm(tmp_path / "f" / "a2.dcm", series="1.1")
    dcm(tmp_path / "f" / "b1.dcm", series="1.2")
    dcm(tmp_path / "f" / "b2.dcm", series="1.2")
    out = si.index_folder(tmp_path, tmp_path / "c.json")
    assert sorted(e["images"] for e in out) == [2, 2]
    assert len({e["series_uid_hash"] for e in out}) == 2


def test_drops_localizer_and_non_ct(tmp_path):
    put(tmp_path / "ok", series="1.1")
    put(tmp_path / "loc", series="1.2", image_type=("ORIGINAL", "PRIMARY", "LOCALIZER"))
    put(tmp_path / "mr", series="1.3", modality="MR")
    out = si.index_folder(tmp_path, tmp_path / "c.json")
    assert [e["folder"] for e in out] == ["ok"]


def test_patient_key_fallbacks(tmp_path):
    put(tmp_path / "a", pid="", series="1.1", name="Test^Beta")
    put(tmp_path / "b", pid="", name="", series="1.2")
    out = {e["folder"]: e["patient_key"] for e in si.index_folder(tmp_path, tmp_path / "c.json")}
    assert out == {"a": "Test^Beta", "b": "b"}


def test_label():
    assert si.label({"description": "Chest 1mm"}) == "Chest 1mm"
    e = {"description": "", "series_number": 3, "kernel": "B30f", "slice_mm": 1.25, "images": 300}
    assert si.label(e) == "Series 3 · B30f · 1.25 mm · 300 images"
    assert si.label({"description": None, "series_number": None, "kernel": None, "slice_mm": 2.0, "images": 1}) \
        == "2 mm · 1 images"


def test_timeline():
    def e(k, d, s):
        return {"patient_key": k, "study_date": d, "series_uid_hash": s}
    out = si.timeline([e("A", "2020-01-11", "s2"), e("A", "2020-01-01", "s1"), e("A", "2020-01-11", "s3"),
                       e("B", "2021-05-05", "s4")])
    a = next(p for p in out if p["patient_key"] == "A")["scans"]
    assert [(s["timepoint"], s["day"]) for s in a] == [("Baseline", 0), ("Follow-up", 10), ("Follow-up", 10)]
    assert a[0]["series_uid_hash"] == "s1"
    b = next(p for p in out if p["patient_key"] == "B")["scans"]
    assert b[0]["timepoint"] == "Baseline"


def counting(monkeypatch):
    calls = []
    real = si.dcmread
    monkeypatch.setattr(si, "dcmread", lambda *a, **k: (calls.append(1), real(*a, **k))[1])
    return calls


def test_every_header_read(tmp_path, monkeypatch):
    put(tmp_path / "f", n=6)
    calls = counting(monkeypatch)
    out = si.index_folder(tmp_path, tmp_path / "c.json")
    assert out[0]["images"] == 6 and len(calls) == 6  # every header is read, never a sample


def test_cache_hit_and_refresh(tmp_path, monkeypatch):
    put(tmp_path / "f", series="1.1")
    cache = tmp_path.parent / (tmp_path.name + "-cache.json")
    si.index_folder(tmp_path, cache)
    calls = counting(monkeypatch)
    assert len(si.index_folder(tmp_path, cache)) == 1 and calls == []
    dcm(tmp_path / "f" / "x.dcm", series="1.2")
    os.utime(tmp_path / "f", (1, 1))  # force a different mtime on fast file systems
    out = si.index_folder(tmp_path, cache)
    assert len(out) == 2 and calls


def test_damaged_cache(tmp_path):
    put(tmp_path / "f")
    cache = tmp_path.parent / (tmp_path.name + "-bad.json")
    cache.write_text("{not json")
    assert len(si.index_folder(tmp_path, cache)) == 1
    cache.write_text('{"v": 1, "folders": {"f": 5}}')
    assert len(si.index_folder(tmp_path, cache)) == 1


def test_unreadable_file_skipped(tmp_path, caplog):
    put(tmp_path / "f", n=3)
    (tmp_path / "f" / "9.dcm").write_bytes(b"garbage")
    (tmp_path / "f" / "0a.dcm").write_bytes(b"garbage")
    with caplog.at_level("INFO"):
        out = si.index_folder(tmp_path, tmp_path / "c.json")
    assert len(out) == 1 and out[0]["images"] == 3
    assert "skipped 2" in caplog.text and "garbage" not in caplog.text and "9.dcm" not in caplog.text


def test_symlink_out_of_root_not_followed(tmp_path):
    outside = tmp_path / "outside"
    put(outside / "f", pid="OUT")
    root = tmp_path / "root"
    put(root / "in")
    (root / "link").symlink_to(outside, target_is_directory=True)
    (root / "in" / "ext.dcm").symlink_to(outside / "f" / "0.dcm")
    out = si.index_folder(root, tmp_path / "c.json")
    assert {e["patient_key"] for e in out} == {"P1"} and out[0]["images"] == 2


def test_interleaved_series_not_merged(tmp_path):
    for i, ser in enumerate(["1.1", "1.2", "1.1", "1.2", "1.1"]):
        dcm(tmp_path / "f" / f"{i}.dcm", series=ser)
    out = si.index_folder(tmp_path, tmp_path / "c.json")
    assert sorted(e["images"] for e in out) == [2, 3]


def test_progress(tmp_path):
    put(tmp_path / "f", n=3)
    seen = []
    si.index_folder(tmp_path, tmp_path / "c.json", progress=seen.append)
    assert seen and seen[-1] == 3


def test_overwrite_in_place_detected(tmp_path):
    put(tmp_path / "f", n=2, series="1.1")
    cache = tmp_path.parent / (tmp_path.name + "-ow.json")
    si.index_folder(tmp_path, cache)
    dcm(tmp_path / "f" / "0.dcm", series="1.9")  # same name, directory mtime unchanged
    os.utime(tmp_path / "f" / "0.dcm", (9e9, 9e9))
    os.utime(tmp_path / "f", (1, 1))
    assert len(si.index_folder(tmp_path, cache)) == 2


def test_timeline_undated():
    def e(d, s):
        return {"patient_key": "A", "study_date": d, "series_uid_hash": s}
    a = si.timeline([e(None, "u"), e("2020-01-11", "s2"), e("2020-01-01", "s1")])[0]["scans"]
    assert [(s["timepoint"], s["day"]) for s in a] == [("Baseline", 0), ("Follow-up", 10), ("Undated", None)]
    b = si.timeline([e(None, "u1"), e(None, "u2")])[0]["scans"]
    assert [(s["timepoint"], s["day"]) for s in b] == [("Undated", None)] * 2


@pytest.mark.parametrize("pn,shown", [("Doe^Jane", "Doe, Jane"), ("Doe^Jane^Marie^Dr^Jr", "Doe, Jane"), ("Doe", "Doe"), ("^Jane", "Jane"),
                                      ("Doe^", "Doe"), ("Doe^Jane=山田^太郎", "Doe, Jane"), ("", "")])
def test_display_name(pn, shown):
    assert si.display_name(pn) == shown


def test_index_stops_at_the_file_limit(tmp_path):
    put(tmp_path / "f", n=3)
    with pytest.raises(si.TooManyFiles):
        si.index_folder(tmp_path, tmp_path / "c.json", limit=2)
    assert len(si.index_folder(tmp_path, tmp_path / "c.json", limit=3)) == 1


C30, S30 = 0.866, 0.5  # a 30-degree tilt
ENHANCED = "1.2.840.10008.5.1.4.1.1.2.1"  # Enhanced CT: not CT Image Storage


@pytest.mark.parametrize("kw", [
    dict(image_type=("DERIVED", "SECONDARY", "AXIAL"), sop=ENHANCED), dict(image_type=("ORIGINAL", "SECONDARY"), sop=ENHANCED),
    dict(image_type=("DERIVED", "PRIMARY", "AXIAL"), sop=ENHANCED), dict(burned="YES"),
    dict(image_type=("ORIGINAL", "PRIMARY", "SCREEN SAVE")), dict(image_type="SCREEN SAVE"),  # one value: pydicom gives a str, not a list
    dict(sop="1.2.840.10008.5.1.4.1.1.7"), dict(sop="1.2.840.10008.5.1.4.1.1.7.4"),  # Secondary Capture, single and multi-frame
    dict(modality="SR"), dict(desc="Dose Report"), dict(desc="DOSE INFO"), dict(image_type=("ORIGINAL", "PRIMARY", "DOSE_REPORT")),
    dict(image_type=("ORIGINAL", "PRIMARY", "LOCALIZER")),
    dict(iop=(1, 0, 0, 0, 0, -1)), dict(iop=(0, 1, 0, 0, 0, -1)), dict(iop=(1, 0, 0, 0, C30, S30)),  # coronal, sagittal, tilted
    dict(iop=None),  # no orientation: a CT image must have one (Type 1), so it is a capture or a broken export
])
def test_only_primary_axial_ct_is_kept(tmp_path, kw):
    """A screen save or a dose report can carry the patient's name in its pixels, and the hosted page shows slice pixels."""
    put(tmp_path / "ok", series="1.1")
    put(tmp_path / "x", series="1.2", **kw)
    assert [e["folder"] for e in si.index_folder(tmp_path, tmp_path / "c.json")] == ["ok"]


def test_axial_ct_variants_are_kept(tmp_path):
    put(tmp_path / "a", series="1.1", image_type=None)  # no ImageType: kept when it is CT and axial
    put(tmp_path / "b", series="1.2", iop=(-1, 0, 0, 0, -1, 0))  # flipped, up to sign
    put(tmp_path / "c", series="1.3", iop=(0.995, 0.0998, 0, -0.0998, 0.995, 0))  # a small turn in the plane
    put(tmp_path / "d", series="1.4", desc="Low dose chest")  # a low-dose CT is not a dose report
    put(tmp_path / "e", series="1.5", image_type=("DERIVED", "SECONDARY", "PROCESSED"))  # TCIA's processed CT, as CT Image Storage (RIDER)
    assert sorted(e["folder"] for e in si.index_folder(tmp_path, tmp_path / "c.json")) == ["a", "b", "c", "d", "e"]


def test_an_old_cache_is_not_reused(tmp_path):
    put(tmp_path / "x", series="1.2", image_type=("ORIGINAL", "PRIMARY", "SCREEN SAVE"))
    cache = tmp_path.parent / (tmp_path.name + "-old.json")
    si.index_folder(tmp_path, cache)
    old = json.loads(cache.read_text())
    old["v"] = 1  # written before the primary-axial rule: its entries may hold a screen save
    old["folders"]["x"]["entries"] = [{"folder": "x"}]
    cache.write_text(json.dumps(old))
    assert si.index_folder(tmp_path, cache) == []
