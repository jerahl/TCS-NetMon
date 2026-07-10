// Connected Devices — PacketFence endpoint inventory across the district.
// Layout: KPI strip → 24h connect-trend → device-type split + filters → main table.

const PFHeader = ({
  title,
  tag,
  crumb,
  kpiRow
}) => /*#__PURE__*/React.createElement("div", {
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
}, /*#__PURE__*/React.createElement("h1", null, title), /*#__PURE__*/React.createElement("span", {
  className: "role-tag",
  style: {
    fontSize: 10,
    padding: "1px 8px",
    background: "rgba(245,179,0,0.10)",
    color: "var(--pf)",
    border: "1px solid rgba(245,179,0,0.4)"
  }
}, "IDENTITY \xB7 PACKETFENCE"), tag && /*#__PURE__*/React.createElement("span", {
  className: "role-tag faculty",
  style: {
    fontSize: 10,
    padding: "1px 8px"
  }
}, tag)), /*#__PURE__*/React.createElement("div", {
  className: "host-meta"
}, /*#__PURE__*/React.createElement("span", {
  className: "pill"
}, /*#__PURE__*/React.createElement("span", {
  className: "dot",
  style: {
    background: "var(--ok)"
  }
}), " Cluster 3/3 online"), /*#__PURE__*/React.createElement("span", {
  className: "pill"
}, /*#__PURE__*/React.createElement("span", {
  className: "lbl"
}, "PacketFence"), " ", /*#__PURE__*/React.createElement("span", {
  className: "v"
}, "v", PF_SUMMARY.pfVersion)), /*#__PURE__*/React.createElement("span", {
  className: "pill"
}, /*#__PURE__*/React.createElement("span", {
  className: "lbl"
}, "Sites"), " ", /*#__PURE__*/React.createElement("span", {
  className: "v"
}, PF_SUMMARY.sites)), /*#__PURE__*/React.createElement("span", {
  className: "pill"
}, /*#__PURE__*/React.createElement("span", {
  className: "lbl"
}, "Endpoints"), " ", /*#__PURE__*/React.createElement("span", {
  className: "v"
}, PF_SUMMARY.total.toLocaleString())), /*#__PURE__*/React.createElement("span", {
  className: "pill"
}, /*#__PURE__*/React.createElement("span", {
  className: "lbl"
}, "Last sync"), " ", /*#__PURE__*/React.createElement("span", {
  className: "v"
}, PF_SUMMARY.lastSync)))), /*#__PURE__*/React.createElement("div", {
  className: "timerange"
}, /*#__PURE__*/React.createElement(Icon, {
  name: "calendar"
}), /*#__PURE__*/React.createElement("span", {
  className: "range-val"
}, "Last 24h"), /*#__PURE__*/React.createElement(Icon, {
  name: "chevron"
})));

// ───────── KPI strip ─────────
const ClientsKPIs = () => {
  const s = PF_SUMMARY;
  const cells = [{
    lbl: "Total endpoints",
    v: s.total.toLocaleString(),
    note: "12,704 unique users",
    cls: ""
  }, {
    lbl: "Registered",
    v: s.registered.toLocaleString(),
    note: "93.1% of total",
    cls: "ok"
  }, {
    lbl: "Guest · portal",
    v: s.guest,
    note: "24h · self-reg",
    cls: "pf"
  }, {
    lbl: "Unregistered",
    v: s.unregistered,
    note: "pending · OUI",
    cls: "warn"
  }, {
    lbl: "Isolated",
    v: s.isolated,
    note: "VLAN 666",
    cls: "err"
  }, {
    lbl: "New today",
    v: 142,
    note: "+12 vs avg",
    cls: ""
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

// ───────── 24h connections ─────────
const ConnectsTrend = () => {
  const data = PF_CONNECTS_24H;
  const max = Math.max(...data);
  return /*#__PURE__*/React.createElement("div", {
    className: "card",
    style: {
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "Endpoint Connections (24h)"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "pf"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("span", {
    className: "h-meta"
  }, data.reduce((a, b) => a + b, 0).toLocaleString(), " auth attempts \xB7 peak ", max.toLocaleString(), " @ 09:00")), /*#__PURE__*/React.createElement("div", {
    className: "pf-bars24"
  }, data.map((v, i) => /*#__PURE__*/React.createElement("div", {
    className: "pf-bar",
    key: i,
    title: `${i}:00 — ${v} connections`
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      height: `${v / max * 100}%`
    },
    className: i === 7 || i === 8 || i === 9 ? "" : ""
  }), i % 4 === 0 && /*#__PURE__*/React.createElement("div", {
    className: "pf-bar-tick"
  }, i.toString().padStart(2, "0"))))));
};

// ───────── Device type / role split (visual breakdown) ─────────
const RolePie = () => {
  const roles = PF_ROLES.filter(r => r.id !== "isolation");
  const total = roles.reduce((n, r) => n + r.count, 0);
  const palette = ["var(--pf)", "var(--info)", "#e8843c", "var(--ext)", "var(--ok)", "var(--zbx)", "#c084fc", "#22d3ee"];
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
    return roles.map((r, i) => {
      const frac = r.count / total;
      const dash = C * frac;
      const off = -C * acc;
      acc += frac;
      return /*#__PURE__*/React.createElement("circle", {
        key: r.id,
        cx: "60",
        cy: "60",
        r: "48",
        stroke: palette[i % palette.length],
        strokeWidth: "14",
        fill: "none",
        strokeDasharray: `${dash} ${C}`,
        strokeDashoffset: off,
        transform: "rotate(-90 60 60)"
      });
    });
  })(), /*#__PURE__*/React.createElement("text", {
    x: "60",
    y: "58",
    textAnchor: "middle",
    fill: "var(--fg)",
    fontFamily: "var(--mono)",
    fontSize: "16",
    fontWeight: "600"
  }, total.toLocaleString()), /*#__PURE__*/React.createElement("text", {
    x: "60",
    y: "74",
    textAnchor: "middle",
    fill: "var(--muted)",
    fontSize: "9",
    letterSpacing: "0.5"
  }, "DEVICES")), /*#__PURE__*/React.createElement("div", {
    className: "pf-donut-legend"
  }, roles.map((r, i) => /*#__PURE__*/React.createElement("div", {
    className: "pf-leg-row",
    key: r.id
  }, /*#__PURE__*/React.createElement("span", {
    className: "pf-leg-sw",
    style: {
      background: palette[i % palette.length]
    }
  }), /*#__PURE__*/React.createElement("span", {
    className: "pf-leg-lbl"
  }, r.name), /*#__PURE__*/React.createElement("span", {
    className: "pf-leg-v"
  }, r.count.toLocaleString()), /*#__PURE__*/React.createElement("span", {
    className: "pf-leg-pct"
  }, (r.count / total * 100).toFixed(1), "%")))));
};

// ───────── Filter bar + main table ─────────
const STATUS_FILTERS = [{
  k: "all",
  l: "All",
  c: 12847
}, {
  k: "registered",
  l: "Registered",
  c: 11962
}, {
  k: "guest",
  l: "Guest",
  c: 712
}, {
  k: "pending",
  l: "Pending",
  c: 4
}, {
  k: "unregistered",
  l: "Unregistered",
  c: 173
}, {
  k: "isolated",
  l: "Isolated",
  c: 2
}];
const DevicesTable = ({
  filterStatus,
  setFilterStatus,
  filterRole,
  setFilterRole
}) => {
  const rows = PF_DEVICES.filter(d => {
    if (filterStatus !== "all" && d.status !== filterStatus) return false;
    if (filterRole !== "all" && d.role !== filterRole) return false;
    return true;
  });
  return /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "Endpoint Inventory"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "pf"
  }), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "ext"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("span", {
    className: "h-meta"
  }, rows.length, " of ", PF_DEVICES.length, " shown"), /*#__PURE__*/React.createElement("a", {
    className: "h-link"
  }, "Export CSV ", /*#__PURE__*/React.createElement(Icon, {
    name: "external",
    size: 11
  }))), /*#__PURE__*/React.createElement("div", {
    className: "pf-filterbar"
  }, STATUS_FILTERS.map(f => /*#__PURE__*/React.createElement("button", {
    key: f.k,
    className: "pf-chip" + (filterStatus === f.k ? " active" : ""),
    onClick: () => setFilterStatus(f.k)
  }, f.l, " ", /*#__PURE__*/React.createElement("span", {
    className: "pf-chip-c"
  }, f.c.toLocaleString()))), /*#__PURE__*/React.createElement("span", {
    className: "pf-filter-spacer"
  }), /*#__PURE__*/React.createElement("select", {
    value: filterRole,
    onChange: e => setFilterRole(e.target.value),
    style: {
      background: "var(--bg-2)",
      border: "1px solid var(--line)",
      color: "var(--fg-2)",
      fontSize: 11.5,
      padding: "4px 8px",
      borderRadius: 6,
      fontFamily: "inherit"
    }
  }, /*#__PURE__*/React.createElement("option", {
    value: "all"
  }, "All roles"), PF_ROLES.map(r => /*#__PURE__*/React.createElement("option", {
    key: r.id,
    value: r.id
  }, r.name))), /*#__PURE__*/React.createElement("div", {
    className: "pf-search-mini"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "search",
    size: 12
  }), /*#__PURE__*/React.createElement("input", {
    placeholder: "Find MAC, hostname, owner\u2026",
    readOnly: true
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      maxHeight: 520,
      overflowY: "auto"
    }
  }, /*#__PURE__*/React.createElement("table", {
    className: "tbl"
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", {
    style: {
      width: 130
    }
  }, "MAC"), /*#__PURE__*/React.createElement("th", null, "Hostname / device"), /*#__PURE__*/React.createElement("th", null, "Owner"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 110
    }
  }, "Role"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 60,
      textAlign: "center"
    }
  }, "VLAN"), /*#__PURE__*/React.createElement("th", null, "NAS / location"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 110
    }
  }, "SSID"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 95
    }
  }, "Last seen"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 115
    }
  }, "Status"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 32
    }
  }))), /*#__PURE__*/React.createElement("tbody", null, rows.map((d, i) => /*#__PURE__*/React.createElement("tr", {
    key: i
  }, /*#__PURE__*/React.createElement("td", {
    className: "fg"
  }, d.mac), /*#__PURE__*/React.createElement("td", {
    className: "fg"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      lineHeight: 1.3
    }
  }, /*#__PURE__*/React.createElement("span", null, d.host), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 10,
      color: "var(--muted)"
    }
  }, d.vendor, " \xB7 ", d.os))), /*#__PURE__*/React.createElement("td", {
    style: {
      fontFamily: "var(--sans)",
      fontSize: 11.5
    }
  }, d.owner), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("span", {
    className: "role-tag " + d.role
  }, d.role)), /*#__PURE__*/React.createElement("td", {
    style: {
      textAlign: "center"
    }
  }, d.vlan), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      lineHeight: 1.3
    }
  }, /*#__PURE__*/React.createElement("span", null, d.loc), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 10,
      color: "var(--muted)"
    }
  }, "site ", d.site))), /*#__PURE__*/React.createElement("td", null, d.ssid), /*#__PURE__*/React.createElement("td", {
    className: "mono"
  }, d.lastSeen), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("span", {
    className: "reg-pill " + d.status
  }, /*#__PURE__*/React.createElement("span", {
    className: "dot",
    style: {
      background: "currentColor"
    }
  }), d.status)), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement(SourceBadge, {
    src: d.src
  }))))))));
};

// ───────── App ─────────
const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "density": "balanced",
  "showSourceBadges": true,
  "filterStatus": "all",
  "filterRole": "all"
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
    "data-screen-label": "Connected Devices"
  }, /*#__PURE__*/React.createElement(GlobalSidebar, {
    active: "clients"
  }), /*#__PURE__*/React.createElement("div", {
    className: "main"
  }, /*#__PURE__*/React.createElement(GlobalTopbar, {
    crumb: ["Tuscaloosa City Schools", "Identity", "Connected Devices"],
    search: "Find MAC, hostname, user, IP\u2026"
  }), /*#__PURE__*/React.createElement(PFHeader, {
    title: "Connected Devices"
  }), /*#__PURE__*/React.createElement("div", {
    className: "body"
  }, /*#__PURE__*/React.createElement(DemoBanner, {
    name: "Connected Devices"
  }), /*#__PURE__*/React.createElement(ClientsKPIs, null), /*#__PURE__*/React.createElement("div", {
    className: "row",
    style: {
      gridTemplateColumns: "1.6fr 1fr",
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement(ConnectsTrend, null), /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "Devices by Role"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "pf"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("a", {
    className: "h-link"
  }, "Manage roles ", /*#__PURE__*/React.createElement(Icon, {
    name: "external",
    size: 11
  }))), /*#__PURE__*/React.createElement(RolePie, null))), /*#__PURE__*/React.createElement(DevicesTable, {
    filterStatus: t.filterStatus,
    setFilterStatus: v => setTweak("filterStatus", v),
    filterRole: t.filterRole,
    setFilterRole: v => setTweak("filterRole", v)
  }))), /*#__PURE__*/React.createElement(TweaksPanel, {
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
    title: "Filters"
  }, /*#__PURE__*/React.createElement(TweakSelect, {
    label: "Status",
    value: t.filterStatus,
    options: STATUS_FILTERS.map(f => ({
      value: f.k,
      label: f.l
    })),
    onChange: v => setTweak("filterStatus", v)
  }), /*#__PURE__*/React.createElement(TweakSelect, {
    label: "Role",
    value: t.filterRole,
    options: [{
      value: "all",
      label: "All roles"
    }, ...PF_ROLES.map(r => ({
      value: r.id,
      label: r.name
    }))],
    onChange: v => setTweak("filterRole", v)
  }))));
};
window.PFHeader = PFHeader; // exposed for other PF pages that share the file via include order is not used, but just for safety in inspection
ReactDOM.createRoot(document.getElementById("root")).render(/*#__PURE__*/React.createElement(App, null));