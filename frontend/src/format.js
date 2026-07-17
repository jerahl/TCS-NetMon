// Shared time/staleness formatting (spec 10 §6 / phase 10.5 "staleness badging
// pass"). Consolidates the copy-pasted `ageOf` that lived in seven page modules
// into one place so every page badges freshness identically and honestly (§4.5:
// a dead collector shows visibly old timestamps, never fresh-looking data).
//
// Pure JS only (no JSX) — the <Freshness> chip that builds on these lives in
// primitives.jsx.

// Compact age of an ISO timestamp: "12s" / "4m" / "3h" / "2d". Returns null for
// a missing/unparseable value so callers can choose their own placeholder
// (`ageOf(x) || "—"`). Timestamps without a zone are treated as UTC (the API
// serialises naive UTC datetimes).
export function ageOf(iso) {
  const s = ageSeconds(iso);
  if (s === null) return null;
  if (s < 90) return `${Math.round(s)}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 129600) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

// Seconds since an ISO timestamp (or null). For threshold comparisons.
export function ageSeconds(iso) {
  if (!iso) return null;
  const t = Date.parse(iso.endsWith("Z") || iso.includes("+") ? iso : iso + "Z");
  if (Number.isNaN(t)) return null;
  return Math.max(0, (Date.now() - t) / 1000);
}
