// PacketFence Status — cluster health, RADIUS perf, DB stats, queue depths.

const StatusHeader = () => (
  <div className="page-header" style={{ alignItems: "center" }}>
    <div style={{ flex: 1 }}>
      <div className="host-title">
        <h1>PacketFence · Cluster Status</h1>
        <span className="role-tag" style={{ fontSize: 10, padding: "1px 8px", background: "rgba(245,179,0,0.10)", color: "var(--pf)", border: "1px solid rgba(245,179,0,0.4)" }}>
          IDENTITY · PACKETFENCE
        </span>
        <span className="role-tag faculty" style={{ fontSize: 10, padding: "1px 8px" }}>INFRASTRUCTURE</span>
      </div>
      <div className="host-meta">
        <span className="pill"><span className="dot" style={{ background: "var(--warn)" }} /> 1 node desync · pf-03</span>
        <span className="pill"><span className="lbl">Version</span> <span className="v">v{PF_SUMMARY.pfVersion}</span></span>
        <span className="pill"><span className="lbl">VRRP master</span> <span className="v">pf-01</span></span>
        <span className="pill"><span className="lbl">Galera</span> <span className="v">3 nodes · 1 joiner</span></span>
        <span className="pill"><span className="lbl">Polled by</span> <span className="v">Zabbix · template PF-12</span></span>
      </div>
    </div>
    <div className="timerange">
      <Icon name="calendar" />
      <span className="range-val">Last 1h</span>
      <Icon name="chevron" />
    </div>
  </div>
);

// KPI top strip — cluster-wide
const PerfKPIs = () => {
  const cells = [
    { lbl: "RADIUS req/sec",    v: "418",   note: "5-min avg · peak 612", cls: "pf"   },
    { lbl: "Accept latency",    v: "4.2", unit: "ms", note: "p50 · p99 = 18ms", cls: "ok" },
    { lbl: "Reject rate 1h",    v: "1.0%",  note: "142 of 14.2k req",   cls: "warn" },
    { lbl: "DB connections",    v: "258",   note: "pool 400 · 64%",     cls: ""     },
    { lbl: "Galera lag",        v: "2.4", unit: "s", note: "pf-03 catching up", cls: "warn" },
    { lbl: "Cluster uptime",    v: "47d",   note: "no failover · 2026-04-03", cls: "ok" },
  ];
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="pf-kpis">
        {cells.map(c => (
          <div className="pf-kpi" key={c.lbl}>
            <div className="pf-kpi-h">
              <span className="pf-kpi-lbl">{c.lbl}</span>
              <SourceBadge src="zbx" />
            </div>
            <div className={"pf-kpi-v " + c.cls}>
              {c.v}{c.unit && <span style={{ fontSize: 12, color: "var(--muted)", marginLeft: 4, fontWeight: 500 }}>{c.unit}</span>}
            </div>
            <div className="pf-kpi-note">{c.note}</div>
          </div>
        ))}
      </div>
    </div>
  );
};

// Per-node card
const NodeCard = ({ n }) => {
  const cpuCls = n.cpu > 80 ? "err" : n.cpu > 60 ? "warn" : "ok";
  const memCls = n.mem > 80 ? "err" : n.mem > 60 ? "warn" : "ok";
  const latCls = n.radTime > 10 ? "err" : n.radTime > 7 ? "warn" : "ok";
  const queueCls = n.queue > 100 ? "err" : n.queue > 50 ? "warn" : "ok";
  return (
    <div className="pf-node">
      <div className="pf-node-h">
        <div className="pf-node-name">{n.name}</div>
        <span className={"pf-node-role " + n.role}>{n.role.toUpperCase()}</span>
        <div className="h-spacer" style={{ flex: 1 }} />
        <SourceBadge src="zbx" />
        <SourceBadge src="pf" />
      </div>
      <div className="pf-node-meta">{n.host} · up {n.uptime}</div>
      <div className="pf-node-grid">
        <div className="pf-node-cell"><div className="lbl">CPU</div><div className={"val " + cpuCls}>{n.cpu}<span className="u">%</span></div></div>
        <div className="pf-node-cell"><div className="lbl">Memory</div><div className={"val " + memCls}>{n.mem}<span className="u">%</span></div></div>
        <div className="pf-node-cell"><div className="lbl">Disk /var</div><div className="val">{n.disk}<span className="u">%</span></div></div>
        <div className="pf-node-cell"><div className="lbl">RADIUS req/s</div><div className="val">{n.radSec}</div></div>
        <div className="pf-node-cell"><div className="lbl">DB conn</div><div className="val">{n.dbConn}</div></div>
        <div className="pf-node-cell"><div className="lbl">Auth latency</div><div className={"val " + latCls}>{n.radTime}<span className="u">ms</span></div></div>
      </div>
      <div className="pf-node-svc">
        {n.services.map(s => (
          <span key={s.n} className={"pf-svc " + (s.s !== "ok" ? s.s : "")}>
            <span className="dot" style={{ background: s.s === "ok" ? "var(--ok)" : s.s === "warn" ? "var(--warn)" : "var(--err)" }} />
            {s.n}
          </span>
        ))}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 2, paddingTop: 8, borderTop: "1px solid var(--line)", fontSize: 11 }}>
        <span style={{ color: "var(--muted)" }}>Queue · pfacct</span>
        <span className={"mono"} style={{ color: n.queue > 100 ? "var(--err)" : n.queue > 50 ? "var(--warn)" : "var(--fg-2)", fontWeight: 600 }}>{n.queue}</span>
        <div className="pf-queue-bar" style={{ flex: 1 }}>
          <div className={queueCls === "ok" ? "" : queueCls === "warn" ? "warn" : "err"}
               style={{ width: `${Math.min(100, n.queue / 5)}%` }} />
        </div>
      </div>
    </div>
  );
};

// Galera replication strip
const GaleraStrip = () => (
  <div className="card">
    <div className="card-h">
      <h3>MariaDB · Galera Replication</h3>
      <SourceBadge src="pf" />
      <SourceBadge src="zbx" />
      <div className="h-spacer" />
      <span className="h-meta">wsrep_cluster_size = 3 · wsrep_cluster_status = Primary</span>
    </div>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", padding: 14, gap: 14 }}>
      {[
        { node: "pf-01", state: "Synced", role: "Donor", queue: 0, sent: "8.2 GB / hr", lag: "0.0s", cls: "ok"   },
        { node: "pf-02", state: "Synced", role: "Joiner", queue: 0, sent: "—",          lag: "0.0s", cls: "ok"   },
        { node: "pf-03", state: "Joining", role: "Receiver", queue: 240, sent: "—",     lag: "2.4s", cls: "warn" },
      ].map(g => (
        <div key={g.node} style={{ border: "1px solid var(--line)", borderRadius: 6, padding: 12, background: "var(--bg-1)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <span style={{ fontWeight: 600 }}>{g.node}</span>
            <span className="mono" style={{ fontSize: 10, color: g.cls === "ok" ? "var(--ok)" : "var(--warn)" }}>● {g.state}</span>
            <span className="h-spacer" style={{ flex: 1 }} />
            <span className="mono" style={{ fontSize: 10, color: "var(--muted)" }}>{g.role}</span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
            <div style={{ fontSize: 10, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.5 }}>Recv queue</div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 12, color: g.queue > 0 ? "var(--warn)" : "var(--fg)", textAlign: "right" }}>{g.queue}</div>
            <div style={{ fontSize: 10, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.5 }}>Replicated</div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg)", textAlign: "right" }}>{g.sent}</div>
            <div style={{ fontSize: 10, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.5 }}>Apply lag</div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 12, color: g.cls === "ok" ? "var(--fg)" : "var(--warn)", textAlign: "right" }}>{g.lag}</div>
          </div>
        </div>
      ))}
    </div>
  </div>
);

// Perf timelines (RADIUS req/s, DB conn, Queue depth)
const PerfTimelines = () => {
  const items = [
    { label: "RADIUS req/sec",  data: PF_RADIUS_TIMELINE, color: "var(--pf)",   last: PF_RADIUS_TIMELINE[PF_RADIUS_TIMELINE.length - 1] + "/s",  warn: 600 },
    { label: "DB connections",  data: PF_DB_TIMELINE,     color: "var(--info)", last: PF_DB_TIMELINE[PF_DB_TIMELINE.length - 1] + " conn", warn: 350 },
    { label: "pfacct queue depth", data: PF_QUEUE_TIMELINE, color: "var(--warn)", last: PF_QUEUE_TIMELINE[PF_QUEUE_TIMELINE.length - 1] + "", warn: 100 },
  ];
  return (
    <div className="card">
      <div className="card-h">
        <h3>Performance · last 60 min</h3>
        <SourceBadge src="zbx" />
        <div className="h-spacer" />
        <span className="h-meta">1-min samples</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)" }}>
        {items.map((it, i) => (
          <div key={it.label} style={{ padding: 14, borderRight: i < items.length - 1 ? "1px solid var(--line)" : 0, display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 10.5, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.5, flex: 1 }}>{it.label}</span>
              <span className="mono" style={{ fontSize: 14, fontWeight: 600, color: "var(--fg)" }}>{it.last}</span>
            </div>
            <Sparkline data={it.data} color={it.color} width={400} height={56} fill={true} threshold={it.warn} />
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9.5, color: "var(--muted)", fontFamily: "var(--mono)" }}>
              <span>-60m</span><span>-30m</span><span>now</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

// Queues
const Queues = () => (
  <div className="card">
    <div className="card-h">
      <h3>Queue Depths</h3>
      <SourceBadge src="pf" />
      <div className="h-spacer" />
      <span className="h-meta">pfqueue + pfacct + fingerbank</span>
    </div>
    <div className="card-b tight">
      {PF_QUEUES.map(q => {
        const pct = (q.depth / q.cap) * 100;
        const cls = pct > 75 ? "err" : pct > 30 ? "warn" : "";
        return (
          <div className="pf-queue-row" key={q.name}>
            <div className="pf-queue-name">{q.name}</div>
            <div>
              <div className="pf-queue-bar">
                <div className={cls} style={{ width: `${Math.max(2, pct)}%` }} />
              </div>
              {q.note && <div style={{ fontSize: 10, color: "var(--warn)", marginTop: 3 }}>↳ {q.note}</div>}
            </div>
            <div className="pf-queue-val">
              {q.depth}<span style={{ color: "var(--muted)" }}> / {q.cap}</span>
              <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 2 }}>{q.rate}</div>
            </div>
          </div>
        );
      })}
    </div>
  </div>
);

// Service events stream
const ServiceEvents = () => (
  <div className="card">
    <div className="card-h">
      <h3>Recent Service Events</h3>
      <SourceBadge src="pf" />
      <SourceBadge src="zbx" />
      <div className="h-spacer" />
      <a className="h-link">Open log <Icon name="external" size={11} /></a>
    </div>
    <div className="events">
      {PF_SERVICE_EVENTS.map((e, i) => (
        <div className="event" key={i} style={{ gridTemplateColumns: "80px 60px 90px 1fr" }}>
          <div className="ts">{e.ts}</div>
          <div className={"src " + e.src}>{e.src.toUpperCase()}</div>
          <div className="mono" style={{ fontSize: 11, color: "var(--fg-2)" }}>{e.host}</div>
          <div className="msg">
            <span style={{ color: e.sev === "ok" ? "var(--ok)" : e.sev === "high" ? "var(--err)" : e.sev === "warn" ? "var(--warn)" : "var(--info)", fontWeight: 500 }}>
              {e.msg}
            </span>
            <span style={{ color: "var(--fg)" }}>{e.obj}</span>
          </div>
        </div>
      ))}
    </div>
  </div>
);

// ───────── App ─────────
const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "density": "balanced",
  "showSourceBadges": true
}/*EDITMODE-END*/;

const App = () => {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  React.useEffect(() => {
    document.documentElement.classList.toggle("hide-src-badges", !t.showSourceBadges);
  }, [t.showSourceBadges]);

  return (
    <div className="app" data-density={t.density} data-pf="1" data-screen-label="PacketFence Status">
      <GlobalSidebar active="pf-status" />
      <div className="main">
        <GlobalTopbar crumb={["Tuscaloosa City Schools", "Identity", "PacketFence Status"]} />
        <StatusHeader />
        <div className="body">
          <DemoBanner name="PacketFence Status" />
          <PerfKPIs />

          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14, marginBottom: 14 }}>
            {PF_NODES.map(n => <NodeCard key={n.id} n={n} />)}
          </div>

          <div style={{ marginBottom: 14 }}>
            <PerfTimelines />
          </div>

          <div className="row" style={{ gridTemplateColumns: "1.2fr 1fr", marginBottom: 14 }}>
            <Queues />
            <GaleraStrip />
          </div>

          <ServiceEvents />
        </div>
      </div>

      <TweaksPanel title="Tweaks">
        <TweakSection title="Layout">
          <TweakRadio label="Density" value={t.density} options={[
            { value: "spacious", label: "Spacious" },
            { value: "balanced", label: "Balanced" },
            { value: "dense",    label: "Dense"    }
          ]} onChange={v => setTweak("density", v)} />
          <TweakToggle label="Show data-source badges" value={t.showSourceBadges} onChange={v => setTweak("showSourceBadges", v)} />
        </TweakSection>
        <TweakSection title="Cluster ops">
          <TweakButton onClick={() => alert("Would force a full Galera re-sync on pf-03.")}>Re-sync pf-03</TweakButton>
          <TweakButton onClick={() => alert("Would drain pf-03 (graceful) and remove from VRRP pool.")}>Drain pf-03</TweakButton>
        </TweakSection>
      </TweaksPanel>
    </div>
  );
};

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
