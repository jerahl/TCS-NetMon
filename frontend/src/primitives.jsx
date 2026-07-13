// Small shared UI primitives, in the reference dashboard's idiom but
// dependency-free (no Zabbix bridges, no CDN).

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
    return <div className="msg error">Not signed in. <a href="/auth/login">Sign in</a> to view NetMon.</div>;
  }
  return <div className="msg error">Error: {String(error?.message || error)}</div>;
}
