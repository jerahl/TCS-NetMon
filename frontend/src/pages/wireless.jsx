import React from "react";
import { getJSON } from "../api.js";
import {
  Loading, ErrorMsg, SourceBadge, PageHeader, Tabs, Freshness, sevColor,
} from "../primitives.jsx";
import { SshButton } from "../ssh.jsx";
import { ActionButton, ActionAudit } from "../actions.jsx";
import { IssuesForDevice } from "./issues.jsx";

// Wireless APs — ZCD's AP Detail page, ported (spec 18).
//
// Layout, class names and card order follow reference/assets/{app,shell,tabs}.jsx:
// page header + tab bar over a `.zbx-layout` whose left column is the AP
// Navigator and whose right column is the device card, the tab content and
// the data panel. The stylesheet was ported verbatim in #25, so this file
// only has to emit ZCD's markup.
//
// Deliberately NOT ported: every number ZCD read from Zabbix items that NetMon
// has no source for — CPU/memory (ap_details.cpu_pct/mem_pct, NULL until d360
// telemetry is sourced), radio noise and utilisation, RADIUS association/auth
// failure counts, ICMP loss % and per-AP 24h history. Those cells keep their
// place and render "—" with the reason, never a confident 0 (CLAUDE.md §4.5);
// ZCD itself showed "0%" CPU on an AP it could not reach, which is exactly the
// lie this avoids. Where NetMon has an honest substitute (reachability tier
// for packet loss, PF registration for auth failures) the card names it.
//
// Division of labour with #/xiq: that page is the fleet dashboard; this one is
// the per-AP drill-down. NetMon tables only — zero XIQ/PF calls at render.

const REFRESH_MS = 30000;
const NAV_COLLAPSE_KEY = "netmon.wireless.collapsedSites";
const LOAD_WARN = 35;
const LOAD_HIGH = 50;
const LINK = { color: "inherit", textDecoration: "none" };

// ─────────────────────────────── state helpers ──────────────────────────────

// One source's verdict as 1 (up) / 0 (down) / null (no reading). XIQ's
// "unknown"/"blind" is null on purpose: no reading is not a down reading, and
// an unmanaged AP is not down (the XIQ collector's admin-state rule).
function srcVal(v) {
  if (v === "up") return 1;
  if (v === "down") return 0;
  return null;
}

// ZCD's composeApState over the sources NetMon has: XIQ cloud status, ICMP
// ping, and SNMP once the poller writes an `snmp` row for APs. All known
// sources up → ok; all down → down; mixed → warn (degraded); none → idle.
function composeState(sources) {
  const known = sources.filter((v) => v !== null);
  if (!known.length) return "idle";
  if (known.every((v) => v === 1)) return "ok";
  if (known.every((v) => v === 0)) return "down";
  return "warn";
}

function apState(ap) {
  return composeState([srcVal(ap.status), srcVal(ap.ping)]);
}

function hasProblem(ap) {
  const s = apState(ap);
  return s === "down" || s === "warn";
}

const STATE_LABEL = { ok: "Connected", warn: "Degraded", down: "Unreachable", idle: "Unknown" };
const STATE_COLOR = { ok: "var(--ok)", warn: "var(--warn)", down: "var(--err)", idle: "var(--muted)" };
const STATE_SEV = { ok: "ok", warn: "warn", down: "crit", idle: "unknown" };

function loadLevel(n) {
  if (n > LOAD_HIGH) return "high";
  if (n > LOAD_WARN) return "warn";
  return "ok";
}

function fmtUptime(s) {
  s = Number(s) || 0;
  if (s <= 0) return "—";
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${String(h).padStart(2, "0")}h ${String(m).padStart(2, "0")}m`;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${m}m`;
}

// DB timestamps arrive naive-UTC ("2026-10-07 14:02:11"); ISO ones may carry a zone.
function parseTs(iso) {
  if (!iso) return NaN;
  const s = String(iso);
  const hasZone = /[zZ]|[+-]\d\d:?\d\d$/.test(s);
  return Date.parse(hasZone ? s : `${s.replace(" ", "T")}Z`);
}

function fmtTime(iso) {
  const t = parseTs(iso);
  if (!Number.isFinite(t)) return iso ? String(iso) : "—";
  const d = new Date(t);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString([], { hour12: false })
    : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

// First radio on a band. AP305C is dual-5 GHz on this fleet, so wifi0 is not
// assumed to be 2.4 — the band column (or failing that the channel) decides.
function radioOnBand(radios, band) {
  return (radios || []).find((r) => {
    if (r.band) return String(r.band) === band;
    const ch = Number(r.channel);
    if (!Number.isFinite(ch) || ch <= 0) return false;
    return band === "2.4" ? ch <= 14 : ch >= 36;
  }) || null;
}

// ──────────────────────────────── glyphs ────────────────────────────────────

const GLYPH = {
  search: <><circle cx="7" cy="7" r="4.5" /><path d="m13 13-2.5-2.5" /></>,
  check: <path d="m3 8 3.5 3.5L13 5" />,
  alert: <><path d="M8 2.5 1.5 13.5h13L8 2.5Z" /><path d="M8 6.5v3M8 11.3v.2" /></>,
  external: <path d="M9 2.5h4.5V7M13.5 2.5 7 9M11 8v5.5H2.5V5H8" />,
  refresh: <><path d="M2.5 8a5.5 5.5 0 0 1 9.5-3.8M13.5 2v3.5H10" /><path d="M13.5 8a5.5 5.5 0 0 1-9.5 3.8M2.5 14v-3.5H6" /></>,
  dash: <path d="M4 8h8" />,
};

function Glyph({ name, size = 12 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor"
         strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {GLYPH[name]}
    </svg>
  );
}

// ─────────────────────────────── AP Navigator ───────────────────────────────

function loadCollapsed() {
  try {
    const raw = localStorage.getItem(NAV_COLLAPSE_KEY);
    return raw ? new Set(JSON.parse(raw)) : null;
  } catch {
    return null;  // private mode / corrupt value — fall back to defaults
  }
}

function saveCollapsed(set) {
  try {
    localStorage.setItem(NAV_COLLAPSE_KEY, JSON.stringify([...set]));
  } catch {
    /* non-fatal: collapse state is a convenience, not data */
  }
}

function NavHost({ ap, active }) {
  const state = apState(ap);
  const dot = STATE_COLOR[state];
  const clients = ap.clients_total ?? 0;
  const level = loadLevel(clients);
  const loadColor = level === "high" ? "var(--err)" : level === "warn" ? "var(--warn)" : "var(--fg)";
  const loadTitle = level === "high" ? `Client load HIGH (> ${LOAD_HIGH} clients)`
                  : level === "warn" ? `Client load WARN (> ${LOAD_WARN} clients)`
                  : `${clients} clients`;
  const ip = ap.mgmt_ip || ap.ip || "no IP";
  return (
    <a className={"ap-nav-host" + (active ? " active" : "")} style={LINK}
       href={`#/wireless/${ap.id}`}
       title={`${ap.name} · ${ip} · ${ap.model || "model ?"} · ${STATE_LABEL[state]} · ${loadTitle}`}>
      <span className="ap-led" style={{ background: dot, boxShadow: state === "ok" ? `0 0 4px ${dot}` : "none" }} />
      <div className="ap-meta-col">
        <div className="ap-id">{ap.name}</div>
        <div className="ap-sub">{ap.model || "—"} · {ip}</div>
      </div>
      <div className="ap-cli" title={loadTitle}>
        <div className="n" style={{ color: loadColor, fontWeight: level === "ok" ? 500 : 700 }}>
          {ap.clients_total ?? "—"}
        </div>
        <div className="u">cli</div>
      </div>
    </a>
  );
}

export function ApNavigator({ fleet, activeId }) {
  const [query, setQuery] = React.useState("");
  const [problemsOnly, setProblemsOnly] = React.useState(false);
  const [collapsed, setCollapsed] = React.useState(() => loadCollapsed());

  // No saved preference: ZCD's default — every site collapsed except the one
  // holding the selected AP.
  const activeSite = fleet.find((a) => a.id === activeId)?.site || "Unassigned";
  const isCollapsed = (site) => (collapsed ? collapsed.has(site) : site !== activeSite);

  const toggle = (site) => {
    setCollapsed((prev) => {
      const next = new Set(prev ||
        fleet.map((a) => a.site || "Unassigned").filter((s) => s !== activeSite));
      next.has(site) ? next.delete(site) : next.add(site);
      saveCollapsed(next);
      return next;
    });
  };

  const q = query.trim().toLowerCase();
  const sites = {};
  for (const ap of fleet) (sites[ap.site || "Unassigned"] ||= []).push(ap);
  const siteNames = Object.keys(sites).sort((a, b) => a.localeCompare(b));

  const totalAps = fleet.length;
  const totalClients = fleet.reduce((n, a) => n + (a.clients_total || 0), 0);
  const down = fleet.filter((a) => apState(a) === "down").length;
  const degraded = fleet.filter((a) => apState(a) === "warn").length;
  const unknown = fleet.filter((a) => apState(a) === "idle").length;
  const healthy = totalAps - down - degraded - unknown;

  return (
    <div className="card ap-nav-card">
      <div className="card-h">
        <h3>AP Navigator</h3>
        <SourceBadge source="xiq" />
        <div className="h-spacer" />
        <span className="h-meta">{totalAps} APs</span>
      </div>
      <div className="ap-nav-search">
        <Glyph name="search" />
        <input placeholder="Filter by id, ip, site…" spellCheck={false}
               value={query} onChange={(e) => setQuery(e.target.value)} />
        {query ? <span className="ap-nav-clear" onClick={() => setQuery("")}>×</span> : null}
      </div>
      <div className="ap-nav-filter">
        <div className="seg-toggle">
          <button type="button" className={"seg-btn" + (!problemsOnly ? " active" : "")}
                  onClick={() => setProblemsOnly(false)}>All {totalAps}</button>
          <button type="button" className={"seg-btn" + (problemsOnly ? " active" : "")}
                  onClick={() => setProblemsOnly(true)}
                  title="APs down, or degraded (XIQ and ping disagree)">
            Problems {down + degraded}
          </button>
        </div>
      </div>
      <div className="ap-nav-summary">
        <span><b>{totalClients.toLocaleString()}</b> clients</span>
        <span className="dot-sep">·</span>
        <span><b style={{ color: "var(--ok)" }}>{healthy}</b> healthy</span>
        <span className="dot-sep">·</span>
        <span title="One source says down, the other up"><b style={{ color: "var(--warn)" }}>{degraded}</b> degraded</span>
        <span className="dot-sep">·</span>
        <span><b style={{ color: "var(--err)" }}>{down}</b> down</span>
      </div>
      <div className="ap-nav">
        {siteNames.map((site) => {
          const all = sites[site];
          let matched = q
            ? all.filter((a) => `${a.name} ${a.mgmt_ip || ""} ${a.ip || ""} ${a.model || ""} ${site}`
                .toLowerCase().includes(q))
            : all;
          if (problemsOnly) matched = matched.filter(hasProblem);
          if ((q || problemsOnly) && matched.length === 0) return null;
          // A filter auto-expands every surviving site, as in ZCD.
          const filtering = Boolean(q || problemsOnly);
          const expanded = filtering || !isCollapsed(site);
          const downCount = all.filter((a) => apState(a) === "down").length;
          const degCount = all.filter((a) => apState(a) === "warn").length;
          const holdsActive = all.some((a) => a.id === activeId);
          return (
            <div className="ap-nav-section" key={site}>
              <div className={"ap-nav-site" + (expanded ? "" : " collapsed")}
                   role="button" tabIndex={0} aria-expanded={expanded}
                   onClick={() => !filtering && toggle(site)}
                   onKeyDown={(e) => {
                     if ((e.key === "Enter" || e.key === " ") && !filtering) { e.preventDefault(); toggle(site); }
                   }}>
                <svg className="caret" viewBox="0 0 16 16" fill="none" stroke="currentColor"
                     strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m4 6 4 4 4-4" />
                </svg>
                <span className="site-name">{site}</span>
                <span className="site-count">{matched.length}</span>
                {/* A collapsed site still confesses its problems (§4.5). */}
                {downCount > 0 && (
                  <span className="site-down" title={`${downCount} AP${downCount === 1 ? "" : "s"} down (XIQ + ping)`}>
                    {downCount}↓
                  </span>
                )}
                {degCount > 0 && (
                  <span className="site-drift" title={`${degCount} AP${degCount === 1 ? "" : "s"} degraded (XIQ and ping disagree)`}>
                    {degCount}~
                  </span>
                )}
              </div>
              <div className={"ap-nav-children" + (expanded ? "" : " hidden")}>
                {matched.map((ap) => <NavHost key={ap.id} ap={ap} active={ap.id === activeId} />)}
              </div>
              {!expanded && holdsActive && <div className="host-nav-hint">contains the selected AP</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─────────────────────────────── device card ────────────────────────────────

function ApStatusPills({ xiq, snmp, ping }) {
  const cell = (label, val, title) => {
    const color = val === 1 ? "var(--ok)" : val === 0 ? "var(--err)" : "var(--muted)";
    const text = val === 1 ? "UP" : val === 0 ? "DOWN" : "—";
    return (
      <span className="ap-src-pill" title={title}>
        <span className="ap-src-lbl">{label}</span>
        <span className="ap-src-dot" style={{ background: color }} />
        <span className="ap-src-v" style={{ color }}>{text}</span>
      </span>
    );
  };
  return (
    <div className="ap-src-row">
      {cell("XIQ", xiq, "XIQ cloud connectivity (source_status)")}
      {cell("SNMP", snmp, snmp === null
        ? "No SNMP reading for this AP — not polled, which is not the same as down"
        : "NetMon poller sysUpTime check")}
      {cell("PING", ping, "ICMP ping (NetMon fping sweep)")}
    </div>
  );
}

export function DeviceCard({ ap, state, meta }) {
  const d = ap.detail || {};
  const st = ap.state || {};
  const color = STATE_COLOR[state];
  const clients = d.clients_total ?? (ap.clients || []).length;
  const level = loadLevel(clients);
  const up = ap.uplink;
  const pfMac = ap.pf?.mac;

  return (
    <div className="card device-card-h">
      <div className="dev-h-img">
        <svg width="56" height="56" viewBox="0 0 60 60" aria-hidden="true">
          <ellipse cx="30" cy="46" rx="22" ry="4" fill="rgba(0,0,0,0.3)" />
          <rect x="6" y="22" width="48" height="20" rx="10" fill="#e8ecf4" />
          <rect x="6" y="22" width="48" height="6" rx="10" fill="#f4f7fc" />
          <circle cx="30" cy="32" r="3" fill="#181f2c" />
          <circle cx="30" cy="32" r="1" fill={color} />
        </svg>
      </div>

      <div className="dev-h-id">
        <div className="device-name">{ap.name}</div>
        <div className="status-line">
          <span className="dot" style={{ background: color }} />
          <span style={{ color }}>{STATE_LABEL[state]}</span>
          <span className="muted" style={{ marginLeft: 6 }}>· uptime {fmtUptime(d.uptime_s)}</span>
        </div>
        <ApStatusPills xiq={srcVal(st.source_status?.value)}
                       snmp={srcVal(st.snmp?.value)}
                       ping={srcVal(st.ping?.value)} />
        <div className="dev-h-sub mono">{ap.mgmt_ip || d.ip || "—"}{d.model ? ` · ${d.model}` : ""}</div>
      </div>

      <div className="dev-h-block dev-h-loc">
        <div className="label">Location</div>
        <div className="v">
          {ap.site || "Unassigned"}
          {d.network_policy && (
            <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>policy · {d.network_policy}</div>
          )}
        </div>
      </div>

      <div className="dev-h-block dev-h-cli">
        <div className="label">Clients</div>
        <div className="v"
             style={{
               fontFamily: "var(--mono)", fontSize: 18, fontWeight: 600,
               color: level === "high" ? "var(--err)" : level === "warn" ? "var(--warn)" : "var(--fg)",
               display: "flex", alignItems: "center", gap: 6,
             }}
             title={level === "high" ? `HIGH client load · over ${LOAD_HIGH} clients`
                  : level === "warn" ? `Elevated client load · over ${LOAD_WARN} clients` : undefined}>
          {Number(clients).toLocaleString()}
          {level === "high" && <span className="role-tag guest" style={{ fontSize: 9, padding: "0 6px" }}>HIGH</span>}
          {level === "warn" && <span className="role-tag av" style={{ fontSize: 9, padding: "0 6px" }}>WARN</span>}
        </div>
      </div>

      <div className="dev-h-block dev-h-templates">
        <div className="label">Uplink <SourceBadge source={up ? "snmp" : "pf"} /></div>
        <div className="v">
          {up ? (
            <>
              <a className="tpl-chip mono" style={LINK} href={`#/switches/${up.switch_device_id}`}
                 title={`Switch${up.switch_site ? ` · ${up.switch_site}` : ""} (resolved from the FDB)`}>
                {up.switch_name}
              </a>
              <span className="tpl-chip mono"
                    title={up.poe_cycle_safe ? `Access port confirmed — ${up.why}` : `Unconfirmed — ${up.why}`}
                    style={up.poe_cycle_safe ? undefined : { borderColor: "var(--warn)", color: "var(--warn)" }}>
                {up.port || `ifIndex ${up.ifindex}`}
              </span>
            </>
          ) : ap.pf?.last_switch ? (
            <>
              <span className="tpl-chip mono" title="Switch (per PacketFence locationlog)">{ap.pf.last_switch}</span>
              <span className="tpl-chip mono" title="Port (per PacketFence locationlog)">{ap.pf.last_port || "port?"}</span>
            </>
          ) : (
            <span className="muted">not resolved</span>
          )}
        </div>
      </div>

      <div className="dev-h-actions">
        <div className="ap-pf-actions">
          <div className="ap-pf-btns">
            {meta?.packetfence_url && pfMac ? (
              <a className="pf-btn"
                 href={`${meta.packetfence_url}/admin/#/node/${encodeURIComponent(pfMac)}`}
                 target="_blank" rel="noopener noreferrer">
                <Glyph name="external" size={11} /> View in PacketFence
              </a>
            ) : (
              <span className="pf-btn" style={{ opacity: 0.4, cursor: "not-allowed" }}
                    title={pfMac ? "PacketFence URL not configured" : "PacketFence does not know this AP's MAC"}>
                <Glyph name="external" size={11} /> View in PacketFence
              </span>
            )}
            {pfMac && (
              <ActionButton className="pf-btn" compact actionKey="reevaluate_access" path="reevaluate-access"
                            label="Reevaluate access" body={{ mac: pfMac, device_id: ap.id }} />
            )}
            <ActionButton className="pf-btn" compact actionKey="ap_reboot" path="ap-reboot"
                          label="Reboot AP" body={{ device_id: ap.id }} />
            {/* Cycle PoE only against a corroborated access port: an AP's MAC
                is learned on every trunk in its path, and bouncing one of those
                takes out a whole switch (netmon/uplink.py). */}
            {up?.poe_cycle_safe ? (
              <ActionButton className="pf-btn" compact actionKey="poe_cycle" path="poe-cycle"
                            label={`Cycle PoE ${up.port}`}
                            body={{ device_id: up.switch_device_id, port: up.port }} />
            ) : up ? (
              <button type="button" className="pf-btn warn" disabled
                      title={`Cycle PoE needs a confirmed access port — ${up.why}`}>
                <Glyph name="refresh" size={11} /> Cycle PoE
              </button>
            ) : null}
            {pfMac && (
              <ActionButton className="pf-btn" compact actionKey="restart_port" path="restart-port"
                            label="Restart port" body={{ mac: pfMac, device_id: ap.id }} />
            )}
            <SshButton host={ap.mgmt_ip} name={ap.name} />
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────── overview tab ───────────────────────────────

function HealthRing({ label, value, color, sub }) {
  const missing = value === null || value === undefined || Number.isNaN(Number(value));
  const v = missing ? 0 : Math.max(0, Math.min(100, Number(value)));
  const r = 40;
  const circ = 2 * Math.PI * r;
  return (
    <div className="health-cell">
      <div className="ring">
        <svg width="92" height="92" aria-hidden="true">
          <circle cx="46" cy="46" r={r} stroke="rgba(255,255,255,0.06)" strokeWidth="6" fill="none" />
          <circle cx="46" cy="46" r={r} stroke={missing ? "var(--muted)" : color} strokeWidth="6" fill="none"
                  strokeDasharray={`${(circ * v) / 100} ${circ}`} strokeLinecap="round"
                  transform="rotate(-90 46 46)" />
        </svg>
        <div className="ring-label">
          <div className="ring-val">{missing ? "—" : `${Number.isInteger(v) ? v : v.toFixed(1)}%`}</div>
        </div>
      </div>
      <div className="h-label">{label}</div>
      {sub && <div className="h-sub" style={{ fontSize: 10, color: "var(--muted)", marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function Issue({ n, label, tone, big, title }) {
  const icon = tone === "ok" ? "check" : tone === "muted" ? "dash" : "alert";
  return (
    <div className={`issue ${tone}`} title={title}>
      <div className="ico"><Glyph name={icon} size={16} /></div>
      <div className="num" style={big ? { fontSize: 22 } : undefined}>{n}</div>
      <div className="lbl">{label}</div>
    </div>
  );
}

function SparkCell({ label, value, unit, note = "no history" }) {
  const missing = value === null || value === undefined || value === "";
  return (
    <div className="spark-cell">
      <div className="lbl">{label}</div>
      <div className="val" style={missing ? { color: "var(--muted)" } : undefined}>
        {missing ? "—" : value}{!missing && unit && <span className="u">{unit}</span>}
      </div>
      <div style={{ height: 30, display: "flex", alignItems: "center", color: "var(--muted)", fontSize: 10 }}>
        {note}
      </div>
    </div>
  );
}

function KvCard({ title, meta, rows }) {
  return (
    <div className="card">
      <div className="card-h"><h3>{title}</h3><div className="h-spacer" /><span className="h-meta">{meta}</span></div>
      <div className="kv">
        {rows.map(([k, v, src]) => (
          <React.Fragment key={k}>
            <div className="k">{k}</div>
            <div className="v">{v === null || v === undefined || v === "" ? "—" : v}</div>
            <div className="b">{src && <SourceBadge source={src} />}</div>
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

// NetMon's reachability tiers (netmon/reachability.py) stand in for ZCD's
// ICMP-loss tile: they answer the same question — can we actually reach it —
// and additionally say which path failed.
const REACH = {
  up: ["Reachable", "ok", "XIQ and ping both see it"],
  down_confirmed: ["Down", "err", "XIQ and ping both lost it"],
  down_network_only: ["Ping lost", "warn", "XIQ connected, ICMP fails — check ACL / mgmt VLAN"],
  down_source_only: ["XIQ lost", "warn", "Pings, but XIQ says disconnected — cloud path"],
};

function srcShort(src) {
  const s = String(src || "").toLowerCase();
  if (s === "packetfence") return "PF";
  if (s === "poller") return "PING";
  return (s || "—").toUpperCase().slice(0, 6);
}

function EventRow({ e }) {
  const sev = e.severity === "crit" ? "err" : e.severity === "ok" ? "ok" : e.severity === "warn" ? "warn" : "info";
  const c = { err: "var(--err)", warn: "var(--warn)", ok: "var(--ok)", info: "var(--muted)" }[sev];
  return (
    <div className="event">
      <div className="ts" title={e.occurred_at || ""}>{fmtTime(e.occurred_at)}</div>
      <div className="src">{srcShort(e.source)}</div>
      <span className="sev" style={{ color: c, borderColor: c }}>{sev === "err" ? "CRIT" : sev.toUpperCase()}</span>
      <div className="msg">
        {e.dimension}: {e.old_value ?? "—"} → <b>{e.new_value ?? "—"}</b>
      </div>
    </div>
  );
}

function EventList({ events, limit }) {
  const rows = limit ? (events || []).slice(0, limit) : (events || []);
  return (
    <div className="events">
      {rows.length === 0 ? (
        <div style={{ padding: 20, color: "var(--muted)", fontSize: 12, textAlign: "center" }}>
          No state transitions recorded for this AP.
        </div>
      ) : rows.map((e) => <EventRow key={e.id} e={e} />)}
    </div>
  );
}

export function OverviewTab({ ap }) {
  const d = ap.detail || {};
  const st = ap.state || {};
  const clients = ap.clients || [];
  const r24 = radioOnBand(ap.radios, "2.4");
  const r5 = radioOnBand(ap.radios, "5");
  const up = ap.uplink;
  const weak = clients.filter((c) => c.rssi_dbm != null && c.rssi_dbm < -70).length;
  const unreg = clients.filter((c) => c.pf_status && c.pf_status !== "reg").length;
  const dayAgo = Date.now() - 86400e3;
  const flaps = (ap.events || []).filter((e) => e.severity === "crit" && parseTs(e.occurred_at) >= dayAgo).length;
  const tone = (n, warnAt, errAt) => (n >= errAt ? "err" : n >= warnAt ? "warn" : "ok");
  const reach = REACH[st.reachability?.value] || ["—", "muted", "No reachability classification yet"];

  return (
    <div className="overview">
      <div className="row" style={{ gridTemplateColumns: "1.4fr 1fr .9fr", marginBottom: 14 }}>
        <div className="card">
          <div className="card-h">
            <h3>Device Health</h3>
            <SourceBadge source="xiq" />
            <div className="h-spacer" />
            <span className="h-meta">XIQ device cache · {fmtTime(d.updated_at)}</span>
          </div>
          <div className="health-grid" style={{ gridTemplateColumns: "repeat(2, 1fr)" }}>
            <HealthRing label="CPU Usage" value={d.cpu_pct} color="var(--zbx)"
                        sub={d.cpu_pct == null ? "not collected yet" : null} />
            <HealthRing label="Memory Usage" value={d.mem_pct} color="var(--info)"
                        sub={d.mem_pct == null ? "not collected yet" : null} />
          </div>
        </div>

        <div className="card">
          <div className="card-h">
            <h3>Connectivity Issues</h3>
            <SourceBadge source="xiq" />
            <SourceBadge source="pf" />
            <div className="h-spacer" />
            <span className="h-meta">Total Clients: <b style={{ color: "var(--fg)" }}>{clients.length.toLocaleString()}</b></span>
          </div>
          <div className="issues">
            <Issue n={weak} label="Weak Signal (< −70 dBm)" tone={tone(weak, 1, 5)}
                   title="Clients whose last RSSI reading is below −70 dBm" />
            <Issue n={unreg} label="Unregistered in PF" tone={tone(unreg, 1, 5)}
                   title="Clients PacketFence knows but has not registered (RADIUS failure counts are not collected)" />
            <Issue n={flaps} label="Down Transitions (24h)" tone={tone(flaps, 1, 3)}
                   title="This AP's state transitions to critical in the last 24 hours" />
          </div>
        </div>

        <div className="card">
          <div className="card-h">
            <h3>Reachability</h3>
            <SourceBadge source="netmon" />
            <div className="h-spacer" />
            <span className="h-meta">XIQ × ping</span>
          </div>
          <div className="issues" style={{ gridTemplateColumns: "1fr" }}>
            <Issue n={reach[0]} label={reach[2]} tone={reach[1]} big />
          </div>
        </div>
      </div>

      <div className="row" style={{ gridTemplateColumns: "1fr", marginBottom: 14 }}>
        <div className="card">
          <div className="card-h">
            <h3>Live Telemetry</h3>
            <SourceBadge source="xiq" />
            <SourceBadge source="snmp" />
            <div className="h-spacer" />
            <span className="h-meta">current values · no per-AP history (the 24h ring is fleet-level)</span>
          </div>
          <div className="spark-strip">
            <SparkCell label="Clients 2.4 GHz" value={r24?.clients} />
            <SparkCell label="Clients 5 GHz" value={r5?.clients} />
            <SparkCell label="Uplink Link" value={up?.speed_mbps} unit="Mbps"
                       note={up ? (up.oper_state || "—") : "uplink not resolved"} />
            <SparkCell label="PoE Draw" value={up?.poe_watts} unit="W"
                       note={up ? (up.poe_delivering === 1 ? "delivering" : "not delivering") : "uplink not resolved"} />
          </div>
          <div className="spark-strip" style={{ borderTop: "1px solid var(--line)" }}>
            <SparkCell label="Channel 2.4" value={r24?.channel} note={r24?.width_mhz ? `${r24.width_mhz} MHz wide` : "—"} />
            <SparkCell label="Channel 5" value={r5?.channel} note={r5?.width_mhz ? `${r5.width_mhz} MHz wide` : "—"} />
            <SparkCell label="TX Power 2.4" value={r24?.tx_power_dbm} unit="dBm" />
            <SparkCell label="TX Power 5" value={r5?.tx_power_dbm} unit="dBm" />
          </div>
        </div>
      </div>

      <div className="row" style={{ gridTemplateColumns: "1fr 1fr", marginBottom: 14 }}>
        <KvCard title="System Information" meta="NetMon registry + ExtremeCloud IQ" rows={[
          ["Host Name", ap.name, "netmon"],
          ["Device Model", d.model, "xiq"],
          ["Serial Number", d.serial && <span className="mono">{d.serial}</span>, "xiq"],
          ["Firmware", d.fw_version && <span className="mono">{d.fw_version}</span>, "xiq"],
          ["Site", ap.site, "netmon"],
          ["Network Policy", d.network_policy, "xiq"],
          ["Uptime", fmtUptime(d.uptime_s), "xiq"],
          ["Cloud state", st.source_status?.value, "xiq"],
          ["XIQ Device ID", ap.xiq_device_id && <span className="mono">{ap.xiq_device_id}</span>, "xiq"],
        ]} />
        <KvCard title="Network Information" meta={ap.mgmt_ip ? `mgmt · ${ap.mgmt_ip}` : "no mgmt IP"} rows={[
          ["Mgmt IPv4", ap.mgmt_ip && <span className="mono">{ap.mgmt_ip}</span>, "netmon"],
          ["XIQ-reported IP", d.ip && <span className="mono">{d.ip}</span>, "xiq"],
          ["MAC Address", d.mgmt_mac && <span className="mono">{d.mgmt_mac}</span>, "xiq"],
          ["Uplink", up && <span className="mono">{up.switch_name} · {up.port || up.ifindex}</span>, "snmp"],
          ["PF Role", ap.pf?.role, "pf"],
          ["PF Registration", ap.pf?.reg_status, "pf"],
          ["VLAN", ap.pf?.vlan, "pf"],
        ]} />
      </div>

      <div className="card">
        <div className="card-h">
          <h3>Recent Events</h3>
          <div className="h-spacer" />
          <span className="h-meta">state transitions · ping / XIQ / reachability</span>
          <a className="h-link" href="#/events">Open events log <Glyph name="external" size={11} /></a>
        </div>
        <EventList events={ap.events} limit={6} />
      </div>
    </div>
  );
}

// ───────────────────────────── the other tabs ───────────────────────────────

function MiniMetric({ label, v, unit }) {
  const missing = v === null || v === undefined || v === "";
  return (
    <div style={{ background: "var(--bg-2)", borderRadius: 8, padding: 12, border: "1px solid var(--line)" }}>
      <div style={{ fontSize: 10, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>{label}</div>
      <div style={{ fontFamily: "var(--mono)", fontSize: 18, fontWeight: 600, color: missing ? "var(--muted)" : "var(--fg)" }}>
        {missing ? "—" : v}
        {!missing && unit && <span style={{ fontSize: 11, color: "var(--muted)", marginLeft: 3 }}>{unit}</span>}
      </div>
    </div>
  );
}

export function WirelessTab({ ap }) {
  const ssids = {};
  for (const c of ap.clients || []) {
    const k = c.ssid || "(unknown)";
    ssids[k] ||= { n: 0, bands: new Set() };
    ssids[k].n += 1;
    if (c.band) ssids[k].bands.add(`${c.band} GHz`);
  }
  const ssidRows = Object.entries(ssids).sort((a, b) => b[1].n - a[1].n);
  const radios = ap.radios || [];
  return (
    <div className="row" style={{ gridTemplateColumns: "1fr 1fr", gap: 14 }}>
      {radios.length === 0 && (
        <div className="card" style={{ gridColumn: "1 / -1", padding: 30, textAlign: "center", color: "var(--muted)" }}>
          No radio inventory for this AP yet (XIQ detail cycle).
        </div>
      )}
      {radios.map((r) => (
        <div className="card" key={r.radio}>
          <div className="card-h">
            <h3>Radio · {r.radio}{r.band ? ` · ${r.band} GHz` : ""}</h3>
            <SourceBadge source="xiq" />
            <div className="h-spacer" />
            <span className="h-meta">ch {r.channel ?? "—"} · {r.tx_power_dbm != null ? `${r.tx_power_dbm} dBm TX` : "TX —"}</span>
          </div>
          <div className="card-b" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <MiniMetric label="Channel" v={r.channel} />
            <MiniMetric label="Width" v={r.width_mhz} unit="MHz" />
            <MiniMetric label="TX Power" v={r.tx_power_dbm} unit="dBm" />
            <MiniMetric label="Clients" v={r.clients} />
            <MiniMetric label="Noise Floor" v={r.noise_dbm} unit="dBm" />
            <MiniMetric label="Utilisation" v={r.util_pct} unit="%" />
          </div>
        </div>
      ))}
      <div className="card" style={{ gridColumn: "1 / -1" }}>
        <div className="card-h">
          <h3>SSIDs in use</h3>
          <SourceBadge source="xiq" />
          <div className="h-spacer" />
          <span className="h-meta">from this AP's associated clients · the broadcast list is fleet-level on #/xiq</span>
        </div>
        {ssidRows.length ? (
          <table className="tbl">
            <thead><tr><th>SSID</th><th>Bands</th><th style={{ textAlign: "right" }}>Clients</th></tr></thead>
            <tbody>
              {ssidRows.map(([name, s]) => (
                <tr key={name}>
                  <td className="fg">{name}</td>
                  <td className="mono">{[...s.bands].join(", ") || "—"}</td>
                  <td className="mono" style={{ textAlign: "right" }}>{s.n}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div style={{ padding: 30, textAlign: "center", color: "var(--muted)", fontSize: 12 }}>
            No clients associated, so no SSIDs observed on this AP.
          </div>
        )}
      </div>
    </div>
  );
}

export function WiredTab({ ap }) {
  const up = ap.uplink;
  const pf = ap.pf;
  return (
    <div className="row" style={{ gridTemplateColumns: "1fr 1fr", gap: 14 }}>
      <KvCard title="Uplink — switch port"
              meta={up ? `${up.candidates} FDB candidate(s)` : "not resolved from the FDB"}
              rows={up ? [
                ["Switch", <a href={`#/switches/${up.switch_device_id}`}>{up.switch_name}</a>, "snmp"],
                ["Port", <span className="mono">{up.port || `ifIndex ${up.ifindex}`}</span>, "snmp"],
                ["Link", `${up.oper_state || "—"}${up.speed_mbps ? ` · ${up.speed_mbps} Mbps` : ""}${up.is_sfp === 1 ? " · SFP" : ""}`, "snmp"],
                ["PoE", up.poe_delivering === 1
                  ? <span style={{ color: sevColor("ok") }}>delivering{up.poe_watts ? ` · ${up.poe_watts} W` : ""}</span>
                  : "not delivering", "snmp"],
                ["MACs on port", up.macs_on_port, "snmp"],
                ["PacketFence", up.pf_agrees === true
                  ? <span style={{ color: sevColor("ok") }}>agrees ({up.pf_port})</span>
                  : up.pf_agrees === false
                  ? <span style={{ color: sevColor("warn") }}>disagrees — last saw it on {up.pf_port}</span>
                  : "no PF port recorded", "pf"],
                ["Cycle PoE", up.poe_cycle_safe
                  ? <span style={{ color: sevColor("ok") }}>available — {up.why}</span>
                  : <span style={{ color: sevColor("warn") }}>unavailable — {up.why}</span>, "netmon"],
              ] : [["Uplink", "No access port found for this AP's MAC in the FDB", "snmp"]]} />
      <KvCard title="PacketFence — this AP as an endpoint"
              meta={pf ? `node cache · ${fmtTime(pf.updated_at)}` : "not in PacketFence"}
              rows={pf ? [
                ["MAC", <span className="mono">{pf.mac}</span>, "pf"],
                ["Computer name", pf.computername, "pf"],
                ["Role", pf.role, "pf"],
                ["Registration", pf.reg_status &&
                  <span style={{ color: pf.reg_status === "reg" ? sevColor("ok") : sevColor("warn"), fontWeight: 600 }}>{pf.reg_status}</span>, "pf"],
                ["Online", pf.online === 1 ? "yes" : pf.online === 0 ? "no" : null, "pf"],
                ["VLAN", pf.vlan, "pf"],
                ["Last switch / port", pf.last_switch && `${pf.last_switch}${pf.last_port ? ` · ${pf.last_port}` : ""}`, "pf"],
                ["Connection", pf.conn_method, "pf"],
                ["Last seen", pf.last_seen, "pf"],
              ] : [["PacketFence", "PF has no node for this AP's base MAC", "pf"]]} />
      <div className="card" style={{ gridColumn: "1 / -1" }}>
        <div className="card-h"><h3>Operator actions</h3><div className="h-spacer" /><span className="h-meta">audit log · this AP</span></div>
        <div className="card-b"><ActionAudit deviceId={ap.id} /></div>
      </div>
    </div>
  );
}

export function ClientsTab({ ap }) {
  const [q, setQ] = React.useState("");
  const all = ap.clients || [];
  const needle = q.trim().toLowerCase();
  const rows = all.filter((c) => !needle ||
    `${c.mac} ${c.hostname || ""} ${c.username || ""} ${c.pf_owner || ""} ${c.ip || ""} ${c.ssid || ""}`
      .toLowerCase().includes(needle));
  return (
    <div className="card">
      <div className="card-h">
        <h3>Connected clients</h3>
        <SourceBadge source="xiq" />
        <SourceBadge source="pf" />
        <div className="h-spacer" />
        <input type="text" placeholder="filter…" value={q} onChange={(e) => setQ(e.target.value)}
               style={{ width: 180, marginRight: 10 }} />
        <span className="h-meta">{rows.length} of {all.length}</span>
      </div>
      {rows.length === 0 ? (
        <div style={{ padding: 30, textAlign: "center", color: "var(--muted)", fontSize: 12 }}>
          {all.length ? "No clients match." : "No clients associated."}
        </div>
      ) : (
        <table className="tbl">
          <thead><tr><th>MAC</th><th>Hostname</th><th>User</th><th>PF role</th><th>Reg</th><th>SSID</th><th>Band</th><th>RSSI</th><th>OS</th><th>IP</th></tr></thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.mac}>
                <td className="mono">{c.mac}</td>
                <td className="fg">{c.hostname || "—"}</td>
                <td>{c.username || c.pf_owner || "—"}</td>
                <td>{c.pf_role || "—"}</td>
                <td>{c.pf_status
                  ? <span style={{ color: c.pf_status === "reg" ? sevColor("ok") : sevColor("warn"), fontWeight: 600 }}>{c.pf_status}</span>
                  : "—"}</td>
                <td>{c.ssid || "—"}</td>
                <td className="mono">{c.band ? `${c.band} GHz` : "—"}</td>
                <td className="mono" style={c.rssi_dbm != null && c.rssi_dbm < -70 ? { color: "var(--warn)" } : undefined}>
                  {c.rssi_dbm != null ? `${c.rssi_dbm} dBm` : "—"}</td>
                <td>{c.os || "—"}</td>
                <td className="mono">{c.ip || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function EventsTab({ ap }) {
  return (
    <div className="card">
      <div className="card-h">
        <h3>Events</h3>
        <div className="h-spacer" />
        <span className="h-meta">last {(ap.events || []).length} state transitions</span>
        <a className="h-link" href="#/events">Open events log <Glyph name="external" size={11} /></a>
      </div>
      <EventList events={ap.events} />
    </div>
  );
}

// ZCD's "Debug · Data Bridge" panel, re-aimed at what NetMon can say honestly:
// how old each row behind this page is. A source that stopped writing shows
// here as stale before anyone mistakes old numbers for current ones (§4.5).
export function DataPanel({ ap, loadedAt, onRefresh }) {
  const [open, setOpen] = React.useState(false);
  const rows = [
    ["ap_details (XIQ detail cycle)", ap.detail?.updated_at, 3600],
    ["ap_radios", (ap.radios || [])[0]?.updated_at, 3600],
    ["wireless_clients", (ap.clients || [])[0]?.updated_at, 1800],
    ["pf_nodes (this AP)", ap.pf?.updated_at, 3600],
    ...Object.entries(ap.state || {}).map(([dim, s]) => [`device_state · ${dim} (${s.source})`, s.updated_at, 900]),
  ];
  return (
    <div className="card debug-panel" style={{ marginTop: 14, border: "1px dashed var(--line-2)" }}>
      <div className="card-h" style={{ cursor: "pointer" }} onClick={() => setOpen((o) => !o)}>
        <h3>Data freshness</h3>
        <span style={{
          marginLeft: 8, fontSize: 10, padding: "2px 8px", borderRadius: 999,
          background: "rgba(52, 211, 153, 0.15)", color: "var(--ok)", border: "1px solid rgba(52, 211, 153, 0.4)",
        }}>loaded {fmtTime(loadedAt)}</span>
        <div className="h-spacer" />
        <button type="button" className="btn sm" onClick={(e) => { e.stopPropagation(); onRefresh(); }}>Refresh now</button>
        <span className="h-meta" style={{ marginLeft: 10 }}>{open ? "▼" : "▶"}</span>
      </div>
      {open && (
        <div className="card-b">
          <table className="tbl" style={{ width: "100%", fontSize: 11 }}>
            <thead><tr><th>Row</th><th>Updated</th><th>Age</th></tr></thead>
            <tbody>
              {rows.map(([k, at, stale]) => (
                <tr key={k}>
                  <td className="fg mono">{k}</td>
                  <td className="mono">{at || "—"}</td>
                  <td><Freshness at={at} staleAfter={stale} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ──────────────────────────────────── page ──────────────────────────────────

const TAB_IDS = ["overview", "wireless", "wired", "clients", "events", "issues"];

export function WirelessPage({ id }) {
  const [fleet, setFleet] = React.useState(null);
  const [fleetError, setFleetError] = React.useState(null);
  const [ap, setAp] = React.useState(null);
  const [apError, setApError] = React.useState(null);
  const [loadedAt, setLoadedAt] = React.useState(null);
  const [meta, setMeta] = React.useState(null);
  const [tab, setTab] = React.useState("overview");
  const [tick, setTick] = React.useState(0);

  const activeId = id ? Number(id) : null;

  React.useEffect(() => {
    let live = true;
    getJSON("/api/meta").then((m) => live && setMeta(m)).catch(() => { /* PF link stays disabled */ });
    return () => { live = false; };
  }, []);

  React.useEffect(() => {
    let live = true;
    const load = () => getJSON("/api/wireless/aps")
      .then((rows) => { if (live) { setFleet(rows); setFleetError(null); } })
      .catch((e) => { if (live) setFleetError(e); });
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => { live = false; clearInterval(t); };
  }, []);

  // No AP in the URL: land on the first down AP, else the first problem, else
  // the first AP — ZCD always opened on a device, never on an empty pane.
  React.useEffect(() => {
    if (activeId || !fleet || !fleet.length) return;
    const pick = fleet.find((a) => apState(a) === "down") || fleet.find(hasProblem) || fleet[0];
    location.replace(`#/wireless/${pick.id}`);
  }, [activeId, fleet]);

  React.useEffect(() => {
    if (!activeId) return undefined;
    let live = true;
    // Drop the previous AP's data so a slow load never shows AP A's numbers
    // under AP B's name. The tab is kept on purpose — comparing two APs'
    // clients should not mean clicking "Clients" every time.
    setAp((cur) => (cur && cur.id === activeId ? cur : null));
    const load = () => getJSON(`/api/wireless/aps/${activeId}`)
      .then((w) => {
        if (!live) return;
        if (w.device_type && w.device_type !== "ap") {
          location.replace(w.device_type === "switch" ? `#/switches/${activeId}` : `#/ap/${activeId}`);
          return;
        }
        setAp(w); setApError(null); setLoadedAt(new Date().toISOString());
      })
      .catch((e) => { if (live) setApError(e); });
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => { live = false; clearInterval(t); };
  }, [activeId, tick]);

  if (fleetError) return <ErrorMsg error={fleetError} />;
  if (!fleet) return <Loading what="AP fleet" />;
  if (!fleet.length) return <div className="msg">No APs in the registry.</div>;

  const navRow = fleet.find((a) => a.id === activeId);
  const st = ap?.state || {};
  const state = ap
    ? composeState([srcVal(st.source_status?.value), srcVal(st.snmp?.value), srcVal(st.ping?.value)])
    : navRow ? apState(navRow) : "idle";
  const d = ap?.detail || {};
  const clientsN = ap ? (ap.clients || []).length : navRow?.clients_total;
  const evCrit = (ap?.events || []).some((e) => e.severity === "crit");
  const activeTab = TAB_IDS.includes(tab) ? tab : "overview";

  const tabs = [
    { id: "overview", label: "Overview" },
    { id: "wireless", label: "Wireless", badge: ap?.radios?.length || null },
    { id: "wired", label: "Wired" },
    { id: "clients", label: "Clients", badge: clientsN || null },
    { id: "events", label: "Events", badge: ap?.events?.length || null, kind: evCrit ? "warn" : undefined },
    { id: "issues", label: "Issues" },
  ];

  let body;
  if (apError) body = <ErrorMsg error={apError} />;
  else if (!ap) body = <Loading what={navRow ? navRow.name : `AP ${activeId}`} />;
  else if (activeTab === "wireless") body = <WirelessTab ap={ap} />;
  else if (activeTab === "wired") body = <WiredTab ap={ap} />;
  else if (activeTab === "clients") body = <ClientsTab ap={ap} />;
  else if (activeTab === "events") body = <EventsTab ap={ap} />;
  else if (activeTab === "issues") body = <IssuesForDevice deviceId={ap.id} deviceName={ap.name} />;
  else body = <OverviewTab ap={ap} />;

  return (
    <div>
      <PageHeader
        title={ap?.name || navRow?.name || "Wireless APs"}
        ip={ap?.mgmt_ip || navRow?.mgmt_ip}
        tag={d.model || navRow?.model}
        range="live · refreshes every 30s"
        pills={[
          { severity: STATE_SEV[state], value: STATE_LABEL[state] },
          { label: "Active since", value: fmtUptime(d.uptime_s ?? navRow?.uptime_s) },
          { label: "Site", value: ap?.site || navRow?.site || "—" },
          { label: "Clients", value: Number(clientsN ?? 0).toLocaleString() },
          { label: "XIQ Device ID", value: ap?.xiq_device_id || "—" },
        ]}>
        <a className="pill" href="#/xiq" style={LINK} title="Fleet dashboard (KPIs, per-site health, SSIDs, firmware)">
          <span className="lbl">Fleet</span><span className="v">XIQ dashboard →</span>
        </a>
      </PageHeader>
      <Tabs tabs={tabs} active={activeTab} onChange={setTab} />

      <div className="body" data-screen-label={`AP Detail · ${activeTab}`}>
        <div className="zbx-layout">
          <ApNavigator fleet={fleet} activeId={activeId} />
          <div style={{ minWidth: 0 }}>
            {ap && activeTab === "overview" && <DeviceCard ap={ap} state={state} meta={meta} />}
            <div style={{ marginTop: ap && activeTab === "overview" ? 14 : 0 }}>{body}</div>
            {ap && <DataPanel ap={ap} loadedAt={loadedAt} onRefresh={() => setTick((n) => n + 1)} />}
          </div>
        </div>
      </div>
    </div>
  );
}
