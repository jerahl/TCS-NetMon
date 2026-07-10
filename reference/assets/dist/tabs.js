// Per-tab views

const SectionTitle = ({
  children,
  src
}) => /*#__PURE__*/React.createElement("h2", {
  className: "section-title"
}, children, src && /*#__PURE__*/React.createElement(SourceBadge, {
  src: src
}));

// Helpers: per-AP SNMP uplink items are in bits/sec — convert to Mbps for
// display on the Live Telemetry strip. Null-safe.
const bpsToMbps = v => typeof v === "number" ? +(v / 1e6).toFixed(2) : v;
const histToMbps = h => Array.isArray(h) ? h.map(v => v / 1e6) : h;

// ───────── Overview tab ─────────
const OverviewTab = ({
  density
}) => {
  const A = window.ALERTS_SUMMARY || {};
  const I = window.ZBX_ITEMS || {};
  const host = window.ZBX_HOST || {};

  // Derive an "issue" tone from a count — anything > 0 is a warning unless
  // a separate severity hint is provided.
  const toneFor = (n, warnAt = 1, errAt = 5) => n >= errAt ? "err" : n >= warnAt ? "warn" : "ok";
  const iconFor = n => n > 0 ? "alert" : "check";
  const cpu = I.cpu || {};
  const memory = I.memory || {};
  const pktLoss = I.pktLoss || {};
  const totalClients = typeof A.totalClients === "number" && A.totalClients > 0 ? A.totalClients : host.clients ?? 0;

  // Packet-loss live value drives the big tile: <1% ok, <5% warn, else err.
  const lossPct = typeof pktLoss.value === "number" ? pktLoss.value : null;
  const lossEvents = typeof A.packetLoss === "number" ? A.packetLoss : 0;
  const lossTone = lossPct === null ? "muted" : lossPct >= 5 ? "err" : lossPct >= 1 ? "warn" : "ok";
  return /*#__PURE__*/React.createElement("div", {
    className: "overview"
  }, /*#__PURE__*/React.createElement("div", {
    className: "row",
    style: {
      gridTemplateColumns: "1.4fr 1fr .9fr",
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "Device Health"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("span", {
    className: "h-meta"
  }, "polling every 60s \xB7 template Extreme AP via SNMPv3")), /*#__PURE__*/React.createElement("div", {
    className: "health-grid",
    style: {
      gridTemplateColumns: "repeat(2, 1fr)"
    }
  }, /*#__PURE__*/React.createElement(HealthRing, {
    label: "CPU Usage",
    value: cpu.value,
    color: cpu.trigger != null && cpu.value > cpu.trigger ? "var(--warn)" : "var(--zbx)",
    sub: cpu.prev != null ? `prev ${cpu.prev}%` : "no history"
  }), /*#__PURE__*/React.createElement(HealthRing, {
    label: "Memory Usage",
    value: memory.value,
    color: "var(--info)",
    sub: memory.history && memory.history.length ? `peak ${Math.max(...memory.history).toFixed(0)}%` : "no history"
  }))), /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "Connectivity Issues"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  }), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "pf"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("span", {
    className: "h-meta"
  }, "Total Clients: ", /*#__PURE__*/React.createElement("b", {
    style: {
      color: "var(--fg)"
    }
  }, totalClients.toLocaleString()))), /*#__PURE__*/React.createElement("div", {
    className: "issues"
  }, /*#__PURE__*/React.createElement(Issue, {
    n: A.associationFailures ?? 0,
    label: "Association Failures",
    tone: toneFor(A.associationFailures ?? 0),
    icon: iconFor(A.associationFailures ?? 0)
  }), /*#__PURE__*/React.createElement(Issue, {
    n: A.authFailures ?? 0,
    label: "Authentication Failures",
    tone: toneFor(A.authFailures ?? 0),
    icon: iconFor(A.authFailures ?? 0)
  }), /*#__PURE__*/React.createElement(Issue, {
    n: A.networkIssues ?? 0,
    label: "Network Issues",
    tone: toneFor(A.networkIssues ?? 0),
    icon: iconFor(A.networkIssues ?? 0)
  }))), /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "Packet Loss"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("span", {
    className: "h-meta"
  }, "ICMP \xB7 last 5m")), /*#__PURE__*/React.createElement("div", {
    className: "issues",
    style: {
      gridTemplateColumns: "1fr"
    }
  }, /*#__PURE__*/React.createElement(Issue, {
    n: lossPct === null ? "—" : `${lossPct.toFixed(1)}%`,
    label: lossEvents > 0 ? `${lossEvents} loss event${lossEvents === 1 ? "" : "s"} (24h)` : "Loss rate (now)",
    tone: lossTone === "muted" ? "ok" : lossTone,
    icon: lossTone === "ok" || lossTone === "muted" ? "check" : "alert",
    big: true
  })))), /*#__PURE__*/React.createElement("div", {
    className: "row",
    style: {
      gridTemplateColumns: "1fr",
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "Live Telemetry"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("span", {
    className: "h-meta"
  }, "last 24h \xB7 ", (I.uplinkIn && I.uplinkIn.history || []).length, " samples"), /*#__PURE__*/React.createElement("span", {
    className: "h-link"
  }, "Open in Grafana ", /*#__PURE__*/React.createElement(Icon, {
    name: "external",
    size: 11
  }))), /*#__PURE__*/React.createElement("div", {
    className: "spark-strip"
  }, /*#__PURE__*/React.createElement(SparkCell, {
    label: "Uplink In",
    value: bpsToMbps((I.uplinkIn || {}).value),
    unit: "Mbps",
    data: histToMbps((I.uplinkIn || {}).history),
    color: "var(--zbx)"
  }), /*#__PURE__*/React.createElement(SparkCell, {
    label: "Uplink Out",
    value: bpsToMbps((I.uplinkOut || {}).value),
    unit: "Mbps",
    data: histToMbps((I.uplinkOut || {}).history),
    color: "var(--info)"
  }), /*#__PURE__*/React.createElement(SparkCell, {
    label: "Latency",
    value: (I.latency || {}).value,
    unit: "ms",
    data: (I.latency || {}).history,
    color: "var(--ok)"
  }), /*#__PURE__*/React.createElement(SparkCell, {
    label: "Pkt Loss",
    value: (I.pktLoss || {}).value,
    unit: "%",
    data: (I.pktLoss || {}).history,
    color: "var(--warn)"
  })), /*#__PURE__*/React.createElement("div", {
    className: "spark-strip",
    style: {
      borderTop: "1px solid var(--line)"
    }
  }, /*#__PURE__*/React.createElement(SparkCell, {
    label: "Noise 2.4 GHz",
    value: (I.noise24 || {}).value,
    unit: "dBm",
    data: (I.noise24 || {}).history,
    color: "var(--info)"
  }), /*#__PURE__*/React.createElement(SparkCell, {
    label: "Noise 5 GHz",
    value: (I.noise5 || {}).value,
    unit: "dBm",
    data: (I.noise5 || {}).history,
    color: "var(--info)"
  }), /*#__PURE__*/React.createElement(SparkCell, {
    label: "TX Power 2.4",
    value: (I.txpower24 || {}).value,
    unit: "dBm",
    data: (I.txpower24 || {}).history,
    color: "var(--pf)"
  }), /*#__PURE__*/React.createElement(SparkCell, {
    label: "TX Power 5",
    value: (I.txpower5 || {}).value,
    unit: "dBm",
    data: (I.txpower5 || {}).history,
    color: "var(--pf)"
  })))), /*#__PURE__*/React.createElement("div", {
    className: "row",
    style: {
      gridTemplateColumns: "1fr 1fr",
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "System Information"), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("span", {
    className: "h-meta"
  }, "merged from Zabbix host + ExtremeCloud IQ")), /*#__PURE__*/React.createElement("div", {
    className: "kv"
  }, window.SYSTEM_INFO.map(([k, v, src]) => /*#__PURE__*/React.createElement(React.Fragment, {
    key: k
  }, /*#__PURE__*/React.createElement("div", {
    className: "k"
  }, k), /*#__PURE__*/React.createElement("div", {
    className: "v"
  }, v), /*#__PURE__*/React.createElement("div", {
    className: "b"
  }, /*#__PURE__*/React.createElement(SourceBadge, {
    src: src
  })))))), /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "Network Information"), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("span", {
    className: "h-meta"
  }, window.ZBX_HOST && window.ZBX_HOST.ip ? `SNMPv3 · ${window.ZBX_HOST.ip}` : "SNMPv3")), /*#__PURE__*/React.createElement("div", {
    className: "kv"
  }, window.NETWORK_INFO.map(([k, v, src]) => /*#__PURE__*/React.createElement(React.Fragment, {
    key: k
  }, /*#__PURE__*/React.createElement("div", {
    className: "k"
  }, k), /*#__PURE__*/React.createElement("div", {
    className: "v"
  }, k === "Device Status" ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(StatusDot, {
    state: "ok"
  }), " ", v) : v), /*#__PURE__*/React.createElement("div", {
    className: "b"
  }, /*#__PURE__*/React.createElement(SourceBadge, {
    src: src
  }))))))), /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "Recent Events"), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("span", {
    className: "h-meta"
  }, "live merge: Zabbix triggers + PacketFence audit"), /*#__PURE__*/React.createElement("span", {
    className: "h-link"
  }, "Open events log ", /*#__PURE__*/React.createElement(Icon, {
    name: "external",
    size: 11
  }))), /*#__PURE__*/React.createElement("div", {
    className: "events"
  }, window.ZBX_EVENTS.slice(0, 6).map((e, i) => /*#__PURE__*/React.createElement("div", {
    className: "event",
    key: i
  }, /*#__PURE__*/React.createElement("div", {
    className: "ts"
  }, e.ts), /*#__PURE__*/React.createElement("div", {
    className: `src ${e.source === "Zabbix" ? "zbx" : "pf"}`
  }, e.source === "Zabbix" ? "ZBX" : "PF"), /*#__PURE__*/React.createElement(Sev, {
    level: e.severity
  }), /*#__PURE__*/React.createElement("div", {
    className: "msg"
  }, e.msg, " ", /*#__PURE__*/React.createElement("span", {
    className: "obj"
  }, "\xB7 ", e.obj)))))));
};
const HealthRing = ({
  label,
  value,
  color,
  sub,
  max = 100,
  unit = "%"
}) => {
  const missing = value === null || value === undefined || typeof value === "number" && Number.isNaN(value);
  const v = missing ? 0 : value;
  const display = missing ? "—" : `${typeof v === "number" ? Number.isInteger(v) ? v : v.toFixed(1) : v}${unit === "%" ? "%" : ""}`;
  return /*#__PURE__*/React.createElement("div", {
    className: "health-cell"
  }, /*#__PURE__*/React.createElement(Ring, {
    value: v,
    max: max,
    color: missing ? "var(--muted)" : color,
    label: display,
    sub: unit !== "%" && !missing ? unit : null
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-label"
  }, label), sub && /*#__PURE__*/React.createElement("div", {
    className: "h-sub",
    style: {
      fontSize: 10,
      color: "var(--muted)",
      marginTop: 2
    }
  }, sub));
};
const Issue = ({
  n,
  label,
  tone,
  icon,
  big
}) => /*#__PURE__*/React.createElement("div", {
  className: `issue ${tone}`
}, /*#__PURE__*/React.createElement("div", {
  className: "ico"
}, /*#__PURE__*/React.createElement(Icon, {
  name: icon,
  size: 16
})), /*#__PURE__*/React.createElement("div", {
  className: "num",
  style: big ? {
    fontSize: 22
  } : {}
}, n), /*#__PURE__*/React.createElement("div", {
  className: "lbl"
}, label));
const SparkCell = ({
  label,
  value,
  unit,
  data,
  color
}) => {
  const missing = value === null || value === undefined || typeof value === "number" && Number.isNaN(value);
  const display = missing ? "—" : typeof value === "number" ? Number.isInteger(value) ? value : value.toFixed(2) : value;
  const hist = Array.isArray(data) ? data : [];
  return /*#__PURE__*/React.createElement("div", {
    className: "spark-cell"
  }, /*#__PURE__*/React.createElement("div", {
    className: "lbl"
  }, label), /*#__PURE__*/React.createElement("div", {
    className: "val",
    style: missing ? {
      color: "var(--muted)"
    } : {}
  }, display, !missing && /*#__PURE__*/React.createElement("span", {
    className: "u"
  }, unit)), hist.length > 0 ? /*#__PURE__*/React.createElement(Sparkline, {
    data: hist,
    color: color,
    width: 240,
    height: 30
  }) : /*#__PURE__*/React.createElement("div", {
    style: {
      height: 30,
      display: "flex",
      alignItems: "center",
      color: "var(--muted)",
      fontSize: 10
    }
  }, "no history"));
};

// Derive radio band from current channel number. AP305C is dual-5 GHz on
// this fleet, so we can't assume wifi0=2.4 / wifi1=5 anymore.
const deriveBand = ch => {
  const n = typeof ch === "number" ? ch : Number(ch);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n >= 1 && n <= 14) return "2.4 GHz";
  if (n >= 36) return "5 GHz";
  return null;
};

// ───────── Wireless tab ─────────
const WirelessTab = () => {
  const I = window.ZBX_ITEMS || {};
  // Keep the existing channel24/channel5 keys (they refer to ifIndex 12 and
  // 13, i.e. wifi0 and wifi1) but display the band derived from the live
  // channel value rather than the variable name.
  return /*#__PURE__*/React.createElement("div", {
    className: "row",
    style: {
      gridTemplateColumns: "1fr 1fr",
      gap: 14
    }
  }, /*#__PURE__*/React.createElement(RadioCard, {
    radioName: "wifi0",
    channel: I.channel24,
    txpower: I.txpower24,
    noise: I.noise24,
    rxbytes: I.radioRx24,
    txbytes: I.radioTx24
  }), /*#__PURE__*/React.createElement(RadioCard, {
    radioName: "wifi1",
    channel: I.channel5,
    txpower: I.txpower5,
    noise: I.noise5,
    rxbytes: I.radioRx5,
    txbytes: I.radioTx5
  }), /*#__PURE__*/React.createElement("div", {
    className: "card",
    style: {
      gridColumn: "1 / -1"
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "SSIDs Broadcast"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("span", {
    className: "h-meta"
  }, Array.isArray(window.SSIDS) && window.SSIDS.length > 0 ? `${window.SSIDS.length} SSIDs · LLD via Extreme AP SNMPv2c` : "SSID LLD has not yet discovered any subinterfaces (runs hourly)")), Array.isArray(window.SSIDS) && window.SSIDS.length > 0 ? /*#__PURE__*/React.createElement("table", {
    className: "tbl"
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", null, "SSID"), /*#__PURE__*/React.createElement("th", null, "Subinterface"), /*#__PURE__*/React.createElement("th", null, "Band"), /*#__PURE__*/React.createElement("th", null, "VLAN"), /*#__PURE__*/React.createElement("th", null, "Auth"), /*#__PURE__*/React.createElement("th", {
    style: {
      textAlign: "right"
    }
  }, "RX"), /*#__PURE__*/React.createElement("th", {
    style: {
      textAlign: "right"
    }
  }, "TX"))), /*#__PURE__*/React.createElement("tbody", null, window.SSIDS.map(s => {
    const rx = s.rxMbps;
    const tx = s.txMbps;
    return /*#__PURE__*/React.createElement("tr", {
      key: s.id || s.name
    }, /*#__PURE__*/React.createElement("td", {
      className: "fg"
    }, s.name), /*#__PURE__*/React.createElement("td", {
      className: "mono",
      style: {
        color: "var(--muted)"
      }
    }, s.ifname || "—"), /*#__PURE__*/React.createElement("td", null, s.band || "—"), /*#__PURE__*/React.createElement("td", null, s.vlan ?? "—"), /*#__PURE__*/React.createElement("td", null, s.auth ?? "—"), /*#__PURE__*/React.createElement("td", {
      className: "mono",
      style: {
        textAlign: "right"
      }
    }, rx == null ? "—" : `${rx.toFixed(2)} Mbps`), /*#__PURE__*/React.createElement("td", {
      className: "mono",
      style: {
        textAlign: "right"
      }
    }, tx == null ? "—" : `${tx.toFixed(2)} Mbps`));
  }))) : /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 30,
      textAlign: "center",
      color: "var(--muted)",
      fontSize: 12
    }
  }, "No SSID inventory available for this AP.")));
};
const RadioCard = ({
  radioName,
  channel,
  txpower,
  noise,
  rxbytes,
  txbytes
}) => {
  const ch = channel || {};
  const tp = txpower || {};
  const n = noise || {};
  const rx = rxbytes || {};
  const tx = txbytes || {};
  const band = deriveBand(ch.value);
  // Bytes/sec → Mbps for display.
  const bytesToMbps = v => typeof v === "number" ? +(v * 8 / 1e6).toFixed(2) : v;
  return /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "Radio \xB7 ", radioName, band ? ` · ${band}` : ""), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("span", {
    className: "h-meta"
  }, "ch ", ch.value ?? "—", " \xB7 ", tp.value != null ? `${tp.value} dBm TX` : "TX —")), /*#__PURE__*/React.createElement("div", {
    className: "card-b",
    style: {
      display: "grid",
      gridTemplateColumns: "1fr 1fr",
      gap: 12
    }
  }, /*#__PURE__*/React.createElement(MiniMetric, {
    label: "Channel",
    v: ch.value,
    unit: "",
    color: "var(--pf)"
  }), /*#__PURE__*/React.createElement(MiniMetric, {
    label: "TX Power",
    v: tp.value,
    unit: "dBm",
    data: tp.history,
    color: "var(--pf)"
  }), /*#__PURE__*/React.createElement(MiniMetric, {
    label: "Noise Floor",
    v: n.value,
    unit: "dBm",
    data: n.history,
    color: "var(--info)"
  }), /*#__PURE__*/React.createElement(MiniMetric, {
    label: "RX Throughput",
    v: bytesToMbps(rx.value),
    unit: "Mbps",
    data: (rx.history || []).map(v => v * 8 / 1e6),
    color: "var(--ok)"
  }), /*#__PURE__*/React.createElement(MiniMetric, {
    label: "TX Throughput",
    v: bytesToMbps(tx.value),
    unit: "Mbps",
    data: (tx.history || []).map(v => v * 8 / 1e6),
    color: "var(--zbx)"
  })));
};
const MiniMetric = ({
  label,
  v,
  unit,
  data,
  color,
  threshold
}) => {
  const missing = v === null || v === undefined || v === "" || typeof v === "number" && Number.isNaN(v);
  const display = missing ? "—" : typeof v === "number" ? Number.isInteger(v) ? v.toString() : v.toFixed(1) : String(v);
  return /*#__PURE__*/React.createElement("div", {
    style: {
      background: "var(--bg-2)",
      borderRadius: 8,
      padding: 12,
      border: "1px solid var(--line)"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10,
      color: "var(--muted)",
      textTransform: "uppercase",
      letterSpacing: 0.5,
      marginBottom: 6
    }
  }, label), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "var(--mono)",
      fontSize: 20,
      fontWeight: 600,
      color: missing ? "var(--muted)" : "var(--fg)"
    }
  }, display, !missing && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 11,
      color: "var(--muted)",
      marginLeft: 3
    }
  }, unit)), data && data.length > 0 && /*#__PURE__*/React.createElement(Sparkline, {
    data: data,
    color: color,
    width: 240,
    height: 28,
    threshold: threshold
  }));
};

// ───────── Wired tab ─────────
const WiredTab = () => {
  const ports = Array.isArray(window.WIRED_PORTS) ? window.WIRED_PORTS : [];
  return /*#__PURE__*/React.createElement("div", {
    className: "row",
    style: {
      gridTemplateColumns: "1fr",
      gap: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "Wired Interfaces"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("span", {
    className: "h-meta"
  }, ports.length === 0 ? "no IF-MIB items for this host" : "SNMP IF-MIB · live")), ports.length === 0 ? /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 30,
      textAlign: "center",
      color: "var(--muted)",
      fontSize: 12
    }
  }, "No wired interface data available. Confirm the host has the Extreme AP SNMPv2c template linked.") : /*#__PURE__*/React.createElement("table", {
    className: "tbl"
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", null, "Port"), /*#__PURE__*/React.createElement("th", null, "State"), /*#__PURE__*/React.createElement("th", null, "Link Speed"), /*#__PURE__*/React.createElement("th", null, "In"), /*#__PURE__*/React.createElement("th", null, "Out"), /*#__PURE__*/React.createElement("th", null, "Errors"), /*#__PURE__*/React.createElement("th", null, "LLDP Neighbor"))), /*#__PURE__*/React.createElement("tbody", null, ports.map(p => /*#__PURE__*/React.createElement("tr", {
    key: p.name
  }, /*#__PURE__*/React.createElement("td", {
    className: "fg"
  }, p.name), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement(StatusDot, {
    state: p.state
  }), " ", /*#__PURE__*/React.createElement("span", {
    style: {
      textTransform: "uppercase"
    }
  }, p.state)), /*#__PURE__*/React.createElement("td", {
    className: "mono"
  }, p.speed || "—"), /*#__PURE__*/React.createElement("td", {
    className: "mono"
  }, p.in || "—"), /*#__PURE__*/React.createElement("td", {
    className: "mono"
  }, p.out || "—"), /*#__PURE__*/React.createElement("td", {
    className: "mono"
  }, p.err || "—"), /*#__PURE__*/React.createElement("td", null, p.neighbor || /*#__PURE__*/React.createElement("span", {
    className: "muted"
  }, "\u2014"))))))));
};

// ───────── Clients tab ─────────
// Source-agnostic: ActionDashboard prefers XIQ /clients/active (deviceIds
// = host macro {$XIQ_DEVICE_ID}) and falls back to PacketFence per-node.
// Each row carries .source so the badge reflects what actually populated it.
const ClientsTab = ({
  filter,
  setFilter
}) => {
  const all = Array.isArray(window.PF_CLIENTS) ? window.PF_CLIENTS : [];
  const authFails = Array.isArray(window.PF_AUTH_FAILS) ? window.PF_AUTH_FAILS : [];
  const [selectedMac, setSelectedMac] = React.useState(null);
  const source = all[0] && all[0].source === "xiq+pf" ? "xiq+pf" : all[0] && all[0].source === "xiq" ? "xiq" : all[0] && all[0].source === "pf" ? "pf" : "none";
  const filtered = all.filter(c => {
    const role = String(c.role ?? "");
    if (filter === "all") return true;
    if (filter === "issues") return c.posture !== "compliant" && c.posture !== "n/a";
    if (filter === "students") return role.includes("Student");
    if (filter === "faculty") return role === "Faculty";
    if (filter === "guests") return role.includes("Guest");
    return true;
  });
  const selected = selectedMac ? all.find(c => c.mac === selectedMac) : null;
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "card",
    style: {
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "Connected Clients"), (source === "xiq" || source === "xiq+pf") && /*#__PURE__*/React.createElement(SourceBadge, {
    src: "ext"
  }), (source === "pf" || source === "xiq+pf") && /*#__PURE__*/React.createElement(SourceBadge, {
    src: "pf"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("span", {
    className: "h-meta",
    style: {
      marginRight: 8
    }
  }, all.length, " associated", source === "xiq+pf" ? " · XIQ + PacketFence" : source === "xiq" ? " · XIQ /clients/active" : source === "pf" ? " · PacketFence" : ""), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 4
    }
  }, [["all", "All"], ["issues", "Issues"], ["students", "Students"], ["faculty", "Faculty"], ["guests", "Guests"]].map(([k, l]) => /*#__PURE__*/React.createElement("button", {
    key: k,
    className: `btn sm ${filter === k ? "primary" : "ghost"}`,
    onClick: () => setFilter(k)
  }, l)))), all.length === 0 ? /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 30,
      textAlign: "center",
      color: "var(--muted)",
      fontSize: 12
    }
  }, "No active clients reported for this AP.", /*#__PURE__*/React.createElement("br", null)) : /*#__PURE__*/React.createElement("table", {
    className: "tbl"
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", null, "Status"), /*#__PURE__*/React.createElement("th", null, "MAC / Hostname"), /*#__PURE__*/React.createElement("th", null, "User"), /*#__PURE__*/React.createElement("th", null, "Role"), /*#__PURE__*/React.createElement("th", null, "VLAN"), /*#__PURE__*/React.createElement("th", null, "SSID / Auth"), /*#__PURE__*/React.createElement("th", null, "RSSI"), /*#__PURE__*/React.createElement("th", null, "Band"), /*#__PURE__*/React.createElement("th", null, "OS"), /*#__PURE__*/React.createElement("th", null, "Connected"), /*#__PURE__*/React.createElement("th", null))), /*#__PURE__*/React.createElement("tbody", null, filtered.map(c => /*#__PURE__*/React.createElement(ClientRow, {
    key: c.mac || c.host,
    c: c,
    active: c.mac === selectedMac,
    onClick: () => setSelectedMac(c.mac === selectedMac ? null : c.mac)
  }))))), selected && /*#__PURE__*/React.createElement(ClientDetailCard, {
    c: selected,
    onClose: () => setSelectedMac(null)
  }), /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "Recent Authentication Failures"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "pf"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("span", {
    className: "h-meta"
  }, authFails.length === 0 ? "no failures or PacketFence not configured" : "RADIUS audit · last 24h")), authFails.length === 0 ? /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 24,
      textAlign: "center",
      color: "var(--muted)",
      fontSize: 12
    }
  }, "No authentication failures recorded.") : /*#__PURE__*/React.createElement("table", {
    className: "tbl"
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", null, "Time"), /*#__PURE__*/React.createElement("th", null, "Client MAC"), /*#__PURE__*/React.createElement("th", null, "SSID"), /*#__PURE__*/React.createElement("th", null, "Reason"), /*#__PURE__*/React.createElement("th", null, "Attempts"))), /*#__PURE__*/React.createElement("tbody", null, authFails.map((f, i) => /*#__PURE__*/React.createElement("tr", {
    key: i
  }, /*#__PURE__*/React.createElement("td", null, f.ts), /*#__PURE__*/React.createElement("td", {
    className: "fg"
  }, f.mac), /*#__PURE__*/React.createElement("td", null, f.ssid), /*#__PURE__*/React.createElement("td", {
    style: {
      color: "var(--warn)"
    }
  }, f.reason), /*#__PURE__*/React.createElement("td", null, f.attempts)))))));
};
const roleClassFor = role => {
  const r = String(role ?? "");
  if (r === "Faculty") return "faculty";
  if (r.startsWith("Student-9-12")) return "student";
  if (r === "Student-BYOD") return "byod";
  if (r.includes("Guest")) return "guest";
  if (r === "AV-Equipment") return "av";
  if (r === "Quarantine") return "quarantine";
  return "unknown";
};
const ClientRow = ({
  c,
  active,
  onClick
}) => {
  const role = String(c.role ?? "");
  const rssi = typeof c.rssi === "number" && c.rssi !== 0 ? c.rssi : null;
  const bars = rssi == null ? 0 : rssi >= -55 ? 4 : rssi >= -65 ? 3 : rssi >= -75 ? 2 : 1;
  return /*#__PURE__*/React.createElement("tr", {
    onClick: onClick,
    style: {
      cursor: "pointer",
      background: active ? "rgba(95,168,211,0.10)" : undefined,
      boxShadow: active ? "inset 3px 0 0 var(--zbx)" : undefined
    }
  }, /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement(StatusDot, {
    state: c.posture || "n/a"
  })), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("div", {
    className: "fg"
  }, c.host || c.mac), /*#__PURE__*/React.createElement("div", {
    style: {
      color: "var(--muted)",
      fontSize: 10.5
    }
  }, c.mac)), /*#__PURE__*/React.createElement("td", null, c.user || "—"), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("span", {
    className: `role-tag ${roleClassFor(role)}`
  }, role || "—")), /*#__PURE__*/React.createElement("td", null, c.vlan || "—"), /*#__PURE__*/React.createElement("td", null, c.ssid || "—", /*#__PURE__*/React.createElement("div", {
    style: {
      color: "var(--muted)",
      fontSize: 10.5
    }
  }, c.auth || "")), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "rssi-bar"
  }, [1, 2, 3, 4].map(n => /*#__PURE__*/React.createElement("i", {
    key: n,
    className: n <= bars ? "on" : ""
  }))), rssi == null ? "—" : `${rssi} dBm`)), /*#__PURE__*/React.createElement("td", null, c.band || "—"), /*#__PURE__*/React.createElement("td", null, c.os || "—"), /*#__PURE__*/React.createElement("td", null, c.since || "—"), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement(Icon, {
    name: active ? "chevron" : "more",
    size: 14
  })));
};

// Detail card surfaced when a client row is selected. Mirrors the
// switch tab's PacketFenceDevicePane shape so the two screens feel
// consistent: identity strip, KV grid of PF + XIQ fields, then the
// locationlog row at the bottom.
const ClientDetailCard = ({
  c,
  onClose
}) => {
  const pf = c.pf || {};
  const loc = c.pfLoc || {};
  const reg = (pf.reg || (c.posture === "compliant" ? "REG" : c.posture === "non-compliant" ? "UNREG" : "")).toUpperCase();
  const role = String(c.role ?? "");
  const sourceLabel = c.source === "xiq+pf" ? "XIQ + PacketFence" : c.source === "xiq" ? "XIQ only" : c.source === "pf" ? "PacketFence only" : "—";
  return /*#__PURE__*/React.createElement("div", {
    className: "card",
    style: {
      marginTop: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "Client Detail"), (c.source === "xiq" || c.source === "xiq+pf") && /*#__PURE__*/React.createElement(SourceBadge, {
    src: "ext"
  }), (c.source === "pf" || c.source === "xiq+pf") && /*#__PURE__*/React.createElement(SourceBadge, {
    src: "pf"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("span", {
    className: "h-meta",
    style: {
      marginRight: 8
    }
  }, sourceLabel), /*#__PURE__*/React.createElement("button", {
    className: "btn sm ghost",
    onClick: onClose
  }, "Close")), /*#__PURE__*/React.createElement("div", {
    className: "card-b"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 12,
      marginBottom: 12,
      flexWrap: "wrap"
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "mono",
    style: {
      fontSize: 14,
      fontWeight: 600
    }
  }, c.mac), reg && /*#__PURE__*/React.createElement("span", {
    className: "reg-badge " + (reg === "REG" ? "reg" : "unreg"),
    style: {
      fontSize: 10,
      padding: "1px 8px",
      border: "1px solid",
      borderRadius: 3
    }
  }, reg), /*#__PURE__*/React.createElement("span", {
    className: `role-tag ${roleClassFor(role)}`
  }, role || "—"), /*#__PURE__*/React.createElement(StatusDot, {
    state: c.posture || "n/a"
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 11,
      color: "var(--muted)"
    }
  }, c.posture || "n/a")), /*#__PURE__*/React.createElement("div", {
    className: "kv",
    style: {
      gridTemplateColumns: "120px 1fr 120px 1fr",
      rowGap: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "k"
  }, "Hostname"), "     ", /*#__PURE__*/React.createElement("div", {
    className: "v"
  }, c.host || pf.host || "—"), /*#__PURE__*/React.createElement("div", {
    className: "k"
  }, "IP address"), "   ", /*#__PURE__*/React.createElement("div", {
    className: "v mono"
  }, pf.ip || "—"), /*#__PURE__*/React.createElement("div", {
    className: "k"
  }, "User"), "         ", /*#__PURE__*/React.createElement("div", {
    className: "v"
  }, c.user || "—"), /*#__PURE__*/React.createElement("div", {
    className: "k"
  }, "Owner (PF pid)"), /*#__PURE__*/React.createElement("div", {
    className: "v"
  }, pf.owner || "—"), /*#__PURE__*/React.createElement("div", {
    className: "k"
  }, "SSID"), "         ", /*#__PURE__*/React.createElement("div", {
    className: "v"
  }, c.ssid || "—"), /*#__PURE__*/React.createElement("div", {
    className: "k"
  }, "VLAN"), "         ", /*#__PURE__*/React.createElement("div", {
    className: "v mono"
  }, c.vlan || loc.vlan || "—"), /*#__PURE__*/React.createElement("div", {
    className: "k"
  }, "Protocol"), "     ", /*#__PURE__*/React.createElement("div", {
    className: "v mono"
  }, c.auth || "—"), /*#__PURE__*/React.createElement("div", {
    className: "k"
  }, "Band"), "         ", /*#__PURE__*/React.createElement("div", {
    className: "v mono"
  }, c.band || "—"), /*#__PURE__*/React.createElement("div", {
    className: "k"
  }, "RSSI"), "         ", /*#__PURE__*/React.createElement("div", {
    className: "v mono"
  }, typeof c.rssi === "number" && c.rssi !== 0 ? `${c.rssi} dBm` : "—"), /*#__PURE__*/React.createElement("div", {
    className: "k"
  }, "Connected"), "    ", /*#__PURE__*/React.createElement("div", {
    className: "v mono"
  }, c.since || "—"), /*#__PURE__*/React.createElement("div", {
    className: "k"
  }, "OS"), "           ", /*#__PURE__*/React.createElement("div", {
    className: "v"
  }, c.os || pf.os || "—"), /*#__PURE__*/React.createElement("div", {
    className: "k"
  }, "Vendor"), "       ", /*#__PURE__*/React.createElement("div", {
    className: "v"
  }, pf.vendor || "—"), /*#__PURE__*/React.createElement("div", {
    className: "k"
  }, "DHCP fingerprint"), /*#__PURE__*/React.createElement("div", {
    className: "v",
    style: {
      fontSize: 11
    }
  }, pf.dhcpFp || "—"), /*#__PURE__*/React.createElement("div", {
    className: "k"
  }, "Last seen"), "    ", /*#__PURE__*/React.createElement("div", {
    className: "v mono"
  }, pf.lastSeen || "—"), /*#__PURE__*/React.createElement("div", {
    className: "k"
  }, "Last ARP"), "     ", /*#__PURE__*/React.createElement("div", {
    className: "v mono"
  }, pf.lastArp || "—"), /*#__PURE__*/React.createElement("div", {
    className: "k"
  }, "Last DHCP"), "    ", /*#__PURE__*/React.createElement("div", {
    className: "v mono"
  }, pf.lastDhcp || "—")), (loc.switch || loc.port || loc.connection_type || loc.dot1x_username) && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 14,
      paddingTop: 12,
      borderTop: "1px solid var(--line)"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10,
      textTransform: "uppercase",
      letterSpacing: 0.6,
      color: "var(--muted)",
      marginBottom: 8
    }
  }, "PacketFence locationlog (latest)"), /*#__PURE__*/React.createElement("div", {
    className: "kv",
    style: {
      gridTemplateColumns: "120px 1fr 120px 1fr",
      rowGap: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "k"
  }, "Switch / AP"), "      ", /*#__PURE__*/React.createElement("div", {
    className: "v mono"
  }, loc.switch || "—", " ", loc.switch_ip && /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--muted)"
    }
  }, "\xB7 ", loc.switch_ip)), /*#__PURE__*/React.createElement("div", {
    className: "k"
  }, "Port / ifDesc"), "    ", /*#__PURE__*/React.createElement("div", {
    className: "v mono"
  }, loc.port || loc.ifDesc || "—"), /*#__PURE__*/React.createElement("div", {
    className: "k"
  }, "Connection"), "       ", /*#__PURE__*/React.createElement("div", {
    className: "v"
  }, loc.connection_type || "—", loc.connection_sub_type ? ` · ${loc.connection_sub_type}` : ""), /*#__PURE__*/React.createElement("div", {
    className: "k"
  }, "802.1X user"), "      ", /*#__PURE__*/React.createElement("div", {
    className: "v"
  }, loc.dot1x_username || "—", loc.realm ? `@${loc.realm}` : ""), /*#__PURE__*/React.createElement("div", {
    className: "k"
  }, "Session start"), "    ", /*#__PURE__*/React.createElement("div", {
    className: "v mono"
  }, loc.start_time || "—"), /*#__PURE__*/React.createElement("div", {
    className: "k"
  }, "Session end"), "      ", /*#__PURE__*/React.createElement("div", {
    className: "v mono"
  }, loc.end_time || "—"))), /*#__PURE__*/React.createElement(ClientPfActionRow, {
    mac: c.mac,
    hasPf: !!c.pf
  })));
};

// Per-client PF write-actions — "View in PacketFence" + "Reevaluate
// access". Mirrors switches-widgets' PfActionRow but skipped the
// switchport-restart button since it doesn't apply to wireless.
const ClientPfActionRow = ({
  mac,
  hasPf
}) => {
  const [busy, setBusy] = React.useState(null);
  const [msg, setMsg] = React.useState({
    kind: "",
    text: ""
  });
  // PF stores and matches MACs in lowercase — both the admin UI route
  // and the API endpoints normalise to lowercase, but several PF versions
  // 404 on uppercase MAC paths instead of redirecting. Lower-case here
  // and at every call site to keep behaviour consistent across versions.
  const pfMac = String(mac || "").toLowerCase();
  const adminBase = (window.PF_ADMIN_BASE || "").replace(/\/+$/, "");
  const viewHref = adminBase && pfMac ? `${adminBase}/admin/#/node/${encodeURIComponent(pfMac)}` : null;
  const run = React.useCallback(async (op, label) => {
    if (!pfMac || busy) return;
    if (typeof window.tcsPfDeviceAction !== "function") {
      setMsg({
        kind: "err",
        text: "endpoint missing"
      });
      return;
    }
    setBusy(op);
    setMsg({
      kind: "",
      text: `${label}…`
    });
    const r = await window.tcsPfDeviceAction(pfMac, op);
    setBusy(null);
    setMsg(r && r.ok ? {
      kind: "",
      text: r.message || "ok"
    } : {
      kind: "err",
      text: r && (r.error || r.message) || "failed"
    });
    setTimeout(() => setMsg({
      kind: "",
      text: ""
    }), 6000);
  }, [pfMac, busy]);
  return /*#__PURE__*/React.createElement("div", {
    className: "pf-actions",
    style: {
      marginTop: 14,
      paddingTop: 12,
      borderTop: "1px solid var(--line)"
    }
  }, viewHref ? /*#__PURE__*/React.createElement("a", {
    className: "pf-btn",
    href: viewHref,
    target: "_blank",
    rel: "noopener noreferrer"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "external",
    size: 11
  }), " View in PacketFence") : /*#__PURE__*/React.createElement("span", {
    className: "pf-btn",
    style: {
      opacity: 0.4,
      cursor: "not-allowed"
    },
    title: "Set global macro {$PF.ADMIN_URL} to enable"
  }, "View in PacketFence"), /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: "pf-btn",
    onClick: () => run("reevaluate_access", "reevaluating"),
    disabled: !!busy || !hasPf,
    title: hasPf ? "Re-run PF role / access evaluation for this client (issues a CoA)" : "Client not registered in PacketFence"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "refresh",
    size: 11
  }), " ", busy === "reevaluate_access" ? "REEVALUATING…" : "Reevaluate access"), msg.text && /*#__PURE__*/React.createElement("span", {
    className: "pf-msg" + (msg.kind === "err" ? " err" : "")
  }, msg.text));
};

// ───────── Events tab ─────────
const EventsTab = () => {
  const all = Array.isArray(window.ZBX_EVENTS) ? window.ZBX_EVENTS : [];
  const [filter, setFilter] = React.useState("all");
  const [src, setSrc] = React.useState("all");
  const filtered = all.filter(e => {
    if (filter === "problems" && e.value !== 1) return false;
    if (filter === "resolved" && e.value !== 0) return false;
    if (filter === "unacked" && (e.value !== 1 || e.acked)) return false;
    if (src === "zbx" && e.source !== "Zabbix") return false;
    if (src === "xiq" && e.source !== "XIQ") return false;
    if (src === "pf" && e.source !== "PF") return false;
    return true;
  });
  const counts = {
    problems: all.filter(e => e.value === 1).length,
    resolved: all.filter(e => e.value === 0).length,
    unacked: all.filter(e => e.value === 1 && !e.acked).length
  };
  return /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "All Events"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  }), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "ext"
  }), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "pf"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("span", {
    className: "h-meta",
    style: {
      marginRight: 12
    }
  }, all.length, " total \xB7 ", counts.problems, " open \xB7 ", counts.unacked, " unacked"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 4
    }
  }, [["all", `All ${all.length}`], ["problems", `Open ${counts.problems}`], ["unacked", `Unacked ${counts.unacked}`], ["resolved", `Resolved ${counts.resolved}`]].map(([k, l]) => /*#__PURE__*/React.createElement("button", {
    key: k,
    className: `btn sm ${filter === k ? "primary" : "ghost"}`,
    onClick: () => setFilter(k)
  }, l)), /*#__PURE__*/React.createElement("span", {
    style: {
      width: 8
    }
  }), [["all", "All"], ["zbx", "ZBX"], ["xiq", "XIQ"], ["pf", "PF"]].map(([k, l]) => /*#__PURE__*/React.createElement("button", {
    key: k,
    className: `btn sm ${src === k ? "primary" : "ghost"}`,
    onClick: () => setSrc(k)
  }, l)))), filtered.length === 0 ? /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 30,
      textAlign: "center",
      color: "var(--muted)",
      fontSize: 12
    }
  }, all.length === 0 ? "No events recorded for this host." : "No events match the current filters.") : /*#__PURE__*/React.createElement("div", {
    className: "events"
  }, filtered.map(e => /*#__PURE__*/React.createElement("div", {
    className: "event",
    key: e.eventid
  }, /*#__PURE__*/React.createElement("div", {
    className: "ts",
    title: `${e.date} ${e.ts}`
  }, e.today ? e.ts : /*#__PURE__*/React.createElement(React.Fragment, null, e.date, /*#__PURE__*/React.createElement("br", null), /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--muted)",
      fontSize: 10
    }
  }, e.ts))), /*#__PURE__*/React.createElement("div", {
    className: `src ${e.source === "Zabbix" ? "zbx" : e.source === "XIQ" ? "ext" : "pf"}`
  }, e.source === "Zabbix" ? "ZBX" : e.source === "XIQ" ? "XIQ" : "PF"), /*#__PURE__*/React.createElement(Sev, {
    level: e.severity
  }), /*#__PURE__*/React.createElement("div", {
    className: "msg"
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: e.value === 0 ? "var(--ok)" : "var(--fg)"
    }
  }, e.msg), e.obj && /*#__PURE__*/React.createElement("span", {
    className: "obj"
  }, " \xB7 ", e.obj), e.value === 0 && /*#__PURE__*/React.createElement("span", {
    className: "role-tag faculty",
    style: {
      marginLeft: 8,
      fontSize: 9,
      padding: "0 6px"
    }
  }, "RESOLVED"), e.value === 1 && e.acked && /*#__PURE__*/React.createElement("span", {
    className: "role-tag av",
    style: {
      marginLeft: 8,
      fontSize: 9,
      padding: "0 6px"
    }
  }, "ACKED"), e.value === 1 && !e.acked && /*#__PURE__*/React.createElement("span", {
    className: "role-tag guest",
    style: {
      marginLeft: 8,
      fontSize: 9,
      padding: "0 6px"
    }
  }, "OPEN"))))));
};

// ───────── Alerts tab ─────────
const AlertsTab = () => {
  const A = window.ALERTS_DETAIL || {
    activeTriggers: [],
    triggerCount: 0,
    last24h: {
      count: 0,
      bySeverity: {}
    },
    lastFiredAgo: null
  };
  const active = Array.isArray(A.activeTriggers) ? A.activeTriggers : [];
  const sev = A.last24h && A.last24h.bySeverity ? A.last24h.bySeverity : {};
  const totalLast24h = A.last24h && A.last24h.count || 0;
  const maxBar = Math.max(1, sev.disaster || 0, sev.high || 0, sev.warning || 0, sev.info || 0);
  return /*#__PURE__*/React.createElement("div", {
    className: "row",
    style: {
      gridTemplateColumns: "1.4fr 1fr",
      gap: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "Active Triggers"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("span", {
    className: "h-meta"
  }, active.length === 0 ? `0 firing · ${A.triggerCount} monitored${A.lastFiredAgo ? ` · last fired ${A.lastFiredAgo} ago` : ""}` : `${active.length} firing · ${A.triggerCount} monitored`)), active.length === 0 ? /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 30,
      textAlign: "center",
      color: "var(--muted)"
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "check",
    size: 32
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 8,
      fontSize: 14,
      color: "var(--ok)"
    }
  }, "No active Zabbix triggers"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      marginTop: 4
    }
  }, A.triggerCount > 0 ? `${A.triggerCount} triggers monitored` : "No triggers linked to this host", A.lastFiredAgo ? ` · last fired ${A.lastFiredAgo} ago` : "")) : /*#__PURE__*/React.createElement("table", {
    className: "tbl"
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", {
    style: {
      width: 90
    }
  }, "Severity"), /*#__PURE__*/React.createElement("th", null, "Trigger"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 90
    }
  }, "Age"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 80,
      textAlign: "right"
    }
  }, "State"))), /*#__PURE__*/React.createElement("tbody", null, active.map(t => /*#__PURE__*/React.createElement("tr", {
    key: t.id
  }, /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement(Sev, {
    level: t.severity
  })), /*#__PURE__*/React.createElement("td", {
    className: "fg"
  }, t.name, t.scope && /*#__PURE__*/React.createElement("div", {
    style: {
      color: "var(--muted)",
      fontSize: 10.5
    }
  }, "scope \xB7 ", t.scope)), /*#__PURE__*/React.createElement("td", {
    className: "mono"
  }, t.age), /*#__PURE__*/React.createElement("td", {
    style: {
      textAlign: "right"
    }
  }, t.ack ? /*#__PURE__*/React.createElement("span", {
    className: "role-tag av",
    style: {
      fontSize: 9,
      padding: "0 6px"
    }
  }, "ACKED") : /*#__PURE__*/React.createElement("span", {
    className: "role-tag guest",
    style: {
      fontSize: 9,
      padding: "0 6px"
    }
  }, "OPEN"))))))), /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "24h Alert Volume"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("span", {
    className: "h-meta"
  }, totalLast24h, " problem events")), /*#__PURE__*/React.createElement("div", {
    className: "card-b",
    style: {
      display: "flex",
      flexDirection: "column",
      gap: 10
    }
  }, [["disaster", "Disaster", "var(--err)"], ["high", "High", "var(--err)"], ["warning", "Warning", "var(--warn)"], ["info", "Info", "var(--info)"]].map(([k, label, color]) => {
    const n = sev[k] || 0;
    return /*#__PURE__*/React.createElement("div", {
      key: k,
      style: {
        display: "grid",
        gridTemplateColumns: "80px 1fr 40px",
        alignItems: "center",
        gap: 10
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        alignItems: "center",
        gap: 6,
        fontSize: 11
      }
    }, /*#__PURE__*/React.createElement(Sev, {
      level: k
    }), /*#__PURE__*/React.createElement("span", null, label)), /*#__PURE__*/React.createElement("div", {
      style: {
        background: "var(--bg-2)",
        border: "1px solid var(--line)",
        borderRadius: 4,
        height: 10,
        overflow: "hidden"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        width: `${n / maxBar * 100}%`,
        height: "100%",
        background: color
      }
    })), /*#__PURE__*/React.createElement("div", {
      className: "mono",
      style: {
        textAlign: "right",
        fontSize: 12,
        color: n > 0 ? "var(--fg)" : "var(--muted)"
      }
    }, n));
  }), totalLast24h === 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      color: "var(--muted)",
      fontSize: 11,
      textAlign: "center",
      paddingTop: 6
    }
  }, "No problem events recorded for this host in the last 24 hours."))));
};
window.OverviewTab = OverviewTab;
window.WirelessTab = WirelessTab;
window.WiredTab = WiredTab;
window.ClientsTab = ClientsTab;
window.EventsTab = EventsTab;
window.AlertsTab = AlertsTab;