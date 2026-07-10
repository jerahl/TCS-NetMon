// Shared UI primitives for the Zabbix + PacketFence dashboard

const SourceBadge = ({
  src
}) => {
  const map = {
    zbx: {
      label: "ZBX",
      title: "Source: Zabbix",
      color: "var(--zbx)"
    },
    pf: {
      label: "PF",
      title: "Source: PacketFence",
      color: "var(--pf)"
    },
    ext: {
      label: "EXT",
      title: "Source: ExtremeCloud IQ (read-through)",
      color: "var(--ext)"
    },
    "3cx": {
      label: "3CX",
      title: "Source: 3CX Phone System API",
      color: "var(--cx)"
    },
    xdr: {
      label: "XDR",
      title: "Source: Cortex XDR tenant",
      color: "var(--xdr)"
    }
  };
  const m = map[src] || map.zbx;
  return /*#__PURE__*/React.createElement("span", {
    className: "src-badge",
    title: m.title,
    style: {
      borderColor: m.color,
      color: m.color
    }
  }, m.label);
};
const Sparkline = ({
  data,
  color = "var(--zbx)",
  width = 120,
  height = 32,
  fill = true,
  threshold = null
}) => {
  if (!data || !data.length) return null;
  const max = Math.max(...data, threshold || -Infinity);
  const min = Math.min(...data);
  const range = max - min || 1;
  const stepX = width / (data.length - 1);
  const pts = data.map((v, i) => [i * stepX, height - (v - min) / range * (height - 2) - 1]);
  const path = pts.map((p, i) => i === 0 ? `M${p[0]},${p[1]}` : `L${p[0]},${p[1]}`).join(" ");
  const fillPath = `${path} L${width},${height} L0,${height} Z`;
  return /*#__PURE__*/React.createElement("svg", {
    width: width,
    height: height,
    className: "sparkline",
    viewBox: `0 0 ${width} ${height}`,
    preserveAspectRatio: "none"
  }, fill && /*#__PURE__*/React.createElement("path", {
    d: fillPath,
    fill: color,
    opacity: "0.12"
  }), /*#__PURE__*/React.createElement("path", {
    d: path,
    stroke: color,
    strokeWidth: "1.4",
    fill: "none",
    strokeLinejoin: "round",
    strokeLinecap: "round"
  }), threshold !== null && /*#__PURE__*/React.createElement("line", {
    x1: "0",
    x2: width,
    y1: height - (threshold - min) / range * (height - 2) - 1,
    y2: height - (threshold - min) / range * (height - 2) - 1,
    stroke: "var(--warn)",
    strokeDasharray: "2 3",
    strokeWidth: "0.8",
    opacity: "0.5"
  }));
};

// Donut/ring gauge
const Ring = ({
  value,
  max = 100,
  size = 92,
  color,
  label,
  sub,
  threshold
}) => {
  const pct = Math.min(1, value / max);
  const r = size / 2 - 6;
  const c = 2 * Math.PI * r;
  const dash = c * pct;
  const isWarn = threshold && value >= threshold;
  const stroke = color || (isWarn ? "var(--warn)" : "var(--zbx)");
  return /*#__PURE__*/React.createElement("div", {
    className: "ring"
  }, /*#__PURE__*/React.createElement("svg", {
    width: size,
    height: size
  }, /*#__PURE__*/React.createElement("circle", {
    cx: size / 2,
    cy: size / 2,
    r: r,
    stroke: "rgba(255,255,255,0.06)",
    strokeWidth: "6",
    fill: "none"
  }), /*#__PURE__*/React.createElement("circle", {
    cx: size / 2,
    cy: size / 2,
    r: r,
    stroke: stroke,
    strokeWidth: "6",
    fill: "none",
    strokeDasharray: `${dash} ${c}`,
    strokeLinecap: "round",
    transform: `rotate(-90 ${size / 2} ${size / 2})`
  })), /*#__PURE__*/React.createElement("div", {
    className: "ring-label"
  }, /*#__PURE__*/React.createElement("div", {
    className: "ring-val"
  }, label), sub && /*#__PURE__*/React.createElement("div", {
    className: "ring-sub"
  }, sub)));
};
const StatusDot = ({
  state
}) => {
  const map = {
    ok: "var(--ok)",
    warn: "var(--warn)",
    err: "var(--err)",
    up: "var(--ok)",
    down: "var(--err)",
    idle: "var(--muted)",
    compliant: "var(--ok)",
    "non-compliant": "var(--warn)",
    rejected: "var(--err)",
    "n/a": "var(--muted)"
  };
  return /*#__PURE__*/React.createElement("span", {
    className: "dot",
    style: {
      background: map[state] || "var(--muted)"
    }
  });
};
const Sev = ({
  level
}) => {
  const map = {
    info: ["INFO", "var(--info)"],
    warning: ["WARN", "var(--warn)"],
    average: ["AVG", "#e8843c"],
    high: ["HIGH", "var(--err)"],
    disaster: ["DSTR", "var(--err)"]
  };
  const [l, c] = map[level] || map.info;
  return /*#__PURE__*/React.createElement("span", {
    className: "sev",
    style: {
      color: c,
      borderColor: c
    }
  }, l);
};

// SVG icon set — simple stroke icons, no AI-slop emoji
const Icon = ({
  name,
  size = 16
}) => {
  const s = {
    width: size,
    height: size,
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.4,
    strokeLinecap: "round",
    strokeLinejoin: "round"
  };
  switch (name) {
    case "back":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("path", {
        d: "M10 13 4.5 8 10 3"
      }));
    case "close":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("path", {
        d: "M3 3l10 10M13 3 3 13"
      }));
    case "search":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("circle", {
        cx: "7",
        cy: "7",
        r: "4.5"
      }), /*#__PURE__*/React.createElement("path", {
        d: "m13 13-2.5-2.5"
      }));
    case "calendar":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("rect", {
        x: "2.5",
        y: "3.5",
        width: "11",
        height: "10",
        rx: "1.5"
      }), /*#__PURE__*/React.createElement("path", {
        d: "M2.5 6.5h11M5.5 2v3M10.5 2v3"
      }));
    case "chevron":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("path", {
        d: "m4 6 4 4 4-4"
      }));
    case "refresh":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("path", {
        d: "M2.5 8a5.5 5.5 0 0 1 9.5-3.8M13.5 2v3.5H10"
      }), /*#__PURE__*/React.createElement("path", {
        d: "M13.5 8a5.5 5.5 0 0 1-9.5 3.8M2.5 14v-3.5H6"
      }));
    case "ap":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("circle", {
        cx: "8",
        cy: "11",
        r: "1"
      }), /*#__PURE__*/React.createElement("path", {
        d: "M5.5 9a3.5 3.5 0 0 1 5 0M3.5 7a6.5 6.5 0 0 1 9 0M1.5 5a9.5 9.5 0 0 1 13 0"
      }));
    case "shield":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("path", {
        d: "M8 1.5 2.5 3.5v4c0 3 2.4 5.6 5.5 7 3.1-1.4 5.5-4 5.5-7v-4L8 1.5Z"
      }));
    case "user":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("circle", {
        cx: "8",
        cy: "6",
        r: "2.5"
      }), /*#__PURE__*/React.createElement("path", {
        d: "M3 14c.8-2.5 2.8-4 5-4s4.2 1.5 5 4"
      }));
    case "wifi":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("path", {
        d: "M1.5 5.5a10 10 0 0 1 13 0M3.5 8a7 7 0 0 1 9 0M5.5 10.5a4 4 0 0 1 5 0"
      }), /*#__PURE__*/React.createElement("circle", {
        cx: "8",
        cy: "13",
        r: ".8",
        fill: "currentColor"
      }));
    case "ethernet":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("rect", {
        x: "2.5",
        y: "5.5",
        width: "11",
        height: "6",
        rx: "1"
      }), /*#__PURE__*/React.createElement("path", {
        d: "M5 11.5v1.5M7 11.5v1.5M9 11.5v1.5M11 11.5v1.5"
      }));
    case "firewall":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("rect", {
        x: "2",
        y: "3",
        width: "12",
        height: "10",
        rx: "1"
      }), /*#__PURE__*/React.createElement("path", {
        d: "M2 6.5h12M2 9.5h12M6 3v3.5M10 6.5v3M6 9.5V13M10 9.5V13"
      }));
    case "phone":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("path", {
        d: "M3 3.5h3l1.2 3.2-1.6 1A8 8 0 0 0 8.3 10.4l1-1.6 3.2 1.2v3a1 1 0 0 1-1.1 1A11 11 0 0 1 2.5 4.6 1 1 0 0 1 3.5 3.5Z"
      }));
    case "headset":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("path", {
        d: "M3 9.5V8a5 5 0 0 1 10 0v1.5"
      }), /*#__PURE__*/React.createElement("rect", {
        x: "2",
        y: "9",
        width: "3",
        height: "4.5",
        rx: "1"
      }), /*#__PURE__*/React.createElement("rect", {
        x: "11",
        y: "9",
        width: "3",
        height: "4.5",
        rx: "1"
      }));
    case "trunk":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("circle", {
        cx: "3",
        cy: "8",
        r: "1.5"
      }), /*#__PURE__*/React.createElement("circle", {
        cx: "13",
        cy: "3.5",
        r: "1.2"
      }), /*#__PURE__*/React.createElement("circle", {
        cx: "13",
        cy: "8",
        r: "1.2"
      }), /*#__PURE__*/React.createElement("circle", {
        cx: "13",
        cy: "12.5",
        r: "1.2"
      }), /*#__PURE__*/React.createElement("path", {
        d: "M4.5 8 11.8 3.5 M4.5 8h7.3 M4.5 8 11.8 12.5"
      }));
    case "crosshair":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("circle", {
        cx: "8",
        cy: "8",
        r: "3.2"
      }), /*#__PURE__*/React.createElement("circle", {
        cx: "8",
        cy: "8",
        r: "6"
      }), /*#__PURE__*/React.createElement("path", {
        d: "M8 1v2 M8 13v2 M1 8h2 M13 8h2"
      }));
    case "bug":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("rect", {
        x: "5",
        y: "5.5",
        width: "6",
        height: "7",
        rx: "3"
      }), /*#__PURE__*/React.createElement("path", {
        d: "M5 7H3 M5 9.5H2.5 M5 12H3 M11 7h2 M11 9.5h2.5 M11 12h2 M6.5 5.5 5.5 3.5 M9.5 5.5 10.5 3.5"
      }));
    case "alert":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("path", {
        d: "M8 2.5 1.5 13.5h13L8 2.5Z"
      }), /*#__PURE__*/React.createElement("path", {
        d: "M8 6.5v3M8 11.3v.2"
      }));
    case "events":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("path", {
        d: "M2 4h12M2 8h12M2 12h7"
      }));
    case "clients":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("circle", {
        cx: "5.5",
        cy: "6",
        r: "2"
      }), /*#__PURE__*/React.createElement("circle", {
        cx: "11",
        cy: "7",
        r: "1.5"
      }), /*#__PURE__*/React.createElement("path", {
        d: "M2 13c.5-2 2-3 3.5-3s3 1 3.5 3M9 13c.3-1.4 1.2-2.2 2.5-2.2s2.2.8 2.5 2.2"
      }));
    case "more":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("circle", {
        cx: "3",
        cy: "8",
        r: "1",
        fill: "currentColor"
      }), /*#__PURE__*/React.createElement("circle", {
        cx: "8",
        cy: "8",
        r: "1",
        fill: "currentColor"
      }), /*#__PURE__*/React.createElement("circle", {
        cx: "13",
        cy: "8",
        r: "1",
        fill: "currentColor"
      }));
    case "external":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("path", {
        d: "M9 2.5h4.5V7M13.5 2.5 7 9M11 8v5.5H2.5V5H8"
      }));
    case "filter":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("path", {
        d: "M2 3h12l-4.5 6V13l-3 1V9L2 3Z"
      }));
    case "check":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("path", {
        d: "m3 8 3.5 3.5L13 5"
      }));
    case "x":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("path", {
        d: "M3 3l10 10M13 3 3 13"
      }));
    case "lock":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("rect", {
        x: "3.5",
        y: "7.5",
        width: "9",
        height: "6",
        rx: "1"
      }), /*#__PURE__*/React.createElement("path", {
        d: "M5.5 7.5V5a2.5 2.5 0 0 1 5 0v2.5"
      }));
    case "map":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("path", {
        d: "M2 4 6 2.5l4 1.5 4-1.5v9.5L10 13.5 6 12 2 13.5V4Z M6 2.5v9.5 M10 4v9.5"
      }));
    case "sidebar-collapse":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("rect", {
        x: "2",
        y: "3",
        width: "12",
        height: "10",
        rx: "1.5"
      }), /*#__PURE__*/React.createElement("path", {
        d: "M6 3v10"
      }), /*#__PURE__*/React.createElement("path", {
        d: "M11 6 9 8l2 2"
      }));
    case "sidebar-expand":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("rect", {
        x: "2",
        y: "3",
        width: "12",
        height: "10",
        rx: "1.5"
      }), /*#__PURE__*/React.createElement("path", {
        d: "M6 3v10"
      }), /*#__PURE__*/React.createElement("path", {
        d: "M9 6l2 2-2 2"
      }));
    default:
      return null;
  }
};

// Red banner shown on tabs / pages still rendering hardcoded demo
// content. `name` is the human-readable label of the surface being
// shown (e.g. "Topology", "Surveillance NOC Overview").
const DemoBanner = ({
  name
}) => /*#__PURE__*/React.createElement("div", {
  className: "demo-banner",
  role: "alert"
}, /*#__PURE__*/React.createElement("span", {
  className: "demo-banner-pill"
}, "DEMO"), /*#__PURE__*/React.createElement("span", null, "This data is for Demo only and not live. The ", /*#__PURE__*/React.createElement("b", null, name), " page is part of the roadmap."));
window.SourceBadge = SourceBadge;
window.Sparkline = Sparkline;
window.Ring = Ring;
window.StatusDot = StatusDot;
window.Sev = Sev;
window.Icon = Icon;
window.DemoBanner = DemoBanner;