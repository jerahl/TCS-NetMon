// Zabbix Server + Proxy Status — internal-side view of the monitoring platform itself.

const {
  useState,
  useEffect
} = React;

// ───────── Live data bindings ─────────
// Globals are populated by zbx-status-bridge.jsx (from window.ZBX_BOOT on
// first paint, then refreshed by fetch to tcs.zbx.status.data). These `let`s
// are live bindings — child components reference them by name and pick up
// reassignments when the bridge fires "tcs:zbx-status-data". The root App
// listens for that event and bumps a render counter.
let ZBX_SUMMARY = window.ZBX_SUMMARY || {};
let ZBX_NODES = window.ZBX_NODES || [];
let ZBX_PROCESSES = window.ZBX_PROCESSES || [];
let ZBX_CACHES = window.ZBX_CACHES || [];
let ZBX_PROXIES = window.ZBX_PROXIES || [];
let ZBX_NVPS_TIMELINE = window.ZBX_NVPS_TIMELINE || [];
let ZBX_QUEUE_TIMELINE = window.ZBX_QUEUE_TIMELINE || [];
let ZBX_CACHE_TIMELINE = window.ZBX_CACHE_TIMELINE || [];
let ZBX_EVENTS = window.ZBX_EVENTS || [];
window.addEventListener("tcs:zbx-status-data", () => {
  ZBX_SUMMARY = window.ZBX_SUMMARY || ZBX_SUMMARY;
  ZBX_NODES = window.ZBX_NODES || ZBX_NODES;
  ZBX_PROCESSES = window.ZBX_PROCESSES || ZBX_PROCESSES;
  ZBX_CACHES = window.ZBX_CACHES || ZBX_CACHES;
  ZBX_PROXIES = window.ZBX_PROXIES || ZBX_PROXIES;
  ZBX_NVPS_TIMELINE = window.ZBX_NVPS_TIMELINE || ZBX_NVPS_TIMELINE;
  ZBX_QUEUE_TIMELINE = window.ZBX_QUEUE_TIMELINE || ZBX_QUEUE_TIMELINE;
  ZBX_CACHE_TIMELINE = window.ZBX_CACHE_TIMELINE || ZBX_CACHE_TIMELINE;
  ZBX_EVENTS = window.ZBX_EVENTS || ZBX_EVENTS;
});
const tail = (arr, fallback = 0) => Array.isArray(arr) && arr.length ? arr[arr.length - 1] : fallback;
const LiveBanner = () => {
  const b = window.ZBX_BANNER;
  if (!b) return null;
  const color = b.kind === "error" ? "var(--err)" : "var(--warn)";
  const bg = b.kind === "error" ? "rgba(242,95,92,0.10)" : "rgba(245,179,0,0.10)";
  return /*#__PURE__*/React.createElement("div", {
    style: {
      margin: "0 0 14px",
      padding: "8px 12px",
      border: "1px solid " + color,
      background: bg,
      color: color,
      fontSize: 12,
      borderRadius: 4
    }
  }, /*#__PURE__*/React.createElement("strong", {
    style: {
      marginRight: 8,
      textTransform: "uppercase",
      letterSpacing: ".06em",
      fontSize: 10.5
    }
  }, b.kind), b.msg);
};
const StatusHeader = () => {
  const s = ZBX_SUMMARY || {};
  const px = s.proxies || {
    total: 0,
    offline: 0,
    drift: 0
  };
  const hosts = s.hosts || {};
  const items = s.items || {};
  const triggers = s.triggers || {};
  const offline = px.offline || 0;
  const drift = px.drift || 0;
  const dotColor = offline > 0 ? "var(--err)" : drift > 0 ? "var(--warn)" : "var(--ok)";
  const summaryMsg = offline > 0 ? `Cluster healthy · ${offline} proxy ${offline === 1 ? "unreachable" : "unreachable"}` : drift > 0 ? `Cluster healthy · ${drift} proxy ${drift === 1 ? "version drift" : "with version drift"}` : px.total > 0 ? `Cluster healthy · ${px.total} ${px.total === 1 ? "proxy" : "proxies"} online` : "Cluster healthy";
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
  }, /*#__PURE__*/React.createElement("h1", null, "Zabbix \xB7 Server & Proxy Status"), /*#__PURE__*/React.createElement("span", {
    className: "role-tag",
    style: {
      fontSize: 10,
      padding: "1px 8px",
      background: "rgba(217,41,41,0.10)",
      color: "var(--zbx)",
      border: "1px solid rgba(217,41,41,0.4)"
    }
  }, "MONITORING \xB7 CORE"), /*#__PURE__*/React.createElement("span", {
    className: "role-tag faculty",
    style: {
      fontSize: 10,
      padding: "1px 8px"
    }
  }, ZBX_NODES.length > 1 ? "HA CLUSTER" : "STANDALONE")), /*#__PURE__*/React.createElement("div", {
    className: "host-meta"
  }, /*#__PURE__*/React.createElement("span", {
    className: "pill"
  }, /*#__PURE__*/React.createElement("span", {
    className: "dot",
    style: {
      background: dotColor
    }
  }), " ", summaryMsg), /*#__PURE__*/React.createElement("span", {
    className: "pill"
  }, /*#__PURE__*/React.createElement("span", {
    className: "lbl"
  }, "Version"), " ", /*#__PURE__*/React.createElement("span", {
    className: "v"
  }, s.version || "—")), /*#__PURE__*/React.createElement("span", {
    className: "pill"
  }, /*#__PURE__*/React.createElement("span", {
    className: "lbl"
  }, "Active node"), " ", /*#__PURE__*/React.createElement("span", {
    className: "v"
  }, s.primary || "—")), /*#__PURE__*/React.createElement("span", {
    className: "pill"
  }, /*#__PURE__*/React.createElement("span", {
    className: "lbl"
  }, "Up"), " ", /*#__PURE__*/React.createElement("span", {
    className: "v"
  }, s.upHuman || "—")), /*#__PURE__*/React.createElement("span", {
    className: "pill"
  }, /*#__PURE__*/React.createElement("span", {
    className: "lbl"
  }, "Hosts"), " ", /*#__PURE__*/React.createElement("span", {
    className: "v"
  }, (hosts.monitored || 0).toLocaleString())), /*#__PURE__*/React.createElement("span", {
    className: "pill"
  }, /*#__PURE__*/React.createElement("span", {
    className: "lbl"
  }, "Items"), " ", /*#__PURE__*/React.createElement("span", {
    className: "v"
  }, (items.enabled || 0).toLocaleString())), /*#__PURE__*/React.createElement("span", {
    className: "pill"
  }, /*#__PURE__*/React.createElement("span", {
    className: "lbl"
  }, "Triggers"), " ", /*#__PURE__*/React.createElement("span", {
    className: "v"
  }, (triggers.enabled || 0).toLocaleString(), " (", triggers.problem || 0, " problem)")))), /*#__PURE__*/React.createElement("div", {
    className: "timerange"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "calendar"
  }), /*#__PURE__*/React.createElement("span", {
    className: "range-val"
  }, "Last 1h"), /*#__PURE__*/React.createElement(Icon, {
    name: "chevron"
  })));
};

// ───────── KPI strip ─────────
const PerfKPIs = () => {
  const s = ZBX_SUMMARY || {};
  const hosts = s.hosts || {};
  const items = s.items || {};
  const triggers = s.triggers || {};
  const queue = s.queue || {};
  const proxies = s.proxies || {
    total: 0,
    online: 0,
    offline: 0,
    drift: 0
  };
  const reqPerf = s.reqPerf || 0;
  const actPerf = s.actPerf || 0;
  const reqRatio = reqPerf > 0 ? Math.round(actPerf / reqPerf * 100) : 0;
  const cells = [{
    lbl: "NVPS · actual",
    v: actPerf.toLocaleString(),
    unit: "/s",
    note: `req ${reqPerf.toLocaleString()}/s · ${reqRatio}% of req`,
    cls: ""
  }, {
    lbl: "Hosts monitored",
    v: (hosts.monitored || 0).toLocaleString(),
    note: `${hosts.disabled || 0} disabled · ${hosts.templates || 0} templates`,
    cls: ""
  }, {
    lbl: "Items enabled",
    v: ((items.enabled || 0) / 1000).toFixed(1) + "k",
    note: `${items.notSupported || 0} not supported`,
    cls: ""
  }, {
    lbl: "Queue · total",
    v: String(queue.total || 0),
    note: `${queue.ten_min || 0} > 10m · ${queue.half_hr || 0} > 30m`,
    cls: (queue.total || 0) > 100 ? "warn" : ""
  }, {
    lbl: "Problems",
    v: String(triggers.problem || 0),
    note: `${triggers.suppressed || 0} suppressed · ${(triggers.ok || 0).toLocaleString()} OK`,
    cls: (triggers.problem || 0) > 0 ? "warn" : ""
  }, {
    lbl: "Proxies online",
    v: `${proxies.online || 0} / ${proxies.total || 0}`,
    note: `${proxies.offline || 0} unreachable · ${proxies.drift || 0} ver. drift`,
    cls: (proxies.offline || 0) > 0 ? "warn" : ""
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

// ───────── HA cluster nodes ─────────
const HANodeCard = ({
  n
}) => {
  const cpuCls = n.cpu > 80 ? "err" : n.cpu > 60 ? "warn" : "ok";
  const memCls = n.mem > 80 ? "err" : n.mem > 60 ? "warn" : "ok";
  const roleColor = n.role === "active" ? "var(--ok)" : n.role === "standby" ? "var(--info)" : "var(--err)";
  const roleBg = n.role === "active" ? "rgba(52,211,153,0.10)" : n.role === "standby" ? "rgba(95,168,211,0.10)" : "rgba(242,95,92,0.10)";
  return /*#__PURE__*/React.createElement("div", {
    className: "pf-node"
  }, /*#__PURE__*/React.createElement("div", {
    className: "pf-node-h"
  }, /*#__PURE__*/React.createElement("div", {
    className: "pf-node-name"
  }, n.id), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--mono)",
      fontSize: 9.5,
      fontWeight: 700,
      letterSpacing: 0.6,
      padding: "1px 6px",
      border: "1px solid " + roleColor,
      borderRadius: 3,
      color: roleColor,
      background: roleBg
    }
  }, n.role.toUpperCase()), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer",
    style: {
      flex: 1
    }
  }), /*#__PURE__*/React.createElement("span", {
    className: "mono",
    style: {
      fontSize: 10.5,
      color: "var(--muted)"
    }
  }, "v", n.version), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  })), /*#__PURE__*/React.createElement("div", {
    className: "pf-node-meta"
  }, n.host, " \xB7 ", n.ip, " \xB7 up ", n.uptime), /*#__PURE__*/React.createElement("div", {
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
  }, "Disk /var/lib"), /*#__PURE__*/React.createElement("div", {
    className: "val"
  }, n.disk, /*#__PURE__*/React.createElement("span", {
    className: "u"
  }, "%"))), /*#__PURE__*/React.createElement("div", {
    className: "pf-node-cell"
  }, /*#__PURE__*/React.createElement("div", {
    className: "lbl"
  }, "NVPS"), /*#__PURE__*/React.createElement("div", {
    className: "val"
  }, n.nvps ? n.nvps.toLocaleString() : "—", n.nvps ? /*#__PURE__*/React.createElement("span", {
    className: "u"
  }, "/s") : null)), /*#__PURE__*/React.createElement("div", {
    className: "pf-node-cell"
  }, /*#__PURE__*/React.createElement("div", {
    className: "lbl"
  }, "DB conn"), /*#__PURE__*/React.createElement("div", {
    className: "val"
  }, n.dbConn)), /*#__PURE__*/React.createElement("div", {
    className: "pf-node-cell"
  }, /*#__PURE__*/React.createElement("div", {
    className: "lbl"
  }, "Last seen"), /*#__PURE__*/React.createElement("div", {
    className: "val"
  }, n.lastSeen))), /*#__PURE__*/React.createElement("div", {
    className: "pf-node-svc"
  }, n.services.map(s => {
    const isStandby = s.s === "standby";
    const cls = isStandby ? "" : s.s !== "ok" ? s.s : "";
    const dotBg = s.s === "ok" ? "var(--ok)" : s.s === "warn" ? "var(--warn)" : isStandby ? "var(--info)" : "var(--err)";
    return /*#__PURE__*/React.createElement("span", {
      key: s.n,
      className: "pf-svc " + cls,
      style: isStandby ? {
        color: "var(--info)",
        borderColor: "rgba(95,168,211,0.4)",
        background: "rgba(95,168,211,0.08)"
      } : null
    }, /*#__PURE__*/React.createElement("span", {
      className: "dot",
      style: {
        background: dotBg
      }
    }), s.n);
  })));
};

// ───────── Internal processes ─────────
const ProcessGroup = ({
  title,
  items
}) => {
  const forkSum = items.reduce((a, b) => a + (b.forks || 0), 0);
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      gap: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8,
      padding: "9px 14px",
      background: "rgba(255,255,255,0.015)",
      borderBottom: "1px solid var(--line)",
      fontSize: 10.5,
      color: "var(--muted)",
      textTransform: "uppercase",
      letterSpacing: 0.6,
      fontWeight: 600
    }
  }, /*#__PURE__*/React.createElement("span", null, title), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }), /*#__PURE__*/React.createElement("span", {
    className: "mono",
    style: {
      fontSize: 10,
      color: "var(--muted)",
      textTransform: "none",
      letterSpacing: 0
    }
  }, items.length, " processes", forkSum > 0 ? ` · ${forkSum} forks` : "")), items.map(p => {
    const cls = p.busy > 80 ? "err" : p.busy > 60 ? "warn" : "ok";
    const barCls = cls === "ok" ? "" : cls;
    return /*#__PURE__*/React.createElement("div", {
      className: "pf-queue-row",
      key: p.n,
      style: {
        gridTemplateColumns: "180px 1fr 110px"
      }
    }, /*#__PURE__*/React.createElement("div", {
      className: "pf-queue-name"
    }, p.n, p.alert && /*#__PURE__*/React.createElement("span", {
      style: {
        marginLeft: 6,
        fontSize: 9,
        color: "var(--err)"
      }
    }, "\u25CF")), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
      className: "pf-queue-bar"
    }, /*#__PURE__*/React.createElement("div", {
      className: barCls,
      style: {
        width: `${Math.max(2, p.busy)}%`,
        background: cls === "ok" ? "var(--ok)" : cls === "warn" ? "var(--warn)" : "var(--err)"
      }
    })), p.alert && /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 10,
        color: "var(--warn)",
        marginTop: 3
      }
    }, "\u21B3 sustained > 80% for 5m")), /*#__PURE__*/React.createElement("div", {
      className: "pf-queue-val"
    }, /*#__PURE__*/React.createElement("span", {
      className: "mono",
      style: {
        color: cls === "ok" ? "var(--fg-2)" : cls === "warn" ? "var(--warn)" : "var(--err)",
        fontWeight: 600
      }
    }, p.busy, "%"), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 10,
        color: "var(--muted)",
        marginTop: 2
      }
    }, p.forks > 0 ? `${p.forks} fork${p.forks > 1 ? "s" : ""}` : "— forks")));
  }));
};
const ProcessPanel = () => {
  const groups = ["Pollers", "Data flow", "Triggers", "Discovery", "Housekeeping"];
  return /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "Internal Processes \xB7 % busy"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("span", {
    className: "h-meta"
  }, "5-min avg \xB7 zabbix-server only")), /*#__PURE__*/React.createElement("div", {
    className: "card-b tight"
  }, groups.map(g => /*#__PURE__*/React.createElement(ProcessGroup, {
    key: g,
    title: g,
    items: ZBX_PROCESSES.filter(p => p.group === g)
  }))));
};

// ───────── Cache usage rings ─────────
const CachePanel = () => /*#__PURE__*/React.createElement("div", {
  className: "card"
}, /*#__PURE__*/React.createElement("div", {
  className: "card-h"
}, /*#__PURE__*/React.createElement("h3", null, "Cache Usage"), /*#__PURE__*/React.createElement(SourceBadge, {
  src: "zbx"
}), /*#__PURE__*/React.createElement("div", {
  className: "h-spacer"
}), /*#__PURE__*/React.createElement("span", {
  className: "h-meta"
}, "% used")), /*#__PURE__*/React.createElement("div", {
  style: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 1,
    background: "var(--line)"
  }
}, ZBX_CACHES.map(c => {
  const color = c.used > 80 ? "var(--err)" : c.used > 60 ? "var(--warn)" : "var(--ok)";
  return /*#__PURE__*/React.createElement("div", {
    key: c.n,
    style: {
      background: "var(--bg-1)",
      padding: 14,
      display: "flex",
      gap: 12,
      alignItems: "center"
    }
  }, /*#__PURE__*/React.createElement(Ring, {
    value: c.used,
    max: 100,
    size: 64,
    color: color,
    label: /*#__PURE__*/React.createElement("span", {
      className: "mono",
      style: {
        fontSize: 14,
        fontWeight: 600
      }
    }, c.used, "%"),
    sub: null
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      minWidth: 0,
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: "var(--fg)",
      fontWeight: 500
    }
  }, c.n), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10.5,
      color: "var(--muted)",
      fontFamily: "var(--mono)",
      marginTop: 3
    }
  }, c.note, " = ", c.size), c.warn && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10,
      color: "var(--warn)",
      marginTop: 3
    }
  }, "\u21B3 approaching limit")));
})));

// ───────── Perf timelines ─────────
const PerfTimelines = () => {
  const reqPerf = ZBX_SUMMARY && ZBX_SUMMARY.reqPerf || 0;
  const items = [{
    label: "NVPS (new values/sec)",
    data: ZBX_NVPS_TIMELINE,
    color: "var(--zbx)",
    last: tail(ZBX_NVPS_TIMELINE).toLocaleString() + "/s",
    warn: reqPerf
  }, {
    label: "Queue depth",
    data: ZBX_QUEUE_TIMELINE,
    color: "var(--warn)",
    last: tail(ZBX_QUEUE_TIMELINE) + " items",
    warn: 200
  }, {
    label: "Value cache · % used",
    data: ZBX_CACHE_TIMELINE,
    color: "var(--info)",
    last: tail(ZBX_CACHE_TIMELINE) + "%",
    warn: 80
  }];
  return /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "Server performance \xB7 last 60 min"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("span", {
    className: "h-meta"
  }, "1-min samples \xB7 internal items")), /*#__PURE__*/React.createElement("div", {
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

// ───────── Proxies table ─────────
const ProxiesTable = () => {
  const [sortKey, setSortKey] = React.useState("status");
  const [filter, setFilter] = React.useState("");
  const cmp = (a, b) => {
    const order = {
      down: 0,
      warn: 1,
      ok: 2
    };
    if (sortKey === "status") return order[a.status] - order[b.status];
    if (sortKey === "nvps") return b.nvps - a.nvps;
    if (sortKey === "hosts") return b.hosts - a.hosts;
    if (sortKey === "queue") return b.queue - a.queue;
    if (sortKey === "name") return a.id.localeCompare(b.id);
    return 0;
  };
  const rows = ZBX_PROXIES.filter(p => !filter || (p.id + p.host + p.site).toLowerCase().includes(filter.toLowerCase())).slice().sort(cmp);
  const sortBtn = (k, l) => /*#__PURE__*/React.createElement("span", {
    onClick: () => setSortKey(k),
    style: {
      cursor: "pointer",
      color: sortKey === k ? "var(--fg)" : "var(--muted)",
      fontWeight: sortKey === k ? 600 : 400
    }
  }, l, sortKey === k ? " ▾" : "");
  return /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "Zabbix Proxies \xB7 ", ZBX_PROXIES.length, " total"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 6,
      background: "var(--bg-2)",
      border: "1px solid var(--line)",
      borderRadius: 4,
      padding: "3px 8px"
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "search",
    size: 11
  }), /*#__PURE__*/React.createElement("input", {
    placeholder: "filter\u2026",
    value: filter,
    onChange: e => setFilter(e.target.value),
    style: {
      border: 0,
      outline: 0,
      background: "transparent",
      color: "var(--fg)",
      font: "inherit",
      fontSize: 11,
      width: 110
    }
  })), /*#__PURE__*/React.createElement("a", {
    className: "h-link"
  }, "All proxies ", /*#__PURE__*/React.createElement(Icon, {
    name: "external",
    size: 11
  }))), /*#__PURE__*/React.createElement("div", {
    className: "zbx-proxy-table"
  }, /*#__PURE__*/React.createElement("div", {
    className: "zbx-proxy-row zbx-proxy-head"
  }, /*#__PURE__*/React.createElement("div", null), /*#__PURE__*/React.createElement("div", null, sortBtn("name", "Proxy")), /*#__PURE__*/React.createElement("div", null, "Site"), /*#__PURE__*/React.createElement("div", null, "Mode"), /*#__PURE__*/React.createElement("div", null, "Version"), /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "right"
    }
  }, sortBtn("hosts", "Hosts")), /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "right"
    }
  }, "Items"), /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "right"
    }
  }, sortBtn("nvps", "NVPS")), /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "right"
    }
  }, sortBtn("queue", "Queue")), /*#__PURE__*/React.createElement("div", null, "CPU \xB7 Mem"), /*#__PURE__*/React.createElement("div", null, "Last seen"), /*#__PURE__*/React.createElement("div", null)), rows.map(p => {
    const sColor = p.status === "ok" ? "var(--ok)" : p.status === "warn" ? "var(--warn)" : "var(--err)";
    const isDown = p.status === "down";
    return /*#__PURE__*/React.createElement("div", {
      className: "zbx-proxy-row" + (isDown ? " zbx-proxy-down" : ""),
      key: p.id
    }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("span", {
      className: "dot",
      style: {
        background: sColor,
        boxShadow: p.status === "ok" ? `0 0 4px ${sColor}` : "none",
        width: 8,
        height: 8,
        borderRadius: "50%"
      }
    })), /*#__PURE__*/React.createElement("div", {
      className: "zbx-proxy-name"
    }, /*#__PURE__*/React.createElement("div", {
      className: "mono",
      style: {
        fontSize: 12,
        color: "var(--fg)"
      }
    }, p.id), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 10,
        color: "var(--muted)",
        fontFamily: "var(--mono)"
      }
    }, p.ip)), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 12,
        color: "var(--fg-2)"
      }
    }, p.host), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 10,
        color: "var(--muted)"
      }
    }, p.site)), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("span", {
      style: {
        fontFamily: "var(--mono)",
        fontSize: 9.5,
        fontWeight: 700,
        letterSpacing: 0.5,
        padding: "1px 5px",
        border: "1px solid",
        borderColor: p.mode === "active" ? "rgba(217,41,41,0.4)" : "var(--line-2)",
        borderRadius: 3,
        color: p.mode === "active" ? "var(--zbx)" : "var(--fg-2)",
        background: p.mode === "active" ? "rgba(217,41,41,0.08)" : "var(--bg-2)"
      }
    }, p.mode.toUpperCase()), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 9.5,
        color: "var(--muted)",
        marginTop: 3,
        fontFamily: "var(--mono)"
      }
    }, p.encrypted)), /*#__PURE__*/React.createElement("div", {
      className: "mono",
      style: {
        fontSize: 11.5,
        color: p.version === (ZBX_SUMMARY && ZBX_SUMMARY.version) ? "var(--fg-2)" : "var(--warn)"
      }
    }, "v", p.version, p.version !== (ZBX_SUMMARY && ZBX_SUMMARY.version) && /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 9.5,
        color: "var(--warn)"
      }
    }, "drift")), /*#__PURE__*/React.createElement("div", {
      className: "mono",
      style: {
        textAlign: "right",
        fontSize: 12
      }
    }, p.hosts), /*#__PURE__*/React.createElement("div", {
      className: "mono",
      style: {
        textAlign: "right",
        fontSize: 12,
        color: "var(--fg-2)"
      }
    }, p.items.toLocaleString()), /*#__PURE__*/React.createElement("div", {
      className: "mono",
      style: {
        textAlign: "right",
        fontSize: 12,
        color: isDown ? "var(--err)" : "var(--fg)"
      }
    }, p.nvps.toLocaleString(), /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 9.5,
        color: "var(--muted)"
      }
    }, "/s")), /*#__PURE__*/React.createElement("div", {
      className: "mono",
      style: {
        textAlign: "right",
        fontSize: 12,
        color: p.queue > 100 ? "var(--err)" : p.queue > 10 ? "var(--warn)" : "var(--fg-2)"
      }
    }, p.queue), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
      className: "zbx-mini-bar"
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        width: p.cpu + "%",
        background: p.cpu > 60 ? "var(--warn)" : "var(--ok)"
      }
    })), /*#__PURE__*/React.createElement("div", {
      className: "zbx-mini-bar",
      style: {
        marginTop: 3
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        width: p.mem + "%",
        background: p.mem > 60 ? "var(--warn)" : "var(--info)"
      }
    }))), /*#__PURE__*/React.createElement("div", {
      style: {
        fontFamily: "var(--mono)",
        fontSize: 11,
        color: isDown ? "var(--err)" : "var(--fg-2)"
      }
    }, p.lastSeen), /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        gap: 4,
        justifyContent: "flex-end"
      }
    }, /*#__PURE__*/React.createElement("span", {
      className: "icon-btn",
      title: "Refresh"
    }, /*#__PURE__*/React.createElement(Icon, {
      name: "refresh",
      size: 12
    })), /*#__PURE__*/React.createElement("span", {
      className: "icon-btn",
      title: "More"
    }, /*#__PURE__*/React.createElement(Icon, {
      name: "more",
      size: 12
    }))));
  })), rows.some(p => p.notes) && /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "10px 14px",
      borderTop: "1px solid var(--line)",
      background: "rgba(245,179,0,0.04)"
    }
  }, rows.filter(p => p.notes).map(p => /*#__PURE__*/React.createElement("div", {
    key: p.id,
    style: {
      fontSize: 11,
      color: "var(--fg-2)",
      fontFamily: "var(--mono)",
      display: "flex",
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: p.status === "down" ? "var(--err)" : "var(--warn)",
      minWidth: 130
    }
  }, p.id), /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--muted)"
    }
  }, "\u21B3"), /*#__PURE__*/React.createElement("span", null, p.notes)))));
};

// ───────── Service events stream ─────────
const ServiceEvents = () => /*#__PURE__*/React.createElement("div", {
  className: "card"
}, /*#__PURE__*/React.createElement("div", {
  className: "card-h"
}, /*#__PURE__*/React.createElement("h3", null, "Recent Server & Proxy Events"), /*#__PURE__*/React.createElement(SourceBadge, {
  src: "zbx"
}), /*#__PURE__*/React.createElement("div", {
  className: "h-spacer"
}), /*#__PURE__*/React.createElement("a", {
  className: "h-link"
}, "Open full log ", /*#__PURE__*/React.createElement(Icon, {
  name: "external",
  size: 11
}))), /*#__PURE__*/React.createElement("div", {
  className: "events"
}, ZBX_EVENTS.map((e, i) => /*#__PURE__*/React.createElement("div", {
  className: "event",
  key: i,
  style: {
    gridTemplateColumns: "80px 60px 160px 1fr"
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
const TWEAK_DEFAULTS = {
  density: "balanced",
  showSourceBadges: true
};
const ZbxStatusApp = () => {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [, setTick] = useState(0);
  useEffect(() => {
    document.documentElement.classList.toggle("hide-src-badges", !t.showSourceBadges);
  }, [t.showSourceBadges]);

  // Re-render whenever zbx-status-bridge.jsx swaps in a fresh
  // tcs.zbx.status.data payload.
  useEffect(() => {
    const onData = () => setTick(n => n + 1);
    window.addEventListener("tcs:zbx-status-data", onData);
    return () => window.removeEventListener("tcs:zbx-status-data", onData);
  }, []);
  const refresh = () => {
    if (typeof window.tcsZbxStatusRefresh === "function") window.tcsZbxStatusRefresh();
  };
  return /*#__PURE__*/React.createElement("div", {
    className: "app",
    "data-density": t.density,
    "data-screen-label": "Zabbix Server Status"
  }, /*#__PURE__*/React.createElement(GlobalSidebar, {
    active: "zbx-status"
  }), /*#__PURE__*/React.createElement("div", {
    className: "main"
  }, /*#__PURE__*/React.createElement(GlobalTopbar, {
    crumb: ["Tuscaloosa City Schools", "Monitoring", "Zabbix · Server & Proxy Status"],
    onRefresh: refresh
  }), /*#__PURE__*/React.createElement(StatusHeader, null), /*#__PURE__*/React.createElement("div", {
    className: "body"
  }, /*#__PURE__*/React.createElement(LiveBanner, null), /*#__PURE__*/React.createElement(PerfKPIs, null), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gridTemplateColumns: "1fr 1fr",
      gap: 14,
      marginBottom: 14
    }
  }, ZBX_NODES.map(n => /*#__PURE__*/React.createElement(HANodeCard, {
    key: n.id,
    n: n
  }))), /*#__PURE__*/React.createElement("div", {
    className: "row",
    style: {
      gridTemplateColumns: "1.3fr 1fr",
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement(ProcessPanel, null), /*#__PURE__*/React.createElement(CachePanel, null)), /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement(PerfTimelines, null)), /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement(ProxiesTable, null)), /*#__PURE__*/React.createElement(ServiceEvents, null))), /*#__PURE__*/React.createElement(TweaksPanel, {
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
    title: "Refresh"
  }, /*#__PURE__*/React.createElement(TweakButton, {
    onClick: refresh
  }, "Refresh now"))));
};
ReactDOM.createRoot(document.getElementById("root")).render(/*#__PURE__*/React.createElement(ZbxStatusApp, null));