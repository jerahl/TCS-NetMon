// Servers dashboard widgets

const {
  useState: useStateSV
} = React;

// ───────── Server Host Navigator ─────────
const ServerNavigator = ({
  activeId,
  onSelect,
  query,
  setQuery
}) => {
  const [sites, setSites] = useStateSV(window.SERVER_SITES);
  const toggle = idx => setSites(sites.map((s, i) => i === idx ? {
    ...s,
    expanded: !s.expanded
  } : s));
  const q = (query || "").trim().toLowerCase();
  const total = sites.reduce((n, s) => n + s.servers.length, 0);
  const totalProb = sites.reduce((n, s) => n + s.problems, 0);
  return /*#__PURE__*/React.createElement("div", {
    className: "card ap-nav-card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "Server Navigator"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("span", {
    className: "h-meta"
  }, total, " hosts")), /*#__PURE__*/React.createElement("div", {
    className: "ap-nav-search"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "search",
    size: 12
  }), /*#__PURE__*/React.createElement("input", {
    placeholder: "Filter by host, ip, role\u2026",
    value: query || "",
    onChange: e => setQuery(e.target.value),
    spellCheck: false
  }), query ? /*#__PURE__*/React.createElement("span", {
    className: "ap-nav-clear",
    onClick: () => setQuery("")
  }, "\xD7") : null), /*#__PURE__*/React.createElement("div", {
    className: "ap-nav-summary"
  }, /*#__PURE__*/React.createElement("span", null, /*#__PURE__*/React.createElement("b", {
    style: {
      color: "var(--ok)"
    }
  }, total - totalProb), " healthy"), /*#__PURE__*/React.createElement("span", {
    className: "dot-sep"
  }, "\xB7"), /*#__PURE__*/React.createElement("span", null, /*#__PURE__*/React.createElement("b", {
    style: {
      color: "var(--warn)"
    }
  }, totalProb), " with triggers"), /*#__PURE__*/React.createElement("span", {
    className: "dot-sep"
  }, "\xB7"), /*#__PURE__*/React.createElement("span", null, /*#__PURE__*/React.createElement("b", null, sites.length), " sites")), /*#__PURE__*/React.createElement("div", {
    className: "ap-nav"
  }, sites.map((site, i) => {
    const matched = q ? site.servers.filter(sv => sv.id.toLowerCase().includes(q) || sv.ip.toLowerCase().includes(q) || sv.role.toLowerCase().includes(q) || site.name.toLowerCase().includes(q)) : site.servers;
    if (q && matched.length === 0) return null;
    const expanded = q ? true : site.expanded;
    return /*#__PURE__*/React.createElement("div", {
      className: "ap-nav-section",
      key: site.id
    }, /*#__PURE__*/React.createElement("div", {
      className: "ap-nav-site" + (expanded ? "" : " collapsed"),
      onClick: () => !q && toggle(i)
    }, /*#__PURE__*/React.createElement("svg", {
      className: "caret",
      viewBox: "0 0 16 16",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: "1.6",
      strokeLinecap: "round",
      strokeLinejoin: "round"
    }, /*#__PURE__*/React.createElement("path", {
      d: "m4 6 4 4 4-4"
    })), /*#__PURE__*/React.createElement("span", {
      className: "site-name"
    }, site.name), /*#__PURE__*/React.createElement("span", {
      className: "site-count"
    }, matched.length), site.problems > 0 && /*#__PURE__*/React.createElement("span", {
      className: "site-prob"
    }, site.problems)), /*#__PURE__*/React.createElement("div", {
      className: "ap-nav-children" + (expanded ? "" : " hidden")
    }, matched.map(sv => {
      const dotColor = sv.status === "ok" ? "var(--ok)" : sv.status === "warn" ? "var(--warn)" : "var(--err)";
      return /*#__PURE__*/React.createElement("div", {
        key: sv.id,
        className: "ap-nav-host" + (sv.id === activeId ? " active" : ""),
        onClick: () => onSelect(sv),
        title: `${sv.id} · ${sv.ip} · ${sv.role}`
      }, /*#__PURE__*/React.createElement("span", {
        className: "ap-led",
        style: {
          background: dotColor,
          boxShadow: sv.status === "ok" ? `0 0 4px ${dotColor}` : "none"
        }
      }), /*#__PURE__*/React.createElement("div", {
        className: "ap-meta-col"
      }, /*#__PURE__*/React.createElement("div", {
        className: "ap-id"
      }, sv.id), /*#__PURE__*/React.createElement("div", {
        className: "ap-sub"
      }, sv.role, " \xB7 ", sv.kind === "phys" ? "phys" : "vm")), /*#__PURE__*/React.createElement("div", {
        className: "ap-cli"
      }, /*#__PURE__*/React.createElement("div", {
        className: "n"
      }, sv.cpu, /*#__PURE__*/React.createElement("span", {
        style: {
          fontSize: 9,
          color: "var(--muted)"
        }
      }, "%")), /*#__PURE__*/React.createElement("div", {
        className: "u"
      }, "cpu")), sv.problems > 0 && /*#__PURE__*/React.createElement("span", {
        className: "ap-prob"
      }, sv.problems));
    })));
  })));
};

// ───────── KPI strip for selected host ─────────
const ServerKPIs = ({
  host
}) => {
  const H = window.ACTIVE_SERVER_HISTORY;
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
  }, "CPU \xB7 1m"), /*#__PURE__*/React.createElement("div", {
    className: "val " + (host.cpu > 60 ? "warn" : "ok")
  }, host.cpu, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 11,
      color: "var(--muted)",
      fontWeight: 500
    }
  }, "%")), /*#__PURE__*/React.createElement(Sparkline, {
    data: H.cpu1m,
    color: "var(--info)",
    width: 120,
    height: 20,
    threshold: 80
  })), /*#__PURE__*/React.createElement("div", {
    className: "swstat-cell"
  }, /*#__PURE__*/React.createElement("div", {
    className: "lbl"
  }, "Memory"), /*#__PURE__*/React.createElement("div", {
    className: "val " + (host.mem > 80 ? "warn" : "ok")
  }, host.mem, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 11,
      color: "var(--muted)",
      fontWeight: 500
    }
  }, "% / ", host.ram, "G")), /*#__PURE__*/React.createElement(Sparkline, {
    data: H.memUsed,
    color: "var(--zbx)",
    width: 120,
    height: 20,
    threshold: 85
  })), /*#__PURE__*/React.createElement("div", {
    className: "swstat-cell"
  }, /*#__PURE__*/React.createElement("div", {
    className: "lbl"
  }, "Disk I/O \xB7 MB/s"), /*#__PURE__*/React.createElement("div", {
    className: "val"
  }, Math.round(H.diskRead.at(-1) + H.diskWrite.at(-1)), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 11,
      color: "var(--muted)",
      fontWeight: 500
    }
  }, " MB/s")), /*#__PURE__*/React.createElement(Sparkline, {
    data: H.diskRead,
    color: "var(--warn)",
    width: 120,
    height: 20
  })), /*#__PURE__*/React.createElement("div", {
    className: "swstat-cell"
  }, /*#__PURE__*/React.createElement("div", {
    className: "lbl"
  }, "Net In / Out"), /*#__PURE__*/React.createElement("div", {
    className: "val"
  }, host.netMbps, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 11,
      color: "var(--muted)",
      fontWeight: 500
    }
  }, " Mbps")), /*#__PURE__*/React.createElement(Sparkline, {
    data: H.netIn,
    color: "var(--ok)",
    width: 120,
    height: 20
  })), /*#__PURE__*/React.createElement("div", {
    className: "swstat-cell"
  }, /*#__PURE__*/React.createElement("div", {
    className: "lbl"
  }, "Load avg \xB7 1m"), /*#__PURE__*/React.createElement("div", {
    className: "val"
  }, H.load1m.at(-1).toFixed(2)), /*#__PURE__*/React.createElement(Sparkline, {
    data: H.load1m,
    color: "var(--pf)",
    width: 120,
    height: 20
  })), /*#__PURE__*/React.createElement("div", {
    className: "swstat-cell"
  }, /*#__PURE__*/React.createElement("div", {
    className: "lbl"
  }, "Uptime"), /*#__PURE__*/React.createElement("div", {
    className: "val ok"
  }, host.uptimeDays, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 11,
      color: "var(--muted)",
      fontWeight: 500
    }
  }, "d")), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10,
      color: "var(--ok)",
      fontFamily: "var(--mono)"
    }
  }, "\u25CF agent2 v6.4.7"))));
};

// ───────── Server hero / sidecar (left of body) ─────────
const ServerSidecar = ({
  host
}) => /*#__PURE__*/React.createElement("div", {
  className: "card device-card"
}, /*#__PURE__*/React.createElement("div", {
  className: "device-hero"
}, /*#__PURE__*/React.createElement("div", {
  className: "status-line"
}, /*#__PURE__*/React.createElement(StatusDot, {
  state: host.status
}), /*#__PURE__*/React.createElement("span", {
  style: {
    color: host.status === "ok" ? "var(--ok)" : host.status === "warn" ? "var(--warn)" : "var(--err)"
  }
}, host.status === "ok" ? "Online" : host.status === "warn" ? "Degraded" : "Critical"), /*#__PURE__*/React.createElement("span", {
  className: "muted",
  style: {
    marginLeft: 6
  }
}, "\xB7 ", host.uptimeDays, "d up")), /*#__PURE__*/React.createElement("div", {
  className: "device-img"
}, /*#__PURE__*/React.createElement("svg", {
  width: "120",
  height: "48",
  viewBox: "0 0 120 48"
}, /*#__PURE__*/React.createElement("rect", {
  x: "2",
  y: "6",
  width: "116",
  height: "36",
  rx: "2",
  fill: "#1c2230",
  stroke: "#2c3650",
  strokeWidth: "1"
}), [0, 1, 2, 3, 4, 5, 6, 7].map(i => /*#__PURE__*/React.createElement("rect", {
  key: i,
  x: 6 + i * 13,
  y: "10",
  width: "11",
  height: "28",
  rx: "0.5",
  fill: "#0f1320",
  stroke: "#2c3650",
  strokeWidth: "0.6"
})), /*#__PURE__*/React.createElement("circle", {
  cx: "112",
  cy: "14",
  r: "1.4",
  fill: "var(--ok)"
}), /*#__PURE__*/React.createElement("circle", {
  cx: "112",
  cy: "20",
  r: "1.4",
  fill: "var(--ok)"
}), /*#__PURE__*/React.createElement("circle", {
  cx: "112",
  cy: "26",
  r: "1.4",
  fill: "#2c3650"
}), /*#__PURE__*/React.createElement("circle", {
  cx: "112",
  cy: "32",
  r: "1.4",
  fill: host.status === "ok" ? "#2c3650" : "var(--warn)"
}), /*#__PURE__*/React.createElement("circle", {
  cx: "6",
  cy: "10",
  r: "1",
  fill: "#2c3650"
}), /*#__PURE__*/React.createElement("circle", {
  cx: "6",
  cy: "38",
  r: "1",
  fill: "#2c3650"
}))), /*#__PURE__*/React.createElement("div", {
  className: "device-name"
}, host.id), /*#__PURE__*/React.createElement("div", {
  className: "uptime"
}, host.fqdn)), /*#__PURE__*/React.createElement("div", {
  className: "location-block"
}, /*#__PURE__*/React.createElement("div", {
  className: "label"
}, "Hardware"), /*#__PURE__*/React.createElement("div", {
  className: "v"
}, host.model, /*#__PURE__*/React.createElement("br", null), /*#__PURE__*/React.createElement("span", {
  style: {
    fontFamily: "var(--mono)",
    fontSize: 11
  }
}, host.cores, " cores \xB7 ", host.ram, " GB RAM \xB7 ", host.diskTb, " TB disk"))), /*#__PURE__*/React.createElement("div", {
  className: "location-block"
}, /*#__PURE__*/React.createElement("div", {
  className: "label"
}, "OS / Role"), /*#__PURE__*/React.createElement("div", {
  className: "v"
}, host.os, /*#__PURE__*/React.createElement("br", null), /*#__PURE__*/React.createElement("span", {
  style: {
    color: "var(--accent)",
    fontSize: 11
  }
}, host.role))), /*#__PURE__*/React.createElement("div", {
  className: "location-block"
}, /*#__PURE__*/React.createElement("div", {
  className: "label"
}, "Network"), /*#__PURE__*/React.createElement("div", {
  className: "v",
  style: {
    fontFamily: "var(--mono)",
    fontSize: 11
  }
}, host.ip, /*#__PURE__*/React.createElement("br", null), "iDRAC \xB7 10.24.99.", host.id.endsWith("01") ? "20" : "21", /*#__PURE__*/React.createElement("br", null), "VLAN 24 \xB7 Gateway 10.24.0.1")), /*#__PURE__*/React.createElement("div", {
  className: "device-actions"
}, /*#__PURE__*/React.createElement("button", {
  className: "btn primary"
}, /*#__PURE__*/React.createElement(Icon, {
  name: "external",
  size: 12
}), " RDP"), /*#__PURE__*/React.createElement("button", {
  className: "btn"
}, /*#__PURE__*/React.createElement(Icon, {
  name: "external",
  size: 12
}), " SSH"), /*#__PURE__*/React.createElement("button", {
  className: "btn ghost"
}, /*#__PURE__*/React.createElement(Icon, {
  name: "more",
  size: 12
}))), /*#__PURE__*/React.createElement("div", {
  className: "location-block"
}, /*#__PURE__*/React.createElement("div", {
  className: "label"
}, "Zabbix Templates"), /*#__PURE__*/React.createElement("div", {
  className: "v",
  style: {
    display: "flex",
    flexDirection: "column",
    gap: 4
  }
}, /*#__PURE__*/React.createElement("span", {
  style: {
    fontFamily: "var(--mono)",
    fontSize: 11
  }
}, "\u2022 Windows by Zabbix agent 2"), /*#__PURE__*/React.createElement("span", {
  style: {
    fontFamily: "var(--mono)",
    fontSize: 11
  }
}, "\u2022 MS SQL by ODBC"), /*#__PURE__*/React.createElement("span", {
  style: {
    fontFamily: "var(--mono)",
    fontSize: 11
  }
}, "\u2022 Dell iDRAC9 by SNMP"), /*#__PURE__*/React.createElement("span", {
  style: {
    fontFamily: "var(--mono)",
    fontSize: 11
  }
}, "\u2022 ICMP Ping"))));

// ───────── Filesystems ─────────
const FilesystemsCard = () => {
  const fs = window.ACTIVE_SERVER_FS;
  return /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "Filesystems"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("span", {
    className: "h-meta"
  }, "vfs.fs.size \xB7 60s poll")), /*#__PURE__*/React.createElement("table", {
    className: "link-tbl"
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", {
    style: {
      width: 180
    }
  }, "Mount"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 60
    }
  }, "FS"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 90,
      textAlign: "right"
    }
  }, "Size"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 90,
      textAlign: "right"
    }
  }, "Free"), /*#__PURE__*/React.createElement("th", null, "Used"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 70,
      textAlign: "right"
    }
  }, "Latency"))), /*#__PURE__*/React.createElement("tbody", null, fs.map(f => /*#__PURE__*/React.createElement("tr", {
    key: f.mount
  }, /*#__PURE__*/React.createElement("td", {
    className: "fg",
    style: {
      color: "var(--accent)",
      fontFamily: "var(--mono)"
    }
  }, f.mount), /*#__PURE__*/React.createElement("td", null, f.fs), /*#__PURE__*/React.createElement("td", {
    style: {
      textAlign: "right"
    }
  }, f.sizeGb >= 1024 ? `${(f.sizeGb / 1024).toFixed(1)} TB` : `${f.sizeGb} GB`), /*#__PURE__*/React.createElement("td", {
    style: {
      textAlign: "right"
    }
  }, f.freeGb >= 1024 ? `${(f.freeGb / 1024).toFixed(1)} TB` : `${f.freeGb} GB`), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("span", {
    className: "util-bar"
  }, /*#__PURE__*/React.createElement("i", {
    className: f.usedPct > 85 ? "err" : f.usedPct > 70 ? "warn" : "",
    style: {
      width: `${Math.max(2, f.usedPct)}%`
    }
  })), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--mono)",
      fontSize: 11,
      color: f.usedPct > 85 ? "var(--err)" : f.usedPct > 70 ? "var(--warn)" : "var(--fg)"
    }
  }, f.usedPct, "%")), /*#__PURE__*/React.createElement("td", {
    style: {
      textAlign: "right",
      color: f.latMs > 2 ? "var(--warn)" : "var(--muted)"
    }
  }, f.latMs, " ms"))))));
};

// ───────── Services / processes table ─────────
const ServicesCard = () => {
  const items = window.ACTIVE_SERVER_SERVICES;
  return /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "Services"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("span", {
    className: "h-meta"
  }, items.filter(i => i.state === "running").length, " running \xB7 ", items.filter(i => i.state !== "running").length, " stopped")), /*#__PURE__*/React.createElement("table", {
    className: "link-tbl"
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", {
    style: {
      width: 12
    }
  }), /*#__PURE__*/React.createElement("th", null, "Service"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 70
    }
  }, "State"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 60
    }
  }, "Start"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 60,
      textAlign: "right"
    }
  }, "PID"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 70,
      textAlign: "right"
    }
  }, "CPU%"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 80,
      textAlign: "right"
    }
  }, "Mem MB"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 130
    }
  }, "Since"))), /*#__PURE__*/React.createElement("tbody", null, items.map(s => /*#__PURE__*/React.createElement("tr", {
    key: s.name
  }, /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement(StatusDot, {
    state: s.state === "running" ? "ok" : "err"
  })), /*#__PURE__*/React.createElement("td", {
    className: "fg",
    style: {
      color: "var(--fg)",
      fontFamily: "var(--mono)",
      fontSize: 11.5
    }
  }, s.name, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 9.5,
      color: "var(--muted)"
    }
  }, s.check)), /*#__PURE__*/React.createElement("td", {
    style: {
      color: s.state === "running" ? "var(--ok)" : "var(--err)",
      fontFamily: "var(--mono)",
      fontSize: 11
    }
  }, s.state), /*#__PURE__*/React.createElement("td", {
    style: {
      color: s.auto ? "var(--fg)" : "var(--muted)"
    }
  }, s.auto ? "auto" : "manual"), /*#__PURE__*/React.createElement("td", {
    style: {
      textAlign: "right",
      fontFamily: "var(--mono)"
    }
  }, s.pid ?? "—"), /*#__PURE__*/React.createElement("td", {
    style: {
      textAlign: "right",
      fontFamily: "var(--mono)"
    }
  }, s.cpu.toFixed(1)), /*#__PURE__*/React.createElement("td", {
    style: {
      textAlign: "right",
      fontFamily: "var(--mono)"
    }
  }, s.mem.toFixed(1)), /*#__PURE__*/React.createElement("td", {
    style: {
      fontSize: 10.5,
      color: "var(--muted)"
    }
  }, s.since))))));
};

// ───────── Sessions / processes ─────────
const TopProcsCard = () => {
  const items = window.ACTIVE_SERVER_PROCS;
  return /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "Top processes by CPU"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("span", {
    className: "h-meta"
  }, "proc.cpu.util \xB7 30s")), /*#__PURE__*/React.createElement("table", {
    className: "link-tbl"
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", null, "Process"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 160
    }
  }, "User"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 90,
      textAlign: "right"
    }
  }, "CPU%"), /*#__PURE__*/React.createElement("th", null, "RAM (MB)"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 70,
      textAlign: "right"
    }
  }, "Threads"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 70,
      textAlign: "right"
    }
  }, "PID"))), /*#__PURE__*/React.createElement("tbody", null, items.map(p => /*#__PURE__*/React.createElement("tr", {
    key: p.pid
  }, /*#__PURE__*/React.createElement("td", {
    className: "fg",
    style: {
      color: "var(--accent)",
      fontFamily: "var(--mono)"
    }
  }, p.name), /*#__PURE__*/React.createElement("td", {
    style: {
      fontFamily: "var(--mono)",
      fontSize: 11
    }
  }, p.user), /*#__PURE__*/React.createElement("td", {
    style: {
      textAlign: "right",
      fontFamily: "var(--mono)",
      color: p.cpu > 15 ? "var(--warn)" : "var(--fg)"
    }
  }, p.cpu.toFixed(1)), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("span", {
    className: "util-bar"
  }, /*#__PURE__*/React.createElement("i", {
    style: {
      width: `${Math.min(100, p.mem / 2)}%`
    }
  })), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--mono)",
      fontSize: 11
    }
  }, p.mem.toFixed(1))), /*#__PURE__*/React.createElement("td", {
    style: {
      textAlign: "right",
      fontFamily: "var(--mono)"
    }
  }, p.threads), /*#__PURE__*/React.createElement("td", {
    style: {
      textAlign: "right",
      fontFamily: "var(--mono)",
      color: "var(--muted)"
    }
  }, p.pid))))));
};

// ───────── Network interfaces ─────────
const InterfacesCard = () => {
  const items = window.ACTIVE_SERVER_IFACES;
  return /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "Network interfaces"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("span", {
    className: "h-meta"
  }, "net.if.in/out \xB7 30s")), /*#__PURE__*/React.createElement("table", {
    className: "link-tbl"
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", {
    style: {
      width: 12
    }
  }), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 90
    }
  }, "Name"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 80
    }
  }, "Speed"), /*#__PURE__*/React.createElement("th", null, "IP"), /*#__PURE__*/React.createElement("th", null, "MAC"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 100,
      textAlign: "right"
    }
  }, "RX Mbps"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 100,
      textAlign: "right"
    }
  }, "TX Mbps"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 60,
      textAlign: "right"
    }
  }, "Err"))), /*#__PURE__*/React.createElement("tbody", null, items.map(n => /*#__PURE__*/React.createElement("tr", {
    key: n.name
  }, /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement(StatusDot, {
    state: n.status === "up" ? "ok" : "err"
  })), /*#__PURE__*/React.createElement("td", {
    className: "fg",
    style: {
      color: "var(--accent)",
      fontFamily: "var(--mono)"
    }
  }, n.name), /*#__PURE__*/React.createElement("td", {
    style: {
      fontFamily: "var(--mono)"
    }
  }, n.speed >= 1000 ? `${n.speed / 1000}G` : `${n.speed}M`), /*#__PURE__*/React.createElement("td", {
    style: {
      fontFamily: "var(--mono)",
      fontSize: 11
    }
  }, n.ip), /*#__PURE__*/React.createElement("td", {
    style: {
      fontFamily: "var(--mono)",
      fontSize: 10.5,
      color: "var(--muted)"
    }
  }, n.mac), /*#__PURE__*/React.createElement("td", {
    style: {
      textAlign: "right",
      fontFamily: "var(--mono)"
    }
  }, n.inMbps), /*#__PURE__*/React.createElement("td", {
    style: {
      textAlign: "right",
      fontFamily: "var(--mono)"
    }
  }, n.outMbps), /*#__PURE__*/React.createElement("td", {
    style: {
      textAlign: "right",
      color: n.errs > 0 ? "var(--warn)" : "var(--muted)",
      fontFamily: "var(--mono)"
    }
  }, n.errs))))));
};

// ───────── Sessions card ─────────
const SessionsCard = () => {
  const items = window.ACTIVE_SERVER_SESSIONS;
  return /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "Active sessions"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("span", {
    className: "h-meta"
  }, items.length, " sessions")), /*#__PURE__*/React.createElement("table", {
    className: "link-tbl"
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", null, "User"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 130
    }
  }, "Source"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 70
    }
  }, "Type"), /*#__PURE__*/React.createElement("th", null, "Database"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 130
    }
  }, "Started"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 90
    }
  }, "State"), /*#__PURE__*/React.createElement("th", null, "Wait"))), /*#__PURE__*/React.createElement("tbody", null, items.map((s, i) => /*#__PURE__*/React.createElement("tr", {
    key: i
  }, /*#__PURE__*/React.createElement("td", {
    className: "fg",
    style: {
      color: "var(--fg)",
      fontFamily: "var(--mono)",
      fontSize: 11.5
    }
  }, s.user), /*#__PURE__*/React.createElement("td", {
    style: {
      fontFamily: "var(--mono)",
      fontSize: 11
    }
  }, s.src), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("span", {
    className: "role-tag " + (s.type === "TDS" ? "av" : s.type === "RDP" ? "faculty" : "byod"),
    style: {
      fontSize: 10
    }
  }, s.type)), /*#__PURE__*/React.createElement("td", {
    style: {
      fontFamily: "var(--mono)",
      fontSize: 11
    }
  }, s.db), /*#__PURE__*/React.createElement("td", {
    style: {
      fontSize: 10.5,
      color: "var(--muted)"
    }
  }, s.start), /*#__PURE__*/React.createElement("td", {
    style: {
      color: s.state === "RUNNING" || s.state === "ACTIVE" ? "var(--ok)" : "var(--muted)",
      fontFamily: "var(--mono)",
      fontSize: 11
    }
  }, s.state), /*#__PURE__*/React.createElement("td", {
    style: {
      fontFamily: "var(--mono)",
      fontSize: 10.5,
      color: s.waits === "—" ? "var(--muted)" : "var(--warn)"
    }
  }, s.waits))))));
};

// ───────── Server problems ─────────
const ServerProblems = () => {
  const items = window.SERVER_PROBLEMS;
  return /*#__PURE__*/React.createElement("div", {
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
  }, "Triggers \xB7 last 24h"), /*#__PURE__*/React.createElement("div", null, items.map((p, i) => /*#__PURE__*/React.createElement("div", {
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
  }, p.ts, p.ack && " · ack")))));
};

// ───────── Fleet overview cards (small status tiles) ─────────
const FleetOverview = ({
  activeId,
  onSelect
}) => {
  const all = window.SERVER_SITES.flatMap(s => s.servers.map(sv => ({
    ...sv,
    site: s.name
  })));
  const ok = all.filter(s => s.status === "ok").length;
  const warn = all.filter(s => s.status === "warn").length;
  const err = all.filter(s => s.status === "err").length;
  return /*#__PURE__*/React.createElement("div", {
    className: "card",
    style: {
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "Fleet"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("span", {
    className: "h-meta"
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--ok)"
    }
  }, "\u25CF ", ok, " online"), /*#__PURE__*/React.createElement("span", {
    style: {
      marginLeft: 8,
      color: "var(--warn)"
    }
  }, "\u25CF ", warn, " degraded"), /*#__PURE__*/React.createElement("span", {
    style: {
      marginLeft: 8,
      color: "var(--err)"
    }
  }, "\u25CF ", err, " critical"))), /*#__PURE__*/React.createElement("div", {
    className: "srv-grid"
  }, all.map(sv => {
    const dot = sv.status === "ok" ? "var(--ok)" : sv.status === "warn" ? "var(--warn)" : "var(--err)";
    return /*#__PURE__*/React.createElement("div", {
      key: sv.id,
      className: "srv-tile" + (sv.id === activeId ? " active" : ""),
      onClick: () => onSelect(sv)
    }, /*#__PURE__*/React.createElement("div", {
      className: "srv-tile-h"
    }, /*#__PURE__*/React.createElement("span", {
      className: "dot",
      style: {
        background: dot,
        boxShadow: sv.status === "ok" ? `0 0 4px ${dot}` : "none"
      }
    }), /*#__PURE__*/React.createElement("span", {
      className: "srv-id"
    }, sv.id), /*#__PURE__*/React.createElement("span", {
      className: "srv-kind " + sv.kind
    }, sv.kind === "phys" ? "PHYS" : "VM")), /*#__PURE__*/React.createElement("div", {
      className: "srv-role"
    }, sv.role), /*#__PURE__*/React.createElement("div", {
      className: "srv-bars"
    }, /*#__PURE__*/React.createElement("div", {
      className: "srv-bar"
    }, /*#__PURE__*/React.createElement("span", {
      className: "lbl"
    }, "CPU"), /*#__PURE__*/React.createElement("span", {
      className: "track"
    }, /*#__PURE__*/React.createElement("i", {
      style: {
        width: `${sv.cpu}%`,
        background: sv.cpu > 75 ? "var(--warn)" : "var(--info)"
      }
    })), /*#__PURE__*/React.createElement("span", {
      className: "num"
    }, sv.cpu, "%")), /*#__PURE__*/React.createElement("div", {
      className: "srv-bar"
    }, /*#__PURE__*/React.createElement("span", {
      className: "lbl"
    }, "MEM"), /*#__PURE__*/React.createElement("span", {
      className: "track"
    }, /*#__PURE__*/React.createElement("i", {
      style: {
        width: `${sv.mem}%`,
        background: sv.mem > 80 ? "var(--warn)" : "var(--zbx)"
      }
    })), /*#__PURE__*/React.createElement("span", {
      className: "num"
    }, sv.mem, "%")), /*#__PURE__*/React.createElement("div", {
      className: "srv-bar"
    }, /*#__PURE__*/React.createElement("span", {
      className: "lbl"
    }, "DSK"), /*#__PURE__*/React.createElement("span", {
      className: "track"
    }, /*#__PURE__*/React.createElement("i", {
      style: {
        width: `${sv.diskPct}%`,
        background: sv.diskPct > 80 ? "var(--warn)" : "var(--ok)"
      }
    })), /*#__PURE__*/React.createElement("span", {
      className: "num"
    }, sv.diskPct, "%"))));
  })));
};
window.ServerNavigator = ServerNavigator;
window.ServerKPIs = ServerKPIs;
window.ServerSidecar = ServerSidecar;
window.FilesystemsCard = FilesystemsCard;
window.ServicesCard = ServicesCard;
window.TopProcsCard = TopProcsCard;
window.InterfacesCard = InterfacesCard;
window.SessionsCard = SessionsCard;
window.ServerProblems = ServerProblems;
window.FleetOverview = FleetOverview;