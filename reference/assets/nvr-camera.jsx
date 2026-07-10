// Camera detail panel — single camera deep dive

// Resolve the camera the page is about. The live Surveillance tiles/rows
// link by &hostid=<perCameraZabbixHost>; older links pass ?id=<camId>.
// camera-bridge.jsx publishes the server-resolved camera as CAMERAS[0].
const resolveCamera = () => {
  const params = new URLSearchParams(location.search);
  const hostid = params.get("hostid");
  const id     = params.get("id");
  const cams   = window.CAMERAS || [];
  if (hostid) { const m = cams.find(c => String(c.hostid) === hostid); if (m) return m; }
  if (id)     { const m = cams.find(c => c.id === id);                 if (m) return m; }
  return cams[0] || null;
};

const CameraDetailEmpty = () => (
  <div className="app">
    <NVRSidebar active="nvr-cameras" />
    <div className="main">
      <NVRTopbar crumb={["Surveillance", "Cameras", "—"]} />
      <div className="body">
        <div className="card" style={{ padding: 40, textAlign: "center", color: "var(--muted)" }}>
          <h3 style={{ marginBottom: 8 }}>Camera not found</h3>
          <div style={{ fontSize: 13 }}>
            No live camera matched this link. It may not be discovered in Zabbix yet,
            or the host id is stale. <a className="cam-id-link" href="zabbix.php?action=tcs.surveillance.view&view=cameras">Back to cameras</a>
          </div>
        </div>
      </div>
    </div>
  </div>
);

const CameraDetail = () => {
  const cam = resolveCamera();
  const [tab, setTab] = React.useState("overview");
  if (!cam) return <CameraDetailEmpty />;

  const camName = cam.name || cam.id;
  const hasIp = cam.ip && cam.ip !== "—";
  // Direct camera live page — opened in a new tab (the camera login is
  // prompted by the browser). Not embedded: it needs auth the iframe can't
  // carry, so live stays a click-out and the page shows stills inline.
  const liveUrl = hasIp
    ? `https://${cam.ip}/fullscreen.htm?line=1&stream=1&vport=2&autoresize=false&keepaspect=true&dewarp=false`
    : null;
  // Still image via the server-side proxy (injects the shared read-only
  // login; keeps the password off the browser). Templated by hostid; size
  // S / M / L / XL or an exact "WxH".
  const snapUrl = cam.hostid
    ? `zabbix.php?action=tcs.camera.snapshot&hostid=${encodeURIComponent(cam.hostid)}&size=L`
    : null;

  const H = window.CAM_HISTORY || {};
  const liveEvents = window.CAM_EVENTS || [];

  const show   = (...tabs) => tabs.includes(tab);
  const lastOf = (a) => (Array.isArray(a) && a.length ? a[a.length - 1] : 0);
  const fmt    = (v) => (typeof v === "number" ? (Number.isInteger(v) ? v : v.toFixed(1)) : v);

  const isErr = cam.state === "err";
  const isWarn = cam.state === "warn";
  const stateLabel = isErr ? "Offline" : isWarn ? "Warning" : "Streaming";
  const stateColor = isErr ? "var(--err)" : isWarn ? "var(--warn)" : "var(--ok)";

  const now = new Date();
  const ts = now.toISOString().replace("T", " ").substr(0, 19);

  return (
    <div className="app">
      <NVRSidebar active="nvr-cameras" />
      <div className="main">
        <NVRTopbar crumb={["Surveillance", "Cameras", cam.site, camName]} />

        <div className="page-header">
          <div className="icon-btn" style={{ marginTop: 4 }} onClick={() => history.back()}><Icon name="back" /></div>
          <div style={{ flex: 1 }}>
            <div className="host-title">
              <h1>{camName}</h1>
              <span className="ip">{cam.ip}</span>
              <span className="role-tag faculty" style={{ fontSize: 10, padding: "1px 8px" }}>{cam.model}</span>
            </div>
            <div className="host-meta">
              <span className="pill"><span className="dot" style={{ background: stateColor }} /> {stateLabel}</span>
              <span className="pill"><span className="lbl">Site</span> <span>{cam.site} · {cam.loc}</span></span>
              <span className="pill"><span className="lbl">Recording</span> <span className="v">{cam.recording}</span></span>
              <span className="pill"><span className="lbl">Server</span> {cam.server&&cam.server!=="—"?<a className="cam-id-link" href={`zabbix.php?action=tcs.server.view&id=${encodeURIComponent(cam.server)}`}>{cam.server}</a>:<span className="v">—</span>}</span>
              <span className="pill"><span className="lbl">MAC</span> <span className="v">{cam.mac}</span></span>
            </div>
          </div>
          <div className="timerange"><Icon name="calendar" /><span className="range-val">last 24h</span><Icon name="chevron" /></div>
        </div>

        <div className="tabs">
          {[["overview","Overview"],["live","Live"],["events","Events"],["config","Configuration"]].map(([k,l]) =>
            <div key={k} className={"tab " + (tab===k?"active":"")} onClick={()=>setTab(k)}>{l}</div>
          )}
        </div>

        <div className="body" data-screen-label={`Camera · ${camName}`}>
          <DemoBanner name="Camera Detail" />
          <div style={{ display: "grid", gridTemplateColumns: "320px 1fr", gap: 14 }}>
            {/* Sidecar */}
            <div className="card">
              <div className="device-hero" style={{padding:14}}>
                <div className="status-line"><StatusDot state={cam.state==="err"?"err":cam.state==="warn"?"warn":"ok"}/> <span style={{color:stateColor}}>{stateLabel}</span></div>
                <div className="live-large" style={{ width: "100%", marginTop: 12 }}>
                  <div className="frame"/><div className="scan"/>
                  {!isErr && snapUrl && (
                    <img
                      src={snapUrl}
                      alt={`Snapshot · ${camName}`}
                      onError={(e) => { e.currentTarget.style.display = "none"; }}
                      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
                    />
                  )}
                  {!isErr ? <>
                    <div style={{position:"absolute",top:8,left:10,fontFamily:"var(--mono)",fontSize:10,color:"#fff"}}>{camName}</div>
                    <div style={{position:"absolute",top:8,right:10,fontFamily:"var(--mono)",fontSize:10,color:"rgba(255,255,255,0.85)"}}>{ts}</div>
                    {(cam.res!=="—"||cam.fps||cam.codec!=="—") && <div style={{position:"absolute",bottom:8,left:10,fontFamily:"var(--mono)",fontSize:10,color:"rgba(255,255,255,0.85)"}}>{[cam.res!=="—"?cam.res:null,cam.fps?`${cam.fps}fps`:null,cam.codec!=="—"?cam.codec:null].filter(Boolean).join(" · ")}</div>}
                    <div style={{position:"absolute",bottom:8,right:10,display:"flex",alignItems:"center",gap:4,fontFamily:"var(--mono)",fontSize:10,color:"#fff"}}>
                      <span style={{width:7,height:7,borderRadius:50,background:"var(--err)",animation:"blink 1.4s infinite",boxShadow:"0 0 6px var(--err)"}}/> REC
                    </div>
                  </> : (
                    <div style={{position:"absolute",inset:0,display:"grid",placeItems:"center",color:"var(--err)",fontFamily:"var(--mono)",letterSpacing:2,fontWeight:600}}>NO SIGNAL</div>
                  )}
                </div>
                <div style={{ display: "flex", gap: 6, marginTop: 10, width: "100%" }}>
                  <button className="btn primary" style={{flex:1}}><Icon name="external" size={12}/> Smart Client</button>
                  <button className="btn" style={{flex:1}}><Icon name="refresh" size={12}/> Restart Stream</button>
                </div>
              </div>

              <div className="location-block">
                <div className="label">Location</div>
                <div className="v">{cam.site}<br/>{cam.loc}</div>
              </div>
              <div className="location-block">
                <div className="label">Hardware</div>
                <div className="v">
                  <div>{cam.model}</div>
                  <div className="muted" style={{fontSize:11}}>MAC {cam.mac}</div>
                  <div className="muted" style={{fontSize:11}}>PoE draw {cam.poe?`${cam.poe} W`:"—"}</div>
                </div>
              </div>
              <div className="location-block">
                <div className="label">Recording Server</div>
                <div className="v" style={{fontSize:11}}>{cam.server}</div>
              </div>
            </div>

            {/* Right column — content switches with the active tab */}
            <div>
              {/* Active issue — always shown when present, regardless of tab */}
              {(isErr || isWarn) && (
                <div className="card" style={{ marginBottom: 14, borderColor: isErr ? "rgba(242,95,92,0.5)" : "rgba(245,179,0,0.5)" }}>
                  <div className="card-h">
                    <h3 style={{ color: isErr ? "var(--err)" : "var(--warn)" }}>Active Issue</h3>
                    <SourceBadge src="zbx" />
                    <div className="h-spacer"/>
                    <button className="btn sm">Acknowledge</button>
                  </div>
                  <div style={{ padding: 14, fontSize: 13 }}>
                    {cam.errMsg || cam.warnMsg || "—"}
                  </div>
                </div>
              )}

              {/* Health rings — Overview, Live */}
              {show("overview", "live") && (
              <div className="card" style={{ marginBottom: 14 }}>
                <div className="card-h"><h3>Device Health</h3><SourceBadge src="zbx"/><div className="h-spacer"/><span className="h-meta">poll · 60s · SNMP + ICMP</span></div>
                <div className="health-grid">
                  <div className="health-cell">
                    <Ring value={isErr?0:lastOf(H.cpu)} max={100} label={lastOf(H.cpu)?fmt(lastOf(H.cpu)):"—"} sub="%" color="var(--zbx)"/>
                    <div className="h-label">CPU</div>
                  </div>
                  <div className="health-cell">
                    <Ring value={isErr?0:lastOf(H.mem)} max={100} label={lastOf(H.mem)?fmt(lastOf(H.mem)):"—"} sub="%" color="var(--info)"/>
                    <div className="h-label">Memory</div>
                  </div>
                  <div className="health-cell">
                    <Ring value={lastOf(H.latency)} max={100} label={H.latency&&H.latency.length?fmt(lastOf(H.latency)):"—"} sub="ms" color="var(--zbx)"/>
                    <div className="h-label">ICMP Latency</div>
                  </div>
                  <div className="health-cell">
                    <Ring value={lastOf(H.packetLoss)} max={100} label={H.packetLoss&&H.packetLoss.length?fmt(lastOf(H.packetLoss)):"—"} sub="%" color={lastOf(H.packetLoss)>1?"var(--warn)":"var(--ok)"}/>
                    <div className="h-label">Packet Loss</div>
                  </div>
                </div>
              </div>
              )}

              {/* Live telemetry — Overview */}
              {show("overview") && (
              <div className="card" style={{ marginBottom: 14 }}>
                <div className="card-h"><h3>Live Telemetry · 24h</h3><SourceBadge src="zbx"/><div className="h-spacer"/><span className="h-meta">48 samples · 30m bucket</span></div>
                <div className="spark-strip">
                  <SparkCellM label="CPU" v={lastOf(H.cpu)?fmt(lastOf(H.cpu)):"—"} unit="%" data={H.cpu} color="var(--zbx)" />
                  <SparkCellM label="MEM" v={lastOf(H.mem)?fmt(lastOf(H.mem)):"—"} unit="%" data={H.mem} color="var(--info)" />
                  <SparkCellM label="Pkt Loss" v={H.packetLoss&&H.packetLoss.length?fmt(lastOf(H.packetLoss)):"—"} unit="%" data={H.packetLoss} color="var(--warn)" />
                  <SparkCellM label="ICMP Latency" v={H.latency&&H.latency.length?fmt(lastOf(H.latency)):"—"} unit="ms" data={H.latency} color="var(--zbx)" />
                </div>
              </div>
              )}

              {/* Stream configuration — Live, Configuration */}
              {show("live", "config") && (
              <div className="card" style={{ marginBottom: 14 }}>
                <div className="card-h"><h3>Stream Configuration</h3><SourceBadge src="ext"/></div>
                <div className="kv tight">
                  <div className="k">Codec</div><div className="v">{cam.codec}</div><div className="b"><SourceBadge src="ext"/></div>
                  <div className="k">Resolution</div><div className="v">{cam.res}</div><div className="b"><SourceBadge src="ext"/></div>
                  <div className="k">FPS</div><div className="v">{cam.fps||"—"}</div><div className="b"><SourceBadge src="ext"/></div>
                  <div className="k">Bitrate</div><div className="v">{cam.bitrate?`${(cam.bitrate/1000).toFixed(1)} Mbps`:"—"}</div><div className="b"><SourceBadge src="ext"/></div>
                  <div className="k">Recording mode</div><div className="v">{cam.recording}</div><div className="b"><SourceBadge src="ext"/></div>
                  <div className="k">Stream URL</div><div className="v" style={{fontSize:10}}>{liveUrl?<a className="cam-id-link" href={liveUrl} target="_blank" rel="noreferrer">{liveUrl}</a>:"—"}</div><div className="b"><SourceBadge src="ext"/></div>
                </div>
              </div>
              )}

              {/* Network + identity — Configuration */}
              {show("config") && (
              <div className="card" style={{ marginBottom: 14 }}>
                <div className="card-h"><h3>Network & Identity</h3><SourceBadge src="zbx"/></div>
                <div className="kv">
                  <div className="k">IPv4</div><div className="v">{cam.ip}</div><div className="b"><SourceBadge src="zbx"/></div>
                  <div className="k">MAC</div><div className="v">{cam.mac}</div><div className="b"><SourceBadge src="zbx"/></div>
                  <div className="k">Model</div><div className="v">{cam.model}</div><div className="b"><SourceBadge src="zbx"/></div>
                  <div className="k">PoE draw</div><div className="v">{cam.poe?`${cam.poe} W`:"—"}</div><div className="b"><SourceBadge src="zbx"/></div>
                  <div className="k">Recording server</div><div className="v">{cam.server}</div><div className="b"><SourceBadge src="ext"/></div>
                </div>
              </div>
              )}

              {/* PacketFence & Uplink — Overview, Configuration */}
              {show("overview", "config") && <CameraPfPanel cam={cam} />}

              {/* Live preview note — Live */}
              {show("live") && (
              <div className="card" style={{ marginBottom: 14 }}>
                <div className="card-h"><h3>Live View</h3><SourceBadge src="ext"/><div className="h-spacer"/>{liveUrl && <a className="cam-id-link" href={liveUrl} target="_blank" rel="noreferrer">Open live stream <Icon name="external" size={11}/></a>}</div>
                {!isErr && snapUrl ? (
                  <>
                    <div className="live-large" style={{ width: "100%" }}>
                      <img src={snapUrl} alt={`Snapshot · ${camName}`} onError={(e)=>{e.currentTarget.style.display="none";}} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} />
                    </div>
                    <div style={{ padding: 12, fontSize: 12, color: "var(--muted)" }}>
                      Still image, refreshed on load. The live video stream opens in the camera's
                      own player via <strong>Open live stream</strong> (you'll be prompted to log in).
                    </div>
                  </>
                ) : (
                  <div style={{ padding: 14, fontSize: 13, color: "var(--muted)" }}>
                    {isErr
                      ? "Camera is offline — no snapshot available."
                      : "No IP address discovered for this camera. Use the Milestone Smart Client to view it."}
                  </div>
                )}
              </div>
              )}

              {/* Recent events — Overview, Events */}
              {show("overview", "events") && (
              <div className="card">
                <div className="card-h"><h3>Recent Events</h3><SourceBadge src="zbx"/><div className="h-spacer"/><span className="h-meta">Open Zabbix problems · this camera</span></div>
                <div className="events">
                  {liveEvents.length
                    ? liveEvents.map((e, i) => <CamEvent key={i} ts={e.ts} src={e.src} sev={e.sev} msg={e.msg} />)
                    : <div style={{ padding: 18, textAlign: "center", color: "var(--muted)", fontSize: 13 }}>No open problems on this camera.</div>}
                </div>
              </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

const CamEvent = ({ ts, src, sev, msg }) => (
  <div className="event">
    <div className="ts">{ts}</div>
    <div className={`src ${src === "ZBX" ? "zbx" : "pf"}`}>{src}</div>
    <Sev level={sev} />
    <div className="msg">{msg}</div>
  </div>
);

// PacketFence + Uplink card. Mirrors the switches port-detail PF pane and
// the AP detail action row — same backend endpoints (tcs.pf.device,
// tcs.switch.cyclepoe), same buttons (View in PF / Reevaluate / Reboot /
// Cycle PoE), so the AP and camera screens behave identically.
const CameraPfPanel = ({ cam }) => {
  const uplink = window.CAMERA_UPLINK || null;
  const dev    = window.CAMERA_PF     || null;
  const mac    = (dev && dev.mac) || cam.mac || "";
  const adminBase = (window.PF_ADMIN_BASE || "").replace(/\/+$/, "");
  const viewHref = adminBase && mac && mac !== "—"
    ? `${adminBase}/admin/#/node/${encodeURIComponent(String(mac).toLowerCase())}`
    : null;

  // Parse the PF locationlog port into (member, port) for Cycle PoE. EXOS
  // stacks expose ports as "<member>:<port>"; ifDesc forms like "1/5" or
  // "1:5" or plain "5" all work — fall through to member=1 if unclear.
  const parsePort = (raw) => {
    const s = String(raw || "").trim();
    if (!s) return null;
    const m = s.match(/^(\d+)[\/:](\d+)$/);
    if (m) return { member: parseInt(m[1], 10), port: parseInt(m[2], 10) };
    const n = parseInt(s, 10);
    if (Number.isFinite(n) && n > 0) return { member: 1, port: n };
    return null;
  };

  const [busy, setBusy] = React.useState(null);   // 'reevaluate'|'reboot'|'poe'|null
  const [msg, setMsg]   = React.useState({ kind: "", text: "" });
  const flash = (m) => { setMsg(m); setTimeout(() => setMsg({ kind: "", text: "" }), 6000); };

  const runPf = async (op, op_busy, label) => {
    if (!mac || mac === "—") { flash({ kind: "err", text: "no MAC" }); return; }
    if (typeof window.tcsPfDeviceAction !== "function") { flash({ kind: "err", text: "endpoint missing" }); return; }
    setBusy(op_busy); setMsg({ kind: "", text: `${label}…` });
    const r = await window.tcsPfDeviceAction(mac, op);
    setBusy(null);
    flash(r && r.ok ? { kind: "", text: r.message || "ok" } : { kind: "err", text: (r && (r.error || r.message)) || "failed" });
  };

  const runCyclePoe = async () => {
    if (typeof window.tcsCyclePoeOnSwitch !== "function") { flash({ kind: "err", text: "endpoint missing" }); return; }
    if (!uplink || !uplink.switchHostid) { flash({ kind: "err", text: "upstream switch unknown" }); return; }
    const mp = parsePort(uplink.port || uplink.ifDesc);
    if (!mp) { flash({ kind: "err", text: "bad PF port string" }); return; }
    setBusy("poe"); setMsg({ kind: "", text: "cycling PoE…" });
    const r = await window.tcsCyclePoeOnSwitch(uplink.switchHostid, mp.member, mp.port);
    setBusy(null);
    flash(r && r.ok ? { kind: "", text: r.message || "ok" } : { kind: "err", text: (r && (r.error || r.message)) || "failed" });
  };

  const swHref = uplink && uplink.switchHostid
    ? `zabbix.php?action=tcs.switches.view&switchid=${encodeURIComponent(uplink.switchHostid)}`
    : null;

  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="card-h">
        <h3>PacketFence & Uplink</h3>
        <SourceBadge src="pf" />
        <div className="h-spacer" />
        {dev && (
          <span className={"reg-badge " + (dev.reg === "REG" ? "reg" : "unreg")} style={{ fontSize: 10 }}>{dev.reg}</span>
        )}
      </div>
      <div className="kv tight">
        <div className="k">Switch</div>
        <div className="v">{uplink && uplink.switch
          ? (swHref ? <a className="cam-id-link" href={swHref}>{uplink.switch}</a> : uplink.switch)
          : <span className="muted">—</span>}{uplink && uplink.switchIp ? <span className="muted" style={{ fontSize: 10, marginLeft: 6 }}>{uplink.switchIp}</span> : null}</div>
        <div className="b"><SourceBadge src="pf" /></div>
        <div className="k">Port</div>
        <div className="v">{uplink && (uplink.port || uplink.ifDesc) ? `${uplink.port || ""}${uplink.ifDesc ? ` · ${uplink.ifDesc}` : ""}` : <span className="muted">—</span>}</div>
        <div className="b"><SourceBadge src="pf" /></div>
        <div className="k">MAC</div>
        <div className="v" style={{ fontFamily: "var(--mono)", fontSize: 11 }}>{mac || <span className="muted">—</span>}</div>
        <div className="b"><SourceBadge src="zbx" /></div>
        <div className="k">Role</div>
        <div className="v">{dev && dev.role ? <span className={"role-tag " + (dev.role || "unknown")}>{dev.role}</span> : <span className="muted">—</span>}</div>
        <div className="b"><SourceBadge src="pf" /></div>
        <div className="k">PF IP</div>
        <div className="v">{dev && dev.ip ? dev.ip : <span className="muted">—</span>}</div>
        <div className="b"><SourceBadge src="pf" /></div>
        <div className="k">Last seen</div>
        <div className="v" style={{ fontSize: 11 }}>{dev && dev.lastSeen ? dev.lastSeen : <span className="muted">—</span>}</div>
        <div className="b"><SourceBadge src="pf" /></div>
      </div>
      <div className="pf-actions" style={{ padding: "10px 14px", display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        {viewHref ? (
          <a className="pf-btn" href={viewHref} target="_blank" rel="noopener noreferrer">
            <Icon name="external" size={11} /> View in PacketFence
          </a>
        ) : (
          <span className="pf-btn" style={{ opacity: 0.4, cursor: "not-allowed" }} title="PF admin URL or MAC not available">
            View in PacketFence
          </span>
        )}
        <button type="button" className="pf-btn" disabled={!!busy || !mac || mac === "—"}
          onClick={() => runPf("reevaluate_access", "reevaluate", "reevaluating")}
          title="Re-run PF role / access evaluation for this camera">
          <Icon name="refresh" size={11} /> {busy === "reevaluate" ? "REEVALUATING…" : "Reevaluate"}
        </button>
        <button type="button" className="pf-btn warn" disabled={!!busy || !mac || mac === "—"}
          onClick={() => runPf("restart_switchport", "reboot", "restarting switchport")}
          title="Bounce the switch port via PF (effectively reboots the camera over PoE link)">
          <Icon name="refresh" size={11} /> {busy === "reboot" ? "REBOOTING…" : "Reboot"}
        </button>
        <button type="button" className="pf-btn warn" disabled={!!busy || !uplink || !uplink.switchHostid}
          onClick={runCyclePoe}
          title="Toggle PoE off/on on the upstream switch port (rConfig snippet on the switch host)">
          <Icon name="refresh" size={11} /> {busy === "poe" ? "CYCLING…" : "Cycle PoE"}
        </button>
        {msg.text && <span className={"pf-msg" + (msg.kind === "err" ? " err" : "")} style={{ fontSize: 11 }}>{msg.text}</span>}
      </div>
    </div>
  );
};

ReactDOM.createRoot(document.getElementById("root")).render(<CameraDetail />);
