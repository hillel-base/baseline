# Notice

This finder is a separate program under AGPL-3.0; the rest of the tool calls it as a separate process. Research use only.

Its full licence text is in `LICENSE`. It uses and downloads:

- **Ultralytics** (AGPL-3.0), https://github.com/ultralytics/ultralytics.
- **The model:** Chou L.-F. et al., *Diagnostics* 2026;16(18):3038, doi:10.3390/diagnostics16183038. Weights `Lien-Feng/Lightweight-2-5D-LUNA16` on Hugging Face (CC BY 4.0), doi:10.57967/hf/10295, pinned to revision `d9bc7ec3f06fab778f941fd8f05de145f1a7332c`. The code in that repository (`luna_rev/`) is downloaded at run time and is not copied here.
- **Training data:** LUNA16 (CC BY 4.0) and LIDC-IDRI (CC BY 3.0).
- If accuracy numbers are quoted: LIDC-annot-NLST501, doi:10.7937/Y2DX-E334 (CC BY 4.0).
