// NAC Policies — authentication sources, connection profiles, role/VLAN map, rules.

const NACHeader = () => /*#__PURE__*/React.createElement("div", {
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
}, /*#__PURE__*/React.createElement("h1", null, "NAC Policies"), /*#__PURE__*/React.createElement("span", {
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
}, "ADMIN \xB7 TIER-2")), /*#__PURE__*/React.createElement("div", {
  className: "host-meta"
}, /*#__PURE__*/React.createElement("span", {
  className: "pill"
}, /*#__PURE__*/React.createElement("span", {
  className: "dot",
  style: {
    background: "var(--ok)"
  }
}), " All policies in sync"), /*#__PURE__*/React.createElement("span", {
  className: "pill"
}, /*#__PURE__*/React.createElement("span", {
  className: "lbl"
}, "Profiles"), " ", /*#__PURE__*/React.createElement("span", {
  className: "v"
}, PF_PROFILES.length)), /*#__PURE__*/React.createElement("span", {
  className: "pill"
}, /*#__PURE__*/React.createElement("span", {
  className: "lbl"
}, "Auth sources"), " ", /*#__PURE__*/React.createElement("span", {
  className: "v"
}, PF_AUTH_SOURCES.length)), /*#__PURE__*/React.createElement("span", {
  className: "pill"
}, /*#__PURE__*/React.createElement("span", {
  className: "lbl"
}, "Roles"), " ", /*#__PURE__*/React.createElement("span", {
  className: "v"
}, PF_ROLES.length)), /*#__PURE__*/React.createElement("span", {
  className: "pill"
}, /*#__PURE__*/React.createElement("span", {
  className: "lbl"
}, "Last change"), " ", /*#__PURE__*/React.createElement("span", {
  className: "v"
}, "Apr 12 \xB7 09:14")))), /*#__PURE__*/React.createElement("div", {
  style: {
    display: "flex",
    gap: 8
  }
}, /*#__PURE__*/React.createElement("button", {
  className: "btn"
}, "Test policy"), /*#__PURE__*/React.createElement("button", {
  className: "btn primary"
}, "New profile")));

// KPIs
const PolicyKPIs = () => {
  const cells = [{
    lbl: "Connection profiles",
    v: 18,
    note: "8 wireless · 10 wired",
    cls: ""
  }, {
    lbl: "Auth sources",
    v: 6,
    note: "AD · SAML · RADIUS · Local",
    cls: ""
  }, {
    lbl: "Network roles",
    v: 9,
    note: "→ VLANs 110 – 666",
    cls: "pf"
  }, {
    lbl: "Enforcement points",
    v: 312,
    note: "switches + APs polled",
    cls: ""
  }, {
    lbl: "Rules evaluated 24h",
    v: "52.8k",
    note: "44.1k accept · 8.7k step-up",
    cls: "ok"
  }, {
    lbl: "Reject rate 24h",
    v: "1.0%",
    note: "527 access-reject",
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

// Authentication sources card
const AuthSources = () => /*#__PURE__*/React.createElement("div", {
  className: "card"
}, /*#__PURE__*/React.createElement("div", {
  className: "card-h"
}, /*#__PURE__*/React.createElement("h3", null, "Authentication Sources"), /*#__PURE__*/React.createElement(SourceBadge, {
  src: "pf"
}), /*#__PURE__*/React.createElement("div", {
  className: "h-spacer"
}), /*#__PURE__*/React.createElement("a", {
  className: "h-link"
}, "Edit chain ", /*#__PURE__*/React.createElement(Icon, {
  name: "external",
  size: 11
}))), /*#__PURE__*/React.createElement("div", {
  className: "card-b tight"
}, PF_AUTH_SOURCES.map(s => /*#__PURE__*/React.createElement("div", {
  className: "pf-source",
  key: s.id
}, /*#__PURE__*/React.createElement("div", {
  className: "pf-source-ico"
}, s.short), /*#__PURE__*/React.createElement("div", {
  style: {
    minWidth: 0
  }
}, /*#__PURE__*/React.createElement("div", {
  className: "pf-source-name"
}, s.name), /*#__PURE__*/React.createElement("div", {
  className: "pf-source-sub"
}, s.type, " \xB7 ", s.host, " \u2014 ", s.note)), /*#__PURE__*/React.createElement("div", {
  className: "pf-source-c"
}, s.daily.toLocaleString(), /*#__PURE__*/React.createElement("span", {
  className: "u"
}, "auth / 24h")), s.status === "ok" ? /*#__PURE__*/React.createElement("span", {
  className: "reg-pill registered"
}, /*#__PURE__*/React.createElement("span", {
  className: "dot",
  style: {
    background: "currentColor"
  }
}), "OK") : /*#__PURE__*/React.createElement("span", {
  className: "reg-pill isolated",
  style: {
    color: "var(--warn)",
    borderColor: "rgba(245,179,0,0.45)",
    background: "rgba(245,179,0,0.10)"
  }
}, /*#__PURE__*/React.createElement("span", {
  className: "dot",
  style: {
    background: "currentColor"
  }
}), "warn")))));

// Role / VLAN map
const ROLE_COLOR = {
  faculty: "#8eb0ff",
  student: "#b6a3ff",
  byod: "#6ee0b3",
  guest: "#ffd25e",
  av: "#87c4e2",
  voip: "#f1a87f",
  camera: "#87c4e2",
  iot: "#7c5cff",
  isolation: "#ff8a87"
};
const RoleVlanMap = () => /*#__PURE__*/React.createElement("div", {
  className: "card"
}, /*#__PURE__*/React.createElement("div", {
  className: "card-h"
}, /*#__PURE__*/React.createElement("h3", null, "Roles \u2192 VLAN Mapping"), /*#__PURE__*/React.createElement(SourceBadge, {
  src: "pf"
}), /*#__PURE__*/React.createElement("div", {
  className: "h-spacer"
}), /*#__PURE__*/React.createElement("span", {
  className: "h-meta"
}, "9 roles \xB7 9 VLANs")), /*#__PURE__*/React.createElement("div", {
  className: "card-b tight"
}, PF_ROLES.map(r => /*#__PURE__*/React.createElement("div", {
  className: "pf-role-row",
  key: r.id
}, /*#__PURE__*/React.createElement("div", {
  className: "pf-role-sw",
  style: {
    background: ROLE_COLOR[r.id] || "var(--pf)"
  }
}, r.vlan), /*#__PURE__*/React.createElement("div", {
  className: "pf-role-h"
}, /*#__PURE__*/React.createElement("span", {
  className: "pf-role-name"
}, r.name), /*#__PURE__*/React.createElement("span", {
  className: "pf-role-sub"
}, "role: ", r.id, " \xB7 ", r.count.toLocaleString(), " endpoints")), /*#__PURE__*/React.createElement("div", {
  className: "pf-role-kv"
}, /*#__PURE__*/React.createElement("div", {
  className: "pf-role-k"
}, "VLAN"), /*#__PURE__*/React.createElement("div", {
  className: "pf-role-v"
}, r.vlan)), /*#__PURE__*/React.createElement("div", {
  className: "pf-role-kv"
}, /*#__PURE__*/React.createElement("div", {
  className: "pf-role-k"
}, "ACL"), /*#__PURE__*/React.createElement("div", {
  className: "pf-role-v"
}, r.acl)), /*#__PURE__*/React.createElement("div", {
  className: "pf-role-kv"
}, /*#__PURE__*/React.createElement("div", {
  className: "pf-role-k"
}, "Bandwidth"), /*#__PURE__*/React.createElement("div", {
  className: "pf-role-v"
}, r.bw)), /*#__PURE__*/React.createElement(Icon, {
  name: "chevron",
  size: 14
})))));

// Connection profiles table
const Profiles = () => /*#__PURE__*/React.createElement("div", {
  className: "card"
}, /*#__PURE__*/React.createElement("div", {
  className: "card-h"
}, /*#__PURE__*/React.createElement("h3", null, "Connection Profiles"), /*#__PURE__*/React.createElement(SourceBadge, {
  src: "pf"
}), /*#__PURE__*/React.createElement("div", {
  className: "h-spacer"
}), /*#__PURE__*/React.createElement("a", {
  className: "h-link"
}, "All profiles ", /*#__PURE__*/React.createElement(Icon, {
  name: "external",
  size: 11
}))), /*#__PURE__*/React.createElement("table", {
  className: "tbl"
}, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", null, "Profile"), /*#__PURE__*/React.createElement("th", {
  style: {
    width: 130
  }
}, "SSID / medium"), /*#__PURE__*/React.createElement("th", null, "Auth source chain"), /*#__PURE__*/React.createElement("th", null, "Resulting role(s)"), /*#__PURE__*/React.createElement("th", {
  style: {
    width: 100,
    textAlign: "right"
  }
}, "24h auths"), /*#__PURE__*/React.createElement("th", {
  style: {
    width: 32
  }
}))), /*#__PURE__*/React.createElement("tbody", null, PF_PROFILES.map(p => /*#__PURE__*/React.createElement("tr", {
  key: p.id
}, /*#__PURE__*/React.createElement("td", {
  className: "fg",
  style: {
    fontWeight: 600,
    fontFamily: "var(--sans)",
    fontSize: 12
  }
}, p.name), /*#__PURE__*/React.createElement("td", null, p.ssids === "—" ? /*#__PURE__*/React.createElement("span", {
  className: "muted"
}, "wired") : p.ssids), /*#__PURE__*/React.createElement("td", null, p.sources), /*#__PURE__*/React.createElement("td", null, p.roles), /*#__PURE__*/React.createElement("td", {
  style: {
    textAlign: "right"
  },
  className: "fg"
}, p.auths.toLocaleString()), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement(Icon, {
  name: "chevron",
  size: 14
})))))));

// Enforcement rules (small condition-tree-ish list)
const RULES = [{
  id: "R-01",
  when: "source = AD-TCS AND group ∋ Staff",
  then: "role → faculty · VLAN 110",
  hits: "8,210 / 24h",
  sev: "ok"
}, {
  id: "R-02",
  when: "source = AD-Student AND OU = Students",
  then: "role → student · VLAN 120",
  hits: "31,420 / 24h",
  sev: "ok"
}, {
  id: "R-03",
  when: "source = Google AND domain = tcs.k12 AND device-class = BYOD",
  then: "role → byod · VLAN 122 · BW 10Mb",
  hits: "1,408 / 24h",
  sev: "ok"
}, {
  id: "R-04",
  when: "source = Guest portal · sponsor approved",
  then: "role → guest · VLAN 199 · BW 5Mb · 24h cap",
  hits: "712 / 24h",
  sev: "ok"
}, {
  id: "R-05",
  when: "OUI ∋ Yealink AND CDP-port-vlan = voice",
  then: "role → voip · VLAN 140",
  hits: "204 / 24h",
  sev: "ok"
}, {
  id: "R-06",
  when: "OUI ∋ Axis/Hikvision AND switch.group = NVR-uplink",
  then: "role → camera · VLAN 150",
  hits: "1,147 / 24h",
  sev: "ok"
}, {
  id: "R-07",
  when: "Fingerbank.os ∈ {Win 10 ≤ 1909, Server 2008}",
  then: "isolate → VLAN 666 · violation 1100001",
  hits: "2 / 24h",
  sev: "err"
}, {
  id: "R-08",
  when: "RADIUS-Reject count ≥ 10 / 60s per MAC",
  then: "rate-limit · alert tier-1",
  hits: "4 / 24h",
  sev: "warn"
}, {
  id: "R-09",
  when: "Cortex XDR · endpoint-agent = missing AND role = faculty",
  then: "step-up → captive remediation",
  hits: "14 / 24h",
  sev: "warn"
}];
const RulesTable = () => /*#__PURE__*/React.createElement("div", {
  className: "card"
}, /*#__PURE__*/React.createElement("div", {
  className: "card-h"
}, /*#__PURE__*/React.createElement("h3", null, "Enforcement Rules"), /*#__PURE__*/React.createElement(SourceBadge, {
  src: "pf"
}), /*#__PURE__*/React.createElement(SourceBadge, {
  src: "xdr"
}), /*#__PURE__*/React.createElement("div", {
  className: "h-spacer"
}), /*#__PURE__*/React.createElement("span", {
  className: "h-meta"
}, RULES.length, " rules \xB7 evaluated top-down"), /*#__PURE__*/React.createElement("a", {
  className: "h-link"
}, "Rule editor ", /*#__PURE__*/React.createElement(Icon, {
  name: "external",
  size: 11
}))), /*#__PURE__*/React.createElement("table", {
  className: "tbl"
}, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", {
  style: {
    width: 50
  }
}, "#"), /*#__PURE__*/React.createElement("th", null, "WHEN"), /*#__PURE__*/React.createElement("th", null, "THEN"), /*#__PURE__*/React.createElement("th", {
  style: {
    width: 120,
    textAlign: "right"
  }
}, "Hits"), /*#__PURE__*/React.createElement("th", {
  style: {
    width: 60
  }
}, "Sev"))), /*#__PURE__*/React.createElement("tbody", null, RULES.map(r => /*#__PURE__*/React.createElement("tr", {
  key: r.id
}, /*#__PURE__*/React.createElement("td", {
  className: "mono"
}, r.id), /*#__PURE__*/React.createElement("td", {
  className: "fg"
}, r.when), /*#__PURE__*/React.createElement("td", null, r.then), /*#__PURE__*/React.createElement("td", {
  style: {
    textAlign: "right"
  },
  className: "fg"
}, r.hits), /*#__PURE__*/React.createElement("td", null, r.sev === "ok" && /*#__PURE__*/React.createElement(Sev, {
  level: "info"
}), r.sev === "warn" && /*#__PURE__*/React.createElement(Sev, {
  level: "warning"
}), r.sev === "err" && /*#__PURE__*/React.createElement(Sev, {
  level: "high"
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
    "data-screen-label": "NAC Policies"
  }, /*#__PURE__*/React.createElement(GlobalSidebar, {
    active: "nac"
  }), /*#__PURE__*/React.createElement("div", {
    className: "main"
  }, /*#__PURE__*/React.createElement(GlobalTopbar, {
    crumb: ["Tuscaloosa City Schools", "Identity", "NAC Policies"]
  }), /*#__PURE__*/React.createElement(NACHeader, null), /*#__PURE__*/React.createElement("div", {
    className: "body"
  }, /*#__PURE__*/React.createElement(DemoBanner, {
    name: "NAC Policies"
  }), /*#__PURE__*/React.createElement(PolicyKPIs, null), /*#__PURE__*/React.createElement("div", {
    className: "row",
    style: {
      gridTemplateColumns: "1fr 1fr",
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement(AuthSources, null), /*#__PURE__*/React.createElement(RoleVlanMap, null)), /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement(Profiles, null)), /*#__PURE__*/React.createElement(RulesTable, null))), /*#__PURE__*/React.createElement(TweaksPanel, {
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
  }))));
};
ReactDOM.createRoot(document.getElementById("root")).render(/*#__PURE__*/React.createElement(App, null));