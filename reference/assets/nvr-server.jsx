// Server / DVR detail panel — single recording server deep dive

const ServerDetail = () => {
  const params = new URLSearchParams(location.search);
  const id = params.get("id") || "tcs-rec-bhs-01";
  const s = window.SERVERS.find(x => x.id === id) || window.SERVERS[0];
  const H = window.SERVER_HISTORY;
  const [tab, setTab] = React.useState("overview");

  const isMgmt = s.role === "Management Server";
  const isFailover = s.role === "Failover";
  const stateColor = s.disk > 90 || s.cpu > 80 ? "var(--warn)" : "var(--ok)";
  const stateLabel = s.disk > 90 || s.cpu > 80 ? "Degraded" : "Healthy";

  // Synthesize disk array — 24 disks
  const disks = Array.from({length: 24}, (_, i) => {
    let st = "ok";
    if (s.raid === "warn" && i === 3) st = "rebuild";
    if (s.id === "tcs-rec-ws-01" && i === 17) st = "warn";
    return { idx: i + 1, size: "8 TB", state: st };
  });

  // Synthesize channel grid — `s.chans` cells
  const chanCount = s.chans;
  const failedChans = s.chans - s.recording;

  return (
    <div className="app">
      <NVRSidebar active="nvr-servers" />
      <div className="main">
        <NVRTopbar crumb={["Surveillance", "Recording Servers", s.site, s.id]} />

        <div className="page-header">
          <div className="icon-btn" style={{ marginTop: 4 }} onClick={() => history.back()}><Icon name="back"/></div>
          <div style={{flex:1}}>
            <div className="host-title">
              <h1>{s.id}</h1>
              <span className="ip">{s.ip}</span>
              <span className="role-tag faculty" style={{fontSize:10,padding:"1px 8px"}}>{s.role}</span>
            </div>
            <div className="host-meta">
              <span className="pill"><span className="dot" style={{background:stateColor}}/> {stateLabel}</span>
              <span className="pill"><span className="lbl">Site</span> <span>{s.site}</span></span>
              <span className="pill"><span className="lbl">OS</span> <span>{s.os}</span></span>
              <span className="pill"><span className="lbl">Uptime</span> <span className="v">{s.uptimeD}d</span></span>
              <span className="pill"><span className="lbl">Agent</span> <span className="v">{s.agent}</span></span>
              <span className="pill"><span className="lbl">Last backup</span> <span className="v">{s.lastBackup}</span></span>
            </div>
          </div>
          <div className="timerange"><Icon name="calendar"/><span className="range-val">last 24h</span><Icon name="chevron"/></div>
        </div>

        <div className="tabs">
          {[["overview","Overview"],["channels","Channels"],["storage","Storage"],["network","Network"],["events","Events"],["config","Configuration"]].map(([k,l]) =>
            <div key={k} className={"tab " + (tab===k?"active":"")} onClick={()=>setTab(k)}>{l}</div>
          )}
        </div>

        <div className="body" data-screen-label={`Server · ${s.id}`}>
          <DemoBanner name="Recording Server Detail" />
          {/* TOP KPI strip */}
          <div className="card" style={{ marginBottom: 14 }}>
            <div className="stat-grid" style={{ gridTemplateColumns: "repeat(6, 1fr)" }}>
              <KPI lbl="CPU"      v={s.cpu}  unit="%" sub={`load avg ${(s.cpu/100*4).toFixed(2)}`} src="zbx" warn={s.cpu>80}/>
              <KPI lbl="Memory"   v={s.mem}  unit="%" sub="48 GB / 96 GB" src="zbx" warn={s.mem>85}/>
              <KPI lbl="Disk Avg" v={s.disk} unit="%" sub={s.raid === "warn" ? "RAID rebuild active" : "RAID 6 healthy"} src="zbx" warn={s.disk>85}/>
              <KPI lbl="Net In"   v="1.6"    unit="Gbps" sub={`${s.recording} streams`} src="zbx"/>
              <KPI lbl="Recording" v={`${s.recording}`} unit={`/ ${s.chans}`} sub={failedChans > 0 ? `${failedChans} not recording` : "all channels"} src="ext" warn={failedChans>0}/>
              <KPI lbl="Archive Lag" v={s.archiveLagH} unit="h" sub={s.archiveLagH>1?"behind schedule":"on schedule"} src="ext" warn={s.archiveLagH>1}/>
            </div>
          </div>

          {/* Hero row: 24h chart | hardware | health rings */}
          <div className="row" style={{ gridTemplateColumns: "1.6fr 1fr", marginBottom: 14 }}>
            <div className="card">
              <div className="card-h"><h3>Resource Utilization · 24h</h3><SourceBadge src="zbx"/><div className="h-spacer"/><span className="h-meta">zabbix-agent2 · 60s items</span></div>
              <div className="bigchart">
                <DualChart a={H.cpu} b={H.mem} aLabel="CPU %" bLabel="Memory %" aColor="var(--zbx)" bColor="var(--info)"/>
              </div>
              <div className="spark-strip" style={{borderTop:"1px solid var(--line)"}}>
                <SparkCellM label="Disk Write" v={138} unit="MB/s" data={H.diskWrite} color="var(--ok)"/>
                <SparkCellM label="Disk Read" v={42} unit="MB/s" data={H.diskRead} color="var(--info)"/>
                <SparkCellM label="Net In" v={1620} unit="Mbps" data={H.netIn} color="var(--zbx)"/>
                <SparkCellM label="Net Out" v={140} unit="Mbps" data={H.netOut} color="var(--pf)"/>
              </div>
            </div>

            <div className="card">
              <div className="card-h"><h3>Server Health</h3><SourceBadge src="zbx"/><div className="h-spacer"/><span className="h-meta">IPMI + WMI</span></div>
              <div className="health-grid" style={{gridTemplateColumns:"repeat(2,1fr)"}}>
                <div className="health-cell">
                  <Ring value={s.cpu} max={100} label={`${s.cpu}%`} sub="cpu" color={s.cpu>80?"var(--warn)":"var(--zbx)"}/>
                  <div className="h-label">CPU · 2× Xeon Gold 6326</div>
                </div>
                <div className="health-cell">
                  <Ring value={s.mem} max={100} label={`${s.mem}%`} sub="mem" color={s.mem>85?"var(--warn)":"var(--info)"}/>
                  <div className="h-label">Memory · 96 GB DDR4</div>
                </div>
                <div className="health-cell">
                  <Ring value={s.disk} max={100} label={`${s.disk}%`} sub="disk" color={s.disk>85?"var(--warn)":"var(--ok)"}/>
                  <div className="h-label">RAID 6 · 192 TB raw</div>
                </div>
                <div className="health-cell">
                  <Ring value={42} max={75} label="42°" sub="C" color="var(--ok)"/>
                  <div className="h-label">Inlet temperature</div>
                </div>
              </div>
            </div>
          </div>

          {/* Recording channels grid */}
          {!isMgmt && !isFailover && (
            <div className="card" style={{ marginBottom: 14 }}>
              <div className="card-h">
                <h3>Recording Channels</h3>
                <SourceBadge src="ext"/>
                <div className="h-spacer"/>
                <div className="summary-badge"><b>{s.recording}</b><span>/ {s.chans} recording</span></div>
                {failedChans > 0 && <div className="summary-badge"><b style={{color:"var(--err)"}}>{failedChans}</b><span>not recording</span></div>}
              </div>
              <div className="chan-grid">
                {Array.from({length: chanCount}, (_, i) => {
                  let st = "ok";
                  if (i < failedChans) st = "err";
                  else if (i < failedChans + 2) st = "warn";
                  return <div key={i} className={`chan-cell ${st}`} title={`Channel ${i+1}`}/>;
                })}
              </div>
              <div style={{padding:"8px 14px",borderTop:"1px solid var(--line)",display:"flex",gap:14,fontSize:11,color:"var(--muted)"}}>
                <span style={{display:"inline-flex",alignItems:"center",gap:6}}><span style={{width:10,height:10,borderRadius:2,background:"rgba(52,211,153,0.55)",border:"1px solid rgba(52,211,153,0.7)"}}/>recording</span>
                <span style={{display:"inline-flex",alignItems:"center",gap:6}}><span style={{width:10,height:10,borderRadius:2,background:"rgba(245,179,0,0.7)"}}/>warning</span>
                <span style={{display:"inline-flex",alignItems:"center",gap:6}}><span style={{width:10,height:10,borderRadius:2,background:"rgba(242,95,92,0.7)"}}/>not recording</span>
              </div>
            </div>
          )}

          {/* Disk array + System info */}
          <div className="row" style={{ gridTemplateColumns: "1.3fr 1fr", marginBottom: 14 }}>
            <div className="card">
              <div className="card-h">
                <h3>RAID Array · 24 × 8 TB SAS</h3>
                <SourceBadge src="zbx"/>
                <div className="h-spacer"/>
                <span className="h-meta">{s.raid === "warn" ? "1 disk rebuilding · ETA 9h 14m" : "all disks healthy · last scrub 12d ago"}</span>
              </div>
              <div className="disk-grid">
                {disks.map(d => (
                  <div key={d.idx} className={`disk-cell ${d.state}`}>
                    <div className="label">D{String(d.idx).padStart(2,"0")}</div>
                    <div className="size">{d.size}</div>
                  </div>
                ))}
              </div>
              <div className="kv tight" style={{borderTop:"1px solid var(--line)"}}>
                <div className="k">Logical volumes</div><div className="v">D:\Recording (180 TB) · E:\Archive (40 TB)</div><div className="b"><SourceBadge src="zbx"/></div>
                <div className="k">Capacity used</div><div className="v">{s.disk}% · ~{(180*s.disk/100).toFixed(0)} TB of 180 TB recording</div><div className="b"><SourceBadge src="zbx"/></div>
                <div className="k">Scrub schedule</div><div className="v">Sundays 02:00 · last completed 12 days ago</div><div className="b"><SourceBadge src="zbx"/></div>
                <div className="k">Hot spares</div><div className="v">2 available · 0 used</div><div className="b"><SourceBadge src="zbx"/></div>
              </div>
            </div>

            <div className="card">
              <div className="card-h"><h3>System Information</h3><SourceBadge src="zbx"/></div>
              <div className="kv">
                <div className="k">Hostname</div><div className="v">{s.id}</div><div className="b"><SourceBadge src="zbx"/></div>
                <div className="k">FQDN</div><div className="v">{s.id}.tcs.local</div><div className="b"><SourceBadge src="zbx"/></div>
                <div className="k">Role</div><div className="v">{s.role}</div><div className="b"><SourceBadge src="ext"/></div>
                <div className="k">Site</div><div className="v">{s.site}</div><div className="b"><SourceBadge src="ext"/></div>
                <div className="k">OS</div><div className="v">{s.os}</div><div className="b"><SourceBadge src="zbx"/></div>
                <div className="k">CPU</div><div className="v">2× Intel Xeon Gold 6326 (32c/64t)</div><div className="b"><SourceBadge src="zbx"/></div>
                <div className="k">RAM</div><div className="v">96 GB DDR4-3200 ECC</div><div className="b"><SourceBadge src="zbx"/></div>
                <div className="k">Chassis</div><div className="v">Dell PowerEdge R750xs · SVC TAG ASDF{s.id.slice(-3).toUpperCase()}</div><div className="b"><SourceBadge src="zbx"/></div>
                <div className="k">Agent</div><div className="v">{s.agent}</div><div className="b"><SourceBadge src="zbx"/></div>
                <div className="k">Uptime</div><div className="v">{s.uptimeD} days</div><div className="b"><SourceBadge src="zbx"/></div>
                <div className="k">Last patch</div><div className="v">2026-04-18 · KB5036893</div><div className="b"><SourceBadge src="zbx"/></div>
                <div className="k">XProtect ver</div><div className="v">{window.MILESTONE.version}</div><div className="b"><SourceBadge src="ext"/></div>
              </div>
            </div>
          </div>

          {/* Network + Cameras served */}
          <div className="row" style={{gridTemplateColumns:"1fr 1.6fr", marginBottom: 14}}>
            <div className="card">
              <div className="card-h"><h3>Network Interfaces</h3><SourceBadge src="zbx"/></div>
              <table className="tbl">
                <thead><tr><th>iface</th><th>state</th><th>speed</th><th>in</th><th>out</th><th>err</th></tr></thead>
                <tbody>
                  <tr><td className="fg">Ten1 (uplink)</td><td><StatusDot state="up"/> UP</td><td>10 Gbps</td><td>1.62 Gbps</td><td>140 Mbps</td><td>0</td></tr>
                  <tr><td className="fg">Ten2 (lag)</td><td><StatusDot state="up"/> UP</td><td>10 Gbps</td><td>1.58 Gbps</td><td>132 Mbps</td><td>0</td></tr>
                  <tr><td className="fg">Mgmt (iDRAC)</td><td><StatusDot state="up"/> UP</td><td>1 Gbps</td><td>0.4 Mbps</td><td>0.1 Mbps</td><td>0</td></tr>
                </tbody>
              </table>
              <div className="kv tight" style={{borderTop:"1px solid var(--line)"}}>
                <div className="k">VLAN</div><div className="v">61 (recording) · 99 (mgmt)</div><div className="b"/>
                <div className="k">LLDP neighbor</div><div className="v">DC-CORE-SW01 · Po12</div><div className="b"/>
                <div className="k">DNS</div><div className="v">10.10.1.177 · 10.10.1.178</div><div className="b"/>
                <div className="k">NTP drift</div><div className="v">3 ms (in spec)</div><div className="b"/>
              </div>
            </div>

            <div className="card">
              <div className="card-h">
                <h3>Cameras on this server</h3>
                <SourceBadge src="ext"/>
                <div className="h-spacer"/>
                <span className="h-meta">{window.CAMERAS.filter(c => c.server === s.id).length} of {s.chans} shown</span>
              </div>
              <table className="tbl">
                <thead>
                  <tr><th>Status</th><th>Camera</th><th>Location</th><th>Resolution</th><th>FPS</th><th>Bitrate</th><th>Recording</th><th></th></tr>
                </thead>
                <tbody>
                  {window.CAMERAS.filter(c => c.server === s.id).map(c => (
                    <tr key={c.id} style={{cursor:"pointer"}} onClick={()=>location.href=(c.hostid ? `zabbix.php?action=tcs.camera.view&hostid=${c.hostid}` : `zabbix.php?action=tcs.camera.view&id=${encodeURIComponent(c.id)}`)}>
                      <td><StatusDot state={c.state==="err"?"err":c.state==="warn"?"warn":"ok"}/></td>
                      <td className="fg" style={{color:"var(--accent)"}}>{c.id}</td>
                      <td>{c.loc}</td>
                      <td>{c.res}</td>
                      <td>{c.fps || "—"}</td>
                      <td>{c.bitrate ? `${(c.bitrate/1000).toFixed(1)} Mbps` : "—"}</td>
                      <td>{c.recording}</td>
                      <td style={{textAlign:"right"}}><Icon name="chevron" size={12}/></td>
                    </tr>
                  ))}
                  {window.CAMERAS.filter(c => c.server === s.id).length === 0 && (
                    <tr><td colSpan="8" style={{textAlign:"center",color:"var(--muted)",padding:24}}>No cameras directly assigned (management/failover server)</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Recent events */}
          <div className="card">
            <div className="card-h"><h3>Recent Events</h3><div className="h-spacer"/><span className="h-meta">Zabbix triggers + XProtect log</span></div>
            <div className="events">
              <CamEvent ts="09:14:09" src="ZBX" sev="info"    msg={`zabbix-agent2 heartbeat OK (${s.agent})`} />
              <CamEvent ts="08:42:30" src="EXT" sev="info"    msg="Daily archive task completed · 142 GB written" />
              {s.disk > 85 && <CamEvent ts="07:55:18" src="ZBX" sev="warning" msg={`Disk usage ${s.disk}% above 85% threshold`} />}
              {s.raid === "warn" && <CamEvent ts="08:12:00" src="ZBX" sev="warning" msg="RAID rebuild started · disk slot 4 replaced" />}
              <CamEvent ts="06:00:00" src="ZBX" sev="info" msg="Daily smartctl scan: all disks pass" />
              <CamEvent ts="Yesterday 23:48" src="EXT" sev="info" msg="XProtect Recording Server service restart (scheduled)" />
              <CamEvent ts="Yesterday 18:14" src="ZBX" sev="info" msg="Patch compliance check: KB5036893 installed" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

const KPI = ({ lbl, v, unit, sub, src, warn }) => (
  <div className="stat-cell">
    <div className="lbl">{lbl} <SourceBadge src={src || "zbx"} /></div>
    <div className="val" style={warn ? { color: "var(--warn)" } : {}}>{v}<span className="u">{unit}</span></div>
    <div className={"sub " + (warn ? "warn" : "")}>{sub}</div>
  </div>
);

const DualChart = ({ a, b, aLabel, bLabel, aColor, bColor }) => {
  const w = 800, h = 160;
  const stepX = w / (a.length - 1);
  const path = (data) => {
    const lo = 0, hi = 100;
    const pts = data.map((v, i) => [i * stepX, h - 20 - ((v - lo) / (hi - lo)) * (h - 40)]);
    return pts.map((p, i) => (i === 0 ? `M${p[0]},${p[1]}` : `L${p[0]},${p[1]}`)).join(" ");
  };
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      {[0.25, 0.5, 0.75].map(p => (
        <line key={p} x1="0" x2={w} y1={20 + p * (h - 40)} y2={20 + p * (h - 40)} stroke="var(--line)" strokeDasharray="3 3" strokeWidth="0.5"/>
      ))}
      <path d={path(a)} fill="none" stroke={aColor} strokeWidth="1.5" strokeLinejoin="round"/>
      <path d={path(b)} fill="none" stroke={bColor} strokeWidth="1.5" strokeLinejoin="round" strokeDasharray="3 2"/>
      <text x="6" y="14" fontSize="10" fontFamily="var(--mono)" fill={aColor}>● {aLabel}</text>
      <text x="100" y="14" fontSize="10" fontFamily="var(--mono)" fill={bColor}>--- {bLabel}</text>
    </svg>
  );
};

ReactDOM.createRoot(document.getElementById("root")).render(<ServerDetail />);
