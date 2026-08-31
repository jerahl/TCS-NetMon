import React from "react";
import { getJSON, qs } from "../api.js";
import { Card, Loading, ErrorMsg, Dot, SourceBadge, sevColor } from "../primitives.jsx";
import { ageOf } from "../format.js";

// XIQ Wireless fleet page (spec 10 §7, Phase 10.2). All data from NetMon's
// wireless tables (XIQ collector cycles) — zero XIQ calls at render.

const REFRESH_MS = 30000;

function fmtUptime(s) {
  if (s === null || s === undefined) return "—";
  if (s < 7200) return `${Math.round(s / 60)}m`;
  if (s < 172800) return `${(s / 3600).toFixed(1)}h`;
  return `${Math.floor(s / 86400)}d`;
}

const STATUS_COLOR = { up: "ok", down: "crit", blind: "warn" };

// ───────── APs by site ─────────
//
// ZCD's APs-by-site grid, which spec 15 §2 listed as missing. It was not
// buildable until 2026-08-31: 782 of 783 APs read site "Unassigned" because
// the seed let Zabbix's "Site/Wireless APs" catch-all outrank the real
// Site/Wireless/<school>/<floor> group (spec 17). With attribution fixed the
// grid is a pure client-side roll-up of /api/wireless/aps — no new endpoint.
//
// Tiles are tinted by worst status and are click-to-filter, so "which school
// is unhappy" and "show me its APs" are one gesture rather than two.
function SiteGrid({ aps, filter, onFilter, onPick, picked }) {
  const sites = {};
  for (const a of aps) (sites[a.site || "Unassigned"] ||= []).push(a);

  const rows = Object.entries(sites).map(([name, list]) => {
    const down = list.filter((a) => a.status === "down").length;
    const blind = list.filter((a) => a.status === "blind").length;
    const unknown = list.filter((a) => !a.status).length;
    // "unknown" is never folded into "ok" — no reading is not a good reading.
    const worst = down ? "crit" : (blind || unknown) ? "warn" : "ok";
    const clients = list.reduce((n, a) => n + (a.clients_total || 0), 0);
    return { name, total: list.length, down, blind, unknown, worst, clients };
  });
  rows.sort((a, b) => b.down - a.down || a.name.localeCompare(b.name));

  const issues = rows.filter((r) => r.worst !== "ok");
  const shown = filter === "issues" ? issues
    : filter === "ok" ? rows.filter((r) => r.worst === "ok") : rows;

  return (
    <Card kicker={`${rows.length} site(s) · ${issues.length} needing attention`}>
      <div className="evt-filters" style={{ marginTop: 0 }}>
        {[["all", `All ${rows.length}`], ["issues", `Issues ${issues.length}`],
          ["ok", `Healthy ${rows.length - issues.length}`]].map(([k, label]) => (
          <button key={k} type="button"
                  className={"linkish" + (filter === k ? " active" : "")}
                  onClick={() => onFilter(k)}>{label}</button>
        ))}
        {picked && (
          <button type="button" className="linkish" onClick={() => onPick(picked)}>
            clear “{picked}” filter
          </button>
        )}
      </div>
      <div className="site-grid">
        {shown.map((r) => (
          <button key={r.name} type="button"
                  className={"site-tile" + (picked === r.name ? " active" : "")}
                  style={{ borderLeftColor: sevColor(r.worst) }}
                  onClick={() => onPick(r.name)}
                  title={`${r.total} AP(s)${r.down ? ` · ${r.down} down` : ""}` +
                         `${r.blind ? ` · ${r.blind} blind` : ""}` +
                         `${r.unknown ? ` · ${r.unknown} unknown` : ""}`}>
            <div className="site-tile-name">{r.name}</div>
            <div className="site-tile-sub mono">{r.total} AP · {r.clients} cl</div>
            {r.down > 0 && (
              <div className="site-tile-prob" style={{ color: sevColor("crit") }}>
                {r.down} down
              </div>
            )}
            {r.down === 0 && (r.blind || r.unknown) > 0 && (
              <div className="site-tile-prob" style={{ color: sevColor("warn") }}>
                {r.blind ? `${r.blind} blind` : `${r.unknown} unknown`}
              </div>
            )}
          </button>
        ))}
        {shown.length === 0 && <div className="msg">No sites in this filter.</div>}
      </div>
    </Card>
  );
}

export function XiqPage() {
  const [summary, setSummary] = React.useState(null);
  const [aps, setAps] = React.useState(null);
  const [ssids, setSsids] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [site, setSite] = React.useState("");
  const [siteFilter, setSiteFilter] = React.useState("all");
  const [q, setQ] = React.useState("");

  React.useEffect(() => {
    let live = true;
    const load = () =>
      Promise.all([
        getJSON("/api/wireless/summary"),
        getJSON("/api/wireless/aps"),
        getJSON("/api/wireless/ssids"),
      ]).then(([s, a, ss]) => {
        if (!live) return;
        setSummary(s); setAps(a); setSsids(ss); setError(null);
      }).catch((e) => { if (live) setError(e); });
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => { live = false; clearInterval(id); };
  }, []);

  if (error) return <ErrorMsg error={error} />;
  if (!summary || !aps) return <Loading what="wireless fleet" />;

  const sites = [...new Set(aps.map((a) => a.site).filter(Boolean))].sort();
  const shown = aps.filter((a) =>
    (!site || a.site === site) &&
    (!q || `${a.name} ${a.model || ""} ${a.ip || ""} ${a.fw_version || ""}`.toLowerCase().includes(q.toLowerCase())));
  const bands = summary.clients_by_band || {};
  const detailAge = ageOf(summary.details_updated_at);
  const fwTop = (summary.firmware || [])[0];
  const fwCompliant = fwTop && summary.aps_total
    ? Math.round((fwTop.n / summary.aps_total) * 100) : null;

  return (
    <div className="page">
      <h1>XIQ · Wireless</h1>
      <div className="subtitle">
        ExtremeCloud IQ cycles · <SourceBadge source="xiq" /> · refreshes every {REFRESH_MS / 1000}s
        {" · "}<a href="#/wireless">AP navigator →</a>
        {detailAge && <span> · detail cache {detailAge} old</span>}
        {!summary.details_updated_at && <span style={{ color: sevColor("warn") }}> · no detail sweep yet</span>}
      </div>

      <div className="stat-row">
        <div className="stat"><div className="stat-value">{summary.aps_up}/{summary.aps_total}</div>
          <div className="stat-label">APs connected</div></div>
        <div className="stat"><div className="stat-value" style={summary.aps_down ? { color: sevColor("crit") } : undefined}>
          {summary.aps_down}</div><div className="stat-label">APs down</div></div>
        {summary.aps_blind > 0 && (
          <div className="stat"><div className="stat-value" style={{ color: sevColor("warn") }}>{summary.aps_blind}</div>
            <div className="stat-label">Blind (XIQ unreachable)</div></div>)}
        <div className="stat"><div className="stat-value">{summary.clients_total}</div>
          <div className="stat-label">Clients</div></div>
        {/* `wired` is included on purpose. XIQ reports radio_type = 3 (WIRED)
            for switch-attached clients, and they are ~85% of the rows — listing
            only the Wi-Fi bands would show a number 6× smaller than the client
            count directly beside it. Whether wired clients belong in
            wireless_clients at all is an owner question; until it is answered
            the tile must at least agree with the table. */}
        <div className="stat"><div className="stat-value">
          {["2.4", "5", "6", "wired"].filter((b) => bands[b])
            .map((b) => `${b}: ${bands[b]}`).join(" · ") || "—"}</div>
          <div className="stat-label">Clients by band</div></div>
        <div className="stat"><div className="stat-value">{fwCompliant !== null ? `${fwCompliant}%` : "—"}</div>
          <div className="stat-label">On {fwTop ? fwTop.fw_version : "top firmware"}</div></div>
      </div>

      <SiteGrid aps={aps} filter={siteFilter} onFilter={setSiteFilter}
                onPick={(s) => setSite(s === site ? "" : s)} picked={site} />

      <div className="evt-filters">
        <label className="evt-filter">
          <span>Site</span>
          <select value={site} onChange={(e) => setSite(e.target.value)}>
            <option value="">All</option>
            {sites.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <label className="evt-filter evt-filter-grow">
          <span>Search</span>
          <input type="text" placeholder="name, model, IP, firmware…" value={q}
                 onChange={(e) => setQ(e.target.value)} />
        </label>
      </div>

      <Card kicker={`${shown.length} AP(s)`}>
        {shown.length === 0 ? (
          <div className="msg">No APs match. If the whole table is empty, the XIQ detail cycle hasn't run yet.</div>
        ) : (
          <table className="grid">
            <thead>
              <tr><th></th><th>AP</th><th>Site</th><th>Model</th><th>IP</th>
                  <th>Firmware</th><th>Clients</th><th>Uptime</th><th>Policy</th></tr>
            </thead>
            <tbody>
              {shown.map((a) => (
                <tr key={a.id}>
                  <td><Dot severity={STATUS_COLOR[a.status] || "unknown"} /></td>
                  <td><a href={`#/wireless/${a.id}`}>{a.name}</a></td>
                  <td>{a.site || "—"}</td>
                  <td className="dim">{a.model || "—"}</td>
                  <td className="mono dim">{a.ip || a.mgmt_ip || "—"}</td>
                  <td className="mono dim">{a.fw_version || "—"}</td>
                  <td className="mono">{a.clients_total ?? "—"}</td>
                  <td className="mono dim">{fmtUptime(a.uptime_s)}</td>
                  <td className="dim">{a.network_policy || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card kicker="SSIDs (client counts rolled up live)">
        {!ssids || ssids.length === 0 ? (
          <div className="msg">No SSIDs cached yet — the SSID cycle runs every 30 minutes.</div>
        ) : (
          <table className="grid">
            <thead><tr><th>SSID</th><th>Auth</th><th>Enabled</th><th>Policy</th><th>Clients</th></tr></thead>
            <tbody>
              {ssids.map((s) => (
                <tr key={s.name}>
                  <td>{s.name}</td>
                  <td className="mono dim">{s.auth || "—"}</td>
                  <td>{s.enabled === null ? "—" : s.enabled ? "yes" : "no"}</td>
                  <td className="dim">{s.network_policy || "—"}</td>
                  <td className="mono">{s.clients}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
