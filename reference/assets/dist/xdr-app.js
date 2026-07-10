// Cortex XDR · TCS Security tenant — endpoint detection & response dashboard.
// Layout: header → KPI strip → featured active incident (kill-chain + actions)
// → incident severity 7d + detection sources → MITRE ATT&CK heatmap →
// endpoint agent OS strip → top risky users / hosts → alerts table → hunts
// → events.

const {
  useState,
  useEffect
} = React;

// Compact numbers
const xdrCompact = n => {
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return n.toLocaleString();
};

// Score → class
const scoreClass = s => s >= 85 ? "crit" : s >= 65 ? "high" : s >= 45 ? "med" : "low";

// ───────── Header ─────────
const XdrHeader = ({
  now,
  timeRange
}) => {
  const t = XDR_TENANT;
  const k = XDR_KPI;
  return /*#__PURE__*/React.createElement("div", {
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
  }, /*#__PURE__*/React.createElement("h1", null, "Cortex XDR ", /*#__PURE__*/React.createElement("small", null, "\xB7 ", t.name)), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "xdr"
  }), /*#__PURE__*/React.createElement("span", {
    className: "role-tag voip",
    style: {
      fontSize: 10,
      padding: "1px 8px"
    }
  }, "SECURITY OPS"), /*#__PURE__*/React.createElement("span", {
    className: "ip"
  }, t.console)), /*#__PURE__*/React.createElement("div", {
    className: "host-meta"
  }, /*#__PURE__*/React.createElement("span", {
    className: "pill"
  }, /*#__PURE__*/React.createElement("span", {
    className: "refresh-ring"
  }), " ", /*#__PURE__*/React.createElement("span", {
    className: "lbl"
  }, "Tenant sync"), " ", /*#__PURE__*/React.createElement("span", {
    className: "v"
  }, t.lastSync)), /*#__PURE__*/React.createElement("span", {
    className: "pill"
  }, /*#__PURE__*/React.createElement("span", {
    className: "lbl"
  }, "Tenant ID"), " ", /*#__PURE__*/React.createElement("span", {
    className: "v"
  }, t.tenantId)), /*#__PURE__*/React.createElement("span", {
    className: "pill"
  }, /*#__PURE__*/React.createElement("span", {
    className: "lbl"
  }, "Region"), " ", /*#__PURE__*/React.createElement("span", {
    className: "v"
  }, t.region)), /*#__PURE__*/React.createElement("span", {
    className: "pill"
  }, /*#__PURE__*/React.createElement("span", {
    className: "lbl"
  }, "Agents"), " ", /*#__PURE__*/React.createElement("span", {
    className: "v"
  }, xdrCompact(t.agentsDeployed), "/", xdrCompact(t.agentsTotal))), /*#__PURE__*/React.createElement("span", {
    className: "pill"
  }, /*#__PURE__*/React.createElement("span", {
    className: "lbl"
  }, "Policy"), " ", /*#__PURE__*/React.createElement("span", {
    className: "v"
  }, t.policyVersion)), /*#__PURE__*/React.createElement("span", {
    className: "pill"
  }, /*#__PURE__*/React.createElement("span", {
    className: "lbl"
  }, "Content"), " ", /*#__PURE__*/React.createElement("span", {
    className: "v"
  }, t.contentPack)), /*#__PURE__*/React.createElement("span", {
    className: "pill"
  }, /*#__PURE__*/React.createElement("span", {
    className: "dot",
    style: {
      background: "var(--err)"
    }
  }), " ", k.incidents.open, " open incidents"), /*#__PURE__*/React.createElement("span", {
    className: "pill"
  }, /*#__PURE__*/React.createElement("span", {
    className: "lbl"
  }, "Refresh"), " ", /*#__PURE__*/React.createElement("span", {
    className: "v"
  }, now)))), /*#__PURE__*/React.createElement("div", {
    className: "timerange"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "calendar"
  }), /*#__PURE__*/React.createElement("span", {
    className: "range-val"
  }, timeRange), /*#__PURE__*/React.createElement(Icon, {
    name: "chevron"
  })));
};

// ───────── KPI strip ─────────
const XdrKpiStrip = () => {
  const k = XDR_KPI;
  const inc = k.incidents;
  const totalInc = inc.critical + inc.high + inc.med + inc.low;
  return /*#__PURE__*/React.createElement("div", {
    className: "card",
    style: {
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "xdr-kpi"
  }, /*#__PURE__*/React.createElement("div", {
    className: "xdr-kpi-cell crit"
  }, /*#__PURE__*/React.createElement("div", {
    className: "xdr-kpi-h"
  }, /*#__PURE__*/React.createElement("span", {
    className: "xdr-kpi-lbl"
  }, "Open Incidents"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "xdr"
  })), /*#__PURE__*/React.createElement("div", {
    className: "xdr-kpi-v"
  }, inc.open, /*#__PURE__*/React.createElement("span", {
    className: "u"
  }, "\xB7 +", inc.new24h, " new 24h")), /*#__PURE__*/React.createElement("div", {
    className: "xdr-sev-mini"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: inc.critical,
      background: "var(--err)"
    },
    title: `${inc.critical} critical`
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: inc.high,
      background: "var(--xdr)"
    },
    title: `${inc.high} high`
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: inc.med,
      background: "var(--warn)"
    },
    title: `${inc.med} medium`
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: inc.low,
      background: "var(--info)"
    },
    title: `${inc.low} low`
  })), /*#__PURE__*/React.createElement("div", {
    className: "xdr-kpi-foot"
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--err)"
    }
  }, inc.critical, " crit"), /*#__PURE__*/React.createElement("span", null, "\xB7 ", inc.high, " high"), /*#__PURE__*/React.createElement("span", null, "\xB7 ", inc.med, " med"), /*#__PURE__*/React.createElement("span", null, "\xB7 ", inc.low, " low"))), /*#__PURE__*/React.createElement("div", {
    className: "xdr-kpi-cell pink"
  }, /*#__PURE__*/React.createElement("div", {
    className: "xdr-kpi-h"
  }, /*#__PURE__*/React.createElement("span", {
    className: "xdr-kpi-lbl"
  }, "Alerts \xB7 24h"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "xdr"
  })), /*#__PURE__*/React.createElement("div", {
    className: "xdr-kpi-v"
  }, xdrCompact(k.alerts24h.total)), /*#__PURE__*/React.createElement(Sparkline, {
    data: XDR_ALERTS_24H,
    color: "var(--xdr)",
    width: 180,
    height: 28,
    fill: true
  }), /*#__PURE__*/React.createElement("div", {
    className: "xdr-kpi-foot"
  }, k.alerts24h.investigated, " triaged \xB7 ", k.alerts24h.promoted, " \u2192 incidents")), /*#__PURE__*/React.createElement("div", {
    className: "xdr-kpi-cell ok"
  }, /*#__PURE__*/React.createElement("div", {
    className: "xdr-kpi-h"
  }, /*#__PURE__*/React.createElement("span", {
    className: "xdr-kpi-lbl"
  }, "Endpoints Protected"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "xdr"
  })), /*#__PURE__*/React.createElement("div", {
    className: "xdr-kpi-v"
  }, xdrCompact(k.agents.healthy), /*#__PURE__*/React.createElement("span", {
    className: "u"
  }, "/ ", xdrCompact(XDR_TENANT.agentsDeployed))), /*#__PURE__*/React.createElement("div", {
    className: "xdr-kpi-foot"
  }, k.agents.covered_pct, "% coverage \xB7 ", k.agents.disconnected, " disconnected")), /*#__PURE__*/React.createElement("div", {
    className: "xdr-kpi-cell"
  }, /*#__PURE__*/React.createElement("div", {
    className: "xdr-kpi-h"
  }, /*#__PURE__*/React.createElement("span", {
    className: "xdr-kpi-lbl"
  }, "MTTD / MTTR"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "xdr"
  })), /*#__PURE__*/React.createElement("div", {
    className: "xdr-kpi-v"
  }, k.mttd.value, /*#__PURE__*/React.createElement("span", {
    className: "u"
  }, "m"), " ", /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--muted)",
      fontSize: 18
    }
  }, "/"), " ", k.mttr.value, /*#__PURE__*/React.createElement("span", {
    className: "u"
  }, "m")), /*#__PURE__*/React.createElement("div", {
    className: "xdr-kpi-foot"
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--ok)"
    }
  }, "\u25BC ", Math.abs(k.mttd.trend), "m detect"), /*#__PURE__*/React.createElement("span", null, "\xB7 ", /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--ok)"
    }
  }, "\u25BC ", Math.abs(k.mttr.trend), "m respond")))), /*#__PURE__*/React.createElement("div", {
    className: "xdr-kpi-cell pink"
  }, /*#__PURE__*/React.createElement("div", {
    className: "xdr-kpi-h"
  }, /*#__PURE__*/React.createElement("span", {
    className: "xdr-kpi-lbl"
  }, "MITRE Coverage"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "xdr"
  })), /*#__PURE__*/React.createElement("div", {
    className: "xdr-kpi-v"
  }, k.coverage.pct, /*#__PURE__*/React.createElement("span", {
    className: "u"
  }, "%")), /*#__PURE__*/React.createElement("div", {
    className: "fg-kpi-bar",
    style: {
      height: 3,
      background: "var(--bg-2)",
      borderRadius: 2,
      overflow: "hidden"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: `${k.coverage.pct}%`,
      background: "var(--xdr)",
      height: "100%"
    }
  })), /*#__PURE__*/React.createElement("div", {
    className: "xdr-kpi-foot"
  }, k.coverage.covered, " of ", k.coverage.total, " techniques \xB7 ", k.coverage.mitreTactics, " tactics")), /*#__PURE__*/React.createElement("div", {
    className: "xdr-kpi-cell warn"
  }, /*#__PURE__*/React.createElement("div", {
    className: "xdr-kpi-h"
  }, /*#__PURE__*/React.createElement("span", {
    className: "xdr-kpi-lbl"
  }, "Hosts Isolated"), /*#__PURE__*/React.createElement("span", {
    className: "pulse-dot"
  })), /*#__PURE__*/React.createElement("div", {
    className: "xdr-kpi-v"
  }, k.isolated.hosts), /*#__PURE__*/React.createElement("div", {
    className: "xdr-kpi-foot"
  }, "+ ", k.isolated.accounts, " accounts disabled \xB7 auto-iso active"))));
};

// ───────── Featured active incident · kill chain ─────────
const XdrActiveIncident = () => {
  const i = XDR_ACTIVE_INC;
  return /*#__PURE__*/React.createElement("div", {
    className: "card",
    style: {
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "inc-banner"
  }, /*#__PURE__*/React.createElement("div", {
    className: "inc-banner-l"
  }, /*#__PURE__*/React.createElement("div", {
    className: "inc-id-row"
  }, /*#__PURE__*/React.createElement("span", {
    className: "inc-id"
  }, i.id), /*#__PURE__*/React.createElement("span", {
    className: "inc-sev-pill " + i.sev
  }, i.sev), /*#__PURE__*/React.createElement("span", {
    className: "inc-status-pill"
  }, /*#__PURE__*/React.createElement("span", {
    className: "dot",
    style: {
      background: "var(--xdr)"
    }
  }), i.status), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "xdr"
  })), /*#__PURE__*/React.createElement("div", {
    className: "inc-title"
  }, i.title), /*#__PURE__*/React.createElement("div", {
    className: "inc-meta"
  }, /*#__PURE__*/React.createElement("span", null, /*#__PURE__*/React.createElement("span", {
    className: "lbl"
  }, "Opened"), /*#__PURE__*/React.createElement("span", {
    className: "v"
  }, i.opened), " \xB7 ", i.age), /*#__PURE__*/React.createElement("span", null, /*#__PURE__*/React.createElement("span", {
    className: "lbl"
  }, "Assigned"), /*#__PURE__*/React.createElement("span", {
    className: "v"
  }, i.assignee)), /*#__PURE__*/React.createElement("span", null, /*#__PURE__*/React.createElement("span", {
    className: "lbl"
  }, "Hosts"), /*#__PURE__*/React.createElement("span", {
    className: "v"
  }, i.hosts.join(", "))), /*#__PURE__*/React.createElement("span", null, /*#__PURE__*/React.createElement("span", {
    className: "lbl"
  }, "Users"), /*#__PURE__*/React.createElement("span", {
    className: "v"
  }, i.users.join(", "))), /*#__PURE__*/React.createElement("span", null, /*#__PURE__*/React.createElement("span", {
    className: "lbl"
  }, "Alerts"), /*#__PURE__*/React.createElement("span", {
    className: "v"
  }, i.alertsLinked, " linked \xB7 ", i.techniques, " techniques")))), /*#__PURE__*/React.createElement("div", {
    className: "inc-banner-r"
  }, /*#__PURE__*/React.createElement("div", {
    className: "inc-score"
  }, /*#__PURE__*/React.createElement("div", {
    className: "v"
  }, i.score), /*#__PURE__*/React.createElement("div", {
    className: "lbl"
  }, "Risk score")), /*#__PURE__*/React.createElement("button", {
    className: "btn primary"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "lock",
    size: 12
  }), "Contain"), /*#__PURE__*/React.createElement("button", {
    className: "btn"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "external",
    size: 12
  }), "Open case"))), /*#__PURE__*/React.createElement("div", {
    className: "kill-chain"
  }, i.kill.map((s, idx) => /*#__PURE__*/React.createElement("div", {
    className: "kill-step",
    key: idx
  }, /*#__PURE__*/React.createElement("div", {
    className: "ks-line"
  }), /*#__PURE__*/React.createElement("div", {
    className: "ks-dot " + s.sev
  }), /*#__PURE__*/React.createElement("div", {
    className: "ks-ts"
  }, s.ts), /*#__PURE__*/React.createElement("div", {
    className: "ks-tid"
  }, s.tid), /*#__PURE__*/React.createElement("div", {
    className: "ks-tac"
  }, s.tactic), /*#__PURE__*/React.createElement("div", {
    className: "ks-name"
  }, s.name), /*#__PURE__*/React.createElement("div", {
    className: "ks-detail"
  }, s.detail), /*#__PURE__*/React.createElement("div", {
    className: "ks-host"
  }, s.host)))), /*#__PURE__*/React.createElement("div", {
    className: "inc-actions"
  }, i.actions.map((a, idx) => /*#__PURE__*/React.createElement("div", {
    className: "inc-act-row",
    key: idx
  }, /*#__PURE__*/React.createElement("div", {
    className: "ts"
  }, a.ts), /*#__PURE__*/React.createElement("div", {
    className: "actor " + a.actor
  }, a.actor), /*#__PURE__*/React.createElement("div", {
    className: "msg"
  }, a.what), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement(Icon, {
    name: "check",
    size: 12
  }))))));
};

// ───────── 7-day incident severity stacked ─────────
const XdrIncidents7d = () => {
  const data = XDR_INC_7D;
  const max = Math.max(...data.map(d => d.crit + d.high + d.med + d.low)) * 1.08;
  const total = {
    crit: data.reduce((a, d) => a + d.crit, 0),
    high: data.reduce((a, d) => a + d.high, 0),
    med: data.reduce((a, d) => a + d.med, 0),
    low: data.reduce((a, d) => a + d.low, 0)
  };
  const pxFor = v => v / max * 180;
  return /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "Incidents \xB7 Last 7 Days"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "xdr"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("span", {
    className: "h-meta"
  }, "by severity \xB7 stacked")), /*#__PURE__*/React.createElement("div", {
    className: "inc7-row"
  }, /*#__PURE__*/React.createElement("div", {
    className: "inc7-chart"
  }, /*#__PURE__*/React.createElement("div", {
    className: "inc7-grid"
  }, data.map((d, i) => /*#__PURE__*/React.createElement("div", {
    className: "inc7-col",
    key: i
  }, /*#__PURE__*/React.createElement("div", {
    className: "inc7-stack"
  }, d.low > 0 && /*#__PURE__*/React.createElement("div", {
    className: "low",
    style: {
      height: pxFor(d.low)
    }
  }), d.med > 0 && /*#__PURE__*/React.createElement("div", {
    className: "med",
    style: {
      height: pxFor(d.med)
    }
  }), d.high > 0 && /*#__PURE__*/React.createElement("div", {
    className: "high",
    style: {
      height: pxFor(d.high)
    }
  }), d.crit > 0 && /*#__PURE__*/React.createElement("div", {
    className: "crit",
    style: {
      height: pxFor(d.crit)
    }
  })), /*#__PURE__*/React.createElement("div", {
    className: "inc7-day"
  }, d.d))))), /*#__PURE__*/React.createElement("div", {
    className: "inc7-side"
  }, /*#__PURE__*/React.createElement("div", {
    className: "inc7-legend"
  }, /*#__PURE__*/React.createElement("span", {
    className: "sw",
    style: {
      background: "var(--err)"
    }
  }), " Critical ", /*#__PURE__*/React.createElement("span", {
    className: "v"
  }, total.crit)), /*#__PURE__*/React.createElement("div", {
    className: "inc7-legend"
  }, /*#__PURE__*/React.createElement("span", {
    className: "sw",
    style: {
      background: "var(--xdr)"
    }
  }), " High     ", /*#__PURE__*/React.createElement("span", {
    className: "v"
  }, total.high)), /*#__PURE__*/React.createElement("div", {
    className: "inc7-legend"
  }, /*#__PURE__*/React.createElement("span", {
    className: "sw",
    style: {
      background: "var(--warn)"
    }
  }), " Medium   ", /*#__PURE__*/React.createElement("span", {
    className: "v"
  }, total.med)), /*#__PURE__*/React.createElement("div", {
    className: "inc7-legend"
  }, /*#__PURE__*/React.createElement("span", {
    className: "sw",
    style: {
      background: "var(--info)"
    }
  }), " Low      ", /*#__PURE__*/React.createElement("span", {
    className: "v"
  }, total.low)), /*#__PURE__*/React.createElement("div", {
    style: {
      borderTop: "1px solid var(--line)",
      paddingTop: 10,
      marginTop: 4
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "inc7-legend"
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--muted)"
    }
  }, "7d total"), /*#__PURE__*/React.createElement("span", {
    className: "v"
  }, total.crit + total.high + total.med + total.low))))));
};

// ───────── Detection sources ─────────
const XdrDetectionSources = () => /*#__PURE__*/React.createElement("div", {
  className: "card"
}, /*#__PURE__*/React.createElement("div", {
  className: "card-h"
}, /*#__PURE__*/React.createElement("h3", null, "Detection Sources \xB7 24h"), /*#__PURE__*/React.createElement(SourceBadge, {
  src: "xdr"
}), /*#__PURE__*/React.createElement("div", {
  className: "h-spacer"
}), /*#__PURE__*/React.createElement("span", {
  className: "h-meta"
}, XDR_SOURCES.reduce((a, s) => a + s.count, 0).toLocaleString(), " signals")), XDR_SOURCES.map(s => /*#__PURE__*/React.createElement("div", {
  className: "src-row",
  key: s.id
}, /*#__PURE__*/React.createElement("div", {
  className: "lbl"
}, /*#__PURE__*/React.createElement("span", {
  className: "dot",
  style: {
    background: s.color
  }
}), s.label), /*#__PURE__*/React.createElement("div", {
  className: "bar"
}, /*#__PURE__*/React.createElement("div", {
  style: {
    width: s.pct + "%",
    background: s.color
  }
})), /*#__PURE__*/React.createElement("div", {
  className: "v"
}, s.count.toLocaleString(), /*#__PURE__*/React.createElement("span", {
  className: "pct"
}, s.pct, "%")))));

// ───────── MITRE ATT&CK heatmap ─────────
const XdrMitre = () => {
  const heat = n => n === 0 ? "h0" : n < 5 ? "h1" : n < 15 ? "h2" : n < 30 ? "h3" : n < 60 ? "h4" : "h5";
  return /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "MITRE ATT&CK \xB7 Coverage & Detections \xB7 7d"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "xdr"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("span", {
    className: "h-meta"
  }, XDR_KPI.coverage.covered, "/", XDR_KPI.coverage.total, " techniques covered \xB7 ", XDR_KPI.coverage.pct, "%")), /*#__PURE__*/React.createElement("div", {
    className: "mitre"
  }, XDR_MITRE.map(col => /*#__PURE__*/React.createElement("div", {
    className: "mitre-col",
    key: col.tactic
  }, /*#__PURE__*/React.createElement("div", {
    className: "mitre-col-h"
  }, col.tactic), col.techs.map(t => /*#__PURE__*/React.createElement("div", {
    className: "mitre-cell " + heat(t.hits),
    key: t.id,
    title: `${t.id} · ${t.n} — ${t.hits} hits · ${t.cov} coverage`
  }, /*#__PURE__*/React.createElement("div", {
    className: "tid"
  }, t.id), /*#__PURE__*/React.createElement("div", {
    className: "nm"
  }, t.n), t.hits > 0 && /*#__PURE__*/React.createElement("div", {
    className: "hc"
  }, t.hits), /*#__PURE__*/React.createElement("div", {
    className: "cov " + t.cov
  })))))), /*#__PURE__*/React.createElement("div", {
    className: "mitre-foot"
  }, /*#__PURE__*/React.createElement("span", null, "Hits 7d"), /*#__PURE__*/React.createElement("span", {
    className: "heat-leg"
  }, /*#__PURE__*/React.createElement("div", {
    className: "mitre-cell h0",
    style: {
      padding: 0
    }
  }), /*#__PURE__*/React.createElement("div", {
    className: "mitre-cell h1",
    style: {
      padding: 0
    }
  }), /*#__PURE__*/React.createElement("div", {
    className: "mitre-cell h2",
    style: {
      padding: 0
    }
  }), /*#__PURE__*/React.createElement("div", {
    className: "mitre-cell h3",
    style: {
      padding: 0
    }
  }), /*#__PURE__*/React.createElement("div", {
    className: "mitre-cell h4",
    style: {
      padding: 0
    }
  }), /*#__PURE__*/React.createElement("div", {
    className: "mitre-cell h5",
    style: {
      padding: 0
    }
  })), /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--muted)"
    }
  }, "0 \u2192 60+"), /*#__PURE__*/React.createElement("span", {
    style: {
      marginLeft: "auto"
    }
  }, "Coverage:"), /*#__PURE__*/React.createElement("span", {
    className: "cov-leg"
  }, /*#__PURE__*/React.createElement("span", {
    className: "dot",
    style: {
      background: "var(--ok)"
    }
  }), " Full"), /*#__PURE__*/React.createElement("span", {
    className: "cov-leg"
  }, /*#__PURE__*/React.createElement("span", {
    className: "dot",
    style: {
      background: "var(--warn)"
    }
  }), " Partial"), /*#__PURE__*/React.createElement("span", {
    className: "cov-leg"
  }, /*#__PURE__*/React.createElement("span", {
    className: "dot",
    style: {
      background: "var(--muted-2)"
    }
  }), " None")));
};

// ───────── Agent OS strip ─────────
const XdrAgentOs = () => /*#__PURE__*/React.createElement("div", {
  className: "card"
}, /*#__PURE__*/React.createElement("div", {
  className: "card-h"
}, /*#__PURE__*/React.createElement("h3", null, "Agent Inventory \xB7 By OS"), /*#__PURE__*/React.createElement(SourceBadge, {
  src: "xdr"
}), /*#__PURE__*/React.createElement("div", {
  className: "h-spacer"
}), /*#__PURE__*/React.createElement("span", {
  className: "h-meta"
}, xdrCompact(XDR_TENANT.agentsDeployed), " agents \xB7 policy ", XDR_TENANT.policyVersion)), /*#__PURE__*/React.createElement("div", {
  className: "card-b tight"
}, /*#__PURE__*/React.createElement("table", {
  className: "tbl agent-os-tbl"
}, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", null, "OS"), /*#__PURE__*/React.createElement("th", {
  style: {
    width: 80,
    textAlign: "right"
  }
}, "Agents"), /*#__PURE__*/React.createElement("th", {
  style: {
    width: 80,
    textAlign: "right"
  }
}, "Healthy"), /*#__PURE__*/React.createElement("th", {
  style: {
    width: 160
  }
}, "Health %"), /*#__PURE__*/React.createElement("th", {
  style: {
    width: 130
  }
}, "Agent ver."))), /*#__PURE__*/React.createElement("tbody", null, XDR_AGENTS_OS.map(o => {
  const pct = o.healthy / o.count * 100;
  return /*#__PURE__*/React.createElement("tr", {
    key: o.os
  }, /*#__PURE__*/React.createElement("td", {
    className: "fg"
  }, o.os), /*#__PURE__*/React.createElement("td", {
    style: {
      textAlign: "right"
    }
  }, o.count.toLocaleString()), /*#__PURE__*/React.createElement("td", {
    style: {
      textAlign: "right",
      color: "var(--ok)"
    }
  }, o.healthy.toLocaleString()), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("span", {
    className: "agent-bar"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: pct + "%",
      background: pct > 98 ? "var(--ok)" : pct > 95 ? "var(--warn)" : "var(--err)"
    }
  })), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--mono)",
      fontSize: 11
    }
  }, pct.toFixed(1), "%")), /*#__PURE__*/React.createElement("td", null, o.ver));
})))));

// ───────── Top risky users / hosts ─────────
const XdrRiskyUsers = () => /*#__PURE__*/React.createElement("div", {
  className: "card"
}, /*#__PURE__*/React.createElement("div", {
  className: "card-h"
}, /*#__PURE__*/React.createElement("h3", null, "Top Risky Users"), /*#__PURE__*/React.createElement(SourceBadge, {
  src: "xdr"
}), /*#__PURE__*/React.createElement(SourceBadge, {
  src: "pf"
}), /*#__PURE__*/React.createElement("div", {
  className: "h-spacer"
}), /*#__PURE__*/React.createElement("span", {
  className: "h-meta"
}, "behavioral score \xB7 last 7d")), XDR_TOP_USERS.map(u => {
  const cls = scoreClass(u.score);
  return /*#__PURE__*/React.createElement("div", {
    className: "risk-row",
    key: u.user
  }, /*#__PURE__*/React.createElement("div", {
    className: "l"
  }, /*#__PURE__*/React.createElement("div", {
    className: "name"
  }, u.user, /*#__PURE__*/React.createElement("span", {
    className: "role-tag " + (u.role === "Faculty" ? "faculty" : u.role === "Student" ? "student" : u.role === "Service" ? "unknown" : u.role === "Admin" ? "av" : "guest"),
    style: {
      fontSize: 9.5,
      padding: "0 6px"
    }
  }, u.role)), /*#__PURE__*/React.createElement("div", {
    className: "sub"
  }, u.dept), /*#__PURE__*/React.createElement("div", {
    className: "signals"
  }, u.signals.map((s, i) => /*#__PURE__*/React.createElement("span", {
    className: "sig-chip",
    key: i
  }, s)))), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "score " + cls
  }, u.score), /*#__PURE__*/React.createElement("div", {
    className: "meter"
  }, /*#__PURE__*/React.createElement("div", {
    className: cls,
    style: {
      width: u.score + "%"
    }
  }))), /*#__PURE__*/React.createElement("div", {
    className: "trend " + (u.trend > 0 ? "up" : "down")
  }, u.trend > 0 ? "▲" : "▼", " ", Math.abs(u.trend), /*#__PURE__*/React.createElement("br", null), /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--muted)",
      fontSize: 10
    }
  }, "vs 7d")));
}));
const XdrRiskyHosts = () => /*#__PURE__*/React.createElement("div", {
  className: "card"
}, /*#__PURE__*/React.createElement("div", {
  className: "card-h"
}, /*#__PURE__*/React.createElement("h3", null, "Top Risky Hosts"), /*#__PURE__*/React.createElement(SourceBadge, {
  src: "xdr"
}), /*#__PURE__*/React.createElement("div", {
  className: "h-spacer"
}), /*#__PURE__*/React.createElement("span", {
  className: "h-meta"
}, XDR_KPI.isolated.hosts, " isolated")), XDR_TOP_HOSTS.map(h => {
  const cls = scoreClass(h.score);
  return /*#__PURE__*/React.createElement("div", {
    className: "risk-row",
    key: h.host
  }, /*#__PURE__*/React.createElement("div", {
    className: "l"
  }, /*#__PURE__*/React.createElement("div", {
    className: "name",
    style: {
      fontFamily: "var(--mono)",
      fontSize: 12
    }
  }, h.host, h.isolated && /*#__PURE__*/React.createElement("span", {
    className: "iso"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "lock",
    size: 9
  }), " ISOLATED")), /*#__PURE__*/React.createElement("div", {
    className: "sub"
  }, h.os, " \xB7 ", h.site, " \xB7 user ", h.user), /*#__PURE__*/React.createElement("div", {
    className: "signals"
  }, /*#__PURE__*/React.createElement("span", {
    className: "sig-chip"
  }, h.alerts, " alerts \xB7 24h"))), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "score " + cls
  }, h.score), /*#__PURE__*/React.createElement("div", {
    className: "meter"
  }, /*#__PURE__*/React.createElement("div", {
    className: cls,
    style: {
      width: h.score + "%"
    }
  }))), /*#__PURE__*/React.createElement("div", {
    className: "trend",
    style: {
      color: "var(--muted)",
      fontFamily: "var(--mono)",
      fontSize: 11
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "chevron",
    size: 12
  })));
}));

// ───────── Top alerts table ─────────
const XdrAlerts = () => /*#__PURE__*/React.createElement("div", {
  className: "card"
}, /*#__PURE__*/React.createElement("div", {
  className: "card-h"
}, /*#__PURE__*/React.createElement("h3", null, "Top Alerts \xB7 24h"), /*#__PURE__*/React.createElement(SourceBadge, {
  src: "xdr"
}), /*#__PURE__*/React.createElement("div", {
  className: "h-spacer"
}), /*#__PURE__*/React.createElement("a", {
  className: "h-link"
}, "Open alert queue ", /*#__PURE__*/React.createElement(Icon, {
  name: "external",
  size: 11
}))), /*#__PURE__*/React.createElement("div", {
  className: "card-b tight"
}, /*#__PURE__*/React.createElement("table", {
  className: "tbl alerts-tbl"
}, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", {
  style: {
    width: 78
  }
}, "Alert"), /*#__PURE__*/React.createElement("th", null, "Signature"), /*#__PURE__*/React.createElement("th", {
  style: {
    width: 88
  }
}, "MITRE"), /*#__PURE__*/React.createElement("th", {
  style: {
    width: 60
  }
}, "Sev"), /*#__PURE__*/React.createElement("th", {
  style: {
    width: 160
  }
}, "Host"), /*#__PURE__*/React.createElement("th", {
  style: {
    width: 110
  }
}, "User"), /*#__PURE__*/React.createElement("th", {
  style: {
    width: 90
  }
}, "Age"), /*#__PURE__*/React.createElement("th", {
  style: {
    width: 130
  }
}, "Status"))), /*#__PURE__*/React.createElement("tbody", null, XDR_TOP_ALERTS.map(a => /*#__PURE__*/React.createElement("tr", {
  key: a.id
}, /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("span", {
  className: "al-id"
}, a.id)), /*#__PURE__*/React.createElement("td", {
  className: "fg"
}, a.sig), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("span", {
  className: "al-mitre"
}, a.mitre)), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement(Sev, {
  level: a.sev === "critical" ? "disaster" : a.sev
})), /*#__PURE__*/React.createElement("td", null, a.host), /*#__PURE__*/React.createElement("td", null, a.user), /*#__PURE__*/React.createElement("td", null, a.ago), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("span", {
  className: "al-status " + a.status
}, a.status))))))));

// ───────── Hunts ─────────
const XdrHunts = () => /*#__PURE__*/React.createElement("div", {
  className: "card"
}, /*#__PURE__*/React.createElement("div", {
  className: "card-h"
}, /*#__PURE__*/React.createElement("h3", null, "Active Hunts & Scheduled Queries"), /*#__PURE__*/React.createElement(SourceBadge, {
  src: "xdr"
}), /*#__PURE__*/React.createElement("div", {
  className: "h-spacer"
}), /*#__PURE__*/React.createElement("span", {
  className: "h-meta"
}, XDR_HUNTS.filter(h => h.status === "running").length, " running \xB7 ", XDR_HUNTS.length, " total")), XDR_HUNTS.map((h, i) => /*#__PURE__*/React.createElement("div", {
  className: "hunt-row",
  key: i
}, /*#__PURE__*/React.createElement("div", {
  className: "hn-name"
}, /*#__PURE__*/React.createElement("span", {
  className: "hunt-status-dot " + h.status
}), h.name), /*#__PURE__*/React.createElement("div", {
  className: "hn-author"
}, "by ", h.author), /*#__PURE__*/React.createElement("div", {
  className: "hn-sched"
}, h.schedule), /*#__PURE__*/React.createElement("div", {
  className: "hn-last"
}, h.lastRun), /*#__PURE__*/React.createElement("div", {
  className: "hn-hits " + (h.hits > 0 ? "hits" : "zero")
}, h.hits, " hits"))));

// ───────── Events ─────────
const XdrEvents = () => /*#__PURE__*/React.createElement("div", {
  className: "events"
}, XDR_EVENTS.map((e, i) => /*#__PURE__*/React.createElement("div", {
  className: "event",
  key: i
}, /*#__PURE__*/React.createElement("div", {
  className: "ts"
}, e.ts), /*#__PURE__*/React.createElement("div", {
  className: "src " + e.source
}, e.source.toUpperCase()), /*#__PURE__*/React.createElement("div", {
  className: "mono",
  style: {
    fontSize: 11,
    color: "var(--fg-2)"
  }
}, e.host), /*#__PURE__*/React.createElement("div", {
  className: "msg"
}, /*#__PURE__*/React.createElement("span", {
  style: {
    color: e.sev === "ok" ? "var(--ok)" : e.sev === "high" || e.sev === "disaster" ? "var(--err)" : e.sev === "warning" ? "var(--warn)" : "var(--info)",
    fontWeight: 500
  }
}, e.msg), /*#__PURE__*/React.createElement("span", {
  style: {
    color: "var(--fg)"
  }
}, e.obj)))));

// ───────── App shell ─────────
const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "density": "balanced",
  "showSourceBadges": true,
  "showKillChain": true,
  "showMitre": true,
  "showHunts": true
} /*EDITMODE-END*/;
const App = () => {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [timeRange, setTimeRange] = useState("Last 24h");
  const [now, setNow] = useState("just now");
  useEffect(() => {
    document.documentElement.classList.toggle("hide-src-badges", !t.showSourceBadges);
  }, [t.showSourceBadges]);
  return /*#__PURE__*/React.createElement("div", {
    className: "app xdr-page",
    "data-density": t.density,
    "data-screen-label": "Cortex XDR"
  }, /*#__PURE__*/React.createElement(GlobalSidebar, {
    active: "xdr"
  }), /*#__PURE__*/React.createElement("div", {
    className: "main"
  }, /*#__PURE__*/React.createElement(GlobalTopbar, {
    crumb: ["Tuscaloosa City Schools", "Security Ops", "Cortex XDR · tcs-secops"],
    search: "Find incident, host, user, hash, MITRE ID\u2026"
  }), /*#__PURE__*/React.createElement(XdrHeader, {
    now: now,
    timeRange: timeRange
  }), /*#__PURE__*/React.createElement("div", {
    className: "body"
  }, /*#__PURE__*/React.createElement(DemoBanner, {
    name: "Cortex XDR Dashboard"
  }), /*#__PURE__*/React.createElement(XdrKpiStrip, null), t.showKillChain && /*#__PURE__*/React.createElement(XdrActiveIncident, null), /*#__PURE__*/React.createElement("div", {
    className: "row",
    style: {
      gridTemplateColumns: "1.4fr 1fr",
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement(XdrIncidents7d, null), /*#__PURE__*/React.createElement(XdrDetectionSources, null)), t.showMitre && /*#__PURE__*/React.createElement("div", {
    className: "row",
    style: {
      gridTemplateColumns: "1fr",
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement(XdrMitre, null)), /*#__PURE__*/React.createElement("div", {
    className: "row",
    style: {
      gridTemplateColumns: "1fr",
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement(XdrAgentOs, null)), /*#__PURE__*/React.createElement("div", {
    className: "row",
    style: {
      gridTemplateColumns: "1fr 1fr",
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement(XdrRiskyUsers, null), /*#__PURE__*/React.createElement(XdrRiskyHosts, null)), /*#__PURE__*/React.createElement("div", {
    className: "row",
    style: {
      gridTemplateColumns: "1fr",
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement(XdrAlerts, null)), t.showHunts && /*#__PURE__*/React.createElement("div", {
    className: "row",
    style: {
      gridTemplateColumns: "1fr",
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement(XdrHunts, null)), /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "Cortex XDR \xB7 Recent Events"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "xdr"
  }), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("a", {
    className: "h-link"
  }, "Open in event console ", /*#__PURE__*/React.createElement(Icon, {
    name: "external",
    size: 11
  }))), /*#__PURE__*/React.createElement("div", {
    className: "card-b tight"
  }, /*#__PURE__*/React.createElement(XdrEvents, null))))), /*#__PURE__*/React.createElement(TweaksPanel, {
    title: "Tweaks"
  }, /*#__PURE__*/React.createElement(TweakSection, {
    label: "Layout"
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
    label: "Show source badges",
    value: t.showSourceBadges,
    onChange: v => setTweak("showSourceBadges", v)
  })), /*#__PURE__*/React.createElement(TweakSection, {
    label: "Sections"
  }, /*#__PURE__*/React.createElement(TweakToggle, {
    label: "Active incident \xB7 kill chain",
    value: t.showKillChain,
    onChange: v => setTweak("showKillChain", v)
  }), /*#__PURE__*/React.createElement(TweakToggle, {
    label: "MITRE ATT&CK heatmap",
    value: t.showMitre,
    onChange: v => setTweak("showMitre", v)
  }), /*#__PURE__*/React.createElement(TweakToggle, {
    label: "Active hunts",
    value: t.showHunts,
    onChange: v => setTweak("showHunts", v)
  })), /*#__PURE__*/React.createElement(TweakSection, {
    label: "Quick actions"
  }, /*#__PURE__*/React.createElement(TweakButton, {
    onClick: () => setNow(new Date().toLocaleTimeString()),
    label: "Refresh tenant sync"
  }), /*#__PURE__*/React.createElement(TweakButton, {
    onClick: () => alert("Would open INC-2026-0418 in the case manager."),
    label: "Open active incident"
  }))));
};
ReactDOM.createRoot(document.getElementById("root")).render(/*#__PURE__*/React.createElement(App, null));