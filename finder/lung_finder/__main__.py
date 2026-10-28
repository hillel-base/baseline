"""Nodule finder (research use only). AGPL-3.0, see ../LICENSE.
python -m lung_finder --image <volume file, e.g. .mha, in HU> --out <file.json> [--threads N]
python -m lung_finder --weights   (only downloads the pinned weights: a practice server does it at start)"""
import argparse, json, os, sys, time
from pathlib import Path

REPO, REV = "Lien-Feng/Lightweight-2-5D-LUNA16", "d9bc7ec3f06fab778f941fd8f05de145f1a7332c"
NAME = "Chou 2.5D YOLO11n Exp3_2p5D_Loose fold0"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--image")  # the engine writes the volume it loaded, so every scan is read the same way
    ap.add_argument("--out")
    ap.add_argument("--weights", action="store_true")
    ap.add_argument("--threads", type=int, default=max(1, (os.cpu_count() or 2) // 2))
    a = ap.parse_args()
    if not a.weights and not (a.image and a.out):
        ap.error("--image and --out are required (or --weights alone)")
    t0 = time.perf_counter()
    home = Path.home() / ".lung-finder"  # every download and config stays here; set before the imports below
    (home / "ultralytics").mkdir(parents=True, exist_ok=True)
    os.environ.update(LUNA_DEVICE="cpu", LUNA_INFER_HALF="0", LUNA_INFER_BATCH="16", HF_HOME=str(home / "hf"),
                      YOLO_CONFIG_DIR=str(home / "ultralytics"), OMP_NUM_THREADS=str(a.threads),
                      YOLO_OFFLINE="1")  # no usage events, no online checks: hospital computers stay quiet
    import cv2, numpy as np, SimpleITK as sitk, torch
    cv2.setNumThreads(a.threads)
    from huggingface_hub import snapshot_download
    torch.set_num_threads(a.threads)
    repo = snapshot_download(REPO, revision=REV, local_dir=home / REV,
                             allow_patterns=["luna_rev/*", "weights/Exp3_2p5D_Loose/fold0/*"])
    sys.path.insert(0, repo)
    from ultralytics import YOLO
    from luna_rev.io_luna import ScanMeta, normalize_hu
    from luna_rev.predict import candidates_to_world, cluster_to_3d, detect_volume
    if a.weights:  # after the imports: a server's start pays the cold imports once, so its first Find after a start or a wake does not
        print(f"finder weights ready: {REPO}@{REV[:7]}")
        return
    ct = sitk.ReadImage(a.image)  # HU, with the scan's own geometry
    model = YOLO(os.path.join(repo, "weights", "Exp3_2p5D_Loose", "fold0", "best.pt"))
    meta = ScanMeta("scan", np.array(ct.GetSize()), np.array(ct.GetSpacing()), np.array(ct.GetOrigin()), np.array(ct.GetDirection()).reshape(3, 3))
    cl = cluster_to_3d(detect_volume(model, normalize_hu(sitk.GetArrayFromImage(ct)), "naive"))[:150]
    pts = np.asarray(candidates_to_world(cl, meta)).reshape(-1, 3)
    cands = [{"x": float(p[0]), "y": float(p[1]), "z": float(p[2]), "score": float(s)} for p, s in zip(pts, cl[:, 5])]
    with open(a.out, "w") as f:
        json.dump({"finder": NAME, "candidates": cands, "seconds": round(time.perf_counter() - t0, 1)}, f)


if __name__ == "__main__":
    main()
