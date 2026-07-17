import React from "react";
import { getJSON, qs } from "../api.js";
import { Card, Loading, ErrorMsg, SourceBadge, sevColor } from "../primitives.jsx";
import { ageOf } from "../format.js";

// NAC (PacketFence) — Phase 10.3: five ZCD PF views as tabs over pf_nodes +
// snapshot_cache. All reads from NetMon's DB (5-minute collector cadence,
// honestly labeled — the design's "LIVE·5s" is renegotiated to cache cadence).
// Write actions (release, reevaluate) are D4-gated: none rendered.

const REFRESH_MS = 30000;

const TABS = [
  { id: "devices", label: "Connected Devices" },
  { id: "sessions", label: "User Sessions" },
  { id: "quarantine", label: "Quarantine" },
  { id: "policies", label: "NAC Policies" },
  { id: "cluster", label: "Cluster Status" },
];

function RegBadge({ status }) {
  if (!status) return <span className="dim">—</span>;
  const ok = status === "reg";
  return <span style={{ color: ok ? sevColor("ok") : sevColor("warn"), fontWeight: 600 }}>{status}</span>;
}

function NodeTable({ rows, showLocation = true }) {
  if (!rows || rows.length === 0) return <div className="msg">No nodes.</div>;
  return (
    <table className="grid">
      <thead>
        <tr>
          <th>MAC</th><th>Hostname</th><th>Owner</th><th>Role</th><th>Reg</th>
          <th>IP</th><th>OS</th>{showLocation && <th>Location</th>}
          <th>Auth</th><th>Last seen</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((n) => (
          <tr key={n.mac}>
            <td className="mono">{n.mac}</td>
            <td>{n.computername || "—"}</td>
            <td className="dim">{n.owner || n.dot1x_user || "—"}</td>
            <td>{n.role ? <span className="pill">{n.role}</span> : "—"}</td>
            <td><RegBadge status={n.reg_status} /></td>
            <td className="mono dim">{n.ip || "—"}</td>
            <td className="dim">{n.os || "—"}</td>
            {showLocation && (
              <td className="dim">
                {n.last_ssid ? `📶 ${n.last_ssid}`
                  : n.last_switch ? `${n.last_switch}${n.last_port ? ` · ${n.last_port}` : ""}` : "—"}
              </td>
            )}
            <td className="mono dim">{n.conn_sub || n.conn_method || "—"}</td>
            <td className="mono dim">{n.last_seen || "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SnapshotCard({ title, snap, render }) {
  return (
    <Card title={title} kicker={snap
      ? `${snap.ok ? "ok" : "STALE — last refresh failed"} · ${ageOf(snap.updated_at) || "?"} old`
      : "never fetched"}>
      {!snap ? (
        <div className="msg">This PF endpoint hasn't been captured yet (collector disabled, or the endpoint 404s on this PF version — check collector logs).</div>
      ) : !snap.payload ? (
        <div className="msg">No payload retained.</div>
      ) : render(snap.payload)}
    </Card>
  );
}

// Generic renderer for PF config/list snapshots whose exact shape varies by
// PF version: renders {items:[...]} as a key table, else pretty JSON.
function GenericSnapshot({ payload }) {
  const items = Array.isArray(payload) ? payload : payload?.items;
  if (Array.isArray(items) && items.length > 0 && typeof items[0] === "object") {
    const cols = Object.keys(items[0]).slice(0, 6);
    return (
      <table className="grid">
        <thead><tr>{cols.map((c) => <th key={c}>{c}</th>)}</tr></thead>
        <tbody>
          {items.slice(0, 100).map((it, i) => (
            <tr key={i}>{cols.map((c) => (
              <td key={c} className="dim">{typeof it[c] === "object" && it[c] !== null ? JSON.stringify(it[c]).slice(0, 40) : String(it[c] ?? "—")}</td>
            ))}</tr>
          ))}
        </tbody>
      </table>
    );
  }
  return <pre className="mono dim" style={{ fontSize: 11, overflowX: "auto" }}>{JSON.stringify(payload, null, 2).slice(0, 4000)}</pre>;
}

export function NacPage() {
  const [tab, setTab] = React.useState("devices");
  const [summary, setSummary] = React.useState(null);
  const [error, setError] = React.useState(null);

  React.useEffect(() => {
    let live = true;
    const load = () => getJSON("/api/nac")
      .then((s) => { if (live) { setSummary(s); setError(null); } })
      .catch((e) => { if (live) setError(e); });
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => { live = false; clearInterval(id); };
  }, []);

  if (error) return <ErrorMsg error={error} />;
  if (!summary) return <Loading what="NAC" />;
  if (summary.enabled === false) {
    return (
      <div className="page"><h1>NAC · PacketFence</h1>
        <Card><div className="msg">The PacketFence collector is not enabled ([packetfence] in netmon.conf).</div></Card>
      </div>
    );
  }

  const age = ageOf(summary.updated_at);
  return (
    <div className="page">
      <h1>NAC · PacketFence</h1>
      <div className="subtitle">
        <SourceBadge source="packetfence" /> · cache cadence 5 min · refreshes every {REFRESH_MS / 1000}s
        {age && <span> · node cache {age} old</span>}
      </div>

      <div className="stat-row">
        <div className="stat"><div className="stat-value">{summary.total}</div><div className="stat-label">Nodes</div></div>
        <div className="stat"><div className="stat-value" style={{ color: sevColor("ok") }}>{summary.registered}</div>
          <div className="stat-label">Registered</div></div>
        <div className="stat"><div className="stat-value" style={summary.unregistered ? { color: sevColor("warn") } : undefined}>
          {summary.unregistered}</div><div className="stat-label">Unregistered</div></div>
        <div className="stat"><div className="stat-value" style={summary.pending ? { color: sevColor("warn") } : undefined}>
          {summary.pending}</div><div className="stat-label">Pending</div></div>
        <div className="stat"><div className="stat-value">{summary.online}</div><div className="stat-label">Online now</div></div>
        <div className="stat"><div className="stat-value">
          {(summary.auth_split || []).slice(0, 2).map((a) => `${(a.conn_method || "?").replace("Wireless-802.11-", "")}: ${a.n}`).join(" · ") || "—"}</div>
          <div className="stat-label">Auth methods (online)</div></div>
      </div>

      <div className="tabs">
        {TABS.map((t) => (
          <button key={t.id} type="button" className={"tab" + (tab === t.id ? " active" : "")}
                  onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </div>

      {tab === "devices" && <DevicesTab />}
      {tab === "sessions" && <SessionsTab />}
      {tab === "quarantine" && <QuarantineTab />}
      {tab === "policies" && <PoliciesTab />}
      {tab === "cluster" && <ClusterTab />}
    </div>
  );
}

function DevicesTab() {
  const [rows, setRows] = React.useState(null);
  const [q, setQ] = React.useState("");
  const [status, setStatus] = React.useState("");
  React.useEffect(() => {
    const id = setTimeout(() =>
      getJSON("/api/nac/nodes" + qs({ q, status, limit: 500 })).then(setRows).catch(() => setRows([])),
      250);
    return () => clearTimeout(id);
  }, [q, status]);
  return (
    <Card kicker={rows ? `${rows.length} node(s)` : "Connected devices"}>
      <div className="evt-filters">
        <label className="evt-filter">
          <span>Status</span>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option>
            <option value="reg">reg</option>
            <option value="unreg">unreg</option>
            <option value="pending">pending</option>
          </select>
        </label>
        <label className="evt-filter evt-filter-grow">
          <span>Search</span>
          <input type="text" placeholder="MAC, hostname, owner, IP…" value={q}
                 onChange={(e) => setQ(e.target.value)} />
        </label>
      </div>
      {!rows ? <Loading what="nodes" /> : <NodeTable rows={rows} />}
    </Card>
  );
}

function SessionsTab() {
  const [data, setData] = React.useState(null);
  React.useEffect(() => { getJSON("/api/nac/sessions").then(setData).catch(() => setData({})); }, []);
  if (!data) return <Loading what="sessions" />;
  const rejects = data.rejects?.payload || [];
  return (
    <React.Fragment>
      <Card kicker={`${(data.sessions || []).length} active session(s) · cache cadence, not live`}>
        <NodeTable rows={data.sessions} />
      </Card>
      <Card title="RADIUS reject tail"
            kicker={data.rejects ? `${data.rejects.ok ? "ok" : "STALE"} · ${ageOf(data.rejects.updated_at) || "?"} old` : "never fetched"}>
        {rejects.length === 0 ? <div className="msg">No recent rejects captured.</div> : (
          <table className="grid">
            <thead><tr><th>MAC</th><th>User</th><th>NAS</th><th>Port</th><th>Reason</th><th>At</th></tr></thead>
            <tbody>
              {rejects.map((r, i) => (
                <tr key={i}>
                  <td className="mono">{r.mac || "—"}</td>
                  <td>{r.user_name || "—"}</td>
                  <td className="mono dim">{r.nas_ip_address || "—"}</td>
                  <td className="mono dim">{r.nas_port_id || "—"}</td>
                  <td style={{ color: sevColor("warn") }}>{r.reason || "—"}</td>
                  <td className="mono dim">{r.created_at || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </React.Fragment>
  );
}

function QuarantineTab() {
  const [data, setData] = React.useState(null);
  React.useEffect(() => { getJSON("/api/nac/quarantine").then(setData).catch(() => setData({})); }, []);
  if (!data) return <Loading what="quarantine" />;
  return (
    <React.Fragment>
      <Card kicker={`${(data.nodes || []).length} non-registered node(s)`}>
        <NodeTable rows={data.nodes} />
        <div className="dim pd-note">Release / re-evaluate actions are managed in PacketFence (write actions are D4-gated).</div>
      </Card>
      <SnapshotCard title="Violation catalog (security events)" snap={data.violations}
                    render={(p) => <GenericSnapshot payload={p} />} />
    </React.Fragment>
  );
}

function PoliciesTab() {
  const [data, setData] = React.useState(null);
  React.useEffect(() => { getJSON("/api/nac/policies").then(setData).catch(() => setData({})); }, []);
  if (!data) return <Loading what="policies" />;
  return (
    <React.Fragment>
      <SnapshotCard title="Authentication sources" snap={data.sources}
                    render={(p) => <GenericSnapshot payload={p} />} />
      <SnapshotCard title="Connection profiles" snap={data.profiles}
                    render={(p) => <GenericSnapshot payload={p} />} />
      <SnapshotCard title="Security events" snap={data.violations}
                    render={(p) => <GenericSnapshot payload={p} />} />
    </React.Fragment>
  );
}

function ClusterTab() {
  const [data, setData] = React.useState(null);
  React.useEffect(() => { getJSON("/api/nac/cluster").then(setData).catch(() => setData({})); }, []);
  if (!data) return <Loading what="cluster" />;
  return (
    <React.Fragment>
      <SnapshotCard title="Cluster servers" snap={data.cluster}
                    render={(p) => <GenericSnapshot payload={p} />} />
      <SnapshotCard title="Services" snap={data.services}
                    render={(p) => <GenericSnapshot payload={p} />} />
      <SnapshotCard title="Queues" snap={data.queues}
                    render={(p) => <GenericSnapshot payload={p} />} />
    </React.Fragment>
  );
}
