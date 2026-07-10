// Main app
const { useState, useEffect } = React;

const App = () => {
  const [tab, setTab] = useState("overview");
  const [timeRange, setTimeRange] = useState("May 4, 2026 09:40 — May 5, 2026 09:40");
  const [clientFilter, setClientFilter] = useState("all");
  const [t, setTweak] = useTweaks(window.TWEAK_DEFAULTS);
  // Default to whatever host the server boot-loaded — that's the one
  // whose data is on the page. Match on hostid: the AP nav records use
  // ZBX visible_name as `id`, while ZBX_HOST.host is the technical name
  // (e.g. "TMS-GYM-2" vs. visible "TMS-GYM#2"), so an id-string match
  // silently misses and used to fall through to a hardcoded placeholder.
  const bootHostid = window.ZBX_HOST && window.ZBX_HOST.hostid ? String(window.ZBX_HOST.hostid) : "";
  const firstNavAp = (window.AP_SITES && window.AP_SITES[0] && window.AP_SITES[0].aps && window.AP_SITES[0].aps[0]) || null;
  const [activeApId, setActiveApId] = useState(bootHostid || t.selectedAp || (firstNavAp && firstNavAp.hostid && String(firstNavAp.hostid)) || (firstNavAp && firstNavAp.id) || "");
  const [apQuery, setApQuery] = useState("");

  // Resolve the active AP from AP_SITES. Prefer hostid (stable, set on
  // every real nav record); fall back to legacy id-string matching for
  // synthetic rows that don't carry one. NO hardcoded placeholder —
  // returning undefined here is preferable to painting an unrelated AP
  // over the real ZBX_HOST data.
  const allAps = window.AP_SITES.flatMap(s => s.aps.map(a => ({ ...a, site: s.name })));
  const activeAp = allAps.find(a => a.hostid && String(a.hostid) === String(activeApId))
                || allAps.find(a => a.id === activeApId)
                || null;
  // Merge nav-rail enrichment (loadLevel, status, clients, etc.) over
  // ZBX_HOST. When activeAp resolves cleanly, prefer the boot host's
  // canonical fields (host name, ip, model) — they're already correct
  // for the page that was server-rendered; only fold in the per-AP
  // metadata the nav rail uniquely provides.
  const host = activeAp ? {
    ...window.ZBX_HOST,
    site:       activeAp.site       ?? window.ZBX_HOST.site,
    floor:      activeAp.floor      ?? window.ZBX_HOST.floor,
    clients:    activeAp.clients    ?? window.ZBX_HOST.clients,
    apProblems: activeAp.problems,
    apStatus:   activeAp.status,
  } : { ...window.ZBX_HOST };

  const onSelectAp = (ap) => {
    // When the AP carries a real Zabbix hostid (i.e. came from
    // boot.apSites, not the synthetic single-host fallback), reload the
    // page targeting that host so the backend collects its data on the
    // next paint. Falls back to local-state-only for synthetic rows.
    if (ap.hostid) {
      const url = new URL(window.location.href);
      url.searchParams.set("hostid", ap.hostid);
      window.location.href = url.toString();
      return;
    }
    setActiveApId(ap.id);
    setTweak("selectedAp", ap.id);
  };

  // Apply tweaks
  useEffect(() => {
    document.documentElement.style.setProperty("--zbx", t.accent);
    document.documentElement.style.setProperty("--mono", `"${t.fontMono}", ui-monospace, "SF Mono", Menlo, monospace`);
    document.documentElement.classList.toggle("hide-src-badges", !t.showSourceBadges);
  }, [t.accent, t.fontMono, t.showSourceBadges]);

  const TabView = (() => {
    switch (tab) {
      case "overview": return <OverviewTab density={t.density} />;
      case "wireless": return <WirelessTab />;
      case "wired":    return <WiredTab />;
      case "clients":  return <ClientsTab filter={clientFilter} setFilter={setClientFilter} />;
      case "events":   return <EventsTab />;
      case "alerts":   return <AlertsTab />;
      default:         return <ComingSoon name={tab} />;
    }
  })();

  // density
  const densityVar = t.density === "spacious" ? 1.15 : t.density === "dense" ? 0.85 : 1;
  const showSide = t.showSidecar && (tab === "overview");
  const showApNav = t.showApNav !== false;

  const TabContent = (
    showSide ? (
      <div>
        <DeviceSidecar host={host} />
        <div style={{ marginTop: 14 }}>{TabView}</div>
      </div>
    ) : TabView
  );

  return (
    <div className="app" data-density={t.density} style={{ fontSize: `${13 * densityVar}px` }}>
      <Sidebar tab={tab} setTab={setTab} />
      <div className="main">
        <Topbar activeAp={activeAp} />
        <PageHeader timeRange={timeRange} setTimeRange={setTimeRange} host={host} />
        <Tabs tab={tab} setTab={setTab} />

        <div className="body" data-screen-label={`AP Detail · ${tab}`}>
          {showApNav ? (
            <div className="zbx-layout">
              <APNavigator
                activeId={activeApId}
                onSelect={onSelectAp}
                query={apQuery}
                setQuery={setApQuery}
              />
              <div style={{ minWidth: 0 }}>
                {TabContent}
                <DebugPanel />
              </div>
            </div>
          ) : (
            <>
              {TabContent}
              <DebugPanel />
            </>
          )}
        </div>
      </div>
      <Tweaks t={t} setTweak={setTweak} />
    </div>
  );
};

const ComingSoon = ({ name }) => (
  <div className="card" style={{ padding: 60, textAlign: "center", color: "var(--muted)" }}>
    <div style={{ fontSize: 14 }}>The <span style={{ color: "var(--fg)", textTransform: "capitalize" }}>{name}</span> tab is part of the roadmap.</div>
    <div style={{ fontSize: 11, marginTop: 6 }}>Backed by Zabbix history API + PacketFence /api/v1/reports.</div>
  </div>
);

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
