import React from "react";
import { getJSON } from "../api.js";
import { Card, Badge, Loading, ErrorMsg, sevColor } from "../primitives.jsx";
import { SshButton } from "../ssh.jsx";
import { ActionButton, ActionAudit } from "../actions.jsx";

// Device detail (AP / switch / any): registry fields + live state; APs get
// the Phase 10.2 wireless sections (detail KV, radios, clients) from
// /api/wireless/aps/{id} — NetMon's own tables, zero XIQ calls at render.
// ``embedded`` renders the same content inside the Wireless navigator's right
// pane: the outer <div className="page"> and the "← Back" link belong to the
// standalone #/ap/:id route and would nest a page inside a page otherwise.
export function ApDetailPage({ id, embedded = false }) {
  const [device, setDevice] = React.useState(null);
  const [status, setStatus] = React.useState(null);
  const [wireless, setWireless] = React.useState(null);
  const [meta, setMeta] = React.useState(null);
  const [error, setError] = React.useState(null);

  React.useEffect(() => {
    let live = true;
    getJSON("/api/meta").then((m) => live && setMeta(m))
      .catch(() => { /* the PF deep-link just stays hidden */ });
    return () => { live = false; };
  }, []);

  React.useEffect(() => {
    let live = true;
    Promise.all([getJSON(`/api/devices/${id}`), getJSON("/api/status")])
      .then(([dev, rows]) => {
        if (!live) return;
        // A switch belongs on the Switches page (faceplate/ports/PoE), never
        // "under AP" — bounce there if we were reached via an #/ap/ link.
        if (dev.device_type === "switch") { location.replace(`#/switches/${id}`); return; }
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
    <div className={embedded ? "" : "page"}>
      {!embedded && (
        <a className="back" href={device.device_type === "switch" ? "#/switches" : "#/wireless"}>← Back</a>
      )}
      <div className="detail-head">
        <h1>{device.name}</h1>
        <SshButton host={device.mgmt_ip} name={device.name} />
        {/* Reboot AP (spec 11 D4) — XIQ only, so it self-hides on a switch,
            and the server independently refuses a non-AP device_type. */}
        {device.device_type === "ap" && (
          <ActionButton actionKey="ap_reboot" path="ap-reboot"
                        body={{ device_id: device.id }} />
        )}
        {/* PacketFence acts on an endpoint MAC, so these appear only when PF
            actually knows this AP (745 of 783 do). */}
        {wireless?.pf?.mac && (
          <ActionButton actionKey="reevaluate_access" path="reevaluate-access"
                        body={{ mac: wireless.pf.mac, device_id: device.id }} />
        )}
        {wireless?.pf?.mac && (
          <ActionButton actionKey="restart_port" path="restart-port"
                        body={{ mac: wireless.pf.mac, device_id: device.id }} />
        )}
        {/* Cycle PoE targets the switch port the AP is powered from, so it is
            offered only when that port is corroborated — see the Uplink card.
            An unconfirmed port is far more likely to be an uplink trunk, and
            power-cycling one of those takes out a whole switch. */}
        {wireless?.uplink?.poe_cycle_safe && (
          <ActionButton actionKey="poe_cycle" path="poe-cycle"
                        body={{ device_id: wireless.uplink.switch_device_id,
                                port: wireless.uplink.port }}
                        label={`Cycle PoE (${wireless.uplink.switch_name} ${wireless.uplink.port})`} />
        )}
        {wireless?.uplink && !wireless.uplink.poe_cycle_safe && (
          <button type="button" className="btn btn-sm" disabled
                  title={`Cycle PoE needs a confirmed access port — ${wireless.uplink.why}`}>
            Cycle PoE
          </button>
        )}
        {meta?.packetfence_url && wireless?.pf?.mac && (
          <a className="btn btn-sm"
             href={`${meta.packetfence_url}/admin/#/node/${encodeURIComponent(wireless.pf.mac)}`}
             target="_blank" rel="noopener noreferrer"
             title="Open this endpoint in the PacketFence admin UI">
            View in PacketFence ↗
          </a>
        )}
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

      {wireless?.uplink && (
        <Card title="Uplink — switch port"
              kicker={`${wireless.uplink.candidates} FDB candidate(s)`}>
          <table className="grid kv">
            <tbody>
              <tr><td>Switch</td><td>
                <a href={`#/switches/${wireless.uplink.switch_device_id}`}>{wireless.uplink.switch_name}</a>
                {wireless.uplink.switch_site && <span className="dim"> · {wireless.uplink.switch_site}</span>}
              </td></tr>
              <tr><td>Port</td><td className="mono">{wireless.uplink.port || `ifIndex ${wireless.uplink.ifindex}`}</td></tr>
              <tr><td>Link</td><td className="mono dim">
                {wireless.uplink.oper_state || "—"}
                {wireless.uplink.speed_mbps ? ` · ${wireless.uplink.speed_mbps} Mbps` : ""}
                {wireless.uplink.is_sfp === 1 ? " · SFP/fiber" : ""}
              </td></tr>
              <tr><td>PoE</td><td className="mono">
                {wireless.uplink.poe_delivering === 1
                  ? <span style={{ color: sevColor("ok") }}>
                      delivering{wireless.uplink.poe_watts ? ` · ${wireless.uplink.poe_watts} W` : ""}
                    </span>
                  : <span className="dim">not delivering</span>}
              </td></tr>
              <tr><td>MACs on port</td><td className="mono">{wireless.uplink.macs_on_port}</td></tr>
              <tr><td>PacketFence</td><td className="mono">
                {wireless.uplink.pf_agrees === true
                  ? <span style={{ color: sevColor("ok") }}>agrees ({wireless.uplink.pf_port})</span>
                  : wireless.uplink.pf_agrees === false
                  ? <span style={{ color: sevColor("warn") }}>
                      disagrees — PF last saw it on {wireless.uplink.pf_port}
                    </span>
                  : <span className="dim">no PF port recorded</span>}
              </td></tr>
            </tbody>
          </table>
          {/* Why this is shown rather than just used: an AP's MAC is learned on
              every port in its path — a median of 5 here, up to 14 — and all but
              one are uplink trunks. The operator should be able to see which
              port the Cycle PoE button would actually bounce, and why. */}
          <div className={"msg" + (wireless.uplink.poe_cycle_safe ? "" : " error")}
               style={{ fontSize: 11 }}>
            {wireless.uplink.poe_cycle_safe
              ? `Access port confirmed: ${wireless.uplink.why}. Cycle PoE targets this port.`
              : `Cycle PoE is unavailable: ${wireless.uplink.why}. Bouncing an unconfirmed port risks power-cycling an uplink.`}
          </div>
        </Card>
      )}

      {wireless?.pf && (
        <Card title="PacketFence — this AP as an endpoint"
              kicker={`node cache · ${wireless.pf.updated_at || ""}`}>
          <table className="grid kv">
            <tbody>
              <tr><td>MAC</td><td className="mono">{wireless.pf.mac}</td></tr>
              <tr><td>Computer name</td><td>{wireless.pf.computername || "—"}</td></tr>
              <tr><td>Role</td><td>{wireless.pf.role || "—"}</td></tr>
              <tr><td>Registration</td><td>
                {wireless.pf.reg_status
                  ? <span style={{ color: wireless.pf.reg_status === "reg" ? sevColor("ok") : sevColor("warn"), fontWeight: 600 }}>
                      {wireless.pf.reg_status}
                    </span>
                  : "—"}
              </td></tr>
              <tr><td>Online</td><td>{wireless.pf.online === 1 ? "yes" : wireless.pf.online === 0 ? "no" : "—"}</td></tr>
              <tr><td>Vendor</td><td className="dim">{wireless.pf.vendor || "—"}</td></tr>
              <tr><td>VLAN</td><td className="mono dim">{wireless.pf.vlan || "—"}</td></tr>
              <tr><td>Last switch / port</td><td className="mono dim">
                {wireless.pf.last_switch || "—"}{wireless.pf.last_port ? ` · ${wireless.pf.last_port}` : ""}
              </td></tr>
              <tr><td>Connection</td><td className="mono dim">{wireless.pf.conn_method || "—"}</td></tr>
              <tr><td>Last seen</td><td className="mono dim">{wireless.pf.last_seen || "—"}</td></tr>
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
