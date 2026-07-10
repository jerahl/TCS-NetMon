// Global Dashboard — high-level problem-area overview across all monitored estates
// Layout philosophy: triage > drill-down. Severity totals up top, sites heatmap +
// domain breakdown in the middle, triggers table + hotspots below, raw event stream
// at the bottom. Every card is something an operator can scan in <2 seconds.

const RANGE_OPTIONS = [
  { key: "1h",  label: "Last 1h"  },
  { key: "6h",  label: "Last 6h"  },
  { key: "24h", label: "Last 24h" },
  { key: "7d",  label: "Last 7d"  }
];

const RangeMenu = ({ anchorRect, rangeKey, onPick, onClose }) => {
  if (!anchorRect) return null;
  const style = {
    position: "fixed",
    top: anchorRect.bottom + 6,
    left: Math.max(8, anchorRect.right - 160),
    width: 160, zIndex: 1000,
    background: "var(--bg-1, #0f1620)",
    border: "1px solid var(--line, #1f2a36)",
    borderRadius: 8,
    boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
    padding: 4
  };
  return ReactDOM.createPortal(
    <div style={style} onClick={(e) => e.stopPropagation()}>
      {RANGE_OPTIONS.map(o => (
        <div
          key={o.key}
          onClick={() => { onPick(o.key); onClose(); }}
          style={{
            padding: "8px 12px", cursor: "pointer", borderRadius: 6,
            background: o.key === rangeKey ? "var(--bg-2, #1a2330)" : "transparent",
            color: o.key === rangeKey ? "var(--fg, #fff)" : "var(--fg-2, #cbd5e1)",
            fontSize: 13
          }}
          onMouseEnter={e => e.currentTarget.style.background = "var(--bg-2, #1a2330)"}
          onMouseLeave={e => e.currentTarget.style.background = o.key === rangeKey ? "var(--bg-2, #1a2330)" : "transparent"}
        >
          {o.label}
        </div>
      ))}
    </div>,
    document.body
  );
};

const GlobalHeader = ({ now, rangeKey, setRangeKey }) => {
  const [open, setOpen] = React.useState(false);
  const [anchorRect, setAnchorRect] = React.useState(null);
  const triggerRef = React.useRef(null);
  const current = RANGE_OPTIONS.find(r => r.key === rangeKey) || RANGE_OPTIONS[2];

  React.useEffect(() => {
    if (!open) return;
    const onDoc = (e) => {
      if (triggerRef.current && !triggerRef.current.contains(e.target)) setOpen(false);
    };
    const onResize = () => setOpen(false);
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onResize, true);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onResize, true);
    };
  }, [open]);

  const toggle = () => {
    if (open) { setOpen(false); return; }
    if (triggerRef.current) setAnchorRect(triggerRef.current.getBoundingClientRect());
    setOpen(true);
  };

  return (
    <div className="page-header" style={{ alignItems: "center" }}>
      <div style={{ flex: 1 }}>
        <div className="host-title">
          <h1>Global Dashboard</h1>
          <span className="role-tag faculty" style={{ fontSize: 10, padding: "1px 8px" }}>OPERATIONS · TIER-1</span>
        </div>
        <div className="host-meta">
          <span className="pill"><span className="dot" style={{ background: "var(--ok)" }} /> All proxies polling</span>
          <span className="pill"><span className="lbl">Last refresh</span> <span className="v">{now}</span></span>
          <span className="pill"><span className="lbl">Auto-refresh</span> <span className="v">30s</span></span>
          <span className="pill"><span className="lbl">Polled hosts</span> <span className="v">{GLOBAL_TOTALS.hosts.total.toLocaleString()}</span></span>
          <span className="pill"><span className="lbl">Templates</span> <span className="v">{GLOBAL_TOTALS.templates.version}</span></span>
        </div>
      </div>

      <div className="timerange" ref={triggerRef} onClick={toggle}>
        <Icon name="calendar" />
        <span className="range-val">{current.label}</span>
        <Icon name="chevron" />
      </div>

      {open && (
        <RangeMenu
          anchorRect={anchorRect}
          rangeKey={rangeKey}
          onPick={setRangeKey}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
};

// ───────── Severity strip (Disaster / High / Warning / Info / Acknowledged / Hosts down) ─────────
const SeverityStrip = () => {
  const p = GLOBAL_TOTALS.problems;
  const cells = [
    { label: "Disaster",      value: p.disaster, color: "var(--err)",  bg: "rgba(242,95,92,0.10)",   note: `${p.disaster ? "active" : "—"}` },
    { label: "High",          value: p.high,     color: "var(--err)",  bg: "rgba(242,95,92,0.06)",   note: `${p.disaster + p.high} unack`  },
    { label: "Warning",       value: p.warning,  color: "var(--warn)", bg: "rgba(245,179,0,0.08)",   note: "+12 in 1h" },
    { label: "Info",          value: p.info,     color: "var(--info)", bg: "rgba(95,168,211,0.08)",  note: "drift" },
    { label: "Acknowledged",  value: p.ack,      color: "var(--fg-2)", bg: "var(--bg-2)",            note: `${Math.round(p.ack/(p.disaster+p.high+p.warning+p.info+p.ack)*100)}% of total` },
    { label: "Hosts down",    value: GLOBAL_TOTALS.hosts.down, color: "var(--err)", bg: "rgba(242,95,92,0.06)", note: `of ${GLOBAL_TOTALS.hosts.total.toLocaleString()}` },
  ];
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="sev-strip">
        {cells.map(c => (
          <div className="sev-cell" key={c.label} style={{ background: c.bg }}>
            <div className="sev-cell-h">
              <span className="sev-cell-lbl" style={{ color: c.color }}>{c.label}</span>
              <SourceBadge src="zbx" />
            </div>
            <div className="sev-cell-v" style={{ color: c.color }}>{c.value}</div>
            <div className="sev-cell-note">{c.note}</div>
          </div>
        ))}
      </div>
    </div>
  );
};

// ───────── Sites heatmap ─────────
const sevColors = {
  ok:       { bg: "rgba(52,211,153,0.12)",  bd: "rgba(52,211,153,0.35)", fg: "var(--ok)"  },
  info:     { bg: "rgba(95,168,211,0.12)",  bd: "rgba(95,168,211,0.35)", fg: "var(--info)" },
  warning:  { bg: "rgba(245,179,0,0.12)",   bd: "rgba(245,179,0,0.40)",  fg: "var(--warn)" },
  high:     { bg: "rgba(242,95,92,0.14)",   bd: "rgba(242,95,92,0.45)",  fg: "var(--err)"  },
  disaster: { bg: "rgba(242,95,92,0.30)",   bd: "var(--err)",            fg: "#ffd0cf"     },
};

const SitesHeatmap = ({ filter, setFilter }) => {
  const sites = filter === "issues"
    ? GLOBAL_SITES.filter(s => s.problems > 0)
    : filter === "ok"
    ? GLOBAL_SITES.filter(s => s.problems === 0)
    : GLOBAL_SITES;
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="card-h">
        <h3>Sites — Health Map</h3>
        <SourceBadge src="zbx" />
        <div className="h-spacer" />
        <div className="seg-toggle">
          {[["all", `All ${GLOBAL_SITES.length}`], ["issues", `Issues ${GLOBAL_SITES.filter(s=>s.problems).length}`], ["ok", `OK ${GLOBAL_SITES.filter(s=>!s.problems).length}`]].map(([k, l]) => (
            <button key={k} className={"seg-btn" + (filter === k ? " active" : "")} onClick={() => setFilter(k)}>{l}</button>
          ))}
        </div>
      </div>
      <div className="card-b">
        <div className="sites-grid">
          {sites.map(s => {
            const c = sevColors[s.sev] || sevColors.ok;
            const href = (window.TCS_NAV ? window.TCS_NAV.events : "zabbix.php?action=tcs.events.view")
              + "&site=" + encodeURIComponent(s.name)
              + "&range=open";
            return (
              <a
                key={s.id}
                href={href}
                className={"site-tile" + (s.kind === "outage" ? " pulse" : "")}
                style={{ background: c.bg, borderColor: c.bd, textDecoration: "none" }}
                title={`${s.name} · ${s.problems} problems · SLA ${s.sla}% — click to view events`}
              >
                <div className="site-tile-h">
                  {s.problems > 0 ? (
                    <span className="site-tile-prob" style={{ color: c.fg }}>{s.problems}</span>
                  ) : (
                    <Icon name="check" size={11} />
                  )}
                </div>
                <div className="site-tile-name">{s.name}</div>
                <div className="site-tile-meta">
                  <span>{s.hosts} hosts</span>
                  <span className="mono">{s.sla.toFixed(2)}%</span>
                </div>
              </a>
            );
          })}
        </div>
      </div>
      <div className="sites-legend">
        {[["disaster","Disaster"],["high","High"],["warning","Warning"],["info","Info"],["ok","OK"]].map(([k,l]) => (
          <span className="legend-item" key={k}><span className="legend-sw" style={{ background: sevColors[k].bg, borderColor: sevColors[k].bd }} />{l}</span>
        ))}
        <span className="h-spacer" />
        <span className="legend-foot">{sites.reduce((n,s)=>n+s.problems,0)} problems · {sites.reduce((n,s)=>n+s.hosts,0).toLocaleString()} hosts shown</span>
      </div>
    </div>
  );
};

// ───────── System Snapshot — per-system tiles ─────────
// One card per monitored system, surfacing its 3 most important KPIs +
// a domain-specific sparkline + a headline message. Matches the design's
// SystemCard layout (sys-card / sys-h / sys-kpis / sys-spark / sys-foot).

const sysStatus = {
  ok:       { lbl: "OK",       fg: "var(--ok)",   bg: "rgba(52,211,153,0.10)", bd: "rgba(52,211,153,0.35)" },
  info:     { lbl: "INFO",     fg: "var(--info)", bg: "rgba(95,168,211,0.10)", bd: "rgba(95,168,211,0.35)" },
  warning:  { lbl: "WARN",     fg: "var(--warn)", bg: "rgba(245,179,0,0.10)",  bd: "rgba(245,179,0,0.40)"  },
  high:     { lbl: "HIGH",     fg: "var(--err)",  bg: "rgba(242,95,92,0.10)",  bd: "rgba(242,95,92,0.40)"  },
  disaster: { lbl: "DISASTER", fg: "#ffd0cf",     bg: "rgba(242,95,92,0.22)",  bd: "var(--err)"            },
};

const SystemCard = ({ sys }) => {
  const st = sysStatus[sys.status] || sysStatus.ok;
  const spark = Array.isArray(sys.spark) && sys.spark.some(v => v > 0) ? sys.spark : null;
  return (
    <a className="sys-card" href={sys.href} title={sys.top}>
      <div className="sys-h">
        <div className="sys-icon" style={{ borderColor: st.bd, color: st.fg, background: st.bg }}>
          <Icon name={sys.icon} size={15} />
        </div>
        <div className="sys-h-meta">
          <div className="sys-h-title">{sys.label}</div>
          <div className="sys-h-sub">{sys.sub}</div>
        </div>
        {sys.src && <SourceBadge src={sys.src} />}
        <span className="sys-status" style={{ color: st.fg, borderColor: st.bd, background: st.bg }}>
          <span className="dot" style={{ background: st.fg }} />{st.lbl}
        </span>
      </div>

      <div className="sys-kpis">
        {(sys.kpis || []).map((k, i) => (
          <div className="sys-kpi" key={i}>
            <div className="sys-kpi-lbl">{k.label}</div>
            <div className="sys-kpi-v">
              {k.value}
              {k.unit && <span className="sys-kpi-u">{k.unit}</span>}
            </div>
            {k.note && <div className="sys-kpi-n" title={k.note}>{k.note}</div>}
          </div>
        ))}
      </div>

      <div className="sys-spark">
        {spark
          ? <Sparkline data={spark} color={sys.sparkColor || "var(--zbx)"} width={260} height={28} fill={true} />
          : <div className="sys-spark-empty">—</div>}
        {sys.sparkLabel && <div className="sys-spark-lbl">{sys.sparkLabel}</div>}
      </div>

      <div className="sys-foot">
        <span className="sys-foot-msg" style={{ borderLeftColor: st.fg }}>{sys.top || "—"}</span>
        <span className="sys-foot-link">Open <Icon name="external" size={11} /></span>
      </div>
    </a>
  );
};

const SystemSnapshot = () => {
  const needAttention = GLOBAL_DOMAINS.filter(s => s.status && s.status !== "ok" && s.status !== "info").length;
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="card-h">
        <h3>System Snapshot</h3>
        <span className="h-meta">most important headline from every monitored system</span>
        <div className="h-spacer" />
        <span className="h-meta mono">{GLOBAL_DOMAINS.length} systems · {needAttention} need attention</span>
      </div>
      <div className="card-b">
        <div className="sys-grid">
          {GLOBAL_DOMAINS.map(s => <SystemCard key={s.id} sys={s} />)}
        </div>
      </div>
    </div>
  );
};

// ───────── Active triggers table ─────────
const TriggersTable = ({ filterSev }) => {
  const rows = filterSev === "all" ? GLOBAL_TRIGGERS : GLOBAL_TRIGGERS.filter(t => t.sev === filterSev);
  return (
    <table className="tbl trig-tbl">
      <thead>
        <tr>
          <th style={{ width: 60 }}>Sev</th>
          <th style={{ width: 70 }}>Age</th>
          <th>Host / trigger</th>
          <th style={{ width: 60, textAlign: "center" }}>Site</th>
          <th style={{ width: 32 }}></th>
          <th style={{ width: 28 }}></th>
        </tr>
      </thead>
      <tbody>
        {rows.map((t, i) => (
          <tr key={i}>
            <td><Sev level={t.sev} /></td>
            <td className="mono">{t.age}</td>
            <td className="fg">
              <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                <span className="mono" style={{ fontSize: 11, color: "var(--fg)" }}>{t.host}</span>
                <span style={{ fontFamily: "var(--sans)", fontSize: 11.5, color: "var(--fg-2)" }}>{t.trigger}</span>
              </div>
            </td>
            <td style={{ textAlign: "center" }}>
              <span className="site-chip">{t.site}</span>
            </td>
            <td><SourceBadge src={t.source} /></td>
            <td>
              {t.ack
                ? <Icon name="check" size={12} />
                : <span className="dot pulse-dot" style={{ background: "var(--err)" }} />}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};

// ───────── Hotspots — top sites with most problems ─────────
const Hotspots = () => {
  const top = [...GLOBAL_SITES].sort((a, b) => b.problems - a.problems).slice(0, 6);
  const max = Math.max(...top.map(t => t.problems));
  return (
    <div className="hotspots">
      {top.map(s => {
        const c = sevColors[s.sev] || sevColors.ok;
        const pct = (s.problems / max) * 100;
        return (
          <div className="hotspot-row" key={s.id}>
            <div className="hotspot-id">{s.id}</div>
            <div className="hotspot-meta">
              <div className="hotspot-h">
                <span className="hotspot-name">{s.name}</span>
                <span className="hotspot-prob mono" style={{ color: c.fg }}>{s.problems}</span>
              </div>
              <div className="hotspot-bar">
                <div style={{ width: `${pct}%`, background: c.fg, opacity: 0.85 }} />
              </div>
              <div className="hotspot-foot">
                <span>{s.hosts} hosts</span>
                <span className="mono">SLA {s.sla.toFixed(2)}%</span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
};

// ───────── Events stream ─────────
const EventsStream = () => (
  <div className="events">
    {GLOBAL_EVENTS.map((e, i) => (
      <div className="event" key={i}>
        <div className="ts">{e.ts}</div>
        <div className={"src " + e.source}>{e.source.toUpperCase()}</div>
        <div className="mono" style={{ fontSize: 11, color: "var(--fg-2)" }}>{e.host}</div>
        <div className="msg">
          <span style={{ color: e.sev === "ok" ? "var(--ok)" : e.sev === "high" || e.sev === "disaster" ? "var(--err)" : e.sev === "warning" ? "var(--warn)" : "var(--info)", fontWeight: 500 }}>
            {e.msg}
          </span>{" "}
          <span style={{ color: "var(--fg)" }}>{e.obj}</span>
        </div>
      </div>
    ))}
  </div>
);

// ───────── App ─────────
const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "density": "balanced",
  "showSourceBadges": true,
  "siteFilter": "all",
  "sevFilter": "all",
  "groupBy": "site"
}/*EDITMODE-END*/;

// Banner shown while staged data is still in flight. Two pill-shaped
// segments — one per stage — light up as their fetches complete. The
// whole banner fades out once both stages have landed.
const LoadingBanner = ({ stages }) => {
  const allDone = stages.core && stages.enrich;
  return (
    <div className={"load-banner" + (allDone ? " done" : "")} role="status" aria-live="polite">
      <span className="load-spin" aria-hidden="true" />
      <span className="load-msg">
        {allDone ? "All data loaded" : "Loading dashboard…"}
      </span>
      <span className="load-stages">
        <span className={"load-stage" + (stages.core   ? " done" : "")}>
          {stages.core   ? <Icon name="check" size={10} /> : <span className="load-dot" />} Core
        </span>
        <span className={"load-stage" + (stages.enrich ? " done" : "")}>
          {stages.enrich ? <Icon name="check" size={10} /> : <span className="load-dot" />} Enrichment
        </span>
      </span>
    </div>
  );
};

// Block-shaped pulsing skeleton used in place of card bodies that haven't
// received their data yet. Keeps the layout from jumping when content lands.
const Skeleton = ({ rows = 3, height = 36 }) => (
  <div className="skeleton-stack" aria-hidden="true">
    {Array.from({ length: rows }).map((_, i) => (
      <div className="skeleton-row" key={i} style={{ height }} />
    ))}
  </div>
);

const App = () => {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [rangeKey, setRangeKeyState] = React.useState("24h");
  const [now, setNow] = React.useState("—");
  const [refreshing, setRefreshing] = React.useState(false);
  // Bump on every successful refresh so children re-read window.GLOBAL_* globals.
  const [, setTick] = React.useState(0);
  // Per-stage "have we seen at least one successful response yet?" flags.
  // Drives the loading banner + per-section skeletons.
  const [stages, setStages] = React.useState({ core: false, enrich: false });

  React.useEffect(() => {
    document.documentElement.classList.toggle("hide-src-badges", !t.showSourceBadges);
  }, [t.showSourceBadges]);

  // Listen for bridge-published data updates: refresh timestamp + force re-render.
  React.useEffect(() => {
    const onData = (ev) => {
      const d = ev.detail || {};
      if (d.error) return; // keep the skeleton up so the user sees something's still pending
      setNow(new Date().toLocaleTimeString());
      setRefreshing(false);
      setTick(n => n + 1);
      if (d.stage === "core" || d.stage === "enrich" || d.stage === "all") {
        setStages(prev => ({
          core:   prev.core   || d.stage === "core"   || d.stage === "all",
          enrich: prev.enrich || d.stage === "enrich" || d.stage === "all"
        }));
      }
    };
    window.addEventListener("tcs:global-data", onData);
    return () => window.removeEventListener("tcs:global-data", onData);
  }, []);

  const doRefresh = React.useCallback(async () => {
    if (typeof window.tcsGlobalRefresh !== "function") return;
    setRefreshing(true);
    await window.tcsGlobalRefresh();
    // Failure path: clear spinner after a beat in case no event fires.
    setTimeout(() => setRefreshing(false), 4000);
  }, []);

  const setRangeKey = React.useCallback((r) => {
    setRangeKeyState(r);
    if (typeof window.tcsGlobalSetRange === "function") {
      setRefreshing(true);
      window.tcsGlobalSetRange(r);
    }
  }, []);

  return (
    <div className="app" data-density={t.density} data-screen-label="Global Dashboard">
      <GlobalSidebar active="global" />
      <div className="main">
        <GlobalTopbar crumb={["Tuscaloosa City Schools", "Operations", "Global"]} onRefresh={doRefresh} refreshing={refreshing} />
        <GlobalHeader now={now} rangeKey={rangeKey} setRangeKey={setRangeKey} />
        <div className="body">
          {(!stages.core || !stages.enrich) && <LoadingBanner stages={stages} />}

          {stages.core
            ? <SeverityStrip />
            : <div className="card" style={{ marginBottom: 14 }}><div className="card-b"><Skeleton rows={1} height={64} /></div></div>}

          {stages.enrich
            ? <SystemSnapshot />
            : <div className="card" style={{ marginBottom: 14 }}>
                <div className="card-h"><h3>System Snapshot</h3><span className="h-meta">loading external systems…</span></div>
                <div className="card-b"><Skeleton rows={2} height={110} /></div>
              </div>}

          {stages.core
            ? <SitesHeatmap filter={t.siteFilter} setFilter={v => setTweak("siteFilter", v)} />
            : <div className="card" style={{ marginBottom: 14 }}>
                <div className="card-h"><h3>Sites — Health Map</h3></div>
                <div className="card-b"><Skeleton rows={3} height={56} /></div>
              </div>}

          <div className="row" style={{ gridTemplateColumns: "1.4fr 1fr", marginBottom: 14 }}>
            <div className="card">
              <div className="card-h">
                <h3>Active Triggers</h3>
                <SourceBadge src="zbx" />
                <div className="h-spacer" />
                <div className="seg-toggle">
                  {[["all","All"],["disaster","Disaster"],["high","High"],["warning","Warning"]].map(([k,l]) => (
                    <button key={k} className={"seg-btn" + (t.sevFilter === k ? " active" : "")} onClick={() => setTweak("sevFilter", k)}>{l}</button>
                  ))}
                </div>
                <a className="h-link">All <Icon name="external" size={11} /></a>
              </div>
              <div className="card-b tight" style={{ maxHeight: 380, overflowY: "auto" }}>
                {stages.core ? <TriggersTable filterSev={t.sevFilter} /> : <Skeleton rows={5} height={28} />}
              </div>
            </div>
            <div className="card">
              <div className="card-h">
                <h3>Top Problem Hotspots</h3>
                <SourceBadge src="zbx" />
                <div className="h-spacer" />
                <span className="h-meta">by site</span>
              </div>
              <div className="card-b">
                {stages.core ? <Hotspots /> : <Skeleton rows={4} height={32} />}
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-h">
              <h3>Recent Events</h3>
              <SourceBadge src="zbx" />
              <SourceBadge src="pf" />
              <SourceBadge src="ext" />
              <div className="h-spacer" />
              <a className="h-link">Open in event console <Icon name="external" size={11} /></a>
            </div>
            <div className="card-b tight">
              {stages.core ? <EventsStream /> : <Skeleton rows={4} height={26} />}
            </div>
          </div>
        </div>
      </div>

      <TweaksPanel title="Tweaks">
        <TweakSection title="Layout">
          <TweakRadio label="Density" value={t.density} options={[
            { value: "spacious", label: "Spacious" },
            { value: "balanced", label: "Balanced" },
            { value: "dense",    label: "Dense"    }
          ]} onChange={v => setTweak("density", v)} />
          <TweakToggle label="Show data-source badges (ZBX/PF/EXT)" value={t.showSourceBadges} onChange={v => setTweak("showSourceBadges", v)} />
        </TweakSection>
        <TweakSection title="Filters">
          <TweakRadio label="Sites view" value={t.siteFilter} options={[
            { value: "all",    label: "All"     },
            { value: "issues", label: "Issues"  },
            { value: "ok",     label: "OK only" },
          ]} onChange={v => setTweak("siteFilter", v)} />
          <TweakSelect label="Trigger severity" value={t.sevFilter} options={[
            { value: "all",      label: "All severities" },
            { value: "disaster", label: "Disaster only" },
            { value: "high",     label: "High & above" },
            { value: "warning",  label: "Warning only" },
          ]} onChange={v => setTweak("sevFilter", v)} />
        </TweakSection>
        <TweakSection title="Quick actions">
          <TweakButton onClick={doRefresh}>Refresh now</TweakButton>
          <TweakButton onClick={() => alert("This would acknowledge all unacknowledged triggers below disaster.")}>Bulk-ack warnings</TweakButton>
        </TweakSection>
      </TweaksPanel>
    </div>
  );
};

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
