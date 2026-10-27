import numpy as np
from pytest import approx
from scipy.spatial import ConvexHull

from lung_engine.measure import axes, depth_mm, half_up, volume_ml


def ellipse(a_mm, b_mm, px, n=3):
    yy, xx = np.mgrid[:int(100 / px[1]), :int(100 / px[0])] * np.array(px[::-1])[:, None, None]
    return (((xx - 50) / a_mm) ** 2 + ((yy - 50) / b_mm) ** 2 <= 1)[None].repeat(n, 0)


def hull_width(mask):
    p = np.argwhere(mask[0]).astype(float)
    h = p[ConvexHull(p).vertices]
    d = np.linalg.norm(h[:, None] - h[None], axis=2)
    i, j = np.unravel_index(np.argmax(d), d.shape)
    u = (h[j] - h[i]) / d[i, j]
    return float(np.ptp(h @ np.array([-u[1], u[0]])))


def test_axes_ellipse():
    a = axes(ellipse(20, 10, (0.5, 0.5)), (0.5, 0.5, 2.0))
    assert abs(a["long_mm"] - 40) < 1.1 and abs(a["short_mm"] - 20) < 1.1


def test_axes_anisotropic_pixels_same_mm():
    assert abs(axes(ellipse(20, 10, (0.5, 1.0)), (0.5, 1.0, 2.0))["long_mm"] - 40) < 1.6


def test_short_axis_is_a_chord_not_hull_width():
    L = np.zeros((1, 60, 60), bool)
    L[0, 0:10, 0:40] = True
    L[0, 0:40, 0:10] = True
    assert axes(L, (1, 1, 1))["short_mm"] < hull_width(L) - 5


def test_axes_lines_have_measured_length():
    a = axes(ellipse(20, 10, (0.5, 0.5)), (0.5, 0.5, 2.0), edge=False)
    (y0, x0), (y1, x1) = a["long_line"]
    assert abs(np.hypot((y1 - y0) * 0.5, (x1 - x0) * 0.5) - a["long_mm"]) < 0.01


def test_axes_lines_are_in_voxel_indices_on_anisotropic_pixels():
    m = ellipse(20, 10, (0.5, 1.0))
    a = axes(m, (0.5, 1.0, 2.0), edge=False)
    assert all(m[a["z"], y, x] for y, x in a["long_line"] + a["short_line"])


def test_axes_empty_is_none():
    assert axes(np.zeros((3, 9, 9), bool), (1, 1, 1)) is None


def test_axes_single_voxel_and_line_do_not_crash():
    m = np.zeros((1, 9, 9), bool)
    m[0, 4, 4] = True
    assert axes(m, (1, 1, 1), edge=False)["long_mm"] == 0
    m[0, 4, 2:7] = True
    assert axes(m, (1, 1, 1), edge=False)["long_mm"] == 4


def test_half_up_rounding():
    assert [half_up(v, 1) for v in (71.25, 6.25, 72.5)] == [71.3, 6.3, 72.5]
    assert half_up(0.125, 2) == 0.13


def test_volume_ml():
    assert volume_ml(np.ones((10, 10, 10), bool), (1, 1, 1)) == 1.0


def bar():
    m = np.zeros((1, 5, 20), bool)
    m[0, 2, 3:13] = True  # one row of 10 px
    return m


def test_edge_to_edge_bar():
    a = axes(bar(), (0.5, 0.8, 1.0))
    assert (a["long_mm"], a["short_mm"]) == approx((5.0, 0.8))
    c = axes(bar(), (0.5, 0.8, 1.0), edge=False)
    assert (c["long_mm"], c["short_mm"]) == approx((4.5, 0.0))


def test_edge_line_end_points_match_the_length():
    a = axes(ellipse(20, 10, (0.5, 0.7)), (0.5, 0.7, 2.0))
    (y0, x0), (y1, x1) = a["long_line"]
    assert abs(np.hypot((y1 - y0) * 0.7, (x1 - x0) * 0.5) - a["long_mm"]) < 0.01


def test_one_pixel_slice_is_one_pixel_wide():
    m = np.zeros((1, 9, 9), bool)
    m[0, 4, 4] = True
    a = axes(m, (0.5, 0.8, 1.0))
    assert (a["long_mm"], a["short_mm"]) == (0.8, 0.5)
    assert a["long_line"] == [[4, 4], [4, 4]]


def test_depth():
    m = np.zeros((10, 3, 3), bool)
    m[3:8] = True
    assert depth_mm(m, 1.25) == 6.25 and depth_mm(m, 1.25, edge=False) == 5.0
    assert depth_mm(np.zeros((4, 3, 3), bool), 1.25) == 0
