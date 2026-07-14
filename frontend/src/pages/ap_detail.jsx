import React from "react";
import { getJSON } from "../api.js";
import { Card, Badge, Loading, ErrorMsg } from "../primitives.jsx";

// Device detail (AP / switch / any): registry fields + live state.
// Per-device XIQ live detail (ports/PoE/clients) is a later passthrough
// endpoint; this page shows what the core model + poller/XIQ collector store.
export function ApDetailPage({ id }) {
  const [device, setDevice] = React.useState(null);
  const [status, setStatus] = React.useState(null);
  const [error, setError] = React.useState(null);

  React.useEffect(() => {
    let live = true;
    Promise.all([getJSON(`/api/devices/${id}`), getJSON("/api/status")])
      .then(([dev, rows]) => {
        if (!live) return;
        setDevice(dev);
        setStatus(rows.find((r) => String(r.id) === String(id)) || null);
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
      <h1>{device.name}</h1>
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
