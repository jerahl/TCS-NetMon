// Switches dashboard widgets — host navigator, switch port viewer, problems

const {
  useState: useStateSW
} = React;

// ───────── Host Navigator ─────────
// activeId can be either a numeric hostid (live data) or a host shortname
// (mock data fallback). Rows with a `hostid` field navigate to that switch
// by reloading the page with ?switchid=<hostid>; rows without it fall back
// to onSelect() for in-page selection (mock mode).
const HostNavigator = ({
  activeId,
  onSelect
}) => {
  const [sites, setSites] = useStateSW(window.SWITCH_SITES);
  const [loading, setLoading] = useStateSW(() => !!(window.SWITCH_LOADING && window.SWITCH_LOADING.fleet));
  // The bridge updates window.SWITCH_SITES in-place after the fleet fetch
  // resolves. Re-sync our local state on each tcs:switch-data event,
  // preserving expand/collapse choices by id so user toggles don't get
  // clobbered when a refresh lands.
  React.useEffect(() => {
    const sync = () => {
      const fresh = window.SWITCH_SITES || [];
      setSites(prev => {
        if (!prev || prev.length === 0) return fresh;
        const expandedById = Object.create(null);
        for (const s of prev) expandedById[s.id] = !!s.expanded;
        return fresh.map(s => ({
          ...s,
          expanded: s.id in expandedById ? expandedById[s.id] : s.expanded
        }));
      });
      setLoading(!!(window.SWITCH_LOADING && window.SWITCH_LOADING.fleet));
    };
    window.addEventListener("tcs:switch-data", sync);
    return () => window.removeEventListener("tcs:switch-data", sync);
  }, []);
  const toggle = idx => {
    setSites(sites.map((s, i) => i === idx ? {
      ...s,
      expanded: !s.expanded
    } : s));
  };
  const isActive = sw => {
    if (!activeId) return !!sw.selected;
    const a = String(activeId);
    return a === String(sw.hostid || "") || a === String(sw.id);
  };
  const onRowClick = sw => {
    // Always let the parent update activeId so the page header / KPI tiles
    // re-bind to the new switch immediately. Then fire SPA-style navigation
    // which kicks off the snapshot fetch in the background.
    onSelect(sw.id);
    if (sw.hostid && typeof window.tcsNavigateSwitch === "function") {
      window.tcsNavigateSwitch(sw.hostid);
    }
  };
  const totalHosts = sites.reduce((n, s) => n + (s.switches || []).length, 0);
  return /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "Host navigator"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("span", {
    className: "h-meta"
  }, loading && totalHosts === 0 ? /*#__PURE__*/React.createElement("span", {
    className: "hn-loading-inline"
  }, /*#__PURE__*/React.createElement("span", {
    className: "hn-spinner"
  }), " loading\u2026") : `${totalHosts} switches`)), /*#__PURE__*/React.createElement("div", {
    className: "host-nav"
  }, loading && sites.length === 0 && /*#__PURE__*/React.createElement("div", {
    className: "hn-loading"
  }, /*#__PURE__*/React.createElement("span", {
    className: "hn-spinner"
  }), /*#__PURE__*/React.createElement("span", {
    className: "hn-loading-lbl"
  }, "Loading fleet\u2026")), sites.map((site, i) => /*#__PURE__*/React.createElement("div", {
    className: "host-nav-section",
    key: site.id
  }, /*#__PURE__*/React.createElement("div", {
    className: "host-nav-site" + (site.expanded ? "" : " collapsed"),
    onClick: () => toggle(i)
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
  }, site.name), site.problems > 0 && /*#__PURE__*/React.createElement("span", {
    className: "site-prob"
  }, site.problems)), /*#__PURE__*/React.createElement("div", {
    className: "host-nav-children" + (site.expanded ? "" : " hidden")
  }, site.switches.map(sw => /*#__PURE__*/React.createElement("div", {
    key: sw.hostid || sw.id,
    className: "host-nav-host" + (isActive(sw) ? " active" : ""),
    onClick: () => onRowClick(sw),
    title: sw.ip ? `${sw.id} · ${sw.ip}` : sw.id
  }, /*#__PURE__*/React.createElement("span", {
    className: "h-id"
  }, sw.id), sw.problems > 0 && /*#__PURE__*/React.createElement("span", {
    className: "h-prob"
  }, "\u25CF"))))))));
};

// ───────── Single port cell ─────────
const Port = ({
  p,
  selected,
  onClick
}) => {
  if (p.state === "absent") {
    return /*#__PURE__*/React.createElement("div", {
      className: "port absent",
      title: `Port ${p.n} — not present`
    }, /*#__PURE__*/React.createElement("div", {
      className: "pn"
    }, p.n), /*#__PURE__*/React.createElement("div", {
      className: "body"
    }), /*#__PURE__*/React.createElement("div", {
      style: {
        height: 4
      }
    }));
  }
  const speedClass = p.state === "up" ? `spd-${p.speed}` : "";
  const cls = ["port", p.state, speedClass, p.poe ? "poe" : "", p.err ? "err" : "", p.alert ? "alert" : "", p.state === "down" ? "searching" : "", selected ? "selected" : ""].filter(Boolean).join(" ");
  const speedLbl = p.speed === 10000 ? "10G" : p.speed === 1000 ? "1G" : p.speed === 100 ? "100M" : "10M";
  return /*#__PURE__*/React.createElement("div", {
    className: cls,
    onClick: onClick,
    title: `Port ${p.n} · ${p.state}${p.state === "up" ? " · " + speedLbl : ""}${p.poe ? " · PoE" : ""}`
  }, /*#__PURE__*/React.createElement("div", {
    className: "pn"
  }, p.n), /*#__PURE__*/React.createElement("div", {
    className: "body"
  }, /*#__PURE__*/React.createElement("span", {
    className: "led led-link"
  }), /*#__PURE__*/React.createElement("span", {
    className: "led led-speed " + speedClass
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      height: 4
    }
  }));
};

// ───────── Member port grid (28 ports per row, two rows) ─────────
const MemberGrid = ({
  member,
  selected,
  onSelect
}) => {
  const odds = member.ports.filter(p => p.n % 2 === 1);
  const evens = member.ports.filter(p => p.n % 2 === 0);
  // repeat(0, …) is invalid CSS — fall back to 1 so an empty regular grid
  // still produces a renderable (zero-height) track instead of breaking
  // layout flow.
  const cols = Math.max(1, odds.length, evens.length);
  const isSel = n => selected && selected.member === member.idx && selected.port === n;
  const hasSfp = Array.isArray(member.sfp) && member.sfp.length > 0;
  return /*#__PURE__*/React.createElement("div", {
    className: "swport-row",
    style: hasSfp ? null : {
      gridTemplateColumns: "1fr"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gridTemplateRows: "1fr 1fr",
      gap: 5,
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "swport-grid",
    style: {
      gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
      minWidth: 0
    }
  }, odds.map(p => /*#__PURE__*/React.createElement(Port, {
    key: p.n,
    p: p,
    selected: isSel(p.n),
    onClick: () => onSelect(member.idx, p)
  }))), /*#__PURE__*/React.createElement("div", {
    className: "swport-grid",
    style: {
      gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
      minWidth: 0
    }
  }, evens.map(p => /*#__PURE__*/React.createElement(Port, {
    key: p.n,
    p: p,
    selected: isSel(p.n),
    onClick: () => onSelect(member.idx, p)
  })))), hasSfp && /*#__PURE__*/React.createElement("div", {
    className: "swport-sfp"
  }, /*#__PURE__*/React.createElement("div", {
    className: "sfp-label"
  }, "SFP"), member.sfp.map(s => /*#__PURE__*/React.createElement("div", {
    key: s.n,
    className: "sfp-port " + s.state,
    title: `SFP ${s.n} · ${s.state}`,
    onClick: () => onSelect(member.idx, {
      ...s,
      state: s.state,
      n: s.n,
      speed: s.speed,
      poe: false
    })
  }, /*#__PURE__*/React.createElement("div", {
    className: "core"
  }), /*#__PURE__*/React.createElement("div", {
    className: "pn"
  }, s.n)))));
};

// ───────── Port detail panes ─────────
const PfActionRow = ({
  mac
}) => {
  const [busy, setBusy] = React.useState(null); // "reevaluate_access" | "restart_switchport" | null
  const [msg, setMsg] = React.useState({
    kind: "",
    text: ""
  });
  const adminBase = (window.PF_ADMIN_BASE || "").replace(/\/+$/, "");
  // PF admin UI route is /admin/#/node/<mac> (singular) — matches the
  // pf_device reference widget. Trailing /info is invalid in PF 11+.
  const viewHref = adminBase && mac ? `${adminBase}/admin/#/node/${encodeURIComponent(mac)}` : null;
  const run = React.useCallback(async (op, label) => {
    if (!mac || busy) return;
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
    const r = await window.tcsPfDeviceAction(mac, op);
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
  }, [mac, busy]);
  return /*#__PURE__*/React.createElement("div", {
    className: "pf-actions"
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
    title: "PF admin URL not configured"
  }, "View in PacketFence"), /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: "pf-btn",
    onClick: () => run("reevaluate_access", "reevaluating"),
    disabled: !!busy,
    title: "Re-run PF role / access evaluation for this device"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "refresh",
    size: 11
  }), " ", busy === "reevaluate_access" ? "REEVALUATING…" : "Reevaluate access"), /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: "pf-btn warn",
    onClick: () => run("restart_switchport", "restarting"),
    disabled: !!busy,
    title: "Bounce the switch port via PF's SNMP integration"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "refresh",
    size: 11
  }), " ", busy === "restart_switchport" ? "RESTARTING…" : "Restart switchport"), msg.text && /*#__PURE__*/React.createElement("span", {
    className: "pf-msg" + (msg.kind === "err" ? " err" : "")
  }, msg.text));
};

// Normalize detail.device / detail.devices into one array so the tile
// works both with the new multi-MAC payload and any legacy single-device
// callers.
const pfDeviceList = detail => {
  if (!detail) return [];
  if (Array.isArray(detail.devices) && detail.devices.length) return detail.devices.filter(Boolean);
  return detail.device ? [detail.device] : [];
};

// Last two octets of a MAC, uppercased — used as the tab label.
const pfMacTail = mac => {
  const parts = String(mac || "").split(":");
  return (parts.length >= 2 ? parts.slice(-2).join(":") : String(mac || "")).toUpperCase();
};

// "5m" / "2h" / "1d" / "now", relative to the freshest lastSeen on the port.
const pfRelAge = (lastSeen, refMs) => {
  if (!lastSeen || lastSeen === "—") return "—";
  const t = Date.parse(String(lastSeen).replace(" ", "T"));
  if (!Number.isFinite(t)) return "";
  const dm = Math.max(0, Math.round((refMs - t) / 60000));
  if (dm < 1) return "now";
  if (dm < 60) return `${dm}m`;
  if (dm < 60 * 24) return `${Math.round(dm / 60)}h`;
  return `${Math.round(dm / (60 * 24))}d`;
};

// Threshold above which we expose the filter input + cap the rendered
// tab count. 100+ MACs on a trunk / uplink port shouldn't be impossible
// to navigate.
const PF_TAB_FILTER_THRESHOLD = 12;
const PF_TAB_RENDER_CAP = 60;
const PacketFenceDevicePane = ({
  host,
  detail
}) => {
  const devices = pfDeviceList(detail);
  const [activeIdx, setActiveIdx] = React.useState(0);
  const [filter, setFilter] = React.useState("");
  // Reset selection + filter on port change.
  React.useEffect(() => {
    setActiveIdx(0);
    setFilter("");
  }, [detail && detail.label]);
  if (!detail || devices.length === 0) {
    return /*#__PURE__*/React.createElement("div", {
      className: "pf-pane"
    }, /*#__PURE__*/React.createElement("div", {
      className: "pf-head"
    }, /*#__PURE__*/React.createElement("span", {
      className: "pf-host"
    }, "PacketFence device"), /*#__PURE__*/React.createElement(SourceBadge, {
      src: "pf"
    })), /*#__PURE__*/React.createElement("div", {
      className: "pf-card"
    }, /*#__PURE__*/React.createElement("div", {
      className: "pf-empty"
    }, detail ? "No registered device on this port" : "Click a port to see device")));
  }
  const multi = devices.length > 1;
  const refMs = devices.reduce((mx, dv) => {
    const t = Date.parse(String(dv.lastSeen || "").replace(" ", "T"));
    return Number.isNaN(t) ? mx : Math.max(mx, t);
  }, 0);

  // Filter (when shown) matches against MAC, hostname, IP, role text —
  // case-insensitive substring. We keep activeIdx pointed at the absolute
  // device list so the main card stays consistent even when filtered out.
  const showFilter = devices.length > PF_TAB_FILTER_THRESHOLD;
  const fq = filter.trim().toLowerCase();
  const filteredIdxs = !fq ? devices.map((_, i) => i) : devices.reduce((acc, dv, i) => {
    const hay = [dv.mac, dv.host, dv.ip, dv.role, dv.owner].join(" ").toLowerCase();
    if (hay.includes(fq)) acc.push(i);
    return acc;
  }, []);
  const renderedIdxs = filteredIdxs.slice(0, PF_TAB_RENDER_CAP);
  const hiddenCount = filteredIdxs.length - renderedIdxs.length;
  const safeIdx = Math.min(Math.max(activeIdx, 0), devices.length - 1);
  const d = devices[safeIdx];
  return /*#__PURE__*/React.createElement("div", {
    className: "pf-pane"
  }, /*#__PURE__*/React.createElement("div", {
    className: "pf-head"
  }, /*#__PURE__*/React.createElement("span", {
    className: "pf-host"
  }, "PacketFence device"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "pf"
  }), multi && /*#__PURE__*/React.createElement("span", {
    className: "pf-multi-pill",
    title: `${devices.length} MAC addresses learned on this port`
  }, /*#__PURE__*/React.createElement("i", {
    className: "pf-multi-dot"
  }), devices.length, " MACs on port")), /*#__PURE__*/React.createElement("div", {
    className: "pf-head",
    style: {
      marginBottom: 10,
      fontSize: 11
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--mono)",
      color: "var(--fg)"
    }
  }, host.id), /*#__PURE__*/React.createElement("span", {
    className: "pf-ifx"
  }, "ifIndex ", detail.ifIndex), /*#__PURE__*/React.createElement("span", {
    className: "pf-ifx"
  }, devices.length, " MAC", devices.length > 1 ? "s" : "", " learned"), /*#__PURE__*/React.createElement("span", {
    className: "pf-age"
  }, detail.ageMin < 60 ? `${detail.ageMin}m old` : `${Math.round(detail.ageMin / 60)}h old`)), multi && /*#__PURE__*/React.createElement(React.Fragment, null, showFilter && /*#__PURE__*/React.createElement("div", {
    className: "pf-mac-filter"
  }, /*#__PURE__*/React.createElement("input", {
    type: "text",
    value: filter,
    onChange: e => setFilter(e.target.value),
    placeholder: `Filter ${devices.length} MACs — MAC / host / IP / role`,
    spellCheck: false,
    autoComplete: "off"
  }), fq && /*#__PURE__*/React.createElement("span", {
    className: "pf-mac-filter-count"
  }, filteredIdxs.length, "/", devices.length)), /*#__PURE__*/React.createElement("div", {
    className: "pf-mac-tabs",
    role: "tablist",
    "aria-label": "MAC addresses on this port"
  }, renderedIdxs.map(i => {
    const dv = devices[i];
    const active = i === safeIdx;
    const age = pfRelAge(dv.lastSeen, refMs);
    return /*#__PURE__*/React.createElement("button", {
      key: dv.mac + ":" + i,
      type: "button",
      role: "tab",
      "aria-selected": active,
      className: "pf-mac-tab" + (active ? " active" : ""),
      onClick: () => setActiveIdx(i),
      title: `${dv.mac} · ${dv.host}`
    }, /*#__PURE__*/React.createElement("span", {
      className: `pf-mac-tab-role role-tag ${dv.roleClass || "unknown"}`
    }, dv.role || "—"), /*#__PURE__*/React.createElement("span", {
      className: "pf-mac-tab-mac"
    }, pfMacTail(dv.mac)), /*#__PURE__*/React.createElement("span", {
      className: "pf-mac-tab-reg " + (dv.reg === "REG" ? "reg" : "unreg")
    }, dv.reg), /*#__PURE__*/React.createElement("span", {
      className: "pf-mac-tab-age"
    }, age));
  }), hiddenCount > 0 && /*#__PURE__*/React.createElement("span", {
    className: "pf-mac-tab-overflow",
    title: "Narrow the filter to see these"
  }, "+ ", hiddenCount, " more"))), /*#__PURE__*/React.createElement("div", {
    className: "pf-card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "pf-mac"
  }, /*#__PURE__*/React.createElement("span", null, d.mac), /*#__PURE__*/React.createElement("span", {
    className: "reg-badge " + (d.reg === "REG" ? "reg" : "unreg")
  }, d.reg)), /*#__PURE__*/React.createElement("div", {
    className: "pf-kv"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "k"
  }, "IP"), /*#__PURE__*/React.createElement("div", {
    className: "v"
  }, d.ip, " ", /*#__PURE__*/React.createElement(SourceBadge, {
    src: "pf"
  }))), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "k"
  }, "Hostname"), /*#__PURE__*/React.createElement("div", {
    className: "v"
  }, d.host)), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "k"
  }, "Vendor"), /*#__PURE__*/React.createElement("div", {
    className: "v sans"
  }, d.vendor)), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "k"
  }, "OS"), /*#__PURE__*/React.createElement("div", {
    className: "v sans"
  }, d.os)), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "k"
  }, "Owner"), /*#__PURE__*/React.createElement("div", {
    className: "v",
    style: {
      fontSize: 10.5
    }
  }, d.owner)), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "k"
  }, "DHCP FP"), /*#__PURE__*/React.createElement("div", {
    className: "v",
    style: {
      fontSize: 10.5
    }
  }, d.dhcpFp.length > 22 ? d.dhcpFp.slice(0, 22) + "…" : d.dhcpFp)), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "k"
  }, "Last Seen"), /*#__PURE__*/React.createElement("div", {
    className: "v"
  }, d.lastSeen)), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "k"
  }, "Last ARP"), /*#__PURE__*/React.createElement("div", {
    className: "v muted",
    style: {
      color: "var(--muted)"
    }
  }, "0000-00-00 00:00:00")), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "k"
  }, "Last DHCP"), /*#__PURE__*/React.createElement("div", {
    className: "v"
  }, d.lastDhcp)), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "k"
  }, "Role"), /*#__PURE__*/React.createElement("div", {
    className: "v sans"
  }, /*#__PURE__*/React.createElement("span", {
    className: `role-tag ${d.roleClass || "unknown"}`
  }, d.role || "—"))), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "k"
  }, "Switch"), /*#__PURE__*/React.createElement("div", {
    className: "v"
  }, host.id)), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "k"
  }, "Port"), /*#__PURE__*/React.createElement("div", {
    className: "v"
  }, detail.label))), /*#__PURE__*/React.createElement(PfActionRow, {
    mac: d.mac
  })));
};
const formatRate = kbps => {
  if (kbps >= 1000) return [(kbps / 1000).toFixed(1), "Mbps"];
  return [kbps.toFixed(1), "Kbps"];
};

// Log-scaled bar width for unbounded counters (errors / discards). 0 → 0%,
// 1 error → small but visible, 100 → ~half, 10k+ → full bar.
const countBarPct = n => {
  if (!n || n <= 0) return 0;
  return Math.min(100, Math.max(6, Math.log10(n + 1) * 25));
};
const PortDetailPane = ({
  detail,
  onClose
}) => {
  const [cycleState, setCycleState] = React.useState({
    busy: false,
    msg: ""
  });
  const onCycle = React.useCallback(async () => {
    if (cycleState.busy || !detail || typeof window.tcsCyclePoe !== "function") return;
    // detail.label is "<member>:<port>" — parse to get the args.
    const [m, p] = String(detail.label || "").split(":").map(s => parseInt(s, 10));
    if (!m || !p) {
      setCycleState({
        busy: false,
        msg: "bad port"
      });
      return;
    }
    setCycleState({
      busy: true,
      msg: "queuing…"
    });
    const r = await window.tcsCyclePoe(m, p);
    setCycleState({
      busy: false,
      msg: r && r.ok ? r.message || "queued" : r && (r.error || r.message) || "failed"
    });
    setTimeout(() => setCycleState({
      busy: false,
      msg: ""
    }), 4000);
  }, [detail, cycleState.busy]);
  if (!detail) {
    return /*#__PURE__*/React.createElement("div", {
      className: "pd-pane"
    }, /*#__PURE__*/React.createElement("div", {
      className: "pd-head"
    }, /*#__PURE__*/React.createElement("span", {
      className: "pd-title"
    }, "Switch Port Detail")), /*#__PURE__*/React.createElement("div", {
      className: "pf-empty",
      style: {
        padding: "40px 16px"
      }
    }, "Click a port in the grid below to see details."));
  }
  const [inV, inU] = formatRate(detail.inKbps);
  const [outV, outU] = formatRate(detail.outKbps);
  const stateLbl = detail.state.toUpperCase();
  return /*#__PURE__*/React.createElement("div", {
    className: "pd-pane"
  }, /*#__PURE__*/React.createElement("div", {
    className: "pd-head"
  }, /*#__PURE__*/React.createElement("span", {
    className: "pd-title"
  }, "Switch Port Detail"), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 13,
      fontWeight: 600,
      color: "var(--fg)"
    }
  }, "Port ", detail.label), /*#__PURE__*/React.createElement("span", {
    className: "pd-sep"
  }, "\u2014"), /*#__PURE__*/React.createElement("span", {
    className: "pd-state-badge " + detail.state
  }, stateLbl)), /*#__PURE__*/React.createElement("div", {
    className: "pd-grid"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "pd-row"
  }, /*#__PURE__*/React.createElement("div", {
    className: "pd-lbl"
  }, "In ", /*#__PURE__*/React.createElement(Icon, {
    name: "events",
    size: 11
  })), /*#__PURE__*/React.createElement("div", {
    className: "pd-mid"
  }, /*#__PURE__*/React.createElement(Sparkline, {
    data: detail.inHist,
    color: "var(--info)",
    width: 200,
    height: 28
  })), /*#__PURE__*/React.createElement("div", {
    className: "pd-val"
  }, inV, " ", /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--muted)",
      fontSize: 11
    }
  }, inU))), /*#__PURE__*/React.createElement("div", {
    className: "pd-row"
  }, /*#__PURE__*/React.createElement("div", {
    className: "pd-lbl"
  }, "Out ", /*#__PURE__*/React.createElement(Icon, {
    name: "events",
    size: 11
  })), /*#__PURE__*/React.createElement("div", {
    className: "pd-mid"
  }, /*#__PURE__*/React.createElement(Sparkline, {
    data: detail.outHist,
    color: "var(--pf)",
    width: 200,
    height: 28
  })), /*#__PURE__*/React.createElement("div", {
    className: "pd-val"
  }, outV, " ", /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--muted)",
      fontSize: 11
    }
  }, outU))), /*#__PURE__*/React.createElement("div", {
    className: "pd-row"
  }, /*#__PURE__*/React.createElement("div", {
    className: "pd-lbl"
  }, "Utilization ", /*#__PURE__*/React.createElement(Icon, {
    name: "events",
    size: 11
  })), /*#__PURE__*/React.createElement("div", {
    className: "pd-mid"
  }, /*#__PURE__*/React.createElement("div", {
    className: "pd-util"
  }, /*#__PURE__*/React.createElement("i", {
    className: detail.utilPct > 80 ? "err" : detail.utilPct > 50 ? "warn" : "",
    style: {
      width: `${Math.max(1, detail.utilPct)}%`
    }
  }))), /*#__PURE__*/React.createElement("div", {
    className: "pd-val"
  }, detail.utilPct, "%")), /*#__PURE__*/React.createElement("div", {
    className: "pd-row"
  }, /*#__PURE__*/React.createElement("div", {
    className: "pd-lbl"
  }, "PoE"), /*#__PURE__*/React.createElement("div", {
    className: "pd-mid"
  }, detail.poe ? /*#__PURE__*/React.createElement("div", {
    className: "pd-poe-btns"
  }, /*#__PURE__*/React.createElement("span", {
    className: "pd-btn delivering"
  }, "Delivering Power"), /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: "pd-btn cycle",
    onClick: onCycle,
    disabled: cycleState.busy,
    title: "Cycle PoE on this port via rConfig",
    style: {
      cursor: cycleState.busy ? "wait" : "pointer",
      border: 0,
      font: "inherit"
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "refresh",
    size: 11
  }), " ", cycleState.busy ? "CYCLING…" : "CYCLE"), cycleState.msg && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 10.5,
      color: "var(--muted)",
      marginLeft: 6
    }
  }, cycleState.msg)) : /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 11,
      color: "var(--muted)"
    }
  }, "\u2014")), /*#__PURE__*/React.createElement("div", {
    className: "pd-val muted"
  }, detail.poe ? `${detail.poeWatts} W` : ""))), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "pd-row",
    style: {
      gridTemplateColumns: "1fr",
      display: "block",
      paddingBottom: 10
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "pd-lbl",
    style: {
      justifyContent: "space-between",
      display: "flex"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      display: "inline-flex",
      alignItems: "center",
      gap: 5
    }
  }, "1H Online State ", /*#__PURE__*/React.createElement(Icon, {
    name: "events",
    size: 11
  })), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--mono)",
      fontSize: 9.5,
      color: "var(--muted)",
      textTransform: "none",
      letterSpacing: 0
    }
  }, "now \u203A")), /*#__PURE__*/React.createElement("div", {
    className: "pd-heatmap",
    style: {
      marginTop: 6
    }
  }, detail.onlineHist.map((s, i) => /*#__PURE__*/React.createElement("i", {
    key: i,
    className: s
  })))), /*#__PURE__*/React.createElement("div", {
    className: "pd-row"
  }, /*#__PURE__*/React.createElement("div", {
    className: "pd-lbl"
  }, "Errors 1H ", /*#__PURE__*/React.createElement(Icon, {
    name: "events",
    size: 11
  })), /*#__PURE__*/React.createElement("div", {
    className: "pd-mid"
  }, /*#__PURE__*/React.createElement("div", {
    className: "pd-util"
  }, /*#__PURE__*/React.createElement("i", {
    className: detail.errors1h > 0 ? "err" : "",
    style: {
      width: `${countBarPct(detail.errors1h)}%`
    }
  }))), /*#__PURE__*/React.createElement("div", {
    className: "pd-val " + (detail.errors1h > 0 ? "warn" : "muted"),
    style: {
      fontSize: 11
    }
  }, detail.errors1h, " ", /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--muted)"
    }
  }, "(in ", detail.errIn || 0, " / out ", detail.errOut || 0, ")"))), /*#__PURE__*/React.createElement("div", {
    className: "pd-row"
  }, /*#__PURE__*/React.createElement("div", {
    className: "pd-lbl"
  }, "Discards 1H ", /*#__PURE__*/React.createElement(Icon, {
    name: "events",
    size: 11
  })), /*#__PURE__*/React.createElement("div", {
    className: "pd-mid"
  }, /*#__PURE__*/React.createElement("div", {
    className: "pd-util"
  }, /*#__PURE__*/React.createElement("i", {
    className: detail.discards1h > 0 ? "warn" : "",
    style: {
      width: `${countBarPct(detail.discards1h)}%`
    }
  }))), /*#__PURE__*/React.createElement("div", {
    className: "pd-val " + (detail.discards1h > 0 ? "warn" : "muted"),
    style: {
      fontSize: 11
    }
  }, detail.discards1h, " ", /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--muted)"
    }
  }, "(in ", detail.discIn || 0, " / out ", detail.discOut || 0, ")"))), /*#__PURE__*/React.createElement("div", {
    className: "pd-row"
  }, /*#__PURE__*/React.createElement("div", {
    className: "pd-lbl"
  }, "Link Speed"), /*#__PURE__*/React.createElement("div", {
    className: "pd-mid"
  }), /*#__PURE__*/React.createElement("div", {
    className: "pd-val"
  }, detail.speed >= 1000 ? `${detail.speed / 1000} Gbps` : `${detail.speed} Mbps`)), /*#__PURE__*/React.createElement("div", {
    className: "pd-row"
  }, /*#__PURE__*/React.createElement("div", {
    className: "pd-lbl"
  }, "VLAN"), /*#__PURE__*/React.createElement("div", {
    className: "pd-mid"
  }), /*#__PURE__*/React.createElement("div", {
    className: "pd-val"
  }, detail.portVlan ? /*#__PURE__*/React.createElement("span", null, /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--accent)",
      fontFamily: "var(--mono)"
    }
  }, detail.portVlan.vid), detail.portVlan.name ? ` · ${detail.portVlan.name}` : "") : /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--muted)"
    }
  }, "\u2014"))), detail.primaryAuth && (() => {
    const a = detail.primaryAuth;
    // etsysMultiAuthSessionStationAuthStatus codes
    const statusLabels = {
      1: "authSuccess",
      2: "authFail",
      3: "authInProgress",
      4: "authIdle",
      5: "authTerminated"
    };
    const statusLabel = statusLabels[a.status] || `status ${a.status || "?"}`;
    const statusClass = a.status === 1 ? "ok" : a.status === 3 ? "warn" : "err";
    return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
      className: "pd-row"
    }, /*#__PURE__*/React.createElement("div", {
      className: "pd-lbl"
    }, "Auth Session"), /*#__PURE__*/React.createElement("div", {
      className: "pd-mid"
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 11,
        color: "var(--fg)"
      }
    }, a.agentLabel), a.mac && /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 10.5,
        color: "var(--muted)",
        marginLeft: 8,
        fontFamily: "var(--mono)"
      }
    }, a.mac)), /*#__PURE__*/React.createElement("div", {
      className: "pd-val"
    }, /*#__PURE__*/React.createElement("span", {
      className: "pd-state-badge " + (a.applied ? "up" : "down"),
      title: a.applied ? "policy applied" : "not applied"
    }, a.applied ? "APPLIED" : "INACTIVE"))), /*#__PURE__*/React.createElement("div", {
      className: "pd-row"
    }, /*#__PURE__*/React.createElement("div", {
      className: "pd-lbl"
    }, "Auth Status"), /*#__PURE__*/React.createElement("div", {
      className: "pd-mid"
    }), /*#__PURE__*/React.createElement("div", {
      className: "pd-val " + statusClass
    }, statusLabel)), /*#__PURE__*/React.createElement("div", {
      className: "pd-row"
    }, /*#__PURE__*/React.createElement("div", {
      className: "pd-lbl"
    }, "Policy"), /*#__PURE__*/React.createElement("div", {
      className: "pd-mid"
    }), /*#__PURE__*/React.createElement("div", {
      className: "pd-val"
    }, a.policy != null ? /*#__PURE__*/React.createElement("span", null, /*#__PURE__*/React.createElement("span", {
      style: {
        color: "var(--accent)",
        fontFamily: "var(--mono)"
      }
    }, a.policy), a.policyName ? ` · ${a.policyName}` : "") : /*#__PURE__*/React.createElement("span", {
      style: {
        color: "var(--muted)"
      }
    }, "\u2014"))), detail.authSessions.length > 1 && /*#__PURE__*/React.createElement("div", {
      className: "pd-row"
    }, /*#__PURE__*/React.createElement("div", {
      className: "pd-lbl"
    }, "Other sessions"), /*#__PURE__*/React.createElement("div", {
      className: "pd-mid",
      style: {
        fontSize: 10.5,
        color: "var(--muted)"
      }
    }, detail.authSessions.filter(s => s !== a).map(s => s.agentLabel).join(", ")), /*#__PURE__*/React.createElement("div", {
      className: "pd-val muted"
    }, detail.authSessions.length - 1)));
  })())));
};

// ───────── Switch Port Status widget ─────────
const SwitchPortWidget = ({
  host,
  selected,
  onSelectPort
}) => {
  const stack = window.ARC_MDF_STACK;
  const totalUp = stack.reduce((n, m) => n + m.upCount, 0);
  const totalDown = stack.reduce((n, m) => n + m.downCount, 0);
  const totalPoe = stack.reduce((n, m) => n + m.poeCount, 0);
  return /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "Switch Port Status"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "ext"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("span", {
    className: "h-meta"
  }, "ExtremeCloud IQ \xB7 8s refresh"), /*#__PURE__*/React.createElement("span", {
    className: "h-link"
  }, "Open in ExtremeCloud ", /*#__PURE__*/React.createElement(Icon, {
    name: "external",
    size: 11
  }))), /*#__PURE__*/React.createElement("div", {
    className: "swport-head"
  }, /*#__PURE__*/React.createElement("div", {
    className: "swport-title"
  }, /*#__PURE__*/React.createElement("span", {
    className: "id"
  }, host.id), /*#__PURE__*/React.createElement("div", {
    className: "swport-legend"
  }, /*#__PURE__*/React.createElement("span", {
    className: "item"
  }, /*#__PURE__*/React.createElement("span", {
    className: "swatch",
    style: {
      background: "var(--ok)"
    }
  }), " Up (", totalUp, ")"), /*#__PURE__*/React.createElement("span", {
    className: "item"
  }, /*#__PURE__*/React.createElement("span", {
    className: "swatch",
    style: {
      background: "#1a1e28",
      borderColor: "var(--line)"
    }
  }), " Down (", totalDown, ")"), /*#__PURE__*/React.createElement("span", {
    className: "item"
  }, /*#__PURE__*/React.createElement("span", {
    className: "swatch",
    style: {
      background: "var(--bg-2)",
      border: "1px solid var(--line)"
    }
  }), " Disabled (0)"), /*#__PURE__*/React.createElement("span", {
    className: "item"
  }, /*#__PURE__*/React.createElement("span", {
    className: "swatch",
    style: {
      background: "transparent",
      border: "1px dashed var(--line)"
    }
  }), " Not Present (32)"), /*#__PURE__*/React.createElement("span", {
    className: "item"
  }, /*#__PURE__*/React.createElement("span", {
    className: "dot-led",
    style: {
      background: "var(--warn)",
      boxShadow: "0 0 4px var(--warn)"
    }
  }), " PoE On (", totalPoe, ")"), /*#__PURE__*/React.createElement("span", {
    className: "item"
  }, /*#__PURE__*/React.createElement("span", {
    className: "dot-led",
    style: {
      background: "var(--info)"
    }
  }), " Searching (137)")), /*#__PURE__*/React.createElement("div", {
    className: "swport-legend",
    style: {
      marginLeft: "auto"
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "item"
  }, /*#__PURE__*/React.createElement("span", {
    className: "swatch",
    style: {
      background: "#f0a52c"
    }
  }), " 10 Mbps (2)"), /*#__PURE__*/React.createElement("span", {
    className: "item"
  }, /*#__PURE__*/React.createElement("span", {
    className: "swatch",
    style: {
      background: "#c9d62b"
    }
  }), " 100 Mbps (", Math.round(totalUp * 0.18), ")"), /*#__PURE__*/React.createElement("span", {
    className: "item"
  }, /*#__PURE__*/React.createElement("span", {
    className: "swatch",
    style: {
      background: "var(--ok)"
    }
  }), " 1 Gbps (", Math.round(totalUp * 0.78), ")"), /*#__PURE__*/React.createElement("span", {
    className: "item"
  }, /*#__PURE__*/React.createElement("span", {
    className: "swatch",
    style: {
      background: "#2bd6c0"
    }
  }), " 10 Gbps (", Math.round(totalUp * 0.04), ")")))), /*#__PURE__*/React.createElement("div", {
    className: "swport-toolbar"
  }, /*#__PURE__*/React.createElement("span", {
    className: "chip-btn ok"
  }, /*#__PURE__*/React.createElement("span", {
    className: "dot",
    style: {
      background: "var(--ok)"
    }
  }), /*#__PURE__*/React.createElement("span", {
    className: "lbl-mono"
  }, "CPU"), " ", host.cpu, "%"), /*#__PURE__*/React.createElement("span", {
    className: "chip-btn ok"
  }, /*#__PURE__*/React.createElement("span", {
    className: "dot",
    style: {
      background: "var(--ok)"
    }
  }), /*#__PURE__*/React.createElement("span", {
    className: "lbl-mono"
  }, "MEM"), " ", host.mem, "%"), /*#__PURE__*/React.createElement("span", {
    className: "chip-btn warn"
  }, /*#__PURE__*/React.createElement("span", {
    className: "dot",
    style: {
      background: "var(--warn)"
    }
  }), /*#__PURE__*/React.createElement("span", {
    className: "lbl-mono"
  }, host.temp, "\xB0C")), /*#__PURE__*/React.createElement("span", {
    className: "chip-btn ok"
  }, /*#__PURE__*/React.createElement("span", {
    className: "dot",
    style: {
      background: "var(--ok)"
    }
  }), /*#__PURE__*/React.createElement("span", {
    className: "lbl-mono"
  }, "PSU")), /*#__PURE__*/React.createElement("span", {
    className: "chip-btn ok"
  }, /*#__PURE__*/React.createElement("span", {
    className: "dot",
    style: {
      background: "var(--ok)"
    }
  }), /*#__PURE__*/React.createElement("span", {
    className: "lbl-mono"
  }, "FAN"))), stack.map(m => /*#__PURE__*/React.createElement("div", {
    className: "swport-member",
    key: m.idx
  }, /*#__PURE__*/React.createElement("div", {
    className: "swport-member-head"
  }, /*#__PURE__*/React.createElement("span", {
    className: "m-id"
  }, "MEMBER ", /*#__PURE__*/React.createElement("span", {
    className: "m-num"
  }, m.idx)), /*#__PURE__*/React.createElement("span", {
    className: "m-stats"
  }, /*#__PURE__*/React.createElement("span", {
    className: "up"
  }, m.upCount, " up"), " / ", /*#__PURE__*/React.createElement("span", {
    className: "down"
  }, m.downCount, " down")), /*#__PURE__*/React.createElement("span", {
    className: "m-stats poe"
  }, /*#__PURE__*/React.createElement("svg", {
    width: "10",
    height: "12",
    viewBox: "0 0 10 12",
    fill: "currentColor"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M6 0 0 7h4l-1 5 6-7H5l1-5Z"
  })), m.poeCount, " PoE on")), /*#__PURE__*/React.createElement(MemberGrid, {
    member: m,
    selected: selected ? {
      member: selected.member,
      port: selected.port
    } : null,
    onSelect: onSelectPort
  }))));
};

// ───────── Problems widget ─────────
const ProblemsWidget = () => {
  const items = window.SWITCH_PROBLEMS;
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
  }, "Triggers \xB7 last 24h"), items.length === 0 ? /*#__PURE__*/React.createElement("div", {
    className: "empty-state"
  }, /*#__PURE__*/React.createElement("div", {
    className: "ico"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "search",
    size: 20
  })), /*#__PURE__*/React.createElement("div", {
    className: "lbl"
  }, "No data found")) : /*#__PURE__*/React.createElement("div", null, items.map((p, i) => /*#__PURE__*/React.createElement("div", {
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

// ───────── Stack KPI strip ─────────
const StackKPIs = ({
  host
}) => {
  const stack = window.ARC_MDF_STACK;
  const totalUp = stack.reduce((n, m) => n + m.upCount, 0);
  const H = window.ARC_MDF_HISTORY;
  const K = window.SWITCH_KPIS || {};
  const fmt = (v, suffix = "") => v === null || v === undefined ? "—" : Math.round(v * 10) / 10 + suffix;
  const cpuVal = K.cpu !== null && K.cpu !== undefined ? Math.round(K.cpu) : host.cpu;
  const tempVal = K.temp !== null && K.temp !== undefined ? Math.round(K.temp) : host.temp;
  const poeW = K.poeWatts;
  const poeMax = K.poeBudget;

  // Peak uplink RX from the history series, converted to a friendly unit.
  const peakRx = H.uplinkRx && H.uplinkRx.length ? Math.max(...H.uplinkRx) : 0;
  const peakRxV = peakRx >= 1000 ? (peakRx / 1000).toFixed(1) : Math.round(peakRx);
  const peakRxU = peakRx >= 1000 ? "Gbps" : "Mbps";
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
  }, "Stack Members"), /*#__PURE__*/React.createElement("div", {
    className: "val"
  }, stack.length, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 11,
      color: "var(--muted)",
      fontWeight: 500
    }
  }, " / 8 max")), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10,
      color: "var(--ok)",
      fontFamily: "var(--mono)"
    }
  }, "\u25CF all up")), /*#__PURE__*/React.createElement("div", {
    className: "swstat-cell"
  }, /*#__PURE__*/React.createElement("div", {
    className: "lbl"
  }, "Active Ports"), /*#__PURE__*/React.createElement("div", {
    className: "val"
  }, totalUp, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 11,
      color: "var(--muted)",
      fontWeight: 500
    }
  }, " / ", host.ports)), /*#__PURE__*/React.createElement(Sparkline, {
    data: (H.uplinkRx || []).map(v => Math.round(v / 30 + 60)),
    color: "var(--ok)",
    width: 120,
    height: 20
  })), /*#__PURE__*/React.createElement("div", {
    className: "swstat-cell"
  }, /*#__PURE__*/React.createElement("div", {
    className: "lbl"
  }, "PoE Budget"), /*#__PURE__*/React.createElement("div", {
    className: "val"
  }, fmt(poeW), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 11,
      color: "var(--muted)",
      fontWeight: 500
    }
  }, " W", poeMax ? ` / ${Math.round(poeMax)}` : "")), /*#__PURE__*/React.createElement(Sparkline, {
    data: H.poeWatts || [],
    color: "var(--warn)",
    width: 120,
    height: 20
  })), /*#__PURE__*/React.createElement("div", {
    className: "swstat-cell"
  }, /*#__PURE__*/React.createElement("div", {
    className: "lbl"
  }, "Uplink RX (peak)"), /*#__PURE__*/React.createElement("div", {
    className: "val"
  }, peakRxV, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 11,
      color: "var(--muted)",
      fontWeight: 500
    }
  }, " ", peakRxU)), /*#__PURE__*/React.createElement(Sparkline, {
    data: H.uplinkRx || [],
    color: "var(--zbx)",
    width: 120,
    height: 20
  })), /*#__PURE__*/React.createElement("div", {
    className: "swstat-cell"
  }, /*#__PURE__*/React.createElement("div", {
    className: "lbl"
  }, "CPU \xB7 1m"), /*#__PURE__*/React.createElement("div", {
    className: "val ok"
  }, cpuVal, "%"), /*#__PURE__*/React.createElement(Sparkline, {
    data: H.cpu || [],
    color: "var(--info)",
    width: 120,
    height: 20
  })), /*#__PURE__*/React.createElement("div", {
    className: "swstat-cell"
  }, /*#__PURE__*/React.createElement("div", {
    className: "lbl"
  }, "Temp (max)"), /*#__PURE__*/React.createElement("div", {
    className: "val warn"
  }, tempVal, "\xB0C"), /*#__PURE__*/React.createElement(Sparkline, {
    data: H.temp || [],
    color: "var(--pf)",
    width: 120,
    height: 20,
    threshold: 75
  }))));
};

// ───────── Uplink table ─────────
const UplinkTable = () => /*#__PURE__*/React.createElement("div", {
  className: "card"
}, /*#__PURE__*/React.createElement("div", {
  className: "card-h"
}, /*#__PURE__*/React.createElement("h3", null, "Uplinks \xB7 Top Talkers"), /*#__PURE__*/React.createElement(SourceBadge, {
  src: "zbx"
}), /*#__PURE__*/React.createElement("div", {
  className: "h-spacer"
}), /*#__PURE__*/React.createElement("span", {
  className: "h-meta"
}, "SNMP IF-MIB \xB7 30s poll")), /*#__PURE__*/React.createElement("table", {
  className: "link-tbl"
}, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", {
  style: {
    width: 60
  }
}, "Port"), /*#__PURE__*/React.createElement("th", {
  style: {
    width: 70
  }
}, "Type"), /*#__PURE__*/React.createElement("th", null, "Peer"), /*#__PURE__*/React.createElement("th", {
  style: {
    width: 90,
    textAlign: "right"
  }
}, "RX"), /*#__PURE__*/React.createElement("th", {
  style: {
    width: 90,
    textAlign: "right"
  }
}, "TX"), /*#__PURE__*/React.createElement("th", {
  style: {
    width: 130
  }
}, "Util"), /*#__PURE__*/React.createElement("th", {
  style: {
    width: 50,
    textAlign: "right"
  }
}, "Err"))), /*#__PURE__*/React.createElement("tbody", null, window.ARC_MDF_LINKS.map(l => /*#__PURE__*/React.createElement("tr", {
  key: l.name
}, /*#__PURE__*/React.createElement("td", {
  className: "fg",
  style: {
    color: "var(--accent)"
  }
}, l.name), /*#__PURE__*/React.createElement("td", null, l.type), /*#__PURE__*/React.createElement("td", null, l.peer), /*#__PURE__*/React.createElement("td", {
  style: {
    textAlign: "right"
  }
}, l.rxMbps, " Mbps"), /*#__PURE__*/React.createElement("td", {
  style: {
    textAlign: "right"
  }
}, l.txMbps, " Mbps"), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("span", {
  className: "util-bar"
}, /*#__PURE__*/React.createElement("i", {
  className: l.util > 50 ? "warn" : "",
  style: {
    width: `${Math.max(2, l.util)}%`
  }
})), l.util, "%"), /*#__PURE__*/React.createElement("td", {
  style: {
    textAlign: "right",
    color: l.errors > 0 ? "var(--warn)" : "var(--muted)"
  }
}, l.errors))))));

// ───────── Combined port detail row (used between stack and uplinks) ─────────
const PortDetailRow = ({
  host,
  detail
}) => /*#__PURE__*/React.createElement("div", {
  className: "card"
}, /*#__PURE__*/React.createElement("div", {
  className: "card-h"
}, /*#__PURE__*/React.createElement("h3", null, "Port Detail"), /*#__PURE__*/React.createElement(SourceBadge, {
  src: "pf"
}), /*#__PURE__*/React.createElement(SourceBadge, {
  src: "zbx"
}), /*#__PURE__*/React.createElement("div", {
  className: "h-spacer"
}), /*#__PURE__*/React.createElement("span", {
  className: "h-meta"
}, detail ? `${host.id} · Port ${detail.label}` : "click any port above")), /*#__PURE__*/React.createElement("div", {
  className: "port-detail-row"
}, /*#__PURE__*/React.createElement(PacketFenceDevicePane, {
  host: host,
  detail: detail
}), /*#__PURE__*/React.createElement(PortDetailPane, {
  detail: detail
})));
window.PortDetailRow = PortDetailRow;
window.SwitchPortWidget = SwitchPortWidget;
window.PacketFenceDevicePane = PacketFenceDevicePane;
window.PortDetailPane = PortDetailPane;
window.ProblemsWidget = ProblemsWidget;
window.StackKPIs = StackKPIs;
window.UplinkTable = UplinkTable;