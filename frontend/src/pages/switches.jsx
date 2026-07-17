import React from "react";
import { getJSON } from "../api.js";
import { Card, Loading, ErrorMsg, SourceBadge, sevColor } from "../primitives.jsx";
import { SshButton } from "../ssh.jsx";

// Switches dashboard (spec 10 §7 / phase 10.1) — the ZCD port of the "big
// build": site navigator, KPI strip, port faceplate, port-detail pane (with
// the FDB MAC list; PF identity joins in 10.3), and the LLDP/VLAN/stack/PoE/
// triggers/backups tabs. Everything renders from NetMon's own DB via
// /api/switches/* — zero source-platform calls at render time. Rows carry
// updated_at so staleness is badged honestly; PoE columns are NULL until the
// PoE sweep lands (spec 10 progress log) and render "—", never fabricated.

const REFRESH_MS = 30000;

const TABS = [
  { id: "ports", label: "Ports" },
  { id: "fdb", label: "FDB" },
  { id: "topology", label: "Topology" },
  { id: "vlans", label: "VLANs" },
  { id: "stack", label: "Stack" },
  { id: "poe", label: "PoE" },
  { id: "triggers", label: "Triggers" },
  { id: "backups", label: "Backups" },
];

function ageOf(iso) {
  if (!iso) return null;
  const t = Date.parse(iso.endsWith("Z") || iso.includes("+") ? iso : iso + "Z");
  if (Number.isNaN(t)) return null;
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 90) return `${Math.round(s)}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 129600) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

function fmtRate(kbps) {
  if (kbps === null || kbps === undefined) return "—";
  if (kbps >= 1000000) return `${(kbps / 1000000).toFixed(1)} Gbps`;
  if (kbps >= 1000) return `${(kbps / 1000).toFixed(1)} Mbps`;
  return `${kbps} Kbps`;
}

function fmtSpeed(mbps) {
  if (!mbps) return "—";
  return mbps >= 1000 ? `${mbps / 1000}G` : `${mbps}M`;
}

function fmtUptime(s) {
  if (s === null || s === undefined) return "—";
  if (s < 7200) return `${Math.round(s / 60)}m`;
  if (s < 172800) return `${(s / 3600).toFixed(1)}h`;
  return `${Math.floor(s / 86400)}d`;
}

// Port number from the EXOS name "1:18" (fall back to ifindex).
function portNum(p) {
  const m = /:(\d+)$/.exec(p.name || "");
  return m ? parseInt(m[1], 10) : p.ifindex;
}

// Healthy stack member states (decoded from extremeStackMemberOperStatus):
// "up" is good; "down"/"mismatch"/"unknown" warn. Legacy "active"/"online"
// kept so older cached rows don't suddenly read as faulted.
const STACK_OK = new Set(["up", "active", "online"]);

const SPEED_CLASS = (mbps) =>
  mbps >= 10000 ? "spd-10g" : mbps >= 1000 ? "spd-1g" : mbps >= 100 ? "spd-100m" : "spd-10m";

// ───────── faceplate ─────────

function PortCell({ p, selected, onClick }) {
  const state = p.oper_state || "unknown";
  const cls = [
    "port", state,
    state === "up" ? SPEED_CLASS(p.speed_mbps || 0) : "",
    p.poe_delivering ? "poe" : "",
    (p.err_in_delta || p.err_out_delta) ? "err" : "",
    selected ? "selected" : "",
  ].filter(Boolean).join(" ");
  const bits = [`${p.name || p.ifindex}`, state];
  if (state === "up") bits.push(fmtSpeed(p.speed_mbps));
  if (p.is_sfp === 1) bits.push("SFP/fiber");
  if (p.poe_delivering) bits.push("PoE");
  if (p.err_in_delta || p.err_out_delta) bits.push("errors");
  return (
    <div className={cls + (p.is_sfp === 1 ? " sfp" : "")} onClick={onClick} title={bits.join(" · ")}>
      <div className="pn">{portNum(p)}{p.is_sfp === 1 ? <span style={{ fontSize: 7, verticalAlign: "super", opacity: 0.85 }} title="SFP / fiber">◆</span> : null}</div>
      <div className="body">
        <span className="led led-link" />
        <span className="led led-speed" />
      </div>
    </div>
  );
}

function MemberGrid({ member, ports, selected, onSelect }) {
  const odds = ports.filter((p) => portNum(p) % 2 === 1);
  const evens = ports.filter((p) => portNum(p) % 2 === 0);
  const cols = Math.max(1, odds.length, evens.length);
  const up = ports.filter((p) => p.oper_state === "up").length;
  const poe = ports.filter((p) => p.poe_delivering).length;
  const sfp = ports.filter((p) => p.is_sfp === 1).length;
  return (
    <div className="swport-member">
      <div className="swport-member-head">
        <span className="m-id">MEMBER <span className="m-num">{member ?? "—"}</span></span>
        <span className="m-stats">
          <span className="m-up">{up} up</span> / <span className="m-down">{ports.length - up} down</span>
        </span>
        {poe > 0 && <span className="m-stats">⚡ {poe} PoE on</span>}
        {sfp > 0 && <span className="m-stats" title="fiber / SFP ports">◆ {sfp} SFP</span>}
      </div>
      {[odds, evens].map((row, i) => (
        <div className="swport-grid" key={i}
             style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
          {row.map((p) => (
            <PortCell key={p.ifindex} p={p}
                      selected={selected === p.ifindex}
                      onClick={() => onSelect(p.ifindex)} />
          ))}
        </div>
      ))}
    </div>
  );
}

// ───────── port detail pane ─────────

function RateBar({ kbps, speedMbps, color }) {
  const cap = (speedMbps || 1000) * 1000;
  const pct = kbps ? Math.min(100, (kbps / cap) * 100) : 0;
  return (
    <div className="pd-bar">
      <i style={{ width: `${Math.max(pct, kbps ? 2 : 0)}%`, background: color }} />
    </div>
  );
}

function PortDetail({ switchId, ifindex }) {
  const [detail, setDetail] = React.useState(null);
  const [error, setError] = React.useState(null);

  React.useEffect(() => {
    if (!ifindex) return;
    setDetail(null);
    let live = true;
    const load = () =>
      getJSON(`/api/switches/${switchId}/ports/${ifindex}`)
        .then((d) => { if (live) { setDetail(d); setError(null); } })
        .catch((e) => { if (live) setError(e); });
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => { live = false; clearInterval(id); };
  }, [switchId, ifindex]);

  if (!ifindex) {
    return <Card kicker="Port detail"><div className="msg">Select a port on the faceplate.</div></Card>;
  }
  if (error) return <ErrorMsg error={error} />;
  if (!detail) return <Loading what="port detail" />;

  const p = detail.port;
  const row = (label, value) => (
    <div className="pd-row"><div className="pd-lbl">{label}</div><div className="pd-val">{value}</div></div>
  );
  return (
    <Card kicker={`Port detail · ${p.name || p.ifindex} · cache ${ageOf(p.updated_at) || "?"} old`}>
      <div className="pd-cols">
        <div>
          {row("State", <span style={{ color: p.oper_state === "up" ? sevColor("ok") : sevColor("unknown"), fontWeight: 600 }}>
            {p.oper_state}{p.admin_up === 0 ? " (admin down)" : ""}</span>)}
          {row("Speed", p.speed_mbps ? fmtSpeed(p.speed_mbps) : "—")}
          {row("Media", p.is_sfp === 1 ? "SFP / fiber" : p.is_sfp === 0 ? "copper / fixed" : "—")}
          {row("Duplex", p.duplex || "—")}
          {row("Utilization", p.util_pct !== null && p.util_pct !== undefined ? `${p.util_pct}%` : "—")}
          <div className="pd-row">
            <div className="pd-lbl">Rate in</div>
            <div className="pd-mid"><RateBar kbps={p.in_kbps} speedMbps={p.speed_mbps} color={sevColor("ok")} /></div>
            <div className="pd-val mono">{fmtRate(p.in_kbps)}</div>
          </div>
          <div className="pd-row">
            <div className="pd-lbl">Rate out</div>
            <div className="pd-mid"><RateBar kbps={p.out_kbps} speedMbps={p.speed_mbps} color="#5b8cff" /></div>
            <div className="pd-val mono">{fmtRate(p.out_kbps)}</div>
          </div>
          {row("Errors (Δ)", <span style={(p.err_in_delta || p.err_out_delta) ? { color: sevColor("warn") } : undefined}>
            {p.err_in_delta ?? "—"} in / {p.err_out_delta ?? "—"} out</span>)}
          {row("Discards (Δ)", `${p.disc_in_delta ?? "—"} in / ${p.disc_out_delta ?? "—"} out`)}
          {row("PoE", p.poe_delivering ? `delivering${p.poe_watts ? ` · ${p.poe_watts} W` : ""}` : (p.poe_admin === null ? "—" : "off"))}
        </div>
        <div>
          <div className="pd-devices-head">
            Devices on port · FDB <SourceBadge source="snmp_inventory" />
            <span className="dim"> {detail.macs.length} MAC(s)
              {detail.macs[0] ? ` · FDB age ${ageOf(detail.macs[0].updated_at) || "?"}` : ""}</span>
          </div>
          {detail.macs.length === 0 ? (
            <div className="msg">No MAC addresses learned on this port in the last FDB sweep.</div>
          ) : (
            <table className="grid">
              <thead><tr><th>MAC</th><th>VLAN</th><th>Identity</th><th>Owner</th><th>Role</th><th>Reg</th></tr></thead>
              <tbody>
                {detail.macs.map((m) => (
                  <tr key={m.mac}>
                    <td className="mono">{m.mac}</td>
                    <td className="mono dim">{m.vlan_id ?? "—"}</td>
                    <td>{m.computername || <span className="dim">unknown to PF</span>}</td>
                    <td className="dim">{m.owner || m.dot1x_user || "—"}</td>
                    <td>{m.role ? <span className="pill">{m.role}</span> : "—"}</td>
                    <td>{m.reg_status
                      ? <span style={{ color: m.reg_status === "reg" ? sevColor("ok") : sevColor("warn"), fontWeight: 600 }}>
                          {m.reg_status}</span>
                      : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="dim pd-note">Identity via FDB ⋈ PacketFence (cache join, zero source calls).</div>
        </div>
      </div>
    </Card>
  );
}

// ───────── simple tab tables ─────────

function staleKicker(rows, what) {
  const newest = rows.reduce((a, r) => (r.updated_at > a ? r.updated_at : a), "");
  return `${rows.length} ${what} · cache ${ageOf(newest) || "?"} old`;
}

function EmptySweep({ what }) {
  return (
    <div className="msg">
      No {what} rows for this switch yet — the snmp_inventory sweep hasn't run
      (disabled, first cycle pending, or this switch is unreachable). Prior data
      is never fabricated.
    </div>
  );
}

function FdbTab({ switchId, portName }) {
  const [rows, setRows] = React.useState(null);
  const [q, setQ] = React.useState("");
  React.useEffect(() => { tabFetch(`/api/switches/${switchId}/fdb`, setRows); }, [switchId]);
  if (!rows) return <Loading what="FDB" />;
  const shown = rows.filter((r) => !q || r.mac.includes(q.toLowerCase()));
  return (
    <Card kicker={rows.length ? staleKicker(rows, "FDB entries") : "FDB"}>
      {rows.length === 0 ? <EmptySweep what="FDB" /> : (
        <React.Fragment>
          <label className="evt-filter" style={{ maxWidth: 280, marginBottom: 8 }}>
            <span>Filter MAC</span>
            <input type="text" value={q} placeholder="aa:bb:cc…" onChange={(e) => setQ(e.target.value)} />
          </label>
          <table className="grid">
            <thead><tr><th>MAC</th><th>VLAN</th><th>Port</th><th>First seen</th><th>Age</th></tr></thead>
            <tbody>
              {shown.slice(0, 500).map((r) => (
                <tr key={r.mac}>
                  <td className="mono">{r.mac}</td>
                  <td className="mono dim">{r.vlan_id ?? "—"}</td>
                  <td className="mono">{portName(r.ifindex)}</td>
                  <td className="mono dim">{r.first_seen || "—"}</td>
                  <td className="mono dim">{ageOf(r.updated_at) || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {shown.length > 500 && <div className="dim pd-note">Showing first 500 of {shown.length} — narrow the filter.</div>}
        </React.Fragment>
      )}
    </Card>
  );
}

function TopologyTab({ switchId, portName }) {
  const [rows, setRows] = React.useState(null);
  React.useEffect(() => { tabFetch(`/api/switches/${switchId}/neighbors`, setRows); }, [switchId]);
  if (!rows) return <Loading what="EDP neighbors" />;
  return (
    <Card kicker={rows.length ? staleKicker(rows, "EDP neighbor(s)") : "Topology (EDP)"}>
      {rows.length === 0 ? <EmptySweep what="EDP neighbor" /> : (
        <table className="grid">
          <thead><tr><th>Local port</th><th>Neighbor</th><th>Neighbor port</th>
                     <th>EXOS version</th><th>Proto</th><th>Entry age</th></tr></thead>
          <tbody>
            {rows.map((r) => {
              // extremeEdpEntryAge > 90s means the neighbor likely went away.
              const stale = r.age_s !== null && r.age_s !== undefined && r.age_s > 90;
              return (
                <tr key={r.local_ifindex}>
                  <td className="mono">{r.local_port || portName(r.local_ifindex)}</td>
                  <td>{r.remote_sysname || "—"}</td>
                  <td className="mono">{r.remote_port || "—"}</td>
                  <td className="dim">{r.remote_sysdesc || "—"}</td>
                  <td className="mono dim">{(r.protocol || "edp").toUpperCase()}</td>
                  <td className="mono" style={stale ? { color: sevColor("warn") } : { color: "var(--dim)" }}>
                    {r.age_s !== null && r.age_s !== undefined ? `${r.age_s}s` : "—"}
                    {stale ? " ⚠" : ""}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function VlansTab({ switchId }) {
  const [rows, setRows] = React.useState(null);
  React.useEffect(() => { tabFetch(`/api/switches/${switchId}/vlans`, setRows); }, [switchId]);
  if (!rows) return <Loading what="VLANs" />;
  return (
    <Card kicker={rows.length ? staleKicker(rows, "VLANs") : "VLANs"}>
      {rows.length === 0 ? <EmptySweep what="VLAN" /> : (
        <table className="grid">
          <thead><tr><th>VID</th><th>Name</th><th>Admin</th><th>Untagged</th><th>Tagged</th><th>Age</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.vlan_id}>
                <td className="mono">{r.vlan_id}</td>
                <td>{r.name || "—"}</td>
                <td>{r.admin_up === null ? "—" : r.admin_up ? "up" : "down"}</td>
                <td className="mono dim">{r.untagged_count ?? "—"}</td>
                <td className="mono dim">{r.tagged_count ?? "—"}</td>
                <td className="mono dim">{ageOf(r.updated_at) || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function parseJsonList(s) {
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : null; } catch { return null; }
}

function StackTab({ stack }) {
  if (!stack || stack.length === 0) {
    return <Card kicker="Stack"><EmptySweep what="stack-member" /></Card>;
  }
  return (
    <Card kicker={staleKicker(stack, "stack member(s)")}>
      <table className="grid">
        <thead>
          <tr><th>Slot</th><th>Role</th><th>Status</th><th>Model</th><th>Serial</th><th>EXOS</th>
              <th>Uptime</th><th>CPU</th><th>Mem</th><th>Temp</th><th>Fans</th><th>PSUs</th><th>Note</th></tr>
        </thead>
        <tbody>
          {stack.map((m) => {
            const fans = parseJsonList(m.fans);
            const psus = parseJsonList(m.psus);
            return (
              <tr key={m.slot}>
                <td className="mono">{m.slot}</td>
                <td>{m.role || "—"}</td>
                <td style={m.status && !STACK_OK.has(m.status) ? { color: sevColor("warn") } : undefined}>
                  {m.status || "—"}</td>
                <td>{m.model || "—"}</td>
                <td className="mono dim">{m.serial || "—"}</td>
                <td className="mono dim">{m.fw_version || "—"}</td>
                <td className="mono">{fmtUptime(m.uptime_s)}</td>
                <td className="mono">{m.cpu_pct !== null && m.cpu_pct !== undefined ? `${m.cpu_pct}%` : "—"}</td>
                <td className="mono">{m.mem_pct !== null && m.mem_pct !== undefined ? `${m.mem_pct}%` : "—"}</td>
                <td className="mono">{m.temp_c !== null && m.temp_c !== undefined ? `${m.temp_c}°C` : "—"}</td>
                <td className="mono dim" title={fans ? fans.join(", ") : undefined}>
                  {fans ? fans.length : "—"}</td>
                <td className="mono dim" title={psus ? psus.join(", ") : undefined}>
                  {psus ? psus.length : "—"}</td>
                <td className="dim">{m.warn_msg || "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="dim pd-note">
        Model / serial / EXOS / fan+PSU presence come from the hourly ENTITY
        sweep; fan RPM / PSU wattage sensors are a later Extreme-MIB extra.
      </div>
    </Card>
  );
}

function PoeBudgetBar({ used, avail }) {
  if (!avail) return null;
  const pct = Math.min(100, (used / avail) * 100);
  const color = pct >= 90 ? sevColor("crit") : pct >= 75 ? sevColor("warn") : sevColor("ok");
  return (
    <div className="pd-bar" style={{ width: 140 }}>
      <i style={{ width: `${Math.max(pct, used ? 2 : 0)}%`, background: color }} />
    </div>
  );
}

function PoeTab({ ports, stack }) {
  const slots = (stack || []).filter((m) => m.poe_status || m.poe_budget_w !== null);
  const withPoe = (ports || []).filter(
    (p) => p.poe_admin !== null || p.poe_delivering !== null || p.poe_watts !== null);
  const delivering = withPoe.filter((p) => p.poe_delivering)
    .sort((a, b) => (b.poe_watts || 0) - (a.poe_watts || 0));
  return (
    <React.Fragment>
      <Card kicker="Per-member PoE budget" title="Slot budgets (EXTREME-POE-MIB)">
        {slots.length === 0 ? (
          <div className="msg">No slot PoE data yet — the poe sweep hasn't run against this switch.</div>
        ) : (
          <table className="grid">
            <thead>
              <tr><th>Member</th><th>Status</th><th>Measured</th><th>Allocated</th>
                  <th>Usage</th><th>Available</th><th>Budget</th><th>HW max</th></tr>
            </thead>
            <tbody>
              {slots.map((m) => (
                <tr key={m.slot}>
                  <td className="mono">{m.slot}</td>
                  <td style={m.poe_status && m.poe_status !== "operational"
                        ? { color: sevColor("warn"), fontWeight: 600 } : undefined}>
                    {m.poe_status || "—"}</td>
                  <td className="mono">{m.poe_measured_w ?? "—"} W</td>
                  <td className="mono dim">{m.poe_alloc_w ?? "—"} W</td>
                  <td><PoeBudgetBar used={m.poe_measured_w || 0} avail={m.poe_avail_w} /></td>
                  <td className="mono">{m.poe_avail_w ?? "—"} W</td>
                  <td className="mono dim">{m.poe_budget_w ?? "—"} W</td>
                  <td className="mono dim">{m.poe_capacity_w ?? "—"} W</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <Card kicker={withPoe.length
          ? `${delivering.length} delivering / ${withPoe.length} PoE-capable port(s)`
          : "Per-port PoE"}>
        {withPoe.length === 0 ? (
          <div className="msg">No per-port PoE data yet — non-PoE ports stay blank, never fabricated.</div>
        ) : (
          <table className="grid">
            <thead><tr><th>Port</th><th>Admin</th><th>Delivering</th><th>Class</th><th>Draw</th></tr></thead>
            <tbody>
              {[...delivering, ...withPoe.filter((p) => !p.poe_delivering)].map((p) => (
                <tr key={p.ifindex}>
                  <td className="mono">{p.name || p.ifindex}</td>
                  <td>{p.poe_admin === null ? "—" : p.poe_admin ? "enabled" : "disabled"}</td>
                  <td>{p.poe_delivering === null ? "—"
                        : p.poe_delivering ? <span style={{ color: sevColor("ok"), fontWeight: 600 }}>yes</span>
                        : <span className="dim">searching</span>}</td>
                  <td className="mono dim">{p.poe_class ?? "—"}</td>
                  <td className="mono">{p.poe_delivering && p.poe_watts !== null ? `${p.poe_watts} W` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </React.Fragment>
  );
}

function TriggersTab({ switchId }) {
  const [rows, setRows] = React.useState(null);
  React.useEffect(() => { tabFetch(`/api/alerts?device_id=${switchId}&include_closed=true`, setRows); }, [switchId]);
  if (!rows) return <Loading what="alerts" />;
  const open = rows.filter((r) => !r.closed_at);
  return (
    <Card kicker={`${open.length} open / ${rows.length} total`}>
      {rows.length === 0 ? (
        <div className="msg">No alerts recorded for this switch.</div>
      ) : (
        <table className="grid">
          <thead><tr><th>Severity</th><th>Rule</th><th>Opened</th><th>Status</th><th>Acked by</th><th>Assigned</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td style={{ color: sevColor(r.severity), fontWeight: 600 }}>{r.severity}</td>
                <td>{r.rule_name}</td>
                <td className="mono dim">{r.opened_at || "—"}</td>
                <td>{r.closed_at ? <span className="dim">closed</span> : <span style={{ color: sevColor("warn") }}>open</span>}</td>
                <td className="dim">{r.acked_by || "—"}</td>
                <td className="dim">{r.assigned_to || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="dim pd-note">Ack / assign / suppress live on the Problems console.</div>
    </Card>
  );
}

function BackupsTab({ switchId }) {
  const [rows, setRows] = React.useState(null);
  React.useEffect(() => { tabFetch(`/api/switches/${switchId}/backups`, setRows); }, [switchId]);
  if (!rows) return <Loading what="config backups" />;
  return (
    <Card kicker={rows.length ? `${rows.length} backup(s)` : "Config backups"}>
      {rows.length === 0 ? (
        <div className="msg">
          No backup metadata for this switch — the rConfig backup-list cycle
          hasn't captured any (collector extension pending, or the device isn't
          in rConfig).
        </div>
      ) : (
        <table className="grid">
          <thead><tr><th>Taken</th><th>Size</th><th>Hash</th><th>Note</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.taken_at}>
                <td className="mono">{r.taken_at}</td>
                <td className="mono dim">{r.size_bytes ? `${Math.round(r.size_bytes / 1024)} KiB` : "—"}</td>
                <td className="mono dim">{(r.hash || "—").slice(0, 12)}</td>
                <td className="dim">{r.note || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="dim pd-note">Config diffs are a user-initiated read-through to rConfig (spec 10 Q5) — not fetched at render.</div>
    </Card>
  );
}

// Tab loaders share one shape: fetch once per switch (tabs refresh on switch
// change; the Ports tab owns the 30 s auto-refresh loop).
function tabFetch(url, set) {
  set(null);
  getJSON(url).then(set).catch(() => set([]));
}

// ───────── page ─────────

export function SwitchesPage({ id }) {
  const [fleet, setFleet] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [tab, setTab] = React.useState("ports");
  const [detail, setDetail] = React.useState(null);   // /api/switches/{id} (stack)
  const [ports, setPorts] = React.useState(null);
  const [selectedPort, setSelectedPort] = React.useState(null);

  const activeId = id ? parseInt(id, 10) : null;

  // Fleet list for the navigator (and to pick a default switch).
  React.useEffect(() => {
    let live = true;
    const load = () => getJSON("/api/switches")
      .then((rows) => { if (live) { setFleet(rows); setError(null); } })
      .catch((e) => { if (live) setError(e); });
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => { live = false; clearInterval(t); };
  }, []);

  // Default selection: first switch once the fleet loads.
  React.useEffect(() => {
    if (!activeId && fleet && fleet.length > 0) {
      location.hash = `#/switches/${fleet[0].id}`;
    }
  }, [fleet, activeId]);

  // Per-switch data (stack + ports) on the cache cadence.
  React.useEffect(() => {
    if (!activeId) return;
    setDetail(null); setPorts(null); setSelectedPort(null);
    let live = true;
    const load = () => {
      getJSON(`/api/switches/${activeId}`)
        .then((d) => { if (live) setDetail(d); })
        .catch((e) => { if (live) setError(e); });
      getJSON(`/api/switches/${activeId}/ports`)
        .then((p) => { if (live) setPorts(p); })
        .catch((e) => { if (live) setError(e); });
    };
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => { live = false; clearInterval(t); };
  }, [activeId]);

  if (error) return <ErrorMsg error={error} />;
  if (!fleet) return <Loading what="switch fleet" />;
  if (fleet.length === 0) {
    return (
      <div className="page"><h1>Switches</h1>
        <Card><div className="msg">No switches in the registry. Seed devices first (netmon-seed).</div></Card>
      </div>
    );
  }

  const sites = {};
  for (const sw of fleet) (sites[sw.site || "Unassigned"] ||= []).push(sw);
  const current = fleet.find((s) => s.id === activeId) || null;
  const stack = detail?.stack || [];
  const portName = (ifindex) => {
    const p = (ports || []).find((x) => x.ifindex === ifindex);
    return p ? (p.name || String(ifindex)) : String(ifindex ?? "—");
  };

  // Faceplate grouping + KPIs.
  const byMember = {};
  for (const p of ports || []) (byMember[p.member ?? "—"] ||= []).push(p);
  const memberKeys = Object.keys(byMember).sort((a, b) => (a === "—") - (b === "—") || a - b);
  const upCount = (ports || []).filter((p) => p.oper_state === "up").length;
  const errCount = (ports || []).reduce((n, p) => n + (p.err_in_delta || 0) + (p.err_out_delta || 0), 0);
  const maxUtil = Math.max(0, ...(ports || []).map((p) => p.util_pct || 0));
  const maxCpu = Math.max(0, ...stack.map((m) => m.cpu_pct || 0));
  const maxTemp = Math.max(0, ...stack.map((m) => m.temp_c || 0));
  const poeUsed = stack.reduce((n, m) => n + (m.poe_measured_w || 0), 0);
  const poeAvail = stack.reduce((n, m) => n + (m.poe_avail_w || 0), 0);
  const portsAge = current ? ageOf(current.ports_updated_at) : null;

  const talkers = (ports || [])
    .filter((p) => p.oper_state === "up" && ((p.in_kbps || 0) + (p.out_kbps || 0)) > 0)
    .sort((a, b) => ((b.in_kbps || 0) + (b.out_kbps || 0)) - ((a.in_kbps || 0) + (a.out_kbps || 0)))
    .slice(0, 8);

  return (
    <div className="page">
      <h1>Switches</h1>
      <div className="subtitle">
        SNMP inventory sweeps · <SourceBadge source="snmp_inventory" /> · refreshes every {REFRESH_MS / 1000}s
        {current && portsAge && <span> · port cache {portsAge} old</span>}
        {current && !current.ports_updated_at && <span style={{ color: sevColor("warn") }}> · no sweep data yet</span>}
      </div>

      <div className="sw-layout">
        <div className="sw-nav">
          {Object.entries(sites).map(([site, rows]) => (
            <div key={site} className="sw-nav-site">
              <div className="sw-nav-site-name">{site}</div>
              {rows.map((sw) => (
                <a key={sw.id}
                   className={"sw-nav-row" + (sw.id === activeId ? " active" : "")}
                   href={`#/switches/${sw.id}`} title={sw.mgmt_ip || sw.name}>
                  <span className="sw-nav-name">{sw.name}</span>
                  <span className="sw-nav-ports mono">
                    {sw.ports_total ? `${sw.ports_up}/${sw.ports_total}` : "—"}
                  </span>
                </a>
              ))}
            </div>
          ))}
        </div>

        <div className="sw-main">
          {current && (
            <div className="sw-header">
              <span className="sw-title">{current.name}</span>
              {current.mgmt_ip && <span className="pill mono">{current.mgmt_ip}</span>}
              <span className="pill">{stack.length || "?"} member(s)</span>
              <span className="pill">{upCount} up · {(ports || []).length - upCount} down · {(ports || []).length} ports</span>
              <span style={{ marginLeft: "auto" }}>
                <SshButton host={current.mgmt_ip} name={current.name} />
              </span>
            </div>
          )}

          <div className="tabs">
            {TABS.map((t) => (
              <button key={t.id} type="button"
                      className={"tab" + (tab === t.id ? " active" : "")}
                      onClick={() => setTab(t.id)}>{t.label}</button>
            ))}
          </div>

          {!current ? <Loading what="switch" /> : tab === "ports" ? (
            <React.Fragment>
              <div className="stat-row">
                <div className="stat"><div className="stat-value">{stack.length || "—"}</div><div className="stat-label">Stack members</div></div>
                <div className="stat"><div className="stat-value">{ports ? `${upCount}/${ports.length}` : "…"}</div><div className="stat-label">Active ports</div></div>
                <div className="stat">
                  <div className="stat-value" style={poeAvail && poeUsed / poeAvail >= 0.75 ? { color: sevColor("warn") } : undefined}>
                    {poeAvail ? `${poeUsed}/${poeAvail} W` : "—"}
                  </div>
                  <div className="stat-label">PoE draw / budget</div>
                </div>
                <div className="stat"><div className="stat-value">{maxUtil ? `${maxUtil}%` : "—"}</div><div className="stat-label">Top port util</div></div>
                <div className="stat"><div className="stat-value" style={errCount ? { color: sevColor("warn") } : undefined}>{errCount}</div><div className="stat-label">Errors (Δ sweep)</div></div>
                <div className="stat"><div className="stat-value">{maxCpu ? `${maxCpu}%` : "—"}</div><div className="stat-label">CPU (max slot)</div></div>
                <div className="stat"><div className="stat-value">{maxTemp ? `${maxTemp}°C` : "—"}</div><div className="stat-label">Temp (max slot)</div></div>
              </div>

              <Card kicker={ports && ports.length ? `Port faceplate · ${staleKicker(ports, "ports")}` : "Port faceplate"}>
                {!ports ? <Loading what="ports" /> : ports.length === 0 ? <EmptySweep what="port" /> : (
                  <React.Fragment>
                    <div className="swport-legend">
                      <span className="item"><span className="swatch sw-up" /> Up</span>
                      <span className="item"><span className="swatch sw-down" /> Down</span>
                      <span className="item"><span className="swatch sw-disabled" /> Disabled</span>
                      <span className="item"><span className="swatch sw-absent" /> Absent</span>
                      <span className="item"><span className="dot-led poe-led" /> PoE</span>
                      <span className="item"><span className="dot-led err-led" /> Errors</span>
                    </div>
                    {memberKeys.map((m) => (
                      <MemberGrid key={m} member={m}
                                  ports={byMember[m].sort((a, b) => portNum(a) - portNum(b))}
                                  selected={selectedPort} onSelect={setSelectedPort} />
                    ))}
                  </React.Fragment>
                )}
              </Card>

              <PortDetail switchId={activeId} ifindex={selectedPort} />

              <Card kicker="Top talkers (current rates)">
                {talkers.length === 0 ? (
                  <div className="msg">No ports with measured traffic yet — rates need two sweep samples.</div>
                ) : (
                  <table className="grid">
                    <thead><tr><th>Port</th><th>Speed</th><th>In</th><th>Out</th><th>Util</th><th>Errors Δ</th></tr></thead>
                    <tbody>
                      {talkers.map((p) => (
                        <tr key={p.ifindex} onClick={() => setSelectedPort(p.ifindex)} style={{ cursor: "pointer" }}>
                          <td className="mono">{p.name || p.ifindex}</td>
                          <td className="mono dim">{fmtSpeed(p.speed_mbps)}</td>
                          <td className="mono">{fmtRate(p.in_kbps)}</td>
                          <td className="mono">{fmtRate(p.out_kbps)}</td>
                          <td className="mono">{p.util_pct !== null && p.util_pct !== undefined ? `${p.util_pct}%` : "—"}</td>
                          <td className="mono dim">{(p.err_in_delta || 0) + (p.err_out_delta || 0)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Card>
            </React.Fragment>
          ) : tab === "fdb" ? <FdbTab switchId={activeId} portName={portName} />
            : tab === "topology" ? <TopologyTab switchId={activeId} portName={portName} />
            : tab === "vlans" ? <VlansTab switchId={activeId} />
            : tab === "stack" ? <StackTab stack={stack} />
            : tab === "poe" ? <PoeTab ports={ports} stack={stack} />
            : tab === "triggers" ? <TriggersTab switchId={activeId} />
            : <BackupsTab switchId={activeId} />}
        </div>
      </div>
    </div>
  );
}
