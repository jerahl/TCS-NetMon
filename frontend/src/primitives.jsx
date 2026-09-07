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

// ZCD's card structure (reference/assets/styles.css): a bordered .card whose
// header is .card-h > h3 and whose padding lives on .card-b. NetMon previously
// used .card-kicker/.card-title/.card-body, which the ported stylesheet does
// not style — so cards would have rendered edge-to-edge with no padding.
//
// The kicker (a right-aligned meta line: row counts, cache age) has no ZCD
// name; it maps onto .h-meta, which ZCD already defines for exactly that.
// `tight` drops the body padding for full-bleed tables, matching .card-b.tight.
// `source` renders ZCD's provenance chip immediately after the title, which is
// where ZCD puts it in every card (`.card-h › h3 · SourceBadge · .h-spacer`) —
// a card that shows numbers without saying who said so is the thing spec 20 §4
// is trying to stop. `link` is ZCD's `.h-link`: the right-hand "open the full
// thing" affordance.
export function Card({ title, kicker, source, link, tight = false, children }) {
  const hasHeader = title || kicker || source || link;
  return (
    <section className="card">
      {hasHeader && (
        <div className="card-h">
          {title && <h3>{title}</h3>}
          {source && <SourceBadge source={source} />}
          <div className="h-spacer" />
          {kicker && <div className="h-meta">{kicker}</div>}
          {link && (
            <a className="h-link" href={link.href}
               {...(link.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
              {link.label}{link.external ? " ↗" : ""}
            </a>
          )}
        </div>
      )}
      <div className={"card-b" + (tight ? " tight" : "")}>{children}</div>
    </section>
  );
}

// ─── Shell primitives (spec 20 S1) ────────────────────────────────────────
// ZCD's page identity comes from three repeated structures, not from its
// colours (NetMon already ships those verbatim). These are those three, so
// every page adopts the look by composition rather than by re-deriving it.

// One `.host-meta` chip: optional status dot, optional label, value.
// `severity` colours the dot only — never the text, because a coloured value
// next to a coloured dot reads as two separate claims.
export function Pill({ label, value, severity, title }) {
  return (
    <span className="pill" title={title || undefined}>
      {severity && <span className="dot" style={{ background: sevColor(severity) }} />}
      {label && <span className="lbl">{label}</span>}
      {value !== undefined && value !== null && value !== "" && <span className="v">{value}</span>}
    </span>
  );
}

/**
 * ZCD's `.page-header`: title block with an address and a type chip, a row of
 * meta pills under it, a time-range chip on the right.
 *
 * `range` is a plain label, not a picker — NetMon's windows are fixed (24 h
 * ring buffer, live state), so an affordance that implied otherwise would be a
 * lie. The picker arrives if and when the data behind it does.
 */
export function PageHeader({ title, ip, tag, pills = [], range, back, children }) {
  return (
    <div className="page-header">
      {back && (
        <a className="icon-btn" href={back.href} title={back.label || "Back"}
           style={{ marginTop: 4, textDecoration: "none" }}>‹</a>
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="host-title">
          <h1>{title}</h1>
          {ip && <span className="ip">{ip}</span>}
          {tag && <span className="role-tag tpl" style={{ fontSize: 10, padding: "1px 8px" }}>{tag}</span>}
        </div>
        <div className="host-meta">
          {pills.filter(Boolean).map((p, i) => <Pill key={p.label || p.value || i} {...p} />)}
          {children}
        </div>
      </div>
      {range && (
        <div className="timerange" title="NetMon's window is fixed: live state, 24 h of history">
          <span className="range-val">{range}</span>
        </div>
      )}
    </div>
  );
}

// ZCD's tab bar. `badge` carries the count, `kind` tints it ("warn" | "err") —
// a tab whose contents include a problem says so before it is opened.
export function Tabs({ tabs, active, onChange }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.filter(Boolean).map((t) => (
        <button key={t.id} type="button" role="tab" aria-selected={active === t.id}
                className={"tab" + (active === t.id ? " active" : "")}
                title={t.title || undefined}
                onClick={() => onChange(t.id)}>
          {t.label}
          {t.badge !== undefined && t.badge !== null && t.badge !== "" && (
            <span className={"badge" + (t.kind ? " " + t.kind : "")}>{t.badge}</span>
          )}
        </button>
      ))}
    </div>
  );
}

/**
 * One `.stat-grid` cell. `severity` colours the value; `subTone` colours the
 * sub-line ("ok" | "warn" | "err"). Pass `value={null}` for a metric nothing
 * feeds and it renders "—" with the sub-line free to say why — the alternative
 * (a confident 0) is what makes ZCD's own NOC page read as an outage.
 */
export function StatCell({ label, value, unit, sub, subTone, severity, source, title }) {
  return (
    <div className="stat-cell" title={title || undefined}>
      <span className="lbl">
        {label}
        {source && <SourceBadge source={source} />}
      </span>
      <span className="val" style={severity ? { color: sevColor(severity) } : undefined}>
        {value === null || value === undefined ? "—" : value}
        {unit && <span className="u">{unit}</span>}
      </span>
      {sub && <span className={"sub" + (subTone ? " " + subTone : "")}>{sub}</span>}
    </div>
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

// Inline SVG sparkline over an array of {ts, value} points (spec 10.6 chart
// slots, fed by /api/history). Dependency-free; degrades to an honest "—" when
// there aren't enough points yet (history disabled or just started).
export function Sparkline({ points, width = 140, height = 32, color, area = true }) {
  const vals = (points || []).map((p) => (p == null ? null : p.value)).filter((v) => v != null);
  if (vals.length < 2) return <span className="spark-empty dim">—</span>;
  const c = color || SEV_COLOR.ok;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const n = vals.length;
  const px = (i) => (i / (n - 1)) * (width - 2) + 1;
  const py = (v) => height - 2 - ((v - min) / span) * (height - 4);
  const line = vals.map((v, i) => `${i ? "L" : "M"}${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(" ");
  const fillPath = `${line} L${px(n - 1).toFixed(1)},${height} L${px(0).toFixed(1)},${height} Z`;
  return (
    <svg className="spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`}
         preserveAspectRatio="none" aria-hidden="true">
      {area && <path d={fillPath} fill={c} fillOpacity="0.14" stroke="none" />}
      <path d={line} fill="none" stroke={c} strokeWidth="1.5"
            strokeLinejoin="round" strokeLinecap="round" />
    </svg>
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
