// Servers dashboard app entry

const {
  useState: useStateSVA,
  useEffect: useEffectSVA
} = React;
const TWEAK_DEFAULTS_SV = /*EDITMODE-BEGIN*/{
  "density": "balanced",
  "accent": "#d92929",
  "showSourceBadges": true,
  "selectedServer": "arc-sql01",
  "showFleet": true,
  "showSidecar": true,
  "tab": "overview"
} /*EDITMODE-END*/;
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
  const allHosts = window.SERVER_SITES.flatMap(s => s.servers.map(sv => ({
    ...sv,
    site: s.name
  })));
  const PLACEHOLDER_HOST = {
    id: "—",
    hostid: "",
    fqdn: "No server selected",
    ip: "",
    role: "—",
    os: "—",
    model: "—",
    site: "—",
    cores: 0,
    ram: 0,
    diskTb: 0,
    cpu: 0,
    mem: 0,
    diskPct: 0,
    netMbps: 0,
    uptimeDays: 0,
    status: "ok",
    problems: 0,
    kind: "phys"
  };
  const host = allHosts.find(h => h.id === activeId) || allHosts.find(h => h.selected) || allHosts[0] || PLACEHOLDER_HOST;

  // Whenever the active host changes (initial mount included), tell the
  // bridge to refetch with the new hostid. That's what populates the
  // Services / Procs / Network tabs (collectActive on the server).
  useEffectSVA(() => {
    if (host && host.hostid && typeof window.tcsServersSetActive === "function") {
      window.tcsServersSetActive(host.hostid);
    }
  }, [host && host.hostid]);
  const onSelect = sv => {
    setActiveId(sv.id);
    setTweak("selectedServer", sv.id);
    if (sv.hostid && typeof window.tcsServersSetActive === "function") {
      window.tcsServersSetActive(sv.hostid);
    }
  };
  const densityVar = t.density === "spacious" ? 1.15 : t.density === "dense" ? 0.85 : 1;
  const tabs = [["overview", "Overview", null], ["fs", "Filesystems", null], ["services", "Services", null], ["procs", "Processes", null], ["net", "Network", null], ["sessions", "Sessions", null], ["graphs", "Graphs", null], ["alerts", "Alerts", "2"], ["config", "Configuration", null]];
  const TabView = (() => {
    switch (tab) {
      case "overview":
        return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(ServerKPIs, {
          host: host
        }), /*#__PURE__*/React.createElement("div", {
          style: {
            display: "grid",
            gridTemplateColumns: "1.4fr 1fr",
            gap: 14
          }
        }, /*#__PURE__*/React.createElement(FilesystemsCard, null), /*#__PURE__*/React.createElement(ServerProblems, null)), /*#__PURE__*/React.createElement("div", {
          style: {
            marginTop: 14
          }
        }, /*#__PURE__*/React.createElement(ServicesCard, null)));
      case "fs":
        return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(ServerKPIs, {
          host: host
        }), /*#__PURE__*/React.createElement(FilesystemsCard, null));
      case "services":
        return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(ServerKPIs, {
          host: host
        }), /*#__PURE__*/React.createElement(ServicesCard, null));
      case "procs":
        return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(ServerKPIs, {
          host: host
        }), /*#__PURE__*/React.createElement(TopProcsCard, null));
      case "net":
        return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(ServerKPIs, {
          host: host
        }), /*#__PURE__*/React.createElement(InterfacesCard, null));
      case "sessions":
        return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(ServerKPIs, {
          host: host
        }), /*#__PURE__*/React.createElement(SessionsCard, null));
      case "alerts":
        return /*#__PURE__*/React.createElement(ServerProblems, null);
      default:
        return /*#__PURE__*/React.createElement("div", {
          className: "card",
          style: {
            padding: 60,
            textAlign: "center",
            color: "var(--muted)"
          }
        }, /*#__PURE__*/React.createElement("div", {
          style: {
            fontSize: 14
          }
        }, "The ", /*#__PURE__*/React.createElement("span", {
          style: {
            color: "var(--fg)",
            textTransform: "capitalize"
          }
        }, tab), " tab is part of the roadmap."), /*#__PURE__*/React.createElement("div", {
          style: {
            fontSize: 11,
            marginTop: 6
          }
        }, "Backed by Zabbix history API."));
    }
  })();
  const Body = /*#__PURE__*/React.createElement(React.Fragment, null, t.showSidecar ? /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gridTemplateColumns: "300px 1fr",
      gap: 14
    }
  }, /*#__PURE__*/React.createElement(ServerSidecar, {
    host: host
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      minWidth: 0
    }
  }, TabView)) : TabView);
  return /*#__PURE__*/React.createElement("div", {
    className: "app",
    "data-density": t.density,
    style: {
      fontSize: `${13 * densityVar}px`
    }
  }, /*#__PURE__*/React.createElement(NVRSidebar, {
    active: "zbx-servers"
  }), /*#__PURE__*/React.createElement("div", {
    className: "main"
  }, /*#__PURE__*/React.createElement(NVRTopbar, {
    crumb: ["Infrastructure", "Servers", host.site, host.id]
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
  }, /*#__PURE__*/React.createElement("h1", null, host.id), /*#__PURE__*/React.createElement("span", {
    className: "ip"
  }, host.ip), /*#__PURE__*/React.createElement("span", {
    className: "role-tag av",
    style: {
      fontSize: 10,
      padding: "1px 8px"
    }
  }, host.kind === "phys" ? "PHYS" : "VM", " \xB7 ", host.os)), /*#__PURE__*/React.createElement("div", {
    className: "host-meta"
  }, /*#__PURE__*/React.createElement("span", {
    className: "pill"
  }, /*#__PURE__*/React.createElement("span", {
    className: "dot",
    style: {
      background: host.status === "ok" ? "var(--ok)" : host.status === "warn" ? "var(--warn)" : "var(--err)"
    }
  }), host.status === "ok" ? "Online" : host.status === "warn" ? "Degraded" : "Critical"), /*#__PURE__*/React.createElement("span", {
    className: "pill"
  }, /*#__PURE__*/React.createElement("span", {
    className: "lbl"
  }, "Role"), " ", /*#__PURE__*/React.createElement("span", null, host.role)), /*#__PURE__*/React.createElement("span", {
    className: "pill"
  }, /*#__PURE__*/React.createElement("span", {
    className: "lbl"
  }, "Hardware"), " ", /*#__PURE__*/React.createElement("span", null, host.model)), /*#__PURE__*/React.createElement("span", {
    className: "pill"
  }, /*#__PURE__*/React.createElement("span", {
    className: "lbl"
  }, "CPU"), " ", /*#__PURE__*/React.createElement("span", {
    className: "v"
  }, host.cores, " cores \xB7 ", host.cpu, "%")), /*#__PURE__*/React.createElement("span", {
    className: "pill"
  }, /*#__PURE__*/React.createElement("span", {
    className: "lbl"
  }, "RAM"), " ", /*#__PURE__*/React.createElement("span", {
    className: "v"
  }, host.ram, " GB \xB7 ", host.mem, "%")), /*#__PURE__*/React.createElement("span", {
    className: "pill"
  }, /*#__PURE__*/React.createElement("span", {
    className: "lbl"
  }, "Site"), " ", /*#__PURE__*/React.createElement("span", null, host.site)), /*#__PURE__*/React.createElement("span", {
    className: "pill"
  }, /*#__PURE__*/React.createElement("span", {
    className: "lbl"
  }, "Uptime"), " ", /*#__PURE__*/React.createElement("span", {
    className: "v"
  }, host.uptimeDays, "d")))), /*#__PURE__*/React.createElement("div", {
    className: "timerange"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "calendar"
  }), /*#__PURE__*/React.createElement("span", {
    className: "range-val"
  }, "May 9, 2026 09:42 \u2014 May 10, 2026 09:42"), /*#__PURE__*/React.createElement(Icon, {
    name: "chevron"
  }))), /*#__PURE__*/React.createElement("div", {
    className: "tabs"
  }, tabs.map(([k, l, b]) => /*#__PURE__*/React.createElement("div", {
    key: k,
    className: `tab ${tab === k ? "active" : ""}`,
    onClick: () => {
      setTab(k);
      setTweak("tab", k);
    }
  }, l, b && /*#__PURE__*/React.createElement("span", {
    className: `badge ${k === "alerts" ? "warn" : ""}`
  }, b)))), /*#__PURE__*/React.createElement("div", {
    className: "body",
    "data-screen-label": `Server · ${host.id} · ${tab}`
  }, /*#__PURE__*/React.createElement("div", {
    className: "zbx-layout"
  }, /*#__PURE__*/React.createElement(ServerNavigator, {
    activeId: activeId,
    onSelect: onSelect,
    query: query,
    setQuery: setQuery
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      minWidth: 0
    }
  }, Body)))), /*#__PURE__*/React.createElement(TweaksPanel, {
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
  }), /*#__PURE__*/React.createElement(TweakToggle, {
    label: "Show device sidecar",
    value: t.showSidecar,
    onChange: v => setTweak("showSidecar", v)
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
  })), /*#__PURE__*/React.createElement(TweakSection, {
    title: "Server view"
  }, /*#__PURE__*/React.createElement(TweakSelect, {
    label: "Active host",
    value: activeId,
    options: allHosts.map(h => ({
      value: h.id,
      label: `${h.id} — ${h.role}`
    })),
    onChange: v => {
      setActiveId(v);
      setTweak("selectedServer", v);
    }
  }))));
};
ReactDOM.createRoot(document.getElementById("root")).render(/*#__PURE__*/React.createElement(ServersApp, null));