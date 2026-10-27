import pytest
from lung_engine.devices import choose_device, default_mem_limit_gb


@pytest.mark.parametrize("cuda,mps,machine,want", [
    (True, False, "x86_64", "cuda"), (True, True, "arm64", "cuda"),
    (False, True, "arm64", "mps"), (False, True, "x86_64", "mps"),
    (False, False, "x86_64", "cpu"), (False, False, "AMD64", "cpu"),
    (False, False, "arm64", None), (False, False, "aarch64", None),
])
def test_choose_device(cuda, mps, machine, want):
    assert choose_device(cuda, mps, machine) == want


@pytest.mark.parametrize("gb,want", [(8, 5.6), (16, 11.2), (64, 14)])
def test_default_mem_limit(gb, want):
    assert default_mem_limit_gb(gb * 1e9) == pytest.approx(want)
