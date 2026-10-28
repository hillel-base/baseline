/** Page texts that the e2e tests check word for word; kept free of imports so a test can import them. */
export const WAITING_LOCAL = "Waiting for the tool on your computer. If Chrome asks whether this site may use apps on your device, choose Allow.";
/** the hosted page's line when the Patients frame does not say it is ready within 8 s. It guesses no cause: by then the page already reaches the engine. */
export const FRAME_BLOCKED = "The patient list could not open here. Use the scan list, or the tool's own page on your computer (http://localhost:8000).";
