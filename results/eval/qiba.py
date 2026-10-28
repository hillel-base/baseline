"""The five QIBA VolCT 1B radiologists' outlines (R2) on our scans (protocol §Quality, R2).
Written in eval/ from the stated rule, not copied from our feasibility test's code, so it is a second implementation of
that test's fix of 2026-10-25. The SEG files name no source scan, and on some patients both scans share a grid, so:
- a SEG is placed on a scan only if every frame sits on that scan's voxel grid, with the same pixel spacing and orientation;
- of the scans it fits, it goes to the one whose R1 centre is nearest;
- each scan keeps one outline per reader, the nearest; one more than SAME_MM from R1's centre is another lesion, dropped.
Fractional values are cut at 128 of 255 (0.5)."""
import glob, os, re
import numpy as np, pydicom

SAME_MM = 40  # RIDER: the same lesion lies <= 28 mm from R1's centre, other lesions 93-133 mm (our feasibility test S3c)

def qiba_index(series_dir):
    """{PatientID: [SEG file, ...]} for the QIBA radiologists' SEGs in data/rider/series."""
    out = {}
    for d in sorted(glob.glob(os.path.join(series_dir, "SEG_*"))):
        f = sorted(glob.glob(os.path.join(d, "*.dcm")))[0]
        h = pydicom.dcmread(f, stop_before_pixels=True)
        if "QIBA" in str(h.get("ContentCreatorName", "")): out.setdefault(str(h.PatientID), []).append(f)
    return out

def reader_of(ds):
    return re.search(r"Reader\s*(\d+)", str(ds.ContentCreatorName)).group(1)

def on_grid(ds, ct, shape):
    """The SEG as a boolean mask (z, y, x) on ct's grid, or None if it does not sit exactly on that grid."""
    g = ds.SharedFunctionalGroupsSequence[0]
    row_mm, col_mm = (float(v) for v in g.PixelMeasuresSequence[0].PixelSpacing)
    if abs(col_mm - ct.GetSpacing()[0]) > 1e-3 or abs(row_mm - ct.GetSpacing()[1]) > 1e-3: return None
    d = ct.GetDirection()  # 3 x 3, row-major, columns are the x, y, z axes; DICOM gives the x axis, then the y axis
    if np.abs(np.array([float(v) for v in g.PlaneOrientationSequence[0].ImageOrientationPatient]) - np.array([d[0], d[3], d[6], d[1], d[4], d[7]])).max() > 1e-3: return None
    m = np.zeros(shape, bool)
    for f, fg in zip(ds.pixel_array.reshape(-1, ds.Rows, ds.Columns) >= 128, ds.PerFrameFunctionalGroupsSequence):
        c = np.array(ct.TransformPhysicalPointToContinuousIndex([float(v) for v in fg.PlanePositionSequence[0].ImagePositionPatient]))
        x, y, z = np.rint(c).astype(int)
        if np.abs(c - (x, y, z)).max() > 0.1 or not (0 <= z < shape[0] and 0 <= y and y + ds.Rows <= shape[1] and 0 <= x and x + ds.Columns <= shape[2]):
            return None
        m[z, y:y + ds.Rows, x:x + ds.Columns] |= f
    return m

def centre_mm(mask, ct):
    return np.array(ct.TransformContinuousIndexToPhysicalPoint([float(v) for v in np.argwhere(mask).mean(0)[::-1]]))

def readers(datasets, cts, r1s):
    """datasets: one patient's QIBA SEGs (read); cts, r1s: {side: CT image}, {side: R1 mask z,y,x}.
    Returns ({side: {reader: mask}}, log), log = [(reader, side or None, distance_mm or None, kept)]."""
    c1 = {s: centre_mm(r1s[s], cts[s]) for s in cts}
    best, log = {s: {} for s in cts}, []
    for ds in datasets:
        who, fit = reader_of(ds), {}
        for s in cts:
            m = on_grid(ds, cts[s], r1s[s].shape)
            if m is not None and m.any(): fit[s] = (float(np.linalg.norm(centre_mm(m, cts[s]) - c1[s])), m)
        if not fit:
            log.append((who, None, None, False)); continue
        s = min(fit, key=lambda k: fit[k][0]); d, m = fit[s]
        log.append((who, s, round(d, 1), d <= SAME_MM))
        if d <= SAME_MM and d < best[s].get(who, (np.inf, None))[0]: best[s][who] = (d, m)
    return {s: {w: m for w, (_, m) in r.items()} for s, r in best.items()}, log

if __name__ == "__main__":  # self-check: one SEG fits both scans of a shared grid and must go where its R1 is
    from types import SimpleNamespace as NS
    import SimpleITK as sitk
    ct = sitk.Image(60, 60, 10, sitk.sitkInt16)  # spacing 1 mm, identity direction, origin 0
    def seg(z0, x0, who):
        fgs = [NS(PlanePositionSequence=[NS(ImagePositionPatient=[x0, 2, z])]) for z in (z0, z0 + 1)]
        shared = NS(PixelMeasuresSequence=[NS(PixelSpacing=[1, 1])], PlaneOrientationSequence=[NS(ImageOrientationPatient=[1, 0, 0, 0, 1, 0])])
        return NS(Rows=4, Columns=4, ContentCreatorName=f"QIBA CT 1B Round 2 Reader {who}", SharedFunctionalGroupsSequence=[shared],
                  PerFrameFunctionalGroupsSequence=fgs, pixel_array=np.full((2, 4, 4), 200, np.uint8))
    r1 = {"test": np.zeros((10, 60, 60), bool), "retest": np.zeros((10, 60, 60), bool)}
    r1["test"][1:3, 2:6, 2:6] = True; r1["retest"][6:8, 2:6, 12:16] = True
    far = seg(1, 50, 2); far.PerFrameFunctionalGroupsSequence = [NS(PlanePositionSequence=[NS(ImagePositionPatient=[50, 50, 8])])]; far.pixel_array = far.pixel_array[:1]  # ~60 mm from both R1s
    out, log = readers([seg(1, 2, 1), seg(6, 12, 1), seg(1, 2, 3), far], {"test": ct, "retest": ct}, r1)
    assert set(out["test"]) == {"1", "3"} and set(out["retest"]) == {"1"}, out  # the far one (reader 2) is not kept
    assert [l for l in log if l[0] == "2"][0][3] is False and [l for l in log if l[0] == "2"][0][2] > 40, log
    assert out["test"]["1"][1, 2, 2] and out["retest"]["1"][6, 2, 12] and out["test"]["1"].sum() == 32
    assert reader_of(NS(ContentCreatorName="QIBA CT 1B Round 2 Reader 4")) == "4"
    print("qiba.py self-check ok")
