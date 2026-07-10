function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
// XIQ Wireless Status — global overview rolled up from ExtremeCloud IQ
// (read-through via the EXT source) joined with Zabbix host-level state.
// Layout: KPI strip → sites → SSID/problems → channel/firmware
// → client-mix/roaming → live events.

const {
  useState,
  useEffect
} = React;

// ───────── Live data bindings ─────────
// Data globals are populated by xiq-bridge.jsx (from window.XIQ_BOOT on first
// paint, then refreshed by fetch to tcs.xiq.data). These `let`s are live
// bindings — child components reference them by name and pick up reassignments
// when the bridge fires "tcs:xiq-data". The App component listens for that
// event and bumps a render counter to force the tree to re-evaluate.
let XIQ_TOTALS = window.XIQ_TOTALS || {};
let XIQ_SITES = window.XIQ_SITES || [];
let XIQ_SSIDS = window.XIQ_SSIDS || [];
let XIQ_TOP_CLIENT_APS = window.XIQ_TOP_CLIENT_APS || [];
let XIQ_CHANNEL_GRID = window.XIQ_CHANNEL_GRID || {
  sites: [],
  channels: [],
  matrix: []
};
let XIQ_CLIENT_MIX = window.XIQ_CLIENT_MIX || {
  standards: [],
  os: []
};
let XIQ_FIRMWARE = window.XIQ_FIRMWARE || {
  versions: []
};
let XIQ_ROAMING = window.XIQ_ROAMING || {
  buckets: [],
  rate24h: 0
};
let XIQ_EVENTS = window.XIQ_EVENTS || [];
window.addEventListener("tcs:xiq-data", () => {
  XIQ_TOTALS = window.XIQ_TOTALS || XIQ_TOTALS;
  XIQ_SITES = window.XIQ_SITES || XIQ_SITES;
  XIQ_SSIDS = window.XIQ_SSIDS || XIQ_SSIDS;
  XIQ_TOP_CLIENT_APS = window.XIQ_TOP_CLIENT_APS || XIQ_TOP_CLIENT_APS;
  XIQ_CHANNEL_GRID = window.XIQ_CHANNEL_GRID || XIQ_CHANNEL_GRID;
  XIQ_CLIENT_MIX = window.XIQ_CLIENT_MIX || XIQ_CLIENT_MIX;
  XIQ_FIRMWARE = window.XIQ_FIRMWARE || XIQ_FIRMWARE;
  XIQ_ROAMING = window.XIQ_ROAMING || XIQ_ROAMING;
  XIQ_EVENTS = window.XIQ_EVENTS || XIQ_EVENTS;
});

// ───────── Severity color palette (reused across cards) ─────────
const xiqSev = {
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

// ───────── Loading / empty state for a card ─────────
const CardLoading = ({
  label,
  spinning = true
}) => /*#__PURE__*/React.createElement("div", {
  style: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    padding: "40px 14px",
    color: "var(--muted)",
    fontSize: 12
  }
}, spinning ? /*#__PURE__*/React.createElement("div", {
  className: "refresh-ring",
  style: {
    width: 22,
    height: 22,
    borderWidth: 2.5
  }
}) : /*#__PURE__*/React.createElement(Icon, {
  name: "alert",
  size: 18
}), /*#__PURE__*/React.createElement("div", null, label));

// Heat color for the channel utilization grid: 0–100 → blue→amber→red.
const heatColor = v => {
  if (v <= 0) return null;
  if (v < 25) return `rgba(95,168,211,${0.18 + v / 100})`;
  if (v < 50) return `rgba(124,92,255,${0.22 + (v - 25) / 100})`;
  if (v < 75) return `rgba(245,179,0,${0.30 + (v - 50) / 120})`;
  return `rgba(242,95,92,${0.40 + (v - 75) / 120})`;
};

// ───────── Header ─────────
const XIQHeader = ({
  now,
  timeRange,
  setTimeRange
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
}, /*#__PURE__*/React.createElement("h1", null, "XIQ Wireless \xB7 Status"), /*#__PURE__*/React.createElement(SourceBadge, {
  src: "ext"
}), /*#__PURE__*/React.createElement("span", {
  className: "role-tag av",
  style: {
    fontSize: 10,
    padding: "1px 8px"
  }
}, "RF \xB7 CONTROLLER")), /*#__PURE__*/React.createElement("div", {
  className: "host-meta"
}, /*#__PURE__*/React.createElement("span", {
  className: "pill"
}, /*#__PURE__*/React.createElement("span", {
  className: "refresh-ring"
}), " ", /*#__PURE__*/React.createElement("span", {
  className: "lbl"
}, "XIQ sync"), " ", /*#__PURE__*/React.createElement("span", {
  className: "v"
}, XIQ_TOTALS.controllers.lastSync)), /*#__PURE__*/React.createElement("span", {
  className: "pill"
}, /*#__PURE__*/React.createElement("span", {
  className: "lbl"
}, "Tenant"), " ", /*#__PURE__*/React.createElement("span", {
  className: "v"
}, XIQ_TOTALS.controllers.instance)), /*#__PURE__*/React.createElement("span", {
  className: "pill"
}, /*#__PURE__*/React.createElement("span", {
  className: "lbl"
}, "Region"), " ", /*#__PURE__*/React.createElement("span", {
  className: "v"
}, XIQ_TOTALS.controllers.region)), /*#__PURE__*/React.createElement("span", {
  className: "pill"
}, /*#__PURE__*/React.createElement("span", {
  className: "dot",
  style: {
    background: "var(--ok)"
  }
}), " All cloud brokers reachable"), /*#__PURE__*/React.createElement("span", {
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

// ───────── KPI strip (6 cells) ─────────
const KPIStrip = () => {
  const t = XIQ_TOTALS;
  const onlinePct = t.aps.total > 0 ? t.aps.online / t.aps.total * 100 : 0;
  return /*#__PURE__*/React.createElement("div", {
    className: "card",
    style: {
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "xiq-kpi"
  }, /*#__PURE__*/React.createElement("div", {
    className: "xiq-kpi-cell"
  }, /*#__PURE__*/React.createElement("div", {
    className: "xiq-kpi-h"
  }, /*#__PURE__*/React.createElement("span", {
    className: "xiq-kpi-lbl"
  }, "Access Points"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "ext"
  })), /*#__PURE__*/React.createElement("div", {
    className: "xiq-kpi-v"
  }, t.aps.total.toLocaleString()), /*#__PURE__*/React.createElement("div", {
    className: "xiq-kpi-foot"
  }, "across ", XIQ_SITES.length, " site", XIQ_SITES.length === 1 ? "" : "s")), /*#__PURE__*/React.createElement("div", {
    className: "xiq-kpi-cell ok"
  }, /*#__PURE__*/React.createElement("div", {
    className: "xiq-kpi-h"
  }, /*#__PURE__*/React.createElement("span", {
    className: "xiq-kpi-lbl"
  }, "Online"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "ext"
  })), /*#__PURE__*/React.createElement("div", {
    className: "xiq-kpi-v"
  }, t.aps.online.toLocaleString(), /*#__PURE__*/React.createElement("span", {
    className: "u"
  }, "/ ", t.aps.total.toLocaleString())), /*#__PURE__*/React.createElement("div", {
    className: "xiq-kpi-bar"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: `${onlinePct}%`,
      background: "var(--ok)"
    }
  })), /*#__PURE__*/React.createElement("div", {
    className: "xiq-kpi-foot"
  }, onlinePct.toFixed(1), "% reachable")), /*#__PURE__*/React.createElement("div", {
    className: "xiq-kpi-cell err"
  }, /*#__PURE__*/React.createElement("div", {
    className: "xiq-kpi-h"
  }, /*#__PURE__*/React.createElement("span", {
    className: "xiq-kpi-lbl"
  }, "Offline / Critical"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "ext"
  })), /*#__PURE__*/React.createElement("div", {
    className: "xiq-kpi-v"
  }, t.aps.offline + t.aps.critical), /*#__PURE__*/React.createElement("div", {
    className: "xiq-kpi-foot"
  }, t.aps.offline, " unreachable \xB7 ", t.aps.critical, " critical \xB7 ", t.aps.idle, " idle")), /*#__PURE__*/React.createElement("div", {
    className: "xiq-kpi-cell ext"
  }, /*#__PURE__*/React.createElement("div", {
    className: "xiq-kpi-h"
  }, /*#__PURE__*/React.createElement("span", {
    className: "xiq-kpi-lbl"
  }, "Connected Clients"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "ext"
  })), /*#__PURE__*/React.createElement("div", {
    className: "xiq-kpi-v"
  }, t.clients.total.toLocaleString()), /*#__PURE__*/React.createElement("div", {
    className: "xiq-kpi-foot"
  }, t.clients.dot11ax.toLocaleString(), " ax \xB7 ", t.clients.dot11ac.toLocaleString(), " ac \xB7 ", t.clients.legacy, " legacy")), /*#__PURE__*/React.createElement("div", {
    className: "xiq-kpi-cell warn"
  }, /*#__PURE__*/React.createElement("div", {
    className: "xiq-kpi-h"
  }, /*#__PURE__*/React.createElement("span", {
    className: "xiq-kpi-lbl"
  }, "RF Health Score"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "ext"
  })), /*#__PURE__*/React.createElement("div", {
    className: "xiq-kpi-v"
  }, t.rfHealth.score, /*#__PURE__*/React.createElement("span", {
    className: "u"
  }, "/ 100")), /*#__PURE__*/React.createElement("div", {
    className: "xiq-kpi-bar"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: `${t.rfHealth.score}%`,
      background: t.rfHealth.score >= t.rfHealth.target ? "var(--ok)" : "var(--warn)"
    }
  })), /*#__PURE__*/React.createElement("div", {
    className: "xiq-kpi-foot"
  }, "target \u2265 ", t.rfHealth.target, " \xB7 2.4 GHz dragging"))));
};

// ───────── Site → AP rollup grid ─────────
const APSiteGrid = ({
  filter,
  setFilter
}) => {
  const sites = filter === "issues" ? XIQ_SITES.filter(s => s.online < s.aps || s.sev === "warning" || s.sev === "high" || s.sev === "disaster") : filter === "ok" ? XIQ_SITES.filter(s => s.online === s.aps && (s.sev === "ok" || s.sev === "info")) : XIQ_SITES;
  return /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "APs by Site"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "ext"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("div", {
    className: "seg-toggle"
  }, [["all", `All ${XIQ_SITES.length}`], ["issues", "Issues"], ["ok", "Healthy"]].map(([k, l]) => /*#__PURE__*/React.createElement("button", {
    key: k,
    className: "seg-btn" + (filter === k ? " active" : ""),
    onClick: () => setFilter(k)
  }, l)))), /*#__PURE__*/React.createElement("div", {
    className: "card-b"
  }, XIQ_SITES.length === 0 ? /*#__PURE__*/React.createElement(CardLoading, {
    label: window.XIQ_LOADING ? "Loading AP fleet from Zabbix…" : "No APs found in the Site/Wireless/* groups.",
    spinning: !!window.XIQ_LOADING
  }) : /*#__PURE__*/React.createElement("div", {
    className: "apsite-grid"
  }, sites.map(s => {
    const c = xiqSev[s.sev] || xiqSev.ok;
    const off = s.aps - s.online;
    const utilColor = s.util > 70 ? "var(--err)" : s.util > 55 ? "var(--warn)" : "var(--ok)";
    return /*#__PURE__*/React.createElement("div", {
      key: s.id,
      className: "apsite-tile" + (s.kind === "outage" ? " pulse" : ""),
      style: {
        background: c.bg,
        borderColor: c.bd
      },
      title: `${s.name} · ${s.online}/${s.aps} online · ${s.clients} clients · util ${s.util}%`
    }, /*#__PURE__*/React.createElement("div", {
      className: "apsite-h"
    }, /*#__PURE__*/React.createElement("span", {
      className: "apsite-id",
      style: {
        color: c.fg
      }
    }, s.id), /*#__PURE__*/React.createElement("span", {
      className: "apsite-aps"
    }, off > 0 ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("span", {
      className: "off"
    }, off, "\u2193"), " ", /*#__PURE__*/React.createElement("span", {
      style: {
        color: "var(--muted)"
      }
    }, "/ ", s.aps)) : /*#__PURE__*/React.createElement("span", {
      style: {
        color: c.fg
      }
    }, s.aps))), /*#__PURE__*/React.createElement("div", {
      className: "apsite-name"
    }, s.name), /*#__PURE__*/React.createElement("div", {
      className: "apsite-util-row"
    }, /*#__PURE__*/React.createElement("div", {
      className: "apsite-util-bar"
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        width: `${s.util}%`,
        background: utilColor
      }
    })), /*#__PURE__*/React.createElement("span", null, s.util, "%")), /*#__PURE__*/React.createElement("div", {
      className: "apsite-clients"
    }, s.clients.toLocaleString(), " clients"));
  }))), /*#__PURE__*/React.createElement("div", {
    className: "sites-legend"
  }, [["disaster", "Disaster"], ["high", "High"], ["warning", "Warning"], ["info", "Info"], ["ok", "OK"]].map(([k, l]) => /*#__PURE__*/React.createElement("span", {
    className: "legend-item",
    key: k
  }, /*#__PURE__*/React.createElement("span", {
    className: "legend-sw",
    style: {
      background: xiqSev[k].bg,
      borderColor: xiqSev[k].bd
    }
  }), l)), /*#__PURE__*/React.createElement("span", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("span", {
    className: "legend-foot"
  }, sites.reduce((n, s) => n + s.online, 0), " / ", sites.reduce((n, s) => n + s.aps, 0), " APs online \xB7 ", sites.reduce((n, s) => n + s.clients, 0).toLocaleString(), " clients")));
};

// ───────── SSID table ─────────
const SSIDTable = () => /*#__PURE__*/React.createElement("table", {
  className: "tbl ssid-tbl"
}, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", null, "SSID"), /*#__PURE__*/React.createElement("th", {
  style: {
    width: 110
  }
}, "Auth"), /*#__PURE__*/React.createElement("th", {
  style: {
    width: 60,
    textAlign: "right"
  }
}, "VLAN"), /*#__PURE__*/React.createElement("th", {
  style: {
    width: 80,
    textAlign: "right"
  }
}, "Clients"), /*#__PURE__*/React.createElement("th", {
  style: {
    width: 160
  }
}, "Assoc success"), /*#__PURE__*/React.createElement("th", {
  style: {
    width: 80,
    textAlign: "right"
  }
}, "Gbps"), /*#__PURE__*/React.createElement("th", {
  style: {
    width: 28
  }
}))), /*#__PURE__*/React.createElement("tbody", null, XIQ_SSIDS.map(s => {
  const cls = s.success >= 99 ? "ok" : s.success >= 97 ? "warn" : "err";
  const barColor = s.success >= 99 ? "var(--ok)" : s.success >= 97 ? "var(--warn)" : "var(--err)";
  return /*#__PURE__*/React.createElement("tr", {
    key: s.id
  }, /*#__PURE__*/React.createElement("td", {
    className: "fg"
  }, /*#__PURE__*/React.createElement("span", {
    className: "ssid-name" + (s.hidden ? " hidden" : "")
  }, /*#__PURE__*/React.createElement("span", {
    className: "bcast-dot"
  }), s.label)), /*#__PURE__*/React.createElement("td", null, s.auth), /*#__PURE__*/React.createElement("td", {
    style: {
      textAlign: "right"
    }
  }, s.vlan), /*#__PURE__*/React.createElement("td", {
    style: {
      textAlign: "right"
    },
    className: "fg"
  }, s.clients.toLocaleString()), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("div", {
    className: "ssid-bar-cell"
  }, /*#__PURE__*/React.createElement("div", {
    className: "ssid-bar"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: `${s.success}%`,
      background: barColor
    }
  })), /*#__PURE__*/React.createElement("span", {
    className: "ssid-success " + cls
  }, s.success.toFixed(1), "%"))), /*#__PURE__*/React.createElement("td", {
    style: {
      textAlign: "right"
    },
    className: "fg"
  }, s.throughput.toFixed(2)), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("span", {
    className: "role-tag " + s.role,
    style: {
      fontSize: 9,
      padding: "0 5px"
    }
  }, s.role)));
})));

// ───────── Top client APs list (APs with the most connected clients) ─────────
const TopClientAPList = () => {
  if (!XIQ_TOP_CLIENT_APS || XIQ_TOP_CLIENT_APS.length === 0) {
    return /*#__PURE__*/React.createElement(CardLoading, {
      label: window.XIQ_LOADING ? "Loading fleet client counts…" : "No client data yet — xiq.ap.clients items have not reported.",
      spinning: !!window.XIQ_LOADING
    });
  }
  return /*#__PURE__*/React.createElement("div", {
    className: "papl"
  }, XIQ_TOP_CLIENT_APS.map((p, i) => {
    const apDetailUrl = p.hostid ? `${window.TCS_NAV && window.TCS_NAV.apDetail || "zabbix.php?action=tcs.dashboard.view"}&hostid=${encodeURIComponent(p.hostid)}` : null;
    const rowProps = apDetailUrl ? {
      onClick: () => {
        window.location.href = apDetailUrl;
      },
      style: {
        cursor: "pointer"
      },
      title: `Open ${p.ap} detail`
    } : {};
    const rank = i + 1;
    const loadCls = p.clients > 50 ? "err" : p.clients > 35 ? "warn" : "";
    return /*#__PURE__*/React.createElement("div", _extends({
      className: "pap-row",
      key: i
    }, rowProps), /*#__PURE__*/React.createElement("div", {
      className: "pap-main"
    }, /*#__PURE__*/React.createElement("div", {
      className: "pap-head"
    }, /*#__PURE__*/React.createElement("span", {
      className: "pap-id"
    }, "#", rank, " \xB7 ", p.ap), /*#__PURE__*/React.createElement("span", {
      className: "site-chip"
    }, p.site), /*#__PURE__*/React.createElement("span", {
      className: "pap-model"
    }, p.model)), p.building ? /*#__PURE__*/React.createElement("div", {
      className: "pap-reason",
      style: {
        color: "var(--muted)"
      }
    }, p.building) : null), /*#__PURE__*/React.createElement("div", {
      className: "pap-age"
    }, /*#__PURE__*/React.createElement("span", {
      className: "v " + loadCls,
      style: {
        fontSize: 18,
        fontWeight: 600
      }
    }, p.clients), /*#__PURE__*/React.createElement("br", null), /*#__PURE__*/React.createElement("span", {
      style: {
        color: "var(--muted)"
      }
    }, "clients")), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement(Icon, {
      name: "chevron",
      size: 12
    })));
  }));
};

// ───────── Channel utilization heat grid ─────────
const ChannelGrid = () => {
  const g = XIQ_CHANNEL_GRID;
  const cols = `60px repeat(${g.channels.length}, 1fr)`;
  return /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "5 GHz \xB7 Channel Utilization Heatmap"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "ext"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("span", {
    className: "h-meta"
  }, "top 8 sites \xB7 CCA mean / 5m")), /*#__PURE__*/React.createElement("div", {
    className: "chgrid"
  }, /*#__PURE__*/React.createElement("div", {
    className: "chgrid-row",
    style: {
      gridTemplateColumns: cols
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "chgrid-rowlabel"
  }), g.channels.map(ch => /*#__PURE__*/React.createElement("div", {
    className: "chgrid-h",
    key: ch
  }, ch))), g.sites.map((siteId, ri) => /*#__PURE__*/React.createElement("div", {
    className: "chgrid-row",
    key: siteId,
    style: {
      gridTemplateColumns: cols
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "chgrid-rowlabel"
  }, siteId), g.matrix[ri].map((v, ci) => {
    const bg = heatColor(v);
    return /*#__PURE__*/React.createElement("div", {
      key: ci,
      className: "chgrid-cell" + (v === 0 ? " empty" : ""),
      style: {
        background: bg || undefined
      },
      title: `${siteId} · ch ${g.channels[ci]} — ${v === 0 ? "no data / offline" : v + "% CCA"}`
    }, v > 0 ? v : "—");
  })))), /*#__PURE__*/React.createElement("div", {
    className: "chgrid-legend"
  }, /*#__PURE__*/React.createElement("span", null, "Low"), /*#__PURE__*/React.createElement("div", {
    className: "chgrid-legend-scale"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      background: heatColor(10)
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      background: heatColor(30)
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      background: heatColor(50)
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      background: heatColor(70)
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      background: heatColor(90)
    }
  })), /*#__PURE__*/React.createElement("span", null, "High")));
};

// ───────── Firmware compliance ─────────
const FirmwareCompliance = () => {
  const fw = XIQ_FIRMWARE;
  const total = fw.versions.reduce((n, v) => n + v.count, 0);
  const compliant = fw.versions.find(v => v.status === "target")?.count || 0;
  const pct = total > 0 ? compliant / total * 100 : 0;
  return /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "Firmware Compliance"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "ext"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("span", {
    className: "h-tag"
  }, "target ", XIQ_TOTALS.firmware.target)), /*#__PURE__*/React.createElement("div", {
    className: "fw-grid"
  }, /*#__PURE__*/React.createElement(Ring, {
    value: pct,
    size: 140,
    color: "var(--ok)",
    label: `${pct.toFixed(1)}%`,
    sub: "on target"
  }), /*#__PURE__*/React.createElement("div", {
    className: "fw-list"
  }, fw.versions.map(v => {
    const pct = total > 0 ? v.count / total * 100 : 0;
    const color = v.status === "target" ? "var(--ok)" : v.status === "behind" ? "var(--warn)" : "var(--ext)";
    return /*#__PURE__*/React.createElement("div", {
      className: "fw-row " + v.status,
      key: v.v
    }, /*#__PURE__*/React.createElement("span", {
      className: "v"
    }, v.v), /*#__PURE__*/React.createElement("div", {
      className: "bar"
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        width: `${pct}%`,
        background: color
      }
    })), /*#__PURE__*/React.createElement("span", {
      className: "count"
    }, v.count), /*#__PURE__*/React.createElement("span", {
      className: "pill"
    }));
  }))), /*#__PURE__*/React.createElement("div", {
    className: "sites-legend",
    style: {
      paddingTop: 8,
      paddingBottom: 8
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "legend-item"
  }, /*#__PURE__*/React.createElement("span", {
    className: "legend-sw",
    style: {
      background: "var(--ok)",
      borderColor: "var(--ok)"
    }
  }), "Target"), /*#__PURE__*/React.createElement("span", {
    className: "legend-item"
  }, /*#__PURE__*/React.createElement("span", {
    className: "legend-sw",
    style: {
      background: "var(--warn)",
      borderColor: "var(--warn)"
    }
  }), "Behind"), /*#__PURE__*/React.createElement("span", {
    className: "legend-item"
  }, /*#__PURE__*/React.createElement("span", {
    className: "legend-sw",
    style: {
      background: "var(--ext)",
      borderColor: "var(--ext)"
    }
  }), "Ahead (canary)"), /*#__PURE__*/React.createElement("span", {
    className: "h-spacer",
    style: {
      flex: 1
    }
  }), /*#__PURE__*/React.createElement("span", {
    className: "legend-foot"
  }, "41 APs scheduled May 18 02:00\u201304:00")));
};

// ───────── Client mix (PHY + OS) ─────────
const ClientMix = () => {
  const m = XIQ_CLIENT_MIX;
  const osColors = ["var(--ext)", "var(--zbx)", "var(--info)", "var(--ok)", "var(--cx)", "var(--muted)"];
  return /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "Client Mix"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "ext"
  }), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "pf"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("span", {
    className: "h-meta"
  }, XIQ_TOTALS.clients.total.toLocaleString(), " associated")), /*#__PURE__*/React.createElement("div", {
    className: "mix-grid"
  }, /*#__PURE__*/React.createElement("div", {
    className: "mix-block"
  }, /*#__PURE__*/React.createElement("div", {
    className: "mix-block-h"
  }, "By PHY / standard"), /*#__PURE__*/React.createElement("div", {
    className: "mix-stack"
  }, m.standards.map(s => /*#__PURE__*/React.createElement("div", {
    key: s.id,
    title: `${s.label}: ${s.count.toLocaleString()} (${s.pct}%)`,
    style: {
      width: `${s.pct}%`,
      background: s.color
    }
  }))), /*#__PURE__*/React.createElement("div", {
    className: "mix-legend"
  }, m.standards.map(s => /*#__PURE__*/React.createElement("div", {
    className: "mix-legend-row",
    key: s.id
  }, /*#__PURE__*/React.createElement("span", {
    className: "sw",
    style: {
      background: s.color
    }
  }), /*#__PURE__*/React.createElement("span", {
    className: "l"
  }, s.label), /*#__PURE__*/React.createElement("span", {
    className: "c"
  }, s.count.toLocaleString()), /*#__PURE__*/React.createElement("span", {
    className: "p"
  }, s.pct.toFixed(1), "%"))))), /*#__PURE__*/React.createElement("div", {
    className: "mix-block"
  }, /*#__PURE__*/React.createElement("div", {
    className: "mix-block-h"
  }, "By operating system"), /*#__PURE__*/React.createElement("div", {
    className: "mix-stack"
  }, m.os.map((s, i) => /*#__PURE__*/React.createElement("div", {
    key: s.id,
    title: `${s.label}: ${s.count.toLocaleString()} (${s.pct}%)`,
    style: {
      width: `${s.pct}%`,
      background: osColors[i]
    }
  }))), /*#__PURE__*/React.createElement("div", {
    className: "mix-legend"
  }, m.os.map((s, i) => /*#__PURE__*/React.createElement("div", {
    className: "mix-legend-row",
    key: s.id
  }, /*#__PURE__*/React.createElement("span", {
    className: "sw",
    style: {
      background: osColors[i]
    }
  }), /*#__PURE__*/React.createElement("span", {
    className: "l"
  }, s.label), /*#__PURE__*/React.createElement("span", {
    className: "c"
  }, s.count.toLocaleString()), /*#__PURE__*/React.createElement("span", {
    className: "p"
  }, s.pct.toFixed(1), "%")))))));
};

// ───────── Roaming health ─────────
const RoamingHealth = () => {
  const r = XIQ_ROAMING;
  const total = r.buckets.reduce((a, b) => a + b.count, 0);
  return /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "Roaming Health"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "ext"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("span", {
    className: "h-meta"
  }, "last 1h \xB7 9,264 events")), /*#__PURE__*/React.createElement("div", {
    className: "roam-grid"
  }, /*#__PURE__*/React.createElement("div", {
    className: "roam-head"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "roam-head .h",
    style: {
      fontFamily: "var(--mono)",
      fontSize: 22,
      fontWeight: 600,
      color: "var(--ok)"
    }
  }, (100 - r.rate24h).toFixed(2), "%"), /*#__PURE__*/React.createElement("div", {
    className: "lbl"
  }, "roam success \xB7 24h")), /*#__PURE__*/React.createElement("div", {
    style: {
      marginLeft: "auto",
      textAlign: "right"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "var(--mono)",
      fontSize: 16,
      fontWeight: 600,
      color: "var(--err)"
    }
  }, r.rate24h.toFixed(2), "%"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: "var(--muted)"
    }
  }, "failure rate"))), /*#__PURE__*/React.createElement("div", {
    className: "roam-stack"
  }, r.buckets.map((b, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    title: `${b.range}: ${b.count.toLocaleString()}`,
    style: {
      width: `${total > 0 ? b.count / total * 100 : 0}%`,
      background: b.color,
      opacity: 0.85
    }
  }))), /*#__PURE__*/React.createElement("div", {
    className: "roam-legend"
  }, r.buckets.map((b, i) => /*#__PURE__*/React.createElement("div", {
    className: "roam-legend-row",
    key: i
  }, /*#__PURE__*/React.createElement("span", {
    className: "sw",
    style: {
      background: b.color
    }
  }), /*#__PURE__*/React.createElement("span", null, b.range), /*#__PURE__*/React.createElement("span", {
    className: "c"
  }, b.count.toLocaleString()))))));
};

// ───────── Events stream (reuses .events / .event styles) ─────────
const XIQEvents = () => /*#__PURE__*/React.createElement("div", {
  className: "events"
}, XIQ_EVENTS.map((e, i) => /*#__PURE__*/React.createElement("div", {
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

// ───────── Banner (error / rate-limit warning) ─────────
const XIQBanner = () => {
  const b = window.XIQ_BANNER;
  if (!b || !b.msg) return null;
  const bg = b.kind === "error" ? "rgba(242,95,92,0.14)" : "rgba(245,179,0,0.14)";
  const fg = b.kind === "error" ? "var(--err)" : "var(--warn)";
  const bd = b.kind === "error" ? "rgba(242,95,92,0.40)" : "rgba(245,179,0,0.40)";
  return /*#__PURE__*/React.createElement("div", {
    style: {
      margin: "10px 14px 0",
      padding: "10px 14px",
      borderRadius: 4,
      background: bg,
      border: `1px solid ${bd}`,
      color: fg,
      fontSize: 12,
      lineHeight: 1.45,
      display: "flex",
      alignItems: "center",
      gap: 10
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: b.kind === "error" ? "alert" : "alert",
    size: 14
  }), /*#__PURE__*/React.createElement("span", null, b.msg));
};

// ───────── App shell ─────────
const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "density": "balanced",
  "showSourceBadges": true,
  "siteFilter": "all",
  "expanded": "all"
} /*EDITMODE-END*/;
const App = () => {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [timeRange, setTimeRange] = useState("Last 1h");
  const [now, setNow] = useState("just now");
  const [, setTick] = useState(0);
  useEffect(() => {
    document.documentElement.classList.toggle("hide-src-badges", !t.showSourceBadges);
  }, [t.showSourceBadges]);

  // Re-render whenever xiq-bridge.jsx swaps in a fresh tcs.xiq.data payload.
  useEffect(() => {
    const onData = () => setTick(n => n + 1);
    window.addEventListener("tcs:xiq-data", onData);
    return () => window.removeEventListener("tcs:xiq-data", onData);
  }, []);
  return /*#__PURE__*/React.createElement("div", {
    className: "app",
    "data-density": t.density,
    "data-screen-label": "XIQ Wireless Status"
  }, /*#__PURE__*/React.createElement(GlobalSidebar, {
    active: "xiq"
  }), /*#__PURE__*/React.createElement("div", {
    className: "main"
  }, /*#__PURE__*/React.createElement(GlobalTopbar, {
    crumb: ["Tuscaloosa City Schools", "Wireless", "XIQ · Status"],
    search: "Find AP, SSID, BSSID, client MAC\u2026"
  }), /*#__PURE__*/React.createElement(XIQHeader, {
    now: now,
    timeRange: timeRange,
    setTimeRange: setTimeRange
  }), /*#__PURE__*/React.createElement(XIQBanner, null), /*#__PURE__*/React.createElement("div", {
    className: "body"
  }, /*#__PURE__*/React.createElement(KPIStrip, null), /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement(APSiteGrid, {
    filter: t.siteFilter,
    setFilter: v => setTweak("siteFilter", v)
  })), /*#__PURE__*/React.createElement("div", {
    className: "row",
    "data-xiq-row": true,
    style: {
      gridTemplateColumns: "1.4fr 1fr",
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "Broadcast SSIDs"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "ext"
  }), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "pf"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("a", {
    className: "h-link"
  }, "WLAN config ", /*#__PURE__*/React.createElement(Icon, {
    name: "external",
    size: 11
  }))), /*#__PURE__*/React.createElement("div", {
    className: "card-b tight"
  }, /*#__PURE__*/React.createElement(SSIDTable, null))), /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "Top Client APs"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("span", {
    className: "h-meta"
  }, "most connected clients")), /*#__PURE__*/React.createElement("div", {
    className: "card-b tight"
  }, /*#__PURE__*/React.createElement(TopClientAPList, null)))), /*#__PURE__*/React.createElement("div", {
    className: "row",
    "data-xiq-row": true,
    style: {
      gridTemplateColumns: "1.6fr 1fr",
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement(ChannelGrid, null), /*#__PURE__*/React.createElement(FirmwareCompliance, null)), /*#__PURE__*/React.createElement("div", {
    className: "row",
    "data-xiq-row": true,
    style: {
      gridTemplateColumns: "1.4fr 1fr",
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement(ClientMix, null), /*#__PURE__*/React.createElement(RoamingHealth, null)), /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "XIQ \xB7 Recent Events"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "ext"
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
  }, /*#__PURE__*/React.createElement(XIQEvents, null))))), /*#__PURE__*/React.createElement(TweaksPanel, {
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
    label: "Show source badges (EXT/ZBX/PF)",
    value: t.showSourceBadges,
    onChange: v => setTweak("showSourceBadges", v)
  })), /*#__PURE__*/React.createElement(TweakSection, {
    label: "Filters"
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
      label: "Healthy"
    }],
    onChange: v => setTweak("siteFilter", v)
  })), /*#__PURE__*/React.createElement(TweakSection, {
    label: "Quick actions"
  }, /*#__PURE__*/React.createElement(TweakButton, {
    label: "Refresh now",
    onClick: () => {
      setNow(new Date().toLocaleTimeString());
      if (window.tcsXiqRefresh) window.tcsXiqRefresh();
    }
  }), /*#__PURE__*/React.createElement(TweakButton, {
    label: "Schedule firmware",
    secondary: true,
    onClick: () => console.info("[tcs] firmware schedule action not wired yet — see tcs.xiq.action TODO")
  }))));
};
ReactDOM.createRoot(document.getElementById("root")).render(/*#__PURE__*/React.createElement(App, null));