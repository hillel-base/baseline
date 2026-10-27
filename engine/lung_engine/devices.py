"""Device and memory choices as pure functions (no torch import), so they are testable anywhere."""

INTEL_AMD = ("x86_64", "AMD64")


def choose_device(cuda: bool, mps: bool, machine: str) -> str | None:
    """CUDA, then Apple MPS, then the CPU only on an Intel/AMD machine; None means refuse (an Apple chip without MPS)."""
    if cuda:
        return "cuda"
    if mps:
        return "mps"
    return "cpu" if machine in INTEL_AMD else None


def default_mem_limit_gb(total_bytes: float) -> float:
    return min(14.0, 0.7 * total_bytes / 1e9)
