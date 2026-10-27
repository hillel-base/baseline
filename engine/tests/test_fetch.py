import pandas as pd, pytest
from lung_engine import fetch
from idc_index import index  # at collection, before any test loads a scan: SimpleITK's DICOM reading leaves Python's text encoding at ASCII, and idc_index_data reads its UTF-8 files with it on import


def _index():
    rows = []
    for p in list(fetch.PATIENTS) + ["RIDER-OTHER-NOT-ALLOWED"]:
        for i, d in enumerate(["RIDER-1_1_TEST", "RIDER-1_1_RETEST", "Tumor Segmentation"]):
            rows.append(dict(PatientID=p, Modality="SEG", SeriesDescription=d, SeriesInstanceUID=f"{p}.{i}"))
        rows.append(dict(PatientID=p, Modality="CT", SeriesDescription="x", SeriesInstanceUID=f"{p}.ct"))
    return pd.DataFrame(rows)


def test_three_patients_only():
    assert fetch.PATIENTS == ("RIDER-2541949645", "RIDER-1286684383", "RIDER-2619750334")
    sel = fetch.select_seg(_index())
    assert set(sel.PatientID) == set(fetch.PATIENTS)
    assert len(sel) == 6  # test and retest per patient, no tumour-seg or CT rows


def test_ct_of_another_patient_is_dropped():
    keep = fetch.keep_ct(_index(), {(fetch.PATIENTS[0], "test"): f"{fetch.PATIENTS[0]}.ct", (fetch.PATIENTS[1], "test"): "RIDER-OTHER-NOT-ALLOWED.ct"}, list(fetch.PATIENTS))
    assert list(keep) == [(fetch.PATIENTS[0], "test")]


def test_complete_patient_is_skipped(tmp_path):
    for p in fetch.PATIENTS[:2]:
        for d in fetch.DIRS:
            (tmp_path / p / d).mkdir(parents=True)
            (tmp_path / p / d / "a.dcm").write_bytes(b"x")
    (tmp_path / fetch.PATIENTS[2] / "ct_test").mkdir(parents=True)  # incomplete
    assert fetch.missing(tmp_path) == [fetch.PATIENTS[2]]


def test_low_disk_exits(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(fetch.shutil, "disk_usage", lambda p: type("U", (), {"free": 1e9})())
    with pytest.raises(SystemExit) as e:
        fetch.main(["--data", str(tmp_path)])
    assert "GB" in str(e.value) and "free" in str(e.value)


def test_all_done_makes_no_client(tmp_path, monkeypatch):
    monkeypatch.setattr(fetch, "missing", lambda d: [])
    monkeypatch.setattr(fetch, "_client", lambda: pytest.fail("no network when nothing is missing"))
    fetch.main(["--data", str(tmp_path)])


@pytest.mark.network
def test_index_finds_the_three():
    sel = fetch.select_seg(index.IDCClient().index)
    assert set(sel.PatientID) == set(fetch.PATIENTS) and len(sel) == 6
