import gc
import weakref

import numpy as np
import SimpleITK as sitk
from lung_engine.scans import list_scans, load_scan


def test_list_scans_finds_test_and_retest(tmp_path):
    for s in ("ct_test", "ct_retest"):
        (tmp_path / "RIDER-A" / s).mkdir(parents=True)
        (tmp_path / "RIDER-A" / s / "a.dcm").touch()
    assert [s["id"] for s in list_scans(tmp_path)] == ["RIDER-A_retest", "RIDER-A_test"]


def test_list_scans_ignores_other_folders(tmp_path):
    for s in ("ct_test", "lungctseg_test", "ct_other"):
        (tmp_path / "RIDER-A" / s).mkdir(parents=True)
    assert list_scans(tmp_path) == [{"id": "RIDER-A_test", "patient": "RIDER-A", "series": "test"}]


def test_load_scan_gives_hu_and_spacing(dicom_series):
    s = load_scan(dicom_series, "RIDER-TEST01_test")
    assert s.array.shape == (8, 64, 64) and s.array.dtype == np.int16
    assert s.array[4, 32, 32] == 40 and s.array[0, 0, 0] == -1000
    assert np.allclose(s.spacing, (0.7, 0.7, 1.25))


def test_instance_numbers_follow_z(dicom_series):
    assert load_scan(dicom_series, "RIDER-TEST01_test").instance_numbers == [8, 7, 6, 5, 4, 3, 2, 1]


def test_repeated_instance_numbers_give_none(dicom_series):
    d = dicom_series / "RIDER-TEST01" / "ct_test"
    f = sorted(d.glob("*.dcm"))[0]
    img = sitk.ReadImage(str(f))
    img.SetMetaData("0020|0013", "7")  # same as another slice
    w = sitk.ImageFileWriter()
    w.KeepOriginalImageUIDOn()  # else the series splits
    w.SetFileName(str(f))
    w.Execute(img)
    assert load_scan(dicom_series, "RIDER-TEST01_test").instance_numbers is None


def test_array_is_the_image_buffer_and_keeps_the_image_alive(dicom_series):
    s = load_scan(dicom_series, "RIDER-TEST01_test")
    image, arr = weakref.ref(s.image), s.array
    del s
    gc.collect()
    assert image() is not None and arr[4, 32, 32] == 40 and not arr.flags.writeable
    del arr
    gc.collect()
    assert image() is None


def test_missing_or_bad_header_tags_give_none(dicom_series):
    for f in (dicom_series / "RIDER-TEST01" / "ct_test").glob("*.dcm"):
        img = sitk.ReadImage(str(f))
        img.EraseMetaData("0020|0011"); img.EraseMetaData("0018|0050"); img.SetMetaData("0008|0020", "bad")
        w = sitk.ImageFileWriter(); w.KeepOriginalImageUIDOn(); w.SetFileName(str(f)); w.Execute(img)
    s = load_scan(dicom_series, "RIDER-TEST01_test")
    assert (s.series_number, s.study_date, s.slice_thickness_mm) == (None, None, None)


def test_header_tag_that_is_not_a_finite_number_is_none():
    from lung_engine.scans import _tag

    class Reader:
        def __init__(self, v): self.v = v
        def GetMetaData(self, i, tag): return self.v

    assert _tag(Reader("nan"), "0018|0050", float) is None
    assert _tag(Reader(" inf "), "0018|0050", float) is None
    assert _tag(Reader("1.25"), "0018|0050", float) == 1.25


def test_study_date_skips_a_picture_that_sorts_first(dicom_series):
    from lung_engine.scans import study_date
    d = dicom_series / "RIDER-TEST01" / "ct_test"
    sitk.WriteImage(sitk.Image(4, 4, sitk.sitkUInt8), str(d / "+thumb.png"))  # SimpleITK reads a PNG, which has no StudyDate
    assert study_date(d) == "2001-02-03"
