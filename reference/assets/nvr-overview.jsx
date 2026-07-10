// Surveillance NOC Overview dashboard widgets

// Grid thumbnails are fetched through the server-side snapshot proxy
// (zabbix.php?action=tcs.camera.snapshot), which injects the shared
// read-only camera login so the password never reaches the browser.
// JpegSize accepts S / M / L / XL or an exact "WxH"; M (352x288 CIF) keeps
// the grid light while staying legible.
const CAM_SNAPSHOT_JPEGSIZE = "M";

// Defensive defaults — if surveillance-bridge.jsx hasn't published yet
// (cache race, fetch error, …) every read here falls back to 0 / "" so
// no .toFixed / .toLocaleString throws on undefined.
const _OV_MS_DEFAULTS = {
  product: "—", version: "—", managementServer: "—",
  licenseDeviceTotal: 0, licenseDeviceUsed: 0, licenseHwTotal: 0,
  recordingServers: 0, recordingServersOnline: 0,
  failoverServers: 0, mobileServers: 0,
  smartClientSessions: 0, webClientSessions: 0,
  activeAlarms: 0, alarmsAck: 0,
  retentionDays: 0, storageTotalTB: 0, storageUsedTB: 0,
  evidenceLockSlots: 0, evidenceLockUsed: 0
};
const _OV_HISTORY_KEYS = [
  "totalIngressGbps", "storageWriteMBps", "recordingServersCpu",
  "camerasOnline", "alarmsPerHour", "archiveLagMin"
];
const _ovZ = (n) => { const a = new Array(n); for (let i = 0; i < n; i++) a[i] = 0; return a; };
const _ovHist = () => {
  const h = Object.assign({}, window.FLEET_HISTORY || {});
  for (const k of _OV_HISTORY_KEYS) if (!Array.isArray(h[k]) || !h[k].length) h[k] = _ovZ(48);
  return h;
};
const _ovNz = (v, d = 0) => (typeof v === "number" && !Number.isNaN(v) ? v : d);

const FleetWidgets = () => {
  const M = Object.assign({}, _OV_MS_DEFAULTS, window.MILESTONE || {});
  const H = _ovHist();
  const SITES   = Array.isArray(window.SITES)      ? window.SITES      : [];
  const SERVERS = Array.isArray(window.SERVERS)    ? window.SERVERS    : [];
  const CAMERAS = Array.isArray(window.CAMERAS)    ? window.CAMERAS    : [];
  const ALARMS  = Array.isArray(window.VMS_ALARMS) ? window.VMS_ALARMS : [];
  const totalCams = SITES.reduce((s, x) => s + _ovNz(x.cams), 0);
  const onlineCams = SITES.reduce((s, x) => s + _ovNz(x.online), 0);
  const warnCams = SITES.reduce((s, x) => s + _ovNz(x.warn), 0);
  const errCams = SITES.reduce((s, x) => s + _ovNz(x.err), 0);
  const licensePct = M.licenseDeviceTotal > 0 ? (M.licenseDeviceUsed / M.licenseDeviceTotal) * 100 : 0;

  // Tail-of-series helpers so spark-cells show their actual last value.
  const tail = (arr) => Array.isArray(arr) && arr.length ? arr[arr.length - 1] : 0;
  const sum  = (arr) => Array.isArray(arr) ? arr.reduce((a, b) => a + (Number(b) || 0), 0) : 0;

  // Alarm-severity breakdown from local snapshot.
  const alarmSev = ALARMS.reduce((acc, a) => {
    acc[a.sev] = (acc[a.sev] || 0) + 1; return acc;
  }, {});
  const alarmSubline = [
    alarmSev.disaster ? `${alarmSev.disaster} disaster` : null,
    alarmSev.high     ? `${alarmSev.high} high`         : null,
    alarmSev.warning  ? `${alarmSev.warning} warning`   : null,
    alarmSev.info     ? `${alarmSev.info} info`         : null
  ].filter(Boolean).join(" · ") || "no active alarms";

  return (
    <div>
      {/* TOP KPI strip */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="stat-grid">
          <div className="stat-cell">
            <div className="lbl"><Icon name="ap" size={11}/> Cameras Online <SourceBadge src="ext" /></div>
            <div className="val">{onlineCams.toLocaleString()}<span className="u">/ {totalCams.toLocaleString()}</span></div>
            <div className="sub ok">{warnCams} warn · {errCams} offline</div>
          </div>
          <div className="stat-cell">
            <div className="lbl"><Icon name="ethernet" size={11}/> Recording Servers <SourceBadge src="zbx" /></div>
            <div className="val">{M.recordingServersOnline}<span className="u">/ {M.recordingServers}{M.failoverServers > 0 ? ` +${M.failoverServers} failover` : ""}</span></div>
            <div className={"sub " + (M.recordingServers === 0 ? "" : M.recordingServersOnline === M.recordingServers ? "ok" : "warn")}>
              {M.recordingServers === 0
                ? "no recording servers discovered"
                : M.recordingServersOnline === M.recordingServers
                  ? "all online"
                  : `${M.recordingServers - M.recordingServersOnline} offline`}
            </div>
          </div>
          <div className="stat-cell">
            <div className="lbl"><Icon name="alert" size={11}/> Active VMS Alarms <SourceBadge src="ext" /></div>
            <div className="val" style={{ color: M.activeAlarms > 0 ? "var(--err)" : "var(--ok)" }}>{M.activeAlarms}<span className="u" style={{color:"var(--muted)"}}>{M.alarmsAck > 0 ? `· ${M.alarmsAck} ack` : ""}</span></div>
            <div className={"sub " + (M.activeAlarms > 0 ? "warn" : "ok")}>{alarmSubline}</div>
          </div>
          <div className="stat-cell">
            <div className="lbl"><Icon name="user" size={11}/> Smart Client Sessions <SourceBadge src="ext" /></div>
            <div className="val">{M.smartClientSessions}<span className="u">+ {M.webClientSessions} web</span></div>
            <div className="sub">{M.evidenceLockUsed} / {M.evidenceLockSlots} evidence locks active</div>
          </div>
        </div>
      </div>

      {/* MIDDLE — Milestone summary | Live ingress chart */}
      <div className="row" style={{ gridTemplateColumns: "1.1fr 1.4fr", marginBottom: 14 }}>
        <div className="card">
          <div className="card-h"><h3>Milestone XProtect</h3><SourceBadge src="ext"/><div className="h-spacer"/><span className="h-meta">{M.product}</span></div>
          <div className="card-b" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div>
              <div className="storage-bar">
                <div className="label-row"><span className="name">Device licenses</span><span className="pct">{M.licenseDeviceUsed} / {M.licenseDeviceTotal}</span></div>
                <div className="track"><div className={"fill " + (licensePct > 95 ? "warn" : "")} style={{ width: `${licensePct}%` }} /></div>
              </div>
            </div>
            <div className="kv tight" style={{ borderTop: "1px solid var(--line)" }}>
              <div className="k">Mgmt server</div><div className="v">{M.managementServer}</div><div className="b"><StatusDot state="ok"/></div>
              <div className="k">Recording srvs</div><div className="v">{M.recordingServersOnline} / {M.recordingServers} online</div><div className="b"><StatusDot state="ok"/></div>
              <div className="k">Failover srvs</div><div className="v">{M.failoverServers} standby</div><div className="b"><StatusDot state="ok"/></div>
              <div className="k">Mobile srv</div><div className="v">{M.mobileServers} · {M.smartClientSessions + M.webClientSessions} sessions</div><div className="b"><StatusDot state="ok"/></div>
              <div className="k">Retention</div><div className="v">{M.retentionDays} days standard</div><div className="b"><SourceBadge src="ext"/></div>
              <div className="k">Evidence lock</div><div className="v">{M.evidenceLockUsed} / {M.evidenceLockSlots} active</div><div className="b"><SourceBadge src="ext"/></div>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-h"><h3>Live Ingress · 24h</h3><SourceBadge src="zbx"/><div className="h-spacer"/><span className="h-meta">aggregated across {M.recordingServers} recording servers</span></div>
          <div className="bigchart">
            <FleetChart data={H.totalIngressGbps} label="Ingress" unit="Gbps" max={3} color="var(--zbx)" />
          </div>
          <div className="spark-strip" style={{ borderTop: "1px solid var(--line)" }}>
            <SparkCellM label="Storage Write" v={tail(H.storageWriteMBps)} unit="MB/s" data={H.storageWriteMBps} color="var(--info)" />
            <SparkCellM label="Avg CPU (rec srvs)" v={tail(H.recordingServersCpu)} unit="%" data={H.recordingServersCpu} color="var(--pf)" />
            <SparkCellM label="Cameras Online" v={onlineCams} unit="" data={H.camerasOnline} color="var(--ok)" />
            <SparkCellM label="Alarms / hr" v={sum(H.alarmsPerHour) > 0 ? (sum(H.alarmsPerHour) / 24).toFixed(1) : 0} unit="" data={H.alarmsPerHour} color="var(--warn)" />
          </div>
        </div>
      </div>

      {/* BOTTOM — Sites + Servers + Alarms */}
      <div className="row" style={{ gridTemplateColumns: "1fr 1fr", marginBottom: 14 }}>
        <div className="card">
          <div className="card-h"><h3>Sites</h3><SourceBadge src="ext"/><div className="h-spacer"/><span className="h-meta">click to drill into a site</span></div>
          <div>
            {SITES.map(s => {
              const pct = (s.storageGB / s.storageCapGB) * 100;
              return (
                <div className="site-row" key={s.name}>
                  <div className="site-name"><StatusDot state={s.err ? "err" : s.warn ? "warn" : "ok"}/> {s.name}</div>
                  <div className="cam-counts"><span className="ok">{s.online}</span> / {s.cams}</div>
                  <div className="cam-counts">
                    {s.warn > 0 && <span className="warn">{s.warn}w </span>}
                    {s.err > 0 && <span className="err">{s.err}e</span>}
                    {s.warn === 0 && s.err === 0 && <span className="muted">no issues</span>}
                  </div>
                  <div className="storage-bar compact">
                    <div className="label-row"><span className="name muted" style={{fontFamily:"var(--mono)", fontSize:10}}>{s.server}</span><span className="pct">{pct.toFixed(0)}%</span></div>
                    <div className="track"><div className={"fill " + (pct > 90 ? "err" : pct > 80 ? "warn" : "")} style={{ width: `${pct}%` }}/></div>
                  </div>
                  <div style={{ textAlign: "right", color: "var(--muted)" }}><Icon name="chevron" size={12}/></div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="card">
          <div className="card-h"><h3>Recording Servers</h3><SourceBadge src="zbx"/><div className="h-spacer"/><span className="h-meta">zabbix-agent2 + Milestone WMI plugin</span></div>
          <div className="stat-grid" style={{ gridTemplateColumns: "repeat(2, 1fr)" }}>
            {SERVERS.filter(s => s.role !== "Failover").slice(0, 6).map(s => (
              <ServerMini key={s.id} s={s} />
            ))}
          </div>
        </div>
      </div>

      {/* Alarm feed full width */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-h">
          <h3>Active Alarm Feed</h3>
          <SourceBadge src="ext"/>
          <div className="h-spacer"/>
          <span className="h-meta">XProtect alarms + Zabbix triggers · last 24h</span>
          <span className="h-link">Open full alarm log <Icon name="external" size={11}/></span>
        </div>
        <div>
          {ALARMS.map((a, i) => (
            <div key={i} className={"alarm-row " + (a.ack ? "ack" : "")}>
              <div className="ts">{a.ts}</div>
              <Sev level={a.sev}/>
              <div><span className={`sev-dot ${a.sev}`}/></div>
              <div className="obj" onClick={() => {
                if (a.hostid) { location.href = `zabbix.php?action=tcs.camera.view&hostid=${a.hostid}`; return; }
                if (a.cam) location.href = `zabbix.php?action=tcs.camera.view&id=${encodeURIComponent(a.cam)}`;
                if (a.srv) location.href = `zabbix.php?action=tcs.server.view&id=${encodeURIComponent(a.srv)}`;
              }}>{a.cam || a.srv}</div>
              <div className="msg">{a.msg}</div>
              <div className="site">{a.site} {a.ack && <span className="muted">· ack</span>}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Camera wall moved to the Cameras tab (with the per-group navigator). */}
    </div>
  );
};

// ───── Mini chart ─────
const FleetChart = ({ data, label, unit, color, max }) => {
  const w = 800, h = 160;
  const lo = 0, hi = max || Math.max(...data) * 1.1;
  const stepX = w / (data.length - 1);
  const pts = data.map((v, i) => [i * stepX, h - 20 - ((v - lo) / (hi - lo)) * (h - 40)]);
  const path = pts.map((p, i) => (i === 0 ? `M${p[0]},${p[1]}` : `L${p[0]},${p[1]}`)).join(" ");
  const fill = `${path} L${w},${h - 20} L0,${h - 20} Z`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      {[0.25, 0.5, 0.75].map(p => (
        <line key={p} x1="0" x2={w} y1={20 + p * (h - 40)} y2={20 + p * (h - 40)} stroke="var(--line)" strokeDasharray="3 3" strokeWidth="0.5"/>
      ))}
      <path d={fill} fill={color} opacity="0.12"/>
      <path d={path} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round"/>
      <text x="6" y="14" fontSize="10" fontFamily="var(--mono)" fill="var(--muted)">{label} · peak {Math.max(...data)}{unit}</text>
      <text x={w-6} y="14" fontSize="10" fontFamily="var(--mono)" fill="var(--muted)" textAnchor="end">{data[data.length-1]}{unit}</text>
    </svg>
  );
};

const SparkCellM = ({ label, v, unit, data, color }) => (
  <div className="spark-cell">
    <div className="lbl">{label}</div>
    <div className="val">{v}<span className="u">{unit}</span></div>
    <Sparkline data={data} color={color} width={240} height={26} />
  </div>
);

const ServerMini = ({ s }) => {
  // Combined dot precedence (worst wins): bridge-derived state covers
  // Milestone + iDRAC; the resource-usage thresholds below only matter
  // when there's no hardware-level alert already.
  const cpu  = _ovNz(s.cpu);
  const mem  = _ovNz(s.mem);
  const disk = _ovNz(s.disk);
  let dotState = s.state || "ok";
  if (dotState === "ok" && (disk > 90 || cpu > 80 || mem > 90)) dotState = "warn";
  // RAID/hardware mini-indicator next to the role chip. Hidden when
  // iDRAC hasn't reported yet (raid === "unknown") so the green dot
  // doesn't lie about untested hardware.
  const raid = s.raid;
  return (
    <a className="server-tile" href={`zabbix.php?action=tcs.server.view&hostid=${s.agentHostid || ""}`}
       style={{ textDecoration: "none", color: "inherit" }}>
      <div className="head">
        <StatusDot state={dotState} />
        <div className="id">{s.id}</div>
        <span className="role">{(s.role || "").replace(" Server", "")}</span>
        {raid && raid !== "unknown" && (
          <span className={"raid-pill " + raid}
                title={"iDRAC hardware status: " + raid}
                style={{
                  fontSize: 9, marginLeft: 6, padding: "1px 6px",
                  borderRadius: 8, fontFamily: "var(--mono)",
                  background: raid === "ok" ? "rgba(52, 211, 153, 0.15)"
                            : raid === "warn" ? "rgba(245, 179, 0, 0.18)"
                            : "rgba(255, 70, 92, 0.18)",
                  color:      raid === "ok" ? "var(--ok)"
                            : raid === "warn" ? "var(--warn)"
                            : "var(--err)"
                }}>RAID</span>
        )}
      </div>
      <div className="stats">
        <div>CPU<div className="v" style={cpu > 80 ? {color:"var(--warn)"} : {}}>{cpu}%</div></div>
        <div>Mem<div className="v" style={mem > 90 ? {color:"var(--warn)"} : {}}>{mem}%</div></div>
        <div>Disk<div className="v" style={disk > 90 ? {color:"var(--warn)"} : {}}>{disk}%</div></div>
      </div>
      <div className="meta">
        <span>{s.site}</span>
        <span>{s.model || (s.uptimeD ? `up ${s.uptimeD}d` : "—")}</span>
      </div>
    </a>
  );
};

const CamThumb = ({ c }) => {
  const now = new Date();
  const ts = now.toISOString().replace("T", " ").substr(0, 19);
  // Static snapshot for the grid, via the auth-injecting server proxy. Keyed
  // by the per-camera Zabbix hostid (the proxy resolves the IP server-side).
  const snapUrl = c.hostid
    ? `zabbix.php?action=tcs.camera.snapshot&hostid=${encodeURIComponent(c.hostid)}&size=${encodeURIComponent(CAM_SNAPSHOT_JPEGSIZE)}`
    : null;
  return (
    <a className={`cam-tile ${c.state}`} href={c.hostid ? `zabbix.php?action=tcs.camera.view&hostid=${c.hostid}` : `zabbix.php?action=tcs.camera.view&id=${encodeURIComponent(c.id)}`} style={{textDecoration:"none"}}>
      <div className="frame"/>
      {c.state !== "err" && snapUrl && (
        <img
          src={snapUrl}
          alt={`Snapshot · ${c.loc || c.id}`}
          loading="lazy"
          onError={(e) => { e.currentTarget.style.display = "none"; }}
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", pointerEvents: "none" }}
        />
      )}
      <div className="scan"/>
      <div className="id">{c.loc || c.id}</div>
      <div className="ts">{ts}</div>
    </a>
  );
};

window.FleetWidgets = FleetWidgets;
