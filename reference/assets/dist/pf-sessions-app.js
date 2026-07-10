// User Sessions — live 802.1X / portal sessions with auth method, NAS, duration.

const SessionsHeader = () => /*#__PURE__*/React.createElement("div", {
  className: "page-header",
  style: {
    alignItems: "center"
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    flex: 1
  }
}, /*#__PURE__*/React.createElement("div", {
  className: "host-title"
}, /*#__PURE__*/React.createElement("h1", null, "User Sessions"), /*#__PURE__*/React.createElement("span", {
  className: "role-tag",
  style: {
    fontSize: 10,
    padding: "1px 8px",
    background: "rgba(245,179,0,0.10)",
    color: "var(--pf)",
    border: "1px solid rgba(245,179,0,0.4)"
  }
}, "IDENTITY \xB7 PACKETFENCE"), /*#__PURE__*/React.createElement("span", {
  className: "role-tag faculty",
  style: {
    fontSize: 10,
    padding: "1px 8px"
  }
}, "LIVE \xB7 5s POLL")), /*#__PURE__*/React.createElement("div", {
  className: "host-meta"
}, /*#__PURE__*/React.createElement("span", {
  className: "pill"
}, /*#__PURE__*/React.createElement("span", {
  className: "dot",
  style: {
    background: "var(--ok)"
  }
}), " 12,847 active sessions"), /*#__PURE__*/React.createElement("span", {
  className: "pill"
}, /*#__PURE__*/React.createElement("span", {
  className: "lbl"
}, "Accept rate 1h"), " ", /*#__PURE__*/React.createElement("span", {
  className: "v"
}, "98.9%")), /*#__PURE__*/React.createElement("span", {
  className: "pill"
}, /*#__PURE__*/React.createElement("span", {
  className: "lbl"
}, "Reject 1h"), " ", /*#__PURE__*/React.createElement("span", {
  className: "v"
}, "142")), /*#__PURE__*/React.createElement("span", {
  className: "pill"
}, /*#__PURE__*/React.createElement("span", {
  className: "lbl"
}, "Avg auth"), " ", /*#__PURE__*/React.createElement("span", {
  className: "v"
}, "4.2 ms")), /*#__PURE__*/React.createElement("span", {
  className: "pill"
}, /*#__PURE__*/React.createElement("span", {
  className: "lbl"
}, "RADIUS req/s"), " ", /*#__PURE__*/React.createElement("span", {
  className: "v"
}, "418")))), /*#__PURE__*/React.createElement("div", {
  className: "timerange"
}, /*#__PURE__*/React.createElement(Icon, {
  name: "refresh"
}), /*#__PURE__*/React.createElement("span", {
  className: "range-val"
}, "Live \xB7 5s"), /*#__PURE__*/React.createElement(Icon, {
  name: "chevron"
})));

// KPI strip
const SessionsKPIs = () => {
  const cells = [{
    lbl: "Active sessions",
    v: "12,847",
    note: "across 26 sites",
    cls: ""
  }, {
    lbl: "802.1X · EAP-TLS",
    v: "8,222",
    note: "64.0% · cert auth",
    cls: "pf"
  }, {
    lbl: "802.1X · PEAP",
    v: "2,698",
    note: "21.0% · AD password",
    cls: ""
  }, {
    lbl: "MAB",
    v: "1,413",
    note: "11.0% · OUI / device-class",
    cls: ""
  }, {
    lbl: "Captive portal",
    v: 385,
    note: "3.0% · self-reg",
    cls: ""
  }, {
    lbl: "Rejected 1h",
    v: 142,
    note: "1.0% · investigated 4",
    cls: "warn"
  }];
  return /*#__PURE__*/React.createElement("div", {
    className: "card",
    style: {
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "pf-kpis"
  }, cells.map(c => /*#__PURE__*/React.createElement("div", {
    className: "pf-kpi",
    key: c.lbl
  }, /*#__PURE__*/React.createElement("div", {
    className: "pf-kpi-h"
  }, /*#__PURE__*/React.createElement("span", {
    className: "pf-kpi-lbl"
  }, c.lbl), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "pf"
  })), /*#__PURE__*/React.createElement("div", {
    className: "pf-kpi-v " + c.cls
  }, c.v), /*#__PURE__*/React.createElement("div", {
    className: "pf-kpi-note"
  }, c.note)))));
};

// Auth method donut
const AuthDonut = () => {
  const m = PF_AUTH_METHODS;
  const total = m.reduce((n, x) => n + x.value, 0);
  return /*#__PURE__*/React.createElement("div", {
    className: "pf-donut-wrap"
  }, /*#__PURE__*/React.createElement("svg", {
    width: "120",
    height: "120",
    viewBox: "0 0 120 120"
  }, /*#__PURE__*/React.createElement("circle", {
    cx: "60",
    cy: "60",
    r: "48",
    stroke: "rgba(255,255,255,0.06)",
    strokeWidth: "14",
    fill: "none"
  }), (() => {
    let acc = 0;
    const C = 2 * Math.PI * 48;
    return m.map((x, i) => {
      const frac = x.value / total;
      const dash = C * frac;
      const off = -C * acc;
      acc += frac;
      return /*#__PURE__*/React.createElement("circle", {
        key: x.key,
        cx: "60",
        cy: "60",
        r: "48",
        stroke: x.color,
        strokeWidth: "14",
        fill: "none",
        strokeDasharray: `${dash} ${C}`,
        strokeDashoffset: off,
        transform: "rotate(-90 60 60)"
      });
    });
  })(), /*#__PURE__*/React.createElement("text", {
    x: "60",
    y: "56",
    textAnchor: "middle",
    fill: "var(--fg)",
    fontFamily: "var(--mono)",
    fontSize: "18",
    fontWeight: "600"
  }, "418"), /*#__PURE__*/React.createElement("text", {
    x: "60",
    y: "73",
    textAnchor: "middle",
    fill: "var(--muted)",
    fontSize: "9",
    letterSpacing: "0.5"
  }, "REQ/SEC")), /*#__PURE__*/React.createElement("div", {
    className: "pf-donut-legend"
  }, m.map(x => /*#__PURE__*/React.createElement("div", {
    className: "pf-leg-row",
    key: x.key
  }, /*#__PURE__*/React.createElement("span", {
    className: "pf-leg-sw",
    style: {
      background: x.color
    }
  }), /*#__PURE__*/React.createElement("span", {
    className: "pf-leg-lbl"
  }, x.label), /*#__PURE__*/React.createElement("span", {
    className: "pf-leg-pct"
  }, x.value, "%")))));
};

// Per-SSID sessions split
const SSID_SPLIT = [{
  name: "tcs-secure",
  count: 8210,
  color: "var(--pf)"
}, {
  name: "tcs-byod",
  count: 1408,
  color: "#6ee0b3"
}, {
  name: "tcs-guest",
  count: 712,
  color: "#ffd25e"
}, {
  name: "eduroam",
  count: 42,
  color: "var(--ext)"
}, {
  name: "wired",
  count: 2475,
  color: "var(--info)"
}];
const SsidSplit = () => {
  const total = SSID_SPLIT.reduce((n, s) => n + s.count, 0);
  return /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 14,
      display: "flex",
      flexDirection: "column",
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      height: 18,
      borderRadius: 4,
      overflow: "hidden",
      border: "1px solid var(--line)"
    }
  }, SSID_SPLIT.map(s => /*#__PURE__*/React.createElement("div", {
    key: s.name,
    style: {
      width: `${s.count / total * 100}%`,
      background: s.color
    },
    title: `${s.name}: ${s.count}`
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      gap: 6
    }
  }, SSID_SPLIT.map(s => /*#__PURE__*/React.createElement("div", {
    key: s.name,
    className: "pf-leg-row"
  }, /*#__PURE__*/React.createElement("span", {
    className: "pf-leg-sw",
    style: {
      background: s.color
    }
  }), /*#__PURE__*/React.createElement("span", {
    className: "pf-leg-lbl",
    style: {
      fontFamily: "var(--mono)",
      fontSize: 11.5
    }
  }, s.name), /*#__PURE__*/React.createElement("span", {
    className: "pf-leg-v"
  }, s.count.toLocaleString()), /*#__PURE__*/React.createElement("span", {
    className: "pf-leg-pct"
  }, (s.count / total * 100).toFixed(1), "%")))));
};

// Format duration sec → "Hh Mm"
const formatDur = sec => {
  if (sec >= 99000) return "≥ 5d";
  const h = Math.floor(sec / 3600);
  const m = Math.floor(sec % 3600 / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
};

// Sessions table
const SessionsTable = ({
  filterMethod,
  setFilterMethod
}) => {
  const rows = PF_SESSIONS.filter(s => {
    if (filterMethod === "all") return true;
    if (filterMethod === "tls") return s.method.includes("EAP-TLS");
    if (filterMethod === "peap") return s.method.includes("PEAP");
    if (filterMethod === "mab") return s.method.startsWith("MAB");
    if (filterMethod === "portal") return s.method.includes("Portal");
    return true;
  });
  return /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "Live Sessions"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "pf"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("span", {
    className: "h-meta"
  }, rows.length, " shown \xB7 sorted by start time"), /*#__PURE__*/React.createElement("a", {
    className: "h-link"
  }, "Disconnect selected ", /*#__PURE__*/React.createElement(Icon, {
    name: "external",
    size: 11
  }))), /*#__PURE__*/React.createElement("div", {
    className: "pf-filterbar"
  }, [{
    k: "all",
    l: "All methods",
    c: 12847
  }, {
    k: "tls",
    l: "EAP-TLS",
    c: 8222
  }, {
    k: "peap",
    l: "PEAP",
    c: 2698
  }, {
    k: "mab",
    l: "MAB",
    c: 1413
  }, {
    k: "portal",
    l: "Portal",
    c: 385
  }].map(f => /*#__PURE__*/React.createElement("button", {
    key: f.k,
    className: "pf-chip" + (filterMethod === f.k ? " active" : ""),
    onClick: () => setFilterMethod(f.k)
  }, f.l, " ", /*#__PURE__*/React.createElement("span", {
    className: "pf-chip-c"
  }, f.c.toLocaleString()))), /*#__PURE__*/React.createElement("span", {
    className: "pf-filter-spacer"
  }), /*#__PURE__*/React.createElement("div", {
    className: "pf-search-mini"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "search",
    size: 12
  }), /*#__PURE__*/React.createElement("input", {
    placeholder: "Find user, MAC, NAS\u2026",
    readOnly: true
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      maxHeight: 540,
      overflowY: "auto"
    }
  }, /*#__PURE__*/React.createElement("table", {
    className: "tbl"
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", null, "User"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 110
    }
  }, "Role"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 130
    }
  }, "MAC"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 170
    }
  }, "Auth method"), /*#__PURE__*/React.createElement("th", null, "NAS \xB7 port / AP"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 110
    }
  }, "SSID"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 60,
      textAlign: "center"
    }
  }, "VLAN"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 95
    }
  }, "Started"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 150
    }
  }, "Duration"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 110
    }
  }, "Status"))), /*#__PURE__*/React.createElement("tbody", null, rows.map((s, i) => {
    const pct = Math.min(100, s.dur / 14400 * 100); // session age bar (4h scale)
    return /*#__PURE__*/React.createElement("tr", {
      key: i
    }, /*#__PURE__*/React.createElement("td", {
      className: "fg"
    }, s.user), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("span", {
      className: "role-tag " + s.role
    }, s.role)), /*#__PURE__*/React.createElement("td", null, s.mac), /*#__PURE__*/React.createElement("td", null, s.method), /*#__PURE__*/React.createElement("td", null, s.nas), /*#__PURE__*/React.createElement("td", null, s.ssid), /*#__PURE__*/React.createElement("td", {
      style: {
        textAlign: "center"
      }
    }, s.vlan), /*#__PURE__*/React.createElement("td", {
      className: "mono"
    }, s.started), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("span", {
      className: "dur-bar"
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        width: `${pct}%`
      }
    })), formatDur(s.dur)), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("span", {
      className: "reg-pill " + (s.status === "isolated" ? "isolated" : s.status === "registering" ? "pending" : "registered")
    }, /*#__PURE__*/React.createElement("span", {
      className: "dot",
      style: {
        background: "currentColor"
      }
    }), s.status)));
  })))));
};

// Recent rejects (small list)
const RECENT_REJECTS = [{
  ts: "10:51:22",
  user: "—",
  mac: "ec:0c:9a:11:42:8a",
  nas: "BHS-SW-2F-08:14",
  reason: "Invalid cert (untrusted CA)",
  sev: "warn"
}, {
  ts: "10:51:09",
  user: "—",
  mac: "9c:b6:54:af:78:e1",
  nas: "NHS-AP-Cafe-South",
  reason: "Unknown MAB · no matching OUI",
  sev: "info"
}, {
  ts: "10:50:44",
  user: "j.smith",
  mac: "70:5a:0f:32:c2:e8",
  nas: "CHS-AP-3F-East",
  reason: "AD: account disabled",
  sev: "warn"
}, {
  ts: "10:50:31",
  user: "—",
  mac: "00:1b:21:5e:00:9a",
  nas: "BHS-SW-1F-04:22",
  reason: "Fingerbank: EOL OS · violation 1100001",
  sev: "err"
}, {
  ts: "10:50:18",
  user: "k.harris",
  mac: "d8:80:39:c4:0a:7b",
  nas: "BHS-AP-2F-South",
  reason: "BYOD cert expired (re-onboard)",
  sev: "warn"
}, {
  ts: "10:49:58",
  user: "guest.78",
  mac: "f0:99:b6:11:0a:c4",
  nas: "NHS-AP-Lobby",
  reason: "Sponsor approval expired",
  sev: "info"
}, {
  ts: "10:49:14",
  user: "—",
  mac: "00:1d:c1:99:08:00",
  nas: "OPS-SW-Core:48",
  reason: "MAC spoof — already on different NAS",
  sev: "err"
}];
const RecentRejects = () => /*#__PURE__*/React.createElement("div", {
  className: "card"
}, /*#__PURE__*/React.createElement("div", {
  className: "card-h"
}, /*#__PURE__*/React.createElement("h3", null, "Recent Rejects"), /*#__PURE__*/React.createElement(SourceBadge, {
  src: "pf"
}), /*#__PURE__*/React.createElement("div", {
  className: "h-spacer"
}), /*#__PURE__*/React.createElement("span", {
  className: "h-meta"
}, "last 5 min \xB7 142 total / 1h")), /*#__PURE__*/React.createElement("div", {
  className: "events"
}, RECENT_REJECTS.map((r, i) => /*#__PURE__*/React.createElement("div", {
  className: "event",
  key: i,
  style: {
    gridTemplateColumns: "70px 130px 1fr 90px"
  }
}, /*#__PURE__*/React.createElement("div", {
  className: "ts"
}, r.ts), /*#__PURE__*/React.createElement("div", {
  className: "mono",
  style: {
    fontSize: 11,
    color: "var(--fg-2)"
  }
}, r.mac), /*#__PURE__*/React.createElement("div", {
  className: "msg"
}, /*#__PURE__*/React.createElement("span", {
  style: {
    color: r.sev === "err" ? "var(--err)" : r.sev === "warn" ? "var(--warn)" : "var(--info)",
    fontWeight: 500
  }
}, r.reason), " ", /*#__PURE__*/React.createElement("span", {
  style: {
    color: "var(--fg)"
  }
}, "\xB7 ", r.user || "—", " \xB7 ", r.nas)), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement(Sev, {
  level: r.sev === "err" ? "high" : r.sev === "warn" ? "warning" : "info"
}))))));

// ───────── App ─────────
const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "density": "balanced",
  "showSourceBadges": true,
  "filterMethod": "all"
} /*EDITMODE-END*/;
const App = () => {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  React.useEffect(() => {
    document.documentElement.classList.toggle("hide-src-badges", !t.showSourceBadges);
  }, [t.showSourceBadges]);
  return /*#__PURE__*/React.createElement("div", {
    className: "app",
    "data-density": t.density,
    "data-pf": "1",
    "data-screen-label": "User Sessions"
  }, /*#__PURE__*/React.createElement(GlobalSidebar, {
    active: "sessions"
  }), /*#__PURE__*/React.createElement("div", {
    className: "main"
  }, /*#__PURE__*/React.createElement(GlobalTopbar, {
    crumb: ["Tuscaloosa City Schools", "Identity", "User Sessions"],
    search: "Find user, MAC, NAS\u2026"
  }), /*#__PURE__*/React.createElement(SessionsHeader, null), /*#__PURE__*/React.createElement("div", {
    className: "body"
  }, /*#__PURE__*/React.createElement(DemoBanner, {
    name: "User Sessions"
  }), /*#__PURE__*/React.createElement(SessionsKPIs, null), /*#__PURE__*/React.createElement("div", {
    className: "row",
    style: {
      gridTemplateColumns: "1fr 1fr",
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "Auth Methods"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "pf"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("span", {
    className: "h-meta"
  }, "RADIUS req/sec")), /*#__PURE__*/React.createElement(AuthDonut, null)), /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "Sessions by SSID / wired"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "pf"
  }), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "ext"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("span", {
    className: "h-meta"
  }, SSID_SPLIT.reduce((n, s) => n + s.count, 0).toLocaleString(), " total")), /*#__PURE__*/React.createElement(SsidSplit, null))), /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement(SessionsTable, {
    filterMethod: t.filterMethod,
    setFilterMethod: v => setTweak("filterMethod", v)
  })), /*#__PURE__*/React.createElement(RecentRejects, null))), /*#__PURE__*/React.createElement(TweaksPanel, {
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
    label: "Show data-source badges",
    value: t.showSourceBadges,
    onChange: v => setTweak("showSourceBadges", v)
  })), /*#__PURE__*/React.createElement(TweakSection, {
    title: "Filter"
  }, /*#__PURE__*/React.createElement(TweakSelect, {
    label: "Auth method",
    value: t.filterMethod,
    options: [{
      value: "all",
      label: "All"
    }, {
      value: "tls",
      label: "EAP-TLS"
    }, {
      value: "peap",
      label: "PEAP"
    }, {
      value: "mab",
      label: "MAB"
    }, {
      value: "portal",
      label: "Captive portal"
    }],
    onChange: v => setTweak("filterMethod", v)
  }))));
};
ReactDOM.createRoot(document.getElementById("root")).render(/*#__PURE__*/React.createElement(App, null));