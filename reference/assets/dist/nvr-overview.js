// Surveillance NOC Overview dashboard widgets

// Grid thumbnails are fetched through the server-side snapshot proxy
// (zabbix.php?action=tcs.camera.snapshot), which injects the shared
// read-only camera login so the password never reaches the browser.
// JpegSize accepts S / M / L / XL or an exact "WxH"; M (352x288 CIF) keeps
// the grid light while staying legible.
const CAM_SNAPSHOT_JPEGSIZE = "M";

// Defensive defaults — if surveillance-bridge.jsx hasn't published yet
// (cache race, fetch error, …) every read here falls back to 0 / "" so
// no .toFixed / .toLocaleString throws on undefined.
const _OV_MS_DEFAULTS = {
  product: "—",
  version: "—",
  managementServer: "—",
  licenseDeviceTotal: 0,
  licenseDeviceUsed: 0,
  licenseHwTotal: 0,
  recordingServers: 0,
  recordingServersOnline: 0,
  failoverServers: 0,
  mobileServers: 0,
  smartClientSessions: 0,
  webClientSessions: 0,
  activeAlarms: 0,
  alarmsAck: 0,
  retentionDays: 0,
  storageTotalTB: 0,
  storageUsedTB: 0,
  evidenceLockSlots: 0,
  evidenceLockUsed: 0
};
const _OV_HISTORY_KEYS = ["totalIngressGbps", "storageWriteMBps", "recordingServersCpu", "camerasOnline", "alarmsPerHour", "archiveLagMin"];
const _ovZ = n => {
  const a = new Array(n);
  for (let i = 0; i < n; i++) a[i] = 0;
  return a;
};
const _ovHist = () => {
  const h = Object.assign({}, window.FLEET_HISTORY || {});
  for (const k of _OV_HISTORY_KEYS) if (!Array.isArray(h[k]) || !h[k].length) h[k] = _ovZ(48);
  return h;
};
const _ovNz = (v, d = 0) => typeof v === "number" && !Number.isNaN(v) ? v : d;
const FleetWidgets = () => {
  const M = Object.assign({}, _OV_MS_DEFAULTS, window.MILESTONE || {});
  const H = _ovHist();
  const SITES = Array.isArray(window.SITES) ? window.SITES : [];
  const SERVERS = Array.isArray(window.SERVERS) ? window.SERVERS : [];
  const CAMERAS = Array.isArray(window.CAMERAS) ? window.CAMERAS : [];
  const ALARMS = Array.isArray(window.VMS_ALARMS) ? window.VMS_ALARMS : [];
  const totalCams = SITES.reduce((s, x) => s + _ovNz(x.cams), 0);
  const onlineCams = SITES.reduce((s, x) => s + _ovNz(x.online), 0);
  const warnCams = SITES.reduce((s, x) => s + _ovNz(x.warn), 0);
  const errCams = SITES.reduce((s, x) => s + _ovNz(x.err), 0);
  const licensePct = M.licenseDeviceTotal > 0 ? M.licenseDeviceUsed / M.licenseDeviceTotal * 100 : 0;

  // Tail-of-series helpers so spark-cells show their actual last value.
  const tail = arr => Array.isArray(arr) && arr.length ? arr[arr.length - 1] : 0;
  const sum = arr => Array.isArray(arr) ? arr.reduce((a, b) => a + (Number(b) || 0), 0) : 0;

  // Alarm-severity breakdown from local snapshot.
  const alarmSev = ALARMS.reduce((acc, a) => {
    acc[a.sev] = (acc[a.sev] || 0) + 1;
    return acc;
  }, {});
  const alarmSubline = [alarmSev.disaster ? `${alarmSev.disaster} disaster` : null, alarmSev.high ? `${alarmSev.high} high` : null, alarmSev.warning ? `${alarmSev.warning} warning` : null, alarmSev.info ? `${alarmSev.info} info` : null].filter(Boolean).join(" · ") || "no active alarms";
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "card",
    style: {
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "stat-grid"
  }, /*#__PURE__*/React.createElement("div", {
    className: "stat-cell"
  }, /*#__PURE__*/React.createElement("div", {
    className: "lbl"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "ap",
    size: 11
  }), " Cameras Online ", /*#__PURE__*/React.createElement(SourceBadge, {
    src: "ext"
  })), /*#__PURE__*/React.createElement("div", {
    className: "val"
  }, onlineCams.toLocaleString(), /*#__PURE__*/React.createElement("span", {
    className: "u"
  }, "/ ", totalCams.toLocaleString())), /*#__PURE__*/React.createElement("div", {
    className: "sub ok"
  }, warnCams, " warn \xB7 ", errCams, " offline")), /*#__PURE__*/React.createElement("div", {
    className: "stat-cell"
  }, /*#__PURE__*/React.createElement("div", {
    className: "lbl"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "ethernet",
    size: 11
  }), " Recording Servers ", /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  })), /*#__PURE__*/React.createElement("div", {
    className: "val"
  }, M.recordingServersOnline, /*#__PURE__*/React.createElement("span", {
    className: "u"
  }, "/ ", M.recordingServers, M.failoverServers > 0 ? ` +${M.failoverServers} failover` : "")), /*#__PURE__*/React.createElement("div", {
    className: "sub " + (M.recordingServers === 0 ? "" : M.recordingServersOnline === M.recordingServers ? "ok" : "warn")
  }, M.recordingServers === 0 ? "no recording servers discovered" : M.recordingServersOnline === M.recordingServers ? "all online" : `${M.recordingServers - M.recordingServersOnline} offline`)), /*#__PURE__*/React.createElement("div", {
    className: "stat-cell"
  }, /*#__PURE__*/React.createElement("div", {
    className: "lbl"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "alert",
    size: 11
  }), " Active VMS Alarms ", /*#__PURE__*/React.createElement(SourceBadge, {
    src: "ext"
  })), /*#__PURE__*/React.createElement("div", {
    className: "val",
    style: {
      color: M.activeAlarms > 0 ? "var(--err)" : "var(--ok)"
    }
  }, M.activeAlarms, /*#__PURE__*/React.createElement("span", {
    className: "u",
    style: {
      color: "var(--muted)"
    }
  }, M.alarmsAck > 0 ? `· ${M.alarmsAck} ack` : "")), /*#__PURE__*/React.createElement("div", {
    className: "sub " + (M.activeAlarms > 0 ? "warn" : "ok")
  }, alarmSubline)), /*#__PURE__*/React.createElement("div", {
    className: "stat-cell"
  }, /*#__PURE__*/React.createElement("div", {
    className: "lbl"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "user",
    size: 11
  }), " Smart Client Sessions ", /*#__PURE__*/React.createElement(SourceBadge, {
    src: "ext"
  })), /*#__PURE__*/React.createElement("div", {
    className: "val"
  }, M.smartClientSessions, /*#__PURE__*/React.createElement("span", {
    className: "u"
  }, "+ ", M.webClientSessions, " web")), /*#__PURE__*/React.createElement("div", {
    className: "sub"
  }, M.evidenceLockUsed, " / ", M.evidenceLockSlots, " evidence locks active")))), /*#__PURE__*/React.createElement("div", {
    className: "row",
    style: {
      gridTemplateColumns: "1.1fr 1.4fr",
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "Milestone XProtect"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "ext"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("span", {
    className: "h-meta"
  }, M.product)), /*#__PURE__*/React.createElement("div", {
    className: "card-b",
    style: {
      display: "flex",
      flexDirection: "column",
      gap: 14
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "storage-bar"
  }, /*#__PURE__*/React.createElement("div", {
    className: "label-row"
  }, /*#__PURE__*/React.createElement("span", {
    className: "name"
  }, "Device licenses"), /*#__PURE__*/React.createElement("span", {
    className: "pct"
  }, M.licenseDeviceUsed, " / ", M.licenseDeviceTotal)), /*#__PURE__*/React.createElement("div", {
    className: "track"
  }, /*#__PURE__*/React.createElement("div", {
    className: "fill " + (licensePct > 95 ? "warn" : ""),
    style: {
      width: `${licensePct}%`
    }
  })))), /*#__PURE__*/React.createElement("div", {
    className: "kv tight",
    style: {
      borderTop: "1px solid var(--line)"
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "k"
  }, "Mgmt server"), /*#__PURE__*/React.createElement("div", {
    className: "v"
  }, M.managementServer), /*#__PURE__*/React.createElement("div", {
    className: "b"
  }, /*#__PURE__*/React.createElement(StatusDot, {
    state: "ok"
  })), /*#__PURE__*/React.createElement("div", {
    className: "k"
  }, "Recording srvs"), /*#__PURE__*/React.createElement("div", {
    className: "v"
  }, M.recordingServersOnline, " / ", M.recordingServers, " online"), /*#__PURE__*/React.createElement("div", {
    className: "b"
  }, /*#__PURE__*/React.createElement(StatusDot, {
    state: "ok"
  })), /*#__PURE__*/React.createElement("div", {
    className: "k"
  }, "Failover srvs"), /*#__PURE__*/React.createElement("div", {
    className: "v"
  }, M.failoverServers, " standby"), /*#__PURE__*/React.createElement("div", {
    className: "b"
  }, /*#__PURE__*/React.createElement(StatusDot, {
    state: "ok"
  })), /*#__PURE__*/React.createElement("div", {
    className: "k"
  }, "Mobile srv"), /*#__PURE__*/React.createElement("div", {
    className: "v"
  }, M.mobileServers, " \xB7 ", M.smartClientSessions + M.webClientSessions, " sessions"), /*#__PURE__*/React.createElement("div", {
    className: "b"
  }, /*#__PURE__*/React.createElement(StatusDot, {
    state: "ok"
  })), /*#__PURE__*/React.createElement("div", {
    className: "k"
  }, "Retention"), /*#__PURE__*/React.createElement("div", {
    className: "v"
  }, M.retentionDays, " days standard"), /*#__PURE__*/React.createElement("div", {
    className: "b"
  }, /*#__PURE__*/React.createElement(SourceBadge, {
    src: "ext"
  })), /*#__PURE__*/React.createElement("div", {
    className: "k"
  }, "Evidence lock"), /*#__PURE__*/React.createElement("div", {
    className: "v"
  }, M.evidenceLockUsed, " / ", M.evidenceLockSlots, " active"), /*#__PURE__*/React.createElement("div", {
    className: "b"
  }, /*#__PURE__*/React.createElement(SourceBadge, {
    src: "ext"
  }))))), /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "Live Ingress \xB7 24h"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("span", {
    className: "h-meta"
  }, "aggregated across ", M.recordingServers, " recording servers")), /*#__PURE__*/React.createElement("div", {
    className: "bigchart"
  }, /*#__PURE__*/React.createElement(FleetChart, {
    data: H.totalIngressGbps,
    label: "Ingress",
    unit: "Gbps",
    max: 3,
    color: "var(--zbx)"
  })), /*#__PURE__*/React.createElement("div", {
    className: "spark-strip",
    style: {
      borderTop: "1px solid var(--line)"
    }
  }, /*#__PURE__*/React.createElement(SparkCellM, {
    label: "Storage Write",
    v: tail(H.storageWriteMBps),
    unit: "MB/s",
    data: H.storageWriteMBps,
    color: "var(--info)"
  }), /*#__PURE__*/React.createElement(SparkCellM, {
    label: "Avg CPU (rec srvs)",
    v: tail(H.recordingServersCpu),
    unit: "%",
    data: H.recordingServersCpu,
    color: "var(--pf)"
  }), /*#__PURE__*/React.createElement(SparkCellM, {
    label: "Cameras Online",
    v: onlineCams,
    unit: "",
    data: H.camerasOnline,
    color: "var(--ok)"
  }), /*#__PURE__*/React.createElement(SparkCellM, {
    label: "Alarms / hr",
    v: sum(H.alarmsPerHour) > 0 ? (sum(H.alarmsPerHour) / 24).toFixed(1) : 0,
    unit: "",
    data: H.alarmsPerHour,
    color: "var(--warn)"
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
  }, /*#__PURE__*/React.createElement("h3", null, "Sites"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "ext"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("span", {
    className: "h-meta"
  }, "click to drill into a site")), /*#__PURE__*/React.createElement("div", null, SITES.map(s => {
    const pct = s.storageGB / s.storageCapGB * 100;
    return /*#__PURE__*/React.createElement("div", {
      className: "site-row",
      key: s.name
    }, /*#__PURE__*/React.createElement("div", {
      className: "site-name"
    }, /*#__PURE__*/React.createElement(StatusDot, {
      state: s.err ? "err" : s.warn ? "warn" : "ok"
    }), " ", s.name), /*#__PURE__*/React.createElement("div", {
      className: "cam-counts"
    }, /*#__PURE__*/React.createElement("span", {
      className: "ok"
    }, s.online), " / ", s.cams), /*#__PURE__*/React.createElement("div", {
      className: "cam-counts"
    }, s.warn > 0 && /*#__PURE__*/React.createElement("span", {
      className: "warn"
    }, s.warn, "w "), s.err > 0 && /*#__PURE__*/React.createElement("span", {
      className: "err"
    }, s.err, "e"), s.warn === 0 && s.err === 0 && /*#__PURE__*/React.createElement("span", {
      className: "muted"
    }, "no issues")), /*#__PURE__*/React.createElement("div", {
      className: "storage-bar compact"
    }, /*#__PURE__*/React.createElement("div", {
      className: "label-row"
    }, /*#__PURE__*/React.createElement("span", {
      className: "name muted",
      style: {
        fontFamily: "var(--mono)",
        fontSize: 10
      }
    }, s.server), /*#__PURE__*/React.createElement("span", {
      className: "pct"
    }, pct.toFixed(0), "%")), /*#__PURE__*/React.createElement("div", {
      className: "track"
    }, /*#__PURE__*/React.createElement("div", {
      className: "fill " + (pct > 90 ? "err" : pct > 80 ? "warn" : ""),
      style: {
        width: `${pct}%`
      }
    }))), /*#__PURE__*/React.createElement("div", {
      style: {
        textAlign: "right",
        color: "var(--muted)"
      }
    }, /*#__PURE__*/React.createElement(Icon, {
      name: "chevron",
      size: 12
    })));
  }))), /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "Recording Servers"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("span", {
    className: "h-meta"
  }, "zabbix-agent2 + Milestone WMI plugin")), /*#__PURE__*/React.createElement("div", {
    className: "stat-grid",
    style: {
      gridTemplateColumns: "repeat(2, 1fr)"
    }
  }, SERVERS.filter(s => s.role !== "Failover").slice(0, 6).map(s => /*#__PURE__*/React.createElement(ServerMini, {
    key: s.id,
    s: s
  }))))), /*#__PURE__*/React.createElement("div", {
    className: "card",
    style: {
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "Active Alarm Feed"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "ext"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("span", {
    className: "h-meta"
  }, "XProtect alarms + Zabbix triggers \xB7 last 24h"), /*#__PURE__*/React.createElement("span", {
    className: "h-link"
  }, "Open full alarm log ", /*#__PURE__*/React.createElement(Icon, {
    name: "external",
    size: 11
  }))), /*#__PURE__*/React.createElement("div", null, ALARMS.map((a, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    className: "alarm-row " + (a.ack ? "ack" : "")
  }, /*#__PURE__*/React.createElement("div", {
    className: "ts"
  }, a.ts), /*#__PURE__*/React.createElement(Sev, {
    level: a.sev
  }), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("span", {
    className: `sev-dot ${a.sev}`
  })), /*#__PURE__*/React.createElement("div", {
    className: "obj",
    onClick: () => {
      if (a.hostid) {
        location.href = `zabbix.php?action=tcs.camera.view&hostid=${a.hostid}`;
        return;
      }
      if (a.cam) location.href = `zabbix.php?action=tcs.camera.view&id=${encodeURIComponent(a.cam)}`;
      if (a.srv) location.href = `zabbix.php?action=tcs.server.view&id=${encodeURIComponent(a.srv)}`;
    }
  }, a.cam || a.srv), /*#__PURE__*/React.createElement("div", {
    className: "msg"
  }, a.msg), /*#__PURE__*/React.createElement("div", {
    className: "site"
  }, a.site, " ", a.ack && /*#__PURE__*/React.createElement("span", {
    className: "muted"
  }, "\xB7 ack")))))));
};

// ───── Mini chart ─────
const FleetChart = ({
  data,
  label,
  unit,
  color,
  max
}) => {
  const w = 800,
    h = 160;
  const lo = 0,
    hi = max || Math.max(...data) * 1.1;
  const stepX = w / (data.length - 1);
  const pts = data.map((v, i) => [i * stepX, h - 20 - (v - lo) / (hi - lo) * (h - 40)]);
  const path = pts.map((p, i) => i === 0 ? `M${p[0]},${p[1]}` : `L${p[0]},${p[1]}`).join(" ");
  const fill = `${path} L${w},${h - 20} L0,${h - 20} Z`;
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
    d: fill,
    fill: color,
    opacity: "0.12"
  }), /*#__PURE__*/React.createElement("path", {
    d: path,
    fill: "none",
    stroke: color,
    strokeWidth: "1.5",
    strokeLinejoin: "round"
  }), /*#__PURE__*/React.createElement("text", {
    x: "6",
    y: "14",
    fontSize: "10",
    fontFamily: "var(--mono)",
    fill: "var(--muted)"
  }, label, " \xB7 peak ", Math.max(...data), unit), /*#__PURE__*/React.createElement("text", {
    x: w - 6,
    y: "14",
    fontSize: "10",
    fontFamily: "var(--mono)",
    fill: "var(--muted)",
    textAnchor: "end"
  }, data[data.length - 1], unit));
};
const SparkCellM = ({
  label,
  v,
  unit,
  data,
  color
}) => /*#__PURE__*/React.createElement("div", {
  className: "spark-cell"
}, /*#__PURE__*/React.createElement("div", {
  className: "lbl"
}, label), /*#__PURE__*/React.createElement("div", {
  className: "val"
}, v, /*#__PURE__*/React.createElement("span", {
  className: "u"
}, unit)), /*#__PURE__*/React.createElement(Sparkline, {
  data: data,
  color: color,
  width: 240,
  height: 26
}));
const ServerMini = ({
  s
}) => {
  // Combined dot precedence (worst wins): bridge-derived state covers
  // Milestone + iDRAC; the resource-usage thresholds below only matter
  // when there's no hardware-level alert already.
  const cpu = _ovNz(s.cpu);
  const mem = _ovNz(s.mem);
  const disk = _ovNz(s.disk);
  let dotState = s.state || "ok";
  if (dotState === "ok" && (disk > 90 || cpu > 80 || mem > 90)) dotState = "warn";
  // RAID/hardware mini-indicator next to the role chip. Hidden when
  // iDRAC hasn't reported yet (raid === "unknown") so the green dot
  // doesn't lie about untested hardware.
  const raid = s.raid;
  return /*#__PURE__*/React.createElement("a", {
    className: "server-tile",
    href: `zabbix.php?action=tcs.server.view&hostid=${s.agentHostid || ""}`,
    style: {
      textDecoration: "none",
      color: "inherit"
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "head"
  }, /*#__PURE__*/React.createElement(StatusDot, {
    state: dotState
  }), /*#__PURE__*/React.createElement("div", {
    className: "id"
  }, s.id), /*#__PURE__*/React.createElement("span", {
    className: "role"
  }, (s.role || "").replace(" Server", "")), raid && raid !== "unknown" && /*#__PURE__*/React.createElement("span", {
    className: "raid-pill " + raid,
    title: "iDRAC hardware status: " + raid,
    style: {
      fontSize: 9,
      marginLeft: 6,
      padding: "1px 6px",
      borderRadius: 8,
      fontFamily: "var(--mono)",
      background: raid === "ok" ? "rgba(52, 211, 153, 0.15)" : raid === "warn" ? "rgba(245, 179, 0, 0.18)" : "rgba(255, 70, 92, 0.18)",
      color: raid === "ok" ? "var(--ok)" : raid === "warn" ? "var(--warn)" : "var(--err)"
    }
  }, "RAID")), /*#__PURE__*/React.createElement("div", {
    className: "stats"
  }, /*#__PURE__*/React.createElement("div", null, "CPU", /*#__PURE__*/React.createElement("div", {
    className: "v",
    style: cpu > 80 ? {
      color: "var(--warn)"
    } : {}
  }, cpu, "%")), /*#__PURE__*/React.createElement("div", null, "Mem", /*#__PURE__*/React.createElement("div", {
    className: "v",
    style: mem > 90 ? {
      color: "var(--warn)"
    } : {}
  }, mem, "%")), /*#__PURE__*/React.createElement("div", null, "Disk", /*#__PURE__*/React.createElement("div", {
    className: "v",
    style: disk > 90 ? {
      color: "var(--warn)"
    } : {}
  }, disk, "%"))), /*#__PURE__*/React.createElement("div", {
    className: "meta"
  }, /*#__PURE__*/React.createElement("span", null, s.site), /*#__PURE__*/React.createElement("span", null, s.model || (s.uptimeD ? `up ${s.uptimeD}d` : "—"))));
};
const CamThumb = ({
  c
}) => {
  const now = new Date();
  const ts = now.toISOString().replace("T", " ").substr(0, 19);
  // Static snapshot for the grid, via the auth-injecting server proxy. Keyed
  // by the per-camera Zabbix hostid (the proxy resolves the IP server-side).
  const snapUrl = c.hostid ? `zabbix.php?action=tcs.camera.snapshot&hostid=${encodeURIComponent(c.hostid)}&size=${encodeURIComponent(CAM_SNAPSHOT_JPEGSIZE)}` : null;
  return /*#__PURE__*/React.createElement("a", {
    className: `cam-tile ${c.state}`,
    href: c.hostid ? `zabbix.php?action=tcs.camera.view&hostid=${c.hostid}` : `zabbix.php?action=tcs.camera.view&id=${encodeURIComponent(c.id)}`,
    style: {
      textDecoration: "none"
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "frame"
  }), c.state !== "err" && snapUrl && /*#__PURE__*/React.createElement("img", {
    src: snapUrl,
    alt: `Snapshot · ${c.loc || c.id}`,
    loading: "lazy",
    onError: e => {
      e.currentTarget.style.display = "none";
    },
    style: {
      position: "absolute",
      inset: 0,
      width: "100%",
      height: "100%",
      objectFit: "cover",
      pointerEvents: "none"
    }
  }), /*#__PURE__*/React.createElement("div", {
    className: "scan"
  }), /*#__PURE__*/React.createElement("div", {
    className: "id"
  }, c.loc || c.id), /*#__PURE__*/React.createElement("div", {
    className: "ts"
  }, ts));
};
window.FleetWidgets = FleetWidgets;