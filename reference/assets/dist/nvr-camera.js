// Camera detail panel — single camera deep dive

// Resolve the camera the page is about. The live Surveillance tiles/rows
// link by &hostid=<perCameraZabbixHost>; older links pass ?id=<camId>.
// camera-bridge.jsx publishes the server-resolved camera as CAMERAS[0].
const resolveCamera = () => {
  const params = new URLSearchParams(location.search);
  const hostid = params.get("hostid");
  const id = params.get("id");
  const cams = window.CAMERAS || [];
  if (hostid) {
    const m = cams.find(c => String(c.hostid) === hostid);
    if (m) return m;
  }
  if (id) {
    const m = cams.find(c => c.id === id);
    if (m) return m;
  }
  return cams[0] || null;
};
const CameraDetailEmpty = () => /*#__PURE__*/React.createElement("div", {
  className: "app"
}, /*#__PURE__*/React.createElement(NVRSidebar, {
  active: "nvr-cameras"
}), /*#__PURE__*/React.createElement("div", {
  className: "main"
}, /*#__PURE__*/React.createElement(NVRTopbar, {
  crumb: ["Surveillance", "Cameras", "—"]
}), /*#__PURE__*/React.createElement("div", {
  className: "body"
}, /*#__PURE__*/React.createElement("div", {
  className: "card",
  style: {
    padding: 40,
    textAlign: "center",
    color: "var(--muted)"
  }
}, /*#__PURE__*/React.createElement("h3", {
  style: {
    marginBottom: 8
  }
}, "Camera not found"), /*#__PURE__*/React.createElement("div", {
  style: {
    fontSize: 13
  }
}, "No live camera matched this link. It may not be discovered in Zabbix yet, or the host id is stale. ", /*#__PURE__*/React.createElement("a", {
  className: "cam-id-link",
  href: "zabbix.php?action=tcs.surveillance.view&view=cameras"
}, "Back to cameras"))))));
const CameraDetail = () => {
  const cam = resolveCamera();
  const [tab, setTab] = React.useState("overview");
  if (!cam) return /*#__PURE__*/React.createElement(CameraDetailEmpty, null);
  const camName = cam.name || cam.id;
  const hasIp = cam.ip && cam.ip !== "—";
  // Direct camera live page — opened in a new tab (the camera login is
  // prompted by the browser). Not embedded: it needs auth the iframe can't
  // carry, so live stays a click-out and the page shows stills inline.
  const liveUrl = hasIp ? `https://${cam.ip}/fullscreen.htm?line=1&stream=1&vport=2&autoresize=false&keepaspect=true&dewarp=false` : null;
  // Still image via the server-side proxy (injects the shared read-only
  // login; keeps the password off the browser). Templated by hostid; size
  // S / M / L / XL or an exact "WxH".
  const snapUrl = cam.hostid ? `zabbix.php?action=tcs.camera.snapshot&hostid=${encodeURIComponent(cam.hostid)}&size=L` : null;
  const H = window.CAM_HISTORY || {};
  const liveEvents = window.CAM_EVENTS || [];
  const show = (...tabs) => tabs.includes(tab);
  const lastOf = a => Array.isArray(a) && a.length ? a[a.length - 1] : 0;
  const fmt = v => typeof v === "number" ? Number.isInteger(v) ? v : v.toFixed(1) : v;
  const isErr = cam.state === "err";
  const isWarn = cam.state === "warn";
  const stateLabel = isErr ? "Offline" : isWarn ? "Warning" : "Streaming";
  const stateColor = isErr ? "var(--err)" : isWarn ? "var(--warn)" : "var(--ok)";
  const now = new Date();
  const ts = now.toISOString().replace("T", " ").substr(0, 19);
  return /*#__PURE__*/React.createElement("div", {
    className: "app"
  }, /*#__PURE__*/React.createElement(NVRSidebar, {
    active: "nvr-cameras"
  }), /*#__PURE__*/React.createElement("div", {
    className: "main"
  }, /*#__PURE__*/React.createElement(NVRTopbar, {
    crumb: ["Surveillance", "Cameras", cam.site, camName]
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
  }, /*#__PURE__*/React.createElement("h1", null, camName), /*#__PURE__*/React.createElement("span", {
    className: "ip"
  }, cam.ip), /*#__PURE__*/React.createElement("span", {
    className: "role-tag faculty",
    style: {
      fontSize: 10,
      padding: "1px 8px"
    }
  }, cam.model)), /*#__PURE__*/React.createElement("div", {
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
  }, "Site"), " ", /*#__PURE__*/React.createElement("span", null, cam.site, " \xB7 ", cam.loc)), /*#__PURE__*/React.createElement("span", {
    className: "pill"
  }, /*#__PURE__*/React.createElement("span", {
    className: "lbl"
  }, "Recording"), " ", /*#__PURE__*/React.createElement("span", {
    className: "v"
  }, cam.recording)), /*#__PURE__*/React.createElement("span", {
    className: "pill"
  }, /*#__PURE__*/React.createElement("span", {
    className: "lbl"
  }, "Server"), " ", cam.server && cam.server !== "—" ? /*#__PURE__*/React.createElement("a", {
    className: "cam-id-link",
    href: `zabbix.php?action=tcs.server.view&id=${encodeURIComponent(cam.server)}`
  }, cam.server) : /*#__PURE__*/React.createElement("span", {
    className: "v"
  }, "\u2014")), /*#__PURE__*/React.createElement("span", {
    className: "pill"
  }, /*#__PURE__*/React.createElement("span", {
    className: "lbl"
  }, "MAC"), " ", /*#__PURE__*/React.createElement("span", {
    className: "v"
  }, cam.mac)))), /*#__PURE__*/React.createElement("div", {
    className: "timerange"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "calendar"
  }), /*#__PURE__*/React.createElement("span", {
    className: "range-val"
  }, "last 24h"), /*#__PURE__*/React.createElement(Icon, {
    name: "chevron"
  }))), /*#__PURE__*/React.createElement("div", {
    className: "tabs"
  }, [["overview", "Overview"], ["live", "Live"], ["events", "Events"], ["config", "Configuration"]].map(([k, l]) => /*#__PURE__*/React.createElement("div", {
    key: k,
    className: "tab " + (tab === k ? "active" : ""),
    onClick: () => setTab(k)
  }, l))), /*#__PURE__*/React.createElement("div", {
    className: "body",
    "data-screen-label": `Camera · ${camName}`
  }, /*#__PURE__*/React.createElement(DemoBanner, {
    name: "Camera Detail"
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gridTemplateColumns: "320px 1fr",
      gap: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "device-hero",
    style: {
      padding: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "status-line"
  }, /*#__PURE__*/React.createElement(StatusDot, {
    state: cam.state === "err" ? "err" : cam.state === "warn" ? "warn" : "ok"
  }), " ", /*#__PURE__*/React.createElement("span", {
    style: {
      color: stateColor
    }
  }, stateLabel)), /*#__PURE__*/React.createElement("div", {
    className: "live-large",
    style: {
      width: "100%",
      marginTop: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "frame"
  }), /*#__PURE__*/React.createElement("div", {
    className: "scan"
  }), !isErr && snapUrl && /*#__PURE__*/React.createElement("img", {
    src: snapUrl,
    alt: `Snapshot · ${camName}`,
    onError: e => {
      e.currentTarget.style.display = "none";
    },
    style: {
      position: "absolute",
      inset: 0,
      width: "100%",
      height: "100%",
      objectFit: "cover"
    }
  }), !isErr ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      position: "absolute",
      top: 8,
      left: 10,
      fontFamily: "var(--mono)",
      fontSize: 10,
      color: "#fff"
    }
  }, camName), /*#__PURE__*/React.createElement("div", {
    style: {
      position: "absolute",
      top: 8,
      right: 10,
      fontFamily: "var(--mono)",
      fontSize: 10,
      color: "rgba(255,255,255,0.85)"
    }
  }, ts), (cam.res !== "—" || cam.fps || cam.codec !== "—") && /*#__PURE__*/React.createElement("div", {
    style: {
      position: "absolute",
      bottom: 8,
      left: 10,
      fontFamily: "var(--mono)",
      fontSize: 10,
      color: "rgba(255,255,255,0.85)"
    }
  }, [cam.res !== "—" ? cam.res : null, cam.fps ? `${cam.fps}fps` : null, cam.codec !== "—" ? cam.codec : null].filter(Boolean).join(" · ")), /*#__PURE__*/React.createElement("div", {
    style: {
      position: "absolute",
      bottom: 8,
      right: 10,
      display: "flex",
      alignItems: "center",
      gap: 4,
      fontFamily: "var(--mono)",
      fontSize: 10,
      color: "#fff"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 7,
      height: 7,
      borderRadius: 50,
      background: "var(--err)",
      animation: "blink 1.4s infinite",
      boxShadow: "0 0 6px var(--err)"
    }
  }), " REC")) : /*#__PURE__*/React.createElement("div", {
    style: {
      position: "absolute",
      inset: 0,
      display: "grid",
      placeItems: "center",
      color: "var(--err)",
      fontFamily: "var(--mono)",
      letterSpacing: 2,
      fontWeight: 600
    }
  }, "NO SIGNAL")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 6,
      marginTop: 10,
      width: "100%"
    }
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn primary",
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "external",
    size: 12
  }), " Smart Client"), /*#__PURE__*/React.createElement("button", {
    className: "btn",
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "refresh",
    size: 12
  }), " Restart Stream"))), /*#__PURE__*/React.createElement("div", {
    className: "location-block"
  }, /*#__PURE__*/React.createElement("div", {
    className: "label"
  }, "Location"), /*#__PURE__*/React.createElement("div", {
    className: "v"
  }, cam.site, /*#__PURE__*/React.createElement("br", null), cam.loc)), /*#__PURE__*/React.createElement("div", {
    className: "location-block"
  }, /*#__PURE__*/React.createElement("div", {
    className: "label"
  }, "Hardware"), /*#__PURE__*/React.createElement("div", {
    className: "v"
  }, /*#__PURE__*/React.createElement("div", null, cam.model), /*#__PURE__*/React.createElement("div", {
    className: "muted",
    style: {
      fontSize: 11
    }
  }, "MAC ", cam.mac), /*#__PURE__*/React.createElement("div", {
    className: "muted",
    style: {
      fontSize: 11
    }
  }, "PoE draw ", cam.poe ? `${cam.poe} W` : "—"))), /*#__PURE__*/React.createElement("div", {
    className: "location-block"
  }, /*#__PURE__*/React.createElement("div", {
    className: "label"
  }, "Recording Server"), /*#__PURE__*/React.createElement("div", {
    className: "v",
    style: {
      fontSize: 11
    }
  }, cam.server))), /*#__PURE__*/React.createElement("div", null, (isErr || isWarn) && /*#__PURE__*/React.createElement("div", {
    className: "card",
    style: {
      marginBottom: 14,
      borderColor: isErr ? "rgba(242,95,92,0.5)" : "rgba(245,179,0,0.5)"
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", {
    style: {
      color: isErr ? "var(--err)" : "var(--warn)"
    }
  }, "Active Issue"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("button", {
    className: "btn sm"
  }, "Acknowledge")), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 14,
      fontSize: 13
    }
  }, cam.errMsg || cam.warnMsg || "—")), show("overview", "live") && /*#__PURE__*/React.createElement("div", {
    className: "card",
    style: {
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "Device Health"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("span", {
    className: "h-meta"
  }, "poll \xB7 60s \xB7 SNMP + ICMP")), /*#__PURE__*/React.createElement("div", {
    className: "health-grid"
  }, /*#__PURE__*/React.createElement("div", {
    className: "health-cell"
  }, /*#__PURE__*/React.createElement(Ring, {
    value: isErr ? 0 : lastOf(H.cpu),
    max: 100,
    label: lastOf(H.cpu) ? fmt(lastOf(H.cpu)) : "—",
    sub: "%",
    color: "var(--zbx)"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-label"
  }, "CPU")), /*#__PURE__*/React.createElement("div", {
    className: "health-cell"
  }, /*#__PURE__*/React.createElement(Ring, {
    value: isErr ? 0 : lastOf(H.mem),
    max: 100,
    label: lastOf(H.mem) ? fmt(lastOf(H.mem)) : "—",
    sub: "%",
    color: "var(--info)"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-label"
  }, "Memory")), /*#__PURE__*/React.createElement("div", {
    className: "health-cell"
  }, /*#__PURE__*/React.createElement(Ring, {
    value: lastOf(H.latency),
    max: 100,
    label: H.latency && H.latency.length ? fmt(lastOf(H.latency)) : "—",
    sub: "ms",
    color: "var(--zbx)"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-label"
  }, "ICMP Latency")), /*#__PURE__*/React.createElement("div", {
    className: "health-cell"
  }, /*#__PURE__*/React.createElement(Ring, {
    value: lastOf(H.packetLoss),
    max: 100,
    label: H.packetLoss && H.packetLoss.length ? fmt(lastOf(H.packetLoss)) : "—",
    sub: "%",
    color: lastOf(H.packetLoss) > 1 ? "var(--warn)" : "var(--ok)"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-label"
  }, "Packet Loss")))), show("overview") && /*#__PURE__*/React.createElement("div", {
    className: "card",
    style: {
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "Live Telemetry \xB7 24h"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("span", {
    className: "h-meta"
  }, "48 samples \xB7 30m bucket")), /*#__PURE__*/React.createElement("div", {
    className: "spark-strip"
  }, /*#__PURE__*/React.createElement(SparkCellM, {
    label: "CPU",
    v: lastOf(H.cpu) ? fmt(lastOf(H.cpu)) : "—",
    unit: "%",
    data: H.cpu,
    color: "var(--zbx)"
  }), /*#__PURE__*/React.createElement(SparkCellM, {
    label: "MEM",
    v: lastOf(H.mem) ? fmt(lastOf(H.mem)) : "—",
    unit: "%",
    data: H.mem,
    color: "var(--info)"
  }), /*#__PURE__*/React.createElement(SparkCellM, {
    label: "Pkt Loss",
    v: H.packetLoss && H.packetLoss.length ? fmt(lastOf(H.packetLoss)) : "—",
    unit: "%",
    data: H.packetLoss,
    color: "var(--warn)"
  }), /*#__PURE__*/React.createElement(SparkCellM, {
    label: "ICMP Latency",
    v: H.latency && H.latency.length ? fmt(lastOf(H.latency)) : "—",
    unit: "ms",
    data: H.latency,
    color: "var(--zbx)"
  }))), show("live", "config") && /*#__PURE__*/React.createElement("div", {
    className: "card",
    style: {
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "Stream Configuration"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "ext"
  })), /*#__PURE__*/React.createElement("div", {
    className: "kv tight"
  }, /*#__PURE__*/React.createElement("div", {
    className: "k"
  }, "Codec"), /*#__PURE__*/React.createElement("div", {
    className: "v"
  }, cam.codec), /*#__PURE__*/React.createElement("div", {
    className: "b"
  }, /*#__PURE__*/React.createElement(SourceBadge, {
    src: "ext"
  })), /*#__PURE__*/React.createElement("div", {
    className: "k"
  }, "Resolution"), /*#__PURE__*/React.createElement("div", {
    className: "v"
  }, cam.res), /*#__PURE__*/React.createElement("div", {
    className: "b"
  }, /*#__PURE__*/React.createElement(SourceBadge, {
    src: "ext"
  })), /*#__PURE__*/React.createElement("div", {
    className: "k"
  }, "FPS"), /*#__PURE__*/React.createElement("div", {
    className: "v"
  }, cam.fps || "—"), /*#__PURE__*/React.createElement("div", {
    className: "b"
  }, /*#__PURE__*/React.createElement(SourceBadge, {
    src: "ext"
  })), /*#__PURE__*/React.createElement("div", {
    className: "k"
  }, "Bitrate"), /*#__PURE__*/React.createElement("div", {
    className: "v"
  }, cam.bitrate ? `${(cam.bitrate / 1000).toFixed(1)} Mbps` : "—"), /*#__PURE__*/React.createElement("div", {
    className: "b"
  }, /*#__PURE__*/React.createElement(SourceBadge, {
    src: "ext"
  })), /*#__PURE__*/React.createElement("div", {
    className: "k"
  }, "Recording mode"), /*#__PURE__*/React.createElement("div", {
    className: "v"
  }, cam.recording), /*#__PURE__*/React.createElement("div", {
    className: "b"
  }, /*#__PURE__*/React.createElement(SourceBadge, {
    src: "ext"
  })), /*#__PURE__*/React.createElement("div", {
    className: "k"
  }, "Stream URL"), /*#__PURE__*/React.createElement("div", {
    className: "v",
    style: {
      fontSize: 10
    }
  }, liveUrl ? /*#__PURE__*/React.createElement("a", {
    className: "cam-id-link",
    href: liveUrl,
    target: "_blank",
    rel: "noreferrer"
  }, liveUrl) : "—"), /*#__PURE__*/React.createElement("div", {
    className: "b"
  }, /*#__PURE__*/React.createElement(SourceBadge, {
    src: "ext"
  })))), show("config") && /*#__PURE__*/React.createElement("div", {
    className: "card",
    style: {
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "Network & Identity"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  })), /*#__PURE__*/React.createElement("div", {
    className: "kv"
  }, /*#__PURE__*/React.createElement("div", {
    className: "k"
  }, "IPv4"), /*#__PURE__*/React.createElement("div", {
    className: "v"
  }, cam.ip), /*#__PURE__*/React.createElement("div", {
    className: "b"
  }, /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  })), /*#__PURE__*/React.createElement("div", {
    className: "k"
  }, "MAC"), /*#__PURE__*/React.createElement("div", {
    className: "v"
  }, cam.mac), /*#__PURE__*/React.createElement("div", {
    className: "b"
  }, /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  })), /*#__PURE__*/React.createElement("div", {
    className: "k"
  }, "Model"), /*#__PURE__*/React.createElement("div", {
    className: "v"
  }, cam.model), /*#__PURE__*/React.createElement("div", {
    className: "b"
  }, /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  })), /*#__PURE__*/React.createElement("div", {
    className: "k"
  }, "PoE draw"), /*#__PURE__*/React.createElement("div", {
    className: "v"
  }, cam.poe ? `${cam.poe} W` : "—"), /*#__PURE__*/React.createElement("div", {
    className: "b"
  }, /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  })), /*#__PURE__*/React.createElement("div", {
    className: "k"
  }, "Recording server"), /*#__PURE__*/React.createElement("div", {
    className: "v"
  }, cam.server), /*#__PURE__*/React.createElement("div", {
    className: "b"
  }, /*#__PURE__*/React.createElement(SourceBadge, {
    src: "ext"
  })))), show("overview", "config") && /*#__PURE__*/React.createElement(CameraPfPanel, {
    cam: cam
  }), show("live") && /*#__PURE__*/React.createElement("div", {
    className: "card",
    style: {
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "Live View"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "ext"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), liveUrl && /*#__PURE__*/React.createElement("a", {
    className: "cam-id-link",
    href: liveUrl,
    target: "_blank",
    rel: "noreferrer"
  }, "Open live stream ", /*#__PURE__*/React.createElement(Icon, {
    name: "external",
    size: 11
  }))), !isErr && snapUrl ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    className: "live-large",
    style: {
      width: "100%"
    }
  }, /*#__PURE__*/React.createElement("img", {
    src: snapUrl,
    alt: `Snapshot · ${camName}`,
    onError: e => {
      e.currentTarget.style.display = "none";
    },
    style: {
      position: "absolute",
      inset: 0,
      width: "100%",
      height: "100%",
      objectFit: "cover"
    }
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 12,
      fontSize: 12,
      color: "var(--muted)"
    }
  }, "Still image, refreshed on load. The live video stream opens in the camera's own player via ", /*#__PURE__*/React.createElement("strong", null, "Open live stream"), " (you'll be prompted to log in).")) : /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 14,
      fontSize: 13,
      color: "var(--muted)"
    }
  }, isErr ? "Camera is offline — no snapshot available." : "No IP address discovered for this camera. Use the Milestone Smart Client to view it.")), show("overview", "events") && /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "Recent Events"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("span", {
    className: "h-meta"
  }, "Open Zabbix problems \xB7 this camera")), /*#__PURE__*/React.createElement("div", {
    className: "events"
  }, liveEvents.length ? liveEvents.map((e, i) => /*#__PURE__*/React.createElement(CamEvent, {
    key: i,
    ts: e.ts,
    src: e.src,
    sev: e.sev,
    msg: e.msg
  })) : /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 18,
      textAlign: "center",
      color: "var(--muted)",
      fontSize: 13
    }
  }, "No open problems on this camera."))))))));
};
const CamEvent = ({
  ts,
  src,
  sev,
  msg
}) => /*#__PURE__*/React.createElement("div", {
  className: "event"
}, /*#__PURE__*/React.createElement("div", {
  className: "ts"
}, ts), /*#__PURE__*/React.createElement("div", {
  className: `src ${src === "ZBX" ? "zbx" : "pf"}`
}, src), /*#__PURE__*/React.createElement(Sev, {
  level: sev
}), /*#__PURE__*/React.createElement("div", {
  className: "msg"
}, msg));

// PacketFence + Uplink card. Mirrors the switches port-detail PF pane and
// the AP detail action row — same backend endpoints (tcs.pf.device,
// tcs.switch.cyclepoe), same buttons (View in PF / Reevaluate / Reboot /
// Cycle PoE), so the AP and camera screens behave identically.
const CameraPfPanel = ({
  cam
}) => {
  const uplink = window.CAMERA_UPLINK || null;
  const dev = window.CAMERA_PF || null;
  const mac = dev && dev.mac || cam.mac || "";
  const adminBase = (window.PF_ADMIN_BASE || "").replace(/\/+$/, "");
  const viewHref = adminBase && mac && mac !== "—" ? `${adminBase}/admin/#/node/${encodeURIComponent(String(mac).toLowerCase())}` : null;

  // Parse the PF locationlog port into (member, port) for Cycle PoE. EXOS
  // stacks expose ports as "<member>:<port>"; ifDesc forms like "1/5" or
  // "1:5" or plain "5" all work — fall through to member=1 if unclear.
  const parsePort = raw => {
    const s = String(raw || "").trim();
    if (!s) return null;
    const m = s.match(/^(\d+)[\/:](\d+)$/);
    if (m) return {
      member: parseInt(m[1], 10),
      port: parseInt(m[2], 10)
    };
    const n = parseInt(s, 10);
    if (Number.isFinite(n) && n > 0) return {
      member: 1,
      port: n
    };
    return null;
  };
  const [busy, setBusy] = React.useState(null); // 'reevaluate'|'reboot'|'poe'|null
  const [msg, setMsg] = React.useState({
    kind: "",
    text: ""
  });
  const flash = m => {
    setMsg(m);
    setTimeout(() => setMsg({
      kind: "",
      text: ""
    }), 6000);
  };
  const runPf = async (op, op_busy, label) => {
    if (!mac || mac === "—") {
      flash({
        kind: "err",
        text: "no MAC"
      });
      return;
    }
    if (typeof window.tcsPfDeviceAction !== "function") {
      flash({
        kind: "err",
        text: "endpoint missing"
      });
      return;
    }
    setBusy(op_busy);
    setMsg({
      kind: "",
      text: `${label}…`
    });
    const r = await window.tcsPfDeviceAction(mac, op);
    setBusy(null);
    flash(r && r.ok ? {
      kind: "",
      text: r.message || "ok"
    } : {
      kind: "err",
      text: r && (r.error || r.message) || "failed"
    });
  };
  const runCyclePoe = async () => {
    if (typeof window.tcsCyclePoeOnSwitch !== "function") {
      flash({
        kind: "err",
        text: "endpoint missing"
      });
      return;
    }
    if (!uplink || !uplink.switchHostid) {
      flash({
        kind: "err",
        text: "upstream switch unknown"
      });
      return;
    }
    const mp = parsePort(uplink.port || uplink.ifDesc);
    if (!mp) {
      flash({
        kind: "err",
        text: "bad PF port string"
      });
      return;
    }
    setBusy("poe");
    setMsg({
      kind: "",
      text: "cycling PoE…"
    });
    const r = await window.tcsCyclePoeOnSwitch(uplink.switchHostid, mp.member, mp.port);
    setBusy(null);
    flash(r && r.ok ? {
      kind: "",
      text: r.message || "ok"
    } : {
      kind: "err",
      text: r && (r.error || r.message) || "failed"
    });
  };
  const swHref = uplink && uplink.switchHostid ? `zabbix.php?action=tcs.switches.view&switchid=${encodeURIComponent(uplink.switchHostid)}` : null;
  return /*#__PURE__*/React.createElement("div", {
    className: "card",
    style: {
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "PacketFence & Uplink"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "pf"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), dev && /*#__PURE__*/React.createElement("span", {
    className: "reg-badge " + (dev.reg === "REG" ? "reg" : "unreg"),
    style: {
      fontSize: 10
    }
  }, dev.reg)), /*#__PURE__*/React.createElement("div", {
    className: "kv tight"
  }, /*#__PURE__*/React.createElement("div", {
    className: "k"
  }, "Switch"), /*#__PURE__*/React.createElement("div", {
    className: "v"
  }, uplink && uplink.switch ? swHref ? /*#__PURE__*/React.createElement("a", {
    className: "cam-id-link",
    href: swHref
  }, uplink.switch) : uplink.switch : /*#__PURE__*/React.createElement("span", {
    className: "muted"
  }, "\u2014"), uplink && uplink.switchIp ? /*#__PURE__*/React.createElement("span", {
    className: "muted",
    style: {
      fontSize: 10,
      marginLeft: 6
    }
  }, uplink.switchIp) : null), /*#__PURE__*/React.createElement("div", {
    className: "b"
  }, /*#__PURE__*/React.createElement(SourceBadge, {
    src: "pf"
  })), /*#__PURE__*/React.createElement("div", {
    className: "k"
  }, "Port"), /*#__PURE__*/React.createElement("div", {
    className: "v"
  }, uplink && (uplink.port || uplink.ifDesc) ? `${uplink.port || ""}${uplink.ifDesc ? ` · ${uplink.ifDesc}` : ""}` : /*#__PURE__*/React.createElement("span", {
    className: "muted"
  }, "\u2014")), /*#__PURE__*/React.createElement("div", {
    className: "b"
  }, /*#__PURE__*/React.createElement(SourceBadge, {
    src: "pf"
  })), /*#__PURE__*/React.createElement("div", {
    className: "k"
  }, "MAC"), /*#__PURE__*/React.createElement("div", {
    className: "v",
    style: {
      fontFamily: "var(--mono)",
      fontSize: 11
    }
  }, mac || /*#__PURE__*/React.createElement("span", {
    className: "muted"
  }, "\u2014")), /*#__PURE__*/React.createElement("div", {
    className: "b"
  }, /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  })), /*#__PURE__*/React.createElement("div", {
    className: "k"
  }, "Role"), /*#__PURE__*/React.createElement("div", {
    className: "v"
  }, dev && dev.role ? /*#__PURE__*/React.createElement("span", {
    className: "role-tag " + (dev.role || "unknown")
  }, dev.role) : /*#__PURE__*/React.createElement("span", {
    className: "muted"
  }, "\u2014")), /*#__PURE__*/React.createElement("div", {
    className: "b"
  }, /*#__PURE__*/React.createElement(SourceBadge, {
    src: "pf"
  })), /*#__PURE__*/React.createElement("div", {
    className: "k"
  }, "PF IP"), /*#__PURE__*/React.createElement("div", {
    className: "v"
  }, dev && dev.ip ? dev.ip : /*#__PURE__*/React.createElement("span", {
    className: "muted"
  }, "\u2014")), /*#__PURE__*/React.createElement("div", {
    className: "b"
  }, /*#__PURE__*/React.createElement(SourceBadge, {
    src: "pf"
  })), /*#__PURE__*/React.createElement("div", {
    className: "k"
  }, "Last seen"), /*#__PURE__*/React.createElement("div", {
    className: "v",
    style: {
      fontSize: 11
    }
  }, dev && dev.lastSeen ? dev.lastSeen : /*#__PURE__*/React.createElement("span", {
    className: "muted"
  }, "\u2014")), /*#__PURE__*/React.createElement("div", {
    className: "b"
  }, /*#__PURE__*/React.createElement(SourceBadge, {
    src: "pf"
  }))), /*#__PURE__*/React.createElement("div", {
    className: "pf-actions",
    style: {
      padding: "10px 14px",
      display: "flex",
      gap: 8,
      flexWrap: "wrap",
      alignItems: "center"
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
    title: "PF admin URL or MAC not available"
  }, "View in PacketFence"), /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: "pf-btn",
    disabled: !!busy || !mac || mac === "—",
    onClick: () => runPf("reevaluate_access", "reevaluate", "reevaluating"),
    title: "Re-run PF role / access evaluation for this camera"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "refresh",
    size: 11
  }), " ", busy === "reevaluate" ? "REEVALUATING…" : "Reevaluate"), /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: "pf-btn warn",
    disabled: !!busy || !mac || mac === "—",
    onClick: () => runPf("restart_switchport", "reboot", "restarting switchport"),
    title: "Bounce the switch port via PF (effectively reboots the camera over PoE link)"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "refresh",
    size: 11
  }), " ", busy === "reboot" ? "REBOOTING…" : "Reboot"), /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: "pf-btn warn",
    disabled: !!busy || !uplink || !uplink.switchHostid,
    onClick: runCyclePoe,
    title: "Toggle PoE off/on on the upstream switch port (rConfig snippet on the switch host)"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "refresh",
    size: 11
  }), " ", busy === "poe" ? "CYCLING…" : "Cycle PoE"), msg.text && /*#__PURE__*/React.createElement("span", {
    className: "pf-msg" + (msg.kind === "err" ? " err" : ""),
    style: {
      fontSize: 11
    }
  }, msg.text)));
};
ReactDOM.createRoot(document.getElementById("root")).render(/*#__PURE__*/React.createElement(CameraDetail, null));