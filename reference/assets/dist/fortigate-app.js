// FortiGate Firewall Status — single-device deep dive for the TCS Central Office
// HA pair. Layout: header → KPI strip → throughput 24h → sessions → health
// rings → interfaces → IPsec / SSL-VPN → SD-WAN SLA → UTM → top threats /
// policies → events.

const {
  useState,
  useEffect
} = React;

// ───────── Live data bindings ─────────
// Data globals are populated by fortigate-bridge.jsx (from window.FG_BOOT on
// first paint, then refreshed by fetch to tcs.fortigate.data). These `let`s
// are live bindings — child components reference them by name and pick up
// reassignments when the bridge fires "tcs:fortigate-data". App listens for
// that event and bumps a render counter to force the tree to re-evaluate.
let FG_DEVICE = window.FG_DEVICE || {};
let FG_TOTALS = window.FG_TOTALS || {};
let FG_INTERFACES = window.FG_INTERFACES || [];
let FG_IPSEC = window.FG_IPSEC || [];
let FG_SSLVPN = window.FG_SSLVPN || [];
let FG_SDWAN = window.FG_SDWAN || {
  sla: [],
  latencyHistory: {},
  preferredLink: ""
};
let FG_UTM = window.FG_UTM || [];
let FG_TOP_THREATS = window.FG_TOP_THREATS || [];
let FG_TOP_POLICIES = window.FG_TOP_POLICIES || [];
let FG_SESSIONS_24H = window.FG_SESSIONS_24H || new Array(24).fill(0);
let FG_NEW_SESSIONS_24H = window.FG_NEW_SESSIONS_24H || new Array(24).fill(0);
let FG_THROUGHPUT_24H = window.FG_THROUGHPUT_24H || {
  ingress: new Array(24).fill(0),
  egress: new Array(24).fill(0)
};
let FG_EVENTS = window.FG_EVENTS || [];
window.addEventListener("tcs:fortigate-data", () => {
  FG_DEVICE = window.FG_DEVICE || FG_DEVICE;
  FG_TOTALS = window.FG_TOTALS || FG_TOTALS;
  FG_INTERFACES = window.FG_INTERFACES || FG_INTERFACES;
  FG_IPSEC = window.FG_IPSEC || FG_IPSEC;
  FG_SSLVPN = window.FG_SSLVPN || FG_SSLVPN;
  FG_SDWAN = window.FG_SDWAN || FG_SDWAN;
  FG_UTM = window.FG_UTM || FG_UTM;
  FG_TOP_THREATS = window.FG_TOP_THREATS || FG_TOP_THREATS;
  FG_TOP_POLICIES = window.FG_TOP_POLICIES || FG_TOP_POLICIES;
  FG_SESSIONS_24H = window.FG_SESSIONS_24H || FG_SESSIONS_24H;
  FG_NEW_SESSIONS_24H = window.FG_NEW_SESSIONS_24H || FG_NEW_SESSIONS_24H;
  FG_THROUGHPUT_24H = window.FG_THROUGHPUT_24H || FG_THROUGHPUT_24H;
  FG_EVENTS = window.FG_EVENTS || FG_EVENTS;
});

// Reuse XIQ's severity palette for cards.
const fgSev = {
  ok: {
    bg: "rgba(52,211,153,0.10)",
    bd: "rgba(52,211,153,0.35)",
    fg: "var(--ok)"
  },
  info: {
    bg: "rgba(95,168,211,0.10)",
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
    bg: "rgba(242,95,92,0.28)",
    bd: "var(--err)",
    fg: "#ffd0cf"
  }
};

// Format large numbers compactly: 184_213 → "184k", 1_244_812 → "1.24M".
const compact = n => {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return n.toLocaleString();
};

// ───────── Header ─────────
const FGHeader = ({
  now,
  timeRange,
  setTimeRange
}) => {
  const d = FG_DEVICE;
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
  }, /*#__PURE__*/React.createElement("h1", null, "FortiGate \xB7 ", d.host), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  }), /*#__PURE__*/React.createElement("span", {
    className: "role-tag voip",
    style: {
      fontSize: 10,
      padding: "1px 8px"
    }
  }, "EDGE \xB7 UTM"), /*#__PURE__*/React.createElement("span", {
    className: "ip"
  }, d.mgmtIp)), /*#__PURE__*/React.createElement("div", {
    className: "host-meta"
  }, /*#__PURE__*/React.createElement("span", {
    className: "pill"
  }, /*#__PURE__*/React.createElement("span", {
    className: "refresh-ring"
  }), " ", /*#__PURE__*/React.createElement("span", {
    className: "lbl"
  }, "SNMP poll"), " ", /*#__PURE__*/React.createElement("span", {
    className: "v"
  }, d.lastSync)), /*#__PURE__*/React.createElement("span", {
    className: "pill"
  }, /*#__PURE__*/React.createElement("span", {
    className: "lbl"
  }, "Model"), " ", /*#__PURE__*/React.createElement("span", {
    className: "v"
  }, d.model)), /*#__PURE__*/React.createElement("span", {
    className: "pill"
  }, /*#__PURE__*/React.createElement("span", {
    className: "lbl"
  }, "FortiOS"), " ", /*#__PURE__*/React.createElement("span", {
    className: "v"
  }, d.fos)), /*#__PURE__*/React.createElement("span", {
    className: "pill"
  }, /*#__PURE__*/React.createElement("span", {
    className: "lbl"
  }, "HA"), " ", /*#__PURE__*/React.createElement("span", {
    className: "v"
  }, d.ha)), /*#__PURE__*/React.createElement("span", {
    className: "pill"
  }, /*#__PURE__*/React.createElement("span", {
    className: "lbl"
  }, "Uptime"), " ", /*#__PURE__*/React.createElement("span", {
    className: "v"
  }, d.uptime)), /*#__PURE__*/React.createElement("span", {
    className: "pill"
  }, /*#__PURE__*/React.createElement("span", {
    className: "dot",
    style: {
      background: "var(--ok)"
    }
  }), " Cluster healthy"), /*#__PURE__*/React.createElement("span", {
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

// ───────── KPI strip (6 cells) ─────────
const FGKPIStrip = () => {
  const t = FG_TOTALS;
  const sessLimit = t.sessions.limit || 0;
  const sessPct = sessLimit > 0 ? t.sessions.active / sessLimit * 100 : 0;
  return /*#__PURE__*/React.createElement("div", {
    className: "card",
    style: {
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "fg-kpi"
  }, /*#__PURE__*/React.createElement("div", {
    className: "fg-kpi-cell"
  }, /*#__PURE__*/React.createElement("div", {
    className: "fg-kpi-h"
  }, /*#__PURE__*/React.createElement("span", {
    className: "fg-kpi-lbl"
  }, "Active Sessions"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  })), /*#__PURE__*/React.createElement("div", {
    className: "fg-kpi-v"
  }, compact(t.sessions.active)), /*#__PURE__*/React.createElement("div", {
    className: "fg-kpi-bar"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: `${Math.min(100, sessPct)}%`,
      background: "var(--ok)"
    }
  })), /*#__PURE__*/React.createElement("div", {
    className: "fg-kpi-foot"
  }, sessLimit > 0 ? `${sessPct.toFixed(2)}% of ${(sessLimit / 1e6).toFixed(0)}M cap` : "cap unknown", " \xB7 peak ", compact(t.sessions.peak))), /*#__PURE__*/React.createElement("div", {
    className: "fg-kpi-cell"
  }, /*#__PURE__*/React.createElement("div", {
    className: "fg-kpi-h"
  }, /*#__PURE__*/React.createElement("span", {
    className: "fg-kpi-lbl"
  }, "New / sec"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  })), /*#__PURE__*/React.createElement("div", {
    className: "fg-kpi-v"
  }, t.sessions.new_per_s.toLocaleString()), /*#__PURE__*/React.createElement("div", {
    className: "fg-kpi-foot"
  }, "conntrack rate \xB7 24h avg 2,840 / s")), /*#__PURE__*/React.createElement("div", {
    className: "fg-kpi-cell ext"
  }, /*#__PURE__*/React.createElement("div", {
    className: "fg-kpi-h"
  }, /*#__PURE__*/React.createElement("span", {
    className: "fg-kpi-lbl"
  }, "Throughput"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  })), /*#__PURE__*/React.createElement("div", {
    className: "fg-kpi-v"
  }, t.throughput.total_gbps.toFixed(2), /*#__PURE__*/React.createElement("span", {
    className: "u"
  }, "Gbps")), /*#__PURE__*/React.createElement("div", {
    className: "fg-kpi-foot"
  }, "\u2193 ", t.throughput.wan_in_gbps.toFixed(2), " \xB7 \u2191 ", t.throughput.wan_out_gbps.toFixed(2), " \xB7 peak ", t.throughput.peak_gbps.toFixed(1))), /*#__PURE__*/React.createElement("div", {
    className: "fg-kpi-cell warn"
  }, /*#__PURE__*/React.createElement("div", {
    className: "fg-kpi-h"
  }, /*#__PURE__*/React.createElement("span", {
    className: "fg-kpi-lbl"
  }, "CPU \xB7 15m peak"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  })), /*#__PURE__*/React.createElement("div", {
    className: "fg-kpi-v"
  }, t.cpu.peak15m, /*#__PURE__*/React.createElement("span", {
    className: "u"
  }, "%")), /*#__PURE__*/React.createElement("div", {
    className: "fg-kpi-bar"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: `${t.cpu.peak15m}%`,
      background: t.cpu.peak15m > t.cpu.target ? "var(--warn)" : "var(--ok)"
    }
  })), /*#__PURE__*/React.createElement("div", {
    className: "fg-kpi-foot"
  }, "now ", t.cpu.now, "% \xB7 alert \u2265 ", t.cpu.target, "%")), /*#__PURE__*/React.createElement("div", {
    className: "fg-kpi-cell err"
  }, /*#__PURE__*/React.createElement("div", {
    className: "fg-kpi-h"
  }, /*#__PURE__*/React.createElement("span", {
    className: "fg-kpi-lbl"
  }, "Threats Blocked \xB7 24h"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  })), /*#__PURE__*/React.createElement("div", {
    className: "fg-kpi-v"
  }, compact(t.threats.ips_blocks_24h + t.threats.av_blocks_24h + t.threats.web_blocks_24h + t.threats.app_blocks_24h)), /*#__PURE__*/React.createElement("div", {
    className: "fg-kpi-foot"
  }, "IPS ", compact(t.threats.ips_blocks_24h), " \xB7 WF ", compact(t.threats.web_blocks_24h), " \xB7 AV ", t.threats.av_blocks_24h)), /*#__PURE__*/React.createElement("div", {
    className: "fg-kpi-cell ok"
  }, /*#__PURE__*/React.createElement("div", {
    className: "fg-kpi-h"
  }, /*#__PURE__*/React.createElement("span", {
    className: "fg-kpi-lbl"
  }, "VPN Status"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  }), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "pf"
  })), /*#__PURE__*/React.createElement("div", {
    className: "fg-kpi-v"
  }, t.vpn.ipsec_up, /*#__PURE__*/React.createElement("span", {
    className: "u"
  }, "/ ", t.vpn.ipsec_total, " IPsec")), /*#__PURE__*/React.createElement("div", {
    className: "fg-kpi-foot"
  }, t.vpn.ssl_users, " SSL-VPN users \xB7 peak 24h ", t.vpn.ssl_peak_24h))));
};

// ───────── Throughput 24h chart (SVG dual-area) ─────────
const FGThroughputChart = () => {
  const {
    ingress,
    egress
  } = FG_THROUGHPUT_24H;
  const max = (Math.max(...ingress, ...egress) || 1) * 1.15;
  const W = 100,
    H = 100; // viewBox %
  const stepX = W / (ingress.length - 1);
  const toPath = (data, fillBottom = true) => {
    const pts = data.map((v, i) => [i * stepX, H - v / max * H]);
    const line = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(" ");
    return fillBottom ? `${line} L${W},${H} L0,${H} Z` : line;
  };
  const gridLines = [0.25, 0.5, 0.75];
  return /*#__PURE__*/React.createElement("div", {
    className: "card",
    style: {
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "WAN Throughput \xB7 24h"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("span", {
    className: "h-meta"
  }, "peak ", FG_TOTALS.throughput.peak_gbps.toFixed(1), " Gbps \xB7 sampled 5m")), /*#__PURE__*/React.createElement("div", {
    className: "tput2-row"
  }, /*#__PURE__*/React.createElement("div", {
    className: "tput2-chart"
  }, /*#__PURE__*/React.createElement("svg", {
    className: "tput2-svg",
    viewBox: `0 0 ${W} ${H}`,
    preserveAspectRatio: "none"
  }, /*#__PURE__*/React.createElement("g", {
    className: "tput2-grid"
  }, gridLines.map((g, i) => /*#__PURE__*/React.createElement("line", {
    key: i,
    x1: "0",
    x2: W,
    y1: H * g,
    y2: H * g
  }))), /*#__PURE__*/React.createElement("path", {
    d: toPath(ingress, true),
    fill: "rgba(95,168,211,0.18)"
  }), /*#__PURE__*/React.createElement("path", {
    d: toPath(ingress, false),
    stroke: "var(--info)",
    strokeWidth: "0.6",
    fill: "none",
    vectorEffect: "non-scaling-stroke"
  }), /*#__PURE__*/React.createElement("path", {
    d: toPath(egress, true),
    fill: "rgba(124,92,255,0.20)"
  }), /*#__PURE__*/React.createElement("path", {
    d: toPath(egress, false),
    stroke: "var(--ext)",
    strokeWidth: "0.6",
    fill: "none",
    vectorEffect: "non-scaling-stroke"
  }))), /*#__PURE__*/React.createElement("div", {
    className: "tput2-side"
  }, /*#__PURE__*/React.createElement("div", {
    className: "tput2-stat"
  }, /*#__PURE__*/React.createElement("div", {
    className: "tput2-stat-lbl"
  }, /*#__PURE__*/React.createElement("span", {
    className: "dot",
    style: {
      background: "var(--info)"
    }
  }), " Ingress (RX)"), /*#__PURE__*/React.createElement("div", {
    className: "tput2-stat-v"
  }, FG_TOTALS.throughput.wan_in_gbps.toFixed(2), /*#__PURE__*/React.createElement("span", {
    className: "u"
  }, "Gbps"))), /*#__PURE__*/React.createElement("div", {
    className: "tput2-stat"
  }, /*#__PURE__*/React.createElement("div", {
    className: "tput2-stat-lbl"
  }, /*#__PURE__*/React.createElement("span", {
    className: "dot",
    style: {
      background: "var(--ext)"
    }
  }), " Egress (TX)"), /*#__PURE__*/React.createElement("div", {
    className: "tput2-stat-v"
  }, FG_TOTALS.throughput.wan_out_gbps.toFixed(2), /*#__PURE__*/React.createElement("span", {
    className: "u"
  }, "Gbps"))), /*#__PURE__*/React.createElement("div", {
    className: "tput2-stat"
  }, /*#__PURE__*/React.createElement("div", {
    className: "tput2-stat-lbl"
  }, "LAN total"), /*#__PURE__*/React.createElement("div", {
    className: "tput2-stat-v"
  }, FG_TOTALS.throughput.lan_gbps.toFixed(2), /*#__PURE__*/React.createElement("span", {
    className: "u"
  }, "Gbps"))))));
};

// ───────── Session sparks (3 stacked rows: active, new/s, inspected) ─────────
const FGSessions = () => /*#__PURE__*/React.createElement("div", {
  className: "card"
}, /*#__PURE__*/React.createElement("div", {
  className: "card-h"
}, /*#__PURE__*/React.createElement("h3", null, "Session Activity \xB7 24h"), /*#__PURE__*/React.createElement(SourceBadge, {
  src: "zbx"
}), /*#__PURE__*/React.createElement("div", {
  className: "h-spacer"
}), /*#__PURE__*/React.createElement("span", {
  className: "h-meta"
}, "conntrack \xB7 5m bins")), /*#__PURE__*/React.createElement("div", {
  className: "sess-grid"
}, /*#__PURE__*/React.createElement("div", {
  className: "sess-row"
}, /*#__PURE__*/React.createElement("div", {
  className: "sess-lbl"
}, "Concurrent"), /*#__PURE__*/React.createElement(Sparkline, {
  data: FG_SESSIONS_24H,
  color: "var(--ok)",
  width: 400,
  height: 38,
  fill: true
}), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
  className: "sess-val"
}, compact(FG_TOTALS.sessions.active)), /*#__PURE__*/React.createElement("div", {
  className: "sess-sub"
}, "peak ", compact(FG_TOTALS.sessions.peak)))), /*#__PURE__*/React.createElement("div", {
  className: "sess-row"
}, /*#__PURE__*/React.createElement("div", {
  className: "sess-lbl"
}, "New / sec"), /*#__PURE__*/React.createElement(Sparkline, {
  data: FG_NEW_SESSIONS_24H,
  color: "var(--ext)",
  width: 400,
  height: 38,
  fill: true
}), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
  className: "sess-val"
}, FG_TOTALS.sessions.new_per_s.toLocaleString(), /*#__PURE__*/React.createElement("span", {
  className: "u"
}, "/s")), /*#__PURE__*/React.createElement("div", {
  className: "sess-sub"
}, "peak 4,640 / s"))), /*#__PURE__*/React.createElement("div", {
  className: "sess-row"
}, /*#__PURE__*/React.createElement("div", {
  className: "sess-lbl"
}, "UTM inspected"), /*#__PURE__*/React.createElement(Sparkline, {
  data: FG_NEW_SESSIONS_24H.map(v => v * 0.84),
  color: "var(--zbx)",
  width: 400,
  height: 38,
  fill: true
}), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
  className: "sess-val"
}, "3,467", /*#__PURE__*/React.createElement("span", {
  className: "u"
}, "/s")), /*#__PURE__*/React.createElement("div", {
  className: "sess-sub"
}, "SSL: 62% deep-inspect")))));

// ───────── Health rings strip (CPU, Mem, Disk, Sessions) ─────────
const FGHealthStrip = () => {
  const t = FG_TOTALS;
  const sessLimit = t.sessions.limit || 0;
  const sessUtilPct = sessLimit > 0 ? t.sessions.active / sessLimit * 100 : 0;
  const items = [{
    v: t.cpu.now,
    lbl: "CPU",
    sub: `peak 15m ${t.cpu.peak15m}%`,
    threshold: t.cpu.target,
    color: t.cpu.now > t.cpu.target ? "var(--err)" : t.cpu.now > 50 ? "var(--warn)" : "var(--ok)"
  }, {
    v: t.mem.now,
    lbl: "Memory",
    sub: `peak 15m ${t.mem.peak15m}%`,
    threshold: t.mem.target,
    color: t.mem.now > t.mem.target ? "var(--err)" : "var(--info)"
  }, {
    v: t.disk.now,
    lbl: "Disk · /var/log",
    sub: "log rotation OK",
    threshold: t.disk.target,
    color: t.disk.now > t.disk.target ? "var(--warn)" : "var(--ok)"
  }, {
    v: sessUtilPct,
    lbl: "Session cap",
    sub: sessLimit > 0 ? `${compact(t.sessions.active)} / ${(sessLimit / 1e6).toFixed(0)}M` : compact(t.sessions.active),
    color: "var(--ext)"
  }];
  return /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "Device Health"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("span", {
    className: "h-meta"
  }, "primary node \xB7 60s window")), /*#__PURE__*/React.createElement("div", {
    className: "fg-health-strip"
  }, items.map((it, i) => /*#__PURE__*/React.createElement("div", {
    className: "fg-health-cell",
    key: i
  }, /*#__PURE__*/React.createElement(Ring, {
    value: it.v,
    size: 64,
    color: it.color,
    label: `${it.v.toFixed(it.v < 10 ? 1 : 0)}%`
  }), /*#__PURE__*/React.createElement("div", {
    className: "fg-health-meta"
  }, /*#__PURE__*/React.createElement("div", {
    className: "lbl"
  }, it.lbl), /*#__PURE__*/React.createElement("div", {
    className: "sub"
  }, it.sub))))));
};

// ───────── Interfaces table ─────────
const FGInterfaces = () => /*#__PURE__*/React.createElement("div", {
  className: "card"
}, /*#__PURE__*/React.createElement("div", {
  className: "card-h"
}, /*#__PURE__*/React.createElement("h3", null, "Interfaces \xB7 Physical & Virtual"), /*#__PURE__*/React.createElement(SourceBadge, {
  src: "zbx"
}), /*#__PURE__*/React.createElement("div", {
  className: "h-spacer"
}), /*#__PURE__*/React.createElement("span", {
  className: "h-meta"
}, FG_INTERFACES.filter(i => i.up).length, " of ", FG_INTERFACES.length, " up")), /*#__PURE__*/React.createElement("div", {
  className: "card-b tight",
  style: {
    maxHeight: 380,
    overflow: "auto"
  }
}, /*#__PURE__*/React.createElement("table", {
  className: "tbl if-tbl"
}, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", null, "Interface"), /*#__PURE__*/React.createElement("th", null, "Role"), /*#__PURE__*/React.createElement("th", {
  style: {
    width: 60
  }
}, "Speed"), /*#__PURE__*/React.createElement("th", {
  style: {
    width: 64,
    textAlign: "right"
  }
}, "VLANs"), /*#__PURE__*/React.createElement("th", {
  style: {
    width: 70,
    textAlign: "right"
  }
}, "RX Mbps"), /*#__PURE__*/React.createElement("th", {
  style: {
    width: 70,
    textAlign: "right"
  }
}, "TX Mbps"), /*#__PURE__*/React.createElement("th", {
  style: {
    width: 140
  }
}, "Util"), /*#__PURE__*/React.createElement("th", {
  style: {
    width: 64
  }
}, "State"))), /*#__PURE__*/React.createElement("tbody", null, FG_INTERFACES.map(i => {
  const rxPct = Math.min(60, i.rx_mbps / (parseInt(i.speed) * 1000) * 100);
  const txPct = Math.min(60, i.tx_mbps / (parseInt(i.speed) * 1000) * 100);
  return /*#__PURE__*/React.createElement("tr", {
    key: i.id
  }, /*#__PURE__*/React.createElement("td", {
    className: "fg"
  }, i.id), /*#__PURE__*/React.createElement("td", null, i.role), /*#__PURE__*/React.createElement("td", null, i.speed), /*#__PURE__*/React.createElement("td", {
    style: {
      textAlign: "right"
    }
  }, i.vlans || "—"), /*#__PURE__*/React.createElement("td", {
    style: {
      textAlign: "right"
    },
    className: "fg"
  }, i.rx_mbps.toLocaleString()), /*#__PURE__*/React.createElement("td", {
    style: {
      textAlign: "right"
    },
    className: "fg"
  }, i.tx_mbps.toLocaleString()), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("div", {
    className: "if-traffic-bar"
  }, /*#__PURE__*/React.createElement("div", {
    className: "rx",
    style: {
      width: `${rxPct}%`
    }
  }), /*#__PURE__*/React.createElement("div", {
    className: "tx",
    style: {
      width: `${txPct}%`
    }
  }))), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("span", {
    className: "if-state " + (i.up ? "up" : "down")
  }, /*#__PURE__*/React.createElement("span", {
    className: "dot"
  }), i.up ? "UP" : "DOWN")));
})))));

// ───────── IPsec tunnel list ─────────
const FGIPsec = () => /*#__PURE__*/React.createElement("div", {
  className: "card"
}, /*#__PURE__*/React.createElement("div", {
  className: "card-h"
}, /*#__PURE__*/React.createElement("h3", null, "IPsec Site-to-Site Tunnels"), /*#__PURE__*/React.createElement(SourceBadge, {
  src: "zbx"
}), /*#__PURE__*/React.createElement("div", {
  className: "h-spacer"
}), /*#__PURE__*/React.createElement("span", {
  className: "h-meta"
}, FG_IPSEC.filter(t => t.state === "up").length, " / ", FG_IPSEC.length, " up")), /*#__PURE__*/React.createElement("div", {
  className: "ipsec-head"
}, /*#__PURE__*/React.createElement("span", null, "Tunnel \xB7 Peer"), /*#__PURE__*/React.createElement("span", {
  style: {
    textAlign: "right"
  }
}, "RX MB"), /*#__PURE__*/React.createElement("span", {
  style: {
    textAlign: "right"
  }
}, "TX MB"), /*#__PURE__*/React.createElement("span", {
  style: {
    textAlign: "right"
  }
}, "Latency"), /*#__PURE__*/React.createElement("span", null)), FG_IPSEC.map(t => {
  const latCls = t.latency > 20 ? "warn" : t.state === "down" ? "err" : "ok";
  return /*#__PURE__*/React.createElement("div", {
    className: "ipsec-row",
    key: t.id
  }, /*#__PURE__*/React.createElement("div", {
    className: "ipsec-id"
  }, /*#__PURE__*/React.createElement("span", null, t.id), /*#__PURE__*/React.createElement("span", {
    className: "peer"
  }, "peer ", t.peer, " \xB7 ", t.phase2, " ph2 \xB7 since ", t.since)), /*#__PURE__*/React.createElement("div", {
    className: "v"
  }, t.state === "down" ? "—" : t.rxMb.toLocaleString()), /*#__PURE__*/React.createElement("div", {
    className: "v"
  }, t.state === "down" ? "—" : t.txMb.toLocaleString()), /*#__PURE__*/React.createElement("div", {
    className: "lat " + latCls
  }, t.state === "down" ? "DOWN" : `${t.latency.toFixed(1)} ms`), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("span", {
    className: "ipsec-state-dot " + t.state
  })));
}));

// ───────── SSL-VPN sessions ─────────
const FGSSLVPN = () => /*#__PURE__*/React.createElement("div", {
  className: "card"
}, /*#__PURE__*/React.createElement("div", {
  className: "card-h"
}, /*#__PURE__*/React.createElement("h3", null, "SSL-VPN \xB7 Connected Users"), /*#__PURE__*/React.createElement(SourceBadge, {
  src: "zbx"
}), /*#__PURE__*/React.createElement(SourceBadge, {
  src: "pf"
}), /*#__PURE__*/React.createElement("div", {
  className: "h-spacer"
}), /*#__PURE__*/React.createElement("span", {
  className: "h-meta"
}, FG_SSLVPN.length, " active \xB7 peak 24h ", FG_TOTALS.vpn.ssl_peak_24h)), /*#__PURE__*/React.createElement("div", {
  className: "sslvpn-head"
}, /*#__PURE__*/React.createElement("span", null, "User"), /*#__PURE__*/React.createElement("span", null, "Role"), /*#__PURE__*/React.createElement("span", null, "Src \u2192 Dst"), /*#__PURE__*/React.createElement("span", {
  style: {
    textAlign: "right"
  }
}, "Dur"), /*#__PURE__*/React.createElement("span", {
  style: {
    textAlign: "right"
  }
}, "RX MB"), /*#__PURE__*/React.createElement("span", {
  style: {
    textAlign: "center"
  }
}, "MFA")), FG_SSLVPN.map(u => /*#__PURE__*/React.createElement("div", {
  className: "sslvpn-row",
  key: u.user
}, /*#__PURE__*/React.createElement("div", {
  className: "sslvpn-user"
}, u.user), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("span", {
  className: "role-tag " + (u.role === "vendor" ? "guest" : u.role === "admin" ? "av" : "faculty"),
  style: {
    fontSize: 9.5,
    padding: "0 6px"
  }
}, u.role)), /*#__PURE__*/React.createElement("div", {
  className: "ip"
}, u.src, " \u2192 ", u.dst), /*#__PURE__*/React.createElement("div", {
  className: "dur"
}, u.dur), /*#__PURE__*/React.createElement("div", {
  className: "mb"
}, u.rxMb), /*#__PURE__*/React.createElement("div", {
  style: {
    textAlign: "center"
  }
}, /*#__PURE__*/React.createElement("span", {
  className: "mfa-pill " + (u.mfa ? "yes" : "no")
}, u.mfa ? "MFA" : "NO")))));

// ───────── SD-WAN SLA ─────────
const FGSDWan = () => {
  const w = FG_SDWAN;
  return /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "SD-WAN \xB7 SLA per Link"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("span", {
    className: "h-meta"
  }, w.rules, " rules \xB7 preferred ", w.preferredLink)), w.sla.map(l => {
    const isPreferred = l.link.startsWith(w.preferredLink);
    const latColor = l.latency > 30 ? "var(--err)" : l.latency > 15 ? "var(--warn)" : "var(--ok)";
    const lossCls = l.loss > 0.5 ? "err" : l.loss > 0.1 ? "warn" : "";
    const key = l.link.split(" ")[0]; // wan1 / wan2 / wan3
    return /*#__PURE__*/React.createElement("div", {
      className: "sdwan-row" + (isPreferred ? " preferred" : ""),
      key: l.link
    }, /*#__PURE__*/React.createElement("div", {
      className: "sdwan-h"
    }, /*#__PURE__*/React.createElement("span", {
      className: "sdwan-link-name"
    }, l.link), /*#__PURE__*/React.createElement("span", {
      className: "sdwan-weight"
    }, "weight ", l.weight)), /*#__PURE__*/React.createElement("div", {
      className: "sdwan-metrics"
    }, /*#__PURE__*/React.createElement("div", {
      className: "sdwan-metric"
    }, /*#__PURE__*/React.createElement("div", {
      className: "lbl"
    }, "Latency"), /*#__PURE__*/React.createElement("div", {
      className: "v",
      style: {
        color: latColor
      }
    }, l.latency.toFixed(1), " ", /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 10,
        color: "var(--muted)"
      }
    }, "ms"))), /*#__PURE__*/React.createElement("div", {
      className: "sdwan-metric"
    }, /*#__PURE__*/React.createElement("div", {
      className: "lbl"
    }, "Jitter"), /*#__PURE__*/React.createElement("div", {
      className: "v"
    }, l.jitter.toFixed(1), " ", /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 10,
        color: "var(--muted)"
      }
    }, "ms"))), /*#__PURE__*/React.createElement("div", {
      className: "sdwan-metric"
    }, /*#__PURE__*/React.createElement("div", {
      className: "lbl"
    }, "Loss"), /*#__PURE__*/React.createElement("div", {
      className: "v " + lossCls
    }, l.loss.toFixed(2), " ", /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 10,
        color: "var(--muted)"
      }
    }, "%"))), /*#__PURE__*/React.createElement(Sparkline, {
      data: w.latencyHistory[key],
      color: latColor,
      width: 100,
      height: 32,
      fill: true
    })));
  }));
};

// ───────── UTM module activity (3×2 grid) ─────────
const FGUtmGrid = () => /*#__PURE__*/React.createElement("div", {
  className: "card"
}, /*#__PURE__*/React.createElement("div", {
  className: "card-h"
}, /*#__PURE__*/React.createElement("h3", null, "UTM \xB7 Threat Protection \xB7 24h"), /*#__PURE__*/React.createElement(SourceBadge, {
  src: "zbx"
}), /*#__PURE__*/React.createElement("div", {
  className: "h-spacer"
}), /*#__PURE__*/React.createElement("span", {
  className: "h-meta"
}, "FortiGuard subscriptions active")), /*#__PURE__*/React.createElement("div", {
  className: "utm-grid"
}, FG_UTM.map(u => /*#__PURE__*/React.createElement("div", {
  className: "utm-cell",
  key: u.id
}, /*#__PURE__*/React.createElement("div", {
  className: "utm-h"
}, /*#__PURE__*/React.createElement("span", {
  className: "utm-dot",
  style: {
    background: u.color
  }
}), /*#__PURE__*/React.createElement("span", {
  className: "utm-lbl"
}, u.label)), /*#__PURE__*/React.createElement("div", {
  className: "utm-v",
  style: {
    color: u.color
  }
}, u.blocks.toLocaleString()), /*#__PURE__*/React.createElement("div", {
  className: "utm-foot"
}, /*#__PURE__*/React.createElement("span", null, u.unique, " unique"), u.severity_hi > 0 && /*#__PURE__*/React.createElement("span", {
  style: {
    color: "var(--err)"
  }
}, "\xB7 ", u.severity_hi, " high"))))), /*#__PURE__*/React.createElement("div", {
  className: "fg-fguard"
}, /*#__PURE__*/React.createElement("div", {
  className: "fguard-cell"
}, /*#__PURE__*/React.createElement("span", {
  className: "dot"
}), /*#__PURE__*/React.createElement("span", {
  className: "lbl"
}, "IPS DB"), " ", /*#__PURE__*/React.createElement("span", {
  className: "v"
}, "v25.1924")), /*#__PURE__*/React.createElement("div", {
  className: "fguard-cell"
}, /*#__PURE__*/React.createElement("span", {
  className: "dot"
}), /*#__PURE__*/React.createElement("span", {
  className: "lbl"
}, "AV DB"), "  ", /*#__PURE__*/React.createElement("span", {
  className: "v"
}, "v92.0488")), /*#__PURE__*/React.createElement("div", {
  className: "fguard-cell"
}, /*#__PURE__*/React.createElement("span", {
  className: "dot"
}), /*#__PURE__*/React.createElement("span", {
  className: "lbl"
}, "WF DB"), "  ", /*#__PURE__*/React.createElement("span", {
  className: "v"
}, "v8.084")), /*#__PURE__*/React.createElement("div", {
  className: "fguard-cell"
}, /*#__PURE__*/React.createElement("span", {
  className: "dot"
}), /*#__PURE__*/React.createElement("span", {
  className: "lbl"
}, "App ctrl"), " ", /*#__PURE__*/React.createElement("span", {
  className: "v"
}, "v25.092")), /*#__PURE__*/React.createElement("div", {
  className: "fguard-cell"
}, /*#__PURE__*/React.createElement("span", {
  className: "dot"
}), /*#__PURE__*/React.createElement("span", {
  className: "lbl"
}, "FortiGuard"), " ", /*#__PURE__*/React.createElement("span", {
  className: "v"
}, FG_TOTALS.fortiguard.expiresDays, "d left"))));

// ───────── Top threats list ─────────
const FGTopThreats = () => /*#__PURE__*/React.createElement("div", {
  className: "card"
}, /*#__PURE__*/React.createElement("div", {
  className: "card-h"
}, /*#__PURE__*/React.createElement("h3", null, "Top Threat Signatures \xB7 24h"), /*#__PURE__*/React.createElement(SourceBadge, {
  src: "zbx"
}), /*#__PURE__*/React.createElement("div", {
  className: "h-spacer"
}), /*#__PURE__*/React.createElement("a", {
  className: "h-link"
}, "Open in FortiAnalyzer ", /*#__PURE__*/React.createElement(Icon, {
  name: "external",
  size: 11
}))), FG_TOP_THREATS.map((t, i) => /*#__PURE__*/React.createElement("div", {
  className: "thr-row",
  key: i
}, /*#__PURE__*/React.createElement("div", {
  className: "thr-main"
}, /*#__PURE__*/React.createElement("span", {
  className: "thr-sig"
}, t.sig), /*#__PURE__*/React.createElement("span", {
  className: "thr-meta"
}, /*#__PURE__*/React.createElement("span", {
  className: "thr-cat"
}, t.cat), /*#__PURE__*/React.createElement(Sev, {
  level: t.sev
}), /*#__PURE__*/React.createElement("span", null, "src ", t.src))), /*#__PURE__*/React.createElement("div", {
  className: "thr-cnt"
}, t.count.toLocaleString()), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("span", {
  className: "thr-cc"
}, t.dstCC)), /*#__PURE__*/React.createElement("div", null, t.sev === "disaster" || t.sev === "high" ? /*#__PURE__*/React.createElement("span", {
  className: "dot pulse-dot",
  style: {
    background: "var(--err)"
  }
}) : /*#__PURE__*/React.createElement(Icon, {
  name: "chevron",
  size: 12
})))));

// ───────── Top policies ─────────
const FGTopPolicies = () => {
  const max = FG_TOP_POLICIES.length ? Math.max(...FG_TOP_POLICIES.map(p => p.hits24h)) : 1;
  return /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "Top Policies by Hit Count \xB7 24h"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("span", {
    className: "h-meta"
  }, FG_TOTALS.policies.total, " total \xB7 ", FG_TOTALS.policies.unused_30d, " unused 30d")), /*#__PURE__*/React.createElement("div", {
    className: "card-b tight",
    style: {
      maxHeight: 380,
      overflow: "auto"
    }
  }, /*#__PURE__*/React.createElement("table", {
    className: "tbl pol-tbl"
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", {
    style: {
      width: 36
    }
  }, "ID"), /*#__PURE__*/React.createElement("th", null, "Policy"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 110
    }
  }, "From \u2192 To"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 60
    }
  }, "Action"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 130,
      textAlign: "right"
    }
  }, "Hits / 24h"))), /*#__PURE__*/React.createElement("tbody", null, FG_TOP_POLICIES.map(p => {
    const pct = p.hits24h / max * 100;
    return /*#__PURE__*/React.createElement("tr", {
      key: p.id
    }, /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("span", {
      className: "pol-id"
    }, p.id)), /*#__PURE__*/React.createElement("td", {
      className: "fg",
      style: {
        whiteSpace: "nowrap"
      }
    }, p.name), /*#__PURE__*/React.createElement("td", {
      style: {
        fontSize: 10.5,
        color: "var(--muted)"
      }
    }, p.from, /*#__PURE__*/React.createElement("br", null), "\u2192 ", p.to), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("span", {
      className: "pol-action " + p.action
    }, p.action)), /*#__PURE__*/React.createElement("td", {
      style: {
        textAlign: "right"
      }
    }, /*#__PURE__*/React.createElement("div", {
      className: "pol-hits"
    }, compact(p.hits24h)), /*#__PURE__*/React.createElement("div", {
      className: "pol-hits-bar"
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        width: `${pct}%`
      }
    }))));
  })))));
};

// ───────── Events stream ─────────
const FGEvents = () => /*#__PURE__*/React.createElement("div", {
  className: "events"
}, FG_EVENTS.map((e, i) => /*#__PURE__*/React.createElement("div", {
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
  "showSDWAN": true,
  "view": "operations"
} /*EDITMODE-END*/;

// Banner shown when the bridge surfaces an error/warning (e.g. no FortiGate
// host templated yet). Mirrors XIQBanner.
const FGBanner = () => {
  const b = window.FG_BANNER;
  if (!b) return null;
  const fg = b.kind === "error" ? "var(--err)" : "var(--warn)";
  const bd = b.kind === "error" ? "rgba(242,95,92,0.45)" : "rgba(245,179,0,0.45)";
  const bg = b.kind === "error" ? "rgba(242,95,92,0.10)" : "rgba(245,179,0,0.10)";
  return /*#__PURE__*/React.createElement("div", {
    style: {
      margin: "0 14px 12px",
      padding: "10px 14px",
      borderRadius: 8,
      border: `1px solid ${bd}`,
      background: bg,
      color: fg,
      fontSize: 12.5
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
const App = () => {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [timeRange, setTimeRange] = useState("Last 1h");
  const [now, setNow] = useState("just now");
  const [, setTick] = useState(0);
  useEffect(() => {
    document.documentElement.classList.toggle("hide-src-badges", !t.showSourceBadges);
  }, [t.showSourceBadges]);

  // Re-render whenever fortigate-bridge.jsx swaps in a fresh
  // tcs.fortigate.data payload.
  useEffect(() => {
    const onData = () => {
      setNow(new Date().toLocaleTimeString());
      setTick(n => n + 1);
    };
    window.addEventListener("tcs:fortigate-data", onData);
    return () => window.removeEventListener("tcs:fortigate-data", onData);
  }, []);
  return /*#__PURE__*/React.createElement("div", {
    className: "app",
    "data-density": t.density,
    "data-screen-label": "FortiGate Firewall"
  }, /*#__PURE__*/React.createElement(GlobalSidebar, {
    active: "firewall"
  }), /*#__PURE__*/React.createElement("div", {
    className: "main"
  }, /*#__PURE__*/React.createElement(GlobalTopbar, {
    crumb: ["Tuscaloosa City Schools", "Edge / Security", "FortiGate · fw-tcs-co-01"],
    search: "Find policy, address object, signature, user\u2026"
  }), /*#__PURE__*/React.createElement(FGHeader, {
    now: now,
    timeRange: timeRange,
    setTimeRange: setTimeRange
  }), /*#__PURE__*/React.createElement(FGBanner, null), /*#__PURE__*/React.createElement("div", {
    className: "body"
  }, /*#__PURE__*/React.createElement(FGKPIStrip, null), /*#__PURE__*/React.createElement(FGThroughputChart, null), /*#__PURE__*/React.createElement("div", {
    className: "row",
    "data-fg-row": true,
    style: {
      gridTemplateColumns: "1fr",
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement(FGSessions, null)), /*#__PURE__*/React.createElement("div", {
    className: "row",
    "data-fg-row": true,
    style: {
      gridTemplateColumns: "1fr",
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement(FGHealthStrip, null)), /*#__PURE__*/React.createElement("div", {
    className: "row",
    "data-fg-row": true,
    style: {
      gridTemplateColumns: "1fr",
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement(FGInterfaces, null)), /*#__PURE__*/React.createElement("div", {
    className: "row",
    "data-fg-row": true,
    style: {
      gridTemplateColumns: "1.3fr 1fr",
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement(FGIPsec, null), /*#__PURE__*/React.createElement(FGSSLVPN, null)), t.showSDWAN && /*#__PURE__*/React.createElement("div", {
    className: "row",
    "data-fg-row": true,
    style: {
      gridTemplateColumns: "1fr 1fr",
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement(FGSDWan, null), /*#__PURE__*/React.createElement(FGUtmGrid, null)), /*#__PURE__*/React.createElement("div", {
    className: "row",
    "data-fg-row": true,
    style: {
      gridTemplateColumns: "1fr 1.2fr",
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement(FGTopThreats, null), /*#__PURE__*/React.createElement(FGTopPolicies, null)), /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "FortiGate \xB7 Recent Events"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  }), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "pf"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("a", {
    className: "h-link"
  }, "Open in event console ", /*#__PURE__*/React.createElement(Icon, {
    name: "external",
    size: 11
  }))), /*#__PURE__*/React.createElement("div", {
    className: "card-b tight"
  }, /*#__PURE__*/React.createElement(FGEvents, null))))), /*#__PURE__*/React.createElement(TweaksPanel, {
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
    label: "Show source badges (ZBX/PF)",
    value: t.showSourceBadges,
    onChange: v => setTweak("showSourceBadges", v)
  })), /*#__PURE__*/React.createElement(TweakSection, {
    label: "Sections"
  }, /*#__PURE__*/React.createElement(TweakToggle, {
    label: "SD-WAN + UTM",
    value: t.showSDWAN,
    onChange: v => setTweak("showSDWAN", v)
  })), /*#__PURE__*/React.createElement(TweakSection, {
    label: "Quick actions"
  }, /*#__PURE__*/React.createElement(TweakButton, {
    onClick: () => {
      setNow(new Date().toLocaleTimeString());
      if (window.tcsFortigateRefresh) window.tcsFortigateRefresh();
    },
    label: "Refresh now"
  }))));
};
ReactDOM.createRoot(document.getElementById("root")).render(/*#__PURE__*/React.createElement(App, null));