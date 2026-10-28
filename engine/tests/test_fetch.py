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


FIVE = ("RIDER-1867199702", "RIDER-1825099523", "RIDER-1346917136", "RIDER-2357766186", "RIDER-1225316081")  # data/eval/local-practice-5.txt
TWENTY = ("RIDER-1129164940", "RIDER-1332496276", "RIDER-1344011628", "RIDER-1500037140", "RIDER-1532432635", "RIDER-1760553574",
          "RIDER-1801720707", "RIDER-2016615262", "RIDER-2073083717", "RIDER-2151469008", "RIDER-2539508879", "RIDER-2655999012",
          "RIDER-2669524182", "RIDER-2799584460", "RIDER-3023568408", "RIDER-3115188676", "RIDER-3152132495", "RIDER-3160137230",
          "RIDER-6324870494", "RIDER-9763310455")  # the practice server's other patients


def _fill(root, patients, dirs=None):
    for p in patients:
        for d in dirs or (fetch.DIRS if p in fetch.PATIENTS else fetch.DIRS[:2]):
            (root / p / d).mkdir(parents=True, exist_ok=True)
            (root / p / d / "a.dcm").write_bytes(b"x")


def test_default_is_the_eight_and_all_is_the_28():
    assert fetch.PRACTICE == fetch.PATIENTS + FIVE
    assert len(fetch.ALL) == len(set(fetch.ALL)) == 28 and set(fetch.ALL) == set(fetch.PATIENTS + FIVE + TWENTY)
    assert fetch.ALL[:8] == fetch.PRACTICE


def test_no_seg_for_a_patient_outside_the_three():
    rows = [dict(PatientID=p, Modality="SEG", SeriesDescription=f"{p}_1_{side}", SeriesInstanceUID=f"{p}.seg.{side}")
            for p in fetch.ALL for side in ("TEST", "RETEST")]
    assert set(fetch.select_seg(pd.DataFrame(rows)).PatientID) == set(fetch.PATIENTS)


def _ct_index(patients):
    """A made-up IDC index (SEG and CT rows) and seg_index (each test/retest SEG points to its CT)."""
    rows, segs = [], []
    for p in patients:
        for side in ("TEST", "RETEST", "Tumor"):
            uid = f"{p}.seg.{side}"
            rows.append(dict(PatientID=p, Modality="SEG", SeriesDescription=f"{p}_1_{side}" if side != "Tumor" else "Tumor Segmentation", SeriesInstanceUID=uid))
            rows.append(dict(PatientID=p, Modality="CT", SeriesDescription="x", SeriesInstanceUID=f"{p}.ct.{side}"))
            segs.append(dict(SeriesInstanceUID=uid, segmented_SeriesInstanceUID=f"{p}.ct.{side}"))
    return pd.DataFrame(rows), pd.DataFrame(segs)


def test_select_ct_reads_the_seg_index_only():
    idx, seg = _ct_index(FIVE[:2] + ("RIDER-OTHER-NOT-ALLOWED",))
    assert fetch.select_ct(idx, seg, list(FIVE[:2])) == {(p, side.lower()): f"{p}.ct.{side}" for p in FIVE[:2] for side in ("TEST", "RETEST")}


def test_ct_only_patients_get_their_ct_and_no_seg(tmp_path, monkeypatch):
    idx, seg = _ct_index(fetch.ALL)
    client = type("C", (), {"index": idx, "fetch_index": lambda self, name: setattr(self, name, seg)})()
    got = []
    def download(c, uids, dest):
        for u in list(uids):
            got.append(u)
            (dest / u).mkdir(parents=True)
            (dest / u / "a.dcm").write_bytes(b"x")
    monkeypatch.setattr(fetch, "_client", lambda: client)
    monkeypatch.setattr(fetch, "_download", download)
    fetch.fetch_patients(tmp_path, list(FIVE))
    assert sorted(got) == sorted(f"{p}.ct.{side}" for p in FIVE for side in ("TEST", "RETEST"))
    assert fetch.missing(tmp_path, FIVE) == [] and not list(tmp_path.glob("*/lungctseg_*")) and not (tmp_path / ".download").exists()


def test_a_network_error_on_the_seg_index_is_one_plain_line(tmp_path, monkeypatch):
    idx, _ = _ct_index(fetch.ALL)
    def offline(self, name):
        raise ConnectionError("Max retries exceeded with url: /seg_index.parquet")
    monkeypatch.setattr(fetch, "_client", lambda: type("C", (), {"index": idx, "fetch_index": offline})())
    monkeypatch.setattr(fetch, "_download", lambda c, uids, dest: None)
    with pytest.raises(SystemExit) as e:
        fetch.fetch_patients(tmp_path, list(FIVE))
    assert str(e.value) == "Could not reach the public data index. Check the internet connection and run the same command again."


def test_complete_patient_is_skipped(tmp_path):
    _fill(tmp_path, fetch.PATIENTS[:2] + FIVE[:1])
    _fill(tmp_path, [fetch.PATIENTS[2], FIVE[1]], ["ct_test"])  # incomplete; a CT-only patient needs no lungctseg_*
    assert fetch.missing(tmp_path, fetch.PRACTICE) == [fetch.PATIENTS[2]] + list(FIVE[1:])


def test_complete_set_downloads_nothing(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(fetch, "_client", lambda: pytest.fail("no network when nothing is missing"))
    _fill(tmp_path, fetch.PRACTICE)
    fetch.main(["--data", str(tmp_path)])
    assert "nothing to download" in capsys.readouterr().out
    _fill(tmp_path, TWENTY)
    fetch.main(["--data", str(tmp_path), "--all"])
    assert "nothing to download" in capsys.readouterr().out


def test_all_asks_only_for_the_missing_twenty(tmp_path, monkeypatch):
    _fill(tmp_path, fetch.PRACTICE)
    asked = []
    monkeypatch.setattr(fetch, "fetch_patients", lambda data, todo: (asked.extend(todo), _fill(data, todo)))
    fetch.main(["--data", str(tmp_path), "--all"])
    assert sorted(asked) == sorted(TWENTY)


def test_low_disk_exits(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(fetch.shutil, "disk_usage", lambda p: type("U", (), {"free": 1e9})())
    with pytest.raises(SystemExit) as e:
        fetch.main(["--data", str(tmp_path)])
    assert "GB" in str(e.value) and "free" in str(e.value)


def test_disk_check_is_sized_for_each_set(tmp_path, monkeypatch):
    monkeypatch.setattr(fetch.shutil, "disk_usage", lambda p: type("U", (), {"free": 5e9})())  # enough for the 8, not for the 28
    monkeypatch.setattr(fetch, "fetch_patients", lambda data, todo: _fill(data, todo))
    fetch.main(["--data", str(tmp_path)])
    assert fetch.missing(tmp_path) == []
    with pytest.raises(SystemExit) as e:
        fetch.main(["--data", str(tmp_path), "--all"])
    assert f"{fetch.need_gb(TWENTY)} GB needed" in str(e.value)


def test_disk_check_is_sized_by_the_missing_patients(tmp_path, monkeypatch):
    monkeypatch.setattr(fetch.shutil, "disk_usage", lambda p: type("U", (), {"free": 6.5e9})())  # room for the 20, not for all 28
    asked = []
    monkeypatch.setattr(fetch, "fetch_patients", lambda data, todo: (asked.extend(todo), _fill(data, todo)))
    with pytest.raises(SystemExit):
        fetch.main(["--data", str(tmp_path / "none"), "--all"])  # all 28 missing
    _fill(tmp_path / "eight", fetch.PRACTICE)
    fetch.main(["--data", str(tmp_path / "eight"), "--all"])  # the 8 present: only the 20 count
    assert sorted(asked) == sorted(TWENTY)
    assert 5.1 < fetch.need_gb(TWENTY) < 6.5  # the 20 measured 5.1 GB, plus room
    assert 2.1 < fetch.need_gb(fetch.PRACTICE) < fetch.need_gb(fetch.ALL) and fetch.need_gb([]) < 1.5


def test_all_done_makes_no_client(tmp_path, monkeypatch):
    monkeypatch.setattr(fetch, "missing", lambda *a: [])
    monkeypatch.setattr(fetch, "_client", lambda: pytest.fail("no network when nothing is missing"))
    fetch.main(["--data", str(tmp_path)])


@pytest.mark.network
def test_index_finds_the_three():
    sel = fetch.select_seg(index.IDCClient().index)
    assert set(sel.PatientID) == set(fetch.PATIENTS) and len(sel) == 6


@pytest.mark.network
def test_seg_index_points_every_practice_patient_to_two_ct_series():
    c = index.IDCClient()
    c.fetch_index("seg_index")
    cts = fetch.select_ct(c.index, c.seg_index, list(fetch.ALL))
    assert set(cts) == {(p, side) for p in fetch.ALL for side in ("test", "retest")}
    assert fetch.keep_ct(c.index, cts, list(fetch.ALL)) == cts  # every one a CT series of its own patient
