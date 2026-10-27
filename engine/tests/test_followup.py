import numpy as np
import SimpleITK as sitk
from lung_engine.followup import map_index, register

N, SP = 80, 2.0  # voxels per side, mm


def volume(centre_mm, shift_mm=(0, 0, 0), z_scale=1.0, radius=14.0):
    """Air with one soft ball and a second smaller one (so the pair is not symmetric); centres in mm (x, y, z).
    shift and z_scale move the contents: p_moving = c + z_scale*(p - c) + shift, c = volume centre."""
    c = np.array([N * SP / 2] * 3)
    idx = np.indices((N, N, N)).astype(float) * SP + SP / 2  # (z, y, x) in mm
    pts = np.stack([idx[2], idx[1], idx[0]], -1)
    inv = np.array([1, 1, 1 / z_scale])
    src = c + (pts - c - np.array(shift_mm)) * inv  # where each output voxel comes from
    arr = np.full((N, N, N), -1000.0)
    for ctr, r, hu in ((centre_mm, radius, 40), (np.array(centre_mm) + [30, 20, -20], 7, 300)):
        arr[np.linalg.norm(src - ctr, axis=-1) <= r] = hu
    img = sitk.GetImageFromArray(arr.astype(np.int16))
    img.SetSpacing((SP, SP, SP))
    return img


def idx_of(mm):  # voxel (z, y, x) containing a point (x, y, z) in mm
    return tuple(int(v // SP) for v in mm[::-1])


def test_register_recovers_a_shift():
    ctr, shift = (60.0, 80.0, 80.0), (10.0, 5.0, 0.0)
    f, m = volume(ctr), volume(ctr, shift)
    got = map_index(register(f, m), f, m, idx_of(ctr))
    assert np.abs(np.subtract(got, idx_of(np.add(ctr, shift)))).max() <= 2


def test_register_recovers_a_deeper_breath():
    ctr, shift, c = (60.0, 70.0, 50.0), (0.0, 0.0, 5.0), N * SP / 2
    f, m = volume(ctr), volume(ctr, shift, z_scale=1.06)
    moved = (ctr[0] + shift[0], ctr[1] + shift[1], c + 1.06 * (ctr[2] - c) + shift[2])
    got = map_index(register(f, m), f, m, idx_of(ctr))
    assert np.abs(np.subtract(got, idx_of(moved))).max() <= 2


def test_map_index_reports_a_point_outside_and_keeps_the_clamped_voxel():
    f = volume((60.0, 80.0, 80.0))
    far, near = sitk.TranslationTransform(3, (500.0, 0.0, 0.0)), sitk.TranslationTransform(3, (4.0, 0.0, 0.0))
    assert map_index(far, f, f, (40, 40, 40), report=True) == ((40, 40, N - 1), True)
    assert map_index(far, f, f, (40, 40, 40)) == (40, 40, N - 1)  # the plain call is unchanged
    assert map_index(near, f, f, (40, 40, 40), report=True) == ((40, 40, 42), False)
    assert map_index(near, f, f, (40, 40, N - 1), report=True) == ((40, 40, N - 1), True)  # 2 voxels past the last one
