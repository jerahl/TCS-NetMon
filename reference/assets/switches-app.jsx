// Switches dashboard app entry

const { useState: useStateSWA, useEffect: useEffectSWA } = React;

const TWEAK_DEFAULTS_SW = /*EDITMODE-BEGIN*/{
  "density": "balanced",
  "accent": "#d92929",
  "showSourceBadges": true,
  "selectedSwitch": "ARC-MDF",
  "portStyle": "filled",
  "activeTab": "ports"
}/*EDITMODE-END*/;

const SwitchesApp = () => {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS_SW);
  // When the bridge bound a live switch, prefer its shortname over the
  // sticky tweak so the navigator highlights the correct row on load.
  const liveHost = (window.SWITCH_BOOT && window.SWITCH_BOOT.host) || null;
  const initialId = liveHost ? (liveHost.host || liveHost.visible_name || t.selectedSwitch) : t.selectedSwitch;
  const [activeId, setActiveId] = useStateSWA(initialId);
  const [activeTab, setActiveTab] = useStateSWA(t.activeTab || "ports");
  // Admin-only tabs (the live CLI exposes SSH credentials). The server is the
  // real gate — the snapshot endpoint withholds the ssh descriptor from
  // non-admins — but we also hide the tab so it never shows for them.
  const isAdmin = !!(window.SWITCH_BOOT && window.SWITCH_BOOT.isAdmin);
  const visibleTabs = (window.SWITCH_TABS || []).filter(tab => !tab.admin || isAdmin);
  // Coerce the active tab to a visible one (handles a non-admin landing on a
  // sticky CLI selection, or a stale saved id).
  const effectiveTab = visibleTabs.some(tab => tab.id === activeTab) ? activeTab : "ports";
  // Selected port: starts null and gets seeded once the snapshot arrives,
  // since on first paint window.ARC_MDF_STACK is just the empty-member stub.
  const [selectedPort, setSelectedPort] = useStateSWA(null);
  const onSelectPort = (memberIdx, port) => {
    if (!port || port.state === "absent") return;
    const detail = window.makePortDetail(memberIdx, port);
    setSelectedPort({ member: memberIdx, port: port.n, detail });
    // Sparklines are populated lazily — the snapshot has scalar rates per
    // port but not per-port time series. Fire the history fetch in the
    // background and patch the detail when it returns, only if the user
    // hasn't selected a different port in the meantime.
    if (typeof window.tcsLoadPortHistory === "function") {
      window.tcsLoadPortHistory(memberIdx, port.n).then(hist => {
        setSelectedPort(curr =>
          curr && curr.member === memberIdx && curr.port === port.n
            ? { ...curr, detail: { ...curr.detail, inHist: hist.inHist, outHist: hist.outHist } }
            : curr
        );
      });
    }
  };

  useEffectSWA(() => {
    document.documentElement.style.setProperty("--zbx", t.accent);
    document.documentElement.classList.toggle("hide-src-badges", !t.showSourceBadges);
  }, [t.accent, t.showSourceBadges]);

  // The bridge fetches fleet + snapshot async after first paint and updates
  // window globals in-place. Bump a version state on each tcs:switch-data
  // event so widgets that read those globals re-render.
  const [, setDataVersion] = useStateSWA(0);
  useEffectSWA(() => {
    const onData = () => setDataVersion(v => v + 1);
    window.addEventListener("tcs:switch-data", onData);
    return () => window.removeEventListener("tcs:switch-data", onData);
  }, []);

  const densityVar = t.density === "spacious" ? 1.15 : t.density === "dense" ? 0.85 : 1;

  // Find selected host across all sites. Fleet may not have loaded yet —
  // synthesize a minimal host from SWITCH_BOOT.host so the page header pills
  // render immediately with the right hostname / counters wait for snapshot.
  const allHosts = (window.SWITCH_SITES || []).flatMap(s => s.switches || []);
  const synth = liveHost ? {
    id:       liveHost.host || liveHost.visible_name || String(liveHost.hostid || "—"),
    hostid:   String(liveHost.hostid || ""),
    ip:       liveHost.ip || "",
    model:    "—",
    members:  1,
    ports:    0,
    up:       0,
    down:     0,
    poe:      0,
    cpu:      0,
    mem:      0,
    temp:     0,
    problems: 0
  } : {
    id: "—", hostid: "", ip: "", model: "—",
    members: 1, ports: 0, up: 0, down: 0, poe: 0,
    cpu: 0, mem: 0, temp: 0, problems: 0
  };
  const baseHost =
    allHosts.find(h => h.id === activeId)
    || allHosts.find(h => h.hostid && h.hostid === String(liveHost && liveHost.hostid))
    || synth;

  // Stack member count: prefer the live snapshot's stack (more accurate than
  // the fleet roll-up, which can lag), then fall back to the fleet row.
  const liveStack = Array.isArray(window.ARC_MDF_STACK) ? window.ARC_MDF_STACK : [];
  const liveStackCount = liveStack.filter(m => (m.ports || []).length + (m.sfp || []).length > 0).length;
  const stackMemberCount = liveStackCount || baseHost.members || 1;

  // Firmware / model from the snapshot info payload. The fleet roll-up no
  // longer carries per-port counters or inventory (those were the slow part
  // of the host navigator load) — for the selected switch we derive the
  // header pills from the snapshot stack + info instead.
  const info = window.SWITCH_INFO || {};
  const firmwareLabel = info.firmware || info.swOs || info.version || "—";

  const stackTotals = liveStack.reduce((acc, m) => {
    const total = (m.ports || []).length + (m.sfp || []).length;
    return {
      ports: acc.ports + total,
      up:    acc.up    + (m.upCount   || 0),
      down:  acc.down  + (m.downCount || 0),
      poe:   acc.poe   + (m.poeCount  || 0)
    };
  }, { ports: 0, up: 0, down: 0, poe: 0 });
  const hasLiveStack = stackTotals.ports > 0;

  const host = {
    ...baseHost,
    model: (info.model && String(info.model).trim()) || baseHost.model || "—",
    ports: hasLiveStack ? stackTotals.ports : (baseHost.ports || 0),
    up:    hasLiveStack ? stackTotals.up    : (baseHost.up    || 0),
    down:  hasLiveStack ? stackTotals.down  : (baseHost.down  || 0),
    poe:   hasLiveStack ? stackTotals.poe   : (baseHost.poe   || 0)
  };

  return (
    <div className="app" data-density={t.density} style={{ fontSize: `${13 * densityVar}px` }}>
      <NVRSidebar active="switches" />
      <div className="main">
        <NVRTopbar crumb={["Network", "Extreme Switches", host.id]} />
        <div className="page-header">
          <div className="icon-btn" style={{ marginTop: 4 }}><Icon name="back" /></div>
          <div style={{ flex: 1 }}>
            <div className="host-title">
              <h1>Switch Fleet</h1>
              <span className="ip">{host.id}</span>
              <span className="role-tag av" style={{ fontSize: 10, padding: "1px 8px" }}>Extreme · {host.model}</span>
            </div>
            <div className="host-meta">
              <span className="pill"><span className="dot" style={{ background: "var(--ok)" }} /> All members up</span>
              {host.ip && (
                <span className="pill"><span className="lbl">IP</span> <span className="v">{host.ip}</span></span>
              )}
              <span className="pill"><span className="lbl">Stack</span> <span className="v">{stackMemberCount} member{stackMemberCount === 1 ? "" : "s"}</span></span>
              <span className="pill"><span className="lbl">Ports</span> <span className="v">{host.up} up · {host.down} down · {host.ports} total</span></span>
              <span className="pill"><span className="lbl">PoE</span> <span className="v">{host.poe} drawing</span></span>
              <span className="pill"><span className="lbl">EXOS</span> <span className="v">{firmwareLabel}</span></span>
            </div>
          </div>
          <div className="timerange">
            <Icon name="calendar" />
            <span className="range-val">May 8 09:42 — May 9 09:42</span>
            <Icon name="chevron" />
          </div>
        </div>

        <div className="tabs">
          {visibleTabs.map(tab => {
            // The Triggers tab badge tracks the live firing count from the
            // snapshot; everything else uses its static SWITCH_TABS badge.
            let badge = tab.badge;
            if (tab.id === "triggers") {
              const firing = (window.SWITCH_TRIGGERS || []).filter(t => t.status === "firing").length;
              badge = firing > 0 ? { v: firing, kind: "warn" } : null;
            }
            return (
              <div
                key={tab.id}
                className={"tab" + (effectiveTab === tab.id ? " active" : "")}
                onClick={() => { setActiveTab(tab.id); setTweak("activeTab", tab.id); }}
              >
                {tab.label}
                {badge && <span className={"badge " + badge.kind}>{badge.v}</span>}
              </div>
            );
          })}
        </div>

        <div className="body" data-screen-label={`Switches Dashboard · ${effectiveTab}`}>
          {effectiveTab === "ports" && (
            <React.Fragment>
              <StackKPIs host={host} />
              <div className="switch-layout">
                <HostNavigator activeId={activeId} onSelect={(id) => { setActiveId(id); setTweak("selectedSwitch", id); }} />
                <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
                  <SwitchPortWidget host={host} selected={selectedPort} onSelectPort={onSelectPort} />
                  <PortDetailRow host={host} detail={selectedPort ? selectedPort.detail : null} />
                  <UplinkTable />
                </div>
              </div>
            </React.Fragment>
          )}
          {effectiveTab === "topo" && (
            <React.Fragment>
              <div className="switch-layout-2col">
                <HostNavigator activeId={activeId} onSelect={(id) => { setActiveId(id); setTweak("selectedSwitch", id); }} />
                <TabTopology host={host} />
              </div>
            </React.Fragment>
          )}
          {effectiveTab === "health" && (
            <React.Fragment>
              <div className="switch-layout-2col">
                <HostNavigator activeId={activeId} onSelect={(id) => { setActiveId(id); setTweak("selectedSwitch", id); }} />
                <TabStackHealth />
              </div>
            </React.Fragment>
          )}
          {effectiveTab === "vlan" && (
            <React.Fragment>
              <div className="switch-layout-2col">
                <HostNavigator activeId={activeId} onSelect={(id) => { setActiveId(id); setTweak("selectedSwitch", id); }} />
                <TabVlan />
              </div>
            </React.Fragment>
          )}
          {effectiveTab === "poe" && (
            <React.Fragment>
              <div className="switch-layout-2col">
                <HostNavigator activeId={activeId} onSelect={(id) => { setActiveId(id); setTweak("selectedSwitch", id); }} />
                <TabPoe />
              </div>
            </React.Fragment>
          )}
          {effectiveTab === "xiq" && (
            <React.Fragment>
              <div className="switch-layout-2col">
                <HostNavigator activeId={activeId} onSelect={(id) => { setActiveId(id); setTweak("selectedSwitch", id); }} />
                <TabXiq host={host} />
              </div>
            </React.Fragment>
          )}
          {effectiveTab === "cli" && isAdmin && (
            <React.Fragment>
              <div className="switch-layout-2col">
                <HostNavigator activeId={activeId} onSelect={(id) => { setActiveId(id); setTweak("selectedSwitch", id); }} />
                <TabCli host={host} />
              </div>
            </React.Fragment>
          )}
          {effectiveTab === "triggers" && (
            <React.Fragment>
              <div className="switch-layout-2col">
                <HostNavigator activeId={activeId} onSelect={(id) => { setActiveId(id); setTweak("selectedSwitch", id); }} />
                <TabTriggers />
              </div>
            </React.Fragment>
          )}
          {effectiveTab === "backups" && (
            <React.Fragment>
              <DemoBanner name="Config Backups" />
              <div className="switch-layout-2col">
                <HostNavigator activeId={activeId} onSelect={(id) => { setActiveId(id); setTweak("selectedSwitch", id); }} />
                <TabBackups />
              </div>
            </React.Fragment>
          )}
        </div>
      </div>

      <TweaksPanel title="Tweaks">
        <TweakSection title="Layout">
          <TweakRadio label="Density" value={t.density} options={[{value:"spacious",label:"Spacious"},{value:"balanced",label:"Balanced"},{value:"dense",label:"Dense"}]} onChange={v => setTweak("density", v)} />
        </TweakSection>
        <TweakSection title="Visual">
          <TweakColor label="Primary accent" value={t.accent} options={["#d92929","#5b8cff","#34d399","#7c5cff","#f5b300"]} onChange={v => setTweak("accent", v)} />
          <TweakToggle label="Show data-source badges" value={t.showSourceBadges} onChange={v => setTweak("showSourceBadges", v)} />
        </TweakSection>
        <TweakSection title="Switch view">
          <TweakSelect label="Active host" value={activeId} options={allHosts.map(h => ({value: h.id, label: h.id}))} onChange={v => { setActiveId(v); setTweak("selectedSwitch", v); }} />
        </TweakSection>
      </TweaksPanel>
    </div>
  );
};

ReactDOM.createRoot(document.getElementById("root")).render(<SwitchesApp />);
