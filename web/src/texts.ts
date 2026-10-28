/** Page texts that the e2e tests check word for word; kept free of imports so a test can import them. */
export const WAITING_LOCAL = "Waiting for the tool on your computer. If Chrome asks whether this site may use apps on your device, choose Allow.";
/** the hosted page's line when the Patients frame does not say it is ready within 8 s. It guesses no cause: by then the page already reaches the engine. */
export const FRAME_BLOCKED = "The patient list could not open here. Use the scan list, or the tool's own page on your computer (http://localhost:8000).";
/** The line under "Loading scan…" while a scan opens. Practice server: its first read after a wake goes to its storage (30 to 35 s, measured 2026-10-28), later ones to its cache (about 4 s).
 * Local engine: a RIDER scan loads in about 1 s on the development Mac (2026-10-28); "a few seconds" leaves room for a slower computer. */
export const OPEN_WAIT_PRACTICE = "The first open after the server wakes can take up to 30 s. Later opens take a few seconds.";
export const OPEN_WAIT_LOCAL = "On your computer this takes a few seconds.";
