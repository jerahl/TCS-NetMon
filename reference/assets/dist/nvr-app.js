// Surveillance overview app entry

const {
  useState: useStateOV,
  useEffect: useEffectOV
} = React;

// Safety defaults — if surveillance-bridge.jsx hasn't finished publishing
// yet, or if a refresh swapped MILESTONE for a partial object, fall back
// here rather than throwing on .toFixed / .toLocaleString.
const MS_DEFAULTS = {
  product: "—",
  version: "—",
  managementServer: "—",
  licenseDeviceTotal: 0,
  licenseDeviceUsed: 0,
  licenseHwTotal: 0,
  recordingServers: 0,
  recordingServersOnline: 0,
  failoverServers: 0,
  mobileServers: 0,
  smartClientSessions: 0,
  webClientSessions: 0,
  activeAlarms: 0,
  alarmsAck: 0,
  retentionDays: 0,
  storageTotalTB: 0,
  storageUsedTB: 0,
  evidenceLockSlots: 0,
  evidenceLockUsed: 0
};
const _ms = () => Object.assign({}, MS_DEFAULTS, window.MILESTONE || {});
const _nz = (v, d = 0) => typeof v === "number" && !Number.isNaN(v) ? v : d;
const TWEAK_DEFAULTS_OV = /*EDITMODE-BEGIN*/{
  "density": "balanced",
  "accent": "#d92929",
  "showSourceBadges": true,
  "activeTab": "overview"
} /*EDITMODE-END*/;
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
  const CAMS_RAW = Array.isArray(window.CAMERAS) ? window.CAMERAS : [];
  const SRVS_RAW = Array.isArray(window.SERVERS) ? window.SERVERS : [];

  // First load: the bridge hasn't returned the fleet yet. Hold the boot
  // splash (instead of an empty shell) until the first fetch lands.
  if (window.SURVEILLANCE_LOADING && SITES_RAW.length === 0 && CAMS_RAW.length === 0) {
    return /*#__PURE__*/React.createElement("div", {
      className: "tcs-boot",
      role: "status",
      "aria-live": "polite"
    }, /*#__PURE__*/React.createElement("div", {
      className: "spinner",
      "aria-hidden": "true"
    }), /*#__PURE__*/React.createElement("div", {
      className: "label"
    }, "Loading surveillance fleet\u2026"));
  }
  const densityVar = t.density === "spacious" ? 1.15 : t.density === "dense" ? 0.85 : 1;
  return /*#__PURE__*/React.createElement("div", {
    className: "app",
    "data-density": t.density,
    style: {
      fontSize: `${13 * densityVar}px`
    }
  }, /*#__PURE__*/React.createElement(NVRSidebar, {
    active: "nvr-overview"
  }), /*#__PURE__*/React.createElement("div", {
    className: "main"
  }, /*#__PURE__*/React.createElement(NVRTopbar, {
    crumb: ["Surveillance", "Milestone XProtect", "NOC Overview"]
  }), /*#__PURE__*/React.createElement("div", {
    className: "page-header"
  }, /*#__PURE__*/React.createElement("div", {
    className: "icon-btn",
    style: {
      marginTop: 4
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "back"
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "host-title"
  }, /*#__PURE__*/React.createElement("h1", null, "Surveillance NOC"), /*#__PURE__*/React.createElement("span", {
    className: "ip"
  }, M.managementServer), /*#__PURE__*/React.createElement("span", {
    className: "role-tag faculty",
    style: {
      fontSize: 10,
      padding: "1px 8px"
    }
  }, M.product)), /*#__PURE__*/React.createElement("div", {
    className: "host-meta"
  }, (() => {
    const rsOnline = _nz(M.recordingServersOnline);
    const rsTotal = _nz(M.recordingServers);
    const allUp = rsTotal > 0 && rsOnline === rsTotal;
    const color = allUp ? "var(--ok)" : rsOnline > 0 ? "var(--warn)" : "var(--err)";
    const label = rsTotal === 0 ? "No recording servers discovered" : allUp ? "All recording servers online" : `${rsOnline} / ${rsTotal} recording servers online`;
    return /*#__PURE__*/React.createElement("span", {
      className: "pill"
    }, /*#__PURE__*/React.createElement("span", {
      className: "dot",
      style: {
        background: color
      }
    }), " ", label);
  })(), /*#__PURE__*/React.createElement("span", {
    className: "pill"
  }, /*#__PURE__*/React.createElement("span", {
    className: "lbl"
  }, "XProtect ver"), " ", /*#__PURE__*/React.createElement("span", {
    className: "v"
  }, M.version)), /*#__PURE__*/React.createElement("span", {
    className: "pill"
  }, /*#__PURE__*/React.createElement("span", {
    className: "lbl"
  }, "Cameras"), " ", /*#__PURE__*/React.createElement("span", {
    className: "v"
  }, _nz(M.licenseDeviceUsed).toLocaleString(), " / ", _nz(M.licenseDeviceTotal).toLocaleString(), " licensed")), /*#__PURE__*/React.createElement("span", {
    className: "pill"
  }, /*#__PURE__*/React.createElement("span", {
    className: "lbl"
  }, "Storage"), " ", /*#__PURE__*/React.createElement("span", {
    className: "v"
  }, _nz(M.storageUsedTB).toFixed(1), " / ", _nz(M.storageTotalTB), " TB")), /*#__PURE__*/React.createElement("span", {
    className: "pill"
  }, /*#__PURE__*/React.createElement("span", {
    className: "lbl"
  }, "Sites"), " ", /*#__PURE__*/React.createElement("span", null, SITES_RAW.length)))), /*#__PURE__*/React.createElement("div", {
    className: "timerange"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "calendar"
  }), /*#__PURE__*/React.createElement("span", {
    className: "range-val"
  }, "Last 24h \xB7 live"), /*#__PURE__*/React.createElement(Icon, {
    name: "chevron"
  }))), /*#__PURE__*/React.createElement("div", {
    className: "tabs"
  }, (window.NVR_TABS || []).map(tab => /*#__PURE__*/React.createElement("div", {
    key: tab.id,
    className: "tab" + (activeTab === tab.id ? " active" : ""),
    onClick: () => {
      setActiveTab(tab.id);
      setTweak("activeTab", tab.id);
    }
  }, tab.label, tab.badge && /*#__PURE__*/React.createElement("span", {
    className: "badge" + (tab.badge.kind ? " " + tab.badge.kind : "")
  }, tab.badge.v)))), /*#__PURE__*/React.createElement("div", {
    className: "body",
    "data-screen-label": `Surveillance · ${activeTab}`
  }, activeTab === "overview" && /*#__PURE__*/React.createElement(FleetWidgets, null), activeTab === "sites" && window.NvrTabSites && /*#__PURE__*/React.createElement(NvrTabSites, null), activeTab === "cameras" && window.NvrTabCameras && /*#__PURE__*/React.createElement(NvrTabCameras, null), activeTab === "servers" && window.NvrTabServers && /*#__PURE__*/React.createElement(NvrTabServers, null), activeTab === "alarms" && window.NvrTabAlarms && /*#__PURE__*/React.createElement(NvrTabAlarms, null), activeTab === "storage" && window.NvrTabStorage && /*#__PURE__*/React.createElement(NvrTabStorage, null), activeTab === "evidence" && window.NvrTabEvidence && /*#__PURE__*/React.createElement(NvrTabEvidence, null))), /*#__PURE__*/React.createElement(TweaksPanel, {
    title: "Tweaks"
  }, /*#__PURE__*/React.createElement(TweakSection, {
    title: "Layout"
  }, /*#__PURE__*/React.createElement(TweakRadio, {
    label: "Density",
    value: t.density,
    options: [{
      value: "spacious",
      label: "Spacious"
    }, {
      value: "balanced",
      label: "Balanced"
    }, {
      value: "dense",
      label: "Dense"
    }],
    onChange: v => setTweak("density", v)
  })), /*#__PURE__*/React.createElement(TweakSection, {
    title: "Visual"
  }, /*#__PURE__*/React.createElement(TweakColor, {
    label: "Primary accent",
    value: t.accent,
    options: ["#d92929", "#5b8cff", "#34d399", "#7c5cff", "#f5b300"],
    onChange: v => setTweak("accent", v)
  }), /*#__PURE__*/React.createElement(TweakToggle, {
    label: "Show data-source badges",
    value: t.showSourceBadges,
    onChange: v => setTweak("showSourceBadges", v)
  }))));
};
ReactDOM.createRoot(document.getElementById("root")).render(/*#__PURE__*/React.createElement(NVRApp, null));