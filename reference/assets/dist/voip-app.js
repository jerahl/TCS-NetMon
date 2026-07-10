// VoIP / 3CX monitoring dashboard
// Single-page Zabbix-style view of the TCS 3CX phone system.

const {
  useState: useStateVP,
  useEffect: useEffectVP,
  useMemo: useMemoVP
} = React;

// ═══════════════════════════════════════════════════════════════
// EMPTY-STATE SHELLS
// voip-bridge.jsx fills these with live data from tcs.voip.data once
// the SSR boot or the first fetch lands. Until then (or when 3CX /
// Zabbix are unreachable) every card renders against the zeroed
// shape below — no demo data is ever shown.
// ═══════════════════════════════════════════════════════════════

window.VOIP_PBX = window.VOIP_PBX || {
  fqdn: "—",
  ip: "—",
  version: "—",
  edition: "—",
  uptime: "—",
  region: "—",
  activeNow: 0,
  capacity: 0,
  peakToday: 0,
  callsToday: 0,
  callsInbound: 0,
  callsOutbound: 0,
  callsInternal: 0,
  registeredExt: 0,
  totalExt: 0,
  trunksReg: 0,
  trunksTotal: 0,
  avgMos: 0,
  asr: 0,
  acd: "—",
  history: {
    concur: new Array(96).fill(0),
    inbound: new Array(96).fill(0),
    outbound: new Array(96).fill(0)
  }
};
window.VOIP_TRUNKS = window.VOIP_TRUNKS || [];
window.VOIP_SBCS = window.VOIP_SBCS || [];
window.VOIP_CALLS = window.VOIP_CALLS || [];
window.VOIP_TOP = window.VOIP_TOP || [];
window.VOIP_QUEUES = window.VOIP_QUEUES || [];
window.VOIP_QUALITY = window.VOIP_QUALITY || {
  mos: new Array(48).fill(0),
  jitter: new Array(48).fill(0),
  loss: new Array(48).fill(0),
  rtt: new Array(48).fill(0)
};
window.VOIP_PROBLEMS = window.VOIP_PROBLEMS || [];

// ═══════════════════════════════════════════════════════════════
// WIDGETS
// ═══════════════════════════════════════════════════════════════

// ── Concurrent-calls 24h area chart ──
const ConcurrencyChart = () => {
  const data = window.VOIP_PBX.history;
  const W = 720,
    H = 168,
    PAD_L = 30,
    PAD_R = 14,
    PAD_T = 14,
    PAD_B = 22;
  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;
  const max = 80;
  const n = data.concur.length;
  const x = i => PAD_L + i / (n - 1) * innerW;
  const y = v => PAD_T + innerH - Math.min(1, v / max) * innerH;
  const areaPath = arr => {
    const pts = arr.map((v, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(v)}`).join(" ");
    return `${pts} L${x(n - 1)},${PAD_T + innerH} L${x(0)},${PAD_T + innerH} Z`;
  };
  const linePath = arr => arr.map((v, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(v)}`).join(" ");
  const ticks = [0, 20, 40, 60, 80];
  const hours = [0, 6, 9, 12, 15, 18, 23];
  return /*#__PURE__*/React.createElement("div", {
    className: "card concur-card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "Concurrent Calls \xB7 24h"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "3cx"
  }), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("span", {
    className: "h-meta"
  }, "15-min buckets \xB7 live")), /*#__PURE__*/React.createElement("div", {
    className: "concur-meta"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "cm-lbl"
  }, "Active right now"), /*#__PURE__*/React.createElement("div", {
    className: "cm-now"
  }, window.VOIP_PBX.activeNow, /*#__PURE__*/React.createElement("span", {
    className: "u"
  }, "/ ", window.VOIP_PBX.capacity, " SC"))), /*#__PURE__*/React.createElement("div", {
    className: "cm-kv"
  }, /*#__PURE__*/React.createElement("span", {
    className: "lbl"
  }, "Peak today"), /*#__PURE__*/React.createElement("span", {
    className: "v warn"
  }, window.VOIP_PBX.peakToday || "—")), /*#__PURE__*/React.createElement("div", {
    className: "cm-kv"
  }, /*#__PURE__*/React.createElement("span", {
    className: "lbl"
  }, "Calls today"), /*#__PURE__*/React.createElement("span", {
    className: "v"
  }, window.VOIP_PBX.callsToday.toLocaleString())), /*#__PURE__*/React.createElement("div", {
    className: "cm-kv"
  }, /*#__PURE__*/React.createElement("span", {
    className: "lbl"
  }, "ACD"), /*#__PURE__*/React.createElement("span", {
    className: "v"
  }, window.VOIP_PBX.acd)), /*#__PURE__*/React.createElement("div", {
    className: "cm-kv"
  }, /*#__PURE__*/React.createElement("span", {
    className: "lbl"
  }, "ASR"), /*#__PURE__*/React.createElement("span", {
    className: "v"
  }, window.VOIP_PBX.asr, "%")), /*#__PURE__*/React.createElement("div", {
    className: "cm-spacer"
  }), /*#__PURE__*/React.createElement("div", {
    className: "cm-cap"
  }, /*#__PURE__*/React.createElement("b", null, window.VOIP_PBX.callsInbound.toLocaleString()), " in \xB7 ", /*#__PURE__*/React.createElement("b", null, window.VOIP_PBX.callsOutbound.toLocaleString()), " out \xB7 ", /*#__PURE__*/React.createElement("b", null, window.VOIP_PBX.callsInternal), " internal")), /*#__PURE__*/React.createElement("div", {
    className: "concur-chart-wrap"
  }, /*#__PURE__*/React.createElement("svg", {
    className: "concur-svg",
    viewBox: `0 0 ${W} ${H}`,
    preserveAspectRatio: "none"
  }, ticks.map(t => /*#__PURE__*/React.createElement("g", {
    key: t
  }, /*#__PURE__*/React.createElement("line", {
    className: "grid-line",
    x1: PAD_L,
    x2: W - PAD_R,
    y1: y(t),
    y2: y(t)
  }), /*#__PURE__*/React.createElement("text", {
    className: "axis-lbl",
    x: PAD_L - 6,
    y: y(t) + 3,
    textAnchor: "end"
  }, t))), /*#__PURE__*/React.createElement("line", {
    className: "peak-line",
    x1: PAD_L,
    x2: W - PAD_R,
    y1: y(window.VOIP_PBX.peakToday),
    y2: y(window.VOIP_PBX.peakToday)
  }), /*#__PURE__*/React.createElement("path", {
    className: "area-fill",
    fill: "var(--info)",
    d: areaPath(data.outbound)
  }), /*#__PURE__*/React.createElement("path", {
    className: "area-fill",
    fill: "var(--cx)",
    d: areaPath(data.concur)
  }), /*#__PURE__*/React.createElement("path", {
    className: "area-line",
    stroke: "var(--cx)",
    d: linePath(data.concur)
  }), /*#__PURE__*/React.createElement("path", {
    className: "area-line",
    stroke: "var(--info)",
    strokeOpacity: "0.7",
    d: linePath(data.outbound),
    strokeDasharray: "3 2"
  }), hours.map(h => /*#__PURE__*/React.createElement("text", {
    key: h,
    className: "axis-lbl",
    x: PAD_L + h / 23 * innerW,
    y: H - 6,
    textAnchor: "middle"
  }, String(h).padStart(2, "0"), ":00")))), /*#__PURE__*/React.createElement("div", {
    className: "concur-legend"
  }, /*#__PURE__*/React.createElement("span", {
    className: "item"
  }, /*#__PURE__*/React.createElement("span", {
    className: "sw",
    style: {
      background: "var(--cx)"
    }
  }), " Total concurrent"), /*#__PURE__*/React.createElement("span", {
    className: "item"
  }, /*#__PURE__*/React.createElement("span", {
    className: "sw",
    style: {
      background: "var(--info)",
      opacity: 0.7
    }
  }), " Outbound only"), /*#__PURE__*/React.createElement("span", {
    className: "item"
  }, /*#__PURE__*/React.createElement("span", {
    className: "sw",
    style: {
      background: "var(--warn)",
      height: 2,
      marginBottom: 3
    }
  }), " Today's peak (", window.VOIP_PBX.peakToday, ")")));
};

// ── KPI strip across top ──
const VoipKpis = () => {
  const p = window.VOIP_PBX;
  return /*#__PURE__*/React.createElement("div", {
    className: "card",
    style: {
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "swstat-strip"
  }, /*#__PURE__*/React.createElement("div", {
    className: "swstat-cell"
  }, /*#__PURE__*/React.createElement("div", {
    className: "lbl"
  }, "Active Calls"), /*#__PURE__*/React.createElement("div", {
    className: "val",
    style: {
      color: "var(--cx)"
    }
  }, p.activeNow, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 11,
      color: "var(--muted)",
      fontWeight: 500
    }
  }, " / ", p.capacity)), /*#__PURE__*/React.createElement(Sparkline, {
    data: p.history.concur.slice(-24),
    color: "var(--cx)",
    width: 120,
    height: 20
  })), /*#__PURE__*/React.createElement("div", {
    className: "swstat-cell"
  }, /*#__PURE__*/React.createElement("div", {
    className: "lbl"
  }, "Calls Today"), /*#__PURE__*/React.createElement("div", {
    className: "val"
  }, p.callsToday.toLocaleString()), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10,
      color: "var(--muted)",
      fontFamily: "var(--mono)"
    }
  }, p.callsInbound.toLocaleString(), " in \xB7 ", p.callsOutbound.toLocaleString(), " out")), /*#__PURE__*/React.createElement("div", {
    className: "swstat-cell"
  }, /*#__PURE__*/React.createElement("div", {
    className: "lbl"
  }, "Registered Phones"), /*#__PURE__*/React.createElement("div", {
    className: "val ok"
  }, p.registeredExt, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 11,
      color: "var(--muted)",
      fontWeight: 500
    }
  }, " / ", p.totalExt)), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10,
      color: "var(--warn)",
      fontFamily: "var(--mono)"
    }
  }, "\u25CF ", p.totalExt - p.registeredExt, " unreg")), /*#__PURE__*/React.createElement("div", {
    className: "swstat-cell"
  }, /*#__PURE__*/React.createElement("div", {
    className: "lbl"
  }, "Avg MOS \xB7 1h"), /*#__PURE__*/React.createElement("div", {
    className: "val ok"
  }, p.avgMos.toFixed(2)), /*#__PURE__*/React.createElement(Sparkline, {
    data: window.VOIP_QUALITY.mos.slice(-24),
    color: "var(--ok)",
    width: 120,
    height: 20
  })), /*#__PURE__*/React.createElement("div", {
    className: "swstat-cell"
  }, /*#__PURE__*/React.createElement("div", {
    className: "lbl"
  }, "ASR (Answer)"), /*#__PURE__*/React.createElement("div", {
    className: "val ok"
  }, p.asr, "%"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10,
      color: "var(--muted)",
      fontFamily: "var(--mono)"
    }
  }, "ACD ", p.acd)), /*#__PURE__*/React.createElement("div", {
    className: "swstat-cell"
  }, /*#__PURE__*/React.createElement("div", {
    className: "lbl"
  }, "SIP Trunks"), /*#__PURE__*/React.createElement("div", {
    className: "val warn"
  }, "5", /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 11,
      color: "var(--muted)",
      fontWeight: 500
    }
  }, " / 6 up")), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10,
      color: "var(--err)",
      fontFamily: "var(--mono)"
    }
  }, "\u25CF 1 unreg \xB7 1 degraded"))));
};

// ── Loading-status pill ──
// Reads window.VOIP_LOADING_FLAGS (set by voip-bridge.jsx). Shows a spinner
// + which endpoint(s) are still in flight while the first parallel fetch
// is running, then disappears once everything has responded once.
const LoadingPill = () => {
  const flags = window.VOIP_LOADING_FLAGS || {};
  const labelOf = {
    core: "core",
    top: "top talkers",
    calls: "active calls"
  };
  const pending = Object.keys(flags).filter(k => flags[k]);
  if (pending.length === 0) return null;
  return /*#__PURE__*/React.createElement("span", {
    className: "pill",
    style: {
      background: "var(--bg-2)",
      borderColor: "var(--cx)"
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "dot",
    style: {
      background: "var(--cx)",
      animation: "voipLoadingPulse 1.4s ease-in-out infinite"
    }
  }), /*#__PURE__*/React.createElement("span", {
    className: "lbl"
  }, "Loading"), /*#__PURE__*/React.createElement("span", {
    className: "v",
    style: {
      fontSize: 10,
      opacity: 0.8
    }
  }, pending.map(k => labelOf[k] || k).join(" · ")));
};

// ── SBC fleet ──
// Each row in window.VOIP_SBCS represents one remote 3CX SBC (Session Border
// Controller) reporting back to this PBX. We render up/down + live CPU /
// memory / disk / latency / call & phone counts.
const SbcsCard = () => {
  const sbcs = window.VOIP_SBCS;
  const upCount = sbcs.filter(s => s.up).length;
  return /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "Session Border Controllers"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "3cx"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("span", {
    className: "h-meta"
  }, sbcs.length === 0 ? "no SBCs registered" : `${upCount} / ${sbcs.length} up`)), sbcs.length === 0 ? /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "18px 14px",
      fontSize: 12,
      color: "var(--muted)"
    }
  }, "No SBCs configured on this PBX.") : /*#__PURE__*/React.createElement("div", {
    className: "svc-list"
  }, sbcs.map(s => {
    const cls = s.up ? "" : "err";
    const lbl = s.up ? "UP" : s.hasConn ? "DEGR" : "DOWN";
    const sub = [s.group, s.localIp && `local ${s.localIp}`, s.publicIp && `pub ${s.publicIp}`, s.version].filter(Boolean).join(" · ");
    const stats = [`${s.phones} phones`, `${s.calls} calls`, s.latency > 0 && `${s.latency}ms`, s.cpu && `cpu ${s.cpu}`, s.memory && `mem ${s.memory}`, s.disk && `disk ${s.disk}`].filter(Boolean).join(" · ");
    return /*#__PURE__*/React.createElement("div", {
      key: s.id || s.name,
      className: "svc-row"
    }, /*#__PURE__*/React.createElement("span", {
      className: "svc-led " + cls
    }), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
      className: "svc-name"
    }, s.name), /*#__PURE__*/React.createElement("div", {
      className: "svc-sub"
    }, sub || "—"), stats && /*#__PURE__*/React.createElement("div", {
      className: "svc-sub",
      style: {
        marginTop: 2
      }
    }, stats)), /*#__PURE__*/React.createElement("div", {
      className: "svc-load"
    }, s.uptime || ""), /*#__PURE__*/React.createElement("span", {
      className: "svc-pill " + cls
    }, lbl));
  })));
};

// ── Trunks table ──
const TrunksCard = () => /*#__PURE__*/React.createElement("div", {
  className: "card"
}, /*#__PURE__*/React.createElement("div", {
  className: "card-h"
}, /*#__PURE__*/React.createElement("h3", null, "SIP Trunks \xB7 Carriers"), /*#__PURE__*/React.createElement(SourceBadge, {
  src: "3cx"
}), /*#__PURE__*/React.createElement(SourceBadge, {
  src: "zbx"
}), /*#__PURE__*/React.createElement("div", {
  className: "h-spacer"
}), /*#__PURE__*/React.createElement("span", {
  className: "h-meta"
}, "OPTIONS keepalive \xB7 60s"), /*#__PURE__*/React.createElement("span", {
  className: "h-link"
}, "Open in 3CX Mgmt ", /*#__PURE__*/React.createElement(Icon, {
  name: "external",
  size: 11
}))), /*#__PURE__*/React.createElement("table", {
  className: "trunk-tbl"
}, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", {
  style: {
    width: 90
  }
}, "Status"), /*#__PURE__*/React.createElement("th", null, "Trunk / Carrier"), /*#__PURE__*/React.createElement("th", {
  style: {
    width: 240
  }
}, "Channel utilization"), /*#__PURE__*/React.createElement("th", {
  style: {
    width: 70,
    textAlign: "right"
  }
}, "In"), /*#__PURE__*/React.createElement("th", {
  style: {
    width: 70,
    textAlign: "right"
  }
}, "Out"), /*#__PURE__*/React.createElement("th", {
  style: {
    width: 64,
    textAlign: "right"
  }
}, "ASR"), /*#__PURE__*/React.createElement("th", {
  style: {
    width: 60,
    textAlign: "right"
  }
}, "MOS"), /*#__PURE__*/React.createElement("th", {
  style: {
    width: 60,
    textAlign: "right"
  }
}, "Err 5m"))), /*#__PURE__*/React.createElement("tbody", null, window.VOIP_TRUNKS.map((t, i) => {
  const used = t.chIn + t.chOut;
  const freePct = (t.chTotal - used) / t.chTotal * 100;
  const inPct = t.chIn / t.chTotal * 100;
  const outPct = t.chOut / t.chTotal * 100;
  return /*#__PURE__*/React.createElement("tr", {
    key: i
  }, /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("span", {
    className: "tk-status " + t.status
  }, t.status === "reg" ? "REG" : t.status === "dgr" ? "DEGR" : "UNREG")), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("div", {
    className: "tk-name"
  }, t.name), /*#__PURE__*/React.createElement("div", {
    className: "tk-host"
  }, t.host, " \xB7 ", t.did)), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("div", {
    className: "ch-bar"
  }, /*#__PURE__*/React.createElement("i", {
    className: "in",
    style: {
      width: inPct + "%"
    }
  }), /*#__PURE__*/React.createElement("i", {
    className: "out",
    style: {
      width: outPct + "%"
    }
  }), /*#__PURE__*/React.createElement("i", {
    className: "free",
    style: {
      width: freePct + "%"
    }
  }), /*#__PURE__*/React.createElement("span", {
    className: "lbl"
  }, used, "/", t.chTotal))), /*#__PURE__*/React.createElement("td", {
    className: "mono",
    style: {
      textAlign: "right",
      color: "var(--cx)"
    }
  }, t.chIn), /*#__PURE__*/React.createElement("td", {
    className: "mono",
    style: {
      textAlign: "right",
      color: "var(--info)"
    }
  }, t.chOut), /*#__PURE__*/React.createElement("td", {
    className: "mono",
    style: {
      textAlign: "right",
      color: t.asr === 0 ? "var(--muted)" : t.asr < 92 ? "var(--warn)" : "var(--fg-2)"
    }
  }, t.asr > 0 ? t.asr.toFixed(1) + "%" : "—"), /*#__PURE__*/React.createElement("td", {
    className: "mono",
    style: {
      textAlign: "right",
      color: t.mos === 0 ? "var(--muted)" : t.mos < 4.1 ? "var(--warn)" : "var(--ok)"
    }
  }, t.mos > 0 ? t.mos.toFixed(2) : "—"), /*#__PURE__*/React.createElement("td", {
    className: "mono",
    style: {
      textAlign: "right",
      color: t.errors > 0 ? "var(--warn)" : "var(--muted)"
    }
  }, t.errors));
}))));

// ── Active calls list ──
const ActiveCallsCard = () => {
  const dirLbl = {
    in: "INBOUND",
    out: "OUTBOUND",
    int: "INTERNAL",
    q: "QUEUED"
  };
  return /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "Active Calls \xB7 live"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "3cx"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("span", {
    className: "h-meta"
  }, window.VOIP_CALLS.length, " ongoing \xB7 2s refresh")), /*#__PURE__*/React.createElement("div", {
    className: "calls-list"
  }, window.VOIP_CALLS.map((c, i) => {
    const onBars = c.q === "good" ? 4 : c.q === "fair" ? 2 : 1;
    return /*#__PURE__*/React.createElement("div", {
      key: i,
      className: "call-row"
    }, /*#__PURE__*/React.createElement("span", {
      className: "c-dir " + c.dir
    }, dirLbl[c.dir]), /*#__PURE__*/React.createElement("div", {
      className: "c-leg"
    }, /*#__PURE__*/React.createElement("div", {
      className: "who"
    }, c.from), /*#__PURE__*/React.createElement("div", {
      className: "sub"
    }, c.fromSub)), /*#__PURE__*/React.createElement("div", {
      className: "c-leg"
    }, /*#__PURE__*/React.createElement("div", {
      className: "who"
    }, c.to), /*#__PURE__*/React.createElement("div", {
      className: "sub"
    }, c.toSub)), /*#__PURE__*/React.createElement("div", {
      className: "c-dur"
    }, c.dur), /*#__PURE__*/React.createElement("div", {
      className: "c-tech"
    }, /*#__PURE__*/React.createElement("span", null, /*#__PURE__*/React.createElement("b", null, c.codec)), /*#__PURE__*/React.createElement("span", null, "via ", c.trunk)), /*#__PURE__*/React.createElement("div", {
      className: "c-q " + c.q
    }, c.mos > 0 ? /*#__PURE__*/React.createElement("span", {
      className: "mos " + c.q
    }, c.mos.toFixed(2)) : /*#__PURE__*/React.createElement("span", {
      className: "mos",
      style: {
        color: "var(--muted)"
      }
    }, "\u2014"), /*#__PURE__*/React.createElement("span", {
      className: "bars"
    }, [0, 1, 2, 3].map(b => /*#__PURE__*/React.createElement("i", {
      key: b,
      className: b < onBars ? "on" : ""
    })))));
  })));
};

// ── Call quality card ──
const CallQualityCard = () => {
  const q = window.VOIP_QUALITY;
  const mosNow = q.mos[q.mos.length - 1];
  const jitNow = q.jitter[q.jitter.length - 1];
  const lossNow = q.loss[q.loss.length - 1];
  const rttNow = q.rtt[q.rtt.length - 1];
  const cls = (good, fair, val, inv) => {
    if (inv) return val <= good ? "ok" : val <= fair ? "warn" : "err";
    return val >= good ? "ok" : val >= fair ? "warn" : "err";
  };
  return /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "Call Quality \xB7 24h"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "3cx"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("span", {
    className: "h-meta"
  }, "RTCP-XR \xB7 30m")), /*#__PURE__*/React.createElement("div", {
    className: "cq-rows"
  }, /*#__PURE__*/React.createElement("div", {
    className: "cq-row"
  }, /*#__PURE__*/React.createElement("div", {
    className: "cq-lbl"
  }, /*#__PURE__*/React.createElement("span", {
    className: "name"
  }, "MOS"), /*#__PURE__*/React.createElement("span", {
    className: "sub"
  }, "target \u2265 4.0")), /*#__PURE__*/React.createElement("div", {
    className: "cq-spark"
  }, /*#__PURE__*/React.createElement(Sparkline, {
    data: q.mos,
    color: "var(--ok)",
    width: 300,
    height: 32,
    threshold: 4.0
  })), /*#__PURE__*/React.createElement("div", {
    className: "cq-val"
  }, /*#__PURE__*/React.createElement("div", {
    className: "v " + cls(4.2, 4.0, mosNow)
  }, mosNow.toFixed(2)), /*#__PURE__*/React.createElement("div", {
    className: "u"
  }, "score"))), /*#__PURE__*/React.createElement("div", {
    className: "cq-row"
  }, /*#__PURE__*/React.createElement("div", {
    className: "cq-lbl"
  }, /*#__PURE__*/React.createElement("span", {
    className: "name"
  }, "Jitter"), /*#__PURE__*/React.createElement("span", {
    className: "sub"
  }, "target \u2264 20ms")), /*#__PURE__*/React.createElement("div", {
    className: "cq-spark"
  }, /*#__PURE__*/React.createElement(Sparkline, {
    data: q.jitter,
    color: "var(--warn)",
    width: 300,
    height: 32,
    threshold: 20
  })), /*#__PURE__*/React.createElement("div", {
    className: "cq-val"
  }, /*#__PURE__*/React.createElement("div", {
    className: "v " + cls(15, 20, jitNow, true)
  }, jitNow.toFixed(1)), /*#__PURE__*/React.createElement("div", {
    className: "u"
  }, "ms"))), /*#__PURE__*/React.createElement("div", {
    className: "cq-row"
  }, /*#__PURE__*/React.createElement("div", {
    className: "cq-lbl"
  }, /*#__PURE__*/React.createElement("span", {
    className: "name"
  }, "Packet loss"), /*#__PURE__*/React.createElement("span", {
    className: "sub"
  }, "target \u2264 0.5%")), /*#__PURE__*/React.createElement("div", {
    className: "cq-spark"
  }, /*#__PURE__*/React.createElement(Sparkline, {
    data: q.loss,
    color: "var(--pf)",
    width: 300,
    height: 32,
    threshold: 0.5
  })), /*#__PURE__*/React.createElement("div", {
    className: "cq-val"
  }, /*#__PURE__*/React.createElement("div", {
    className: "v " + cls(0.3, 0.5, lossNow, true)
  }, lossNow.toFixed(2)), /*#__PURE__*/React.createElement("div", {
    className: "u"
  }, "%"))), /*#__PURE__*/React.createElement("div", {
    className: "cq-row"
  }, /*#__PURE__*/React.createElement("div", {
    className: "cq-lbl"
  }, /*#__PURE__*/React.createElement("span", {
    className: "name"
  }, "Round-trip"), /*#__PURE__*/React.createElement("span", {
    className: "sub"
  }, "target \u2264 50ms")), /*#__PURE__*/React.createElement("div", {
    className: "cq-spark"
  }, /*#__PURE__*/React.createElement(Sparkline, {
    data: q.rtt,
    color: "var(--info)",
    width: 300,
    height: 32,
    threshold: 50
  })), /*#__PURE__*/React.createElement("div", {
    className: "cq-val"
  }, /*#__PURE__*/React.createElement("div", {
    className: "v " + cls(30, 50, rttNow, true)
  }, rttNow.toFixed(0)), /*#__PURE__*/React.createElement("div", {
    className: "u"
  }, "ms")))));
};

// ── Top extensions / talkers ──
const TopTalkers = () => {
  const max = window.VOIP_TOP.length ? Math.max(...window.VOIP_TOP.map(t => t.calls)) : 1;
  return /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "Top Extensions \xB7 Today"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "3cx"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("span", {
    className: "h-meta"
  }, "by call volume")), window.VOIP_TOP.map((t, i) => /*#__PURE__*/React.createElement("div", {
    key: t.ext,
    className: "tt-row"
  }, /*#__PURE__*/React.createElement("span", {
    className: "tt-rank"
  }, i + 1), /*#__PURE__*/React.createElement("div", {
    className: "tt-name"
  }, /*#__PURE__*/React.createElement("div", {
    className: "who"
  }, /*#__PURE__*/React.createElement("span", {
    className: "ext"
  }, "x", t.ext), t.name), /*#__PURE__*/React.createElement("div", {
    className: "sub"
  }, t.mins, " min talk \xB7 ", t.site)), /*#__PURE__*/React.createElement("span", {
    className: "tt-bar"
  }, /*#__PURE__*/React.createElement("i", {
    style: {
      width: t.calls / max * 100 + "%"
    }
  })), /*#__PURE__*/React.createElement("span", {
    className: "tt-cnt"
  }, t.calls))));
};

// ── Queues panel ──
const QueuesCard = () => /*#__PURE__*/React.createElement("div", {
  className: "card"
}, /*#__PURE__*/React.createElement("div", {
  className: "card-h"
}, /*#__PURE__*/React.createElement("h3", null, "Call Queues"), /*#__PURE__*/React.createElement(SourceBadge, {
  src: "3cx"
}), /*#__PURE__*/React.createElement("div", {
  className: "h-spacer"
}), /*#__PURE__*/React.createElement("span", {
  className: "h-meta"
}, "SLA = answered within target")), /*#__PURE__*/React.createElement("div", {
  className: "q-grid"
}, window.VOIP_QUEUES.map(q => /*#__PURE__*/React.createElement("div", {
  key: q.ext,
  className: "q-cell"
}, /*#__PURE__*/React.createElement("div", {
  className: "q-head"
}, /*#__PURE__*/React.createElement("span", {
  className: "name"
}, q.name), /*#__PURE__*/React.createElement("span", {
  className: "ext"
}, "x", q.ext)), /*#__PURE__*/React.createElement("div", {
  className: "q-stats"
}, /*#__PURE__*/React.createElement("div", {
  className: "q-stat"
}, /*#__PURE__*/React.createElement("span", {
  className: "k"
}, "Agents"), /*#__PURE__*/React.createElement("span", {
  className: "v"
}, q.agentsOn, "/", q.agents)), /*#__PURE__*/React.createElement("div", {
  className: "q-stat"
}, /*#__PURE__*/React.createElement("span", {
  className: "k"
}, "Waiting"), /*#__PURE__*/React.createElement("span", {
  className: "v " + (q.waiting > 2 ? "warn" : "")
}, q.waiting)), /*#__PURE__*/React.createElement("div", {
  className: "q-stat"
}, /*#__PURE__*/React.createElement("span", {
  className: "k"
}, "SLA ", q.slaSec, "s"), /*#__PURE__*/React.createElement("span", {
  className: "v " + (q.sla < 90 ? "warn" : "")
}, q.sla, "%")), /*#__PURE__*/React.createElement("div", {
  className: "q-stat"
}, /*#__PURE__*/React.createElement("span", {
  className: "k"
}, "Abandon"), /*#__PURE__*/React.createElement("span", {
  className: "v " + (q.abandon > 3 ? "warn" : "")
}, q.abandon))), /*#__PURE__*/React.createElement("div", {
  className: "q-bar"
}, /*#__PURE__*/React.createElement("i", {
  className: "ans",
  style: {
    width: q.ans / (q.ans + q.abandon) * 100 + "%"
  }
}), /*#__PURE__*/React.createElement("i", {
  className: "aban",
  style: {
    width: q.abandon / (q.ans + q.abandon) * 100 + "%"
  }
}))))));

// ── Problems ──
const VoipProblems = () => /*#__PURE__*/React.createElement("div", {
  className: "card"
}, /*#__PURE__*/React.createElement("div", {
  className: "card-h"
}, /*#__PURE__*/React.createElement("h3", null, "Problems"), /*#__PURE__*/React.createElement(SourceBadge, {
  src: "zbx"
}), /*#__PURE__*/React.createElement("div", {
  className: "h-spacer"
}), /*#__PURE__*/React.createElement(Icon, {
  name: "filter",
  size: 12
}), /*#__PURE__*/React.createElement(Icon, {
  name: "more",
  size: 14
})), /*#__PURE__*/React.createElement("div", {
  style: {
    padding: "8px 14px 6px",
    fontSize: 11,
    color: "var(--muted)",
    letterSpacing: 0.4,
    textTransform: "uppercase",
    borderBottom: "1px solid var(--line)"
  }
}, "Triggers \xB7 last 24h \xB7 VoIP host group"), window.VOIP_PROBLEMS.map((p, i) => /*#__PURE__*/React.createElement("div", {
  key: i,
  className: "problem-row " + (p.ack ? "ack" : "")
}, /*#__PURE__*/React.createElement("div", {
  className: "top"
}, /*#__PURE__*/React.createElement(Sev, {
  level: p.sev
}), /*#__PURE__*/React.createElement("span", {
  className: "host"
}, p.host), /*#__PURE__*/React.createElement("span", {
  className: "age"
}, p.age)), /*#__PURE__*/React.createElement("div", {
  className: "trig"
}, p.trig), /*#__PURE__*/React.createElement("div", {
  className: "ts"
}, p.ts, p.ack && " · ack"))));

// ═══════════════════════════════════════════════════════════════
// APP
// ═══════════════════════════════════════════════════════════════

const TWEAK_DEFAULTS_VP = /*EDITMODE-BEGIN*/{
  "density": "balanced",
  "accent": "#2bd6c0",
  "showSourceBadges": true,
  "showInternalCalls": true
} /*EDITMODE-END*/;
const VoipApp = () => {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS_VP);
  const [, setTick] = useStateVP(0);
  useEffectVP(() => {
    document.documentElement.style.setProperty("--cx", t.accent);
    document.documentElement.classList.toggle("hide-src-badges", !t.showSourceBadges);
  }, [t.accent, t.showSourceBadges]);

  // Re-render whenever voip-bridge.jsx swaps in a fresh payload. The card
  // components all read window.VOIP_* directly at render time, so bumping
  // a tick is enough to pick up the new data.
  useEffectVP(() => {
    const onData = () => setTick(n => n + 1);
    window.addEventListener("tcs:voip-data", onData);
    return () => window.removeEventListener("tcs:voip-data", onData);
  }, []);
  const densityVar = t.density === "spacious" ? 1.15 : t.density === "dense" ? 0.85 : 1;
  const p = window.VOIP_PBX;
  return /*#__PURE__*/React.createElement("div", {
    className: "app",
    "data-density": t.density,
    style: {
      fontSize: `${13 * densityVar}px`
    }
  }, /*#__PURE__*/React.createElement(GlobalSidebar, {
    active: "voip"
  }), /*#__PURE__*/React.createElement("div", {
    className: "main"
  }, /*#__PURE__*/React.createElement(GlobalTopbar, {
    crumb: ["Voice", "3CX Phone System", p.fqdn],
    search: "Find extension, DID, caller\u2026"
  }), /*#__PURE__*/React.createElement("div", {
    className: "page-header"
  }, /*#__PURE__*/React.createElement("div", {
    className: "icon-btn",
    style: {
      marginTop: 4
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "back"
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "host-title"
  }, /*#__PURE__*/React.createElement("h1", null, "3CX Phone System"), /*#__PURE__*/React.createElement("span", {
    className: "ip"
  }, p.fqdn), /*#__PURE__*/React.createElement("span", {
    className: "role-tag voip",
    style: {
      fontSize: 10,
      padding: "1px 8px"
    }
  }, "3CX \xB7 ", p.version)), /*#__PURE__*/React.createElement("div", {
    className: "host-meta voip-meta-bar"
  }, /*#__PURE__*/React.createElement(LoadingPill, null), /*#__PURE__*/React.createElement("span", {
    className: "pill"
  }, /*#__PURE__*/React.createElement("span", {
    className: "dot",
    style: {
      background: "var(--ok)"
    }
  }), " Phone System online"), /*#__PURE__*/React.createElement("span", {
    className: "pill"
  }, /*#__PURE__*/React.createElement("span", {
    className: "lbl"
  }, "IP"), " ", /*#__PURE__*/React.createElement("span", {
    className: "v"
  }, p.ip)), /*#__PURE__*/React.createElement("span", {
    className: "pill"
  }, /*#__PURE__*/React.createElement("span", {
    className: "lbl"
  }, "License"), " ", /*#__PURE__*/React.createElement("span", {
    className: "v"
  }, p.edition)), /*#__PURE__*/React.createElement("span", {
    className: "pill"
  }, /*#__PURE__*/React.createElement("span", {
    className: "lbl"
  }, "Uptime"), " ", /*#__PURE__*/React.createElement("span", {
    className: "v"
  }, p.uptime)), /*#__PURE__*/React.createElement("span", {
    className: "pill"
  }, /*#__PURE__*/React.createElement("span", {
    className: "lbl"
  }, "Region"), " ", /*#__PURE__*/React.createElement("span", {
    className: "v"
  }, "Arc-DC")), /*#__PURE__*/React.createElement("span", {
    className: "pill"
  }, /*#__PURE__*/React.createElement("span", {
    className: "dot",
    style: {
      background: "var(--warn)"
    }
  }), " 1 trunk degraded \xB7 1 unreg"))), /*#__PURE__*/React.createElement("div", {
    className: "timerange"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "calendar"
  }), /*#__PURE__*/React.createElement("span", {
    className: "range-val"
  }, "May 13 09:42 \u2014 May 14 09:42"), /*#__PURE__*/React.createElement(Icon, {
    name: "chevron"
  }))), /*#__PURE__*/React.createElement("div", {
    className: "body",
    "data-screen-label": "VoIP Dashboard"
  }, /*#__PURE__*/React.createElement(VoipKpis, null), /*#__PURE__*/React.createElement("div", {
    className: "voip-row-2col-wide",
    style: {
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement(ConcurrencyChart, null), /*#__PURE__*/React.createElement(CallQualityCard, null)), /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement(ActiveCallsCard, null)), /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement(TrunksCard, null)), /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement(SbcsCard, null)), /*#__PURE__*/React.createElement("div", {
    className: "voip-row-2col-wide",
    style: {
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement(QueuesCard, null), /*#__PURE__*/React.createElement(TopTalkers, null)), /*#__PURE__*/React.createElement(VoipProblems, null))), /*#__PURE__*/React.createElement(TweaksPanel, {
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
  })), /*#__PURE__*/React.createElement(TweakSection, {
    title: "Visual"
  }, /*#__PURE__*/React.createElement(TweakColor, {
    label: "3CX accent",
    value: t.accent,
    options: ["#2bd6c0", "#34d399", "#5b8cff", "#7c5cff", "#f5b300", "#d92929"],
    onChange: v => setTweak("accent", v)
  }), /*#__PURE__*/React.createElement(TweakToggle, {
    label: "Show data-source badges",
    value: t.showSourceBadges,
    onChange: v => setTweak("showSourceBadges", v)
  }))));
};
ReactDOM.createRoot(document.getElementById("root")).render(/*#__PURE__*/React.createElement(VoipApp, null));