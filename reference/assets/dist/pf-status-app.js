// PacketFence Status — cluster health, RADIUS perf, DB stats, queue depths.

const StatusHeader = () => /*#__PURE__*/React.createElement("div", {
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
}, /*#__PURE__*/React.createElement("h1", null, "PacketFence \xB7 Cluster Status"), /*#__PURE__*/React.createElement("span", {
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
}, "INFRASTRUCTURE")), /*#__PURE__*/React.createElement("div", {
  className: "host-meta"
}, /*#__PURE__*/React.createElement("span", {
  className: "pill"
}, /*#__PURE__*/React.createElement("span", {
  className: "dot",
  style: {
    background: "var(--warn)"
  }
}), " 1 node desync \xB7 pf-03"), /*#__PURE__*/React.createElement("span", {
  className: "pill"
}, /*#__PURE__*/React.createElement("span", {
  className: "lbl"
}, "Version"), " ", /*#__PURE__*/React.createElement("span", {
  className: "v"
}, "v", PF_SUMMARY.pfVersion)), /*#__PURE__*/React.createElement("span", {
  className: "pill"
}, /*#__PURE__*/React.createElement("span", {
  className: "lbl"
}, "VRRP master"), " ", /*#__PURE__*/React.createElement("span", {
  className: "v"
}, "pf-01")), /*#__PURE__*/React.createElement("span", {
  className: "pill"
}, /*#__PURE__*/React.createElement("span", {
  className: "lbl"
}, "Galera"), " ", /*#__PURE__*/React.createElement("span", {
  className: "v"
}, "3 nodes \xB7 1 joiner")), /*#__PURE__*/React.createElement("span", {
  className: "pill"
}, /*#__PURE__*/React.createElement("span", {
  className: "lbl"
}, "Polled by"), " ", /*#__PURE__*/React.createElement("span", {
  className: "v"
}, "Zabbix \xB7 template PF-12")))), /*#__PURE__*/React.createElement("div", {
  className: "timerange"
}, /*#__PURE__*/React.createElement(Icon, {
  name: "calendar"
}), /*#__PURE__*/React.createElement("span", {
  className: "range-val"
}, "Last 1h"), /*#__PURE__*/React.createElement(Icon, {
  name: "chevron"
})));

// KPI top strip — cluster-wide
const PerfKPIs = () => {
  const cells = [{
    lbl: "RADIUS req/sec",
    v: "418",
    note: "5-min avg · peak 612",
    cls: "pf"
  }, {
    lbl: "Accept latency",
    v: "4.2",
    unit: "ms",
    note: "p50 · p99 = 18ms",
    cls: "ok"
  }, {
    lbl: "Reject rate 1h",
    v: "1.0%",
    note: "142 of 14.2k req",
    cls: "warn"
  }, {
    lbl: "DB connections",
    v: "258",
    note: "pool 400 · 64%",
    cls: ""
  }, {
    lbl: "Galera lag",
    v: "2.4",
    unit: "s",
    note: "pf-03 catching up",
    cls: "warn"
  }, {
    lbl: "Cluster uptime",
    v: "47d",
    note: "no failover · 2026-04-03",
    cls: "ok"
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
    src: "zbx"
  })), /*#__PURE__*/React.createElement("div", {
    className: "pf-kpi-v " + c.cls
  }, c.v, c.unit && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      color: "var(--muted)",
      marginLeft: 4,
      fontWeight: 500
    }
  }, c.unit)), /*#__PURE__*/React.createElement("div", {
    className: "pf-kpi-note"
  }, c.note)))));
};

// Per-node card
const NodeCard = ({
  n
}) => {
  const cpuCls = n.cpu > 80 ? "err" : n.cpu > 60 ? "warn" : "ok";
  const memCls = n.mem > 80 ? "err" : n.mem > 60 ? "warn" : "ok";
  const latCls = n.radTime > 10 ? "err" : n.radTime > 7 ? "warn" : "ok";
  const queueCls = n.queue > 100 ? "err" : n.queue > 50 ? "warn" : "ok";
  return /*#__PURE__*/React.createElement("div", {
    className: "pf-node"
  }, /*#__PURE__*/React.createElement("div", {
    className: "pf-node-h"
  }, /*#__PURE__*/React.createElement("div", {
    className: "pf-node-name"
  }, n.name), /*#__PURE__*/React.createElement("span", {
    className: "pf-node-role " + n.role
  }, n.role.toUpperCase()), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer",
    style: {
      flex: 1
    }
  }), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  }), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "pf"
  })), /*#__PURE__*/React.createElement("div", {
    className: "pf-node-meta"
  }, n.host, " \xB7 up ", n.uptime), /*#__PURE__*/React.createElement("div", {
    className: "pf-node-grid"
  }, /*#__PURE__*/React.createElement("div", {
    className: "pf-node-cell"
  }, /*#__PURE__*/React.createElement("div", {
    className: "lbl"
  }, "CPU"), /*#__PURE__*/React.createElement("div", {
    className: "val " + cpuCls
  }, n.cpu, /*#__PURE__*/React.createElement("span", {
    className: "u"
  }, "%"))), /*#__PURE__*/React.createElement("div", {
    className: "pf-node-cell"
  }, /*#__PURE__*/React.createElement("div", {
    className: "lbl"
  }, "Memory"), /*#__PURE__*/React.createElement("div", {
    className: "val " + memCls
  }, n.mem, /*#__PURE__*/React.createElement("span", {
    className: "u"
  }, "%"))), /*#__PURE__*/React.createElement("div", {
    className: "pf-node-cell"
  }, /*#__PURE__*/React.createElement("div", {
    className: "lbl"
  }, "Disk /var"), /*#__PURE__*/React.createElement("div", {
    className: "val"
  }, n.disk, /*#__PURE__*/React.createElement("span", {
    className: "u"
  }, "%"))), /*#__PURE__*/React.createElement("div", {
    className: "pf-node-cell"
  }, /*#__PURE__*/React.createElement("div", {
    className: "lbl"
  }, "RADIUS req/s"), /*#__PURE__*/React.createElement("div", {
    className: "val"
  }, n.radSec)), /*#__PURE__*/React.createElement("div", {
    className: "pf-node-cell"
  }, /*#__PURE__*/React.createElement("div", {
    className: "lbl"
  }, "DB conn"), /*#__PURE__*/React.createElement("div", {
    className: "val"
  }, n.dbConn)), /*#__PURE__*/React.createElement("div", {
    className: "pf-node-cell"
  }, /*#__PURE__*/React.createElement("div", {
    className: "lbl"
  }, "Auth latency"), /*#__PURE__*/React.createElement("div", {
    className: "val " + latCls
  }, n.radTime, /*#__PURE__*/React.createElement("span", {
    className: "u"
  }, "ms")))), /*#__PURE__*/React.createElement("div", {
    className: "pf-node-svc"
  }, n.services.map(s => /*#__PURE__*/React.createElement("span", {
    key: s.n,
    className: "pf-svc " + (s.s !== "ok" ? s.s : "")
  }, /*#__PURE__*/React.createElement("span", {
    className: "dot",
    style: {
      background: s.s === "ok" ? "var(--ok)" : s.s === "warn" ? "var(--warn)" : "var(--err)"
    }
  }), s.n))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8,
      marginTop: 2,
      paddingTop: 8,
      borderTop: "1px solid var(--line)",
      fontSize: 11
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--muted)"
    }
  }, "Queue \xB7 pfacct"), /*#__PURE__*/React.createElement("span", {
    className: "mono",
    style: {
      color: n.queue > 100 ? "var(--err)" : n.queue > 50 ? "var(--warn)" : "var(--fg-2)",
      fontWeight: 600
    }
  }, n.queue), /*#__PURE__*/React.createElement("div", {
    className: "pf-queue-bar",
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: queueCls === "ok" ? "" : queueCls === "warn" ? "warn" : "err",
    style: {
      width: `${Math.min(100, n.queue / 5)}%`
    }
  }))));
};

// Galera replication strip
const GaleraStrip = () => /*#__PURE__*/React.createElement("div", {
  className: "card"
}, /*#__PURE__*/React.createElement("div", {
  className: "card-h"
}, /*#__PURE__*/React.createElement("h3", null, "MariaDB \xB7 Galera Replication"), /*#__PURE__*/React.createElement(SourceBadge, {
  src: "pf"
}), /*#__PURE__*/React.createElement(SourceBadge, {
  src: "zbx"
}), /*#__PURE__*/React.createElement("div", {
  className: "h-spacer"
}), /*#__PURE__*/React.createElement("span", {
  className: "h-meta"
}, "wsrep_cluster_size = 3 \xB7 wsrep_cluster_status = Primary")), /*#__PURE__*/React.createElement("div", {
  style: {
    display: "grid",
    gridTemplateColumns: "repeat(3, 1fr)",
    padding: 14,
    gap: 14
  }
}, [{
  node: "pf-01",
  state: "Synced",
  role: "Donor",
  queue: 0,
  sent: "8.2 GB / hr",
  lag: "0.0s",
  cls: "ok"
}, {
  node: "pf-02",
  state: "Synced",
  role: "Joiner",
  queue: 0,
  sent: "—",
  lag: "0.0s",
  cls: "ok"
}, {
  node: "pf-03",
  state: "Joining",
  role: "Receiver",
  queue: 240,
  sent: "—",
  lag: "2.4s",
  cls: "warn"
}].map(g => /*#__PURE__*/React.createElement("div", {
  key: g.node,
  style: {
    border: "1px solid var(--line)",
    borderRadius: 6,
    padding: 12,
    background: "var(--bg-1)"
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    marginBottom: 8
  }
}, /*#__PURE__*/React.createElement("span", {
  style: {
    fontWeight: 600
  }
}, g.node), /*#__PURE__*/React.createElement("span", {
  className: "mono",
  style: {
    fontSize: 10,
    color: g.cls === "ok" ? "var(--ok)" : "var(--warn)"
  }
}, "\u25CF ", g.state), /*#__PURE__*/React.createElement("span", {
  className: "h-spacer",
  style: {
    flex: 1
  }
}), /*#__PURE__*/React.createElement("span", {
  className: "mono",
  style: {
    fontSize: 10,
    color: "var(--muted)"
  }
}, g.role)), /*#__PURE__*/React.createElement("div", {
  style: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 6
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    fontSize: 10,
    color: "var(--muted)",
    textTransform: "uppercase",
    letterSpacing: 0.5
  }
}, "Recv queue"), /*#__PURE__*/React.createElement("div", {
  style: {
    fontFamily: "var(--mono)",
    fontSize: 12,
    color: g.queue > 0 ? "var(--warn)" : "var(--fg)",
    textAlign: "right"
  }
}, g.queue), /*#__PURE__*/React.createElement("div", {
  style: {
    fontSize: 10,
    color: "var(--muted)",
    textTransform: "uppercase",
    letterSpacing: 0.5
  }
}, "Replicated"), /*#__PURE__*/React.createElement("div", {
  style: {
    fontFamily: "var(--mono)",
    fontSize: 12,
    color: "var(--fg)",
    textAlign: "right"
  }
}, g.sent), /*#__PURE__*/React.createElement("div", {
  style: {
    fontSize: 10,
    color: "var(--muted)",
    textTransform: "uppercase",
    letterSpacing: 0.5
  }
}, "Apply lag"), /*#__PURE__*/React.createElement("div", {
  style: {
    fontFamily: "var(--mono)",
    fontSize: 12,
    color: g.cls === "ok" ? "var(--fg)" : "var(--warn)",
    textAlign: "right"
  }
}, g.lag))))));

// Perf timelines (RADIUS req/s, DB conn, Queue depth)
const PerfTimelines = () => {
  const items = [{
    label: "RADIUS req/sec",
    data: PF_RADIUS_TIMELINE,
    color: "var(--pf)",
    last: PF_RADIUS_TIMELINE[PF_RADIUS_TIMELINE.length - 1] + "/s",
    warn: 600
  }, {
    label: "DB connections",
    data: PF_DB_TIMELINE,
    color: "var(--info)",
    last: PF_DB_TIMELINE[PF_DB_TIMELINE.length - 1] + " conn",
    warn: 350
  }, {
    label: "pfacct queue depth",
    data: PF_QUEUE_TIMELINE,
    color: "var(--warn)",
    last: PF_QUEUE_TIMELINE[PF_QUEUE_TIMELINE.length - 1] + "",
    warn: 100
  }];
  return /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "Performance \xB7 last 60 min"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("span", {
    className: "h-meta"
  }, "1-min samples")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gridTemplateColumns: "repeat(3, 1fr)"
    }
  }, items.map((it, i) => /*#__PURE__*/React.createElement("div", {
    key: it.label,
    style: {
      padding: 14,
      borderRight: i < items.length - 1 ? "1px solid var(--line)" : 0,
      display: "flex",
      flexDirection: "column",
      gap: 6
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 10.5,
      color: "var(--muted)",
      textTransform: "uppercase",
      letterSpacing: 0.5,
      flex: 1
    }
  }, it.label), /*#__PURE__*/React.createElement("span", {
    className: "mono",
    style: {
      fontSize: 14,
      fontWeight: 600,
      color: "var(--fg)"
    }
  }, it.last)), /*#__PURE__*/React.createElement(Sparkline, {
    data: it.data,
    color: it.color,
    width: 400,
    height: 56,
    fill: true,
    threshold: it.warn
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      justifyContent: "space-between",
      fontSize: 9.5,
      color: "var(--muted)",
      fontFamily: "var(--mono)"
    }
  }, /*#__PURE__*/React.createElement("span", null, "-60m"), /*#__PURE__*/React.createElement("span", null, "-30m"), /*#__PURE__*/React.createElement("span", null, "now"))))));
};

// Queues
const Queues = () => /*#__PURE__*/React.createElement("div", {
  className: "card"
}, /*#__PURE__*/React.createElement("div", {
  className: "card-h"
}, /*#__PURE__*/React.createElement("h3", null, "Queue Depths"), /*#__PURE__*/React.createElement(SourceBadge, {
  src: "pf"
}), /*#__PURE__*/React.createElement("div", {
  className: "h-spacer"
}), /*#__PURE__*/React.createElement("span", {
  className: "h-meta"
}, "pfqueue + pfacct + fingerbank")), /*#__PURE__*/React.createElement("div", {
  className: "card-b tight"
}, PF_QUEUES.map(q => {
  const pct = q.depth / q.cap * 100;
  const cls = pct > 75 ? "err" : pct > 30 ? "warn" : "";
  return /*#__PURE__*/React.createElement("div", {
    className: "pf-queue-row",
    key: q.name
  }, /*#__PURE__*/React.createElement("div", {
    className: "pf-queue-name"
  }, q.name), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "pf-queue-bar"
  }, /*#__PURE__*/React.createElement("div", {
    className: cls,
    style: {
      width: `${Math.max(2, pct)}%`
    }
  })), q.note && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10,
      color: "var(--warn)",
      marginTop: 3
    }
  }, "\u21B3 ", q.note)), /*#__PURE__*/React.createElement("div", {
    className: "pf-queue-val"
  }, q.depth, /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--muted)"
    }
  }, " / ", q.cap), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10,
      color: "var(--muted)",
      marginTop: 2
    }
  }, q.rate)));
})));

// Service events stream
const ServiceEvents = () => /*#__PURE__*/React.createElement("div", {
  className: "card"
}, /*#__PURE__*/React.createElement("div", {
  className: "card-h"
}, /*#__PURE__*/React.createElement("h3", null, "Recent Service Events"), /*#__PURE__*/React.createElement(SourceBadge, {
  src: "pf"
}), /*#__PURE__*/React.createElement(SourceBadge, {
  src: "zbx"
}), /*#__PURE__*/React.createElement("div", {
  className: "h-spacer"
}), /*#__PURE__*/React.createElement("a", {
  className: "h-link"
}, "Open log ", /*#__PURE__*/React.createElement(Icon, {
  name: "external",
  size: 11
}))), /*#__PURE__*/React.createElement("div", {
  className: "events"
}, PF_SERVICE_EVENTS.map((e, i) => /*#__PURE__*/React.createElement("div", {
  className: "event",
  key: i,
  style: {
    gridTemplateColumns: "80px 60px 90px 1fr"
  }
}, /*#__PURE__*/React.createElement("div", {
  className: "ts"
}, e.ts), /*#__PURE__*/React.createElement("div", {
  className: "src " + e.src
}, e.src.toUpperCase()), /*#__PURE__*/React.createElement("div", {
  className: "mono",
  style: {
    fontSize: 11,
    color: "var(--fg-2)"
  }
}, e.host), /*#__PURE__*/React.createElement("div", {
  className: "msg"
}, /*#__PURE__*/React.createElement("span", {
  style: {
    color: e.sev === "ok" ? "var(--ok)" : e.sev === "high" ? "var(--err)" : e.sev === "warn" ? "var(--warn)" : "var(--info)",
    fontWeight: 500
  }
}, e.msg), /*#__PURE__*/React.createElement("span", {
  style: {
    color: "var(--fg)"
  }
}, e.obj))))));

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
    "data-screen-label": "PacketFence Status"
  }, /*#__PURE__*/React.createElement(GlobalSidebar, {
    active: "pf-status"
  }), /*#__PURE__*/React.createElement("div", {
    className: "main"
  }, /*#__PURE__*/React.createElement(GlobalTopbar, {
    crumb: ["Tuscaloosa City Schools", "Identity", "PacketFence Status"]
  }), /*#__PURE__*/React.createElement(StatusHeader, null), /*#__PURE__*/React.createElement("div", {
    className: "body"
  }, /*#__PURE__*/React.createElement(DemoBanner, {
    name: "PacketFence Status"
  }), /*#__PURE__*/React.createElement(PerfKPIs, null), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gridTemplateColumns: "repeat(3, 1fr)",
      gap: 14,
      marginBottom: 14
    }
  }, PF_NODES.map(n => /*#__PURE__*/React.createElement(NodeCard, {
    key: n.id,
    n: n
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement(PerfTimelines, null)), /*#__PURE__*/React.createElement("div", {
    className: "row",
    style: {
      gridTemplateColumns: "1.2fr 1fr",
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement(Queues, null), /*#__PURE__*/React.createElement(GaleraStrip, null)), /*#__PURE__*/React.createElement(ServiceEvents, null))), /*#__PURE__*/React.createElement(TweaksPanel, {
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
    title: "Cluster ops"
  }, /*#__PURE__*/React.createElement(TweakButton, {
    onClick: () => alert("Would force a full Galera re-sync on pf-03.")
  }, "Re-sync pf-03"), /*#__PURE__*/React.createElement(TweakButton, {
    onClick: () => alert("Would drain pf-03 (graceful) and remove from VRRP pool.")
  }, "Drain pf-03"))));
};
ReactDOM.createRoot(document.getElementById("root")).render(/*#__PURE__*/React.createElement(App, null));