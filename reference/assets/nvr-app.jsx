// Surveillance overview app entry

const { useState: useStateOV, useEffect: useEffectOV } = React;

// Safety defaults — if surveillance-bridge.jsx hasn't finished publishing
// yet, or if a refresh swapped MILESTONE for a partial object, fall back
// here rather than throwing on .toFixed / .toLocaleString.
const MS_DEFAULTS = {
  product: "—", version: "—", managementServer: "—",
  licenseDeviceTotal: 0, licenseDeviceUsed: 0, licenseHwTotal: 0,
  recordingServers: 0, recordingServersOnline: 0,
  failoverServers: 0, mobileServers: 0,
  smartClientSessions: 0, webClientSessions: 0,
  activeAlarms: 0, alarmsAck: 0,
  retentionDays: 0, storageTotalTB: 0, storageUsedTB: 0,
  evidenceLockSlots: 0, evidenceLockUsed: 0
};
const _ms = () => Object.assign({}, MS_DEFAULTS, window.MILESTONE || {});
const _nz = (v, d = 0) => (typeof v === "number" && !Number.isNaN(v) ? v : d);

const TWEAK_DEFAULTS_OV = /*EDITMODE-BEGIN*/{
  "density": "balanced",
  "accent": "#d92929",
  "showSourceBadges": true,
  "activeTab": "overview"
}/*EDITMODE-END*/;

const NVRApp = () => {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS_OV);
  const [activeTab, setActiveTab] = useStateOV(t.activeTab || "overview");
  useEffectOV(() => {
    document.documentElement.style.setProperty("--zbx", t.accent);
    document.documentElement.classList.toggle("hide-src-badges", !t.showSourceBadges);
  }, [t.accent, t.showSourceBadges]);
  // surveillance-bridge.jsx fetches the fleet async after first paint and
  // updates the window globals in place. Bump a version on each
  // tcs:surveillance-data event so the tree re-reads them.
  const [, setDataVersion] = useStateOV(0);
  useEffectOV(() => {
    const onData = () => setDataVersion(v => v + 1);
    window.addEventListener("tcs:surveillance-data", onData);
    return () => window.removeEventListener("tcs:surveillance-data", onData);
  }, []);

  // Snapshot the live globals once per render so we never re-deref something
  // mid-tree that the bridge swapped out underneath us.
  const M = _ms();
  const SITES_RAW = Array.isArray(window.SITES) ? window.SITES : [];
  const CAMS_RAW  = Array.isArray(window.CAMERAS) ? window.CAMERAS : [];
  const SRVS_RAW  = Array.isArray(window.SERVERS) ? window.SERVERS : [];

  // First load: the bridge hasn't returned the summary stage yet. Hold
  // the boot splash (instead of an empty shell) until the cheap summary
  // fetch lands; later stages backfill behind the rendered page.
  const stages = window.SURVEILLANCE_STAGES || {};
  const stageLabels = window.TCS_SURVEILLANCE_STAGE_LABELS || {};
  if (window.SURVEILLANCE_LOADING && SITES_RAW.length === 0 && CAMS_RAW.length === 0) {
    const stageList = ["summary", "cameras", "servers", "history"];
    const glyph = (s) => s === "done" ? "✓" : (s === "error" ? "!" : "…");
    const color = (s) => s === "done" ? "#3fb950" : (s === "error" ? "#f85149" : "#6e7681");
    return (
      <div className="tcs-boot" role="status" aria-live="polite">
        <div className="spinner" aria-hidden="true" />
        <div className="label">Loading surveillance fleet…</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 4 }}>
          {stageList.map(s => (
            <div key={s} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: "#8b949e" }}>
              <span style={{ display: "inline-block", width: 14, textAlign: "center", color: color(stages[s]) }}>
                {glyph(stages[s])}
              </span>
              <span>{stageLabels[s] || s}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Once the page is up, surface any still-pending stage as a small inline
  // pill in the header so operators see the cameras / servers / history
  // panels are still filling in rather than wondering why they're empty.
  const pendingStages = Object.keys(stages).filter(k => stages[k] === "pending");

  const densityVar = t.density === "spacious" ? 1.15 : t.density === "dense" ? 0.85 : 1;

  return (
    <div className="app" data-density={t.density} style={{ fontSize: `${13 * densityVar}px` }}>
      <NVRSidebar active="nvr-overview" />
      <div className="main">
        <NVRTopbar crumb={["Surveillance", "Milestone XProtect", "NOC Overview"]} />
        <div className="page-header">
          <div className="icon-btn" style={{ marginTop: 4 }}><Icon name="back" /></div>
          <div style={{ flex: 1 }}>
            <div className="host-title">
              <h1>Surveillance NOC</h1>
              <span className="ip">{M.managementServer}</span>
              <span className="role-tag faculty" style={{ fontSize: 10, padding: "1px 8px" }}>{M.product}</span>
            </div>
            <div className="host-meta">
              {(() => {
                const rsOnline = _nz(M.recordingServersOnline);
                const rsTotal  = _nz(M.recordingServers);
                const allUp    = rsTotal > 0 && rsOnline === rsTotal;
                const color    = allUp ? "var(--ok)" : (rsOnline > 0 ? "var(--warn)" : "var(--err)");
                const label    = rsTotal === 0
                  ? "No recording servers discovered"
                  : (allUp ? "All recording servers online" : `${rsOnline} / ${rsTotal} recording servers online`);
                return <span className="pill"><span className="dot" style={{ background: color }} /> {label}</span>;
              })()}
              <span className="pill"><span className="lbl">XProtect ver</span> <span className="v">{M.version}</span></span>
              <span className="pill"><span className="lbl">Cameras</span> <span className="v">{_nz(M.licenseDeviceUsed).toLocaleString()} / {_nz(M.licenseDeviceTotal).toLocaleString()} licensed</span></span>
              <span className="pill"><span className="lbl">Storage</span> <span className="v">{_nz(M.storageUsedTB).toFixed(1)} / {_nz(M.storageTotalTB)} TB</span></span>
              <span className="pill"><span className="lbl">Sites</span> <span>{SITES_RAW.length}</span></span>
              {pendingStages.length > 0 && (
                <span className="pill" title={pendingStages.map(s => stageLabels[s] || s).join(", ")}>
                  <span
                    className="dot"
                    style={{
                      background: "transparent",
                      width: 10, height: 10,
                      border: "2px solid #6e7681",
                      borderTopColor: "#d92929",
                      borderRadius: "50%",
                      animation: "tcs-spin 0.8s linear infinite"
                    }}
                  />
                  <span className="lbl">Loading</span>
                  <span>{pendingStages.map(s => (stageLabels[s] || s).replace(/^Loading\s+/, "")).join(" · ")}</span>
                </span>
              )}
            </div>
          </div>
          <div className="timerange">
            <Icon name="calendar" />
            <span className="range-val">Last 24h · live</span>
            <Icon name="chevron" />
          </div>
        </div>

        <div className="tabs">
          {(window.NVR_TABS || []).map(tab => (
            <div
              key={tab.id}
              className={"tab" + (activeTab === tab.id ? " active" : "")}
              onClick={() => { setActiveTab(tab.id); setTweak("activeTab", tab.id); }}
            >
              {tab.label}
              {tab.badge && <span className={"badge" + (tab.badge.kind ? " " + tab.badge.kind : "")}>{tab.badge.v}</span>}
            </div>
          ))}
        </div>

        <div className="body" data-screen-label={`Surveillance · ${activeTab}`}>
          {activeTab === "overview" && <FleetWidgets />}
          {activeTab === "sites"    && window.NvrTabSites    && <NvrTabSites />}
          {activeTab === "cameras"  && window.NvrTabCameras  && <NvrTabCameras />}
          {activeTab === "servers"  && window.NvrTabServers  && <NvrTabServers />}
          {activeTab === "alarms"   && window.NvrTabAlarms   && <NvrTabAlarms />}
          {activeTab === "storage"  && window.NvrTabStorage  && <NvrTabStorage />}
          {activeTab === "evidence" && window.NvrTabEvidence && <NvrTabEvidence />}
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
      </TweaksPanel>
    </div>
  );
};

ReactDOM.createRoot(document.getElementById("root")).render(<NVRApp />);
