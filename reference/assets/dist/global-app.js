// Global Dashboard — high-level problem-area overview across all monitored estates
// Layout philosophy: triage > drill-down. Severity totals up top, sites heatmap +
// domain breakdown in the middle, triggers table + hotspots below, raw event stream
// at the bottom. Every card is something an operator can scan in <2 seconds.

const RANGE_OPTIONS = [{
  key: "1h",
  label: "Last 1h"
}, {
  key: "6h",
  label: "Last 6h"
}, {
  key: "24h",
  label: "Last 24h"
}, {
  key: "7d",
  label: "Last 7d"
}];
const RangeMenu = ({
  anchorRect,
  rangeKey,
  onPick,
  onClose
}) => {
  if (!anchorRect) return null;
  const style = {
    position: "fixed",
    top: anchorRect.bottom + 6,
    left: Math.max(8, anchorRect.right - 160),
    width: 160,
    zIndex: 1000,
    background: "var(--bg-1, #0f1620)",
    border: "1px solid var(--line, #1f2a36)",
    borderRadius: 8,
    boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
    padding: 4
  };
  return ReactDOM.createPortal(/*#__PURE__*/React.createElement("div", {
    style: style,
    onClick: e => e.stopPropagation()
  }, RANGE_OPTIONS.map(o => /*#__PURE__*/React.createElement("div", {
    key: o.key,
    onClick: () => {
      onPick(o.key);
      onClose();
    },
    style: {
      padding: "8px 12px",
      cursor: "pointer",
      borderRadius: 6,
      background: o.key === rangeKey ? "var(--bg-2, #1a2330)" : "transparent",
      color: o.key === rangeKey ? "var(--fg, #fff)" : "var(--fg-2, #cbd5e1)",
      fontSize: 13
    },
    onMouseEnter: e => e.currentTarget.style.background = "var(--bg-2, #1a2330)",
    onMouseLeave: e => e.currentTarget.style.background = o.key === rangeKey ? "var(--bg-2, #1a2330)" : "transparent"
  }, o.label))), document.body);
};
const GlobalHeader = ({
  now,
  rangeKey,
  setRangeKey
}) => {
  const [open, setOpen] = React.useState(false);
  const [anchorRect, setAnchorRect] = React.useState(null);
  const triggerRef = React.useRef(null);
  const current = RANGE_OPTIONS.find(r => r.key === rangeKey) || RANGE_OPTIONS[2];
  React.useEffect(() => {
    if (!open) return;
    const onDoc = e => {
      if (triggerRef.current && !triggerRef.current.contains(e.target)) setOpen(false);
    };
    const onResize = () => setOpen(false);
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onResize, true);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onResize, true);
    };
  }, [open]);
  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    if (triggerRef.current) setAnchorRect(triggerRef.current.getBoundingClientRect());
    setOpen(true);
  };
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
  }, /*#__PURE__*/React.createElement("h1", null, "Global Dashboard"), /*#__PURE__*/React.createElement("span", {
    className: "role-tag faculty",
    style: {
      fontSize: 10,
      padding: "1px 8px"
    }
  }, "OPERATIONS \xB7 TIER-1")), /*#__PURE__*/React.createElement("div", {
    className: "host-meta"
  }, /*#__PURE__*/React.createElement("span", {
    className: "pill"
  }, /*#__PURE__*/React.createElement("span", {
    className: "dot",
    style: {
      background: "var(--ok)"
    }
  }), " All proxies polling"), /*#__PURE__*/React.createElement("span", {
    className: "pill"
  }, /*#__PURE__*/React.createElement("span", {
    className: "lbl"
  }, "Last refresh"), " ", /*#__PURE__*/React.createElement("span", {
    className: "v"
  }, now)), /*#__PURE__*/React.createElement("span", {
    className: "pill"
  }, /*#__PURE__*/React.createElement("span", {
    className: "lbl"
  }, "Auto-refresh"), " ", /*#__PURE__*/React.createElement("span", {
    className: "v"
  }, "30s")), /*#__PURE__*/React.createElement("span", {
    className: "pill"
  }, /*#__PURE__*/React.createElement("span", {
    className: "lbl"
  }, "Polled hosts"), " ", /*#__PURE__*/React.createElement("span", {
    className: "v"
  }, GLOBAL_TOTALS.hosts.total.toLocaleString())), /*#__PURE__*/React.createElement("span", {
    className: "pill"
  }, /*#__PURE__*/React.createElement("span", {
    className: "lbl"
  }, "Templates"), " ", /*#__PURE__*/React.createElement("span", {
    className: "v"
  }, GLOBAL_TOTALS.templates.version)))), /*#__PURE__*/React.createElement("div", {
    className: "timerange",
    ref: triggerRef,
    onClick: toggle
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "calendar"
  }), /*#__PURE__*/React.createElement("span", {
    className: "range-val"
  }, current.label), /*#__PURE__*/React.createElement(Icon, {
    name: "chevron"
  })), open && /*#__PURE__*/React.createElement(RangeMenu, {
    anchorRect: anchorRect,
    rangeKey: rangeKey,
    onPick: setRangeKey,
    onClose: () => setOpen(false)
  }));
};

// ───────── Severity strip (Disaster / High / Warning / Info / Acknowledged / Hosts down) ─────────
const SeverityStrip = () => {
  const p = GLOBAL_TOTALS.problems;
  const cells = [{
    label: "Disaster",
    value: p.disaster,
    color: "var(--err)",
    bg: "rgba(242,95,92,0.10)",
    note: `${p.disaster ? "active" : "—"}`
  }, {
    label: "High",
    value: p.high,
    color: "var(--err)",
    bg: "rgba(242,95,92,0.06)",
    note: `${p.disaster + p.high} unack`
  }, {
    label: "Warning",
    value: p.warning,
    color: "var(--warn)",
    bg: "rgba(245,179,0,0.08)",
    note: "+12 in 1h"
  }, {
    label: "Info",
    value: p.info,
    color: "var(--info)",
    bg: "rgba(95,168,211,0.08)",
    note: "drift"
  }, {
    label: "Acknowledged",
    value: p.ack,
    color: "var(--fg-2)",
    bg: "var(--bg-2)",
    note: `${Math.round(p.ack / (p.disaster + p.high + p.warning + p.info + p.ack) * 100)}% of total`
  }, {
    label: "Hosts down",
    value: GLOBAL_TOTALS.hosts.down,
    color: "var(--err)",
    bg: "rgba(242,95,92,0.06)",
    note: `of ${GLOBAL_TOTALS.hosts.total.toLocaleString()}`
  }];
  return /*#__PURE__*/React.createElement("div", {
    className: "card",
    style: {
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "sev-strip"
  }, cells.map(c => /*#__PURE__*/React.createElement("div", {
    className: "sev-cell",
    key: c.label,
    style: {
      background: c.bg
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "sev-cell-h"
  }, /*#__PURE__*/React.createElement("span", {
    className: "sev-cell-lbl",
    style: {
      color: c.color
    }
  }, c.label), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  })), /*#__PURE__*/React.createElement("div", {
    className: "sev-cell-v",
    style: {
      color: c.color
    }
  }, c.value), /*#__PURE__*/React.createElement("div", {
    className: "sev-cell-note"
  }, c.note)))));
};

// ───────── Sites heatmap ─────────
const sevColors = {
  ok: {
    bg: "rgba(52,211,153,0.12)",
    bd: "rgba(52,211,153,0.35)",
    fg: "var(--ok)"
  },
  info: {
    bg: "rgba(95,168,211,0.12)",
    bd: "rgba(95,168,211,0.35)",
    fg: "var(--info)"
  },
  warning: {
    bg: "rgba(245,179,0,0.12)",
    bd: "rgba(245,179,0,0.40)",
    fg: "var(--warn)"
  },
  high: {
    bg: "rgba(242,95,92,0.14)",
    bd: "rgba(242,95,92,0.45)",
    fg: "var(--err)"
  },
  disaster: {
    bg: "rgba(242,95,92,0.30)",
    bd: "var(--err)",
    fg: "#ffd0cf"
  }
};
const SitesHeatmap = ({
  filter,
  setFilter
}) => {
  const sites = filter === "issues" ? GLOBAL_SITES.filter(s => s.problems > 0) : filter === "ok" ? GLOBAL_SITES.filter(s => s.problems === 0) : GLOBAL_SITES;
  return /*#__PURE__*/React.createElement("div", {
    className: "card",
    style: {
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "Sites \u2014 Health Map"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("div", {
    className: "seg-toggle"
  }, [["all", `All ${GLOBAL_SITES.length}`], ["issues", `Issues ${GLOBAL_SITES.filter(s => s.problems).length}`], ["ok", `OK ${GLOBAL_SITES.filter(s => !s.problems).length}`]].map(([k, l]) => /*#__PURE__*/React.createElement("button", {
    key: k,
    className: "seg-btn" + (filter === k ? " active" : ""),
    onClick: () => setFilter(k)
  }, l)))), /*#__PURE__*/React.createElement("div", {
    className: "card-b"
  }, /*#__PURE__*/React.createElement("div", {
    className: "sites-grid"
  }, sites.map(s => {
    const c = sevColors[s.sev] || sevColors.ok;
    const href = (window.TCS_NAV ? window.TCS_NAV.events : "zabbix.php?action=tcs.events.view") + "&site=" + encodeURIComponent(s.name) + "&range=open";
    return /*#__PURE__*/React.createElement("a", {
      key: s.id,
      href: href,
      className: "site-tile" + (s.kind === "outage" ? " pulse" : ""),
      style: {
        background: c.bg,
        borderColor: c.bd,
        textDecoration: "none"
      },
      title: `${s.name} · ${s.problems} problems · SLA ${s.sla}% — click to view events`
    }, /*#__PURE__*/React.createElement("div", {
      className: "site-tile-h"
    }, s.problems > 0 ? /*#__PURE__*/React.createElement("span", {
      className: "site-tile-prob",
      style: {
        color: c.fg
      }
    }, s.problems) : /*#__PURE__*/React.createElement(Icon, {
      name: "check",
      size: 11
    })), /*#__PURE__*/React.createElement("div", {
      className: "site-tile-name"
    }, s.name), /*#__PURE__*/React.createElement("div", {
      className: "site-tile-meta"
    }, /*#__PURE__*/React.createElement("span", null, s.hosts, " hosts"), /*#__PURE__*/React.createElement("span", {
      className: "mono"
    }, s.sla.toFixed(2), "%")));
  }))), /*#__PURE__*/React.createElement("div", {
    className: "sites-legend"
  }, [["disaster", "Disaster"], ["high", "High"], ["warning", "Warning"], ["info", "Info"], ["ok", "OK"]].map(([k, l]) => /*#__PURE__*/React.createElement("span", {
    className: "legend-item",
    key: k
  }, /*#__PURE__*/React.createElement("span", {
    className: "legend-sw",
    style: {
      background: sevColors[k].bg,
      borderColor: sevColors[k].bd
    }
  }), l)), /*#__PURE__*/React.createElement("span", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("span", {
    className: "legend-foot"
  }, sites.reduce((n, s) => n + s.problems, 0), " problems \xB7 ", sites.reduce((n, s) => n + s.hosts, 0).toLocaleString(), " hosts shown")));
};

// ───────── System Snapshot — per-system tiles ─────────
// One card per monitored system, surfacing its 3 most important KPIs +
// a domain-specific sparkline + a headline message. Matches the design's
// SystemCard layout (sys-card / sys-h / sys-kpis / sys-spark / sys-foot).

const sysStatus = {
  ok: {
    lbl: "OK",
    fg: "var(--ok)",
    bg: "rgba(52,211,153,0.10)",
    bd: "rgba(52,211,153,0.35)"
  },
  info: {
    lbl: "INFO",
    fg: "var(--info)",
    bg: "rgba(95,168,211,0.10)",
    bd: "rgba(95,168,211,0.35)"
  },
  warning: {
    lbl: "WARN",
    fg: "var(--warn)",
    bg: "rgba(245,179,0,0.10)",
    bd: "rgba(245,179,0,0.40)"
  },
  high: {
    lbl: "HIGH",
    fg: "var(--err)",
    bg: "rgba(242,95,92,0.10)",
    bd: "rgba(242,95,92,0.40)"
  },
  disaster: {
    lbl: "DISASTER",
    fg: "#ffd0cf",
    bg: "rgba(242,95,92,0.22)",
    bd: "var(--err)"
  }
};
const SystemCard = ({
  sys
}) => {
  const st = sysStatus[sys.status] || sysStatus.ok;
  const spark = Array.isArray(sys.spark) && sys.spark.some(v => v > 0) ? sys.spark : null;
  return /*#__PURE__*/React.createElement("a", {
    className: "sys-card",
    href: sys.href,
    title: sys.top
  }, /*#__PURE__*/React.createElement("div", {
    className: "sys-h"
  }, /*#__PURE__*/React.createElement("div", {
    className: "sys-icon",
    style: {
      borderColor: st.bd,
      color: st.fg,
      background: st.bg
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: sys.icon,
    size: 15
  })), /*#__PURE__*/React.createElement("div", {
    className: "sys-h-meta"
  }, /*#__PURE__*/React.createElement("div", {
    className: "sys-h-title"
  }, sys.label), /*#__PURE__*/React.createElement("div", {
    className: "sys-h-sub"
  }, sys.sub)), sys.src && /*#__PURE__*/React.createElement(SourceBadge, {
    src: sys.src
  }), /*#__PURE__*/React.createElement("span", {
    className: "sys-status",
    style: {
      color: st.fg,
      borderColor: st.bd,
      background: st.bg
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "dot",
    style: {
      background: st.fg
    }
  }), st.lbl)), /*#__PURE__*/React.createElement("div", {
    className: "sys-kpis"
  }, (sys.kpis || []).map((k, i) => /*#__PURE__*/React.createElement("div", {
    className: "sys-kpi",
    key: i
  }, /*#__PURE__*/React.createElement("div", {
    className: "sys-kpi-lbl"
  }, k.label), /*#__PURE__*/React.createElement("div", {
    className: "sys-kpi-v"
  }, k.value, k.unit && /*#__PURE__*/React.createElement("span", {
    className: "sys-kpi-u"
  }, k.unit)), k.note && /*#__PURE__*/React.createElement("div", {
    className: "sys-kpi-n",
    title: k.note
  }, k.note)))), /*#__PURE__*/React.createElement("div", {
    className: "sys-spark"
  }, spark ? /*#__PURE__*/React.createElement(Sparkline, {
    data: spark,
    color: sys.sparkColor || "var(--zbx)",
    width: 260,
    height: 28,
    fill: true
  }) : /*#__PURE__*/React.createElement("div", {
    className: "sys-spark-empty"
  }, "\u2014"), sys.sparkLabel && /*#__PURE__*/React.createElement("div", {
    className: "sys-spark-lbl"
  }, sys.sparkLabel)), /*#__PURE__*/React.createElement("div", {
    className: "sys-foot"
  }, /*#__PURE__*/React.createElement("span", {
    className: "sys-foot-msg",
    style: {
      borderLeftColor: st.fg
    }
  }, sys.top || "—"), /*#__PURE__*/React.createElement("span", {
    className: "sys-foot-link"
  }, "Open ", /*#__PURE__*/React.createElement(Icon, {
    name: "external",
    size: 11
  }))));
};
const SystemSnapshot = () => {
  const needAttention = GLOBAL_DOMAINS.filter(s => s.status && s.status !== "ok" && s.status !== "info").length;
  return /*#__PURE__*/React.createElement("div", {
    className: "card",
    style: {
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "System Snapshot"), /*#__PURE__*/React.createElement("span", {
    className: "h-meta"
  }, "most important headline from every monitored system"), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("span", {
    className: "h-meta mono"
  }, GLOBAL_DOMAINS.length, " systems \xB7 ", needAttention, " need attention")), /*#__PURE__*/React.createElement("div", {
    className: "card-b"
  }, /*#__PURE__*/React.createElement("div", {
    className: "sys-grid"
  }, GLOBAL_DOMAINS.map(s => /*#__PURE__*/React.createElement(SystemCard, {
    key: s.id,
    sys: s
  })))));
};

// ───────── Active triggers table ─────────
const TriggersTable = ({
  filterSev
}) => {
  const rows = filterSev === "all" ? GLOBAL_TRIGGERS : GLOBAL_TRIGGERS.filter(t => t.sev === filterSev);
  return /*#__PURE__*/React.createElement("table", {
    className: "tbl trig-tbl"
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", {
    style: {
      width: 60
    }
  }, "Sev"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 70
    }
  }, "Age"), /*#__PURE__*/React.createElement("th", null, "Host / trigger"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 60,
      textAlign: "center"
    }
  }, "Site"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 32
    }
  }), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 28
    }
  }))), /*#__PURE__*/React.createElement("tbody", null, rows.map((t, i) => /*#__PURE__*/React.createElement("tr", {
    key: i
  }, /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement(Sev, {
    level: t.sev
  })), /*#__PURE__*/React.createElement("td", {
    className: "mono"
  }, t.age), /*#__PURE__*/React.createElement("td", {
    className: "fg"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      gap: 1
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "mono",
    style: {
      fontSize: 11,
      color: "var(--fg)"
    }
  }, t.host), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--sans)",
      fontSize: 11.5,
      color: "var(--fg-2)"
    }
  }, t.trigger))), /*#__PURE__*/React.createElement("td", {
    style: {
      textAlign: "center"
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "site-chip"
  }, t.site)), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement(SourceBadge, {
    src: t.source
  })), /*#__PURE__*/React.createElement("td", null, t.ack ? /*#__PURE__*/React.createElement(Icon, {
    name: "check",
    size: 12
  }) : /*#__PURE__*/React.createElement("span", {
    className: "dot pulse-dot",
    style: {
      background: "var(--err)"
    }
  }))))));
};

// ───────── Hotspots — top sites with most problems ─────────
const Hotspots = () => {
  const top = [...GLOBAL_SITES].sort((a, b) => b.problems - a.problems).slice(0, 6);
  const max = Math.max(...top.map(t => t.problems));
  return /*#__PURE__*/React.createElement("div", {
    className: "hotspots"
  }, top.map(s => {
    const c = sevColors[s.sev] || sevColors.ok;
    const pct = s.problems / max * 100;
    return /*#__PURE__*/React.createElement("div", {
      className: "hotspot-row",
      key: s.id
    }, /*#__PURE__*/React.createElement("div", {
      className: "hotspot-id"
    }, s.id), /*#__PURE__*/React.createElement("div", {
      className: "hotspot-meta"
    }, /*#__PURE__*/React.createElement("div", {
      className: "hotspot-h"
    }, /*#__PURE__*/React.createElement("span", {
      className: "hotspot-name"
    }, s.name), /*#__PURE__*/React.createElement("span", {
      className: "hotspot-prob mono",
      style: {
        color: c.fg
      }
    }, s.problems)), /*#__PURE__*/React.createElement("div", {
      className: "hotspot-bar"
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        width: `${pct}%`,
        background: c.fg,
        opacity: 0.85
      }
    })), /*#__PURE__*/React.createElement("div", {
      className: "hotspot-foot"
    }, /*#__PURE__*/React.createElement("span", null, s.hosts, " hosts"), /*#__PURE__*/React.createElement("span", {
      className: "mono"
    }, "SLA ", s.sla.toFixed(2), "%"))));
  }));
};

// ───────── Events stream ─────────
const EventsStream = () => /*#__PURE__*/React.createElement("div", {
  className: "events"
}, GLOBAL_EVENTS.map((e, i) => /*#__PURE__*/React.createElement("div", {
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
}, e.msg), " ", /*#__PURE__*/React.createElement("span", {
  style: {
    color: "var(--fg)"
  }
}, e.obj)))));

// ───────── App ─────────
const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "density": "balanced",
  "showSourceBadges": true,
  "siteFilter": "all",
  "sevFilter": "all",
  "groupBy": "site"
} /*EDITMODE-END*/;

// Banner shown while staged data is still in flight. Two pill-shaped
// segments — one per stage — light up as their fetches complete. The
// whole banner fades out once both stages have landed.
const LoadingBanner = ({
  stages
}) => {
  const allDone = stages.core && stages.enrich;
  return /*#__PURE__*/React.createElement("div", {
    className: "load-banner" + (allDone ? " done" : ""),
    role: "status",
    "aria-live": "polite"
  }, /*#__PURE__*/React.createElement("span", {
    className: "load-spin",
    "aria-hidden": "true"
  }), /*#__PURE__*/React.createElement("span", {
    className: "load-msg"
  }, allDone ? "All data loaded" : "Loading dashboard…"), /*#__PURE__*/React.createElement("span", {
    className: "load-stages"
  }, /*#__PURE__*/React.createElement("span", {
    className: "load-stage" + (stages.core ? " done" : "")
  }, stages.core ? /*#__PURE__*/React.createElement(Icon, {
    name: "check",
    size: 10
  }) : /*#__PURE__*/React.createElement("span", {
    className: "load-dot"
  }), " Core"), /*#__PURE__*/React.createElement("span", {
    className: "load-stage" + (stages.enrich ? " done" : "")
  }, stages.enrich ? /*#__PURE__*/React.createElement(Icon, {
    name: "check",
    size: 10
  }) : /*#__PURE__*/React.createElement("span", {
    className: "load-dot"
  }), " Enrichment")));
};

// Block-shaped pulsing skeleton used in place of card bodies that haven't
// received their data yet. Keeps the layout from jumping when content lands.
const Skeleton = ({
  rows = 3,
  height = 36
}) => /*#__PURE__*/React.createElement("div", {
  className: "skeleton-stack",
  "aria-hidden": "true"
}, Array.from({
  length: rows
}).map((_, i) => /*#__PURE__*/React.createElement("div", {
  className: "skeleton-row",
  key: i,
  style: {
    height
  }
})));
const App = () => {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [rangeKey, setRangeKeyState] = React.useState("24h");
  const [now, setNow] = React.useState("—");
  const [refreshing, setRefreshing] = React.useState(false);
  // Bump on every successful refresh so children re-read window.GLOBAL_* globals.
  const [, setTick] = React.useState(0);
  // Per-stage "have we seen at least one successful response yet?" flags.
  // Drives the loading banner + per-section skeletons.
  const [stages, setStages] = React.useState({
    core: false,
    enrich: false
  });
  React.useEffect(() => {
    document.documentElement.classList.toggle("hide-src-badges", !t.showSourceBadges);
  }, [t.showSourceBadges]);

  // Listen for bridge-published data updates: refresh timestamp + force re-render.
  React.useEffect(() => {
    const onData = ev => {
      const d = ev.detail || {};
      if (d.error) return; // keep the skeleton up so the user sees something's still pending
      setNow(new Date().toLocaleTimeString());
      setRefreshing(false);
      setTick(n => n + 1);
      if (d.stage === "core" || d.stage === "enrich" || d.stage === "all") {
        setStages(prev => ({
          core: prev.core || d.stage === "core" || d.stage === "all",
          enrich: prev.enrich || d.stage === "enrich" || d.stage === "all"
        }));
      }
    };
    window.addEventListener("tcs:global-data", onData);
    return () => window.removeEventListener("tcs:global-data", onData);
  }, []);
  const doRefresh = React.useCallback(async () => {
    if (typeof window.tcsGlobalRefresh !== "function") return;
    setRefreshing(true);
    await window.tcsGlobalRefresh();
    // Failure path: clear spinner after a beat in case no event fires.
    setTimeout(() => setRefreshing(false), 4000);
  }, []);
  const setRangeKey = React.useCallback(r => {
    setRangeKeyState(r);
    if (typeof window.tcsGlobalSetRange === "function") {
      setRefreshing(true);
      window.tcsGlobalSetRange(r);
    }
  }, []);
  return /*#__PURE__*/React.createElement("div", {
    className: "app",
    "data-density": t.density,
    "data-screen-label": "Global Dashboard"
  }, /*#__PURE__*/React.createElement(GlobalSidebar, {
    active: "global"
  }), /*#__PURE__*/React.createElement("div", {
    className: "main"
  }, /*#__PURE__*/React.createElement(GlobalTopbar, {
    crumb: ["Tuscaloosa City Schools", "Operations", "Global"],
    onRefresh: doRefresh,
    refreshing: refreshing
  }), /*#__PURE__*/React.createElement(GlobalHeader, {
    now: now,
    rangeKey: rangeKey,
    setRangeKey: setRangeKey
  }), /*#__PURE__*/React.createElement("div", {
    className: "body"
  }, (!stages.core || !stages.enrich) && /*#__PURE__*/React.createElement(LoadingBanner, {
    stages: stages
  }), stages.core ? /*#__PURE__*/React.createElement(SeverityStrip, null) : /*#__PURE__*/React.createElement("div", {
    className: "card",
    style: {
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-b"
  }, /*#__PURE__*/React.createElement(Skeleton, {
    rows: 1,
    height: 64
  }))), stages.enrich ? /*#__PURE__*/React.createElement(SystemSnapshot, null) : /*#__PURE__*/React.createElement("div", {
    className: "card",
    style: {
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "System Snapshot"), /*#__PURE__*/React.createElement("span", {
    className: "h-meta"
  }, "loading external systems\u2026")), /*#__PURE__*/React.createElement("div", {
    className: "card-b"
  }, /*#__PURE__*/React.createElement(Skeleton, {
    rows: 2,
    height: 110
  }))), stages.core ? /*#__PURE__*/React.createElement(SitesHeatmap, {
    filter: t.siteFilter,
    setFilter: v => setTweak("siteFilter", v)
  }) : /*#__PURE__*/React.createElement("div", {
    className: "card",
    style: {
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "Sites \u2014 Health Map")), /*#__PURE__*/React.createElement("div", {
    className: "card-b"
  }, /*#__PURE__*/React.createElement(Skeleton, {
    rows: 3,
    height: 56
  }))), /*#__PURE__*/React.createElement("div", {
    className: "row",
    style: {
      gridTemplateColumns: "1.4fr 1fr",
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "Active Triggers"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("div", {
    className: "seg-toggle"
  }, [["all", "All"], ["disaster", "Disaster"], ["high", "High"], ["warning", "Warning"]].map(([k, l]) => /*#__PURE__*/React.createElement("button", {
    key: k,
    className: "seg-btn" + (t.sevFilter === k ? " active" : ""),
    onClick: () => setTweak("sevFilter", k)
  }, l))), /*#__PURE__*/React.createElement("a", {
    className: "h-link"
  }, "All ", /*#__PURE__*/React.createElement(Icon, {
    name: "external",
    size: 11
  }))), /*#__PURE__*/React.createElement("div", {
    className: "card-b tight",
    style: {
      maxHeight: 380,
      overflowY: "auto"
    }
  }, stages.core ? /*#__PURE__*/React.createElement(TriggersTable, {
    filterSev: t.sevFilter
  }) : /*#__PURE__*/React.createElement(Skeleton, {
    rows: 5,
    height: 28
  }))), /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "Top Problem Hotspots"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("span", {
    className: "h-meta"
  }, "by site")), /*#__PURE__*/React.createElement("div", {
    className: "card-b"
  }, stages.core ? /*#__PURE__*/React.createElement(Hotspots, null) : /*#__PURE__*/React.createElement(Skeleton, {
    rows: 4,
    height: 32
  })))), /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "Recent Events"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  }), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "pf"
  }), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "ext"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("a", {
    className: "h-link"
  }, "Open in event console ", /*#__PURE__*/React.createElement(Icon, {
    name: "external",
    size: 11
  }))), /*#__PURE__*/React.createElement("div", {
    className: "card-b tight"
  }, stages.core ? /*#__PURE__*/React.createElement(EventsStream, null) : /*#__PURE__*/React.createElement(Skeleton, {
    rows: 4,
    height: 26
  }))))), /*#__PURE__*/React.createElement(TweaksPanel, {
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
    label: "Show data-source badges (ZBX/PF/EXT)",
    value: t.showSourceBadges,
    onChange: v => setTweak("showSourceBadges", v)
  })), /*#__PURE__*/React.createElement(TweakSection, {
    title: "Filters"
  }, /*#__PURE__*/React.createElement(TweakRadio, {
    label: "Sites view",
    value: t.siteFilter,
    options: [{
      value: "all",
      label: "All"
    }, {
      value: "issues",
      label: "Issues"
    }, {
      value: "ok",
      label: "OK only"
    }],
    onChange: v => setTweak("siteFilter", v)
  }), /*#__PURE__*/React.createElement(TweakSelect, {
    label: "Trigger severity",
    value: t.sevFilter,
    options: [{
      value: "all",
      label: "All severities"
    }, {
      value: "disaster",
      label: "Disaster only"
    }, {
      value: "high",
      label: "High & above"
    }, {
      value: "warning",
      label: "Warning only"
    }],
    onChange: v => setTweak("sevFilter", v)
  })), /*#__PURE__*/React.createElement(TweakSection, {
    title: "Quick actions"
  }, /*#__PURE__*/React.createElement(TweakButton, {
    onClick: doRefresh
  }, "Refresh now"), /*#__PURE__*/React.createElement(TweakButton, {
    onClick: () => alert("This would acknowledge all unacknowledged triggers below disaster.")
  }, "Bulk-ack warnings"))));
};
ReactDOM.createRoot(document.getElementById("root")).render(/*#__PURE__*/React.createElement(App, null));