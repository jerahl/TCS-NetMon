// Small shared UI primitives, in the reference dashboard's idiom but
// dependency-free (no Zabbix bridges, no CDN).

import { sevLabel, sourceBadge } from "./severity.js";
import { ageOf, ageSeconds } from "./format.js";

export const SEV_COLOR = {
  ok: "#1fb75a",
  warn: "#e8a415",
  crit: "#e5484d",
  unknown: "#8a8f98",
};

export function sevColor(sev) {
  return SEV_COLOR[sev] || SEV_COLOR.unknown;
}

// Minimal monochrome glyph. Real icon fidelity is a later polish; the port's
// goal is live data + structure, not pixel-perfect iconography.
export function Icon({ name }) {
  return <span className="ico" data-icon={name} aria-hidden="true" />;
}

export function Dot({ severity }) {
  return <span className="dot" style={{ background: sevColor(severity) }} />;
}

export function Badge({ state }) {
  const sev = state?.severity || "unknown";
  const val = state?.value || "—";
  return (
    <span className="badge" style={{ color: sevColor(sev), borderColor: sevColor(sev) }}>
      {val}
    </span>
  );
}

// Severity as the design's word + NetMon's colour (mapping in severity.js).
export function SevText({ severity }) {
  const sev = severity || "unknown";
  return <span style={{ color: sevColor(sev), fontWeight: 600 }}>{sevLabel(sev)}</span>;
}

// Provenance chip (POLLER/SNMP/XIQ/PF/MS/3CX/RCFG). Attribution per widget,
// exactly as the design shows it — value comes from the API `source` column.
export function SourceBadge({ source }) {
  return <span className="src-badge" title={source || "unknown source"}>{sourceBadge(source)}</span>;
}

// Detail route for a device by type: switches (and stacks) get the full
// Switches page (faceplate/ports/PoE); everything else uses the generic detail
// view. Keeps a switch from ever opening "under AP".
export function deviceHref(d) {
  const id = d?.id;
  if (id === undefined || id === null) return "#/";
  return d.device_type === "switch" ? `#/switches/${id}` : `#/ap/${id}`;
}

export function Card({ title, kicker, children }) {
  return (
    <section className="card">
      {kicker && <div className="card-kicker">{kicker}</div>}
      {title && <h3 className="card-title">{title}</h3>}
      <div className="card-body">{children}</div>
    </section>
  );
}

export function Stat({ label, value, severity }) {
  return (
    <div className="stat">
      <div className="stat-value" style={{ color: sevColor(severity) }}>{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

// A uniform freshness chip: "<age> ago", coloured warn once older than
// `staleAfter` seconds, and crit-flagged when `ok === false` (a snapshot whose
// last refresh failed). Renders "never" when there's no timestamp at all
// (spec 10 §6 staleness badging pass).
export function Freshness({ at, staleAfter = 600, ok = true, prefix = "" }) {
  const age = ageOf(at);
  if (age === null) {
    return <span className="freshness" style={{ color: sevColor("unknown") }}>never</span>;
  }
  const secs = ageSeconds(at);
  const stale = !ok || (secs !== null && secs > staleAfter);
  const sev = !ok ? "crit" : stale ? "warn" : "ok";
  const label = !ok ? `STALE · ${age} ago` : `${age} ago`;
  return (
    <span className="freshness" style={{ color: sevColor(sev) }} title={at || ""}>
      {prefix}{label}
    </span>
  );
}

export function Loading({ what }) {
  return <div className="msg">Loading {what}…</div>;
}

export function ErrorMsg({ error }) {
  if (error?.name === "AuthError") {
    // api.js already redirects to /login; this is just the brief interim text.
    return <div className="msg">Redirecting to sign in… <a href="/login">Sign in</a></div>;
  }
  return <div className="msg error">Error: {String(error?.message || error)}</div>;
}
