// Problems — graphical, icon-first view of the active problem set.
// Ported from the Claude Design prototype (zabbix-extreme/project/
// problems-app.jsx) and wired to live data published by events-bridge.jsx
// → window.EV_EVENTS. Each problem is a tile of glyphs (severity color,
// host-class icon, status indicator, source mark, age bar, tag micro-icons).
// The trigger string only appears in the hover tooltip and the drawer.

const SEV_ORDER = {
  disaster: 5,
  high: 4,
  warning: 3,
  info: 2,
  ok: 1
};
const SEV_LABEL = {
  disaster: "Disaster",
  high: "High",
  warning: "Warning",
  info: "Info",
  ok: "Resolved"
};
const SEV_KEYS = ["disaster", "high", "warning", "info", "ok"];
const SEV_COLOR = {
  disaster: "#ff6b67",
  high: "#ff9a78",
  warning: "#ffc24b",
  info: "#6aa7ff",
  ok: "#5fd9a3"
};
const STATUS_LABEL = {
  open: "Open",
  ack: "Acknowledged",
  resolved: "Resolved",
  suppressed: "Suppressed"
};
const SOURCE_LABEL = {
  zbx: "Zabbix",
  pf: "PacketFence",
  ext: "ExtremeCloud"
};

// ───────── Glyph library ─────────
const Glyph = ({
  name,
  size = 22
}) => {
  const s = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.6,
    strokeLinecap: "round",
    strokeLinejoin: "round"
  };
  switch (name) {
    case "ap":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("circle", {
        cx: "12",
        cy: "17",
        r: "1.6",
        fill: "currentColor",
        stroke: "none"
      }), /*#__PURE__*/React.createElement("path", {
        d: "M8 14a5 5 0 0 1 8 0M5.5 11a8.5 8.5 0 0 1 13 0M3 8a12 12 0 0 1 18 0"
      }));
    case "switch":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("rect", {
        x: "3",
        y: "7",
        width: "18",
        height: "10",
        rx: "2"
      }), /*#__PURE__*/React.createElement("path", {
        d: "M7 17v2M10 17v2M13 17v2M16 17v2M7 5v2M16 5v2"
      }), /*#__PURE__*/React.createElement("circle", {
        cx: "18",
        cy: "12",
        r: ".8",
        fill: "currentColor",
        stroke: "none"
      }), /*#__PURE__*/React.createElement("circle", {
        cx: "15",
        cy: "12",
        r: ".8",
        fill: "currentColor",
        stroke: "none"
      }));
    case "server":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("rect", {
        x: "3.5",
        y: "4",
        width: "17",
        height: "6",
        rx: "1.5"
      }), /*#__PURE__*/React.createElement("rect", {
        x: "3.5",
        y: "14",
        width: "17",
        height: "6",
        rx: "1.5"
      }), /*#__PURE__*/React.createElement("circle", {
        cx: "7",
        cy: "7",
        r: ".9",
        fill: "currentColor",
        stroke: "none"
      }), /*#__PURE__*/React.createElement("circle", {
        cx: "7",
        cy: "17",
        r: ".9",
        fill: "currentColor",
        stroke: "none"
      }), /*#__PURE__*/React.createElement("path", {
        d: "M11 7h7M11 17h7"
      }));
    case "camera":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("rect", {
        x: "3",
        y: "7",
        width: "14",
        height: "10",
        rx: "2"
      }), /*#__PURE__*/React.createElement("path", {
        d: "M17 10l4-2v8l-4-2z"
      }), /*#__PURE__*/React.createElement("circle", {
        cx: "9",
        cy: "12",
        r: "2.4"
      }));
    case "identity":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("circle", {
        cx: "12",
        cy: "9",
        r: "3.4"
      }), /*#__PURE__*/React.createElement("path", {
        d: "M5 20c1-3.6 4-5.4 7-5.4s6 1.8 7 5.4"
      }), /*#__PURE__*/React.createElement("path", {
        d: "M15 11l2 2 4-4"
      }));
    case "shield":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("path", {
        d: "M12 3 4 6v6c0 4.4 3.4 7.7 8 9 4.6-1.3 8-4.6 8-9V6l-8-3Z"
      }));
    case "nvr":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("rect", {
        x: "3",
        y: "7",
        width: "18",
        height: "11",
        rx: "1.6"
      }), /*#__PURE__*/React.createElement("circle", {
        cx: "8",
        cy: "12.5",
        r: "1.6"
      }), /*#__PURE__*/React.createElement("path", {
        d: "M12 12.5h6"
      }));
    case "st-open":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("circle", {
        cx: "12",
        cy: "12",
        r: "4",
        fill: "currentColor",
        stroke: "none"
      }));
    case "st-ack":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("circle", {
        cx: "12",
        cy: "12",
        r: "4"
      }), /*#__PURE__*/React.createElement("path", {
        d: "m9.5 12 1.8 1.8L14.5 10.5"
      }));
    case "st-resolved":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("circle", {
        cx: "12",
        cy: "12",
        r: "6"
      }), /*#__PURE__*/React.createElement("path", {
        d: "m9 12 2.2 2.2L15.5 10"
      }));
    case "st-suppressed":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("rect", {
        x: "7.5",
        y: "10.5",
        width: "9",
        height: "6",
        rx: "1.4"
      }), /*#__PURE__*/React.createElement("path", {
        d: "M9.5 10.5V9a2.5 2.5 0 0 1 5 0v1.5"
      }));
    case "outage":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("path", {
        d: "M12 3v6M5 8.5a8 8 0 1 0 14 0"
      }));
    case "uplink":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("path", {
        d: "M12 5v14M7 10l5-5 5 5"
      }));
    case "port":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("rect", {
        x: "4",
        y: "6",
        width: "16",
        height: "12",
        rx: "1.6"
      }), /*#__PURE__*/React.createElement("path", {
        d: "M8 18v2M12 18v2M16 18v2"
      }));
    case "poe":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("path", {
        d: "M13 3 5 14h6l-1 7 8-11h-6l1-7Z"
      }));
    case "optic":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("circle", {
        cx: "12",
        cy: "12",
        r: "7"
      }), /*#__PURE__*/React.createElement("circle", {
        cx: "12",
        cy: "12",
        r: "2.5",
        fill: "currentColor",
        stroke: "none"
      }));
    case "radio":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("path", {
        d: "M5.5 8.5a9 9 0 0 1 13 0M8 11a5.5 5.5 0 0 1 8 0M10.5 13.5a2.5 2.5 0 0 1 3 0"
      }), /*#__PURE__*/React.createElement("circle", {
        cx: "12",
        cy: "17",
        r: "1.2",
        fill: "currentColor",
        stroke: "none"
      }));
    case "auth":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("circle", {
        cx: "10",
        cy: "11",
        r: "3.4"
      }), /*#__PURE__*/React.createElement("path", {
        d: "m13 11 7 0M17 11v3M20 11v3"
      }));
    case "db":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("ellipse", {
        cx: "12",
        cy: "6",
        rx: "7",
        ry: "2.5"
      }), /*#__PURE__*/React.createElement("path", {
        d: "M5 6v12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V6M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5"
      }));
    case "disk":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("circle", {
        cx: "12",
        cy: "12",
        r: "8"
      }), /*#__PURE__*/React.createElement("circle", {
        cx: "12",
        cy: "12",
        r: "2.5"
      }));
    case "cpu":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("rect", {
        x: "6",
        y: "6",
        width: "12",
        height: "12",
        rx: "2"
      }), /*#__PURE__*/React.createElement("rect", {
        x: "9",
        y: "9",
        width: "6",
        height: "6"
      }), /*#__PURE__*/React.createElement("path", {
        d: "M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3"
      }));
    case "firmware":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("rect", {
        x: "6",
        y: "6",
        width: "12",
        height: "12",
        rx: "1.5"
      }), /*#__PURE__*/React.createElement("path", {
        d: "M3 9h3M3 12h3M3 15h3M18 9h3M18 12h3M18 15h3M9 3v3M12 3v3M15 3v3M9 18v3M12 18v3M15 18v3"
      }));
    case "config":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("circle", {
        cx: "12",
        cy: "12",
        r: "3"
      }), /*#__PURE__*/React.createElement("path", {
        d: "M19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.5-2.4.9a7 7 0 0 0-2.1-1.2L14 3h-4l-.4 2.4a7 7 0 0 0-2.1 1.2L5.1 5.7l-2 3.5 2 1.6A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.6 2 3.5 2.4-.9a7 7 0 0 0 2.1 1.2L10 21h4l.4-2.4a7 7 0 0 0 2.1-1.2l2.4.9 2-3.5-2-1.6c.1-.4.1-.8.1-1.2Z"
      }));
    case "broadcast":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("circle", {
        cx: "12",
        cy: "12",
        r: "2"
      }), /*#__PURE__*/React.createElement("path", {
        d: "M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M5 5a10 10 0 0 0 0 14M19 5a10 10 0 0 1 0 14"
      }));
    case "fan":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("circle", {
        cx: "12",
        cy: "12",
        r: "2"
      }), /*#__PURE__*/React.createElement("path", {
        d: "M12 10c0-3 1-6 3-6s2 2 1 4-3 2-4 2ZM12 14c0 3-1 6-3 6s-2-2-1-4 3-2 4-2ZM10 12c-3 0-6-1-6-3s2-2 4-1 2 3 2 4ZM14 12c3 0 6 1 6 3s-2 2-4 1-2-3-2-4Z"
      }));
    case "temp":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("path", {
        d: "M14 4a2 2 0 0 0-4 0v9a4 4 0 1 0 4 0V4Z"
      }), /*#__PURE__*/React.createElement("circle", {
        cx: "12",
        cy: "17",
        r: "1.5",
        fill: "currentColor",
        stroke: "none"
      }));
    case "vpn":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("path", {
        d: "M3 12c4 0 4-6 9-6s5 6 9 6"
      }), /*#__PURE__*/React.createElement("path", {
        d: "M3 12c4 0 4 6 9 6s5-6 9-6"
      }));
    case "bgp":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("circle", {
        cx: "5",
        cy: "6",
        r: "1.6"
      }), /*#__PURE__*/React.createElement("circle", {
        cx: "19",
        cy: "12",
        r: "1.6"
      }), /*#__PURE__*/React.createElement("circle", {
        cx: "5",
        cy: "18",
        r: "1.6"
      }), /*#__PURE__*/React.createElement("path", {
        d: "m6.5 6 11 5M6.5 18l11-7"
      }));
    case "stp":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("circle", {
        cx: "12",
        cy: "5",
        r: "1.6"
      }), /*#__PURE__*/React.createElement("circle", {
        cx: "5",
        cy: "13",
        r: "1.6"
      }), /*#__PURE__*/React.createElement("circle", {
        cx: "12",
        cy: "13",
        r: "1.6"
      }), /*#__PURE__*/React.createElement("circle", {
        cx: "19",
        cy: "13",
        r: "1.6"
      }), /*#__PURE__*/React.createElement("circle", {
        cx: "8",
        cy: "20",
        r: "1.4"
      }), /*#__PURE__*/React.createElement("circle", {
        cx: "16",
        cy: "20",
        r: "1.4"
      }), /*#__PURE__*/React.createElement("path", {
        d: "M12 6.6V11.4M11 12 6 12M13 12l5 0M11.5 14l-3 4.5M12.5 14l3 4.5"
      }));
    case "stack":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("path", {
        d: "m12 3-9 4 9 4 9-4-9-4ZM3 12l9 4 9-4M3 17l9 4 9-4"
      }));
    case "queue":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("rect", {
        x: "3",
        y: "9",
        width: "3",
        height: "6"
      }), /*#__PURE__*/React.createElement("rect", {
        x: "8",
        y: "9",
        width: "3",
        height: "6"
      }), /*#__PURE__*/React.createElement("rect", {
        x: "13",
        y: "9",
        width: "3",
        height: "6"
      }), /*#__PURE__*/React.createElement("rect", {
        x: "18",
        y: "9",
        width: "3",
        height: "6"
      }));
    case "wan":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("circle", {
        cx: "12",
        cy: "12",
        r: "8.5"
      }), /*#__PURE__*/React.createElement("path", {
        d: "M3.5 12h17M12 3.5c3 3 3 14 0 17M12 3.5c-3 3-3 14 0 17"
      }));
    case "psu":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("rect", {
        x: "3",
        y: "6",
        width: "18",
        height: "12",
        rx: "2"
      }), /*#__PURE__*/React.createElement("path", {
        d: "m11 9-3 4h4l-2 4 4-5h-4l2-3Z",
        fill: "currentColor",
        stroke: "none"
      }));
    case "maint":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("path", {
        d: "m6 14 8-8a4 4 0 0 1 4-4l1 1-3 3 1 1 3-3 1 1a4 4 0 0 1-4 4l-8 8a2 2 0 0 1-3-3Z"
      }));
    case "abuse":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("circle", {
        cx: "12",
        cy: "12",
        r: "9"
      }), /*#__PURE__*/React.createElement("path", {
        d: "M8 8l8 8M16 8l-8 8"
      }));
    case "flap":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("path", {
        d: "M3 12h3l2-4 2 8 2-6 2 6 2-8 2 4h3"
      }));
    case "lockout":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("rect", {
        x: "6",
        y: "11",
        width: "12",
        height: "8",
        rx: "1.4"
      }), /*#__PURE__*/React.createElement("path", {
        d: "M9 11V8a3 3 0 0 1 6 0v3"
      }), /*#__PURE__*/React.createElement("path", {
        d: "m15.5 16.5 4-4M19.5 16.5l-4-4"
      }));
    case "policy":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("path", {
        d: "M6 3h10l4 4v14H6V3Z"
      }), /*#__PURE__*/React.createElement("path", {
        d: "M16 3v4h4M9 12h8M9 16h8M9 8h4"
      }));
    case "byod":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("rect", {
        x: "6",
        y: "3",
        width: "12",
        height: "18",
        rx: "2"
      }), /*#__PURE__*/React.createElement("path", {
        d: "M11 18h2"
      }));
    case "onboard":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("circle", {
        cx: "11",
        cy: "9",
        r: "3.4"
      }), /*#__PURE__*/React.createElement("path", {
        d: "M4 20c1-3.6 4-5.4 7-5.4s6 1.8 7 5.4"
      }), /*#__PURE__*/React.createElement("path", {
        d: "M19 6v6M16 9h6"
      }));
    case "rrm":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("circle", {
        cx: "12",
        cy: "12",
        r: "2"
      }), /*#__PURE__*/React.createElement("circle", {
        cx: "12",
        cy: "12",
        r: "5"
      }), /*#__PURE__*/React.createElement("circle", {
        cx: "12",
        cy: "12",
        r: "8"
      }));
    case "mesh":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("circle", {
        cx: "6",
        cy: "6",
        r: "1.6"
      }), /*#__PURE__*/React.createElement("circle", {
        cx: "18",
        cy: "6",
        r: "1.6"
      }), /*#__PURE__*/React.createElement("circle", {
        cx: "12",
        cy: "12",
        r: "1.6"
      }), /*#__PURE__*/React.createElement("circle", {
        cx: "6",
        cy: "18",
        r: "1.6"
      }), /*#__PURE__*/React.createElement("circle", {
        cx: "18",
        cy: "18",
        r: "1.6"
      }), /*#__PURE__*/React.createElement("path", {
        d: "m7.5 7 3 4M16.5 7l-3 4M7.5 17l3-4M16.5 17l-3-4"
      }));
    case "backup":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("rect", {
        x: "4",
        y: "4",
        width: "16",
        height: "6",
        rx: "1.4"
      }), /*#__PURE__*/React.createElement("rect", {
        x: "4",
        y: "14",
        width: "16",
        height: "6",
        rx: "1.4"
      }), /*#__PURE__*/React.createElement("path", {
        d: "M8 7h.01M8 17h.01"
      }));
    case "interfere":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("path", {
        d: "M3 12c2-3 3-3 5 0s3 3 5 0 3-3 5 0M5 18l14-12"
      }));
    case "capacity":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("rect", {
        x: "4",
        y: "4",
        width: "16",
        height: "16",
        rx: "2"
      }), /*#__PURE__*/React.createElement("path", {
        d: "M4 14h16M9 14V8M14 14V11M19 14V6"
      }));
    case "roam":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("circle", {
        cx: "7",
        cy: "12",
        r: "3"
      }), /*#__PURE__*/React.createElement("circle", {
        cx: "17",
        cy: "12",
        r: "3"
      }), /*#__PURE__*/React.createElement("path", {
        d: "M10 12h4M12 5v3M12 16v3"
      }));
    case "speed":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("path", {
        d: "M4 16a8 8 0 1 1 16 0"
      }), /*#__PURE__*/React.createElement("path", {
        d: "m13 11-2 5"
      }), /*#__PURE__*/React.createElement("circle", {
        cx: "12",
        cy: "16",
        r: "1.2",
        fill: "currentColor",
        stroke: "none"
      }));
    case "reboot":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("path", {
        d: "M4 12a8 8 0 1 1 2 5.3"
      }), /*#__PURE__*/React.createElement("path", {
        d: "M3 17v-4h4"
      }));
    case "stream":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("rect", {
        x: "3",
        y: "6",
        width: "18",
        height: "12",
        rx: "1.6"
      }), /*#__PURE__*/React.createElement("path", {
        d: "M3 9h18M6 6V4M18 6V4"
      }), /*#__PURE__*/React.createElement("path", {
        d: "m10 10 5 3-5 3z",
        fill: "currentColor",
        stroke: "none"
      }));
    case "quality":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("path", {
        d: "m12 3 2.6 6 6.4.6-4.8 4.3 1.4 6.3L12 17l-5.6 3.2 1.4-6.3L3 9.6 9.4 9z"
      }));
    case "vlan":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("rect", {
        x: "4",
        y: "6",
        width: "6",
        height: "4",
        rx: "1"
      }), /*#__PURE__*/React.createElement("rect", {
        x: "14",
        y: "6",
        width: "6",
        height: "4",
        rx: "1"
      }), /*#__PURE__*/React.createElement("rect", {
        x: "4",
        y: "14",
        width: "6",
        height: "4",
        rx: "1"
      }), /*#__PURE__*/React.createElement("rect", {
        x: "14",
        y: "14",
        width: "6",
        height: "4",
        rx: "1"
      }), /*#__PURE__*/React.createElement("path", {
        d: "M10 8h4M10 16h4M7 10v4M17 10v4"
      }));
    case "dhcp":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("path", {
        d: "M4 12h6l2-3 2 6 2-3h4"
      }), /*#__PURE__*/React.createElement("circle", {
        cx: "4",
        cy: "12",
        r: "1.2",
        fill: "currentColor",
        stroke: "none"
      }), /*#__PURE__*/React.createElement("circle", {
        cx: "20",
        cy: "12",
        r: "1.2",
        fill: "currentColor",
        stroke: "none"
      }));
    case "radius":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("circle", {
        cx: "12",
        cy: "12",
        r: "4"
      }), /*#__PURE__*/React.createElement("path", {
        d: "M12 4v3M12 17v3M4 12h3M17 12h3M6.3 6.3l2.1 2.1M15.6 15.6l2.1 2.1M6.3 17.7l2.1-2.1M15.6 8.4l2.1-2.1"
      }));
    case "recording":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("circle", {
        cx: "12",
        cy: "12",
        r: "4",
        fill: "currentColor",
        stroke: "none"
      }), /*#__PURE__*/React.createElement("circle", {
        cx: "12",
        cy: "12",
        r: "8"
      }));
    case "wifi":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("path", {
        d: "M3 9.5a13 13 0 0 1 18 0M6 13a8.5 8.5 0 0 1 12 0M9 16.5a4 4 0 0 1 6 0"
      }), /*#__PURE__*/React.createElement("circle", {
        cx: "12",
        cy: "20",
        r: "1.2",
        fill: "currentColor",
        stroke: "none"
      }));
    case "ospf":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("circle", {
        cx: "6",
        cy: "6",
        r: "1.6"
      }), /*#__PURE__*/React.createElement("circle", {
        cx: "18",
        cy: "6",
        r: "1.6"
      }), /*#__PURE__*/React.createElement("circle", {
        cx: "6",
        cy: "18",
        r: "1.6"
      }), /*#__PURE__*/React.createElement("circle", {
        cx: "18",
        cy: "18",
        r: "1.6"
      }), /*#__PURE__*/React.createElement("circle", {
        cx: "12",
        cy: "12",
        r: "1.6"
      }), /*#__PURE__*/React.createElement("path", {
        d: "m7.5 7 3 3.5M16.5 7l-3 3.5M7.5 17l3-3.5M16.5 17l-3-3.5"
      }));
    case "alert":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("path", {
        d: "M12 3 2 21h20L12 3Z"
      }), /*#__PURE__*/React.createElement("path", {
        d: "M12 10v5M12 17v.2"
      }));
    case "tag":
      return /*#__PURE__*/React.createElement("svg", s, /*#__PURE__*/React.createElement("path", {
        d: "M12 3H5v7l11 11 7-7L12 3Z"
      }), /*#__PURE__*/React.createElement("circle", {
        cx: "8",
        cy: "7",
        r: "1",
        fill: "currentColor",
        stroke: "none"
      }));
    default:
      return null;
  }
};
const SrcMark = ({
  src
}) => {
  const colors = {
    zbx: "#ff6b67",
    pf: "#8a7cff",
    ext: "#56c4ff"
  };
  return /*#__PURE__*/React.createElement("span", {
    className: "pt-src",
    style: {
      color: colors[src] || "var(--muted)"
    }
  }, (src || "?").toUpperCase());
};

// ───────── Host class & tag classifiers ─────────
// Substring match on the host group name (Zabbix-side) since real install
// groups don't follow the design's "wireless/" prefix convention.
const classifyHost = e => {
  const g = (e.group || "").toLowerCase();
  const h = (e.host || "").toLowerCase();
  if (/wireless|access\s*point|\bap\b|wifi|xiq/.test(g) || /^ap[-_]|xiq_ap/.test(h)) return "ap";
  if (/switch|exos|extreme/.test(g)) return "switch";
  if (/camera/.test(g)) return "camera";
  if (/nvr|milestone|xprotect|video/.test(g)) return "nvr";
  if (/identity|packetfence|pf/.test(g)) return "identity";
  if (/server|linux|windows/.test(g)) return "server";
  return "server";
};
const HOST_ICON = {
  ap: "ap",
  switch: "switch",
  server: "server",
  nvr: "nvr",
  camera: "camera",
  identity: "identity"
};

// Map a tag (string of "tag" or "tag:value") to a glyph name.
const TAG_GLYPH_TABLE = {
  outage: "outage",
  core: "stack",
  uplink: "uplink",
  wan: "wan",
  port: "port",
  flap: "flap",
  poe: "poe",
  sfp: "optic",
  optic: "optic",
  radio: "radio",
  interference: "interfere",
  capacity: "capacity",
  roam: "roam",
  mesh: "mesh",
  rrm: "rrm",
  coverage: "rrm",
  ap: "ap",
  camera: "camera",
  reboot: "reboot",
  stream: "stream",
  quality: "quality",
  nvr: "nvr",
  recording: "recording",
  db: "db",
  disk: "disk",
  slowq: "speed",
  replication: "db",
  backup: "backup",
  auth: "auth",
  "802.1x": "auth",
  radius: "radius",
  "auth-fail": "lockout",
  lockout: "lockout",
  portal: "broadcast",
  abuse: "abuse",
  policy: "policy",
  dhcp: "dhcp",
  quar: "shield",
  byod: "byod",
  vlan: "vlan",
  onboard: "onboard",
  new: "onboard",
  config: "config",
  change: "config",
  firmware: "firmware",
  drift: "firmware",
  "maint-win": "maint",
  auto: "config",
  maintenance: "maint",
  psu: "psu",
  power: "psu",
  env: "temp",
  temp: "temp",
  temperature: "temp",
  fan: "fan",
  dc: "server",
  pdu: "psu",
  bgp: "bgp",
  ospf: "ospf",
  stp: "stp",
  instability: "flap",
  security: "shield",
  l2: "broadcast",
  broadcast: "broadcast",
  mac: "tag",
  cluster: "stack",
  ha: "stack",
  legacy: "byod",
  deauth: "lockout",
  bp: "config",
  clients: "byod",
  controller: "stack",
  anchor: "stack",
  rekey: "auth",
  vpn: "vpn",
  l3: "wan",
  proxy: "queue",
  queue: "queue",
  cpu: "cpu",
  memory: "cpu",
  speed: "speed",
  link: "uplink",
  neighbor: "bgp",
  topology: "stp",
  status: "config",
  environmental: "temp",
  application: "config",
  scope: "tag"
};
const tagKey = t => (t.split(":")[0] || "").toLowerCase();
const TAG_GLYPH = t => TAG_GLYPH_TABLE[tagKey(t)];

// ───────── Helpers ─────────
const nowSecs = () => Math.floor(Date.now() / 1000);
const ageMinutes = e => Math.max(0, Math.floor((nowSecs() - (e.clock || nowSecs())) / 60));
const ageFraction = e => Math.min(1, ageMinutes(e) / (6 * 60));
const counts = (arr, fn) => {
  const o = {};
  arr.forEach(x => {
    const k = fn(x);
    o[k] = (o[k] || 0) + 1;
  });
  return o;
};

// rawSev from backend ("ok" means resolved). For grouping/coloring use rawSev
// when present, fall back to sev.
const sevOf = e => e.rawSev || e.sev || "info";

// ───────── Severity totem strip ─────────
const SeverityTotem = ({
  problems,
  active,
  setActive
}) => {
  const bySev = counts(problems, p => sevOf(p));
  const byHr = Array(6).fill(0).map(() => ({
    disaster: 0,
    high: 0,
    warning: 0,
    info: 0,
    ok: 0
  }));
  problems.forEach(p => {
    const idx = Math.min(5, Math.floor(ageMinutes(p) / 60));
    const s = sevOf(p);
    byHr[idx][s] = (byHr[idx][s] || 0) + 1;
  });
  return /*#__PURE__*/React.createElement("div", {
    className: "card",
    style: {
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "prb-totem"
  }, SEV_KEYS.map(sev => {
    const n = bySev[sev] || 0;
    const max = Math.max(1, ...byHr.map(h => h[sev]));
    return /*#__PURE__*/React.createElement("div", {
      key: sev,
      className: "prb-totem-cell sev-" + (sev === "warning" ? "warn" : sev) + "-c" + (active === sev ? " active" : ""),
      onClick: () => setActive(active === sev ? null : sev)
    }, /*#__PURE__*/React.createElement("div", {
      className: "prb-totem-row"
    }, /*#__PURE__*/React.createElement("div", {
      className: "prb-totem-glyph"
    }, /*#__PURE__*/React.createElement(Glyph, {
      name: sev === "disaster" || sev === "high" ? "alert" : sev === "warning" ? "config" : sev === "info" ? "broadcast" : "st-resolved",
      size: 16
    })), /*#__PURE__*/React.createElement("span", {
      className: "prb-totem-val"
    }, n)), /*#__PURE__*/React.createElement("div", {
      className: "prb-totem-spark"
    }, byHr.map((h, i) => /*#__PURE__*/React.createElement("span", {
      key: i,
      style: {
        height: `${h[sev] / max * 100}%`
      }
    }))), /*#__PURE__*/React.createElement("div", {
      className: "prb-totem-foot"
    }, /*#__PURE__*/React.createElement("span", null, /*#__PURE__*/React.createElement("b", null, SEV_LABEL[sev])), /*#__PURE__*/React.createElement("span", {
      style: {
        marginLeft: "auto"
      }
    }, "6h")));
  })));
};

// ───────── Site × Category matrix ─────────
const HOST_CLASSES = [{
  id: "ap",
  icon: "ap",
  label: "Wireless APs"
}, {
  id: "switch",
  icon: "switch",
  label: "Switches"
}, {
  id: "server",
  icon: "server",
  label: "Servers"
}, {
  id: "nvr",
  icon: "nvr",
  label: "NVR"
}, {
  id: "camera",
  icon: "camera",
  label: "Cameras"
}, {
  id: "identity",
  icon: "identity",
  label: "Identity"
}];
const SiteMatrix = ({
  problems
}) => {
  const sitesSet = new Set(problems.map(p => p.site).filter(s => s && s !== "—"));
  const sites = Array.from(sitesSet).sort();
  const cellMap = {};
  problems.forEach(p => {
    if (!p.site || p.site === "—") return;
    const k = `${p.site}|${classifyHost(p)}`;
    const cur = cellMap[k];
    const ps = sevOf(p);
    if (!cur) cellMap[k] = {
      count: 1,
      worstSev: ps
    };else {
      cur.count++;
      if (SEV_ORDER[ps] > SEV_ORDER[cur.worstSev]) cur.worstSev = ps;
    }
  });
  const gridTpl = `28px repeat(${HOST_CLASSES.length}, 1fr)`;
  return /*#__PURE__*/React.createElement("div", {
    className: "prb-matrix-card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "ch"
  }, /*#__PURE__*/React.createElement("h3", null, "Sites \xD7 Categories"), /*#__PURE__*/React.createElement("span", {
    className: "h-meta"
  }, sites.length, " sites \xB7 ", HOST_CLASSES.length, " classes")), /*#__PURE__*/React.createElement("div", {
    className: "matrix-grid",
    style: {
      gridTemplateColumns: gridTpl
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "mg-corner"
  }), HOST_CLASSES.map(c => /*#__PURE__*/React.createElement("div", {
    key: c.id,
    className: "mg-col-head",
    title: c.label
  }, /*#__PURE__*/React.createElement(Glyph, {
    name: c.icon,
    size: 16
  }))), sites.map(site => /*#__PURE__*/React.createElement(React.Fragment, {
    key: site
  }, /*#__PURE__*/React.createElement("div", {
    className: "mg-row-head"
  }, site), HOST_CLASSES.map(c => {
    const cell = cellMap[`${site}|${c.id}`];
    if (!cell) return /*#__PURE__*/React.createElement("div", {
      key: c.id,
      className: "mg-cell empty"
    });
    return /*#__PURE__*/React.createElement("div", {
      key: c.id,
      className: "mg-cell"
    }, /*#__PURE__*/React.createElement("span", {
      className: "mg-dot sev-" + (cell.worstSev === "warning" ? "warn" : cell.worstSev)
    }, cell.count > 1 ? cell.count : ""), /*#__PURE__*/React.createElement("span", {
      className: "mg-tip"
    }, site, " \xB7 ", c.label, " \xB7 ", cell.count, " \xB7 worst: ", SEV_LABEL[cell.worstSev]));
  }))), sites.length === 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      gridColumn: "1 / -1",
      padding: 24,
      textAlign: "center",
      color: "var(--muted)",
      fontSize: 12
    }
  }, "No site groups assigned. Tag hosts with a \"Site/<name>\" host group to populate this matrix.")), /*#__PURE__*/React.createElement("div", {
    className: "prb-legend"
  }, /*#__PURE__*/React.createElement("span", {
    className: "lg-row"
  }, /*#__PURE__*/React.createElement("span", {
    className: "lg-sw",
    style: {
      background: SEV_COLOR.disaster
    }
  }), " Disaster"), /*#__PURE__*/React.createElement("span", {
    className: "lg-row"
  }, /*#__PURE__*/React.createElement("span", {
    className: "lg-sw",
    style: {
      background: SEV_COLOR.high
    }
  }), " High"), /*#__PURE__*/React.createElement("span", {
    className: "lg-row"
  }, /*#__PURE__*/React.createElement("span", {
    className: "lg-sw",
    style: {
      background: SEV_COLOR.warning
    }
  }), " Warning"), /*#__PURE__*/React.createElement("span", {
    className: "lg-row"
  }, /*#__PURE__*/React.createElement("span", {
    className: "lg-sw",
    style: {
      background: SEV_COLOR.info
    }
  }), " Info"), /*#__PURE__*/React.createElement("span", {
    className: "lg-row",
    style: {
      marginLeft: "auto"
    }
  }, "Number on dot = problem count \xB7 color = worst severity")));
};

// ───────── Constellation (site × age) ─────────
const Constellation = ({
  problems
}) => {
  const sites = Array.from(new Set(problems.map(p => p.site).filter(s => s && s !== "—"))).sort();
  const maxAge = 6 * 60;
  const sitePos = site => {
    const i = sites.indexOf(site);
    if (i < 0) return 50;
    return (i + 0.5) / Math.max(1, sites.length) * 100;
  };
  const agePos = e => Math.min(0.96, ageMinutes(e) / maxAge) * 100;
  const yTicks = ["just now", "1h", "2h", "3h", "4h+"];
  return /*#__PURE__*/React.createElement("div", {
    className: "prb-matrix-card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "ch"
  }, /*#__PURE__*/React.createElement("h3", null, "Constellation \u2014 site \xD7 age"), /*#__PURE__*/React.createElement("span", {
    className: "h-meta"
  }, problems.length, " active")), /*#__PURE__*/React.createElement("div", {
    style: {
      position: "relative",
      paddingLeft: 32,
      paddingBottom: 20
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "prb-constel"
  }, /*#__PURE__*/React.createElement("div", {
    className: "prb-constel-y"
  }, yTicks.map((t, i) => /*#__PURE__*/React.createElement("span", {
    key: i
  }, t))), /*#__PURE__*/React.createElement("div", {
    className: "prb-constel-axis"
  }, sites.filter((_, i) => i % Math.max(1, Math.ceil(sites.length / 10)) === 0).map(s => /*#__PURE__*/React.createElement("span", {
    key: s
  }, s))), problems.map(p => {
    const s = sevOf(p);
    const sev = s === "warning" ? "warn" : s;
    const left = p.site && p.site !== "—" ? sitePos(p.site) : 50;
    const top = agePos(p);
    const size = s === "disaster" ? 18 : s === "high" ? 15 : s === "warning" ? 12 : 10;
    return /*#__PURE__*/React.createElement("span", {
      key: p.id,
      className: "constel-dot sev-" + sev + " status-" + p.status,
      style: {
        left: `${left}%`,
        top: `${top}%`,
        width: size,
        height: size
      }
    }, /*#__PURE__*/React.createElement("span", {
      className: "constel-tip"
    }, /*#__PURE__*/React.createElement("b", {
      style: {
        color: SEV_COLOR[s]
      }
    }, SEV_LABEL[s]), " \xB7 ", p.site || "—", /*#__PURE__*/React.createElement("br", null), p.host, /*#__PURE__*/React.createElement("br", null), p.trigger));
  }))));
};

// ───────── Problem tile (icon-only) ─────────
const ProblemTile = ({
  p,
  onClick
}) => {
  const s = sevOf(p);
  const sevCls = "sev-" + s;
  const statusCls = "status-" + p.status;
  const sevColor = SEV_COLOR[s];
  const hostClass = classifyHost(p);
  const ageFrac = ageFraction(p);
  const tagGlyphs = [];
  for (const t of p.tags || []) {
    const g = TAG_GLYPH(t);
    if (g && !tagGlyphs.find(x => x.g === g)) {
      tagGlyphs.push({
        t,
        g
      });
      if (tagGlyphs.length === 3) break;
    }
  }
  const statusIcon = p.status === "open" ? "st-open" : p.status === "ack" ? "st-ack" : p.status === "suppressed" ? "st-suppressed" : "st-resolved";
  return /*#__PURE__*/React.createElement("div", {
    className: "ptile " + sevCls + " " + statusCls,
    onClick: () => onClick(p)
  }, /*#__PURE__*/React.createElement("div", {
    className: "ptile-top"
  }, /*#__PURE__*/React.createElement("span", {
    className: "pt-icon-sm"
  }, /*#__PURE__*/React.createElement(Glyph, {
    name: HOST_ICON[hostClass],
    size: 16
  })), /*#__PURE__*/React.createElement(SrcMark, {
    src: p.source
  }), p.count > 1 && /*#__PURE__*/React.createElement("span", {
    className: "pt-count-inline"
  }, "\xD7", p.count), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1
    }
  }), /*#__PURE__*/React.createElement("span", {
    className: "pt-status " + p.status
  }, /*#__PURE__*/React.createElement(Glyph, {
    name: statusIcon,
    size: 11
  }))), /*#__PURE__*/React.createElement("div", {
    className: "ptile-body"
  }, /*#__PURE__*/React.createElement("div", {
    className: "pt-trigger",
    title: p.trigger
  }, p.trigger), /*#__PURE__*/React.createElement("div", {
    className: "pt-host",
    title: p.host
  }, p.host)), tagGlyphs.length > 0 && /*#__PURE__*/React.createElement("div", {
    className: "ptile-tags-row"
  }, tagGlyphs.map((tg, i) => /*#__PURE__*/React.createElement("span", {
    className: "ptag",
    key: i,
    title: tg.t
  }, /*#__PURE__*/React.createElement(Glyph, {
    name: tg.g,
    size: 11
  })))), /*#__PURE__*/React.createElement("div", {
    className: "ptile-bot"
  }, /*#__PURE__*/React.createElement("span", {
    className: "pt-site"
  }, p.site || "—"), /*#__PURE__*/React.createElement("span", {
    className: "pt-age-text",
    title: "Age " + p.age
  }, p.age), /*#__PURE__*/React.createElement("span", {
    className: "pt-age-wrap",
    title: "Age " + p.age
  }, /*#__PURE__*/React.createElement("span", {
    className: "pt-age-bar",
    style: {
      width: `${ageFrac * 100}%`
    }
  })), p.owner ? p.owner === "system" ? /*#__PURE__*/React.createElement("span", {
    className: "pt-owner-dot system",
    title: "System"
  }, "\xB7") : /*#__PURE__*/React.createElement("span", {
    className: "pt-owner-dot",
    title: p.owner
  }, p.owner[0].toUpperCase()) : null), /*#__PURE__*/React.createElement("div", {
    className: "ptile-tip"
  }, /*#__PURE__*/React.createElement("div", {
    className: "tip-h"
  }, /*#__PURE__*/React.createElement(Glyph, {
    name: HOST_ICON[hostClass],
    size: 14
  }), /*#__PURE__*/React.createElement("span", {
    className: "tip-host"
  }, p.host)), /*#__PURE__*/React.createElement("div", {
    className: "tip-trigger"
  }, p.trigger), /*#__PURE__*/React.createElement("div", {
    className: "tip-meta"
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: sevColor
    }
  }, SEV_LABEL[s]), /*#__PURE__*/React.createElement("span", null, STATUS_LABEL[p.status]), p.site && /*#__PURE__*/React.createElement("span", null, p.site), /*#__PURE__*/React.createElement("span", null, "age ", p.age), p.owner && /*#__PURE__*/React.createElement("span", null, "@", p.owner))));
};

// ───────── Toolbar ─────────
const Toolbar = ({
  view,
  setView,
  sevFilter,
  toggleSev,
  search,
  setSearch,
  problems,
  groupBy,
  setGroupBy
}) => {
  const bySev = counts(problems, p => sevOf(p));
  return /*#__PURE__*/React.createElement("div", {
    className: "prb-toolbar"
  }, /*#__PURE__*/React.createElement("div", {
    className: "seg-pick"
  }, /*#__PURE__*/React.createElement("button", {
    className: view === "mosaic" ? "active" : "",
    onClick: () => setView("mosaic")
  }, /*#__PURE__*/React.createElement(Glyph, {
    name: "capacity",
    size: 12
  }), " Mosaic"), /*#__PURE__*/React.createElement("button", {
    className: view === "constel" ? "active" : "",
    onClick: () => setView("constel")
  }, /*#__PURE__*/React.createElement(Glyph, {
    name: "rrm",
    size: 12
  }), " Constellation"), /*#__PURE__*/React.createElement("button", {
    className: view === "matrix" ? "active" : "",
    onClick: () => setView("matrix")
  }, /*#__PURE__*/React.createElement(Glyph, {
    name: "vlan",
    size: 12
  }), " Matrix only")), /*#__PURE__*/React.createElement("div", {
    className: "sev-filter-row"
  }, SEV_KEYS.map(sev => /*#__PURE__*/React.createElement("span", {
    key: sev,
    className: "sev-pill " + (sev === "warning" ? "warning" : sev) + (sevFilter.length && !sevFilter.includes(sev) ? " muted" : ""),
    onClick: () => toggleSev(sev)
  }, /*#__PURE__*/React.createElement("span", {
    className: "sev-pill-dot"
  }), /*#__PURE__*/React.createElement("span", {
    className: "sev-pill-n"
  }, bySev[sev] || 0)))), /*#__PURE__*/React.createElement("div", {
    className: "prb-search-mini"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "search",
    size: 12
  }), /*#__PURE__*/React.createElement("input", {
    value: search,
    onChange: e => setSearch(e.target.value),
    placeholder: "host / tag / site\u2026"
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }), /*#__PURE__*/React.createElement("div", {
    className: "seg-pick"
  }, /*#__PURE__*/React.createElement("button", {
    className: groupBy === "severity" ? "active" : "",
    onClick: () => setGroupBy("severity")
  }, "Severity"), /*#__PURE__*/React.createElement("button", {
    className: groupBy === "site" ? "active" : "",
    onClick: () => setGroupBy("site")
  }, "Site"), /*#__PURE__*/React.createElement("button", {
    className: groupBy === "category" ? "active" : "",
    onClick: () => setGroupBy("category")
  }, "Category"), /*#__PURE__*/React.createElement("button", {
    className: groupBy === "source" ? "active" : "",
    onClick: () => setGroupBy("source")
  }, "Source"), /*#__PURE__*/React.createElement("button", {
    className: groupBy === "none" ? "active" : "",
    onClick: () => setGroupBy("none")
  }, "Flat")));
};

// ───────── Mosaic ─────────
const Mosaic = ({
  problems,
  groupBy,
  onPick
}) => {
  if (problems.length === 0) {
    return /*#__PURE__*/React.createElement("div", {
      className: "prb-empty"
    }, /*#__PURE__*/React.createElement(Glyph, {
      name: "st-resolved",
      size: 48
    }), /*#__PURE__*/React.createElement("div", null, "No active problems match the current filters."));
  }
  const keyer = groupBy === "severity" ? p => sevOf(p) : groupBy === "site" ? p => p.site || "—" : groupBy === "category" ? p => classifyHost(p) : groupBy === "source" ? p => p.source || "—" : null;
  const groupLabel = g => {
    if (groupBy === "severity") return SEV_LABEL[g] || g;
    if (groupBy === "category") return HOST_CLASSES.find(c => c.id === g)?.label || g;
    if (groupBy === "source") return SOURCE_LABEL[g] || g;
    return g;
  };
  const sortPs = (a, b) => {
    const sa = sevOf(a),
      sb = sevOf(b);
    if (SEV_ORDER[sb] !== SEV_ORDER[sa]) return SEV_ORDER[sb] - SEV_ORDER[sa];
    return ageMinutes(a) - ageMinutes(b);
  };
  let groups;
  if (keyer) {
    const map = {};
    problems.forEach(p => {
      const k = keyer(p);
      (map[k] = map[k] || []).push(p);
    });
    groups = Object.entries(map);
    if (groupBy === "severity") {
      groups.sort((a, b) => SEV_ORDER[b[0]] - SEV_ORDER[a[0]]);
    } else {
      groups.sort((a, b) => b[1].length - a[1].length);
    }
  } else {
    groups = [["all", [...problems].sort(sortPs)]];
  }
  return /*#__PURE__*/React.createElement("div", {
    className: "prb-mosaic-wrap"
  }, /*#__PURE__*/React.createElement("div", {
    className: "prb-mosaic-h"
  }, /*#__PURE__*/React.createElement("h3", null, "Active problems"), /*#__PURE__*/React.createElement("span", {
    className: "h-meta"
  }, problems.length, " tiles \xB7 grouped by ", groupBy)), groups.map(([gKey, gPs]) => {
    const sevMix = counts(gPs, p => sevOf(p));
    const total = gPs.length;
    return /*#__PURE__*/React.createElement("div", {
      className: "prb-group",
      key: gKey
    }, groupBy !== "none" && /*#__PURE__*/React.createElement("div", {
      className: "prb-group-h"
    }, /*#__PURE__*/React.createElement("span", {
      className: "gh-key"
    }, groupLabel(gKey)), /*#__PURE__*/React.createElement("span", {
      className: "gh-n"
    }, gPs.length), /*#__PURE__*/React.createElement("span", {
      className: "gh-bar"
    }, SEV_KEYS.map(s => {
      const n = sevMix[s];
      if (!n) return null;
      return /*#__PURE__*/React.createElement("span", {
        key: s,
        style: {
          background: SEV_COLOR[s],
          flex: n / total
        }
      });
    }))), /*#__PURE__*/React.createElement("div", {
      className: "prb-mosaic"
    }, gPs.sort(sortPs).map(p => /*#__PURE__*/React.createElement(ProblemTile, {
      key: p.id,
      p: p,
      onClick: onPick
    }))));
  }));
};

// ───────── Drawer (reuses styling from events.css) ─────────
const Drawer = ({
  event,
  onClose
}) => {
  if (!event) return null;
  const s = sevOf(event);
  const hostClass = classifyHost(event);
  const timeline = [{
    t: event.ts,
    msg: `Event opened by ${(event.source || "zbx").toUpperCase()}`,
    who: "system"
  }, ...(event.count > 1 ? [{
    t: event.ts,
    msg: `Recurrence ×${event.count}`,
    who: "system"
  }] : []), ...(event.status === "ack" ? [{
    t: event.ts,
    msg: `Acknowledged`,
    who: event.owner || "operator"
  }] : []), ...(event.status === "suppressed" ? [{
    t: event.ts,
    msg: `Suppressed for maintenance window`,
    who: event.owner || "system"
  }] : [])];
  return /*#__PURE__*/React.createElement("div", {
    className: "evt-drawer open"
  }, /*#__PURE__*/React.createElement("div", {
    className: "drawer-h"
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: SEV_COLOR[s],
      display: "inline-flex"
    }
  }, /*#__PURE__*/React.createElement(Glyph, {
    name: HOST_ICON[hostClass],
    size: 20
  })), /*#__PURE__*/React.createElement("h3", null, event.id), /*#__PURE__*/React.createElement("span", {
    className: "ev-status " + event.status
  }, STATUS_LABEL[event.status]), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("span", {
    className: "icon-btn",
    onClick: onClose
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "close"
  }))), /*#__PURE__*/React.createElement("div", {
    className: "drawer-b"
  }, /*#__PURE__*/React.createElement("div", {
    className: "drawer-section"
  }, /*#__PURE__*/React.createElement("div", {
    className: "drawer-trigger",
    style: {
      borderLeft: `3px solid ${SEV_COLOR[s]}`,
      paddingLeft: 10
    }
  }, event.trigger), event.tags && event.tags.length > 0 && /*#__PURE__*/React.createElement("span", {
    className: "ev-tags"
  }, event.tags.map((t, i) => /*#__PURE__*/React.createElement("span", {
    key: i,
    className: "ev-tag"
  }, t)))), /*#__PURE__*/React.createElement("div", {
    className: "drawer-section"
  }, /*#__PURE__*/React.createElement("h4", null, "Identification"), /*#__PURE__*/React.createElement("div", {
    className: "drawer-meta-grid"
  }, /*#__PURE__*/React.createElement("span", {
    className: "k"
  }, "Severity"), "   ", /*#__PURE__*/React.createElement("span", {
    className: "v",
    style: {
      color: SEV_COLOR[s]
    }
  }, SEV_LABEL[s]), /*#__PURE__*/React.createElement("span", {
    className: "k"
  }, "Source"), "     ", /*#__PURE__*/React.createElement("span", {
    className: "v"
  }, /*#__PURE__*/React.createElement(SourceBadge, {
    src: event.source
  }), " ", SOURCE_LABEL[event.source]), /*#__PURE__*/React.createElement("span", {
    className: "k"
  }, "Host"), "       ", /*#__PURE__*/React.createElement("span", {
    className: "v"
  }, event.host), /*#__PURE__*/React.createElement("span", {
    className: "k"
  }, "Site"), "       ", /*#__PURE__*/React.createElement("span", {
    className: "v"
  }, event.site || "—"), /*#__PURE__*/React.createElement("span", {
    className: "k"
  }, "Class"), "      ", /*#__PURE__*/React.createElement("span", {
    className: "v"
  }, event.group), /*#__PURE__*/React.createElement("span", {
    className: "k"
  }, "Owner"), "      ", /*#__PURE__*/React.createElement("span", {
    className: "v"
  }, event.owner || /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--muted)"
    }
  }, "unassigned")), /*#__PURE__*/React.createElement("span", {
    className: "k"
  }, "Count"), "      ", /*#__PURE__*/React.createElement("span", {
    className: "v"
  }, "\xD7", event.count))), /*#__PURE__*/React.createElement("div", {
    className: "drawer-section"
  }, /*#__PURE__*/React.createElement("h4", null, "Timing"), /*#__PURE__*/React.createElement("div", {
    className: "drawer-meta-grid"
  }, /*#__PURE__*/React.createElement("span", {
    className: "k"
  }, "Opened"), "   ", /*#__PURE__*/React.createElement("span", {
    className: "v"
  }, event.tsFull || event.ts), /*#__PURE__*/React.createElement("span", {
    className: "k"
  }, "Age"), "      ", /*#__PURE__*/React.createElement("span", {
    className: "v"
  }, event.age), /*#__PURE__*/React.createElement("span", {
    className: "k"
  }, "Duration"), " ", /*#__PURE__*/React.createElement("span", {
    className: "v"
  }, event.duration))), /*#__PURE__*/React.createElement("div", {
    className: "drawer-section"
  }, /*#__PURE__*/React.createElement("h4", null, "Audit trail"), /*#__PURE__*/React.createElement("div", {
    className: "drawer-timeline"
  }, timeline.map((t, i) => /*#__PURE__*/React.createElement("div", {
    className: "t-row",
    key: i
  }, /*#__PURE__*/React.createElement("span", {
    className: "t-time"
  }, t.t), /*#__PURE__*/React.createElement("span", null, t.msg)))))), /*#__PURE__*/React.createElement("div", {
    className: "drawer-actions"
  }, event.status === "open" && /*#__PURE__*/React.createElement("button", {
    className: "btn primary"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "check",
    size: 12
  }), " Acknowledge"), event.status === "ack" && /*#__PURE__*/React.createElement("button", {
    className: "btn"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "check",
    size: 12
  }), " Resolve"), /*#__PURE__*/React.createElement("button", {
    className: "btn"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "lock",
    size: 12
  }), " Suppress 1h"), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer",
    style: {
      flex: 1
    }
  }), /*#__PURE__*/React.createElement("button", {
    className: "btn ghost"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "external",
    size: 12
  }), " Open host")));
};

// ───────── App ─────────
const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  view: "mosaic",
  size: "balanced",
  groupBy: "severity",
  showResolved: false,
  showSuppressed: false,
  showMatrix: true,
  showConstellation: true,
  density: "balanced"
} /*EDITMODE-END*/;
const useEventsTick = () => {
  const [tick, setTick] = React.useState(0);
  React.useEffect(() => {
    const onData = () => setTick(n => n + 1);
    window.addEventListener("tcs:events-data", onData);
    return () => window.removeEventListener("tcs:events-data", onData);
  }, []);
  return tick;
};
const ProblemsApp = () => {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const tick = useEventsTick();
  const [sevFilter, setSevFilter] = React.useState([]);
  const [search, setSearch] = React.useState(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      return params.get("site") || params.get("search") || "";
    } catch (e) {
      return "";
    }
  });
  const [focused, setFocused] = React.useState(null);
  const [activeSev, setActiveSev] = React.useState(null);
  const [refreshing, setRefreshing] = React.useState(false);
  React.useEffect(() => {
    const onData = () => setRefreshing(false);
    window.addEventListener("tcs:events-data", onData);
    return () => window.removeEventListener("tcs:events-data", onData);
  }, []);
  const toggleSev = sev => {
    setSevFilter(f => f.includes(sev) ? f.filter(x => x !== sev) : [...f, sev]);
  };
  const doRefresh = () => {
    setRefreshing(true);
    if (typeof window.tcsEventsRefresh === "function") window.tcsEventsRefresh();
  };
  const allEvents = window.EV_EVENTS || [];
  const problems = React.useMemo(() => {
    let list = allEvents;
    if (!t.showResolved) list = list.filter(e => e.status !== "resolved");
    if (!t.showSuppressed) list = list.filter(e => e.status !== "suppressed");
    if (activeSev) list = list.filter(e => sevOf(e) === activeSev);
    if (sevFilter.length) list = list.filter(e => sevFilter.includes(sevOf(e)));
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(e => e.host.toLowerCase().includes(q) || (e.site || "").toLowerCase().includes(q) || e.trigger.toLowerCase().includes(q) || (e.tags || []).some(x => x.toLowerCase().includes(q)));
    }
    return list;
  }, [allEvents, t.showResolved, t.showSuppressed, activeSev, sevFilter, search, tick]);
  const totalOpen = allEvents.filter(e => e.status === "open").length;
  const totalAck = allEvents.filter(e => e.status === "ack").length;
  const worstSev = (() => {
    for (const k of SEV_KEYS) {
      if (problems.some(e => sevOf(e) === k && e.status !== "resolved")) return k;
    }
    return "ok";
  })();
  return /*#__PURE__*/React.createElement("div", {
    className: "app",
    "data-density": t.density,
    "data-size": t.size,
    "data-screen-label": "Problems"
  }, /*#__PURE__*/React.createElement(GlobalSidebar, {
    active: "problems"
  }), /*#__PURE__*/React.createElement("div", {
    className: "main"
  }, /*#__PURE__*/React.createElement(GlobalTopbar, {
    crumb: ["Operations", "Problems"],
    onRefresh: doRefresh,
    refreshing: refreshing
  }), /*#__PURE__*/React.createElement("div", {
    className: "prb-header"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "host-title"
  }, /*#__PURE__*/React.createElement("h1", null, "Problems"), /*#__PURE__*/React.createElement("span", {
    className: "role-tag faculty",
    style: {
      fontSize: 10,
      padding: "1px 8px"
    }
  }, "VISUAL"), /*#__PURE__*/React.createElement("span", {
    className: "live-pill"
  }, /*#__PURE__*/React.createElement("span", {
    className: "live-dot"
  }), " Live \xB7 30s")), /*#__PURE__*/React.createElement("div", {
    className: "prb-header-meta"
  }, /*#__PURE__*/React.createElement("span", {
    className: "pill"
  }, /*#__PURE__*/React.createElement("span", {
    className: "lbl"
  }, "Sources"), " ", /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  })), /*#__PURE__*/React.createElement("span", {
    className: "pill"
  }, /*#__PURE__*/React.createElement("span", {
    className: "lbl"
  }, "Active"), " ", /*#__PURE__*/React.createElement("span", {
    className: "v"
  }, problems.length)), /*#__PURE__*/React.createElement("span", {
    className: "pill"
  }, /*#__PURE__*/React.createElement("span", {
    className: "lbl"
  }, "Open"), " ", /*#__PURE__*/React.createElement("span", {
    className: "v",
    style: {
      color: "var(--err)"
    }
  }, totalOpen)), /*#__PURE__*/React.createElement("span", {
    className: "pill"
  }, /*#__PURE__*/React.createElement("span", {
    className: "lbl"
  }, "Acknowledged"), " ", /*#__PURE__*/React.createElement("span", {
    className: "v"
  }, totalAck)), /*#__PURE__*/React.createElement("span", {
    className: "pill"
  }, /*#__PURE__*/React.createElement("span", {
    className: "lbl"
  }, "Worst"), " ", /*#__PURE__*/React.createElement("span", {
    className: "v",
    style: {
      color: SEV_COLOR[worstSev]
    }
  }, SEV_LABEL[worstSev]))))), /*#__PURE__*/React.createElement("div", {
    className: "body"
  }, /*#__PURE__*/React.createElement(SeverityTotem, {
    problems: allEvents.filter(e => t.showResolved ? true : e.status !== "resolved").filter(e => t.showSuppressed ? true : e.status !== "suppressed"),
    active: activeSev,
    setActive: setActiveSev
  }), (t.showMatrix || t.showConstellation) && t.view !== "matrix-only" && /*#__PURE__*/React.createElement("div", {
    className: "prb-matrix-wrap",
    style: !t.showMatrix || !t.showConstellation ? {
      gridTemplateColumns: "1fr"
    } : null
  }, t.showMatrix && /*#__PURE__*/React.createElement(SiteMatrix, {
    problems: problems
  }), t.showConstellation && /*#__PURE__*/React.createElement(Constellation, {
    problems: problems
  })), /*#__PURE__*/React.createElement(Toolbar, {
    view: t.view,
    setView: v => setTweak("view", v),
    sevFilter: sevFilter,
    toggleSev: toggleSev,
    search: search,
    setSearch: setSearch,
    problems: problems,
    groupBy: t.groupBy,
    setGroupBy: v => setTweak("groupBy", v)
  }), t.view === "mosaic" && /*#__PURE__*/React.createElement(Mosaic, {
    problems: problems,
    groupBy: t.groupBy,
    onPick: setFocused
  }), t.view === "constel" && /*#__PURE__*/React.createElement("div", {
    className: "prb-mosaic-wrap"
  }, /*#__PURE__*/React.createElement(Constellation, {
    problems: problems
  })), t.view === "matrix" && /*#__PURE__*/React.createElement("div", {
    className: "prb-mosaic-wrap"
  }, /*#__PURE__*/React.createElement(SiteMatrix, {
    problems: problems
  })))), focused && /*#__PURE__*/React.createElement(Drawer, {
    event: focused,
    onClose: () => setFocused(null)
  }), /*#__PURE__*/React.createElement(TweaksPanel, {
    title: "Tweaks"
  }, /*#__PURE__*/React.createElement(TweakSection, {
    title: "Layout"
  }, /*#__PURE__*/React.createElement(TweakRadio, {
    label: "Main view",
    value: t.view,
    options: [{
      value: "mosaic",
      label: "Mosaic"
    }, {
      value: "constel",
      label: "Swarm"
    }, {
      value: "matrix",
      label: "Matrix"
    }],
    onChange: v => setTweak("view", v)
  }), /*#__PURE__*/React.createElement(TweakRadio, {
    label: "Tile size",
    value: t.size,
    options: [{
      value: "dense",
      label: "Dense"
    }, {
      value: "balanced",
      label: "Balanced"
    }, {
      value: "large",
      label: "Large"
    }],
    onChange: v => setTweak("size", v)
  }), /*#__PURE__*/React.createElement(TweakSelect, {
    label: "Group tiles by",
    value: t.groupBy,
    options: [{
      value: "severity",
      label: "Severity"
    }, {
      value: "site",
      label: "Site"
    }, {
      value: "category",
      label: "Category"
    }, {
      value: "source",
      label: "Source"
    }, {
      value: "none",
      label: "Flat (no grouping)"
    }],
    onChange: v => setTweak("groupBy", v)
  })), /*#__PURE__*/React.createElement(TweakSection, {
    title: "Visible widgets"
  }, /*#__PURE__*/React.createElement(TweakToggle, {
    label: "Site \xD7 category matrix",
    value: t.showMatrix,
    onChange: v => setTweak("showMatrix", v)
  }), /*#__PURE__*/React.createElement(TweakToggle, {
    label: "Constellation swarm",
    value: t.showConstellation,
    onChange: v => setTweak("showConstellation", v)
  })), /*#__PURE__*/React.createElement(TweakSection, {
    title: "Include"
  }, /*#__PURE__*/React.createElement(TweakToggle, {
    label: "Resolved",
    value: t.showResolved,
    onChange: v => setTweak("showResolved", v)
  }), /*#__PURE__*/React.createElement(TweakToggle, {
    label: "Suppressed",
    value: t.showSuppressed,
    onChange: v => setTweak("showSuppressed", v)
  }))));
};
ReactDOM.createRoot(document.getElementById("root")).render(/*#__PURE__*/React.createElement(ProblemsApp, null));