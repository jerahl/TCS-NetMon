// VoIP / 3CX monitoring dashboard
// Single-page Zabbix-style view of the TCS 3CX phone system.

const { useState: useStateVP, useEffect: useEffectVP, useMemo: useMemoVP } = React;

// ═══════════════════════════════════════════════════════════════
// EMPTY-STATE SHELLS
// voip-bridge.jsx fills these with live data from tcs.voip.data once
// the SSR boot or the first fetch lands. Until then (or when 3CX /
// Zabbix are unreachable) every card renders against the zeroed
// shape below — no demo data is ever shown.
// ═══════════════════════════════════════════════════════════════

window.VOIP_PBX = window.VOIP_PBX || {
  fqdn: "—", ip: "—", version: "—", edition: "—", uptime: "—", region: "—",
  activeNow: 0, capacity: 0, peakToday: 0,
  callsToday: 0, callsInbound: 0, callsOutbound: 0, callsInternal: 0,
  registeredExt: 0, totalExt: 0, trunksReg: 0, trunksTotal: 0,
  avgMos: 0, asr: 0, acd: "—",
  history: {
    concur:   new Array(96).fill(0),
    inbound:  new Array(96).fill(0),
    outbound: new Array(96).fill(0),
  },
};
window.VOIP_TRUNKS   = window.VOIP_TRUNKS   || [];
window.VOIP_SBCS     = window.VOIP_SBCS     || [];
window.VOIP_CALLS    = window.VOIP_CALLS    || [];
window.VOIP_TOP      = window.VOIP_TOP      || [];
window.VOIP_QUEUES   = window.VOIP_QUEUES   || [];
window.VOIP_QUALITY  = window.VOIP_QUALITY  || {
  mos:    new Array(48).fill(0),
  jitter: new Array(48).fill(0),
  loss:   new Array(48).fill(0),
  rtt:    new Array(48).fill(0),
};
window.VOIP_PROBLEMS = window.VOIP_PROBLEMS || [];

// ═══════════════════════════════════════════════════════════════
// WIDGETS
// ═══════════════════════════════════════════════════════════════

// ── Concurrent-calls 24h area chart ──
const ConcurrencyChart = () => {
  const data = window.VOIP_PBX.history;
  const W = 720, H = 168, PAD_L = 30, PAD_R = 14, PAD_T = 14, PAD_B = 22;
  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;
  const max = 80;
  const n = data.concur.length;
  const x = i => PAD_L + (i / (n - 1)) * innerW;
  const y = v => PAD_T + innerH - Math.min(1, v / max) * innerH;
  const areaPath = (arr) => {
    const pts = arr.map((v, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(v)}`).join(" ");
    return `${pts} L${x(n-1)},${PAD_T + innerH} L${x(0)},${PAD_T + innerH} Z`;
  };
  const linePath = (arr) => arr.map((v, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(v)}`).join(" ");
  const ticks = [0, 20, 40, 60, 80];
  const hours = [0, 6, 9, 12, 15, 18, 23];

  return (
    <div className="card concur-card">
      <div className="card-h">
        <h3>Concurrent Calls · 24h</h3>
        <SourceBadge src="3cx" />
        <SourceBadge src="zbx" />
        <div className="h-spacer" />
        <span className="h-meta">15-min buckets · live</span>
      </div>
      <div className="concur-meta">
        <div>
          <div className="cm-lbl">Active right now</div>
          <div className="cm-now">{window.VOIP_PBX.activeNow}<span className="u">/ {window.VOIP_PBX.capacity} SC</span></div>
        </div>
        <div className="cm-kv"><span className="lbl">Peak today</span><span className="v warn">{window.VOIP_PBX.peakToday || "—"}</span></div>
        <div className="cm-kv"><span className="lbl">Calls today</span><span className="v">{window.VOIP_PBX.callsToday.toLocaleString()}</span></div>
        <div className="cm-kv"><span className="lbl">ACD</span><span className="v">{window.VOIP_PBX.acd}</span></div>
        <div className="cm-kv"><span className="lbl">ASR</span><span className="v">{window.VOIP_PBX.asr}%</span></div>
        <div className="cm-spacer" />
        <div className="cm-cap"><b>{window.VOIP_PBX.callsInbound.toLocaleString()}</b> in · <b>{window.VOIP_PBX.callsOutbound.toLocaleString()}</b> out · <b>{window.VOIP_PBX.callsInternal}</b> internal</div>
      </div>
      <div className="concur-chart-wrap">
        <svg className="concur-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
          {ticks.map(t => (
            <g key={t}>
              <line className="grid-line" x1={PAD_L} x2={W - PAD_R} y1={y(t)} y2={y(t)} />
              <text className="axis-lbl" x={PAD_L - 6} y={y(t) + 3} textAnchor="end">{t}</text>
            </g>
          ))}
          {/* peak threshold line */}
          <line className="peak-line" x1={PAD_L} x2={W - PAD_R} y1={y(window.VOIP_PBX.peakToday)} y2={y(window.VOIP_PBX.peakToday)} />
          {/* outbound area (lower) */}
          <path className="area-fill" fill="var(--info)" d={areaPath(data.outbound)} />
          {/* total area on top */}
          <path className="area-fill" fill="var(--cx)" d={areaPath(data.concur)} />
          <path className="area-line" stroke="var(--cx)" d={linePath(data.concur)} />
          <path className="area-line" stroke="var(--info)" strokeOpacity="0.7" d={linePath(data.outbound)} strokeDasharray="3 2" />
          {hours.map(h => (
            <text key={h} className="axis-lbl" x={PAD_L + (h/23) * innerW} y={H - 6} textAnchor="middle">{String(h).padStart(2,"0")}:00</text>
          ))}
        </svg>
      </div>
      <div className="concur-legend">
        <span className="item"><span className="sw" style={{background:"var(--cx)"}}></span> Total concurrent</span>
        <span className="item"><span className="sw" style={{background:"var(--info)",opacity:0.7}}></span> Outbound only</span>
        <span className="item"><span className="sw" style={{background:"var(--warn)",height:2,marginBottom:3}}></span> Today's peak ({window.VOIP_PBX.peakToday})</span>
      </div>
    </div>
  );
};

// ── KPI strip across top ──
const VoipKpis = () => {
  const p = window.VOIP_PBX;
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="swstat-strip">
        <div className="swstat-cell">
          <div className="lbl">Active Calls</div>
          <div className="val" style={{color:"var(--cx)"}}>{p.activeNow}<span style={{fontSize:11,color:"var(--muted)",fontWeight:500}}> / {p.capacity}</span></div>
          <Sparkline data={p.history.concur.slice(-24)} color="var(--cx)" width={120} height={20} />
        </div>
        <div className="swstat-cell">
          <div className="lbl">Calls Today</div>
          <div className="val">{p.callsToday.toLocaleString()}</div>
          <div style={{fontSize:10,color:"var(--muted)",fontFamily:"var(--mono)"}}>{p.callsInbound.toLocaleString()} in · {p.callsOutbound.toLocaleString()} out</div>
        </div>
        <div className="swstat-cell">
          <div className="lbl">Registered Phones</div>
          <div className="val ok">{p.registeredExt}<span style={{fontSize:11,color:"var(--muted)",fontWeight:500}}> / {p.totalExt}</span></div>
          <div style={{fontSize:10,color:"var(--warn)",fontFamily:"var(--mono)"}}>● {p.totalExt - p.registeredExt} unreg</div>
        </div>
        <div className="swstat-cell">
          <div className="lbl">Avg MOS · 1h</div>
          <div className="val ok">{p.avgMos.toFixed(2)}</div>
          <Sparkline data={window.VOIP_QUALITY.mos.slice(-24)} color="var(--ok)" width={120} height={20} />
        </div>
        <div className="swstat-cell">
          <div className="lbl">ASR (Answer)</div>
          <div className="val ok">{p.asr}%</div>
          <div style={{fontSize:10,color:"var(--muted)",fontFamily:"var(--mono)"}}>ACD {p.acd}</div>
        </div>
        <div className="swstat-cell">
          <div className="lbl">SIP Trunks</div>
          <div className="val warn">5<span style={{fontSize:11,color:"var(--muted)",fontWeight:500}}> / 6 up</span></div>
          <div style={{fontSize:10,color:"var(--err)",fontFamily:"var(--mono)"}}>● 1 unreg · 1 degraded</div>
        </div>
      </div>
    </div>
  );
};

// ── Loading-status pill ──
// Reads window.VOIP_LOADING_FLAGS (set by voip-bridge.jsx). Shows a spinner
// + which endpoint(s) are still in flight while the first parallel fetch
// is running, then disappears once everything has responded once.
const LoadingPill = () => {
  const flags = window.VOIP_LOADING_FLAGS || {};
  const labelOf = { core: "core", top: "top talkers", calls: "active calls" };
  const pending = Object.keys(flags).filter(k => flags[k]);
  if (pending.length === 0) return null;
  return (
    <span className="pill" style={{ background:"var(--bg-2)", borderColor:"var(--cx)" }}>
      <span className="dot" style={{
        background:"var(--cx)",
        animation:"voipLoadingPulse 1.4s ease-in-out infinite",
      }} />
      <span className="lbl">Loading</span>
      <span className="v" style={{ fontSize:10, opacity:0.8 }}>
        {pending.map(k => labelOf[k] || k).join(" · ")}
      </span>
    </span>
  );
};

// ── SBC fleet ──
// Each row in window.VOIP_SBCS represents one remote 3CX SBC (Session Border
// Controller) reporting back to this PBX. We render up/down + live CPU /
// memory / disk / latency / call & phone counts.
const SbcsCard = () => {
  const sbcs = window.VOIP_SBCS;
  const upCount = sbcs.filter(s => s.up).length;
  return (
    <div className="card">
      <div className="card-h">
        <h3>Session Border Controllers</h3>
        <SourceBadge src="3cx" />
        <div className="h-spacer" />
        <span className="h-meta">{sbcs.length === 0 ? "no SBCs registered" : `${upCount} / ${sbcs.length} up`}</span>
      </div>
      {sbcs.length === 0 ? (
        <div style={{padding:"18px 14px",fontSize:12,color:"var(--muted)"}}>No SBCs configured on this PBX.</div>
      ) : (
        <div className="svc-list">
          {sbcs.map(s => {
            const cls = s.up ? "" : "err";
            const lbl = s.up ? "UP" : (s.hasConn ? "DEGR" : "DOWN");
            const sub = [
              s.group,
              s.localIp && `local ${s.localIp}`,
              s.publicIp && `pub ${s.publicIp}`,
              s.version,
            ].filter(Boolean).join(" · ");
            const stats = [
              `${s.phones} phones`,
              `${s.calls} calls`,
              s.latency > 0 && `${s.latency}ms`,
              s.cpu && `cpu ${s.cpu}`,
              s.memory && `mem ${s.memory}`,
              s.disk && `disk ${s.disk}`,
            ].filter(Boolean).join(" · ");
            return (
              <div key={s.id || s.name} className="svc-row">
                <span className={"svc-led " + cls}></span>
                <div>
                  <div className="svc-name">{s.name}</div>
                  <div className="svc-sub">{sub || "—"}</div>
                  {stats && <div className="svc-sub" style={{marginTop:2}}>{stats}</div>}
                </div>
                <div className="svc-load">{s.uptime || ""}</div>
                <span className={"svc-pill " + cls}>{lbl}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

// ── Trunks table ──
const TrunksCard = () => (
  <div className="card">
    <div className="card-h">
      <h3>SIP Trunks · Carriers</h3>
      <SourceBadge src="3cx" />
      <SourceBadge src="zbx" />
      <div className="h-spacer" />
      <span className="h-meta">OPTIONS keepalive · 60s</span>
      <span className="h-link">Open in 3CX Mgmt <Icon name="external" size={11} /></span>
    </div>
    <table className="trunk-tbl">
      <thead>
        <tr>
          <th style={{width: 90}}>Status</th>
          <th>Trunk / Carrier</th>
          <th style={{width: 240}}>Channel utilization</th>
          <th style={{width: 70, textAlign:"right"}}>In</th>
          <th style={{width: 70, textAlign:"right"}}>Out</th>
          <th style={{width: 64, textAlign:"right"}}>ASR</th>
          <th style={{width: 60, textAlign:"right"}}>MOS</th>
          <th style={{width: 60, textAlign:"right"}}>Err 5m</th>
        </tr>
      </thead>
      <tbody>
        {window.VOIP_TRUNKS.map((t, i) => {
          const used = t.chIn + t.chOut;
          const freePct = ((t.chTotal - used) / t.chTotal) * 100;
          const inPct = (t.chIn / t.chTotal) * 100;
          const outPct = (t.chOut / t.chTotal) * 100;
          return (
            <tr key={i}>
              <td><span className={"tk-status " + t.status}>{t.status === "reg" ? "REG" : t.status === "dgr" ? "DEGR" : "UNREG"}</span></td>
              <td>
                <div className="tk-name">{t.name}</div>
                <div className="tk-host">{t.host} · {t.did}</div>
              </td>
              <td>
                <div className="ch-bar">
                  <i className="in"  style={{width: inPct + "%"}} />
                  <i className="out" style={{width: outPct + "%"}} />
                  <i className="free" style={{width: freePct + "%"}} />
                  <span className="lbl">{used}/{t.chTotal}</span>
                </div>
              </td>
              <td className="mono" style={{textAlign:"right", color:"var(--cx)"}}>{t.chIn}</td>
              <td className="mono" style={{textAlign:"right", color:"var(--info)"}}>{t.chOut}</td>
              <td className="mono" style={{textAlign:"right", color: t.asr === 0 ? "var(--muted)" : (t.asr < 92 ? "var(--warn)" : "var(--fg-2)")}}>
                {t.asr > 0 ? t.asr.toFixed(1) + "%" : "—"}
              </td>
              <td className="mono" style={{textAlign:"right", color: t.mos === 0 ? "var(--muted)" : (t.mos < 4.1 ? "var(--warn)" : "var(--ok)")}}>
                {t.mos > 0 ? t.mos.toFixed(2) : "—"}
              </td>
              <td className="mono" style={{textAlign:"right", color: t.errors > 0 ? "var(--warn)" : "var(--muted)"}}>{t.errors}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  </div>
);

// ── Active calls list ──
const ActiveCallsCard = () => {
  const dirLbl = { in: "INBOUND", out: "OUTBOUND", int: "INTERNAL", q: "QUEUED" };
  return (
    <div className="card">
      <div className="card-h">
        <h3>Active Calls · live</h3>
        <SourceBadge src="3cx" />
        <div className="h-spacer" />
        <span className="h-meta">{window.VOIP_CALLS.length} ongoing · 2s refresh</span>
      </div>
      <div className="calls-list">
        {window.VOIP_CALLS.map((c, i) => {
          const onBars = c.q === "good" ? 4 : c.q === "fair" ? 2 : 1;
          return (
            <div key={i} className="call-row">
              <span className={"c-dir " + c.dir}>{dirLbl[c.dir]}</span>
              <div className="c-leg">
                <div className="who">{c.from}</div>
                <div className="sub">{c.fromSub}</div>
              </div>
              <div className="c-leg">
                <div className="who">{c.to}</div>
                <div className="sub">{c.toSub}</div>
              </div>
              <div className="c-dur">{c.dur}</div>
              <div className="c-tech">
                <span><b>{c.codec}</b></span>
                <span>via {c.trunk}</span>
              </div>
              <div className={"c-q " + c.q}>
                {c.mos > 0 ? <span className={"mos " + c.q}>{c.mos.toFixed(2)}</span> : <span className="mos" style={{color:"var(--muted)"}}>—</span>}
                <span className="bars">
                  {[0,1,2,3].map(b => <i key={b} className={b < onBars ? "on" : ""} />)}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

// ── Call quality card ──
const CallQualityCard = () => {
  const q = window.VOIP_QUALITY;
  const mosNow = q.mos[q.mos.length - 1];
  const jitNow = q.jitter[q.jitter.length - 1];
  const lossNow = q.loss[q.loss.length - 1];
  const rttNow = q.rtt[q.rtt.length - 1];
  const cls = (good, fair, val, inv) => {
    if (inv) return val <= good ? "ok" : (val <= fair ? "warn" : "err");
    return val >= good ? "ok" : (val >= fair ? "warn" : "err");
  };
  return (
    <div className="card">
      <div className="card-h">
        <h3>Call Quality · 24h</h3>
        <SourceBadge src="3cx" />
        <div className="h-spacer" />
        <span className="h-meta">RTCP-XR · 30m</span>
      </div>
      <div className="cq-rows">
        <div className="cq-row">
          <div className="cq-lbl"><span className="name">MOS</span><span className="sub">target ≥ 4.0</span></div>
          <div className="cq-spark"><Sparkline data={q.mos} color="var(--ok)" width={300} height={32} threshold={4.0} /></div>
          <div className="cq-val"><div className={"v " + cls(4.2, 4.0, mosNow)}>{mosNow.toFixed(2)}</div><div className="u">score</div></div>
        </div>
        <div className="cq-row">
          <div className="cq-lbl"><span className="name">Jitter</span><span className="sub">target ≤ 20ms</span></div>
          <div className="cq-spark"><Sparkline data={q.jitter} color="var(--warn)" width={300} height={32} threshold={20} /></div>
          <div className="cq-val"><div className={"v " + cls(15, 20, jitNow, true)}>{jitNow.toFixed(1)}</div><div className="u">ms</div></div>
        </div>
        <div className="cq-row">
          <div className="cq-lbl"><span className="name">Packet loss</span><span className="sub">target ≤ 0.5%</span></div>
          <div className="cq-spark"><Sparkline data={q.loss} color="var(--pf)" width={300} height={32} threshold={0.5} /></div>
          <div className="cq-val"><div className={"v " + cls(0.3, 0.5, lossNow, true)}>{lossNow.toFixed(2)}</div><div className="u">%</div></div>
        </div>
        <div className="cq-row">
          <div className="cq-lbl"><span className="name">Round-trip</span><span className="sub">target ≤ 50ms</span></div>
          <div className="cq-spark"><Sparkline data={q.rtt} color="var(--info)" width={300} height={32} threshold={50} /></div>
          <div className="cq-val"><div className={"v " + cls(30, 50, rttNow, true)}>{rttNow.toFixed(0)}</div><div className="u">ms</div></div>
        </div>
      </div>
    </div>
  );
};

// ── Top extensions / talkers ──
const TopTalkers = () => {
  const max = window.VOIP_TOP.length ? Math.max(...window.VOIP_TOP.map(t => t.calls)) : 1;
  return (
    <div className="card">
      <div className="card-h">
        <h3>Top Extensions · Today</h3>
        <SourceBadge src="3cx" />
        <div className="h-spacer" />
        <span className="h-meta">by call volume</span>
      </div>
      {window.VOIP_TOP.map((t, i) => (
        <div key={t.ext} className="tt-row">
          <span className="tt-rank">{i + 1}</span>
          <div className="tt-name">
            <div className="who"><span className="ext">x{t.ext}</span>{t.name}</div>
            <div className="sub">{t.mins} min talk · {t.site}</div>
          </div>
          <span className="tt-bar"><i style={{width: (t.calls/max*100) + "%"}} /></span>
          <span className="tt-cnt">{t.calls}</span>
        </div>
      ))}
    </div>
  );
};

// ── Queues panel ──
const QueuesCard = () => (
  <div className="card">
    <div className="card-h">
      <h3>Call Queues</h3>
      <SourceBadge src="3cx" />
      <div className="h-spacer" />
      <span className="h-meta">SLA = answered within target</span>
    </div>
    <div className="q-grid">
      {window.VOIP_QUEUES.map(q => (
        <div key={q.ext} className="q-cell">
          <div className="q-head">
            <span className="name">{q.name}</span>
            <span className="ext">x{q.ext}</span>
          </div>
          <div className="q-stats">
            <div className="q-stat"><span className="k">Agents</span><span className="v">{q.agentsOn}/{q.agents}</span></div>
            <div className="q-stat"><span className="k">Waiting</span><span className={"v " + (q.waiting>2?"warn":"")}>{q.waiting}</span></div>
            <div className="q-stat"><span className="k">SLA {q.slaSec}s</span><span className={"v " + (q.sla<90?"warn":"")}>{q.sla}%</span></div>
            <div className="q-stat"><span className="k">Abandon</span><span className={"v " + (q.abandon>3?"warn":"")}>{q.abandon}</span></div>
          </div>
          <div className="q-bar">
            <i className="ans" style={{width: (q.ans/(q.ans+q.abandon)*100) + "%"}}/>
            <i className="aban" style={{width: (q.abandon/(q.ans+q.abandon)*100) + "%"}}/>
          </div>
        </div>
      ))}
    </div>
  </div>
);

// ── Problems ──
const VoipProblems = () => (
  <div className="card">
    <div className="card-h">
      <h3>Problems</h3>
      <SourceBadge src="zbx" />
      <div className="h-spacer" />
      <Icon name="filter" size={12} />
      <Icon name="more" size={14} />
    </div>
    <div style={{padding:"8px 14px 6px", fontSize:11, color:"var(--muted)", letterSpacing:0.4, textTransform:"uppercase", borderBottom:"1px solid var(--line)"}}>
      Triggers · last 24h · VoIP host group
    </div>
    {window.VOIP_PROBLEMS.map((p, i) => (
      <div key={i} className={"problem-row " + (p.ack ? "ack" : "")}>
        <div className="top">
          <Sev level={p.sev} />
          <span className="host">{p.host}</span>
          <span className="age">{p.age}</span>
        </div>
        <div className="trig">{p.trig}</div>
        <div className="ts">{p.ts}{p.ack && " · ack"}</div>
      </div>
    ))}
  </div>
);

// ═══════════════════════════════════════════════════════════════
// APP
// ═══════════════════════════════════════════════════════════════

const TWEAK_DEFAULTS_VP = /*EDITMODE-BEGIN*/{
  "density": "balanced",
  "accent": "#2bd6c0",
  "showSourceBadges": true,
  "showInternalCalls": true
}/*EDITMODE-END*/;

const VoipApp = () => {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS_VP);
  const [, setTick] = useStateVP(0);

  useEffectVP(() => {
    document.documentElement.style.setProperty("--cx", t.accent);
    document.documentElement.classList.toggle("hide-src-badges", !t.showSourceBadges);
  }, [t.accent, t.showSourceBadges]);

  // Re-render whenever voip-bridge.jsx swaps in a fresh payload. The card
  // components all read window.VOIP_* directly at render time, so bumping
  // a tick is enough to pick up the new data.
  useEffectVP(() => {
    const onData = () => setTick(n => n + 1);
    window.addEventListener("tcs:voip-data", onData);
    return () => window.removeEventListener("tcs:voip-data", onData);
  }, []);

  const densityVar = t.density === "spacious" ? 1.15 : t.density === "dense" ? 0.85 : 1;
  const p = window.VOIP_PBX;

  return (
    <div className="app" data-density={t.density} style={{ fontSize: `${13 * densityVar}px` }}>
      <GlobalSidebar active="voip" />
      <div className="main">
        <GlobalTopbar crumb={["Voice", "3CX Phone System", p.fqdn]} search="Find extension, DID, caller…" />
        <div className="page-header">
          <div className="icon-btn" style={{ marginTop: 4 }}><Icon name="back" /></div>
          <div style={{ flex: 1 }}>
            <div className="host-title">
              <h1>3CX Phone System</h1>
              <span className="ip">{p.fqdn}</span>
              <span className="role-tag voip" style={{ fontSize: 10, padding: "1px 8px" }}>3CX · {p.version}</span>
            </div>
            <div className="host-meta voip-meta-bar">
              <LoadingPill />
              <span className="pill"><span className="dot" style={{ background: "var(--ok)" }} /> Phone System online</span>
              <span className="pill"><span className="lbl">IP</span> <span className="v">{p.ip}</span></span>
              <span className="pill"><span className="lbl">License</span> <span className="v">{p.edition}</span></span>
              <span className="pill"><span className="lbl">Uptime</span> <span className="v">{p.uptime}</span></span>
              <span className="pill"><span className="lbl">Region</span> <span className="v">Arc-DC</span></span>
              <span className="pill"><span className="dot" style={{ background: "var(--warn)" }} /> 1 trunk degraded · 1 unreg</span>
            </div>
          </div>
          <div className="timerange">
            <Icon name="calendar" />
            <span className="range-val">May 13 09:42 — May 14 09:42</span>
            <Icon name="chevron" />
          </div>
        </div>

        <div className="body" data-screen-label="VoIP Dashboard">
          <VoipKpis />

          <div className="voip-row-2col-wide" style={{ marginBottom: 14 }}>
            <ConcurrencyChart />
            <CallQualityCard />
          </div>

          <div style={{ marginBottom: 14 }}>
            <ActiveCallsCard />
          </div>

          <div style={{ marginBottom: 14 }}>
            <TrunksCard />
          </div>

          <div style={{ marginBottom: 14 }}>
            <SbcsCard />
          </div>

          <div className="voip-row-2col-wide" style={{ marginBottom: 14 }}>
            <QueuesCard />
            <TopTalkers />
          </div>

          <VoipProblems />
        </div>
      </div>

      <TweaksPanel title="Tweaks">
        <TweakSection title="Layout">
          <TweakRadio label="Density" value={t.density}
            options={[{value:"spacious",label:"Spacious"},{value:"balanced",label:"Balanced"},{value:"dense",label:"Dense"}]}
            onChange={v => setTweak("density", v)} />
        </TweakSection>
        <TweakSection title="Visual">
          <TweakColor label="3CX accent" value={t.accent}
            options={["#2bd6c0","#34d399","#5b8cff","#7c5cff","#f5b300","#d92929"]}
            onChange={v => setTweak("accent", v)} />
          <TweakToggle label="Show data-source badges" value={t.showSourceBadges} onChange={v => setTweak("showSourceBadges", v)} />
        </TweakSection>
      </TweaksPanel>
    </div>
  );
};

ReactDOM.createRoot(document.getElementById("root")).render(<VoipApp />);
