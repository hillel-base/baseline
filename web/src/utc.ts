// The one rule for a time read back from Base44, used by the page and by the live check (which imports this file, so keep it free of imports).
/** A time in ms. A time with no zone is UTC, as Base44 reads its own dates back. NaN when absent. */
export const utcTime = (s?: string | null) => (s ? Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`) : NaN);
