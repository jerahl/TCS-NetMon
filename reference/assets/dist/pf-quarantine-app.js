// Quarantine — currently isolated endpoints, active violations, remediation queue.

const QuarantineHeader = () => /*#__PURE__*/React.createElement("div", {
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
}, /*#__PURE__*/React.createElement("h1", null, "Quarantine"), /*#__PURE__*/React.createElement("span", {
  className: "role-tag",
  style: {
    fontSize: 10,
    padding: "1px 8px",
    background: "rgba(245,179,0,0.10)",
    color: "var(--pf)",
    border: "1px solid rgba(245,179,0,0.4)"
  }
}, "IDENTITY \xB7 PACKETFENCE"), /*#__PURE__*/React.createElement("span", {
  className: "role-tag quarantine",
  style: {
    fontSize: 10,
    padding: "1px 8px"
  }
}, "ISOLATION \xB7 VLAN 666")), /*#__PURE__*/React.createElement("div", {
  className: "host-meta"
}, /*#__PURE__*/React.createElement("span", {
  className: "pill"
}, /*#__PURE__*/React.createElement("span", {
  className: "dot",
  style: {
    background: "var(--err)"
  }
}), " 2 endpoints isolated"), /*#__PURE__*/React.createElement("span", {
  className: "pill"
}, /*#__PURE__*/React.createElement("span", {
  className: "lbl"
}, "Violations 24h"), " ", /*#__PURE__*/React.createElement("span", {
  className: "v"
}, "98")), /*#__PURE__*/React.createElement("span", {
  className: "pill"
}, /*#__PURE__*/React.createElement("span", {
  className: "lbl"
}, "Self-remediated"), " ", /*#__PURE__*/React.createElement("span", {
  className: "v"
}, "47")), /*#__PURE__*/React.createElement("span", {
  className: "pill"
}, /*#__PURE__*/React.createElement("span", {
  className: "lbl"
}, "Open tickets"), " ", /*#__PURE__*/React.createElement("span", {
  className: "v"
}, "2")), /*#__PURE__*/React.createElement("span", {
  className: "pill"
}, /*#__PURE__*/React.createElement("span", {
  className: "lbl"
}, "Last isolate"), " ", /*#__PURE__*/React.createElement("span", {
  className: "v"
}, "10:38")))), /*#__PURE__*/React.createElement("div", {
  style: {
    display: "flex",
    gap: 8
  }
}, /*#__PURE__*/React.createElement("button", {
  className: "btn"
}, "Bulk \xB7 re-evaluate"), /*#__PURE__*/React.createElement("button", {
  className: "btn primary"
}, "Release selected")));

// KPI strip
const QuarKPIs = () => {
  const cells = [{
    lbl: "Currently isolated",
    v: 2,
    note: "VLAN 666 · captive page",
    cls: "err"
  }, {
    lbl: "New violations 24h",
    v: 98,
    note: "44 unique endpoints",
    cls: "warn"
  }, {
    lbl: "Self-remediated",
    v: 47,
    note: "via captive portal",
    cls: "ok"
  }, {
    lbl: "Manual release",
    v: 6,
    note: "admin action · last 24h",
    cls: ""
  }, {
    lbl: "Avg time-to-clear",
    v: "27m",
    note: "from isolation → clear",
    cls: ""
  }, {
    lbl: "Open tickets",
    v: 2,
    note: "TKT-9302 · TKT-9311",
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

// Isolated endpoints — focal card
const ISOLATED = [{
  mac: "d4:6e:0e:33:b8:7c",
  host: "Win10-LegacyLab-04",
  owner: "—",
  site: "NHS",
  loc: "NHS-SW-Lab-A · port 11",
  vlan: 666,
  since: "10:38:21 (today)",
  violation: {
    id: 1100001,
    name: "EOL operating system",
    sev: "err"
  },
  detail: "Endpoint reports Windows 10 build 1909 (EOS Aug-2021). Auto-isolation applied via Fingerbank rule R-07. Captive remediation page presents reimage instructions.",
  actions: ["Release (one-time)", "Whitelist for 24h", "Open ticket"],
  history: [{
    ts: "10:38:21",
    ev: "Auto-isolated · rule R-07"
  }, {
    ts: "10:38:09",
    ev: "Fingerbank OS = Win10·1909"
  }, {
    ts: "10:37:55",
    ev: "EAP-TLS accept · pre-isolation"
  }]
}, {
  mac: "fc:fb:fb:11:90:0a",
  host: "WIN-EOL-2008",
  owner: "—",
  site: "NHS",
  loc: "NHS-SW-3F-08 · port 14",
  vlan: 666,
  since: "Yesterday · 14:22",
  violation: {
    id: 1100002,
    name: "EOL server",
    sev: "err"
  },
  detail: "Server 2008 R2 discovered on student VLAN during port-scan correlation. Ticket TKT-9302 open with Facilities — pending physical decommissioning.",
  actions: ["Snooze (notify in 24h)", "Open ticket", "Force re-auth"],
  history: [{
    ts: "Y · 14:22",
    ev: "Auto-isolated · rule R-07"
  }, {
    ts: "Y · 14:21",
    ev: "OS fingerprint via DHCP"
  }, {
    ts: "Y · 14:20",
    ev: "MAB · port-up"
  }]
}];
const IsolatedCard = ({
  d
}) => /*#__PURE__*/React.createElement("div", {
  className: "card"
}, /*#__PURE__*/React.createElement("div", {
  className: "card-h",
  style: {
    background: "rgba(242,95,92,0.06)"
  }
}, /*#__PURE__*/React.createElement(Icon, {
  name: "lock"
}), /*#__PURE__*/React.createElement("h3", {
  style: {
    color: "var(--err)"
  }
}, d.host), /*#__PURE__*/React.createElement("span", {
  className: "mono",
  style: {
    fontSize: 11,
    color: "var(--muted)"
  }
}, d.mac), /*#__PURE__*/React.createElement("div", {
  className: "h-spacer"
}), /*#__PURE__*/React.createElement("span", {
  className: "reg-pill isolated"
}, /*#__PURE__*/React.createElement("span", {
  className: "dot",
  style: {
    background: "currentColor"
  }
}), "isolated"), /*#__PURE__*/React.createElement(SourceBadge, {
  src: "pf"
})), /*#__PURE__*/React.createElement("div", {
  className: "card-b",
  style: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 14
  }
}, /*#__PURE__*/React.createElement("div", {
  className: "kv",
  style: {
    gridTemplateColumns: "120px 1fr",
    borderRight: "1px solid var(--line)",
    marginRight: -14,
    paddingRight: 0
  }
}, /*#__PURE__*/React.createElement("div", {
  className: "k"
}, "Site"), /*#__PURE__*/React.createElement("div", {
  className: "v"
}, d.site), /*#__PURE__*/React.createElement("div", {
  className: "k"
}, "Location"), /*#__PURE__*/React.createElement("div", {
  className: "v"
}, d.loc), /*#__PURE__*/React.createElement("div", {
  className: "k"
}, "VLAN"), /*#__PURE__*/React.createElement("div", {
  className: "v"
}, d.vlan, " \xB7 ACL-QUARANTINE"), /*#__PURE__*/React.createElement("div", {
  className: "k"
}, "Isolated since"), /*#__PURE__*/React.createElement("div", {
  className: "v"
}, d.since), /*#__PURE__*/React.createElement("div", {
  className: "k"
}, "Violation"), /*#__PURE__*/React.createElement("div", {
  className: "v"
}, /*#__PURE__*/React.createElement("span", {
  className: "mono",
  style: {
    color: "var(--err)"
  }
}, "#", d.violation.id), " \xB7 ", d.violation.name)), /*#__PURE__*/React.createElement("div", {
  style: {
    display: "flex",
    flexDirection: "column",
    gap: 12
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    fontSize: 11.5,
    color: "var(--fg-2)",
    lineHeight: 1.5,
    borderLeft: "2px solid var(--err)",
    paddingLeft: 10
  }
}, d.detail), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
  style: {
    fontSize: 10,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    color: "var(--muted)",
    marginBottom: 6
  }
}, "Recent activity"), /*#__PURE__*/React.createElement("div", {
  style: {
    display: "flex",
    flexDirection: "column",
    gap: 4
  }
}, d.history.map((h, i) => /*#__PURE__*/React.createElement("div", {
  key: i,
  style: {
    display: "flex",
    gap: 10,
    fontSize: 11
  }
}, /*#__PURE__*/React.createElement("span", {
  className: "mono",
  style: {
    color: "var(--muted)",
    width: 80
  }
}, h.ts), /*#__PURE__*/React.createElement("span", {
  style: {
    color: "var(--fg-2)"
  }
}, h.ev))))), /*#__PURE__*/React.createElement("div", {
  style: {
    display: "flex",
    gap: 8,
    flexWrap: "wrap"
  }
}, d.actions.map(a => /*#__PURE__*/React.createElement("button", {
  key: a,
  className: "btn sm"
}, a)), /*#__PURE__*/React.createElement("button", {
  className: "btn sm primary"
}, "Release")))));

// Violation catalog
const ViolationCatalog = () => /*#__PURE__*/React.createElement("div", {
  className: "card"
}, /*#__PURE__*/React.createElement("div", {
  className: "card-h"
}, /*#__PURE__*/React.createElement("h3", null, "Active Violations"), /*#__PURE__*/React.createElement(SourceBadge, {
  src: "pf"
}), /*#__PURE__*/React.createElement(SourceBadge, {
  src: "xdr"
}), /*#__PURE__*/React.createElement("div", {
  className: "h-spacer"
}), /*#__PURE__*/React.createElement("span", {
  className: "h-meta"
}, PF_VIOLATIONS.length, " configured \xB7 sorted by 24h hit-count"), /*#__PURE__*/React.createElement("a", {
  className: "h-link"
}, "Catalog ", /*#__PURE__*/React.createElement(Icon, {
  name: "external",
  size: 11
}))), /*#__PURE__*/React.createElement("div", {
  className: "card-b tight"
}, [...PF_VIOLATIONS].sort((a, b) => b.count - a.count).map(v => /*#__PURE__*/React.createElement("div", {
  className: "pf-violation",
  key: v.id
}, /*#__PURE__*/React.createElement("div", {
  className: "pf-violation-rail " + (v.sev === "err" ? "err" : v.sev === "warn" ? "warn" : "info")
}), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
  className: "pf-violation-h"
}, /*#__PURE__*/React.createElement("span", {
  className: "pf-violation-name"
}, v.name), /*#__PURE__*/React.createElement("span", {
  className: "pf-violation-id"
}, "#", v.id), v.sev === "err" && /*#__PURE__*/React.createElement(Sev, {
  level: "high"
}), v.sev === "warn" && /*#__PURE__*/React.createElement(Sev, {
  level: "warning"
}), v.sev === "info" && /*#__PURE__*/React.createElement(Sev, {
  level: "info"
})), /*#__PURE__*/React.createElement("div", {
  className: "pf-violation-body"
}, v.body), /*#__PURE__*/React.createElement("div", {
  className: "pf-violation-meta"
}, /*#__PURE__*/React.createElement("span", null, "\u21B3 Trigger \xB7 ", v.trigger), /*#__PURE__*/React.createElement("span", null, "\u21B3 Remediation \xB7 ", v.remediation))), /*#__PURE__*/React.createElement("div", {
  className: "pf-violation-count"
}, v.count, /*#__PURE__*/React.createElement("span", {
  className: "u"
}, "hits 24h"))))));

// Remediation queue — small list of items in-flight
const REMEDIATION = [{
  mac: "d8:80:39:c4:0a:7b",
  user: "k.harris",
  why: "BYOD cert expiring · 3d left",
  state: "User notified · email + portal",
  age: "1h"
}, {
  mac: "70:5a:0f:32:c2:e8",
  user: "subteacher.51",
  why: "Cortex XDR agent missing",
  state: "Step-up captive presented",
  age: "20m"
}, {
  mac: "ec:b1:d7:6a:5f:09",
  user: "—",
  why: "Switch firmware compliance",
  state: "Auto-deferred · maintenance window",
  age: "3h"
}, {
  mac: "9c:b6:54:af:78:e1",
  user: "—",
  why: "Captive portal abandoned",
  state: "Awaiting AUP accept · 4h left",
  age: "42m"
}, {
  mac: "00:1b:21:5e:00:9a",
  user: "—",
  why: "EOL OS (Win10·1909)",
  state: "Pending reimage · TKT-9311",
  age: "5h"
}];
const Remediation = () => /*#__PURE__*/React.createElement("div", {
  className: "card"
}, /*#__PURE__*/React.createElement("div", {
  className: "card-h"
}, /*#__PURE__*/React.createElement("h3", null, "Remediation Queue"), /*#__PURE__*/React.createElement(SourceBadge, {
  src: "pf"
}), /*#__PURE__*/React.createElement("div", {
  className: "h-spacer"
}), /*#__PURE__*/React.createElement("span", {
  className: "h-meta"
}, "5 in-flight \xB7 clearing automatically")), /*#__PURE__*/React.createElement("table", {
  className: "tbl"
}, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", {
  style: {
    width: 130
  }
}, "MAC"), /*#__PURE__*/React.createElement("th", null, "User"), /*#__PURE__*/React.createElement("th", null, "Reason"), /*#__PURE__*/React.createElement("th", null, "State"), /*#__PURE__*/React.createElement("th", {
  style: {
    width: 60,
    textAlign: "right"
  }
}, "Age"), /*#__PURE__*/React.createElement("th", {
  style: {
    width: 30
  }
}))), /*#__PURE__*/React.createElement("tbody", null, REMEDIATION.map((r, i) => /*#__PURE__*/React.createElement("tr", {
  key: i
}, /*#__PURE__*/React.createElement("td", {
  className: "fg"
}, r.mac), /*#__PURE__*/React.createElement("td", {
  className: "fg"
}, r.user), /*#__PURE__*/React.createElement("td", null, r.why), /*#__PURE__*/React.createElement("td", null, r.state), /*#__PURE__*/React.createElement("td", {
  style: {
    textAlign: "right"
  },
  className: "mono"
}, r.age), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement(Icon, {
  name: "chevron",
  size: 14
})))))));

// ───────── App ─────────
const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "density": "balanced",
  "showSourceBadges": true
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
    "data-screen-label": "Quarantine"
  }, /*#__PURE__*/React.createElement(GlobalSidebar, {
    active: "quar"
  }), /*#__PURE__*/React.createElement("div", {
    className: "main"
  }, /*#__PURE__*/React.createElement(GlobalTopbar, {
    crumb: ["Tuscaloosa City Schools", "Identity", "Quarantine"]
  }), /*#__PURE__*/React.createElement(QuarantineHeader, null), /*#__PURE__*/React.createElement("div", {
    className: "body"
  }, /*#__PURE__*/React.createElement(DemoBanner, {
    name: "Quarantine"
  }), /*#__PURE__*/React.createElement(QuarKPIs, null), /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 14,
      display: "grid",
      gridTemplateColumns: "1fr 1fr",
      gap: 14
    }
  }, ISOLATED.map(d => /*#__PURE__*/React.createElement(IsolatedCard, {
    key: d.mac,
    d: d
  }))), /*#__PURE__*/React.createElement("div", {
    className: "row",
    style: {
      gridTemplateColumns: "1.4fr 1fr",
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement(ViolationCatalog, null), /*#__PURE__*/React.createElement(Remediation, null)))), /*#__PURE__*/React.createElement(TweaksPanel, {
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
    title: "Quick actions"
  }, /*#__PURE__*/React.createElement(TweakButton, {
    onClick: () => alert("This would release both isolated endpoints back to their previous role.")
  }, "Release all isolated"), /*#__PURE__*/React.createElement(TweakButton, {
    onClick: () => alert("This would force a re-evaluation of all open violations.")
  }, "Re-evaluate violations"))));
};
ReactDOM.createRoot(document.getElementById("root")).render(/*#__PURE__*/React.createElement(App, null));