import base64

import numpy as np

from lung_engine.outline import crop_box, pack_mask


def test_crop_box_centre_and_edges():
    assert crop_box((50, 256, 256), (100, 512, 512), (0.7, 0.7, 1.25)) == ((2, 127, 127), (98, 385, 385))
    lo, hi = crop_box((0, 0, 511), (100, 512, 512), (0.7, 0.7, 1.25))
    assert lo == (0, 0, 382) and hi == (48, 129, 512)


def test_pack_mask_roundtrip_and_empty():
    m = np.zeros((6, 10, 10), bool)
    m[2:4, 3:7, 5:8] = True
    bbox, b64 = pack_mask(m)
    assert bbox == [2, 3, 5, 4, 7, 8]
    sub = np.unpackbits(np.frombuffer(base64.b64decode(b64), np.uint8))[:2 * 4 * 3].reshape(2, 4, 3).astype(bool)
    assert (sub == m[2:4, 3:7, 5:8]).all()
    assert pack_mask(np.zeros((2, 3, 4), bool)) == (None, None)


import pytest
from conftest import BallSegmenter
from lung_engine.outline import AIR_HU, NoNodule, NothingToUndo, OnAir, OutlineSession, OutsideBox
from lung_engine.scans import Scan


def big_scan(shape=(120, 400, 400)):
    return Scan("P_test", "P", "test", None, np.zeros(shape, np.int16), (0.7, 0.7, 1.25), None)


def test_correction_inside_scan_but_outside_working_box_is_refused():
    s = OutlineSession(BallSegmenter())
    s.start(big_scan(), (60, 100, 100))  # box x: 0..229
    with pytest.raises(OutsideBox):
        s.click((60, 100, 300), True)


def test_api_outside_box_message(client, monkeypatch):
    monkeypatch.setattr("lung_engine.outline.HALF_MM", (2, 10, 10))  # a small box inside the 64 px scan
    client.post("/api/scans/RIDER-TEST01_test/nodules", json=dict(z=4, y=32, x=32))
    r = client.post("/api/nodule/clicks", json=dict(z=4, y=32, x=60, positive=True, scan="RIDER-TEST01_test", nodule=1))
    assert r.status_code == 400
    assert r.json()["detail"] == "That click is outside the working box of this nodule. Start a new nodule to outline something else."


class Failing(BallSegmenter):
    def click(self, zyx, positive):
        raise RuntimeError("model error")


def test_failed_start_drops_the_nodule():
    s = OutlineSession(BallSegmenter())
    s.start(big_scan(), (60, 100, 100))
    s.seg = Failing()
    with pytest.raises(RuntimeError):
        s.start(big_scan(), (10, 300, 300))
    with pytest.raises(NoNodule):
        s.click((60, 100, 100), True)
    with pytest.raises(NothingToUndo):
        s.undo()


@pytest.mark.parametrize("hu, refused", [(-1024, True), (AIR_HU, True), (AIR_HU + 1, False), (-600, False), (40, False)])
def test_start_on_air_is_refused_but_ground_glass_is_outlined(hu, refused):
    s = OutlineSession(BallSegmenter())
    s.start(big_scan(), (60, 100, 100))
    scan = big_scan()
    scan.array[60, 200, 200] = hu
    if refused:
        with pytest.raises(OnAir):
            s.start(scan, (60, 200, 200))
        assert s.click((60, 100, 110), True)["nodule"] == 1  # the current nodule is kept
    else:
        assert s.start(scan, (60, 200, 200))[0]["volume_ml"] > 0


def test_api_start_on_air_is_400_with_a_clear_message(client):
    r = client.post("/api/scans/RIDER-TEST01_test/nodules", json=dict(z=4, y=2, x=2))  # -1000 HU in the fixture
    assert r.status_code == 400
    assert r.json()["detail"] == "No outline here: that point is air. Click on the nodule itself."


def test_edge_flag_ball_at_the_crop_edge_sets_it_and_a_central_ball_does_not():
    s = OutlineSession(BallSegmenter())
    assert s.start(big_scan(), (60, 100, 100))[0]["at_window_edge"] is False
    assert s.start(big_scan(), (60, 2, 100))[0]["at_window_edge"] is True  # ball touches the crop's y = 0 face


def test_edge_flag_ball_within_2_voxels_of_the_model_window_sets_it(monkeypatch):
    monkeypatch.setattr("lung_engine.outline.WINDOW", 40)  # window is click +-20: 0..40 around local 20
    s = OutlineSession(BallSegmenter(radius=17))
    assert s.start(big_scan(), (60, 129, 129))[0]["at_window_edge"] is False  # reaches 17 of 20 voxels: 3 from the edge
    s = OutlineSession(BallSegmenter(radius=18))
    assert s.start(big_scan(), (60, 129, 129))[0]["at_window_edge"] is True


def test_click_and_undo_check_the_expected_nodule_under_the_lock():
    s = OutlineSession(BallSegmenter())
    s.start(big_scan(), (60, 100, 100))  # scan "P_test", nodule 1
    with pytest.raises(NoNodule):
        s.click((60, 100, 110), True, ("P_test", 2))
    with pytest.raises(NoNodule):
        s.undo(("other", 1))
    assert s.click((60, 100, 110), True, ("P_test", 1))["nodule"] == 1
    assert s.undo(("P_test", 1))["nodule"] == 1


def test_record_session_rules():
    from conftest import EmptySegmenter
    from lung_engine.outline import AlreadyRecorded, Empty
    sc, e = big_scan(), ("P_test", 1)
    s = OutlineSession(EmptySegmenter())
    s.start(sc, (60, 100, 100))
    with pytest.raises(Empty):
        s.record(e)
    s = OutlineSession(BallSegmenter())
    s.start(sc, (60, 100, 100))
    payload, full, scan = s.record(e)
    assert full.shape == sc.array.shape and full.any() and scan is sc and payload["nodule"] == 1
    with pytest.raises(AlreadyRecorded):
        s.record(e)
    s.unrecord(e)
    s.record(e)
    s.start(sc, (60, 100, 100))  # a new nodule starts unrecorded
    s.record(("P_test", 2))


# Slice 5: brush strokes and hand-set axes. big_scan is 0 HU everywhere; the session's mask is on the crop box.

def disk(shape, cy, cx, r):
    yy, xx = np.indices(shape)
    return (yy - cy) ** 2 + (xx - cx) ** 2 <= r * r


def full(s):
    m = np.zeros(s.scan.array.shape, bool)
    m[tuple(slice(a, b) for a, b in zip(s.lo, s.hi))] = s.mask
    return m


def test_stroke_paints_and_erases_exactly_the_disk_inside_the_box(monkeypatch):
    monkeypatch.setattr("lung_engine.outline.HALF_MM", (12.5, 14, 14))  # box (z,y,x) 50..69, 80..119, 80..119
    s = OutlineSession(BallSegmenter())
    s.start(big_scan(), (60, 100, 100))
    assert (s.lo, s.hi) == ((50, 80, 80), (70, 120, 120))
    before = full(s)
    o, changed = s.stroke([(60, 85, 118)], 4, erase=False, snap=False)  # the disk crosses the box's last column, x = 119
    want = np.zeros_like(before)
    want[60] = disk((400, 400), 85, 118, 4)
    want[:, :, 120:] = False
    assert (full(s) == before | want).all() and changed == want.sum() and o["painted"] == 1
    o, changed = s.stroke([(60, 100, 100)], 2, erase=True, snap=False)
    gone = np.zeros_like(before)
    gone[60] = disk((400, 400), 100, 100, 2)
    assert (full(s) == (before | want) & ~gone).all() and changed == gone.sum() == 13 and o["painted"] == 2
    o, _ = s.stroke([(55, 100, 90), (55, 100, 110)], 1, erase=False, snap=False)  # a line: every pixel within 1 of it
    assert full(s)[55].sum() == full(s)[55, 99:102, 89:112].sum() == 3 * 23 - 4 and o["painted"] == 3  # 3 rows, corners cut by the end disks
    with pytest.raises(OutsideBox):
        s.stroke([(60, 100, 140)], 3, erase=False, snap=False)  # the disk ends at x = 143, the box at 120
    with pytest.raises(OutsideBox):
        s.stroke([(49, 100, 100)], 3, erase=False, snap=False)  # one slice below the box
    with pytest.raises(ValueError):
        s.stroke([(60, 100, 100), (61, 100, 100)], 3, erase=False, snap=False)  # a stroke stays on one slice


def test_snap_paints_voxels_at_minus_750_hu_and_above():
    # The lab's measurement convention (its answer, 2026-10-28): the nodule volume includes the hazy ground-glass part, so Snap keeps -750 HU (the published lower bound for ground glass) and above.
    scan = big_scan()
    scan.array[:, :, 110:] = -1000
    scan.array[:, :, 112] = -751  # just below: kept out
    scan.array[:, :, 113] = -750  # the level itself: painted
    s = OutlineSession(BallSegmenter())
    s.start(scan, (60, 100, 100))
    before = full(s)
    o, changed = s.stroke([(60, 100, 110)], 5, erase=False, snap=True)
    added = full(s) & ~before
    assert added.any() and not added[:, :, 110:113].any() and added[60, 100, 113] and added[60, 100, 105]
    assert changed == added.sum()
    s.stroke([(60, 100, 110)], 5, erase=False, snap=False)
    assert full(s)[60, 100, 110:116].all()
    s.stroke([(60, 100, 110)], 5, erase=True, snap=True)  # snap is for paint only: erase clears air too
    assert not full(s)[60, 100, 105:116].any()


def test_strokes_stay_on_top_of_later_clicks():
    s = OutlineSession(BallSegmenter())
    s.start(big_scan(), (60, 100, 100))
    s.stroke([(60, 120, 120)], 3, erase=False, snap=False)
    s.stroke([(60, 100, 100)], 1, erase=True, snap=False)
    o = s.click((60, 100, 102), True)  # the model's new ball covers the erased disk again
    m = full(s)
    assert m[60, 120, 120] and not m[60, 100, 100] and m[60, 100, 104] and o["painted"] == 2
    o = s.undo()  # the model's mask before the click, with both strokes again
    m = full(s)
    assert m[60, 120, 120] and not m[60, 100, 100] and not m[60, 100, 104] and o["painted"] == 2


def test_hand_set_axes_give_the_drawn_lengths_and_a_later_click_or_stroke_clears_them():
    scan = Scan("P_test", "P", "test", None, np.zeros((120, 400, 400), np.int16), (0.5, 0.8, 1.25), None)  # x 0.5 mm, y 0.8 mm
    s = OutlineSession(BallSegmenter())
    auto, _ = s.start(scan, (60, 100, 100))
    assert auto["axes_edited"] is False
    long_line, short_line = [[98, 97], [101, 101]], [[100.25, 99], [100.25, 102.5]]
    o, changed = s.set_axes(long_line, short_line)
    assert (o["long_line"], o["short_line"], o["axes_edited"]) == (long_line, short_line, True)
    assert (o["long_mm"], o["short_mm"]) == (3.1, 1.8)  # hypot(3 * 0.8, 4 * 0.5) = 3.12; 3.5 * 0.5 = 1.75, half up
    assert changed == [("long", auto["long_mm"], 3.1), ("short", auto["short_mm"], 1.8)]
    assert (o["volume_ml"], o["axis_z"], o["mask"]) == (auto["volume_ml"], auto["axis_z"], auto["mask"])
    o, changed = s.set_axes(long_line, [[100, 99], [100, 103]])
    assert changed == [("short", 1.8, 2.0)]
    o, _ = s.stroke([(60, 110, 110)], 1, erase=False, snap=False)
    assert o["axes_edited"] is False and o["long_line"] != long_line
    s.set_axes(long_line, short_line)
    o = s.click((60, 100, 102), True)
    assert o["axes_edited"] is False and o["long_mm"] > 3.1
    with pytest.raises(OutsideBox):
        s.set_axes([[100, 100], [100, 300]], short_line)  # the box ends at x 280


def test_undo_takes_back_the_last_action_of_any_kind():
    s = OutlineSession(BallSegmenter())
    first, _ = s.start(big_scan(), (60, 100, 100))
    clicked = s.click((60, 100, 104), True)
    s.set_axes([[100, 90], [100, 110]], [[95, 100], [105, 100]])
    stroked, _ = s.stroke([(60, 120, 120)], 3, erase=False, snap=False)  # clears the hand-set axes
    s.set_axes([[100, 92], [100, 110]], [[95, 100], [105, 100]])
    drop = lambda o: {k: v for k, v in o.items() if k != "seconds"}
    assert drop(s.undo()) == drop(stroked)  # the second axes
    u = s.undo()  # the stroke: the first hand-set axes come back with the mask before it
    assert (u["axes_edited"], u["painted"], u["long_line"], u["long_mm"]) == (True, 0, [[100, 90], [100, 110]], 14.0)
    assert drop(s.undo()) == drop(clicked)  # the first axes
    assert drop(s.undo()) == drop(first) | dict(can_undo=False)  # the click, through the model's one-level undo
    with pytest.raises(NothingToUndo):
        s.undo()


def test_stroke_and_axes_on_a_nodule_the_session_does_not_hold_or_has_recorded():
    from lung_engine.outline import Empty, Recorded
    from conftest import EmptySegmenter
    s = OutlineSession(BallSegmenter())
    with pytest.raises(NoNodule):
        s.stroke([(60, 100, 100)], 3, erase=False, snap=False)
    s.start(big_scan(), (60, 100, 100))
    with pytest.raises(NoNodule):
        s.stroke([(60, 100, 100)], 3, erase=False, snap=False, expect=("P_test", 2))
    with pytest.raises(NoNodule):
        s.set_axes([[100, 90], [100, 110]], [[95, 100], [105, 100]], expect=("P_test", 2))
    s.record(("P_test", 1))
    with pytest.raises(Recorded):
        s.stroke([(60, 100, 100)], 3, erase=False, snap=False)
    with pytest.raises(Recorded):
        s.set_axes([[100, 90], [100, 110]], [[95, 100], [105, 100]])
    s = OutlineSession(EmptySegmenter())
    s.start(big_scan(), (60, 100, 100))
    with pytest.raises(Empty):
        s.set_axes([[100, 90], [100, 110]], [[95, 100], [105, 100]])


def test_a_stroke_after_undoing_the_first_click_outlines_with_no_click():
    s = OutlineSession(BallSegmenter())
    s.start(big_scan(), (60, 100, 100))
    assert s.undo()["clicks"] == []
    o, changed = s.stroke([(60, 100, 100)], 3, erase=False, snap=False)
    assert (o["clicks"], o["painted"], o["at_window_edge"], changed) == ([], 1, False, 29) and o["volume_ml"] > 0


def test_a_stroke_that_changes_nothing_is_refused_and_leaves_the_nodule_as_it_was():
    from lung_engine.outline import NoChange
    scan = big_scan()
    scan.array[:, :, 150:] = -1000  # air beside the ball
    s = OutlineSession(BallSegmenter())
    s.start(scan, (60, 100, 100))
    hand, _ = s.set_axes([[100, 96], [100, 104]], [[97, 100], [103, 100]])
    before = full(s)
    for points, erase, snap, says_snap in (([(60, 100, 160)], False, True, True),  # snap over air
                                           ([(60, 100, 100)], False, False, False),  # paint inside the outline
                                           ([(60, 100, 130)], True, True, False)):  # erase outside it (snap is for paint only)
        with pytest.raises(NoChange) as e:
            s.stroke(points, 1, erase=erase, snap=snap)
        assert e.value.args == (says_snap,)
        assert (full(s) == before).all() and s.strokes == []
    o = s._payload(0.0)
    assert (o["painted"], o["axes_edited"], o["long_line"]) == (0, True, hand["long_line"])
    assert s.undo()["axes_edited"] is False  # history holds only the click and the axes: Undo takes back the axes


def test_edge_flag_reads_the_models_mask_so_a_far_stroke_does_not_set_it(monkeypatch):
    monkeypatch.setattr("lung_engine.outline.WINDOW", 40)  # window is click +-20
    s = OutlineSession(BallSegmenter(radius=17))
    assert s.start(big_scan(), (60, 129, 129))[0]["at_window_edge"] is False
    o, changed = s.stroke([(60, 148, 129)], 1, erase=False, snap=False)  # 19 voxels from the click: in the window's 2-voxel rim
    assert changed > 0 and o["at_window_edge"] is False
