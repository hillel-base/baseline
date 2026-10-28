import { renderToString } from "react-dom/server";
import { expect, test } from "vitest";
import { ScanWait } from "./App";
import { OPEN_WAIT_LOCAL, OPEN_WAIT_PRACTICE } from "./texts";

const text = (html: string) => html.replace(/<[^>]+>/g, "");

test("the wait while a scan opens says the time to expect for where the tool runs; the square is hidden from screen readers, the text is a status", () => {
  for (const [embedded, panel, line] of [[true, true, OPEN_WAIT_PRACTICE], [true, false, OPEN_WAIT_LOCAL], [false, true, OPEN_WAIT_LOCAL]] as const) {
    const html = renderToString(<ScanWait embedded={embedded} panel={panel} />); // a practice server; the hosted page with the local engine; the engine's own page
    expect(text(html)).toBe(`Loading scan…${line}`);
    expect(html).toContain('<div class="m-wait" aria-hidden="true"></div>');
    expect(html).toMatch(/<div role="status"><p class="m-wait-title">Loading scan…<\/p><p class="m-wait-note">/);
  }
  expect(OPEN_WAIT_PRACTICE).toBe("The first open after the server wakes can take up to 30 s. Later opens take a few seconds.");
  expect(OPEN_WAIT_LOCAL).toBe("On your computer this takes a few seconds.");
});
