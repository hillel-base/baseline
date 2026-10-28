# Copied from our feasibility tests' shared code (2026-10-24, commit 425bd67): those tests are throwaway, eval must not depend on them.
"""Shared loaders for RIDER spikes: CT series -> SimpleITK image (HU), DICOM SEG -> masks on the CT grid."""
import glob, os
import numpy as np, pydicom, SimpleITK as sitk

def load_ct(d):
    r = sitk.ImageSeriesReader()
    r.SetFileNames(r.GetGDCMSeriesFileNames(d))
    return r.Execute()  # GDCM applies RescaleSlope/Intercept, so voxels are Hounsfield units

def load_seg(d, ct):
    """Return {segment_number: (algorithm_type, description, mask zyx uint8)} on ct's grid."""
    ds = pydicom.dcmread(glob.glob(os.path.join(d, "*.dcm"))[0])
    frames = ds.pixel_array.reshape(-1, ds.Rows, ds.Columns)
    assert (ds.Rows, ds.Columns) == ct.GetSize()[1::-1], "SEG and CT in-plane grids differ"
    info = {s.SegmentNumber: (s.get("SegmentAlgorithmType", ""), s.get("SegmentDescription", "")) for s in ds.SegmentSequence}
    out = {n: (*info[n], np.zeros(ct.GetSize()[::-1], np.uint8)) for n in info}
    for f, fg in zip(frames, ds.PerFrameFunctionalGroupsSequence):
        n = fg.SegmentIdentificationSequence[0].ReferencedSegmentNumber
        pos = [float(v) for v in fg.PlanePositionSequence[0].ImagePositionPatient]
        x, y, z = ct.TransformPhysicalPointToIndex(pos)
        assert abs(x) <= 1 and abs(y) <= 1, "SEG frame not aligned with CT slice origin"
        out[n][2][z] |= f.astype(np.uint8)
    return out

def manual_mask(seg):
    m = [v[2] for v in seg.values() if v[0] == "MANUAL"]
    assert len(m) == 1, f"expected one MANUAL segment, got {[(k, v[0], v[1]) for k, v in seg.items()]}"
    return m[0]

def centroid_phys(mask, ct):
    """Physical point (mm) of the mask voxel nearest to its centre of mass (stays inside odd shapes)."""
    zyx = np.argwhere(mask)
    c = zyx.mean(0)
    v = zyx[np.argmin(((zyx - c) ** 2).sum(1))]
    return ct.TransformIndexToPhysicalPoint([int(v[2]), int(v[1]), int(v[0])])

def inside(mask, ct, p):
    x, y, z = ct.TransformPhysicalPointToIndex(p)
    sz = ct.GetSize()
    return 0 <= x < sz[0] and 0 <= y < sz[1] and 0 <= z < sz[2] and bool(mask[z, y, x])
