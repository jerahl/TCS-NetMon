// Servers dashboard app entry

const { useState: useStateSVA, useEffect: useEffectSVA } = React;

const TWEAK_DEFAULTS_SV = /*EDITMODE-BEGIN*/{
  "density": "balanced",
  "accent": "#d92929",
  "showSourceBadges": true,
  "selectedServer": "arc-sql01",
  "showFleet": true,
  "showSidecar": true,
  "tab": "overview"
}/*EDITMODE-END*/;

const ServersApp = () => {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS_SV);
  const [activeId, setActiveId] = useStateSVA(t.selectedServer);
  const [tab, setTab] = useStateSVA(t.tab || "overview");
  const [query, setQuery] = useStateSVA("");
  // Bump on every bridge refetch so children re-read window.ACTIVE_SERVER_*.
  const [, setTick] = useStateSVA(0);
  useEffectSVA(() => {
    const onData = () => setTick(n => n + 1);
    window.addEventListener("tcs:servers-data", onData);
    return () => window.removeEventListener("tcs:servers-data", onData);
  }, []);

  useEffectSVA(() => {
    document.documentElement.style.setProperty("--zbx", t.accent);
    document.documentElement.classList.toggle("hide-src-badges", !t.showSourceBadges);
  }, [t.accent, t.showSourceBadges]);

  const allHosts = window.SERVER_SITES.flatMap(s => s.servers.map(sv => ({ ...sv, site: s.name })));
  const PLACEHOLDER_HOST = {
    id: "—", hostid: "", fqdn: "No server selected", ip: "", role: "—", os: "—",
    model: "—", site: "—", cores: 0, ram: 0, diskTb: 0,
    cpu: 0, mem: 0, diskPct: 0, netMbps: 0, uptimeDays: 0,
    status: "ok", problems: 0, kind: "phys"
  };
  const host = allHosts.find(h => h.id === activeId)
    || allHosts.find(h => h.selected)
    || allHosts[0]
    || PLACEHOLDER_HOST;

  // Whenever the active host changes (initial mount included), tell the
  // bridge to refetch with the new hostid. That's what populates the
  // Services / Procs / Network tabs (collectActive on the server).
  useEffectSVA(() => {
    if (host && host.hostid && typeof window.tcsServersSetActive === "function") {
      window.tcsServersSetActive(host.hostid);
    }
  }, [host && host.hostid]);

  const onSelect = (sv) => {
    setActiveId(sv.id);
    setTweak("selectedServer", sv.id);
    if (sv.hostid && typeof window.tcsServersSetActive === "function") {
      window.tcsServersSetActive(sv.hostid);
    }
  };

  const densityVar = t.density === "spacious" ? 1.15 : t.density === "dense" ? 0.85 : 1;

  const tabs = [
    ["overview", "Overview", null],
    ["fs", "Filesystems", null],
    ["services", "Services", null],
    ["procs", "Processes", null],
    ["net", "Network", null],
    ["sessions", "Sessions", null],
    ["graphs", "Graphs", null],
    ["alerts", "Alerts", "2"],
    ["config", "Configuration", null],
  ];

  const TabView = (() => {
    switch (tab) {
      case "overview":
        return (
          <>
            <ServerKPIs host={host} />
            <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 14 }}>
              <FilesystemsCard />
              <ServerProblems />
            </div>
            <div style={{ marginTop: 14 }}>
              <ServicesCard />
            </div>
          </>
        );
      case "fs":       return <><ServerKPIs host={host} /><FilesystemsCard /></>;
      case "services": return <><ServerKPIs host={host} /><ServicesCard /></>;
      case "procs":    return <><ServerKPIs host={host} /><TopProcsCard /></>;
      case "net":      return <><ServerKPIs host={host} /><InterfacesCard /></>;
      case "sessions": return <><ServerKPIs host={host} /><SessionsCard /></>;
      case "alerts":   return <ServerProblems />;
      default:         return (
        <div className="card" style={{ padding: 60, textAlign: "center", color: "var(--muted)" }}>
          <div style={{ fontSize: 14 }}>The <span style={{ color: "var(--fg)", textTransform: "capitalize" }}>{tab}</span> tab is part of the roadmap.</div>
          <div style={{ fontSize: 11, marginTop: 6 }}>Backed by Zabbix history API.</div>
        </div>
      );
    }
  })();

  const Body = (
    <>
      {t.showSidecar ? (
        <div style={{ display: "grid", gridTemplateColumns: "300px 1fr", gap: 14 }}>
          <ServerSidecar host={host} />
          <div style={{ minWidth: 0 }}>{TabView}</div>
        </div>
      ) : TabView}
    </>
  );

  return (
    <div className="app" data-density={t.density} style={{ fontSize: `${13 * densityVar}px` }}>
      <NVRSidebar active="zbx-servers" />
      <div className="main">
        <NVRTopbar crumb={["Infrastructure", "Servers", host.site, host.id]} />

        <div className="page-header">
          <div className="icon-btn" style={{ marginTop: 4 }}><Icon name="back" /></div>
          <div style={{ flex: 1 }}>
            <div className="host-title">
              <h1>{host.id}</h1>
              <span className="ip">{host.ip}</span>
              <span className="role-tag av" style={{ fontSize: 10, padding: "1px 8px" }}>{host.kind === "phys" ? "PHYS" : "VM"} · {host.os}</span>
            </div>
            <div className="host-meta">
              <span className="pill">
                <span className="dot" style={{ background: host.status === "ok" ? "var(--ok)" : host.status === "warn" ? "var(--warn)" : "var(--err)" }} />
                {host.status === "ok" ? "Online" : host.status === "warn" ? "Degraded" : "Critical"}
              </span>
              <span className="pill"><span className="lbl">Role</span> <span>{host.role}</span></span>
              <span className="pill"><span className="lbl">Hardware</span> <span>{host.model}</span></span>
              <span className="pill"><span className="lbl">CPU</span> <span className="v">{host.cores} cores · {host.cpu}%</span></span>
              <span className="pill"><span className="lbl">RAM</span> <span className="v">{host.ram} GB · {host.mem}%</span></span>
              <span className="pill"><span className="lbl">Site</span> <span>{host.site}</span></span>
              <span className="pill"><span className="lbl">Uptime</span> <span className="v">{host.uptimeDays}d</span></span>
            </div>
          </div>
          <div className="timerange">
            <Icon name="calendar" />
            <span className="range-val">May 9, 2026 09:42 — May 10, 2026 09:42</span>
            <Icon name="chevron" />
          </div>
        </div>

        <div className="tabs">
          {tabs.map(([k, l, b]) => (
            <div key={k} className={`tab ${tab === k ? "active" : ""}`} onClick={() => { setTab(k); setTweak("tab", k); }}>
              {l}{b && <span className={`badge ${k === "alerts" ? "warn" : ""}`}>{b}</span>}
            </div>
          ))}
        </div>

        <div className="body" data-screen-label={`Server · ${host.id} · ${tab}`}>
          <div className="zbx-layout">
            <ServerNavigator activeId={activeId} onSelect={onSelect} query={query} setQuery={setQuery} />
            <div style={{ minWidth: 0 }}>{Body}</div>
          </div>
        </div>
      </div>

      <TweaksPanel title="Tweaks">
        <TweakSection title="Layout">
          <TweakRadio label="Density" value={t.density} options={[
            { value: "spacious", label: "Spacious" },
            { value: "balanced", label: "Balanced" },
            { value: "dense",    label: "Dense" }
          ]} onChange={v => setTweak("density", v)} />
          <TweakToggle label="Show device sidecar" value={t.showSidecar} onChange={v => setTweak("showSidecar", v)} />
        </TweakSection>
        <TweakSection title="Visual">
          <TweakColor label="Primary accent" value={t.accent} options={["#d92929", "#5b8cff", "#34d399", "#7c5cff", "#f5b300"]} onChange={v => setTweak("accent", v)} />
          <TweakToggle label="Show data-source badges" value={t.showSourceBadges} onChange={v => setTweak("showSourceBadges", v)} />
        </TweakSection>
        <TweakSection title="Server view">
          <TweakSelect label="Active host" value={activeId} options={allHosts.map(h => ({ value: h.id, label: `${h.id} — ${h.role}` }))} onChange={v => { setActiveId(v); setTweak("selectedServer", v); }} />
        </TweakSection>
      </TweaksPanel>
    </div>
  );
};

ReactDOM.createRoot(document.getElementById("root")).render(<ServersApp />);
