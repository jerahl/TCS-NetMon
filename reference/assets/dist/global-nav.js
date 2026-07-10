// Unified sidebar + topbar used by every page in the project.
// Pass `active` to highlight the current page. Values:
//   "global"        — Global Dashboard
//   "xiq"           — XIQ Wireless Status (fleet overview)
//   "wireless"      — Wireless APs (AP Detail / Zabbix Dashboard)
//   "switches"      — Switches Dashboard
//   "firewall"      — FortiGate Firewall Dashboard
//   "zbx-servers"   — Servers Dashboard
//   "zbx-status"    — Zabbix Server Status (server + proxy health)
//   "voip"          — VoIP · 3CX Dashboard
//   "xdr"           — Cortex XDR Dashboard
//   "problems"      — Problems list
//   "events"        — Events Console
//   "clients"       — PacketFence Connected Devices
//   "nac"           — PacketFence NAC Policies
//   "sessions"      — PacketFence User Sessions
//   "quar"          — PacketFence Quarantine
//   "pf-status"     — PacketFence Cluster Status
//   "nvr-overview"  — Surveillance Dashboard
//   "nvr-cameras"   — Camera Detail
//   "nvr-servers"   — Recording Server Detail

// Centralised URLs of every page in this module + the default Zabbix UI.
// All sidebars read from this object, so renaming an action only requires a
// change here.
window.TCS_NAV = window.TCS_NAV || {
  zabbixDefault: "zabbix.php?action=dashboard.view",
  global: "zabbix.php?action=tcs.global.view",
  apDetail: "zabbix.php?action=tcs.dashboard.view",
  xiqStatus: "zabbix.php?action=tcs.xiq.view",
  switches: "zabbix.php?action=tcs.switches.view",
  servers: "zabbix.php?action=tcs.servers.view",
  zbxStatus: "zabbix.php?action=tcs.zbx.status.view",
  problems: "zabbix.php?action=tcs.problems.view",
  events: "zabbix.php?action=tcs.events.view",
  surveillance: "zabbix.php?action=tcs.surveillance.view",
  cameraDetail: "zabbix.php?action=tcs.camera.view",
  serverDetail: "zabbix.php?action=tcs.server.view",
  fortigate: "zabbix.php?action=tcs.fortigate.view",
  voip: "zabbix.php?action=tcs.voip.view",
  xdr: "zabbix.php?action=tcs.xdr.view",
  pfClients: "zabbix.php?action=tcs.pf.clients.view",
  pfNac: "zabbix.php?action=tcs.pf.nac.view",
  pfSessions: "zabbix.php?action=tcs.pf.sessions.view",
  pfQuarantine: "zabbix.php?action=tcs.pf.quarantine.view",
  pfStatus: "zabbix.php?action=tcs.pf.status.view"
};
const TCS_SIDEBAR_STORAGE_KEY = "tcs.sidebar.collapsed";
const GlobalSidebar = ({
  active
}) => {
  const NAV = window.TCS_NAV;
  const [collapsed, setCollapsed] = React.useState(() => {
    try {
      return window.localStorage.getItem(TCS_SIDEBAR_STORAGE_KEY) === "1";
    } catch (e) {
      return false;
    }
  });
  React.useEffect(() => {
    const app = document.querySelector(".app");
    if (app) app.classList.toggle("sidebar-collapsed", collapsed);
    try {
      window.localStorage.setItem(TCS_SIDEBAR_STORAGE_KEY, collapsed ? "1" : "0");
    } catch (e) {/* storage unavailable — toggle is still in-memory */}
  }, [collapsed]);
  const toggle = () => setCollapsed(c => !c);
  const item = (key, href, icon, label, count, countClass) => /*#__PURE__*/React.createElement("a", {
    className: "nav-item" + (active === key ? " active" : ""),
    href: href,
    title: collapsed ? label : undefined
  }, /*#__PURE__*/React.createElement(Icon, {
    name: icon
  }), " ", /*#__PURE__*/React.createElement("span", {
    className: "nav-label-text"
  }, label), count !== undefined && /*#__PURE__*/React.createElement("span", {
    className: "nav-count" + (countClass ? " " + countClass : "")
  }, count));
  return /*#__PURE__*/React.createElement("aside", {
    className: "sidebar" + (collapsed ? " collapsed" : "")
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: "sidebar-toggle",
    onClick: toggle,
    title: collapsed ? "Expand sidebar" : "Collapse sidebar",
    "aria-label": collapsed ? "Expand sidebar" : "Collapse sidebar",
    "aria-expanded": !collapsed
  }, /*#__PURE__*/React.createElement(Icon, {
    name: collapsed ? "sidebar-expand" : "sidebar-collapse"
  })), /*#__PURE__*/React.createElement("a", {
    className: "back-to-zabbix",
    href: NAV.zabbixDefault,
    title: "Back to default Zabbix UI"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "back"
  }), " ", /*#__PURE__*/React.createElement("span", null, "Default Zabbix Dashboard")), /*#__PURE__*/React.createElement("div", {
    className: "brand"
  }, /*#__PURE__*/React.createElement("div", {
    className: "brand-mark"
  }, "Z\xB7P"), /*#__PURE__*/React.createElement("div", {
    className: "brand-text"
  }, /*#__PURE__*/React.createElement("div", {
    className: "brand-name"
  }, "Zabbix \xB7 TCS"), /*#__PURE__*/React.createElement("div", {
    className: "brand-sub"
  }, "Network operations"))), /*#__PURE__*/React.createElement("div", {
    className: "nav-section"
  }, /*#__PURE__*/React.createElement("div", {
    className: "nav-label"
  }, "Monitoring"), item("global", NAV.global, "map", "Global Dashboard"), item("xiq", NAV.xiqStatus, "ap", "XIQ · Status", "1,184"), item("wireless", NAV.apDetail, "wifi", "Wireless APs"), item("switches", NAV.switches, "ethernet", "Switches", "312"), item("firewall", NAV.fortigate, "firewall", "Firewall", "2"), item("zbx-servers", NAV.servers, "ap", "Servers", "17"), item("zbx-status", NAV.zbxStatus, "refresh", "ZBX · Status"), item("voip", NAV.voip, "phone", "VoIP · 3CX", "204"), item("xdr", NAV.xdr, "crosshair", "Cortex XDR", "23", "warn"), item("problems", NAV.problems, "alert", "Problems"), item("events", NAV.events, "events", "Events Console")), /*#__PURE__*/React.createElement("div", {
    className: "nav-section"
  }, /*#__PURE__*/React.createElement("div", {
    className: "nav-label"
  }, "Identity (PacketFence)"), item("clients", NAV.pfClients, "clients", "Connected Devices", "12,847"), item("nac", NAV.pfNac, "shield", "NAC Policies"), item("sessions", NAV.pfSessions, "user", "User Sessions"), item("quar", NAV.pfQuarantine, "lock", "Quarantine", "2", "warn"), item("pf-status", NAV.pfStatus, "ap", "PF · Cluster Status")), /*#__PURE__*/React.createElement("div", {
    className: "nav-section"
  }, /*#__PURE__*/React.createElement("div", {
    className: "nav-label"
  }, "Surveillance (Milestone)"), item("nvr-overview", NAV.surveillance, "map", "NOC Overview"), item("nvr-cameras", NAV.cameraDetail, "ap", "Cameras", "1,147"), item("nvr-servers", NAV.serverDetail, "ethernet", "Recording Servers", "8"), item("nvr-evid", NAV.surveillance, "shield", "Evidence Lock", "7"), item("nvr-alarms", NAV.surveillance, "alert", "VMS Alarms", "12", "warn")), /*#__PURE__*/React.createElement("div", {
    className: "sidebar-footer"
  }, /*#__PURE__*/React.createElement("div", {
    className: "sf-row"
  }, /*#__PURE__*/React.createElement("span", {
    className: "sf-k"
  }, "Zabbix Server"), /*#__PURE__*/React.createElement("span", {
    className: "sf-v ok"
  }, "\u25CF 7.4.9")), /*#__PURE__*/React.createElement("div", {
    className: "sf-row"
  }, /*#__PURE__*/React.createElement("span", {
    className: "sf-k"
  }, "PacketFence API"), /*#__PURE__*/React.createElement("span", {
    className: "sf-v ok"
  }, "\u25CF v15")), /*#__PURE__*/React.createElement("div", {
    className: "sf-row"
  }, /*#__PURE__*/React.createElement("span", {
    className: "sf-k"
  }, "XProtect Mgmt"), /*#__PURE__*/React.createElement("span", {
    className: "sf-v ok"
  }, "\u25CF 25.3 R2"))));
};
const GlobalTopbar = ({
  crumb,
  search = "Find host, MAC, user, IP…",
  onRefresh,
  refreshing
}) => /*#__PURE__*/React.createElement("div", {
  className: "topbar"
}, /*#__PURE__*/React.createElement("div", {
  className: "icon-btn"
}, /*#__PURE__*/React.createElement(Icon, {
  name: "back"
})), /*#__PURE__*/React.createElement("div", {
  className: "crumb"
}, (crumb || ["Global", "Overview"]).map((c, i, arr) => /*#__PURE__*/React.createElement(React.Fragment, {
  key: i
}, i > 0 && /*#__PURE__*/React.createElement("span", {
  className: "sep"
}, "/"), /*#__PURE__*/React.createElement("span", {
  className: i === arr.length - 1 ? "seg" : ""
}, c)))), /*#__PURE__*/React.createElement("div", {
  className: "spacer"
}), /*#__PURE__*/React.createElement("div", {
  className: "search"
}, /*#__PURE__*/React.createElement(Icon, {
  name: "search"
}), /*#__PURE__*/React.createElement("input", {
  placeholder: search,
  readOnly: true
}), /*#__PURE__*/React.createElement("kbd", null, "\u2318K")), /*#__PURE__*/React.createElement("div", {
  className: "icon-btn",
  title: refreshing ? "Refreshing…" : "Refresh",
  onClick: onRefresh,
  style: {
    cursor: onRefresh ? "pointer" : "default",
    opacity: refreshing ? 0.5 : 1
  }
}, /*#__PURE__*/React.createElement(Icon, {
  name: "refresh"
})), /*#__PURE__*/React.createElement("div", {
  className: "icon-btn",
  title: "More"
}, /*#__PURE__*/React.createElement(Icon, {
  name: "more"
})));

// ───────── Global command palette (⌘K) ─────────
// Live search across Zabbix hosts (switches / APs / cameras / servers) and
// PacketFence endpoints (clients + users, with switch-session info). Backed
// by tcs.search.data. Self-mounts a single overlay into <body> on every page
// that loads this file, so the topbar search box and ⌘K work everywhere
// without each page having to wire it up.
const GlobalCommandPalette = () => {
  const [open, setOpen] = React.useState(false);
  const [q, setQ] = React.useState("");
  const [results, setResults] = React.useState([]);
  const [sel, setSel] = React.useState(0);
  const [loading, setLoading] = React.useState(false);
  const reqRef = React.useRef(0);
  const close = React.useCallback(() => {
    setOpen(false);
    setQ("");
    setResults([]);
    setSel(0);
  }, []);

  // Open on ⌘K / Ctrl+K, or when the operator clicks a topbar search box.
  React.useEffect(() => {
    const onKey = e => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setOpen(o => !o);
      }
    };
    const onClick = e => {
      const box = e.target.closest && e.target.closest(".topbar .search");
      if (box) {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("click", onClick, true);
    };
  }, []);

  // Debounced fetch against the search endpoint.
  React.useEffect(() => {
    if (!open) return;
    const term = q.trim();
    if (term.length < 2) {
      setResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const id = ++reqRef.current;
    const t = setTimeout(() => {
      fetch("zabbix.php?action=tcs.search.data&q=" + encodeURIComponent(term), {
        credentials: "same-origin",
        headers: {
          "Accept": "application/json"
        }
      }).then(r => r.json()).then(d => {
        if (id !== reqRef.current) return; // a newer keystroke won
        setResults(Array.isArray(d.results) ? d.results : []);
        setSel(0);
        setLoading(false);
      }).catch(() => {
        if (id !== reqRef.current) return;
        setResults([]);
        setLoading(false);
      });
    }, 220);
    return () => clearTimeout(t);
  }, [q, open]);

  // Keyboard navigation within the open palette.
  React.useEffect(() => {
    if (!open) return;
    const onKey = e => {
      if (e.key === "Escape") {
        close();
      } else if (e.key === "ArrowDown") {
        setSel(s => Math.min(results.length - 1, s + 1));
        e.preventDefault();
      } else if (e.key === "ArrowUp") {
        setSel(s => Math.max(0, s - 1));
        e.preventDefault();
      } else if (e.key === "Enter") {
        const it = results[sel];
        if (it && it.href) window.location.href = it.href;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, results, sel, close]);
  if (!open) return null;
  const term = q.trim();
  return /*#__PURE__*/React.createElement("div", {
    className: "scrim",
    onClick: close
  }, /*#__PURE__*/React.createElement("div", {
    className: "palette",
    onClick: e => e.stopPropagation()
  }, /*#__PURE__*/React.createElement("input", {
    className: "palette-input",
    autoFocus: true,
    spellCheck: false,
    placeholder: "Find host, MAC, user, IP\u2026",
    value: q,
    onChange: e => {
      setQ(e.target.value);
      setSel(0);
    }
  }), /*#__PURE__*/React.createElement("div", {
    className: "palette-list"
  }, results.map((it, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    className: "palette-item" + (i === sel ? " active" : ""),
    onMouseEnter: () => setSel(i),
    onClick: () => {
      if (it.href) window.location.href = it.href;
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: it.icon || "search",
    size: 14
  }), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", null, it.label), it.sub ? /*#__PURE__*/React.createElement("div", {
    className: "pi-mac"
  }, it.sub) : null), /*#__PURE__*/React.createElement("span", {
    className: "pi-cat"
  }, it.cat))), results.length === 0 && /*#__PURE__*/React.createElement("div", {
    className: "palette-item",
    style: {
      cursor: "default",
      color: "var(--muted)"
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "search",
    size: 14
  }), /*#__PURE__*/React.createElement("div", null, term.length < 2 ? "Type at least 2 characters…" : loading ? "Searching…" : "No matches for “" + term + "”")))));
};

// Mount the palette once into its own root so it's available on every page
// regardless of which app owns the main React tree.
(function mountGlobalCommandPalette() {
  if (window.__tcsSearchMounted) return;
  window.__tcsSearchMounted = true;
  const boot = () => {
    if (!window.React || !window.ReactDOM || !window.ReactDOM.createRoot || !window.Icon) {
      return setTimeout(boot, 50);
    }
    let el = document.getElementById("tcs-global-search-root");
    if (!el) {
      el = document.createElement("div");
      el.id = "tcs-global-search-root";
      document.body.appendChild(el);
    }
    window.ReactDOM.createRoot(el).render(/*#__PURE__*/React.createElement(GlobalCommandPalette, null));
  };
  boot();
})();
window.GlobalCommandPalette = GlobalCommandPalette;
window.GlobalSidebar = GlobalSidebar;
window.GlobalTopbar = GlobalTopbar;
// Back-compat shims so older code that referenced NVRSidebar / NVRTopbar
// still resolves. New pages should use GlobalSidebar / GlobalTopbar directly.
window.NVRSidebar = GlobalSidebar;
window.NVRTopbar = GlobalTopbar;