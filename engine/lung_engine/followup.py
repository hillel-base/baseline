"""Whole-chest alignment of a follow-up scan, CPU only (SimpleITK).
Settings are those of our feasibility tests S2 (rigid) and S5 (affine step)."""
import SimpleITK as sitk


def _prep(img: sitk.Image) -> sitk.Image:
    return sitk.Cast(sitk.Clamp(img, lowerBound=-1024, upperBound=1500), sitk.sitkFloat32)


def _align(fixed, moving, init, shrink, sigma):
    R = sitk.ImageRegistrationMethod()
    R.SetMetricAsMattesMutualInformation(32)
    R.SetMetricSamplingStrategy(R.RANDOM)
    R.SetMetricSamplingPercentage(0.05, seed=1)
    R.SetInterpolator(sitk.sitkLinear)
    R.SetOptimizerAsRegularStepGradientDescent(2.0, 0.01, 100)
    R.SetOptimizerScalesFromPhysicalShift()
    R.SetShrinkFactorsPerLevel(list(shrink))
    R.SetSmoothingSigmasPerLevel(list(sigma))
    R.SmoothingSigmasAreSpecifiedInPhysicalUnitsOn()
    R.SetInitialTransform(init, inPlace=False)
    return R.Execute(fixed, moving)


def register(fixed: sitk.Image, moving: sitk.Image) -> sitk.Transform:
    """Transform that maps a physical point of `fixed` (the earlier scan) to `moving`: rigid, then affine."""
    f, m = _prep(fixed), _prep(moving)
    init = sitk.CenteredTransformInitializer(f, m, sitk.Euler3DTransform(), sitk.CenteredTransformInitializerFilter.GEOMETRY)
    rigid = _align(f, m, init, (8, 4), (4.0, 2.0))
    e = sitk.Euler3DTransform(sitk.CompositeTransform(rigid).GetNthTransform(0))
    a = sitk.AffineTransform(3)
    a.SetCenter(e.GetCenter()); a.SetMatrix(e.GetMatrix()); a.SetTranslation(e.GetTranslation())
    return _align(f, m, a, (4, 2), (2.0, 1.0))


def map_index(tx, fixed: sitk.Image, moving: sitk.Image, zyx, report: bool = False):
    """Voxel (z, y, x) of `fixed` -> voxel of `moving`, clamped to the volume.
    With report=True: (that voxel, True when the point fell outside `moving` and was clamped)."""
    z, y, x = zyx
    p = tx.TransformPoint(fixed.TransformContinuousIndexToPhysicalPoint((float(x), float(y), float(z))))
    ix = moving.TransformPhysicalPointToContinuousIndex(p)
    raw = [int(round(c)) for c in ix[::-1]]
    out = tuple(max(0, min(n - 1, r)) for r, n in zip(raw, moving.GetSize()[::-1]))
    return (out, list(out) != raw) if report else out
