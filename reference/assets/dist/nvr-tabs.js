// Surveillance NOC — Sites / Cameras / Recording Servers / Alarms /
// Storage / Evidence Lock tab views. Ported from the design package,
// adapted to use the live bridge state (no mock fixtures).
//
// Defensive reads everywhere — the bridge always publishes the
// MILESTONE / SITES / SERVERS / CAMERAS / VMS_ALARMS globals, but
// SITE_DETAILS and EVIDENCE_LOCKS aren't yet templated on the
// backend; both default to an empty object / array so the tabs
// render an honest empty state instead of crashing.

const {
  useState: useStateNVT,
  useMemo: useMemoNVT
} = React;
const _tabsNz = (v, d = 0) => typeof v === "number" && !Number.isNaN(v) ? v : d;
const _tabsArr = v => Array.isArray(v) ? v : [];
const _tabsObj = v => v && typeof v === "object" && !Array.isArray(v) ? v : {};

// Empty-state renderer reused across tabs.
const _TabEmpty = ({
  children
}) => /*#__PURE__*/React.createElement("div", {
  className: "card",
  style: {
    padding: 32,
    textAlign: "center",
    color: "var(--muted)"
  }
}, children);

// ─────────────────────────────────────────────────────────────
// SITES
// ─────────────────────────────────────────────────────────────
const NvrTabSites = () => {
  const S = _tabsArr(window.SITES);
  const D = _tabsObj(window.SITE_DETAILS);
  const total = S.reduce((a, x) => a + _tabsNz(x.cams), 0);
  const online = S.reduce((a, x) => a + _tabsNz(x.online), 0);
  if (S.length === 0) {
    return /*#__PURE__*/React.createElement("div", {
      className: "tab-pane"
    }, /*#__PURE__*/React.createElement(_TabEmpty, null, "No Milestone sites discovered yet."));
  }
  const edges = Object.values(D).reduce((a, d) => a + _tabsNz(d.edges), 0);
  return /*#__PURE__*/React.createElement("div", {
    className: "tab-pane"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card",
    style: {
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "stat-grid"
  }, /*#__PURE__*/React.createElement("div", {
    className: "stat-cell"
  }, /*#__PURE__*/React.createElement("div", {
    className: "lbl"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "ap",
    size: 11
  }), " Sites ", /*#__PURE__*/React.createElement(SourceBadge, {
    src: "ext"
  })), /*#__PURE__*/React.createElement("div", {
    className: "val"
  }, S.length, /*#__PURE__*/React.createElement("span", {
    className: "u"
  }, "campuses")), /*#__PURE__*/React.createElement("div", {
    className: "sub"
  }, edges ? `${edges} edge buildings` : "—")), /*#__PURE__*/React.createElement("div", {
    className: "stat-cell"
  }, /*#__PURE__*/React.createElement("div", {
    className: "lbl"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "ap",
    size: 11
  }), " Cameras (site total)"), /*#__PURE__*/React.createElement("div", {
    className: "val"
  }, online.toLocaleString(), /*#__PURE__*/React.createElement("span", {
    className: "u"
  }, "/ ", total.toLocaleString())), /*#__PURE__*/React.createElement("div", {
    className: "sub ok"
  }, total > 0 ? `${(online / total * 100).toFixed(1)}% online` : "—")), /*#__PURE__*/React.createElement("div", {
    className: "stat-cell"
  }, /*#__PURE__*/React.createElement("div", {
    className: "lbl"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "ethernet",
    size: 11
  }), " Sites w/ issues"), /*#__PURE__*/React.createElement("div", {
    className: "val",
    style: {
      color: "var(--warn)"
    }
  }, S.filter(s => s.warn || s.err).length), /*#__PURE__*/React.createElement("div", {
    className: "sub warn"
  }, S.filter(s => s.err).length, " with offline cameras")), /*#__PURE__*/React.createElement("div", {
    className: "stat-cell"
  }, /*#__PURE__*/React.createElement("div", {
    className: "lbl"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "alert",
    size: 11
  }), " Storage near limit"), /*#__PURE__*/React.createElement("div", {
    className: "val",
    style: {
      color: "var(--warn)"
    }
  }, S.filter(s => _tabsNz(s.storageCapGB, 1) && s.storageGB / s.storageCapGB > 0.9).length, /*#__PURE__*/React.createElement("span", {
    className: "u"
  }, "/ ", S.length)), /*#__PURE__*/React.createElement("div", {
    className: "sub"
  }, "retention may roll early")))), /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "Sites & campus rollup"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "ext"
  }), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("span", {
    className: "h-meta"
  }, "click any site to drill into XProtect site view")), /*#__PURE__*/React.createElement("table", {
    className: "link-tbl nvr-tbl"
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", {
    style: {
      width: 24
    }
  }), /*#__PURE__*/React.createElement("th", null, "Site"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 140
    }
  }, "Recording server"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 90,
      textAlign: "right"
    }
  }, "Cameras"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 100
    }
  }, "Health"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 220
    }
  }, "Storage"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 110
    }
  }, "Network"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 60,
      textAlign: "right"
    }
  }, "APs"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 32
    }
  }))), /*#__PURE__*/React.createElement("tbody", null, S.map(s => {
    const d = D[s.name] || {};
    const cap = _tabsNz(s.storageCapGB, 1);
    const pct = cap > 0 ? _tabsNz(s.storageGB) / cap * 100 : 0;
    const state = s.err ? "err" : s.warn ? "warn" : "ok";
    return /*#__PURE__*/React.createElement("tr", {
      key: s.name
    }, /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement(StatusDot, {
      state: state
    })), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("div", {
      style: {
        color: "var(--fg)",
        fontWeight: 500
      }
    }, s.name), /*#__PURE__*/React.createElement("div", {
      style: {
        color: "var(--muted)",
        fontSize: 10.5
      }
    }, [d.address, d.edges ? `${d.edges} buildings` : null, d.switches ? `${d.switches} switches` : null].filter(Boolean).join(" · ") || "—")), /*#__PURE__*/React.createElement("td", {
      className: "mono",
      style: {
        color: "var(--accent)"
      }
    }, s.server || "—"), /*#__PURE__*/React.createElement("td", {
      className: "mono",
      style: {
        textAlign: "right"
      }
    }, /*#__PURE__*/React.createElement("span", {
      className: "ok"
    }, _tabsNz(s.online)), /*#__PURE__*/React.createElement("span", {
      style: {
        color: "var(--muted)"
      }
    }, " / ", _tabsNz(s.cams))), /*#__PURE__*/React.createElement("td", null, s.warn === 0 && s.err === 0 ? /*#__PURE__*/React.createElement("span", {
      className: "state-pill ok"
    }, "all clear") : /*#__PURE__*/React.createElement("span", {
      className: "state-pill warn"
    }, s.warn > 0 && /*#__PURE__*/React.createElement("span", null, s.warn, "w"), s.err > 0 && /*#__PURE__*/React.createElement("span", {
      style: {
        color: "var(--err)"
      }
    }, " \xB7 ", s.err, "e"))), /*#__PURE__*/React.createElement("td", null, cap > 1 ? /*#__PURE__*/React.createElement("div", {
      className: "storage-bar compact"
    }, /*#__PURE__*/React.createElement("div", {
      className: "label-row"
    }, /*#__PURE__*/React.createElement("span", {
      className: "name muted",
      style: {
        fontFamily: "var(--mono)"
      }
    }, (_tabsNz(s.storageGB) / 1000).toFixed(1), " / ", (cap / 1000).toFixed(0), " TB"), /*#__PURE__*/React.createElement("span", {
      className: "pct"
    }, pct.toFixed(0), "%")), /*#__PURE__*/React.createElement("div", {
      className: "track"
    }, /*#__PURE__*/React.createElement("div", {
      className: "fill " + (pct > 90 ? "err" : pct > 80 ? "warn" : ""),
      style: {
        width: `${pct}%`
      }
    }))) : /*#__PURE__*/React.createElement("span", {
      style: {
        color: "var(--muted)",
        fontSize: 10.5
      }
    }, "\u2014")), /*#__PURE__*/React.createElement("td", {
      className: "mono",
      style: {
        fontSize: 11
      }
    }, /*#__PURE__*/React.createElement("div", null, d.network || "—"), d.vlan ? /*#__PURE__*/React.createElement("div", {
      style: {
        color: "var(--muted)",
        fontSize: 10
      }
    }, "VLAN ", d.vlan) : null), /*#__PURE__*/React.createElement("td", {
      className: "mono",
      style: {
        textAlign: "right",
        color: "var(--muted)"
      }
    }, d.aps || "—"), /*#__PURE__*/React.createElement("td", {
      style: {
        color: "var(--muted)",
        textAlign: "right"
      }
    }, /*#__PURE__*/React.createElement(Icon, {
      name: "chevron",
      size: 12
    })));
  })))));
};

// ─────────────────────────────────────────────────────────────
// CAMERAS
// ─────────────────────────────────────────────────────────────
const NvrTabCameras = () => {
  const all = _tabsArr(window.CAMERAS);
  const SITES_RAW = _tabsArr(window.SITES);

  // Group membership is attributed server-side (buildCameras walks each
  // group's cameraIds and stamps cam.group). Same join the Sites tab uses
  // for its per-site cam counts — so the navigator buckets here line up
  // with what's shown there.
  const camSite = c => c.group || c.site || "Ungrouped";

  // Site → [cameras] in SITES_RAW order, then any "Ungrouped" / extras after.
  const camsBySite = new Map();
  for (const c of all) {
    const s = camSite(c);
    if (!camsBySite.has(s)) camsBySite.set(s, []);
    camsBySite.get(s).push(c);
  }
  const sitesList = [];
  for (const s of SITES_RAW) {
    sitesList.push({
      name: s.name,
      cams: camsBySite.get(s.name) || []
    });
    camsBySite.delete(s.name);
  }
  for (const [name, cams] of camsBySite) sitesList.push({
    name,
    cams
  });
  const [siteFilter, setSiteFilter] = useStateNVT("All");
  const [stateFilter, setStateFilter] = useStateNVT("all");
  const [q, setQ] = useStateNVT("");
  const [expanded, setExpanded] = useStateNVT(() => new Set());
  const STATES = [{
    id: "all",
    label: "All",
    count: all.length
  }, {
    id: "ok",
    label: "Online",
    count: all.filter(c => c.state === "ok").length
  }, {
    id: "warn",
    label: "Warning",
    count: all.filter(c => c.state === "warn").length
  }, {
    id: "err",
    label: "Offline",
    count: all.filter(c => c.state === "err").length
  }];
  const SITE_OPTS = ["All", ...sitesList.map(s => s.name)];
  const matchSearch = c => !q || ((c.id || "") + (c.loc || "") + (c.model || "") + (c.ip || "")).toLowerCase().includes(q.toLowerCase());
  const matchState = c => stateFilter === "all" || c.state === stateFilter;

  // Filtered cameras (drives the thumbnail grid and the navigator counts).
  const filteredCams = all.filter(c => (siteFilter === "All" || camSite(c) === siteFilter) && matchState(c) && matchSearch(c));
  const anyFilter = !!q || stateFilter !== "all" || siteFilter !== "All";
  const toggle = name => {
    const next = new Set(expanded);
    if (next.has(name)) next.delete(name);else next.add(name);
    setExpanded(next);
  };
  const M = Object.assign({
    licenseDeviceUsed: 0
  }, window.MILESTONE || {});
  return /*#__PURE__*/React.createElement("div", {
    className: "tab-pane"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h-bar"
  }, /*#__PURE__*/React.createElement("span", {
    className: "h-title"
  }, "Camera fleet \u2014 ", _tabsNz(M.licenseDeviceUsed).toLocaleString(), " licensed"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "ext"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("span", {
    className: "h-meta"
  }, "showing ", filteredCams.length.toLocaleString(), " of ", all.length.toLocaleString())), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gridTemplateColumns: "380px 1fr",
      gap: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "card ap-nav-card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "Camera Navigator"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "ext"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("span", {
    className: "h-meta"
  }, all.length.toLocaleString(), " cams")), /*#__PURE__*/React.createElement("div", {
    className: "ap-nav-search"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "search",
    size: 12
  }), /*#__PURE__*/React.createElement("input", {
    placeholder: "Find camera, location, model, IP\u2026",
    value: q,
    onChange: e => setQ(e.target.value),
    spellCheck: false
  }), q ? /*#__PURE__*/React.createElement("span", {
    className: "ap-nav-clear",
    onClick: () => setQ("")
  }, "\xD7") : null), /*#__PURE__*/React.createElement("div", {
    className: "ap-nav-filter"
  }, /*#__PURE__*/React.createElement("div", {
    className: "seg-toggle"
  }, STATES.map(s => /*#__PURE__*/React.createElement("button", {
    key: s.id,
    className: "seg-btn" + (stateFilter === s.id ? " active" : ""),
    onClick: () => setStateFilter(s.id),
    title: s.label
  }, s.label, " ", /*#__PURE__*/React.createElement("b", null, s.count))))), /*#__PURE__*/React.createElement("div", {
    className: "ap-nav-filter",
    style: {
      paddingTop: 0
    }
  }, /*#__PURE__*/React.createElement("select", {
    className: "cfb-select",
    style: {
      flex: 1
    },
    value: siteFilter,
    onChange: e => setSiteFilter(e.target.value)
  }, SITE_OPTS.map(s => /*#__PURE__*/React.createElement("option", {
    key: s,
    value: s
  }, "Site: ", s)))), /*#__PURE__*/React.createElement("div", {
    className: "ap-nav-summary"
  }, /*#__PURE__*/React.createElement("span", null, /*#__PURE__*/React.createElement("b", null, filteredCams.length.toLocaleString()), " shown"), /*#__PURE__*/React.createElement("span", {
    className: "dot-sep"
  }, "\xB7"), /*#__PURE__*/React.createElement("span", null, /*#__PURE__*/React.createElement("b", {
    style: {
      color: "var(--ok)"
    }
  }, all.filter(c => c.state === "ok").length), " ok"), /*#__PURE__*/React.createElement("span", {
    className: "dot-sep"
  }, "\xB7"), /*#__PURE__*/React.createElement("span", null, /*#__PURE__*/React.createElement("b", {
    style: {
      color: "var(--err)"
    }
  }, all.filter(c => c.state === "err").length), " down")), /*#__PURE__*/React.createElement("div", {
    className: "ap-nav"
  }, sitesList.map(site => {
    if (siteFilter !== "All" && siteFilter !== site.name) return null;
    const cams = site.cams.filter(c => matchState(c) && matchSearch(c));
    if (anyFilter && cams.length === 0) return null;
    const open = anyFilter ? true : expanded.has(site.name);
    const errN = site.cams.filter(c => c.state === "err").length;
    return /*#__PURE__*/React.createElement("div", {
      className: "ap-nav-section",
      key: site.name
    }, /*#__PURE__*/React.createElement("div", {
      className: "ap-nav-site" + (open ? "" : " collapsed"),
      onClick: () => !anyFilter && toggle(site.name)
    }, /*#__PURE__*/React.createElement("svg", {
      className: "caret",
      viewBox: "0 0 16 16",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: "1.6",
      strokeLinecap: "round",
      strokeLinejoin: "round"
    }, /*#__PURE__*/React.createElement("path", {
      d: "m4 6 4 4 4-4"
    })), /*#__PURE__*/React.createElement("span", {
      className: "site-name"
    }, site.name), /*#__PURE__*/React.createElement("span", {
      className: "site-count"
    }, cams.length), errN > 0 && /*#__PURE__*/React.createElement("span", {
      className: "site-down",
      title: `${errN} offline / fault`
    }, errN, "\u2193")), /*#__PURE__*/React.createElement("div", {
      className: "ap-nav-children" + (open ? "" : " hidden")
    }, cams.map(c => {
      const dotColor = c.state === "ok" ? "var(--ok)" : c.state === "warn" ? "var(--warn)" : "var(--err)";
      const href = c.hostid ? `zabbix.php?action=tcs.camera.view&hostid=${c.hostid}` : `zabbix.php?action=tcs.camera.view&id=${encodeURIComponent(c.id)}`;
      return /*#__PURE__*/React.createElement("a", {
        key: c.id,
        className: "ap-nav-host",
        href: href,
        title: `${c.loc || c.id} · ${c.ip} · ${c.model}`,
        style: {
          textDecoration: "none",
          color: "inherit"
        }
      }, /*#__PURE__*/React.createElement("span", {
        className: "ap-led",
        style: {
          background: dotColor,
          boxShadow: c.state === "ok" ? `0 0 4px ${dotColor}` : "none"
        }
      }), /*#__PURE__*/React.createElement("div", {
        className: "ap-meta-col"
      }, /*#__PURE__*/React.createElement("div", {
        className: "ap-id"
      }, c.loc || c.id), /*#__PURE__*/React.createElement("div", {
        className: "ap-sub"
      }, c.ip || "—", " \xB7 ", c.model)));
    })));
  }), sitesList.every(site => {
    if (siteFilter !== "All" && siteFilter !== site.name) return true;
    const cams = site.cams.filter(c => matchState(c) && matchSearch(c));
    return anyFilter && cams.length === 0;
  }) && /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 22,
      textAlign: "center",
      color: "var(--muted)",
      fontSize: 12
    }
  }, "No cameras match the current filter."))), /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "Thumbnails"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "ext"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("span", {
    className: "h-meta"
  }, filteredCams.length.toLocaleString(), " cameras shown", filteredCams.length > 48 ? ` · first 48` : "", " · live snapshot")), filteredCams.length === 0 ? /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 32,
      textAlign: "center",
      color: "var(--muted)"
    }
  }, "No cameras match the current filter.") : /*#__PURE__*/React.createElement("div", {
    className: "cam-grid"
  }, filteredCams.slice(0, 48).map(c => /*#__PURE__*/React.createElement(CamThumb, {
    key: c.id,
    c: c
  }))))));
};

// ─────────────────────────────────────────────────────────────
// RECORDING SERVERS
// ─────────────────────────────────────────────────────────────
const InlineBar = ({
  v,
  max,
  warn,
  crit,
  unit
}) => {
  const val = _tabsNz(v);
  const pct = max > 0 ? val / max * 100 : 0;
  const cls = val >= crit ? "err" : val >= warn ? "warn" : "ok";
  return /*#__PURE__*/React.createElement("div", {
    className: "ib"
  }, /*#__PURE__*/React.createElement("div", {
    className: "ib-track"
  }, /*#__PURE__*/React.createElement("div", {
    className: "ib-fill " + cls,
    style: {
      width: `${pct}%`
    }
  })), /*#__PURE__*/React.createElement("span", {
    className: "ib-val " + cls
  }, val, unit));
};
const NvrTabServers = () => {
  const SR = _tabsArr(window.SERVERS);
  const M = Object.assign({
    recordingServers: 0,
    recordingServersOnline: 0,
    failoverServers: 0,
    managementServer: "—",
    version: "—",
    smartClientSessions: 0,
    webClientSessions: 0
  }, window.MILESTONE || {});
  const totalChans = SR.reduce((a, s) => a + _tabsNz(s.chans), 0);
  const recChans = SR.reduce((a, s) => a + _tabsNz(s.recording), 0);
  return /*#__PURE__*/React.createElement("div", {
    className: "tab-pane"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card",
    style: {
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "stat-grid"
  }, /*#__PURE__*/React.createElement("div", {
    className: "stat-cell"
  }, /*#__PURE__*/React.createElement("div", {
    className: "lbl"
  }, "Recording servers ", /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  })), /*#__PURE__*/React.createElement("div", {
    className: "val"
  }, M.recordingServersOnline, /*#__PURE__*/React.createElement("span", {
    className: "u"
  }, "/ ", M.recordingServers)), /*#__PURE__*/React.createElement("div", {
    className: "sub ok"
  }, M.recordingServers > 0 && M.recordingServersOnline === M.recordingServers ? "all online" : "", M.failoverServers ? ` · ${M.failoverServers} failover standby` : "")), /*#__PURE__*/React.createElement("div", {
    className: "stat-cell"
  }, /*#__PURE__*/React.createElement("div", {
    className: "lbl"
  }, "Channels recording"), /*#__PURE__*/React.createElement("div", {
    className: "val"
  }, recChans.toLocaleString(), /*#__PURE__*/React.createElement("span", {
    className: "u"
  }, "/ ", totalChans.toLocaleString())), /*#__PURE__*/React.createElement("div", {
    className: "sub warn"
  }, totalChans - recChans > 0 ? `${totalChans - recChans} channels not recording` : "")), /*#__PURE__*/React.createElement("div", {
    className: "stat-cell"
  }, /*#__PURE__*/React.createElement("div", {
    className: "lbl"
  }, "Mgmt server"), /*#__PURE__*/React.createElement("div", {
    className: "val",
    style: {
      fontSize: 14
    }
  }, M.managementServer), /*#__PURE__*/React.createElement("div", {
    className: "sub ok"
  }, "v ", M.version)), /*#__PURE__*/React.createElement("div", {
    className: "stat-cell"
  }, /*#__PURE__*/React.createElement("div", {
    className: "lbl"
  }, "Mobile / web sessions"), /*#__PURE__*/React.createElement("div", {
    className: "val"
  }, _tabsNz(M.smartClientSessions) + _tabsNz(M.webClientSessions)), /*#__PURE__*/React.createElement("div", {
    className: "sub"
  }, _tabsNz(M.smartClientSessions), " smart \xB7 ", _tabsNz(M.webClientSessions), " web")))), /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "Recording servers"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  }), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "ext"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("span", {
    className: "h-meta"
  }, "zabbix-agent2 + Dell iDRAC SNMP \xB7 60s poll")), SR.length === 0 ? /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 32,
      textAlign: "center",
      color: "var(--muted)"
    }
  }, "No recording servers discovered.") : /*#__PURE__*/React.createElement("table", {
    className: "link-tbl nvr-tbl srv-tbl"
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", {
    style: {
      width: 20
    }
  }), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 170
    }
  }, "Host"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 100
    }
  }, "Service"), /*#__PURE__*/React.createElement("th", null, "Site"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 120
    }
  }, "IP"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 90,
      textAlign: "right"
    }
  }, "Cameras"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 80,
      textAlign: "right"
    }
  }, "Devices"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 110
    }
  }, "CPU"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 110
    }
  }, "Mem"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 180
    }
  }, "Storage"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 80,
      textAlign: "right"
    }
  }, "Retention"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 70
    }
  }, "RAID"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 50,
      textAlign: "right"
    }
  }, "Up"))), /*#__PURE__*/React.createElement("tbody", null, SR.map(s => {
    const tileState = s.state || (_tabsNz(s.disk) > 90 || _tabsNz(s.cpu) > 80 || s.raid === "warn" || s.raid === "err" ? "warn" : "ok");
    // Service pill: prefer Milestone-reported state when
    // available (svcState), otherwise fall back to the
    // handshake age (>5m → stale). Anything not in the
    // "running" set lights red.
    const svc = (s.svcState || "").toLowerCase();
    const svcOk = svc === "" ? null : ["server", "running", "started", "ok"].includes(svc);
    const svcLabel = svc || (s.handshakeAge > 300 ? "stale" : s.handshakeAge >= 0 ? "running" : "—");
    // Per-RS storage: use the new RS-extras rollup if
    // present (storageTotalGB/UsedGB from /storages), else
    // fall back to the agent's disk % so old installs
    // without the extras template still get something.
    const haveStorage = _tabsNz(s.storageTotalGB) > 0;
    const storUsedGB = _tabsNz(s.storageUsedGB);
    const storCapGB = _tabsNz(s.storageTotalGB);
    const storPct = haveStorage ? storUsedGB / storCapGB * 100 : _tabsNz(s.disk);
    const retDays = _tabsNz(s.retentionMin) > 0 ? Math.round(s.retentionMin / 1440) : 0;
    return /*#__PURE__*/React.createElement("tr", {
      key: s.id,
      onClick: () => {
        if (s.agentHostid) location.href = `zabbix.php?action=tcs.server.view&hostid=${s.agentHostid}`;
      }
    }, /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement(StatusDot, {
      state: tileState
    })), /*#__PURE__*/React.createElement("td", {
      className: "mono",
      style: {
        color: "var(--accent)"
      }
    }, s.id), /*#__PURE__*/React.createElement("td", null, svcOk === null ? /*#__PURE__*/React.createElement("span", {
      style: {
        color: "var(--muted)"
      }
    }, "\u2014") : /*#__PURE__*/React.createElement("span", {
      className: "state-pill " + (svcOk ? "ok" : "err")
    }, svcLabel)), /*#__PURE__*/React.createElement("td", {
      style: {
        color: "var(--fg-2)"
      }
    }, s.site), /*#__PURE__*/React.createElement("td", {
      className: "mono",
      style: {
        fontSize: 11
      }
    }, s.ip || "—"), /*#__PURE__*/React.createElement("td", {
      className: "mono",
      style: {
        textAlign: "right"
      }
    }, _tabsNz(s.chans) === 0 ? /*#__PURE__*/React.createElement("span", {
      style: {
        color: "var(--muted)"
      }
    }, "\u2014") : /*#__PURE__*/React.createElement("span", {
      style: {
        color: "var(--fg)"
      }
    }, _tabsNz(s.chans).toLocaleString())), /*#__PURE__*/React.createElement("td", {
      className: "mono",
      style: {
        textAlign: "right",
        color: "var(--muted)"
      }
    }, _tabsNz(s.hwDevices) === 0 ? "—" : _tabsNz(s.hwDevices).toLocaleString()), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement(InlineBar, {
      v: s.cpu,
      max: 100,
      warn: 75,
      crit: 90,
      unit: "%"
    })), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement(InlineBar, {
      v: s.mem,
      max: 100,
      warn: 80,
      crit: 92,
      unit: "%"
    })), /*#__PURE__*/React.createElement("td", null, haveStorage ? /*#__PURE__*/React.createElement("div", {
      className: "storage-bar compact"
    }, /*#__PURE__*/React.createElement("div", {
      className: "label-row"
    }, /*#__PURE__*/React.createElement("span", {
      className: "name mono",
      style: {
        color: "var(--muted)",
        fontSize: 10.5
      }
    }, (storUsedGB / 1000).toFixed(1), " / ", (storCapGB / 1000).toFixed(1), " TB"), /*#__PURE__*/React.createElement("span", {
      className: "pct"
    }, storPct.toFixed(0), "%")), /*#__PURE__*/React.createElement("div", {
      className: "track"
    }, /*#__PURE__*/React.createElement("div", {
      className: "fill " + (storPct > 90 ? "err" : storPct > 80 ? "warn" : ""),
      style: {
        width: `${storPct}%`
      }
    }))) : /*#__PURE__*/React.createElement(InlineBar, {
      v: s.disk,
      max: 100,
      warn: 80,
      crit: 90,
      unit: "%"
    })), /*#__PURE__*/React.createElement("td", {
      className: "mono",
      style: {
        textAlign: "right",
        color: retDays === 0 ? "var(--muted)" : retDays < 30 ? "var(--warn)" : "var(--fg-2)"
      }
    }, retDays === 0 ? "—" : `${retDays}d`), /*#__PURE__*/React.createElement("td", null, s.raid && s.raid !== "unknown" ? /*#__PURE__*/React.createElement("span", {
      className: "state-pill " + (s.raid === "ok" ? "ok" : s.raid === "err" ? "err" : "warn")
    }, s.raid) : /*#__PURE__*/React.createElement("span", {
      style: {
        color: "var(--muted)"
      }
    }, "\u2014")), /*#__PURE__*/React.createElement("td", {
      className: "mono",
      style: {
        textAlign: "right",
        color: "var(--muted)"
      }
    }, _tabsNz(s.uptimeD), "d"));
  })))));
};

// ─────────────────────────────────────────────────────────────
// ALARMS
// ─────────────────────────────────────────────────────────────
const NvrTabAlarms = () => {
  const A = _tabsArr(window.VMS_ALARMS);
  const [sev, setSev] = useStateNVT("all");
  const [ack, setAck] = useStateNVT("all");
  const counts = {
    all: A.length,
    high: A.filter(a => a.sev === "high" || a.sev === "disaster").length,
    warning: A.filter(a => a.sev === "warning").length,
    info: A.filter(a => a.sev === "info").length,
    unack: A.filter(a => !a.ack).length,
    ack: A.filter(a => a.ack).length
  };
  const rows = A.filter(a => (sev === "all" || sev === "high" && (a.sev === "high" || a.sev === "disaster") || sev === a.sev) && (ack === "all" || (ack === "unack" ? !a.ack : a.ack)));
  return /*#__PURE__*/React.createElement("div", {
    className: "tab-pane"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h-bar"
  }, /*#__PURE__*/React.createElement("span", {
    className: "h-title"
  }, "Active alarms \xB7 last 24h"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "ext"
  }), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("div", {
    className: "trig-filter"
  }, /*#__PURE__*/React.createElement("span", {
    className: "tf " + (sev === "all" ? "active" : ""),
    onClick: () => setSev("all")
  }, "All ", /*#__PURE__*/React.createElement("b", null, counts.all)), /*#__PURE__*/React.createElement("span", {
    className: "tf err " + (sev === "high" ? "active" : ""),
    onClick: () => setSev("high")
  }, "High ", /*#__PURE__*/React.createElement("b", null, counts.high)), /*#__PURE__*/React.createElement("span", {
    className: "tf warn " + (sev === "warning" ? "active" : ""),
    onClick: () => setSev("warning")
  }, "Warning ", /*#__PURE__*/React.createElement("b", null, counts.warning)), /*#__PURE__*/React.createElement("span", {
    className: "tf " + (sev === "info" ? "active" : ""),
    onClick: () => setSev("info")
  }, "Info ", /*#__PURE__*/React.createElement("b", null, counts.info))), /*#__PURE__*/React.createElement("span", {
    style: {
      width: 8
    }
  }), /*#__PURE__*/React.createElement("div", {
    className: "trig-filter"
  }, /*#__PURE__*/React.createElement("span", {
    className: "tf " + (ack === "all" ? "active" : ""),
    onClick: () => setAck("all")
  }, "Any ", /*#__PURE__*/React.createElement("b", null, counts.all)), /*#__PURE__*/React.createElement("span", {
    className: "tf warn " + (ack === "unack" ? "active" : ""),
    onClick: () => setAck("unack")
  }, "Unacked ", /*#__PURE__*/React.createElement("b", null, counts.unack)), /*#__PURE__*/React.createElement("span", {
    className: "tf " + (ack === "ack" ? "active" : ""),
    onClick: () => setAck("ack")
  }, "Acked ", /*#__PURE__*/React.createElement("b", null, counts.ack)))), /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, A.length === 0 ? /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 32,
      textAlign: "center",
      color: "var(--muted)"
    }
  }, "No active alarms.") : /*#__PURE__*/React.createElement("table", {
    className: "link-tbl nvr-tbl alarm-tbl"
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", {
    style: {
      width: 130
    }
  }, "Timestamp"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 80
    }
  }, "Severity"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 200
    }
  }, "Object"), /*#__PURE__*/React.createElement("th", null, "Message"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 130
    }
  }, "Site"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 90
    }
  }, "State"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 160,
      textAlign: "right"
    }
  }, "Actions"))), /*#__PURE__*/React.createElement("tbody", null, rows.map((a, i) => /*#__PURE__*/React.createElement("tr", {
    key: i,
    className: a.ack ? "row-ack" : a.sev === "high" || a.sev === "disaster" ? "row-err" : a.sev === "warning" ? "row-warn" : ""
  }, /*#__PURE__*/React.createElement("td", {
    className: "mono",
    style: {
      fontSize: 11,
      color: "var(--muted)"
    }
  }, a.ts), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement(Sev, {
    level: a.sev
  })), /*#__PURE__*/React.createElement("td", {
    className: "mono",
    style: {
      color: "var(--accent)"
    }
  }, a.cam || a.srv || "—"), /*#__PURE__*/React.createElement("td", {
    style: {
      color: "var(--fg-2)"
    }
  }, a.msg), /*#__PURE__*/React.createElement("td", {
    style: {
      color: "var(--fg-2)",
      fontSize: 11
    }
  }, a.site), /*#__PURE__*/React.createElement("td", null, a.ack ? /*#__PURE__*/React.createElement("span", {
    className: "state-pill ok"
  }, "acked") : /*#__PURE__*/React.createElement("span", {
    className: "state-pill warn"
  }, "open")), /*#__PURE__*/React.createElement("td", {
    style: {
      textAlign: "right"
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "row-action"
  }, a.ack ? "View" : "Ack"), /*#__PURE__*/React.createElement("span", {
    className: "row-action"
  }, "Suppress 1h"))))))));
};

// ─────────────────────────────────────────────────────────────
// STORAGE
// ─────────────────────────────────────────────────────────────
const NvrTabStorage = () => {
  const M = Object.assign({
    storageTotalTB: 0,
    storageUsedTB: 0,
    retentionDays: 0,
    evidenceLockSlots: 0,
    evidenceLockUsed: 0
  }, window.MILESTONE || {});
  const S = _tabsArr(window.SITES);
  const SR = _tabsArr(window.SERVERS).filter(s => s.role === "Recording Server");
  // Prefer the top-level Milestone summary if it ever gets templated;
  // otherwise sum the per-RS rollup the extras template now publishes.
  const rsTotalTB = SR.reduce((a, s) => a + _tabsNz(s.storageTotalGB), 0) / 1000;
  const rsUsedTB = SR.reduce((a, s) => a + _tabsNz(s.storageUsedGB), 0) / 1000;
  const usedTB = _tabsNz(M.storageUsedTB) || rsUsedTB;
  const totalTB = _tabsNz(M.storageTotalTB) || rsTotalTB;
  const freeTB = Math.max(0, totalTB - usedTB);
  const pct = totalTB > 0 ? usedTB / totalTB * 100 : 0;
  const nearLimit = S.filter(s => _tabsNz(s.storageCapGB, 1) && s.storageGB / s.storageCapGB > 0.9).length;
  return /*#__PURE__*/React.createElement("div", {
    className: "tab-pane"
  }, /*#__PURE__*/React.createElement("div", {
    className: "row",
    style: {
      gridTemplateColumns: "1fr 1.5fr",
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "Fleet storage"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  })), /*#__PURE__*/React.createElement("div", {
    className: "card-b",
    style: {
      display: "flex",
      flexDirection: "column",
      gap: 18,
      alignItems: "center",
      padding: 20
    }
  }, totalTB > 0 ? /*#__PURE__*/React.createElement(Ring, {
    value: usedTB,
    max: totalTB,
    size: 170,
    color: pct > 90 ? "var(--err)" : pct > 80 ? "var(--warn)" : "var(--zbx)",
    label: `${pct.toFixed(0)}%`,
    sub: `${usedTB.toFixed(1)} / ${totalTB.toFixed(0)} TB`,
    threshold: totalTB * 0.9
  }) : /*#__PURE__*/React.createElement("div", {
    style: {
      color: "var(--muted)",
      padding: 30
    }
  }, "Storage capacity not yet templated."), /*#__PURE__*/React.createElement("div", {
    className: "kv tight",
    style: {
      width: "100%",
      borderTop: "1px solid var(--line)"
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "k"
  }, "Used"), /*#__PURE__*/React.createElement("div", {
    className: "v"
  }, usedTB.toFixed(1), " TB"), /*#__PURE__*/React.createElement("div", {
    className: "b"
  }), /*#__PURE__*/React.createElement("div", {
    className: "k"
  }, "Free"), /*#__PURE__*/React.createElement("div", {
    className: "v",
    style: {
      color: "var(--ok)"
    }
  }, freeTB.toFixed(1), " TB"), /*#__PURE__*/React.createElement("div", {
    className: "b"
  }), /*#__PURE__*/React.createElement("div", {
    className: "k"
  }, "Retention"), /*#__PURE__*/React.createElement("div", {
    className: "v"
  }, M.retentionDays || "—", " ", M.retentionDays ? "days standard" : ""), /*#__PURE__*/React.createElement("div", {
    className: "b"
  }), /*#__PURE__*/React.createElement("div", {
    className: "k"
  }, "Evidence locks"), /*#__PURE__*/React.createElement("div", {
    className: "v"
  }, M.evidenceLockUsed, " / ", M.evidenceLockSlots, " active"), /*#__PURE__*/React.createElement("div", {
    className: "b"
  })))), /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "Per-site capacity"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("span", {
    className: "h-meta"
  }, nearLimit, " approaching limit")), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 14,
      display: "flex",
      flexDirection: "column",
      gap: 14
    }
  }, S.length === 0 ? /*#__PURE__*/React.createElement("div", {
    style: {
      color: "var(--muted)",
      padding: 12
    }
  }, "No sites discovered yet.") : S.map(s => {
    const cap = _tabsNz(s.storageCapGB, 1);
    const used = _tabsNz(s.storageGB);
    const sitePct = cap > 0 ? used / cap * 100 : 0;
    return /*#__PURE__*/React.createElement("div", {
      key: s.name,
      className: "storage-row"
    }, /*#__PURE__*/React.createElement("div", {
      className: "sr-name"
    }, /*#__PURE__*/React.createElement(StatusDot, {
      state: sitePct > 90 ? "err" : sitePct > 80 ? "warn" : "ok"
    }), /*#__PURE__*/React.createElement("span", {
      style: {
        color: "var(--fg)",
        fontWeight: 500
      }
    }, s.name), /*#__PURE__*/React.createElement("span", {
      className: "mono",
      style: {
        color: "var(--muted)",
        fontSize: 10.5
      }
    }, s.server)), /*#__PURE__*/React.createElement("div", {
      className: "storage-bar compact",
      style: {
        flex: 1
      }
    }, /*#__PURE__*/React.createElement("div", {
      className: "label-row"
    }, /*#__PURE__*/React.createElement("span", {
      className: "name mono"
    }, (used / 1000).toFixed(1), " / ", (cap / 1000).toFixed(0), " TB"), /*#__PURE__*/React.createElement("span", {
      className: "pct"
    }, sitePct.toFixed(0), "%")), /*#__PURE__*/React.createElement("div", {
      className: "track"
    }, /*#__PURE__*/React.createElement("div", {
      className: "fill " + (sitePct > 90 ? "err" : sitePct > 80 ? "warn" : ""),
      style: {
        width: `${sitePct}%`
      }
    }))), /*#__PURE__*/React.createElement("div", {
      className: "sr-retention mono"
    }, _tabsNz(s.retentionMin) > 0 ? `${Math.round(s.retentionMin / 1440)}d` : M.retentionDays ? `${M.retentionDays}d` : "—"));
  })))), /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "Storage volumes"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  }), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "ext"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("span", {
    className: "h-meta"
  }, "per recording server \xB7 Milestone /storages rollup")), SR.length === 0 ? /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 32,
      textAlign: "center",
      color: "var(--muted)"
    }
  }, "No recording-server volumes discovered.") : /*#__PURE__*/React.createElement("table", {
    className: "link-tbl nvr-tbl"
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", {
    style: {
      width: 20
    }
  }), /*#__PURE__*/React.createElement("th", null, "Recording server"), /*#__PURE__*/React.createElement("th", null, "Site"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 80,
      textAlign: "right"
    }
  }, "Cameras"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 80,
      textAlign: "right"
    }
  }, "Devices"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 160,
      textAlign: "right"
    }
  }, "Used / Total"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 70,
      textAlign: "right"
    }
  }, "Used %"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 200
    }
  }, "Utilisation"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 90,
      textAlign: "right"
    }
  }, "Retention"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 80
    }
  }, "RAID"))), /*#__PURE__*/React.createElement("tbody", null, SR.map(s => {
    const haveStorage = _tabsNz(s.storageTotalGB) > 0;
    const usedGB = _tabsNz(s.storageUsedGB);
    const capGB = _tabsNz(s.storageTotalGB);
    const pct = haveStorage ? usedGB / capGB * 100 : _tabsNz(s.disk);
    const retDays = _tabsNz(s.retentionMin) > 0 ? Math.round(s.retentionMin / 1440) : 0;
    const dotState = s.raid === "err" || pct > 90 ? "err" : s.raid === "warn" || pct > 80 ? "warn" : "ok";
    return /*#__PURE__*/React.createElement("tr", {
      key: s.id
    }, /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement(StatusDot, {
      state: dotState
    })), /*#__PURE__*/React.createElement("td", {
      className: "mono",
      style: {
        color: "var(--accent)"
      }
    }, s.id), /*#__PURE__*/React.createElement("td", {
      style: {
        color: "var(--fg-2)"
      }
    }, s.site), /*#__PURE__*/React.createElement("td", {
      className: "mono",
      style: {
        textAlign: "right"
      }
    }, _tabsNz(s.chans) === 0 ? /*#__PURE__*/React.createElement("span", {
      style: {
        color: "var(--muted)"
      }
    }, "\u2014") : _tabsNz(s.chans).toLocaleString()), /*#__PURE__*/React.createElement("td", {
      className: "mono",
      style: {
        textAlign: "right",
        color: "var(--muted)"
      }
    }, _tabsNz(s.hwDevices) === 0 ? "—" : _tabsNz(s.hwDevices).toLocaleString()), /*#__PURE__*/React.createElement("td", {
      className: "mono",
      style: {
        textAlign: "right"
      }
    }, haveStorage ? /*#__PURE__*/React.createElement(React.Fragment, null, (usedGB / 1000).toFixed(1), /*#__PURE__*/React.createElement("span", {
      style: {
        color: "var(--muted)"
      }
    }, " / ", (capGB / 1000).toFixed(1), " TB")) : /*#__PURE__*/React.createElement("span", {
      style: {
        color: "var(--muted)"
      }
    }, "\u2014")), /*#__PURE__*/React.createElement("td", {
      className: "mono",
      style: {
        textAlign: "right"
      }
    }, pct > 0 ? `${pct.toFixed(0)}%` : "—"), /*#__PURE__*/React.createElement("td", null, pct > 0 ? /*#__PURE__*/React.createElement(InlineBar, {
      v: pct,
      max: 100,
      warn: 80,
      crit: 90,
      unit: "%"
    }) : /*#__PURE__*/React.createElement("span", {
      style: {
        color: "var(--muted)"
      }
    }, "\u2014")), /*#__PURE__*/React.createElement("td", {
      className: "mono",
      style: {
        textAlign: "right",
        color: retDays === 0 ? "var(--muted)" : retDays < 30 ? "var(--warn)" : "var(--fg-2)"
      }
    }, retDays === 0 ? "—" : `${retDays}d`), /*#__PURE__*/React.createElement("td", null, s.raid && s.raid !== "unknown" ? /*#__PURE__*/React.createElement("span", {
      className: "state-pill " + (s.raid === "ok" ? "ok" : s.raid === "err" ? "err" : "warn")
    }, s.raid) : /*#__PURE__*/React.createElement("span", {
      style: {
        color: "var(--muted)"
      }
    }, "\u2014")));
  })))));
};

// ─────────────────────────────────────────────────────────────
// EVIDENCE LOCK
// ─────────────────────────────────────────────────────────────
const NvrTabEvidence = () => {
  const E = _tabsArr(window.EVIDENCE_LOCKS);
  const M = Object.assign({
    evidenceLockSlots: 0,
    evidenceLockUsed: 0
  }, window.MILESTONE || {});
  if (E.length === 0) {
    return /*#__PURE__*/React.createElement("div", {
      className: "tab-pane"
    }, /*#__PURE__*/React.createElement("div", {
      className: "card",
      style: {
        marginBottom: 14
      }
    }, /*#__PURE__*/React.createElement("div", {
      className: "stat-grid"
    }, /*#__PURE__*/React.createElement("div", {
      className: "stat-cell"
    }, /*#__PURE__*/React.createElement("div", {
      className: "lbl"
    }, "Active evidence locks ", /*#__PURE__*/React.createElement(SourceBadge, {
      src: "ext"
    })), /*#__PURE__*/React.createElement("div", {
      className: "val"
    }, M.evidenceLockUsed, /*#__PURE__*/React.createElement("span", {
      className: "u"
    }, "/ ", M.evidenceLockSlots)), /*#__PURE__*/React.createElement("div", {
      className: "sub"
    }, Math.max(0, M.evidenceLockSlots - M.evidenceLockUsed), " slots available")))), /*#__PURE__*/React.createElement(_TabEmpty, null, "Per-lock detail isn't templated yet \u2014 only the slot counter from the XProtect license is available. Wire the /api/rest/v1/evidence endpoint to populate this view."));
  }
  const totalGB = E.reduce((a, e) => a + _tabsNz(e.sizeGB), 0);
  const now = new Date();
  const expiring = E.filter(e => {
    const d = Date.parse(e.expires);
    if (Number.isNaN(d)) return false;
    return d - now.getTime() < 30 * 86400 * 1000;
  }).length;
  return /*#__PURE__*/React.createElement("div", {
    className: "tab-pane"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card",
    style: {
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "stat-grid"
  }, /*#__PURE__*/React.createElement("div", {
    className: "stat-cell"
  }, /*#__PURE__*/React.createElement("div", {
    className: "lbl"
  }, "Active evidence locks ", /*#__PURE__*/React.createElement(SourceBadge, {
    src: "ext"
  })), /*#__PURE__*/React.createElement("div", {
    className: "val"
  }, M.evidenceLockUsed, /*#__PURE__*/React.createElement("span", {
    className: "u"
  }, "/ ", M.evidenceLockSlots)), /*#__PURE__*/React.createElement("div", {
    className: "sub"
  }, Math.max(0, M.evidenceLockSlots - M.evidenceLockUsed), " slots available")), /*#__PURE__*/React.createElement("div", {
    className: "stat-cell"
  }, /*#__PURE__*/React.createElement("div", {
    className: "lbl"
  }, "Locked footage"), /*#__PURE__*/React.createElement("div", {
    className: "val"
  }, totalGB.toFixed(1), /*#__PURE__*/React.createElement("span", {
    className: "u"
  }, "GB")), /*#__PURE__*/React.createElement("div", {
    className: "sub"
  }, "excluded from retention rollover")), /*#__PURE__*/React.createElement("div", {
    className: "stat-cell"
  }, /*#__PURE__*/React.createElement("div", {
    className: "lbl"
  }, "Expiring < 30d"), /*#__PURE__*/React.createElement("div", {
    className: "val",
    style: {
      color: expiring > 0 ? "var(--warn)" : "var(--ok)"
    }
  }, expiring), /*#__PURE__*/React.createElement("div", {
    className: "sub warn"
  }, "review before auto-release")), /*#__PURE__*/React.createElement("div", {
    className: "stat-cell"
  }, /*#__PURE__*/React.createElement("div", {
    className: "lbl"
  }, "Open cases"), /*#__PURE__*/React.createElement("div", {
    className: "val"
  }, new Set(E.map(e => e.case)).size), /*#__PURE__*/React.createElement("div", {
    className: "sub"
  }, E.filter(e => (e.case || "").startsWith("TPD")).length, " TPD \xB7 ", E.filter(e => (e.case || "").startsWith("TCS")).length, " internal")))), /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "Evidence locks"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "ext"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("span", {
    className: "h-meta"
  }, "XProtect Evidence Lock \xB7 sorted by creation date")), /*#__PURE__*/React.createElement("div", {
    className: "ev-grid"
  }, E.map(e => {
    const expMs = Date.parse(e.expires);
    const daysLeft = Number.isNaN(expMs) ? null : Math.round((expMs - now.getTime()) / (86400 * 1000));
    const urgent = daysLeft !== null && daysLeft < 30;
    const caseStr = e.case || "";
    return /*#__PURE__*/React.createElement("div", {
      key: e.id,
      className: "ev-card " + (urgent ? "urgent" : "")
    }, /*#__PURE__*/React.createElement("div", {
      className: "ev-head"
    }, /*#__PURE__*/React.createElement("div", {
      className: "ev-id mono"
    }, e.id), /*#__PURE__*/React.createElement("div", {
      className: "ev-case " + (caseStr.startsWith("TPD") ? "ext" : "int")
    }, caseStr)), /*#__PURE__*/React.createElement("div", {
      className: "ev-reason"
    }, e.reason), /*#__PURE__*/React.createElement("div", {
      className: "ev-kvs"
    }, /*#__PURE__*/React.createElement("div", {
      className: "ev-kv"
    }, /*#__PURE__*/React.createElement("span", null, "Cameras"), /*#__PURE__*/React.createElement("b", {
      className: "mono"
    }, Array.isArray(e.cams) ? e.cams.join(", ") : "—")), /*#__PURE__*/React.createElement("div", {
      className: "ev-kv"
    }, /*#__PURE__*/React.createElement("span", null, "Site"), /*#__PURE__*/React.createElement("b", null, e.site || "—")), /*#__PURE__*/React.createElement("div", {
      className: "ev-kv"
    }, /*#__PURE__*/React.createElement("span", null, "Footage"), /*#__PURE__*/React.createElement("b", {
      className: "mono"
    }, e.start, " \u2192 ", e.end)), /*#__PURE__*/React.createElement("div", {
      className: "ev-kv"
    }, /*#__PURE__*/React.createElement("span", null, "Size"), /*#__PURE__*/React.createElement("b", {
      className: "mono"
    }, _tabsNz(e.sizeGB).toFixed(1), " GB")), /*#__PURE__*/React.createElement("div", {
      className: "ev-kv"
    }, /*#__PURE__*/React.createElement("span", null, "Locked by"), /*#__PURE__*/React.createElement("b", null, e.by || "—"))), /*#__PURE__*/React.createElement("div", {
      className: "ev-foot"
    }, /*#__PURE__*/React.createElement("div", {
      className: "ev-expire"
    }, /*#__PURE__*/React.createElement("span", {
      className: "lbl"
    }, "Expires"), /*#__PURE__*/React.createElement("span", {
      className: "mono v " + (urgent ? "warn" : "")
    }, e.expires), daysLeft !== null && /*#__PURE__*/React.createElement("span", {
      className: "days " + (urgent ? "warn" : "")
    }, daysLeft >= 0 ? `${daysLeft}d` : `${-daysLeft}d ago`)), /*#__PURE__*/React.createElement("div", {
      className: "ev-actions"
    }, /*#__PURE__*/React.createElement("span", {
      className: "row-action"
    }, "Extend"), /*#__PURE__*/React.createElement("span", {
      className: "row-action"
    }, "Export"))));
  }))));
};
window.NvrTabSites = NvrTabSites;
window.NvrTabCameras = NvrTabCameras;
window.NvrTabServers = NvrTabServers;
window.NvrTabAlarms = NvrTabAlarms;
window.NvrTabStorage = NvrTabStorage;
window.NvrTabEvidence = NvrTabEvidence;

// Live tab badges. Counts re-read window globals at render time so
// the count updates with the 30s bridge poll.
const _liveBadge = (n, kind = "") => n > 0 ? {
  v: n.toLocaleString(),
  kind
} : null;
Object.defineProperty(window, "NVR_TABS", {
  configurable: true,
  get() {
    const sites = _tabsArr(window.SITES).length;
    const cams = _tabsArr(window.CAMERAS).length;
    const srvs = _tabsArr(window.SERVERS).length;
    const alarms = _tabsArr(window.VMS_ALARMS).length;
    return [{
      id: "overview",
      label: "Overview",
      badge: null
    }, {
      id: "sites",
      label: "Sites",
      badge: _liveBadge(sites)
    }, {
      id: "cameras",
      label: "Cameras",
      badge: _liveBadge(cams)
    }, {
      id: "servers",
      label: "Recording Servers",
      badge: _liveBadge(srvs)
    }, {
      id: "alarms",
      label: "Alarms",
      badge: _liveBadge(alarms, "warn")
    }, {
      id: "storage",
      label: "Storage",
      badge: null
    }, {
      id: "evidence",
      label: "Evidence Lock",
      badge: _liveBadge(_tabsArr(window.EVIDENCE_LOCKS).length)
    }];
  }
});