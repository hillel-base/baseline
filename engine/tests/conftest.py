import numpy as np, pytest, SimpleITK as sitk
from fastapi.testclient import TestClient
from lung_engine.app import create_app


@pytest.fixture
def dicom_series(tmp_path):
    """8 slices of 64x64, air with a +40 HU ball (radius 6) centred at (z,y,x) = (4,32,32)."""
    z, y, x = np.indices((8, 64, 64))
    arr = np.where((z - 4) ** 2 + (y - 32) ** 2 + (x - 32) ** 2 <= 36, 40, -1000).astype(np.int16)
    d = tmp_path / "RIDER-TEST01" / "ct_test"
    d.mkdir(parents=True)
    w = sitk.ImageFileWriter()
    w.KeepOriginalImageUIDOn()  # else the writer invents a new series UID per file
    for i in range(8):
        s = sitk.GetImageFromArray(arr[i])
        s.SetSpacing((0.7, 0.7))  # the writer takes pixel spacing from the image, not metadata
        for k, v in {"0008|0060": "CT", "0020|000e": "1.2.826.0.1.3680043.8.498.1",
                     "0020|0032": f"0\\0\\{i * 1.25}", "0020|0013": str(8 - i),  # feet-first like RIDER: z = 0 is the highest image number
                     "0008|0018": f"1.2.826.0.1.3680043.8.498.1.{i + 1}",  # unique SOP UID per slice
                     "0020|0037": "1\\0\\0\\0\\1\\0", "0018|0050": "1.25", "0020|0011": "3", "0008|0020": "20010203",
                     "0028|1052": "0", "0028|1053": "1"}.items():
            s.SetMetaData(k, v)
        w.SetFileName(str(d / f"{i:03d}.dcm"))
        w.Execute(s)
    return tmp_path


@pytest.fixture
def runs_dir(tmp_path):
    return tmp_path / "runs"


@pytest.fixture
def log_path(runs_dir):
    return runs_dir / "events.jsonl"


class BallSegmenter:
    """+ click adds a voxel ball, - click removes one, undo restores the mask before the last click."""

    def __init__(self, radius=3):
        self.r, self.prev = radius, None

    def set_image(self, img):
        self.mask, self.prev = np.zeros(img.shape, bool), None

    def click(self, zyx, positive):
        self.prev = self.mask.copy()
        idx = np.indices(self.mask.shape)
        ball = sum((i - c) ** 2 for i, c in zip(idx, zyx)) <= self.r ** 2
        self.mask = self.mask | ball if positive else self.mask & ~ball
        return self.mask.copy()

    def undo(self):
        if self.prev is None:
            return None
        self.mask, self.prev = self.prev, None
        return self.mask.copy()


class EmptySegmenter(BallSegmenter):
    def click(self, zyx, positive):
        return np.zeros(self.mask.shape, bool)


@pytest.fixture
def client(dicom_series, runs_dir):
    return TestClient(create_app(data_root=dicom_series, segmenter_factory=BallSegmenter, runs_dir=runs_dir), base_url="http://localhost")


@pytest.fixture
def client_empty(dicom_series, runs_dir):
    return TestClient(create_app(data_root=dicom_series, segmenter_factory=EmptySegmenter, runs_dir=runs_dir), base_url="http://localhost")
