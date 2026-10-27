import os
import platform

os.environ["PYTORCH_ENABLE_MPS_FALLBACK"] = "1"  # must be set before torch is imported

import sys
import threading
import time

import numpy as np
import psutil
import torch
from .devices import choose_device, default_mem_limit_gb
from .outline import WINDOW
from nnInteractive.inference.inference_session import nnInteractiveInferenceSession
from nnInteractive.model_management import ensure_model_available, get_default_model_id

NEEDS_GPU = "nnInteractive needs a graphics chip (Apple MPS or NVIDIA CUDA) or an Intel/AMD processor; this ARM machine has no supported graphics chip."


def _watchdog(limit_gb: float):
    """An earlier CPU run reached 50 GB and starved the Mac: exit rather than swap."""
    me = psutil.Process()
    while True:
        used = me.memory_info().rss + (torch.mps.driver_allocated_memory() if torch.backends.mps.is_available() else 0)
        if used > limit_gb * 1e9:
            print(f"watchdog: memory {used / 1e9:.1f} GB is over LUNG_MEM_LIMIT_GB={limit_gb}, exiting", flush=True)
            os._exit(3)
        time.sleep(1)


class NNISegmenter:
    def __init__(self):
        name = choose_device(torch.cuda.is_available(), torch.backends.mps.is_available(), platform.machine())
        if name is None:
            sys.exit(NEEDS_GPU)
        device = torch.device(name)
        self.device = device.type  # /api/info reports it; "cpu" is the standard-PC mode
        if name == "cpu":
            torch.set_num_threads((os.cpu_count() or 1))  # about 20 s per click on a standard PC (our measurement)
        print(f"nnInteractive device: {name}", flush=True)
        limit = float(os.environ.get("LUNG_MEM_LIMIT_GB") or default_mem_limit_gb(psutil.virtual_memory().total))
        threading.Thread(target=_watchdog, args=(limit,), daemon=True).start()
        t = time.perf_counter()
        # No autozoom: on air it ran the model 3 more times and went past the memory guard.
        # shortcut: an outline stops at the 160-voxel window edge, 80 voxels from the click (50 mm in-plane at 0.625 mm);
        # the page warns when it gets there (at_window_edge); upgrade (autozoom within a memory budget) if a tumour needs more.
        self.session = nnInteractiveInferenceSession(device=device, use_torch_compile=False, verbose=False,
                                                     torch_n_threads=(os.cpu_count() or 1) if name == "cpu" else 8, do_autozoom=False, interactions_storage="tensor")
        # Spike S6: a 160^3 window gives the same Dice as the default 192^3 with less memory. Set it before the warm-up,
        # which would otherwise run once at 192^3 and raise the memory peak.
        warmup = nnInteractiveInferenceSession.warmup
        nnInteractiveInferenceSession.warmup = lambda self: None
        try:
            self.session.initialize_from_trained_model_folder(ensure_model_available(get_default_model_id()))
        finally:
            nnInteractiveInferenceSession.warmup = warmup
        self.session.configuration_manager.configuration["patch_size"] = [WINDOW] * 3
        # nnInteractive feeds float16; Apple GPUs and CPUs are far slower in float16 3D convolution (spike S1)
        net = self.session.network.float()
        fwd = net.forward
        net.forward = lambda x, *a, **k: fwd(x.float(), *a, **k)
        warmup(self.session)
        if device.type == "mps":
            torch.mps.empty_cache()
        self.load_seconds = time.perf_counter() - t
        print(f"nnInteractive ready on {device.type} in {self.load_seconds:.1f} s", flush=True)

    def set_image(self, img: np.ndarray) -> None:
        self.buf = np.zeros(img.shape, np.uint8)
        self.session.set_image(img[None])
        self.session.set_target_buffer(self.buf)

    def click(self, zyx, positive: bool) -> np.ndarray:
        self.session.add_point_interaction(tuple(zyx), include_interaction=positive)
        return self.buf.astype(bool)  # a copy: the buffer is rewritten by the next click

    def undo(self) -> np.ndarray | None:
        return self.buf.astype(bool) if self.session.undo() else None
