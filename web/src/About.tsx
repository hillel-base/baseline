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
        <form method="dialog"><button>Close</button></form>
      </dialog>
  );
}
