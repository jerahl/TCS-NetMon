import React from "react";
import { getJSON, qs } from "../api.js";
import { Card, Loading, ErrorMsg, SourceBadge, sevColor } from "../primitives.jsx";
import { ageOf } from "../format.js";
import { HistoryChart } from "../history.jsx";

// VoIP (3CX) — Phase 10.4. Trunks + extensions + SystemStatus, all from
// NetMon's DB. Active calls / MOS / queues depend on the Phase 0 ODBC
// decision and aren't persisted (spec §7).

const REFRESH_MS = 30000;

function ChannelBar({ used, total }) {
  if (!total) return <span className="dim">—</span>;
  const pct = Math.min(100, (used / total) * 100);
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <span className="pd-bar" style={{ width: 100 }}>
        <i style={{ width: `${pct}%`, background: pct >= 90 ? sevColor("crit") : pct >= 70 ? sevColor("warn") : sevColor("ok") }} />
      </span>
      <span className="mono dim">{used ?? 0}/{total}</span>
    </span>
  );
}

export function VoipPage() {
  const [summary, setSummary] = React.useState(null);
  const [trunks, setTrunks] = React.useState(null);
  const [exts, setExts] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [q, setQ] = React.useState("");

  React.useEffect(() => {
    let live = true;
    const load = () => Promise.all([
      getJSON("/api/voip/summary"),
      getJSON("/api/voip/trunks"),
    ]).then(([s, t]) => { if (live) { setSummary(s); setTrunks(t); setError(null); } })
      .catch((e) => { if (live) setError(e); });
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => { live = false; clearInterval(id); };
  }, []);

  React.useEffect(() => {
    const id = setTimeout(() =>
      getJSON("/api/voip/extensions" + qs({ q })).then(setExts).catch(() => setExts([])), 250);
    return () => clearTimeout(id);
  }, [q]);

  if (error) return <ErrorMsg error={error} />;
  if (!summary || !trunks) return <Loading what="VoIP" />;

  const age = ageOf(summary.updated_at);
  const sys = summary.system?.payload;

  return (
    <div className="page">
      <h1>VoIP · 3CX</h1>
      <div className="subtitle">
        <SourceBadge source="threecx" /> · refreshes every {REFRESH_MS / 1000}s
        {age && <span> · cache {age} old</span>}
        {!summary.updated_at && <span style={{ color: sevColor("warn") }}> · no trunk data yet</span>}
      </div>

      <div className="stat-row">
        <div className="stat"><div className="stat-value" style={summary.trunks_registered < summary.trunks_total ? { color: sevColor("warn") } : { color: sevColor("ok") }}>
          {summary.trunks_registered}/{summary.trunks_total}</div><div className="stat-label">Trunks registered</div></div>
        <div className="stat"><div className="stat-value">{summary.channels_in_use}/{summary.channels_total}</div>
          <div className="stat-label">Channels in use</div></div>
        <div className="stat"><div className="stat-value">{summary.extensions_registered}/{summary.extensions_total}</div>
          <div className="stat-label">Extensions registered</div></div>
        {sys && sys.CallsActive !== undefined && (
          <div className="stat"><div className="stat-value">{sys.CallsActive}</div><div className="stat-label">Active calls</div></div>)}
        {sys && sys.Version && (
          <div className="stat"><div className="stat-value" style={{ fontSize: 16 }}>{sys.Version}</div><div className="stat-label">3CX version</div></div>)}
      </div>

      <Card title="24-hour trends" kicker="history ring buffer">
        <div className="hchart-row">
          <HistoryChart series="voip.channels_in_use" label="Channels in use" color={sevColor("ok")} />
          <HistoryChart series="voip.trunks_registered" label="Trunks registered" color={sevColor("unknown")} />
        </div>
      </Card>

      <Card kicker={`${trunks.length} trunk(s)`}>
        {trunks.length === 0 ? <div className="msg">No trunks cached — the 3CX collector hasn't populated the trunk table.</div> : (
          <table className="grid">
            <thead><tr><th>Trunk</th><th>Provider</th><th>DID</th><th>Registration</th><th>Channels</th></tr></thead>
            <tbody>
              {trunks.map((t) => (
                <tr key={t.device_id}>
                  <td>{t.name || t.device_name}</td>
                  <td className="dim">{t.provider_host || "—"}</td>
                  <td className="mono dim">{t.did || "—"}</td>
                  <td style={{ color: t.reg_status === "registered" ? sevColor("ok") : sevColor("crit"), fontWeight: 600 }}>
                    {t.reg_status || t.trunk_state || "unknown"}</td>
                  <td><ChannelBar used={t.ch_in_use} total={t.ch_total} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {sys && (
        <Card kicker={`System status · ${summary.system.ok ? "ok" : "STALE"} · ${ageOf(summary.system.updated_at) || "?"} old`}>
          <table className="grid kv">
            <tbody>
              {Object.entries(sys).slice(0, 12).map(([k, v]) => (
                <tr key={k}><td>{k}</td><td className="mono">{typeof v === "object" ? JSON.stringify(v) : String(v)}</td></tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <Card kicker={exts ? `${exts.length} extension(s)` : "Extensions"}>
        <label className="evt-filter evt-filter-grow" style={{ marginBottom: 8 }}>
          <span>Search</span>
          <input type="text" placeholder="ext, name, site…" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        {!exts ? <Loading what="extensions" /> : exts.length === 0 ? (
          <div className="msg">No extensions cached (the 3CX Users endpoint may be absent on this v20 build — spec Q4).</div>
        ) : (
          <table className="grid">
            <thead><tr><th>Ext</th><th>Name</th><th>Site</th><th>Registered</th><th>DND</th></tr></thead>
            <tbody>
              {exts.map((e) => (
                <tr key={e.ext}>
                  <td className="mono">{e.ext}</td>
                  <td>{e.name || "—"}</td>
                  <td className="dim">{e.site || "—"}</td>
                  <td>{e.registered === null ? "—" : e.registered
                    ? <span style={{ color: sevColor("ok"), fontWeight: 600 }}>yes</span>
                    : <span className="dim">no</span>}</td>
                  <td>{e.dnd ? <span style={{ color: sevColor("warn") }}>DND</span> : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
