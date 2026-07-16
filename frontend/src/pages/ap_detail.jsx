import React from "react";
import { getJSON } from "../api.js";
import { Card, Badge, Loading, ErrorMsg, sevColor } from "../primitives.jsx";
import { SshButton } from "../ssh.jsx";

// Device detail (AP / switch / any): registry fields + live state; APs get
// the Phase 10.2 wireless sections (detail KV, radios, clients) from
// /api/wireless/aps/{id} — NetMon's own tables, zero XIQ calls at render.
export function ApDetailPage({ id }) {
  const [device, setDevice] = React.useState(null);
  const [status, setStatus] = React.useState(null);
  const [wireless, setWireless] = React.useState(null);
  const [error, setError] = React.useState(null);

  React.useEffect(() => {
    let live = true;
    Promise.all([getJSON(`/api/devices/${id}`), getJSON("/api/status")])
      .then(([dev, rows]) => {
        if (!live) return;
        setDevice(dev);
        setStatus(rows.find((r) => String(r.id) === String(id)) || null);
        if (dev.device_type === "ap") {
          getJSON(`/api/wireless/aps/${id}`)
            .then((w) => live && setWireless(w))
            .catch(() => { /* wireless sections stay hidden */ });
        }
      })
      .catch((e) => live && setError(e));
    return () => { live = false; };
  }, [id]);

  if (error) return <ErrorMsg error={error} />;
  if (!device) return <Loading what={`device ${id}`} />;

  const keys = [
    ["XIQ", device.xiq_device_id],
    ["PacketFence MAC", device.pf_node_mac],
    ["Milestone", device.milestone_hardware_id],
    ["rConfig", device.rconfig_device_id],
    ["3CX", device.threecx_ref],
  ].filter(([, v]) => v);

  return (
    <div className="page">
      <a className="back" href={device.device_type === "switch" ? "#/switches" : "#/"}>← Back</a>
      <div className="detail-head">
        <h1>{device.name}</h1>
        <SshButton host={device.mgmt_ip} name={device.name} />
      </div>
      <div className="subtitle mono">{device.mgmt_ip || "no mgmt IP"} · {device.device_type} · {device.site || "unknown site"}</div>

      <div className="stat-row">
        <StateTile label="Ping" state={status?.ping} />
        <StateTile label="SNMP" state={status?.snmp} />
        <StateTile label="Source (XIQ)" state={status?.source_status} />
      </div>

      <Card title="Registry">
        <table className="grid kv">
          <tbody>
            <tr><td>Name</td><td>{device.name}</td></tr>
            <tr><td>Site</td><td>{device.site || "—"}</td></tr>
            <tr><td>Type</td><td>{device.device_type}</td></tr>
            <tr><td>Mgmt IP</td><td className="mono">{device.mgmt_ip || "—"}</td></tr>
            <tr><td>SNMP capable</td><td>{device.snmp_capable ? "yes" : "no"}</td></tr>
            <tr><td>Enabled</td><td>{device.enabled ? "yes" : "no"}</td></tr>
          </tbody>
        </table>
      </Card>

      {wireless?.detail && (
        <Card title="Access point" kicker={`XIQ detail cache · ${wireless.detail.updated_at || ""}`}>
          <table className="grid kv">
            <tbody>
              <tr><td>Model</td><td>{wireless.detail.model || "—"}</td></tr>
              <tr><td>Serial</td><td className="mono">{wireless.detail.serial || "—"}</td></tr>
              <tr><td>Firmware</td><td className="mono">{wireless.detail.fw_version || "—"}</td></tr>
              <tr><td>Base MAC</td><td className="mono">{wireless.detail.mgmt_mac || "—"}</td></tr>
              <tr><td>IP</td><td className="mono">{wireless.detail.ip || "—"}</td></tr>
              <tr><td>Network policy</td><td>{wireless.detail.network_policy || "—"}</td></tr>
              <tr><td>Uptime</td><td>{wireless.detail.uptime_s ? `${Math.floor(wireless.detail.uptime_s / 86400)}d ${Math.floor((wireless.detail.uptime_s % 86400) / 3600)}h` : "—"}</td></tr>
              <tr><td>Clients</td><td className="mono">{wireless.detail.clients_total ?? "—"}</td></tr>
            </tbody>
          </table>
        </Card>
      )}

      {wireless && wireless.radios?.length > 0 && (
        <Card title="Radios">
          <table className="grid">
            <thead><tr><th>Radio</th><th>Band</th><th>Channel</th><th>Width</th><th>TX power</th><th>Clients</th></tr></thead>
            <tbody>
              {wireless.radios.map((r) => (
                <tr key={r.radio}>
                  <td className="mono">{r.radio}</td>
                  <td className="mono">{r.band ? `${r.band} GHz` : "—"}</td>
                  <td className="mono">{r.channel ?? "—"}</td>
                  <td className="mono dim">{r.width_mhz ? `${r.width_mhz} MHz` : "—"}</td>
                  <td className="mono dim">{r.tx_power_dbm !== null && r.tx_power_dbm !== undefined ? `${r.tx_power_dbm} dBm` : "—"}</td>
                  <td className="mono">{r.clients ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {wireless && wireless.clients?.length > 0 && (
        <Card title="Connected clients" kicker={`${wireless.clients.length} client(s) · cache cadence`}>
          <table className="grid">
            <thead><tr><th>MAC</th><th>Hostname</th><th>User</th><th>PF role</th><th>Reg</th><th>SSID</th><th>Band</th><th>RSSI</th><th>OS</th><th>IP</th></tr></thead>
            <tbody>
              {wireless.clients.map((c) => (
                <tr key={c.mac}>
                  <td className="mono">{c.mac}</td>
                  <td>{c.hostname || "—"}</td>
                  <td className="dim">{c.username || c.pf_owner || "—"}</td>
                  <td>{c.pf_role || "—"}</td>
                  <td>{c.pf_status
                    ? <span style={{ color: c.pf_status === "reg" ? sevColor("ok") : sevColor("warn"), fontWeight: 600 }}>{c.pf_status}</span>
                    : "—"}</td>
                  <td>{c.ssid || "—"}</td>
                  <td className="mono dim">{c.band || "—"}</td>
                  <td className="mono" style={c.rssi_dbm !== null && c.rssi_dbm < -70 ? { color: sevColor("warn") } : undefined}>
                    {c.rssi_dbm !== null && c.rssi_dbm !== undefined ? `${c.rssi_dbm} dBm` : "—"}</td>
                  <td className="dim">{c.os || "—"}</td>
                  <td className="mono dim">{c.ip || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="dim" style={{ fontSize: 11, marginTop: 8 }}>
            Role/registration via wireless_clients ⋈ PacketFence (cache join).
          </div>
        </Card>
      )}

      {keys.length > 0 && (
        <Card title="Source keys">
          <table className="grid kv">
            <tbody>{keys.map(([k, v]) => <tr key={k}><td>{k}</td><td className="mono">{v}</td></tr>)}</tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

function StateTile({ label, state }) {
  return (
    <div className="stat">
      <div style={{ margin: "4px 0" }}><Badge state={state} /></div>
      <div className="stat-label">{label}</div>
    </div>
  );
}
