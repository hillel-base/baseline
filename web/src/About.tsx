import type { RefObject } from "react";

export function About({ dialog }: { dialog?: RefObject<HTMLDialogElement> }) {
  return (
    <dialog ref={dialog}>
        <p><strong>Research use only. Not a medical device.</strong></p>
        <p>Outlines come from nnInteractive (weights licence: CC BY-NC-SA 4.0 (non-commercial)). Isensee F., Rokuss M., Krämer L. et al., <em>nnInteractive: Redefining 3D Promptable Segmentation</em>, 2025, arXiv:2503.08373 (DKFZ).</p>
        <p>Practice data from The Cancer Imaging Archive (TCIA), through NCI Imaging Data Commons:</p>
        <ul>
          <li>RIDER Lung CT: Zhao B., Schwartz L. H., Kris M. G., Riely G. J. (2015), doi:10.7937/k9/tcia.2015.u1x8a5nr</li>
          <li>RIDER-LungCT-Seg: Wee L., Aerts H. J. W. L., Kalendralis P., Dekker A. (2020), doi:10.7937/tcia.2020.jit9grk8 (CC BY 3.0)</li>
          <li>QIBA VolCT 1B: McNitt-Gray M. et al. (2020), doi:10.7937/tcia.2020.1c3h-vp70 (CC BY 4.0)</li>
        </ul>
        <p><strong>Nodule finder (optional).</strong> Its suggestions come from a YOLO11n, 2.5D model: Chou L.-F. et al., <em>Diagnostics</em> 2026;16(18):3038, doi:10.3390/diagnostics16183038; weights under CC BY 4.0, doi:10.57967/hf/10295; trained on LUNA16 (CC BY 4.0) and LIDC-IDRI (CC BY 3.0). The finder is its own program under AGPL-3.0 (it uses Ultralytics); the tool starts it as a separate process. Its source code is public: <a href="https://github.com/hillel-base/baseline" target="_blank" rel="noreferrer">github.com/hillel-base/baseline</a>, the finder/ folder. It sends no usage data (YOLO_OFFLINE=1). Our accuracy numbers: Renoust B. et al. (2026), LIDC-annot-NLST501 [Dataset], The Cancer Imaging Archive, doi:10.7937/Y2DX-E334 (CC BY 4.0); NLST images, TCIA, doi:10.7937/TCIA.HMQ8-J677.</p>
        <form method="dialog"><button>Close</button></form>
      </dialog>
  );
}
