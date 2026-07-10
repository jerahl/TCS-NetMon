// Server / DVR detail panel — single recording server deep dive

const ServerDetail = () => {
  const params = new URLSearchParams(location.search);
  const id = params.get("id") || "tcs-rec-bhs-01";
  const s = window.SERVERS.find(x => x.id === id) || window.SERVERS[0];
  const H = window.SERVER_HISTORY;
  const [tab, setTab] = React.useState("overview");
  const isMgmt = s.role === "Management Server";
  const isFailover = s.role === "Failover";
  const stateColor = s.disk > 90 || s.cpu > 80 ? "var(--warn)" : "var(--ok)";
  const stateLabel = s.disk > 90 || s.cpu > 80 ? "Degraded" : "Healthy";

  // Synthesize disk array — 24 disks
  const disks = Array.from({
    length: 24
  }, (_, i) => {
    let st = "ok";
    if (s.raid === "warn" && i === 3) st = "rebuild";
    if (s.id === "tcs-rec-ws-01" && i === 17) st = "warn";
    return {
      idx: i + 1,
      size: "8 TB",
      state: st
    };
  });

  // Synthesize channel grid — `s.chans` cells
  const chanCount = s.chans;
  const failedChans = s.chans - s.recording;
  return /*#__PURE__*/React.createElement("div", {
    className: "app"
  }, /*#__PURE__*/React.createElement(NVRSidebar, {
    active: "nvr-servers"
  }), /*#__PURE__*/React.createElement("div", {
    className: "main"
  }, /*#__PURE__*/React.createElement(NVRTopbar, {
    crumb: ["Surveillance", "Recording Servers", s.site, s.id]
  }), /*#__PURE__*/React.createElement("div", {
    className: "page-header"
  }, /*#__PURE__*/React.createElement("div", {
    className: "icon-btn",
    style: {
      marginTop: 4
    },
    onClick: () => history.back()
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "back"
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "host-title"
  }, /*#__PURE__*/React.createElement("h1", null, s.id), /*#__PURE__*/React.createElement("span", {
    className: "ip"
  }, s.ip), /*#__PURE__*/React.createElement("span", {
    className: "role-tag faculty",
    style: {
      fontSize: 10,
      padding: "1px 8px"
    }
  }, s.role)), /*#__PURE__*/React.createElement("div", {
    className: "host-meta"
  }, /*#__PURE__*/React.createElement("span", {
    className: "pill"
  }, /*#__PURE__*/React.createElement("span", {
    className: "dot",
    style: {
      background: stateColor
    }
  }), " ", stateLabel), /*#__PURE__*/React.createElement("span", {
    className: "pill"
  }, /*#__PURE__*/React.createElement("span", {
    className: "lbl"
  }, "Site"), " ", /*#__PURE__*/React.createElement("span", null, s.site)), /*#__PURE__*/React.createElement("span", {
    className: "pill"
  }, /*#__PURE__*/React.createElement("span", {
    className: "lbl"
  }, "OS"), " ", /*#__PURE__*/React.createElement("span", null, s.os)), /*#__PURE__*/React.createElement("span", {
    className: "pill"
  }, /*#__PURE__*/React.createElement("span", {
    className: "lbl"
  }, "Uptime"), " ", /*#__PURE__*/React.createElement("span", {
    className: "v"
  }, s.uptimeD, "d")), /*#__PURE__*/React.createElement("span", {
    className: "pill"
  }, /*#__PURE__*/React.createElement("span", {
    className: "lbl"
  }, "Agent"), " ", /*#__PURE__*/React.createElement("span", {
    className: "v"
  }, s.agent)), /*#__PURE__*/React.createElement("span", {
    className: "pill"
  }, /*#__PURE__*/React.createElement("span", {
    className: "lbl"
  }, "Last backup"), " ", /*#__PURE__*/React.createElement("span", {
    className: "v"
  }, s.lastBackup)))), /*#__PURE__*/React.createElement("div", {
    className: "timerange"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "calendar"
  }), /*#__PURE__*/React.createElement("span", {
    className: "range-val"
  }, "last 24h"), /*#__PURE__*/React.createElement(Icon, {
    name: "chevron"
  }))), /*#__PURE__*/React.createElement("div", {
    className: "tabs"
  }, [["overview", "Overview"], ["channels", "Channels"], ["storage", "Storage"], ["network", "Network"], ["events", "Events"], ["config", "Configuration"]].map(([k, l]) => /*#__PURE__*/React.createElement("div", {
    key: k,
    className: "tab " + (tab === k ? "active" : ""),
    onClick: () => setTab(k)
  }, l))), /*#__PURE__*/React.createElement("div", {
    className: "body",
    "data-screen-label": `Server · ${s.id}`
  }, /*#__PURE__*/React.createElement(DemoBanner, {
    name: "Recording Server Detail"
  }), /*#__PURE__*/React.createElement("div", {
    className: "card",
    style: {
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "stat-grid",
    style: {
      gridTemplateColumns: "repeat(6, 1fr)"
    }
  }, /*#__PURE__*/React.createElement(KPI, {
    lbl: "CPU",
    v: s.cpu,
    unit: "%",
    sub: `load avg ${(s.cpu / 100 * 4).toFixed(2)}`,
    src: "zbx",
    warn: s.cpu > 80
  }), /*#__PURE__*/React.createElement(KPI, {
    lbl: "Memory",
    v: s.mem,
    unit: "%",
    sub: "48 GB / 96 GB",
    src: "zbx",
    warn: s.mem > 85
  }), /*#__PURE__*/React.createElement(KPI, {
    lbl: "Disk Avg",
    v: s.disk,
    unit: "%",
    sub: s.raid === "warn" ? "RAID rebuild active" : "RAID 6 healthy",
    src: "zbx",
    warn: s.disk > 85
  }), /*#__PURE__*/React.createElement(KPI, {
    lbl: "Net In",
    v: "1.6",
    unit: "Gbps",
    sub: `${s.recording} streams`,
    src: "zbx"
  }), /*#__PURE__*/React.createElement(KPI, {
    lbl: "Recording",
    v: `${s.recording}`,
    unit: `/ ${s.chans}`,
    sub: failedChans > 0 ? `${failedChans} not recording` : "all channels",
    src: "ext",
    warn: failedChans > 0
  }), /*#__PURE__*/React.createElement(KPI, {
    lbl: "Archive Lag",
    v: s.archiveLagH,
    unit: "h",
    sub: s.archiveLagH > 1 ? "behind schedule" : "on schedule",
    src: "ext",
    warn: s.archiveLagH > 1
  }))), /*#__PURE__*/React.createElement("div", {
    className: "row",
    style: {
      gridTemplateColumns: "1.6fr 1fr",
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "Resource Utilization \xB7 24h"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("span", {
    className: "h-meta"
  }, "zabbix-agent2 \xB7 60s items")), /*#__PURE__*/React.createElement("div", {
    className: "bigchart"
  }, /*#__PURE__*/React.createElement(DualChart, {
    a: H.cpu,
    b: H.mem,
    aLabel: "CPU %",
    bLabel: "Memory %",
    aColor: "var(--zbx)",
    bColor: "var(--info)"
  })), /*#__PURE__*/React.createElement("div", {
    className: "spark-strip",
    style: {
      borderTop: "1px solid var(--line)"
    }
  }, /*#__PURE__*/React.createElement(SparkCellM, {
    label: "Disk Write",
    v: 138,
    unit: "MB/s",
    data: H.diskWrite,
    color: "var(--ok)"
  }), /*#__PURE__*/React.createElement(SparkCellM, {
    label: "Disk Read",
    v: 42,
    unit: "MB/s",
    data: H.diskRead,
    color: "var(--info)"
  }), /*#__PURE__*/React.createElement(SparkCellM, {
    label: "Net In",
    v: 1620,
    unit: "Mbps",
    data: H.netIn,
    color: "var(--zbx)"
  }), /*#__PURE__*/React.createElement(SparkCellM, {
    label: "Net Out",
    v: 140,
    unit: "Mbps",
    data: H.netOut,
    color: "var(--pf)"
  }))), /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "Server Health"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("span", {
    className: "h-meta"
  }, "IPMI + WMI")), /*#__PURE__*/React.createElement("div", {
    className: "health-grid",
    style: {
      gridTemplateColumns: "repeat(2,1fr)"
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "health-cell"
  }, /*#__PURE__*/React.createElement(Ring, {
    value: s.cpu,
    max: 100,
    label: `${s.cpu}%`,
    sub: "cpu",
    color: s.cpu > 80 ? "var(--warn)" : "var(--zbx)"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-label"
  }, "CPU \xB7 2\xD7 Xeon Gold 6326")), /*#__PURE__*/React.createElement("div", {
    className: "health-cell"
  }, /*#__PURE__*/React.createElement(Ring, {
    value: s.mem,
    max: 100,
    label: `${s.mem}%`,
    sub: "mem",
    color: s.mem > 85 ? "var(--warn)" : "var(--info)"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-label"
  }, "Memory \xB7 96 GB DDR4")), /*#__PURE__*/React.createElement("div", {
    className: "health-cell"
  }, /*#__PURE__*/React.createElement(Ring, {
    value: s.disk,
    max: 100,
    label: `${s.disk}%`,
    sub: "disk",
    color: s.disk > 85 ? "var(--warn)" : "var(--ok)"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-label"
  }, "RAID 6 \xB7 192 TB raw")), /*#__PURE__*/React.createElement("div", {
    className: "health-cell"
  }, /*#__PURE__*/React.createElement(Ring, {
    value: 42,
    max: 75,
    label: "42\xB0",
    sub: "C",
    color: "var(--ok)"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-label"
  }, "Inlet temperature"))))), !isMgmt && !isFailover && /*#__PURE__*/React.createElement("div", {
    className: "card",
    style: {
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "Recording Channels"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "ext"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("div", {
    className: "summary-badge"
  }, /*#__PURE__*/React.createElement("b", null, s.recording), /*#__PURE__*/React.createElement("span", null, "/ ", s.chans, " recording")), failedChans > 0 && /*#__PURE__*/React.createElement("div", {
    className: "summary-badge"
  }, /*#__PURE__*/React.createElement("b", {
    style: {
      color: "var(--err)"
    }
  }, failedChans), /*#__PURE__*/React.createElement("span", null, "not recording"))), /*#__PURE__*/React.createElement("div", {
    className: "chan-grid"
  }, Array.from({
    length: chanCount
  }, (_, i) => {
    let st = "ok";
    if (i < failedChans) st = "err";else if (i < failedChans + 2) st = "warn";
    return /*#__PURE__*/React.createElement("div", {
      key: i,
      className: `chan-cell ${st}`,
      title: `Channel ${i + 1}`
    });
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "8px 14px",
      borderTop: "1px solid var(--line)",
      display: "flex",
      gap: 14,
      fontSize: 11,
      color: "var(--muted)"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      display: "inline-flex",
      alignItems: "center",
      gap: 6
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 10,
      height: 10,
      borderRadius: 2,
      background: "rgba(52,211,153,0.55)",
      border: "1px solid rgba(52,211,153,0.7)"
    }
  }), "recording"), /*#__PURE__*/React.createElement("span", {
    style: {
      display: "inline-flex",
      alignItems: "center",
      gap: 6
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 10,
      height: 10,
      borderRadius: 2,
      background: "rgba(245,179,0,0.7)"
    }
  }), "warning"), /*#__PURE__*/React.createElement("span", {
    style: {
      display: "inline-flex",
      alignItems: "center",
      gap: 6
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 10,
      height: 10,
      borderRadius: 2,
      background: "rgba(242,95,92,0.7)"
    }
  }), "not recording"))), /*#__PURE__*/React.createElement("div", {
    className: "row",
    style: {
      gridTemplateColumns: "1.3fr 1fr",
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "RAID Array \xB7 24 \xD7 8 TB SAS"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("span", {
    className: "h-meta"
  }, s.raid === "warn" ? "1 disk rebuilding · ETA 9h 14m" : "all disks healthy · last scrub 12d ago")), /*#__PURE__*/React.createElement("div", {
    className: "disk-grid"
  }, disks.map(d => /*#__PURE__*/React.createElement("div", {
    key: d.idx,
    className: `disk-cell ${d.state}`
  }, /*#__PURE__*/React.createElement("div", {
    className: "label"
  }, "D", String(d.idx).padStart(2, "0")), /*#__PURE__*/React.createElement("div", {
    className: "size"
  }, d.size)))), /*#__PURE__*/React.createElement("div", {
    className: "kv tight",
    style: {
      borderTop: "1px solid var(--line)"
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "k"
  }, "Logical volumes"), /*#__PURE__*/React.createElement("div", {
    className: "v"
  }, "D:\\Recording (180 TB) \xB7 E:\\Archive (40 TB)"), /*#__PURE__*/React.createElement("div", {
    className: "b"
  }, /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  })), /*#__PURE__*/React.createElement("div", {
    className: "k"
  }, "Capacity used"), /*#__PURE__*/React.createElement("div", {
    className: "v"
  }, s.disk, "% \xB7 ~", (180 * s.disk / 100).toFixed(0), " TB of 180 TB recording"), /*#__PURE__*/React.createElement("div", {
    className: "b"
  }, /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  })), /*#__PURE__*/React.createElement("div", {
    className: "k"
  }, "Scrub schedule"), /*#__PURE__*/React.createElement("div", {
    className: "v"
  }, "Sundays 02:00 \xB7 last completed 12 days ago"), /*#__PURE__*/React.createElement("div", {
    className: "b"
  }, /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  })), /*#__PURE__*/React.createElement("div", {
    className: "k"
  }, "Hot spares"), /*#__PURE__*/React.createElement("div", {
    className: "v"
  }, "2 available \xB7 0 used"), /*#__PURE__*/React.createElement("div", {
    className: "b"
  }, /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  })))), /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "System Information"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  })), /*#__PURE__*/React.createElement("div", {
    className: "kv"
  }, /*#__PURE__*/React.createElement("div", {
    className: "k"
  }, "Hostname"), /*#__PURE__*/React.createElement("div", {
    className: "v"
  }, s.id), /*#__PURE__*/React.createElement("div", {
    className: "b"
  }, /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  })), /*#__PURE__*/React.createElement("div", {
    className: "k"
  }, "FQDN"), /*#__PURE__*/React.createElement("div", {
    className: "v"
  }, s.id, ".tcs.local"), /*#__PURE__*/React.createElement("div", {
    className: "b"
  }, /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  })), /*#__PURE__*/React.createElement("div", {
    className: "k"
  }, "Role"), /*#__PURE__*/React.createElement("div", {
    className: "v"
  }, s.role), /*#__PURE__*/React.createElement("div", {
    className: "b"
  }, /*#__PURE__*/React.createElement(SourceBadge, {
    src: "ext"
  })), /*#__PURE__*/React.createElement("div", {
    className: "k"
  }, "Site"), /*#__PURE__*/React.createElement("div", {
    className: "v"
  }, s.site), /*#__PURE__*/React.createElement("div", {
    className: "b"
  }, /*#__PURE__*/React.createElement(SourceBadge, {
    src: "ext"
  })), /*#__PURE__*/React.createElement("div", {
    className: "k"
  }, "OS"), /*#__PURE__*/React.createElement("div", {
    className: "v"
  }, s.os), /*#__PURE__*/React.createElement("div", {
    className: "b"
  }, /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  })), /*#__PURE__*/React.createElement("div", {
    className: "k"
  }, "CPU"), /*#__PURE__*/React.createElement("div", {
    className: "v"
  }, "2\xD7 Intel Xeon Gold 6326 (32c/64t)"), /*#__PURE__*/React.createElement("div", {
    className: "b"
  }, /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  })), /*#__PURE__*/React.createElement("div", {
    className: "k"
  }, "RAM"), /*#__PURE__*/React.createElement("div", {
    className: "v"
  }, "96 GB DDR4-3200 ECC"), /*#__PURE__*/React.createElement("div", {
    className: "b"
  }, /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  })), /*#__PURE__*/React.createElement("div", {
    className: "k"
  }, "Chassis"), /*#__PURE__*/React.createElement("div", {
    className: "v"
  }, "Dell PowerEdge R750xs \xB7 SVC TAG ASDF", s.id.slice(-3).toUpperCase()), /*#__PURE__*/React.createElement("div", {
    className: "b"
  }, /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  })), /*#__PURE__*/React.createElement("div", {
    className: "k"
  }, "Agent"), /*#__PURE__*/React.createElement("div", {
    className: "v"
  }, s.agent), /*#__PURE__*/React.createElement("div", {
    className: "b"
  }, /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  })), /*#__PURE__*/React.createElement("div", {
    className: "k"
  }, "Uptime"), /*#__PURE__*/React.createElement("div", {
    className: "v"
  }, s.uptimeD, " days"), /*#__PURE__*/React.createElement("div", {
    className: "b"
  }, /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  })), /*#__PURE__*/React.createElement("div", {
    className: "k"
  }, "Last patch"), /*#__PURE__*/React.createElement("div", {
    className: "v"
  }, "2026-04-18 \xB7 KB5036893"), /*#__PURE__*/React.createElement("div", {
    className: "b"
  }, /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  })), /*#__PURE__*/React.createElement("div", {
    className: "k"
  }, "XProtect ver"), /*#__PURE__*/React.createElement("div", {
    className: "v"
  }, window.MILESTONE.version), /*#__PURE__*/React.createElement("div", {
    className: "b"
  }, /*#__PURE__*/React.createElement(SourceBadge, {
    src: "ext"
  }))))), /*#__PURE__*/React.createElement("div", {
    className: "row",
    style: {
      gridTemplateColumns: "1fr 1.6fr",
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "Network Interfaces"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  })), /*#__PURE__*/React.createElement("table", {
    className: "tbl"
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", null, "iface"), /*#__PURE__*/React.createElement("th", null, "state"), /*#__PURE__*/React.createElement("th", null, "speed"), /*#__PURE__*/React.createElement("th", null, "in"), /*#__PURE__*/React.createElement("th", null, "out"), /*#__PURE__*/React.createElement("th", null, "err"))), /*#__PURE__*/React.createElement("tbody", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("td", {
    className: "fg"
  }, "Ten1 (uplink)"), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement(StatusDot, {
    state: "up"
  }), " UP"), /*#__PURE__*/React.createElement("td", null, "10 Gbps"), /*#__PURE__*/React.createElement("td", null, "1.62 Gbps"), /*#__PURE__*/React.createElement("td", null, "140 Mbps"), /*#__PURE__*/React.createElement("td", null, "0")), /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("td", {
    className: "fg"
  }, "Ten2 (lag)"), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement(StatusDot, {
    state: "up"
  }), " UP"), /*#__PURE__*/React.createElement("td", null, "10 Gbps"), /*#__PURE__*/React.createElement("td", null, "1.58 Gbps"), /*#__PURE__*/React.createElement("td", null, "132 Mbps"), /*#__PURE__*/React.createElement("td", null, "0")), /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("td", {
    className: "fg"
  }, "Mgmt (iDRAC)"), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement(StatusDot, {
    state: "up"
  }), " UP"), /*#__PURE__*/React.createElement("td", null, "1 Gbps"), /*#__PURE__*/React.createElement("td", null, "0.4 Mbps"), /*#__PURE__*/React.createElement("td", null, "0.1 Mbps"), /*#__PURE__*/React.createElement("td", null, "0")))), /*#__PURE__*/React.createElement("div", {
    className: "kv tight",
    style: {
      borderTop: "1px solid var(--line)"
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "k"
  }, "VLAN"), /*#__PURE__*/React.createElement("div", {
    className: "v"
  }, "61 (recording) \xB7 99 (mgmt)"), /*#__PURE__*/React.createElement("div", {
    className: "b"
  }), /*#__PURE__*/React.createElement("div", {
    className: "k"
  }, "LLDP neighbor"), /*#__PURE__*/React.createElement("div", {
    className: "v"
  }, "DC-CORE-SW01 \xB7 Po12"), /*#__PURE__*/React.createElement("div", {
    className: "b"
  }), /*#__PURE__*/React.createElement("div", {
    className: "k"
  }, "DNS"), /*#__PURE__*/React.createElement("div", {
    className: "v"
  }, "10.10.1.177 \xB7 10.10.1.178"), /*#__PURE__*/React.createElement("div", {
    className: "b"
  }), /*#__PURE__*/React.createElement("div", {
    className: "k"
  }, "NTP drift"), /*#__PURE__*/React.createElement("div", {
    className: "v"
  }, "3 ms (in spec)"), /*#__PURE__*/React.createElement("div", {
    className: "b"
  }))), /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "Cameras on this server"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "ext"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("span", {
    className: "h-meta"
  }, window.CAMERAS.filter(c => c.server === s.id).length, " of ", s.chans, " shown")), /*#__PURE__*/React.createElement("table", {
    className: "tbl"
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", null, "Status"), /*#__PURE__*/React.createElement("th", null, "Camera"), /*#__PURE__*/React.createElement("th", null, "Location"), /*#__PURE__*/React.createElement("th", null, "Resolution"), /*#__PURE__*/React.createElement("th", null, "FPS"), /*#__PURE__*/React.createElement("th", null, "Bitrate"), /*#__PURE__*/React.createElement("th", null, "Recording"), /*#__PURE__*/React.createElement("th", null))), /*#__PURE__*/React.createElement("tbody", null, window.CAMERAS.filter(c => c.server === s.id).map(c => /*#__PURE__*/React.createElement("tr", {
    key: c.id,
    style: {
      cursor: "pointer"
    },
    onClick: () => location.href = c.hostid ? `zabbix.php?action=tcs.camera.view&hostid=${c.hostid}` : `zabbix.php?action=tcs.camera.view&id=${encodeURIComponent(c.id)}`
  }, /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement(StatusDot, {
    state: c.state === "err" ? "err" : c.state === "warn" ? "warn" : "ok"
  })), /*#__PURE__*/React.createElement("td", {
    className: "fg",
    style: {
      color: "var(--accent)"
    }
  }, c.id), /*#__PURE__*/React.createElement("td", null, c.loc), /*#__PURE__*/React.createElement("td", null, c.res), /*#__PURE__*/React.createElement("td", null, c.fps || "—"), /*#__PURE__*/React.createElement("td", null, c.bitrate ? `${(c.bitrate / 1000).toFixed(1)} Mbps` : "—"), /*#__PURE__*/React.createElement("td", null, c.recording), /*#__PURE__*/React.createElement("td", {
    style: {
      textAlign: "right"
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "chevron",
    size: 12
  })))), window.CAMERAS.filter(c => c.server === s.id).length === 0 && /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("td", {
    colSpan: "8",
    style: {
      textAlign: "center",
      color: "var(--muted)",
      padding: 24
    }
  }, "No cameras directly assigned (management/failover server)")))))), /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "Recent Events"), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("span", {
    className: "h-meta"
  }, "Zabbix triggers + XProtect log")), /*#__PURE__*/React.createElement("div", {
    className: "events"
  }, /*#__PURE__*/React.createElement(CamEvent, {
    ts: "09:14:09",
    src: "ZBX",
    sev: "info",
    msg: `zabbix-agent2 heartbeat OK (${s.agent})`
  }), /*#__PURE__*/React.createElement(CamEvent, {
    ts: "08:42:30",
    src: "EXT",
    sev: "info",
    msg: "Daily archive task completed \xB7 142 GB written"
  }), s.disk > 85 && /*#__PURE__*/React.createElement(CamEvent, {
    ts: "07:55:18",
    src: "ZBX",
    sev: "warning",
    msg: `Disk usage ${s.disk}% above 85% threshold`
  }), s.raid === "warn" && /*#__PURE__*/React.createElement(CamEvent, {
    ts: "08:12:00",
    src: "ZBX",
    sev: "warning",
    msg: "RAID rebuild started \xB7 disk slot 4 replaced"
  }), /*#__PURE__*/React.createElement(CamEvent, {
    ts: "06:00:00",
    src: "ZBX",
    sev: "info",
    msg: "Daily smartctl scan: all disks pass"
  }), /*#__PURE__*/React.createElement(CamEvent, {
    ts: "Yesterday 23:48",
    src: "EXT",
    sev: "info",
    msg: "XProtect Recording Server service restart (scheduled)"
  }), /*#__PURE__*/React.createElement(CamEvent, {
    ts: "Yesterday 18:14",
    src: "ZBX",
    sev: "info",
    msg: "Patch compliance check: KB5036893 installed"
  }))))));
};
const KPI = ({
  lbl,
  v,
  unit,
  sub,
  src,
  warn
}) => /*#__PURE__*/React.createElement("div", {
  className: "stat-cell"
}, /*#__PURE__*/React.createElement("div", {
  className: "lbl"
}, lbl, " ", /*#__PURE__*/React.createElement(SourceBadge, {
  src: src || "zbx"
})), /*#__PURE__*/React.createElement("div", {
  className: "val",
  style: warn ? {
    color: "var(--warn)"
  } : {}
}, v, /*#__PURE__*/React.createElement("span", {
  className: "u"
}, unit)), /*#__PURE__*/React.createElement("div", {
  className: "sub " + (warn ? "warn" : "")
}, sub));
const DualChart = ({
  a,
  b,
  aLabel,
  bLabel,
  aColor,
  bColor
}) => {
  const w = 800,
    h = 160;
  const stepX = w / (a.length - 1);
  const path = data => {
    const lo = 0,
      hi = 100;
    const pts = data.map((v, i) => [i * stepX, h - 20 - (v - lo) / (hi - lo) * (h - 40)]);
    return pts.map((p, i) => i === 0 ? `M${p[0]},${p[1]}` : `L${p[0]},${p[1]}`).join(" ");
  };
  return /*#__PURE__*/React.createElement("svg", {
    viewBox: `0 0 ${w} ${h}`,
    preserveAspectRatio: "none"
  }, [0.25, 0.5, 0.75].map(p => /*#__PURE__*/React.createElement("line", {
    key: p,
    x1: "0",
    x2: w,
    y1: 20 + p * (h - 40),
    y2: 20 + p * (h - 40),
    stroke: "var(--line)",
    strokeDasharray: "3 3",
    strokeWidth: "0.5"
  })), /*#__PURE__*/React.createElement("path", {
    d: path(a),
    fill: "none",
    stroke: aColor,
    strokeWidth: "1.5",
    strokeLinejoin: "round"
  }), /*#__PURE__*/React.createElement("path", {
    d: path(b),
    fill: "none",
    stroke: bColor,
    strokeWidth: "1.5",
    strokeLinejoin: "round",
    strokeDasharray: "3 2"
  }), /*#__PURE__*/React.createElement("text", {
    x: "6",
    y: "14",
    fontSize: "10",
    fontFamily: "var(--mono)",
    fill: aColor
  }, "\u25CF ", aLabel), /*#__PURE__*/React.createElement("text", {
    x: "100",
    y: "14",
    fontSize: "10",
    fontFamily: "var(--mono)",
    fill: bColor
  }, "--- ", bLabel));
};
ReactDOM.createRoot(document.getElementById("root")).render(/*#__PURE__*/React.createElement(ServerDetail, null));