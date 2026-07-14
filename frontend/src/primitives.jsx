// Small shared UI primitives, in the reference dashboard's idiom but
// dependency-free (no Zabbix bridges, no CDN).

import { sevLabel, sourceBadge } from "./severity.js";

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
