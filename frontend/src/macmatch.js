// Separator-agnostic MAC matching for client-side filters (mirrors
// netmon/macmatch.py). Lets an operator type a MAC in any style —
// "bcf310be9980", "bc:f3:10:be:99:80", "BC-F3-10-…" — and match stored
// colon-lowercase MACs. A non-hex query (hostname) is not treated as a MAC.

const HEX = /^[0-9a-f]+$/;

// Bare lowercase hex if q is a plausible MAC fragment, else null.
export function macNorm(q) {
  const stripped = (q || "").replace(/[:\-. ]/g, "").toLowerCase();
  return stripped.length >= 2 && HEX.test(stripped) ? stripped : null;
}

// Does `mac` (a stored value) match the query `q`? MAC-normalised when q looks
// like a MAC, plain case-insensitive substring otherwise.
export function macMatches(mac, q) {
  if (!q) return true;
  const norm = macNorm(q);
  const m = String(mac || "");
  return norm
    ? m.replace(/:/g, "").toLowerCase().includes(norm)
    : m.toLowerCase().includes(q.toLowerCase());
}
