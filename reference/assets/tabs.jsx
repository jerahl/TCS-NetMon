// Per-tab views

const SectionTitle = ({ children, src }) => (
  <h2 className="section-title">
    {children}
    {src && <SourceBadge src={src} />}
  </h2>
);

// Helpers: per-AP SNMP uplink items are in bits/sec — convert to Mbps for
// display on the Live Telemetry strip. Null-safe.
const bpsToMbps = (v) => (typeof v === "number" ? +(v / 1e6).toFixed(2) : v);
const histToMbps = (h) => Array.isArray(h) ? h.map(v => v / 1e6) : h;

// ───────── Overview tab ─────────
const OverviewTab = ({ density }) => {
  const A = window.ALERTS_SUMMARY || {};
  const I = window.ZBX_ITEMS || {};
  const host = window.ZBX_HOST || {};

  // Derive an "issue" tone from a count — anything > 0 is a warning unless
  // a separate severity hint is provided.
  const toneFor = (n, warnAt = 1, errAt = 5) =>
    n >= errAt ? "err" : n >= warnAt ? "warn" : "ok";
  const iconFor = (n) => (n > 0 ? "alert" : "check");

  const cpu     = I.cpu     || {};
  const memory  = I.memory  || {};
  const pktLoss = I.pktLoss || {};

  const totalClients = (typeof A.totalClients === "number" && A.totalClients > 0)
    ? A.totalClients : (host.clients ?? 0);

  // Packet-loss live value drives the big tile: <1% ok, <5% warn, else err.
  const lossPct = typeof pktLoss.value === "number" ? pktLoss.value : null;
  const lossEvents = typeof A.packetLoss === "number" ? A.packetLoss : 0;
  const lossTone = lossPct === null ? "muted"
                 : lossPct >= 5 ? "err"
                 : lossPct >= 1 ? "warn"
                 : "ok";

  return (
    <div className="overview">
      {/* Health rings + Connectivity issues + Excessive packet loss */}
      <div className="row" style={{ gridTemplateColumns: "1.4fr 1fr .9fr", marginBottom: 14 }}>
        <div className="card">
          <div className="card-h">
            <h3>Device Health</h3>
            <SourceBadge src="zbx" />
            <div className="h-spacer" />
            <span className="h-meta">polling every 60s · template Extreme AP via SNMPv3</span>
          </div>
          <div className="health-grid" style={{ gridTemplateColumns: "repeat(2, 1fr)" }}>
            <HealthRing
              label="CPU Usage"
              value={cpu.value}
              color={cpu.trigger != null && cpu.value > cpu.trigger ? "var(--warn)" : "var(--zbx)"}
              sub={cpu.prev != null ? `prev ${cpu.prev}%` : "no history"}
            />
            <HealthRing
              label="Memory Usage"
              value={memory.value}
              color="var(--info)"
              sub={memory.history && memory.history.length ? `peak ${Math.max(...memory.history).toFixed(0)}%` : "no history"}
            />
          </div>
        </div>

        <div className="card">
          <div className="card-h">
            <h3>Connectivity Issues</h3>
            <SourceBadge src="zbx" />
            <SourceBadge src="pf" />
            <div className="h-spacer" />
            <span className="h-meta">Total Clients: <b style={{ color: "var(--fg)" }}>{totalClients.toLocaleString()}</b></span>
          </div>
          <div className="issues">
            <Issue n={A.associationFailures ?? 0} label="Association Failures"    tone={toneFor(A.associationFailures ?? 0)} icon={iconFor(A.associationFailures ?? 0)} />
            <Issue n={A.authFailures        ?? 0} label="Authentication Failures" tone={toneFor(A.authFailures ?? 0)}        icon={iconFor(A.authFailures ?? 0)} />
            <Issue n={A.networkIssues       ?? 0} label="Network Issues"          tone={toneFor(A.networkIssues ?? 0)}       icon={iconFor(A.networkIssues ?? 0)} />
          </div>
        </div>

        <div className="card">
          <div className="card-h">
            <h3>Packet Loss</h3>
            <SourceBadge src="zbx" />
            <div className="h-spacer" />
            <span className="h-meta">ICMP · last 5m</span>
          </div>
          <div className="issues" style={{ gridTemplateColumns: "1fr" }}>
            <Issue
              n={lossPct === null ? "—" : `${lossPct.toFixed(1)}%`}
              label={lossEvents > 0 ? `${lossEvents} loss event${lossEvents === 1 ? "" : "s"} (24h)` : "Loss rate (now)"}
              tone={lossTone === "muted" ? "ok" : lossTone}
              icon={lossTone === "ok" || lossTone === "muted" ? "check" : "alert"}
              big
            />
          </div>
        </div>
      </div>

      {/* Live throughput + radios */}
      <div className="row" style={{ gridTemplateColumns: "1fr", marginBottom: 14 }}>
        <div className="card">
          <div className="card-h">
            <h3>Live Telemetry</h3>
            <SourceBadge src="zbx" />
            <div className="h-spacer" />
            <span className="h-meta">last 24h · {((I.uplinkIn && I.uplinkIn.history) || []).length} samples</span>
            <span className="h-link">Open in Grafana <Icon name="external" size={11} /></span>
          </div>
          <div className="spark-strip">
            <SparkCell label="Uplink In"  value={bpsToMbps((I.uplinkIn || {}).value)}  unit="Mbps" data={histToMbps((I.uplinkIn || {}).history)}  color="var(--zbx)" />
            <SparkCell label="Uplink Out" value={bpsToMbps((I.uplinkOut|| {}).value)}  unit="Mbps" data={histToMbps((I.uplinkOut|| {}).history)}  color="var(--info)" />
            <SparkCell label="Latency"    value={(I.latency || {}).value}              unit="ms"   data={(I.latency || {}).history}              color="var(--ok)" />
            <SparkCell label="Pkt Loss"   value={(I.pktLoss || {}).value}              unit="%"    data={(I.pktLoss || {}).history}              color="var(--warn)" />
          </div>
          <div className="spark-strip" style={{ borderTop: "1px solid var(--line)" }}>
            <SparkCell label="Noise 2.4 GHz" value={(I.noise24 || {}).value} unit="dBm" data={(I.noise24 || {}).history} color="var(--info)" />
            <SparkCell label="Noise 5 GHz"   value={(I.noise5  || {}).value} unit="dBm" data={(I.noise5  || {}).history} color="var(--info)" />
            <SparkCell label="TX Power 2.4"  value={(I.txpower24 || {}).value} unit="dBm" data={(I.txpower24 || {}).history} color="var(--pf)" />
            <SparkCell label="TX Power 5"    value={(I.txpower5  || {}).value} unit="dBm" data={(I.txpower5  || {}).history} color="var(--pf)" />
          </div>
        </div>
      </div>

      {/* System Info + Network Info */}
      <div className="row" style={{ gridTemplateColumns: "1fr 1fr", marginBottom: 14 }}>
        <div className="card">
          <div className="card-h"><h3>System Information</h3><div className="h-spacer" /><span className="h-meta">merged from Zabbix host + ExtremeCloud IQ</span></div>
          <div className="kv">
            {window.SYSTEM_INFO.map(([k, v, src]) => (
              <React.Fragment key={k}>
                <div className="k">{k}</div>
                <div className="v">{v}</div>
                <div className="b"><SourceBadge src={src} /></div>
              </React.Fragment>
            ))}
          </div>
        </div>

        <div className="card">
          <div className="card-h"><h3>Network Information</h3><div className="h-spacer" /><span className="h-meta">{(window.ZBX_HOST && window.ZBX_HOST.ip) ? `SNMPv3 · ${window.ZBX_HOST.ip}` : "SNMPv3"}</span></div>
          <div className="kv">
            {window.NETWORK_INFO.map(([k, v, src]) => (
              <React.Fragment key={k}>
                <div className="k">{k}</div>
                <div className="v">
                  {k === "Device Status"
                    ? <><StatusDot state="ok" /> {v}</>
                    : v}
                </div>
                <div className="b"><SourceBadge src={src} /></div>
              </React.Fragment>
            ))}
          </div>
        </div>
      </div>

      {/* Recent events tail */}
      <div className="card">
        <div className="card-h">
          <h3>Recent Events</h3>
          <div className="h-spacer" />
          <span className="h-meta">live merge: Zabbix triggers + PacketFence audit</span>
          <span className="h-link">Open events log <Icon name="external" size={11} /></span>
        </div>
        <div className="events">
          {window.ZBX_EVENTS.slice(0, 6).map((e, i) => (
            <div className="event" key={i}>
              <div className="ts">{e.ts}</div>
              <div className={`src ${e.source === "Zabbix" ? "zbx" : "pf"}`}>{e.source === "Zabbix" ? "ZBX" : "PF"}</div>
              <Sev level={e.severity} />
              <div className="msg">{e.msg} <span className="obj">· {e.obj}</span></div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

const HealthRing = ({ label, value, color, sub, max = 100, unit = "%" }) => {
  const missing = value === null || value === undefined || (typeof value === "number" && Number.isNaN(value));
  const v = missing ? 0 : value;
  const display = missing
    ? "—"
    : `${typeof v === "number" ? (Number.isInteger(v) ? v : v.toFixed(1)) : v}${unit === "%" ? "%" : ""}`;
  return (
    <div className="health-cell">
      <Ring value={v} max={max} color={missing ? "var(--muted)" : color} label={display} sub={unit !== "%" && !missing ? unit : null} />
      <div className="h-label">{label}</div>
      {sub && <div className="h-sub" style={{ fontSize: 10, color: "var(--muted)", marginTop: 2 }}>{sub}</div>}
    </div>
  );
};

const Issue = ({ n, label, tone, icon, big }) => (
  <div className={`issue ${tone}`}>
    <div className="ico"><Icon name={icon} size={16} /></div>
    <div className="num" style={big ? { fontSize: 22 } : {}}>{n}</div>
    <div className="lbl">{label}</div>
  </div>
);

const SparkCell = ({ label, value, unit, data, color }) => {
  const missing = value === null || value === undefined || (typeof value === "number" && Number.isNaN(value));
  const display = missing
    ? "—"
    : (typeof value === "number" ? (Number.isInteger(value) ? value : value.toFixed(2)) : value);
  const hist = Array.isArray(data) ? data : [];
  return (
    <div className="spark-cell">
      <div className="lbl">{label}</div>
      <div className="val" style={missing ? { color: "var(--muted)" } : {}}>
        {display}{!missing && <span className="u">{unit}</span>}
      </div>
      {hist.length > 0 ? (
        <Sparkline data={hist} color={color} width={240} height={30} />
      ) : (
        <div style={{ height: 30, display: "flex", alignItems: "center", color: "var(--muted)", fontSize: 10 }}>no history</div>
      )}
    </div>
  );
};

// Derive radio band from current channel number. AP305C is dual-5 GHz on
// this fleet, so we can't assume wifi0=2.4 / wifi1=5 anymore.
const deriveBand = (ch) => {
  const n = typeof ch === "number" ? ch : Number(ch);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n >= 1 && n <= 14) return "2.4 GHz";
  if (n >= 36) return "5 GHz";
  return null;
};

// ───────── Wireless tab ─────────
const WirelessTab = () => {
  const I = window.ZBX_ITEMS || {};
  // Keep the existing channel24/channel5 keys (they refer to ifIndex 12 and
  // 13, i.e. wifi0 and wifi1) but display the band derived from the live
  // channel value rather than the variable name.
  return (
    <div className="row" style={{ gridTemplateColumns: "1fr 1fr", gap: 14 }}>
      <RadioCard radioName="wifi0" channel={I.channel24} txpower={I.txpower24} noise={I.noise24} rxbytes={I.radioRx24} txbytes={I.radioTx24} />
      <RadioCard radioName="wifi1" channel={I.channel5}  txpower={I.txpower5}  noise={I.noise5}  rxbytes={I.radioRx5}  txbytes={I.radioTx5}  />
      <div className="card" style={{ gridColumn: "1 / -1" }}>
        <div className="card-h">
          <h3>SSIDs Broadcast</h3>
          <SourceBadge src="zbx" />
          <div className="h-spacer"/>
          <span className="h-meta">
            {Array.isArray(window.SSIDS) && window.SSIDS.length > 0
              ? `${window.SSIDS.length} SSIDs · LLD via Extreme AP SNMPv2c`
              : "SSID LLD has not yet discovered any subinterfaces (runs hourly)"}
          </span>
        </div>
        {Array.isArray(window.SSIDS) && window.SSIDS.length > 0 ? (
          <table className="tbl">
            <thead>
              <tr>
                <th>SSID</th>
                <th>Subinterface</th>
                <th>Band</th>
                <th>VLAN</th>
                <th>Auth</th>
                <th style={{ textAlign: "right" }}>RX</th>
                <th style={{ textAlign: "right" }}>TX</th>
              </tr>
            </thead>
            <tbody>
              {window.SSIDS.map(s => {
                const rx = s.rxMbps;
                const tx = s.txMbps;
                return (
                  <tr key={s.id || s.name}>
                    <td className="fg">{s.name}</td>
                    <td className="mono" style={{ color: "var(--muted)" }}>{s.ifname || "—"}</td>
                    <td>{s.band || "—"}</td>
                    <td>{s.vlan ?? "—"}</td>
                    <td>{s.auth ?? "—"}</td>
                    <td className="mono" style={{ textAlign: "right" }}>{rx == null ? "—" : `${rx.toFixed(2)} Mbps`}</td>
                    <td className="mono" style={{ textAlign: "right" }}>{tx == null ? "—" : `${tx.toFixed(2)} Mbps`}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <div style={{ padding: 30, textAlign: "center", color: "var(--muted)", fontSize: 12 }}>
            No SSID inventory available for this AP.
          </div>
        )}
      </div>
    </div>
  );
};

const RadioCard = ({ radioName, channel, txpower, noise, rxbytes, txbytes }) => {
  const ch = channel || {};
  const tp = txpower || {};
  const n  = noise   || {};
  const rx = rxbytes || {};
  const tx = txbytes || {};
  const band = deriveBand(ch.value);
  // Bytes/sec → Mbps for display.
  const bytesToMbps = (v) => (typeof v === "number" ? +(v * 8 / 1e6).toFixed(2) : v);
  return (
    <div className="card">
      <div className="card-h">
        <h3>Radio · {radioName}{band ? ` · ${band}` : ""}</h3>
        <SourceBadge src="zbx" />
        <div className="h-spacer" />
        <span className="h-meta">
          ch {ch.value ?? "—"} · {tp.value != null ? `${tp.value} dBm TX` : "TX —"}
        </span>
      </div>
      <div className="card-b" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <MiniMetric label="Channel"        v={ch.value}              unit=""    color="var(--pf)" />
        <MiniMetric label="TX Power"       v={tp.value}              unit="dBm" data={tp.history} color="var(--pf)" />
        <MiniMetric label="Noise Floor"    v={n.value}               unit="dBm" data={n.history}  color="var(--info)" />
        <MiniMetric label="RX Throughput"  v={bytesToMbps(rx.value)} unit="Mbps" data={(rx.history || []).map(v => v * 8 / 1e6)} color="var(--ok)" />
        <MiniMetric label="TX Throughput"  v={bytesToMbps(tx.value)} unit="Mbps" data={(tx.history || []).map(v => v * 8 / 1e6)} color="var(--zbx)" />
      </div>
    </div>
  );
};

const MiniMetric = ({ label, v, unit, data, color, threshold }) => {
  const missing = v === null || v === undefined || v === "" || (typeof v === "number" && Number.isNaN(v));
  const display = missing
    ? "—"
    : (typeof v === "number" ? (Number.isInteger(v) ? v.toString() : v.toFixed(1)) : String(v));
  return (
    <div style={{ background: "var(--bg-2)", borderRadius: 8, padding: 12, border: "1px solid var(--line)" }}>
      <div style={{ fontSize: 10, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>{label}</div>
      <div style={{ fontFamily: "var(--mono)", fontSize: 20, fontWeight: 600, color: missing ? "var(--muted)" : "var(--fg)" }}>
        {display}{!missing && <span style={{ fontSize: 11, color: "var(--muted)", marginLeft: 3 }}>{unit}</span>}
      </div>
      {data && data.length > 0 && <Sparkline data={data} color={color} width={240} height={28} threshold={threshold} />}
    </div>
  );
};

// ───────── Wired tab ─────────
const WiredTab = () => {
  const ports = Array.isArray(window.WIRED_PORTS) ? window.WIRED_PORTS : [];
  return (
    <div className="row" style={{ gridTemplateColumns: "1fr", gap: 14 }}>
      <div className="card">
        <div className="card-h">
          <h3>Wired Interfaces</h3>
          <SourceBadge src="zbx" />
          <div className="h-spacer"/>
          <span className="h-meta">{ports.length === 0 ? "no IF-MIB items for this host" : "SNMP IF-MIB · live"}</span>
        </div>
        {ports.length === 0 ? (
          <div style={{ padding: 30, textAlign: "center", color: "var(--muted)", fontSize: 12 }}>
            No wired interface data available. Confirm the host has the Extreme AP SNMPv2c template linked.
          </div>
        ) : (
          <table className="tbl">
            <thead>
              <tr><th>Port</th><th>State</th><th>Link Speed</th><th>In</th><th>Out</th><th>Errors</th><th>LLDP Neighbor</th></tr>
            </thead>
            <tbody>
              {ports.map(p => (
                <tr key={p.name}>
                  <td className="fg">{p.name}</td>
                  <td><StatusDot state={p.state}/> <span style={{textTransform:"uppercase"}}>{p.state}</span></td>
                  <td className="mono">{p.speed || "—"}</td>
                  <td className="mono">{p.in || "—"}</td>
                  <td className="mono">{p.out || "—"}</td>
                  <td className="mono">{p.err || "—"}</td>
                  <td>{p.neighbor || <span className="muted">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};

// ───────── Clients tab ─────────
// Source-agnostic: ActionDashboard prefers XIQ /clients/active (deviceIds
// = host macro {$XIQ_DEVICE_ID}) and falls back to PacketFence per-node.
// Each row carries .source so the badge reflects what actually populated it.
const ClientsTab = ({ filter, setFilter }) => {
  const all = Array.isArray(window.PF_CLIENTS) ? window.PF_CLIENTS : [];
  const authFails = Array.isArray(window.PF_AUTH_FAILS) ? window.PF_AUTH_FAILS : [];
  const [selectedMac, setSelectedMac] = React.useState(null);
  const source = (all[0] && (all[0].source === "xiq+pf")) ? "xiq+pf"
               : (all[0] && all[0].source === "xiq") ? "xiq"
               : (all[0] && all[0].source === "pf")  ? "pf"
               : "none";
  const filtered = all.filter(c => {
    const role = String(c.role ?? "");
    if (filter === "all") return true;
    if (filter === "issues") return c.posture !== "compliant" && c.posture !== "n/a";
    if (filter === "students") return role.includes("Student");
    if (filter === "faculty") return role === "Faculty";
    if (filter === "guests") return role.includes("Guest");
    return true;
  });
  const selected = selectedMac ? all.find(c => c.mac === selectedMac) : null;
  return (
    <div>
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-h">
          <h3>Connected Clients</h3>
          {(source === "xiq" || source === "xiq+pf") && <SourceBadge src="ext" />}
          {(source === "pf"  || source === "xiq+pf") && <SourceBadge src="pf"  />}
          <div className="h-spacer" />
          <span className="h-meta" style={{ marginRight: 8 }}>
            {all.length} associated{source === "xiq+pf" ? " · XIQ + PacketFence" : source === "xiq" ? " · XIQ /clients/active" : source === "pf" ? " · PacketFence" : ""}
          </span>
          <div style={{ display: "flex", gap: 4 }}>
            {[["all","All"],["issues","Issues"],["students","Students"],["faculty","Faculty"],["guests","Guests"]].map(([k,l]) =>
              <button key={k} className={`btn sm ${filter===k?"primary":"ghost"}`} onClick={()=>setFilter(k)}>{l}</button>
            )}
          </div>
        </div>
        {all.length === 0 ? (
          <div style={{ padding: 30, textAlign: "center", color: "var(--muted)", fontSize: 12 }}>
            No active clients reported for this AP.<br />
          </div>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Status</th>
                <th>MAC / Hostname</th>
                <th>User</th>
                <th>Role</th>
                <th>VLAN</th>
                <th>SSID / Auth</th>
                <th>RSSI</th>
                <th>Band</th>
                <th>OS</th>
                <th>Connected</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(c => (
                <ClientRow
                  key={c.mac || c.host}
                  c={c}
                  active={c.mac === selectedMac}
                  onClick={() => setSelectedMac(c.mac === selectedMac ? null : c.mac)}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>

      {selected && <ClientDetailCard c={selected} onClose={() => setSelectedMac(null)} />}

      <div className="card">
        <div className="card-h">
          <h3>Recent Authentication Failures</h3>
          <SourceBadge src="pf" />
          <div className="h-spacer" />
          <span className="h-meta">{authFails.length === 0 ? "no failures or PacketFence not configured" : "RADIUS audit · last 24h"}</span>
        </div>
        {authFails.length === 0 ? (
          <div style={{ padding: 24, textAlign: "center", color: "var(--muted)", fontSize: 12 }}>
            No authentication failures recorded.
          </div>
        ) : (
          <table className="tbl">
            <thead><tr><th>Time</th><th>Client MAC</th><th>SSID</th><th>Reason</th><th>Attempts</th></tr></thead>
            <tbody>
              {authFails.map((f, i) => (
                <tr key={i}>
                  <td>{f.ts}</td>
                  <td className="fg">{f.mac}</td>
                  <td>{f.ssid}</td>
                  <td style={{ color: "var(--warn)" }}>{f.reason}</td>
                  <td>{f.attempts}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};

const roleClassFor = (role) => {
  const r = String(role ?? "");
  if (r === "Faculty") return "faculty";
  if (r.startsWith("Student-9-12")) return "student";
  if (r === "Student-BYOD") return "byod";
  if (r.includes("Guest")) return "guest";
  if (r === "AV-Equipment") return "av";
  if (r === "Quarantine") return "quarantine";
  return "unknown";
};

const ClientRow = ({ c, active, onClick }) => {
  const role = String(c.role ?? "");
  const rssi = typeof c.rssi === "number" && c.rssi !== 0 ? c.rssi : null;
  const bars = rssi == null ? 0 : rssi >= -55 ? 4 : rssi >= -65 ? 3 : rssi >= -75 ? 2 : 1;
  return (
    <tr
      onClick={onClick}
      style={{
        cursor: "pointer",
        background: active ? "rgba(95,168,211,0.10)" : undefined,
        boxShadow: active ? "inset 3px 0 0 var(--zbx)" : undefined
      }}
    >
      <td><StatusDot state={c.posture || "n/a"} /></td>
      <td><div className="fg">{c.host || c.mac}</div><div style={{ color: "var(--muted)", fontSize: 10.5 }}>{c.mac}</div></td>
      <td>{c.user || "—"}</td>
      <td><span className={`role-tag ${roleClassFor(role)}`}>{role || "—"}</span></td>
      <td>{c.vlan || "—"}</td>
      <td>{c.ssid || "—"}<div style={{ color: "var(--muted)", fontSize: 10.5 }}>{c.auth || ""}</div></td>
      <td>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="rssi-bar">
            {[1,2,3,4].map(n => <i key={n} className={n <= bars ? "on" : ""} />)}
          </span>
          {rssi == null ? "—" : `${rssi} dBm`}
        </div>
      </td>
      <td>{c.band || "—"}</td>
      <td>{c.os || "—"}</td>
      <td>{c.since || "—"}</td>
      <td><Icon name={active ? "chevron" : "more"} size={14}/></td>
    </tr>
  );
};

// Detail card surfaced when a client row is selected. Mirrors the
// switch tab's PacketFenceDevicePane shape so the two screens feel
// consistent: identity strip, KV grid of PF + XIQ fields, then the
// locationlog row at the bottom.
const ClientDetailCard = ({ c, onClose }) => {
  const pf  = c.pf  || {};
  const loc = c.pfLoc || {};
  const reg = (pf.reg || (c.posture === "compliant" ? "REG" : c.posture === "non-compliant" ? "UNREG" : "")).toUpperCase();
  const role = String(c.role ?? "");
  const sourceLabel = c.source === "xiq+pf" ? "XIQ + PacketFence"
                    : c.source === "xiq"    ? "XIQ only"
                    : c.source === "pf"     ? "PacketFence only"
                    : "—";
  return (
    <div className="card" style={{ marginTop: 14 }}>
      <div className="card-h">
        <h3>Client Detail</h3>
        {(c.source === "xiq" || c.source === "xiq+pf") && <SourceBadge src="ext" />}
        {(c.source === "pf"  || c.source === "xiq+pf") && <SourceBadge src="pf"  />}
        <div className="h-spacer" />
        <span className="h-meta" style={{ marginRight: 8 }}>{sourceLabel}</span>
        <button className="btn sm ghost" onClick={onClose}>Close</button>
      </div>
      <div className="card-b">
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
          <div className="mono" style={{ fontSize: 14, fontWeight: 600 }}>{c.mac}</div>
          {reg && (
            <span className={"reg-badge " + (reg === "REG" ? "reg" : "unreg")} style={{ fontSize: 10, padding: "1px 8px", border: "1px solid", borderRadius: 3 }}>
              {reg}
            </span>
          )}
          <span className={`role-tag ${roleClassFor(role)}`}>{role || "—"}</span>
          <StatusDot state={c.posture || "n/a"} />
          <span style={{ fontSize: 11, color: "var(--muted)" }}>{c.posture || "n/a"}</span>
        </div>

        <div className="kv" style={{ gridTemplateColumns: "120px 1fr 120px 1fr", rowGap: 0 }}>
          <div className="k">Hostname</div>     <div className="v">{c.host || pf.host || "—"}</div>
          <div className="k">IP address</div>   <div className="v mono">{pf.ip || "—"}</div>

          <div className="k">User</div>         <div className="v">{c.user || "—"}</div>
          <div className="k">Owner (PF pid)</div><div className="v">{pf.owner || "—"}</div>

          <div className="k">SSID</div>         <div className="v">{c.ssid || "—"}</div>
          <div className="k">VLAN</div>         <div className="v mono">{c.vlan || loc.vlan || "—"}</div>

          <div className="k">Protocol</div>     <div className="v mono">{c.auth || "—"}</div>
          <div className="k">Band</div>         <div className="v mono">{c.band || "—"}</div>

          <div className="k">RSSI</div>         <div className="v mono">{typeof c.rssi === "number" && c.rssi !== 0 ? `${c.rssi} dBm` : "—"}</div>
          <div className="k">Connected</div>    <div className="v mono">{c.since || "—"}</div>

          <div className="k">OS</div>           <div className="v">{c.os || pf.os || "—"}</div>
          <div className="k">Vendor</div>       <div className="v">{pf.vendor || "—"}</div>

          <div className="k">DHCP fingerprint</div><div className="v" style={{ fontSize: 11 }}>{pf.dhcpFp || "—"}</div>
          <div className="k">Last seen</div>    <div className="v mono">{pf.lastSeen || "—"}</div>

          <div className="k">Last ARP</div>     <div className="v mono">{pf.lastArp || "—"}</div>
          <div className="k">Last DHCP</div>    <div className="v mono">{pf.lastDhcp || "—"}</div>
        </div>

        {(loc.switch || loc.port || loc.connection_type || loc.dot1x_username) && (
          <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--line)" }}>
            <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 0.6, color: "var(--muted)", marginBottom: 8 }}>
              PacketFence locationlog (latest)
            </div>
            <div className="kv" style={{ gridTemplateColumns: "120px 1fr 120px 1fr", rowGap: 0 }}>
              <div className="k">Switch / AP</div>      <div className="v mono">{loc.switch || "—"} {loc.switch_ip && <span style={{ color: "var(--muted)" }}>· {loc.switch_ip}</span>}</div>
              <div className="k">Port / ifDesc</div>    <div className="v mono">{loc.port || loc.ifDesc || "—"}</div>
              <div className="k">Connection</div>       <div className="v">{loc.connection_type || "—"}{loc.connection_sub_type ? ` · ${loc.connection_sub_type}` : ""}</div>
              <div className="k">802.1X user</div>      <div className="v">{loc.dot1x_username || "—"}{loc.realm ? `@${loc.realm}` : ""}</div>
              <div className="k">Session start</div>    <div className="v mono">{loc.start_time || "—"}</div>
              <div className="k">Session end</div>      <div className="v mono">{loc.end_time || "—"}</div>
            </div>
          </div>
        )}

        <ClientPfActionRow mac={c.mac} hasPf={!!c.pf} />
      </div>
    </div>
  );
};

// Per-client PF write-actions — "View in PacketFence" + "Reevaluate
// access". Mirrors switches-widgets' PfActionRow but skipped the
// switchport-restart button since it doesn't apply to wireless.
const ClientPfActionRow = ({ mac, hasPf }) => {
  const [busy, setBusy] = React.useState(null);
  const [msg,  setMsg]  = React.useState({ kind: "", text: "" });
  // PF stores and matches MACs in lowercase — both the admin UI route
  // and the API endpoints normalise to lowercase, but several PF versions
  // 404 on uppercase MAC paths instead of redirecting. Lower-case here
  // and at every call site to keep behaviour consistent across versions.
  const pfMac = String(mac || "").toLowerCase();
  const adminBase = (window.PF_ADMIN_BASE || "").replace(/\/+$/, "");
  const viewHref = adminBase && pfMac
    ? `${adminBase}/admin/#/node/${encodeURIComponent(pfMac)}`
    : null;

  const run = React.useCallback(async (op, label) => {
    if (!pfMac || busy) return;
    if (typeof window.tcsPfDeviceAction !== "function") {
      setMsg({ kind: "err", text: "endpoint missing" });
      return;
    }
    setBusy(op);
    setMsg({ kind: "", text: `${label}…` });
    const r = await window.tcsPfDeviceAction(pfMac, op);
    setBusy(null);
    setMsg(r && r.ok
      ? { kind: "", text: r.message || "ok" }
      : { kind: "err", text: (r && (r.error || r.message)) || "failed" });
    setTimeout(() => setMsg({ kind: "", text: "" }), 6000);
  }, [pfMac, busy]);

  return (
    <div className="pf-actions" style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--line)" }}>
      {viewHref ? (
        <a className="pf-btn" href={viewHref} target="_blank" rel="noopener noreferrer">
          <Icon name="external" size={11}/> View in PacketFence
        </a>
      ) : (
        <span className="pf-btn" style={{ opacity: 0.4, cursor: "not-allowed" }} title="Set global macro {$PF.ADMIN_URL} to enable">
          View in PacketFence
        </span>
      )}
      <button
        type="button"
        className="pf-btn"
        onClick={() => run("reevaluate_access", "reevaluating")}
        disabled={!!busy || !hasPf}
        title={hasPf
          ? "Re-run PF role / access evaluation for this client (issues a CoA)"
          : "Client not registered in PacketFence"}
      >
        <Icon name="refresh" size={11}/> {busy === "reevaluate_access" ? "REEVALUATING…" : "Reevaluate access"}
      </button>
      {msg.text && <span className={"pf-msg" + (msg.kind === "err" ? " err" : "")}>{msg.text}</span>}
    </div>
  );
};

// ───────── Events tab ─────────
const EventsTab = () => {
  const all = Array.isArray(window.ZBX_EVENTS) ? window.ZBX_EVENTS : [];
  const [filter, setFilter] = React.useState("all");
  const [src,    setSrc]    = React.useState("all");

  const filtered = all.filter(e => {
    if (filter === "problems" && e.value !== 1) return false;
    if (filter === "resolved" && e.value !== 0) return false;
    if (filter === "unacked"  && (e.value !== 1 || e.acked)) return false;
    if (src === "zbx" && e.source !== "Zabbix") return false;
    if (src === "xiq" && e.source !== "XIQ")    return false;
    if (src === "pf"  && e.source !== "PF")     return false;
    return true;
  });

  const counts = {
    problems: all.filter(e => e.value === 1).length,
    resolved: all.filter(e => e.value === 0).length,
    unacked:  all.filter(e => e.value === 1 && !e.acked).length
  };

  return (
    <div className="card">
      <div className="card-h">
        <h3>All Events</h3>
        <SourceBadge src="zbx" />
        <SourceBadge src="ext" />
        <SourceBadge src="pf" />
        <div className="h-spacer" />
        <span className="h-meta" style={{ marginRight: 12 }}>
          {all.length} total · {counts.problems} open · {counts.unacked} unacked
        </span>
        <div style={{ display: "flex", gap: 4 }}>
          {[
            ["all",      `All ${all.length}`],
            ["problems", `Open ${counts.problems}`],
            ["unacked",  `Unacked ${counts.unacked}`],
            ["resolved", `Resolved ${counts.resolved}`]
          ].map(([k, l]) => (
            <button key={k} className={`btn sm ${filter === k ? "primary" : "ghost"}`} onClick={() => setFilter(k)}>{l}</button>
          ))}
          <span style={{ width: 8 }} />
          {[["all", "All"], ["zbx", "ZBX"], ["xiq", "XIQ"], ["pf", "PF"]].map(([k, l]) => (
            <button key={k} className={`btn sm ${src === k ? "primary" : "ghost"}`} onClick={() => setSrc(k)}>{l}</button>
          ))}
        </div>
      </div>
      {filtered.length === 0 ? (
        <div style={{ padding: 30, textAlign: "center", color: "var(--muted)", fontSize: 12 }}>
          {all.length === 0
            ? "No events recorded for this host."
            : "No events match the current filters."}
        </div>
      ) : (
        <div className="events">
          {filtered.map((e) => (
            <div className="event" key={e.eventid}>
              <div className="ts" title={`${e.date} ${e.ts}`}>
                {e.today ? e.ts : <>{e.date}<br/><span style={{ color: "var(--muted)", fontSize: 10 }}>{e.ts}</span></>}
              </div>
              <div className={`src ${e.source === "Zabbix" ? "zbx" : e.source === "XIQ" ? "ext" : "pf"}`}>
                {e.source === "Zabbix" ? "ZBX" : e.source === "XIQ" ? "XIQ" : "PF"}
              </div>
              <Sev level={e.severity} />
              <div className="msg">
                <span style={{ color: e.value === 0 ? "var(--ok)" : "var(--fg)" }}>{e.msg}</span>
                {e.obj && <span className="obj"> · {e.obj}</span>}
                {e.value === 0 && <span className="role-tag faculty" style={{ marginLeft: 8, fontSize: 9, padding: "0 6px" }}>RESOLVED</span>}
                {e.value === 1 && e.acked  && <span className="role-tag av"      style={{ marginLeft: 8, fontSize: 9, padding: "0 6px" }}>ACKED</span>}
                {e.value === 1 && !e.acked && <span className="role-tag guest"   style={{ marginLeft: 8, fontSize: 9, padding: "0 6px" }}>OPEN</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// ───────── Alerts tab ─────────
const AlertsTab = () => {
  const A = window.ALERTS_DETAIL || { activeTriggers: [], triggerCount: 0, last24h: { count: 0, bySeverity: {} }, lastFiredAgo: null };
  const active = Array.isArray(A.activeTriggers) ? A.activeTriggers : [];
  const sev = A.last24h && A.last24h.bySeverity ? A.last24h.bySeverity : {};
  const totalLast24h = (A.last24h && A.last24h.count) || 0;
  const maxBar = Math.max(1, sev.disaster || 0, sev.high || 0, sev.warning || 0, sev.info || 0);

  return (
    <div className="row" style={{ gridTemplateColumns: "1.4fr 1fr", gap: 14 }}>
      <div className="card">
        <div className="card-h">
          <h3>Active Triggers</h3>
          <SourceBadge src="zbx" />
          <div className="h-spacer" />
          <span className="h-meta">
            {active.length === 0
              ? `0 firing · ${A.triggerCount} monitored${A.lastFiredAgo ? ` · last fired ${A.lastFiredAgo} ago` : ""}`
              : `${active.length} firing · ${A.triggerCount} monitored`}
          </span>
        </div>
        {active.length === 0 ? (
          <div style={{ padding: 30, textAlign: "center", color: "var(--muted)" }}>
            <Icon name="check" size={32} />
            <div style={{ marginTop: 8, fontSize: 14, color: "var(--ok)" }}>No active Zabbix triggers</div>
            <div style={{ fontSize: 11, marginTop: 4 }}>
              {A.triggerCount > 0 ? `${A.triggerCount} triggers monitored` : "No triggers linked to this host"}
              {A.lastFiredAgo ? ` · last fired ${A.lastFiredAgo} ago` : ""}
            </div>
          </div>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ width: 90 }}>Severity</th>
                <th>Trigger</th>
                <th style={{ width: 90 }}>Age</th>
                <th style={{ width: 80, textAlign: "right" }}>State</th>
              </tr>
            </thead>
            <tbody>
              {active.map(t => (
                <tr key={t.id}>
                  <td><Sev level={t.severity} /></td>
                  <td className="fg">
                    {t.name}
                    {t.scope && <div style={{ color: "var(--muted)", fontSize: 10.5 }}>scope · {t.scope}</div>}
                  </td>
                  <td className="mono">{t.age}</td>
                  <td style={{ textAlign: "right" }}>
                    {t.ack
                      ? <span className="role-tag av" style={{ fontSize: 9, padding: "0 6px" }}>ACKED</span>
                      : <span className="role-tag guest" style={{ fontSize: 9, padding: "0 6px" }}>OPEN</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <div className="card-h">
          <h3>24h Alert Volume</h3>
          <SourceBadge src="zbx" />
          <div className="h-spacer" />
          <span className="h-meta">{totalLast24h} problem events</span>
        </div>
        <div className="card-b" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {[
            ["disaster", "Disaster", "var(--err)"],
            ["high",     "High",     "var(--err)"],
            ["warning",  "Warning",  "var(--warn)"],
            ["info",     "Info",     "var(--info)"]
          ].map(([k, label, color]) => {
            const n = sev[k] || 0;
            return (
              <div key={k} style={{ display: "grid", gridTemplateColumns: "80px 1fr 40px", alignItems: "center", gap: 10 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11 }}>
                  <Sev level={k} />
                  <span>{label}</span>
                </div>
                <div style={{ background: "var(--bg-2)", border: "1px solid var(--line)", borderRadius: 4, height: 10, overflow: "hidden" }}>
                  <div style={{ width: `${(n / maxBar) * 100}%`, height: "100%", background: color }} />
                </div>
                <div className="mono" style={{ textAlign: "right", fontSize: 12, color: n > 0 ? "var(--fg)" : "var(--muted)" }}>{n}</div>
              </div>
            );
          })}
          {totalLast24h === 0 && (
            <div style={{ color: "var(--muted)", fontSize: 11, textAlign: "center", paddingTop: 6 }}>
              No problem events recorded for this host in the last 24 hours.
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

window.OverviewTab = OverviewTab;
window.WirelessTab = WirelessTab;
window.WiredTab = WiredTab;
window.ClientsTab = ClientsTab;
window.EventsTab = EventsTab;
window.AlertsTab = AlertsTab;
