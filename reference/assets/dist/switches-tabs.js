// Switches dashboard — extra tab views (Topology, Stack Health, VLAN, PoE, Macros/CLI, Triggers, Backups)

const {
  useState: useStateTAB
} = React;

// ───────────────────────────────────────────────────────────────────
// Shared data for tab content
// ───────────────────────────────────────────────────────────────────

window.TAB_STACK_HEALTH = [{
  idx: 1,
  role: "Backup",
  serial: "1903N-72101",
  uptime: "127d 04h",
  cpu: 22,
  cpu5: 18,
  mem: 36,
  temp: 67,
  fan1: 5400,
  fan2: 5320,
  psu1: 240,
  psu2: 238,
  version: "31.7.1.4"
}, {
  idx: 2,
  role: "Primary",
  serial: "1903N-72104",
  uptime: "127d 04h",
  cpu: 28,
  cpu5: 24,
  mem: 38,
  temp: 69,
  fan1: 5480,
  fan2: 5410,
  psu1: 244,
  psu2: 240,
  version: "31.7.1.4"
}, {
  idx: 3,
  role: "Standby",
  serial: "1903N-72107",
  uptime: "127d 04h",
  cpu: 25,
  cpu5: 22,
  mem: 36,
  temp: 71,
  fan1: 5620,
  fan2: 5580,
  psu1: 236,
  psu2: 0,
  version: "31.7.1.4",
  warn: "PSU2 absent"
}, {
  idx: 4,
  role: "Backup",
  serial: "1903N-72112",
  uptime: "  6d 11h",
  cpu: 19,
  cpu5: 17,
  mem: 34,
  temp: 65,
  fan1: 5380,
  fan2: 5290,
  psu1: 232,
  psu2: 230,
  version: "31.7.1.4"
}];

// Sparkline seed generator (deterministic small history)
function _spark(seed, base, jitter, len = 24) {
  let x = seed;
  return Array.from({
    length: len
  }, () => {
    x = (x * 9301 + 49297) % 233280;
    return Math.round(base + (x / 233280 - 0.5) * 2 * jitter);
  });
}
window.TAB_BACKUPS = [{
  ts: "2026-05-09 04:00:02",
  user: "auto (zbx-conf)",
  method: "SSH+SCP",
  size: "118.4 KB",
  lines: 4112,
  changed: 0,
  hash: "9c4e…f30a",
  note: "Nightly scheduled backup"
}, {
  ts: "2026-05-08 14:18:55",
  user: "ksimmons@tcs",
  method: "Web UI",
  size: "118.4 KB",
  lines: 4112,
  changed: 2,
  hash: "9c4e…f30a",
  note: "Added VLAN 100 untagged to 2:31"
}, {
  ts: "2026-05-08 04:00:01",
  user: "auto (zbx-conf)",
  method: "SSH+SCP",
  size: "118.3 KB",
  lines: 4110,
  changed: 0,
  hash: "8b9d…2e74",
  note: "Nightly scheduled backup"
}, {
  ts: "2026-05-07 11:42:11",
  user: "tservice@tcs",
  method: "SSH",
  size: "118.3 KB",
  lines: 4110,
  changed: 5,
  hash: "8b9d…2e74",
  note: "Updated uplink trunk config"
}, {
  ts: "2026-05-07 04:00:01",
  user: "auto (zbx-conf)",
  method: "SSH+SCP",
  size: "117.9 KB",
  lines: 4105,
  changed: 0,
  hash: "73af…ec01",
  note: "Nightly scheduled backup"
}, {
  ts: "2026-05-06 09:11:48",
  user: "ksimmons@tcs",
  method: "Web UI",
  size: "117.9 KB",
  lines: 4105,
  changed: 1,
  hash: "73af…ec01",
  note: "Updated SNMP location string"
}];
window.TAB_DIFF = [{
  type: "ctx",
  ln: 1242,
  txt: "configure vlan FACULTY tag 20"
}, {
  type: "ctx",
  ln: 1243,
  txt: "configure vlan FACULTY add ports 1:7,1:9,1:11 tagged"
}, {
  type: "del",
  ln: 1244,
  txt: "configure vlan PRINTERS add ports 2:31 untagged"
}, {
  type: "add",
  ln: 1244,
  txt: "configure vlan CAMERAS add ports 2:31 untagged"
}, {
  type: "ctx",
  ln: 1245,
  txt: "configure vlan VOIP add ports 1:42,4:11 untagged"
}];

// ───────────────────────────────────────────────────────────────────
// 1. TOPOLOGY (EDP-driven)
// ───────────────────────────────────────────────────────────────────
// EDP gives us, for each Extreme neighbor: which local port it's on,
// the neighbor's hostname, EXOS version, the neighbor's slot/port, and
// the age of the entry. EDP doesn't classify direction (uplink vs.
// downstream) so we render all neighbors in a single tier below the
// stack and let the operator infer.
const _fmtAge = sec => {
  if (sec == null || !isFinite(sec)) return "—";
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d`;
};
const TabTopology = ({
  host
}) => {
  const stack = window.ARC_MDF_STACK;
  const edp = Array.isArray(window.EDP_NEIGHBORS) ? window.EDP_NEIGHBORS : [];
  const loading = window.SWITCH_LOADING && window.SWITCH_LOADING.snapshot;
  // EDP entries are considered stale if older than 90s — the default
  // EDP advertisement interval is 60s, so two missed updates means the
  // peer's likely gone but the table hasn't aged out yet.
  const isStale = n => typeof n.age === "number" && n.age > 90;
  return /*#__PURE__*/React.createElement("div", {
    className: "tab-pane"
  }, /*#__PURE__*/React.createElement("div", {
    className: "topo-layout"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card topo-canvas-card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "Stack & EDP neighbors"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("span", {
    className: "h-meta"
  }, loading ? "loading…" : `EDP · ${edp.length} neighbor${edp.length === 1 ? "" : "s"}`)), /*#__PURE__*/React.createElement("div", {
    className: "topo-canvas"
  }, /*#__PURE__*/React.createElement("div", {
    className: "topo-stack"
  }, /*#__PURE__*/React.createElement("div", {
    className: "topo-tier-label"
  }, "STACK \xB7 ", host.id), /*#__PURE__*/React.createElement("div", {
    className: "topo-stack-rack"
  }, stack.map((m, i) => {
    const live = (window.STACK_MEMBERS || [])[i];
    const role = live && live.role || "—";
    return /*#__PURE__*/React.createElement("div", {
      key: m.idx,
      className: "topo-stack-member"
    }, /*#__PURE__*/React.createElement("div", {
      className: "m-bezel"
    }, /*#__PURE__*/React.createElement("div", {
      className: "m-led"
    }), /*#__PURE__*/React.createElement("div", {
      className: "m-id"
    }, "M", m.idx), /*#__PURE__*/React.createElement("div", {
      className: "m-role"
    }, role), /*#__PURE__*/React.createElement("div", {
      className: "m-ports"
    }, m.upCount, "\u2191 ", m.downCount, "\u2193"), /*#__PURE__*/React.createElement("div", {
      className: "m-bays"
    }, [0, 1, 2, 3].map(b => /*#__PURE__*/React.createElement("div", {
      key: b,
      className: "bay " + (b < 2 ? "lit" : "")
    }))), /*#__PURE__*/React.createElement("div", {
      className: "m-sfp"
    }, "SFP+")), i < stack.length - 1 && /*#__PURE__*/React.createElement("div", {
      className: "m-link"
    }));
  }), /*#__PURE__*/React.createElement("div", {
    className: "topo-stack-ring"
  }, /*#__PURE__*/React.createElement("svg", {
    viewBox: "0 0 40 220",
    preserveAspectRatio: "none"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M 8 12 C -8 60 -8 160 8 208"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M 32 12 C 48 60 48 160 32 208"
  }), /*#__PURE__*/React.createElement("circle", {
    cx: "8",
    cy: "12",
    r: "3"
  }), /*#__PURE__*/React.createElement("circle", {
    cx: "32",
    cy: "12",
    r: "3"
  }), /*#__PURE__*/React.createElement("circle", {
    cx: "8",
    cy: "208",
    r: "3"
  }), /*#__PURE__*/React.createElement("circle", {
    cx: "32",
    cy: "208",
    r: "3"
  })), /*#__PURE__*/React.createElement("div", {
    className: "ring-label"
  }, "stack ring")))), /*#__PURE__*/React.createElement("div", {
    className: "topo-tier topo-tier-down"
  }, /*#__PURE__*/React.createElement("div", {
    className: "topo-tier-label"
  }, "EXTREME NEIGHBORS \xB7 EDP"), loading && /*#__PURE__*/React.createElement("div", {
    className: "topo-row",
    style: {
      color: "var(--muted)",
      padding: "12px 0"
    }
  }, "Loading EDP neighbor data from Zabbix\u2026"), !loading && edp.length === 0 && /*#__PURE__*/React.createElement("div", {
    className: "topo-row",
    style: {
      color: "var(--muted)",
      padding: "12px 0"
    }
  }, "No EDP neighbors discovered. Confirm the vlan-poe-topology template patch is applied and EDP is enabled on the switch (`enable edp ports all`)."), !loading && edp.length > 0 && /*#__PURE__*/React.createElement("div", {
    className: "topo-row"
  }, edp.map((n, i) => /*#__PURE__*/React.createElement("div", {
    key: `${n.localIfIndex}-${n.deviceId}-${i}`,
    className: "topo-node edge" + (isStale(n) ? " down" : "")
  }, /*#__PURE__*/React.createElement("div", {
    className: "n-id"
  }, n.name || "(unknown)"), /*#__PURE__*/React.createElement("div", {
    className: "n-port"
  }, n.localLabel || "—", n.peerLabel ? ` → ${n.peerLabel}` : ""), n.version && /*#__PURE__*/React.createElement("div", {
    className: "n-port",
    style: {
      color: "var(--muted)"
    }
  }, "EXOS ", n.version), isStale(n) && /*#__PURE__*/React.createElement("div", {
    className: "n-err"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "alert",
    size: 9
  }), " stale \xB7 ", _fmtAge(n.age)))))))), /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "EDP neighbors"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("span", {
    className: "h-meta"
  }, loading ? "loading…" : `${edp.length} learned`)), loading && /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "18px 14px",
      color: "var(--muted)"
    }
  }, "Loading EDP neighbor data from Zabbix\u2026"), !loading && edp.length === 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "18px 14px",
      color: "var(--muted)"
    }
  }, "No EDP neighbors learned on this switch."), !loading && edp.length > 0 && /*#__PURE__*/React.createElement("table", {
    className: "link-tbl"
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", {
    style: {
      width: 56
    }
  }, "Local"), /*#__PURE__*/React.createElement("th", null, "Neighbor"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 70
    }
  }, "R-Port"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 56
    }
  }, "Age"))), /*#__PURE__*/React.createElement("tbody", null, edp.map((n, i) => /*#__PURE__*/React.createElement("tr", {
    key: `${n.localIfIndex}-${n.deviceId}-${i}`
  }, /*#__PURE__*/React.createElement("td", {
    className: "fg",
    style: {
      color: "var(--accent)"
    }
  }, n.localLabel || "—"), /*#__PURE__*/React.createElement("td", {
    style: {
      whiteSpace: "normal",
      lineHeight: 1.35
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      color: "var(--fg)"
    }
  }, n.name || "(unknown)"), /*#__PURE__*/React.createElement("div", {
    style: {
      color: "var(--muted)",
      fontSize: 10
    }
  }, n.version ? `EXOS ${n.version}` : n.deviceId)), /*#__PURE__*/React.createElement("td", null, n.peerLabel || "—"), /*#__PURE__*/React.createElement("td", {
    style: {
      color: isStale(n) ? "var(--warn)" : "var(--muted)"
    }
  }, _fmtAge(n.age)))))))));
};

// ───────────────────────────────────────────────────────────────────
// 2. STACK HEALTH
// ───────────────────────────────────────────────────────────────────
const HealthMetric = ({
  label,
  val,
  unit,
  threshold,
  hist,
  color
}) => {
  const isWarn = threshold && val >= threshold;
  return /*#__PURE__*/React.createElement("div", {
    className: "hm-cell"
  }, /*#__PURE__*/React.createElement("div", {
    className: "hm-lbl"
  }, label), /*#__PURE__*/React.createElement("div", {
    className: "hm-val" + (isWarn ? " warn" : "")
  }, val, /*#__PURE__*/React.createElement("span", {
    className: "hm-unit"
  }, unit)), /*#__PURE__*/React.createElement(Sparkline, {
    data: hist,
    color: color || (isWarn ? "var(--warn)" : "var(--ok)"),
    width: 120,
    height: 22,
    threshold: threshold
  }));
};

// Build per-member rows from the live snapshot (window.STACK_MEMBERS).
// Returns [] when nothing has loaded yet; the tab shows a loading state
// in that case instead of falling back to fixture data.
const _fmtUptime = sec => {
  if (sec == null || !isFinite(sec) || sec <= 0) return null;
  const d = Math.floor(sec / 86400);
  const h = Math.floor(sec % 86400 / 3600);
  return `${d}d ${String(h).padStart(2, "0")}h`;
};
const buildMemberRows = () => {
  const live = Array.isArray(window.STACK_MEMBERS) ? window.STACK_MEMBERS : [];
  return live.map(m => {
    const fans = Array.isArray(m.fans) ? m.fans : [];
    const psus = Array.isArray(m.psus) ? m.psus : [];
    return {
      idx: m.idx,
      role: m.role || "Member",
      cpu: m.cpu != null ? Math.round(m.cpu) : null,
      cpu5: m.cpu5 != null ? Math.round(m.cpu5) : null,
      mem: m.mem != null ? Math.round(m.mem) : null,
      temp: m.temp != null ? Math.round(m.temp) : null,
      serial: m.serial || null,
      version: m.version || null,
      uptime: _fmtUptime(m.uptime),
      fanCells: [0, 1].map(i => {
        const f = fans[i];
        return f ? {
          rpm: f.rpm || 0,
          ok: f.ok !== false
        } : null;
      }),
      psuCells: [0, 1].map(i => {
        const p = psus[i];
        return p ? {
          watts: p.watts || 0,
          status: p.status || 0,
          present: !!p.present,
          ok: !!p.ok
        } : null;
      })
    };
  });
};
const TabStackHealth = () => {
  const H = buildMemberRows();
  const loading = window.SWITCH_LOADING && window.SWITCH_LOADING.snapshot || H.length === 0;
  return /*#__PURE__*/React.createElement("div", {
    className: "tab-pane"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h-bar"
  }, /*#__PURE__*/React.createElement("span", {
    className: "h-title"
  }, "Stack member health"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  })), loading && /*#__PURE__*/React.createElement("div", {
    className: "card",
    style: {
      padding: "24px 18px",
      textAlign: "center",
      color: "var(--muted)"
    }
  }, "Loading stack member data from Zabbix\u2026"), !loading && /*#__PURE__*/React.createElement("div", {
    className: "health-grid"
  }, H.map(m => /*#__PURE__*/React.createElement("div", {
    key: m.idx,
    className: "card health-card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "hc-head"
  }, /*#__PURE__*/React.createElement("div", {
    className: "hc-id-block"
  }, /*#__PURE__*/React.createElement("div", {
    className: "hc-id"
  }, "MEMBER ", m.idx), /*#__PURE__*/React.createElement("div", {
    className: "hc-role " + String(m.role || "").toLowerCase()
  }, m.role)), /*#__PURE__*/React.createElement("div", {
    className: "hc-side"
  }, /*#__PURE__*/React.createElement("div", {
    className: "kv"
  }, /*#__PURE__*/React.createElement("span", null, "Serial"), /*#__PURE__*/React.createElement("b", null, m.serial || "—")), /*#__PURE__*/React.createElement("div", {
    className: "kv"
  }, /*#__PURE__*/React.createElement("span", null, "EXOS"), /*#__PURE__*/React.createElement("b", null, m.version || "—")), /*#__PURE__*/React.createElement("div", {
    className: "kv"
  }, /*#__PURE__*/React.createElement("span", null, "Uptime"), /*#__PURE__*/React.createElement("b", null, m.uptime || "—")))), /*#__PURE__*/React.createElement("div", {
    className: "hm-grid"
  }, /*#__PURE__*/React.createElement(HealthMetric, {
    label: "CPU 1m",
    val: m.cpu != null ? m.cpu : "—",
    unit: m.cpu != null ? "%" : "",
    threshold: 85,
    hist: _spark(m.idx * 11, m.cpu || 0, 6),
    color: "var(--info)"
  }), /*#__PURE__*/React.createElement(HealthMetric, {
    label: "CPU 5m",
    val: m.cpu5 != null ? m.cpu5 : "—",
    unit: m.cpu5 != null ? "%" : "",
    threshold: 75,
    hist: _spark(m.idx * 17, m.cpu5 || 0, 4),
    color: "var(--info)"
  }), /*#__PURE__*/React.createElement(HealthMetric, {
    label: "Memory",
    val: m.mem != null ? m.mem : "—",
    unit: m.mem != null ? "%" : "",
    threshold: 90,
    hist: _spark(m.idx * 23, m.mem || 0, 3),
    color: "var(--zbx)"
  }), /*#__PURE__*/React.createElement(HealthMetric, {
    label: "Temp",
    val: m.temp != null ? m.temp : "—",
    unit: m.temp != null ? "°C" : "",
    threshold: 72,
    hist: _spark(m.idx * 29, m.temp || 0, 5),
    color: "var(--pf)"
  })), /*#__PURE__*/React.createElement("div", {
    className: "hc-foot"
  }, [0, 1].map(i => {
    const f = m.fanCells[i];
    if (!f) return /*#__PURE__*/React.createElement("div", {
      key: `fan${i}`,
      className: "hcf-cell"
    }, /*#__PURE__*/React.createElement("span", {
      className: "lbl"
    }, "FAN ", i + 1), /*#__PURE__*/React.createElement("span", {
      className: "val"
    }, "\u2014"));
    const failed = !f.ok;
    return /*#__PURE__*/React.createElement("div", {
      key: `fan${i}`,
      className: "hcf-cell"
    }, /*#__PURE__*/React.createElement("span", {
      className: "lbl"
    }, "FAN ", i + 1), /*#__PURE__*/React.createElement("span", {
      className: "val " + (failed ? "err" : f.rpm > 6000 ? "warn" : "")
    }, f.rpm > 0 ? `${f.rpm} RPM` : "—"));
  }), [0, 1].map(i => {
    const p = m.psuCells[i];
    if (!p) return /*#__PURE__*/React.createElement("div", {
      key: `psu${i}`,
      className: "hcf-cell"
    }, /*#__PURE__*/React.createElement("span", {
      className: "lbl"
    }, "PSU ", i + 1), /*#__PURE__*/React.createElement("span", {
      className: "val"
    }, "\u2014"));
    const absent = !p.present;
    return /*#__PURE__*/React.createElement("div", {
      key: `psu${i}`,
      className: "hcf-cell"
    }, /*#__PURE__*/React.createElement("span", {
      className: "lbl"
    }, "PSU ", i + 1), /*#__PURE__*/React.createElement("span", {
      className: "val " + (absent ? "err" : p.ok ? "" : "warn")
    }, absent ? "absent" : p.watts > 0 ? `${p.watts} W` : p.ok ? "ok" : "fault"));
  }))))));
};

// ───────────────────────────────────────────────────────────────────
// 3. VLAN
// ───────────────────────────────────────────────────────────────────
// Lookup port-set membership for a slot. Tagged/untagged ports come
// from the snapshot as per-slot 1-based port-number arrays. The "M:P"
// key is the same shape ARC_MDF_STACK uses.
const _vlanPortClass = (vlan, member, portNum) => {
  if (!vlan) return "u-out";
  const tag = (vlan.taggedPorts || {})[member] || [];
  const un = (vlan.untaggedPorts || {})[member] || [];
  if (un.includes(portNum)) return "u-in";
  if (tag.includes(portNum)) return "u-tag";
  return "u-out";
};
const TabVlan = () => {
  const V = Array.isArray(window.VLANS) ? window.VLANS : [];
  const loading = window.SWITCH_LOADING && window.SWITCH_LOADING.snapshot;
  // Pick the first VLAN by default; track by ifIndex so it stays stable
  // across snapshot refreshes even if a VID gets renumbered.
  const [sel, setSel] = useStateTAB(null);
  const selected = sel !== null ? V.find(v => v.ifIndex === sel) : V.find(v => v.active) || V[0] || null;
  const selVid = selected ? selected.vid : null;
  const userCount = V.filter(v => v.active && (v.vid ?? 0) !== 1).length;
  const sysCount = V.length - userCount;
  return /*#__PURE__*/React.createElement("div", {
    className: "tab-pane"
  }, /*#__PURE__*/React.createElement("div", {
    className: "vlan-layout"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "VLAN table"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("span", {
    className: "h-meta"
  }, loading ? "loading…" : `${V.length} VLAN${V.length === 1 ? "" : "s"} · ${userCount} user · ${sysCount} system`)), loading && /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "18px 14px",
      color: "var(--muted)"
    }
  }, "Loading VLAN data from Zabbix\u2026"), !loading && V.length === 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "18px 14px",
      color: "var(--muted)"
    }
  }, "No VLAN items found on this switch. Confirm the vlan-poe-topology template patch is applied."), !loading && V.length > 0 && /*#__PURE__*/React.createElement("table", {
    className: "vlan-tbl"
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", {
    style: {
      width: 50
    }
  }, "VID"), /*#__PURE__*/React.createElement("th", null, "Name"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 80
    }
  }, "Untagged"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 70
    }
  }, "Tagged"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 60
    }
  }, "State"))), /*#__PURE__*/React.createElement("tbody", null, V.map(v => /*#__PURE__*/React.createElement("tr", {
    key: v.ifIndex,
    className: selected && selected.ifIndex === v.ifIndex ? "sel" : "",
    onClick: () => setSel(v.ifIndex)
  }, /*#__PURE__*/React.createElement("td", {
    className: "mono fg",
    style: {
      color: "var(--accent)"
    }
  }, v.vid ?? "—"), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("div", {
    className: "vname"
  }, v.name || "(unnamed)")), /*#__PURE__*/React.createElement("td", {
    className: "mono"
  }, /*#__PURE__*/React.createElement("span", {
    className: "port-pill"
  }, v.untaggedCount)), /*#__PURE__*/React.createElement("td", {
    className: "mono"
  }, /*#__PURE__*/React.createElement("span", {
    className: "port-pill tag"
  }, v.taggedCount)), /*#__PURE__*/React.createElement("td", null, v.active ? /*#__PURE__*/React.createElement("span", {
    className: "state-dot ok",
    title: "enabled"
  }) : /*#__PURE__*/React.createElement("span", {
    className: "state-dot off",
    title: "disabled"
  }))))))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      gap: 14,
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, selected ? `VLAN ${selVid ?? "?"} · ${selected.name || "(unnamed)"}` : "Port membership"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("span", {
    className: "h-meta"
  }, selected ? `${selected.untaggedCount} untagged · ${selected.taggedCount} tagged` : "—")), /*#__PURE__*/React.createElement("div", {
    className: "vlan-portmap"
  }, !selected && /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "12px 4px",
      color: "var(--muted)"
    }
  }, "Select a VLAN to see its per-port membership."), selected && (window.ARC_MDF_STACK || []).map(m => /*#__PURE__*/React.createElement("div", {
    key: m.idx,
    className: "vp-row"
  }, /*#__PURE__*/React.createElement("span", {
    className: "vp-id"
  }, "M", m.idx), /*#__PURE__*/React.createElement("div", {
    className: "vp-grid"
  }, m.ports.map(p => {
    let cls = "u-absent";
    if (p.state !== "absent") {
      cls = _vlanPortClass(selected, m.idx, p.n);
    }
    return /*#__PURE__*/React.createElement("i", {
      key: p.n,
      className: cls,
      title: `${m.idx}:${p.n}`
    });
  })))), selected && /*#__PURE__*/React.createElement("div", {
    className: "vp-legend"
  }, /*#__PURE__*/React.createElement("span", null, /*#__PURE__*/React.createElement("i", {
    className: "u-in"
  }), " Untagged in VLAN ", selVid), /*#__PURE__*/React.createElement("span", null, /*#__PURE__*/React.createElement("i", {
    className: "u-tag"
  }), " Tagged in VLAN ", selVid), /*#__PURE__*/React.createElement("span", null, /*#__PURE__*/React.createElement("i", {
    className: "u-out"
  }), " Other VLAN"), /*#__PURE__*/React.createElement("span", null, /*#__PURE__*/React.createElement("i", {
    className: "u-absent"
  }), " Not present")))))));
};

// ───────────────────────────────────────────────────────────────────
// 4. PoE BUDGET
// ───────────────────────────────────────────────────────────────────
// Resolve a port "m.p" key into the freshest PF-known device, if any.
// The bridge populates _tcsPfByKey with one or more device rows per
// port; we take the first because (in PF v11+) it's the active node.
const _poePfDevice = (member, port) => {
  const bag = window._tcsPfByKey || {};
  const rows = bag[`${member}.${port}`];
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const r = rows[0] || {};
  return {
    device: r.computername || r.hostname || r.mac || "—",
    vendor: r.vendor || r.fingerprint || r.dhcp_fingerprint || "—",
    mac: r.mac || ""
  };
};
const TabPoe = () => {
  const P = window.POE_BUDGET;
  const loading = window.SWITCH_LOADING && window.SWITCH_LOADING.snapshot || P === null;
  if (loading) {
    return /*#__PURE__*/React.createElement("div", {
      className: "tab-pane"
    }, /*#__PURE__*/React.createElement("div", {
      className: "card",
      style: {
        padding: "24px 18px",
        textAlign: "center",
        color: "var(--muted)"
      }
    }, "Loading PoE budget data from Zabbix\u2026"));
  }
  const totals = P.totals || {
    drawn: 0,
    budget: 0,
    available: 0,
    measured: 0,
    pct: 0
  };
  const members = Array.isArray(P.members) ? P.members : [];
  const ports = Array.isArray(P.ports) ? P.ports : [];
  if (members.length === 0 && ports.length === 0) {
    return /*#__PURE__*/React.createElement("div", {
      className: "tab-pane"
    }, /*#__PURE__*/React.createElement("div", {
      className: "card",
      style: {
        padding: "24px 18px",
        textAlign: "center",
        color: "var(--muted)"
      }
    }, "No PoE items found on this switch. Confirm the vlan-poe-topology template patch is applied and the switch has PoE-capable hardware."));
  }

  // PSU redundancy comes from the per-member-health PSU data the Stack
  // Health tab already uses. Worst-case across members: any "absent" PSU
  // → N+0 / err; any "fault" → degraded / warn; otherwise N+1 / ok.
  const allPsus = (window.STACK_MEMBERS || []).flatMap(m => Array.isArray(m.psus) ? m.psus : []);
  let psuLabel = "—",
    psuClass = "",
    psuSub = "";
  if (allPsus.length > 0) {
    const absent = allPsus.filter(p => !p.present).length;
    const fault = allPsus.filter(p => p.present && !p.ok).length;
    if (absent > 0) {
      psuLabel = "N+0";
      psuClass = "err";
      psuSub = `${absent} PSU absent`;
    } else if (fault > 0) {
      psuLabel = "DEGRADED";
      psuClass = "warn";
      psuSub = `${fault} PSU fault`;
    } else {
      psuLabel = "N+1";
      psuClass = "ok";
      psuSub = `${allPsus.length} PSUs ok`;
    }
  }

  // Stack-wide totals from the available PSE envelope (sum of per-member
  // extremePethSlotMaxAvailPower) and the measured draw — fall back to
  // the allocated/configured-limit fields when those aren't present so
  // the headline still populates.
  const hlMeasured = totals.measured > 0 ? totals.measured : totals.drawn;
  const hlAvailable = members.reduce((acc, m) => acc + (m.available != null ? m.available : m.capacity != null ? m.capacity : m.budget), 0) || totals.budget;
  const hlPct = hlAvailable > 0 ? Math.round(hlMeasured / hlAvailable * 100) : 0;
  const hlHeadroom = Math.max(0, hlAvailable - hlMeasured);
  return /*#__PURE__*/React.createElement("div", {
    className: "tab-pane"
  }, /*#__PURE__*/React.createElement("div", {
    className: "poe-top"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card poe-headline"
  }, /*#__PURE__*/React.createElement("div", {
    className: "poe-hl-left"
  }, /*#__PURE__*/React.createElement(Ring, {
    value: hlMeasured,
    max: Math.max(hlAvailable, hlMeasured, 1),
    size: 140,
    color: "var(--warn)",
    label: `${Math.round(hlMeasured)} W`,
    sub: `of ${Math.round(hlAvailable)} W available`,
    threshold: hlAvailable * 0.85
  })), /*#__PURE__*/React.createElement("div", {
    className: "poe-hl-stats"
  }, /*#__PURE__*/React.createElement("div", {
    className: "phs"
  }, /*#__PURE__*/React.createElement("span", {
    className: "lbl"
  }, "Measured"), /*#__PURE__*/React.createElement("span", {
    className: "v warn"
  }, Math.round(hlMeasured), " W"), /*#__PURE__*/React.createElement("span", {
    className: "sub"
  }, hlPct, "% utilised")), /*#__PURE__*/React.createElement("div", {
    className: "phs"
  }, /*#__PURE__*/React.createElement("span", {
    className: "lbl"
  }, "Max available"), /*#__PURE__*/React.createElement("span", {
    className: "v"
  }, Math.round(hlAvailable), " W"), /*#__PURE__*/React.createElement("span", {
    className: "sub"
  }, "across ", members.length, " member", members.length === 1 ? "" : "s")), /*#__PURE__*/React.createElement("div", {
    className: "phs"
  }, /*#__PURE__*/React.createElement("span", {
    className: "lbl"
  }, "Headroom"), /*#__PURE__*/React.createElement("span", {
    className: "v ok"
  }, Math.round(hlHeadroom), " W"), /*#__PURE__*/React.createElement("span", {
    className: "sub"
  }, ports.length, " port", ports.length === 1 ? "" : "s", " drawing")), /*#__PURE__*/React.createElement("div", {
    className: "phs"
  }, /*#__PURE__*/React.createElement("span", {
    className: "lbl"
  }, "PSU redundancy"), /*#__PURE__*/React.createElement("span", {
    className: "v " + psuClass
  }, psuLabel), /*#__PURE__*/React.createElement("span", {
    className: "sub"
  }, psuSub || "—")))), /*#__PURE__*/React.createElement("div", {
    className: "card poe-perm"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "Per-member draw"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  })), /*#__PURE__*/React.createElement("div", {
    className: "poe-perm-body"
  }, members.length === 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "12px 4px",
      color: "var(--muted)"
    }
  }, "No per-slot PoE items reported."), members.map(m => {
    // Show actual measured PSE draw against the slot's max
    // available power envelope. measured =
    // extremePethSlotMeasuredPower, available =
    // extremePethSlotMaxAvailPower (the operational ceiling
    // given the current PSU mode and status).
    const measured = m.measured != null ? m.measured : m.drawn;
    const cap = m.available != null && m.available > 0 ? m.available : m.capacity != null ? m.capacity : m.budget;
    const pct = cap > 0 ? Math.round(measured / cap * 100) : 0;
    return /*#__PURE__*/React.createElement("div", {
      key: m.idx,
      className: "ppm-row"
    }, /*#__PURE__*/React.createElement("div", {
      className: "ppm-id"
    }, "MEMBER ", m.idx), /*#__PURE__*/React.createElement("div", {
      className: "ppm-bar"
    }, /*#__PURE__*/React.createElement("i", {
      className: pct > 80 ? "warn" : "",
      style: {
        width: `${Math.min(100, pct)}%`
      }
    }), /*#__PURE__*/React.createElement("span", {
      className: "ppm-val"
    }, Math.round(measured), " / ", Math.round(cap), " W")), /*#__PURE__*/React.createElement("div", {
      className: "ppm-ports"
    }, m.portCount, " port", m.portCount === 1 ? "" : "s"), /*#__PURE__*/React.createElement("div", {
      className: "ppm-pct"
    }, pct, "%"));
  })))), /*#__PURE__*/React.createElement("div", {
    className: "card",
    style: {
      marginTop: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "Top PoE consumers"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  }), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "pf"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("span", {
    className: "h-meta"
  }, ports.length === 0 ? "no ports drawing" : `${Math.min(ports.length, 25)} of ${ports.length} shown · sorted by W`)), ports.length === 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "18px 14px",
      color: "var(--muted)"
    }
  }, "No ports reporting measured PoE draw."), ports.length > 0 && /*#__PURE__*/React.createElement("table", {
    className: "link-tbl poe-tbl"
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", {
    style: {
      width: 60
    }
  }, "Port"), /*#__PURE__*/React.createElement("th", null, "Device"), /*#__PURE__*/React.createElement("th", null, "Vendor"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 90
    }
  }, "Class"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 160
    }
  }, "Draw"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 80,
      textAlign: "right"
    }
  }, "Watts"))), /*#__PURE__*/React.createElement("tbody", null, ports.slice(0, 25).map((c, i) => {
    const pf = _poePfDevice(c.member, c.port);
    // class-4 ports can draw up to 25.5W; use that as the bar
    // ceiling so the bar reflects "fraction of class-4 max".
    const pct = Math.min(100, Math.round(c.watts / 25.5 * 100));
    const isClass4 = c.class === 5; // 5 = class4 (802.3at), 1..4 → class 0..3
    return /*#__PURE__*/React.createElement("tr", {
      key: `${c.member}.${c.port}`
    }, /*#__PURE__*/React.createElement("td", {
      className: "fg",
      style: {
        color: "var(--accent)"
      }
    }, c.member, ":", c.port), /*#__PURE__*/React.createElement("td", {
      style: {
        color: "var(--fg)"
      }
    }, pf ? pf.device : "—"), /*#__PURE__*/React.createElement("td", null, pf ? pf.vendor : "—"), /*#__PURE__*/React.createElement("td", null, c.class != null ? /*#__PURE__*/React.createElement("span", {
      className: "poe-cls cls-" + c.class
    }, "Class ", c.class - 1) : /*#__PURE__*/React.createElement("span", {
      style: {
        color: "var(--muted)"
      }
    }, "\u2014")), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("span", {
      className: "util-bar"
    }, /*#__PURE__*/React.createElement("i", {
      style: {
        width: `${pct}%`,
        background: isClass4 ? "var(--warn)" : "var(--ok)"
      }
    }))), /*#__PURE__*/React.createElement("td", {
      style: {
        textAlign: "right"
      }
    }, c.watts.toFixed(1), " W"));
  })))));
};

// ───────────────────────────────────────────────────────────────────
// 5. CLI (admin-only — server withholds window.SWITCH_SSH from non-admins)
// ───────────────────────────────────────────────────────────────────
const TabCli = ({
  host
}) => {
  const ssh = window.SWITCH_SSH || null;
  return /*#__PURE__*/React.createElement("div", {
    className: "tab-pane"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "CLI \xB7 ssh ", host.id), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "ext"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), ssh ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("span", {
    className: "h-meta"
  }, ssh.user ? ssh.user + "@" : "", ssh.host, ":", ssh.port, " \xB7 ssheasy"), /*#__PURE__*/React.createElement("span", {
    className: "h-link",
    onClick: () => window.open(ssh.url, "_blank", "noopener")
  }, "Open in tab")) : /*#__PURE__*/React.createElement("span", {
    className: "h-meta"
  }, "SSH not configured")), /*#__PURE__*/React.createElement("div", {
    className: "cli-pane"
  }, ssh ? /*#__PURE__*/React.createElement("iframe", {
    className: "cli-frame",
    src: ssh.url,
    title: "ssh " + ssh.host,
    allow: "clipboard-read; clipboard-write"
  }) : /*#__PURE__*/React.createElement("div", {
    className: "cli-empty"
  }, "Set ", /*#__PURE__*/React.createElement("code", null, "{$SSHEASY.URL}"), " (and a host management IP) to enable the live SSH console."))));
};

// ───────────────────────────────────────────────────────────────────
// 6. TRIGGERS
// ───────────────────────────────────────────────────────────────────
const TabTriggers = () => {
  const T = Array.isArray(window.SWITCH_TRIGGERS) ? window.SWITCH_TRIGGERS : [];
  const [filter, setFilter] = useStateTAB("all");
  const counts = {
    firing: T.filter(t => t.status === "firing").length,
    enabled: T.filter(t => t.status === "enabled").length,
    disabled: T.filter(t => t.status === "disabled").length
  };
  const rows = filter === "all" ? T : T.filter(t => t.status === filter);
  const loading = window.SWITCH_LOADING && window.SWITCH_LOADING.snapshot;
  return /*#__PURE__*/React.createElement("div", {
    className: "tab-pane"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h-bar"
  }, /*#__PURE__*/React.createElement("span", {
    className: "h-title"
  }, "Triggers"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("div", {
    className: "trig-filter"
  }, /*#__PURE__*/React.createElement("span", {
    className: "tf" + (filter === "all" ? " active" : ""),
    onClick: () => setFilter("all")
  }, "All ", /*#__PURE__*/React.createElement("b", null, T.length)), /*#__PURE__*/React.createElement("span", {
    className: "tf warn" + (filter === "firing" ? " active" : ""),
    onClick: () => setFilter("firing")
  }, "Firing ", /*#__PURE__*/React.createElement("b", null, counts.firing)), /*#__PURE__*/React.createElement("span", {
    className: "tf" + (filter === "enabled" ? " active" : ""),
    onClick: () => setFilter("enabled")
  }, "Enabled ", /*#__PURE__*/React.createElement("b", null, counts.enabled)), /*#__PURE__*/React.createElement("span", {
    className: "tf" + (filter === "disabled" ? " active" : ""),
    onClick: () => setFilter("disabled")
  }, "Disabled ", /*#__PURE__*/React.createElement("b", null, counts.disabled))), /*#__PURE__*/React.createElement("span", {
    className: "h-meta"
  }, "Live \xB7 Zabbix trigger.get")), /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("table", {
    className: "trig-tbl"
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", {
    style: {
      width: 90
    }
  }, "Severity"), /*#__PURE__*/React.createElement("th", null, "Name & expression"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 120
    }
  }, "24h history"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 75
    }
  }, "Fires 24h"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 60
    }
  }, "Deps"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 80
    }
  }, "Status"))), /*#__PURE__*/React.createElement("tbody", null, rows.length === 0 && /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("td", {
    colSpan: 6,
    style: {
      textAlign: "center",
      color: "var(--muted)",
      padding: 28
    }
  }, loading ? "Loading triggers…" : T.length === 0 ? "No triggers defined on this host." : `No ${filter} triggers.`)), rows.map((t, i) => /*#__PURE__*/React.createElement("tr", {
    key: i,
    className: t.status === "firing" ? "firing" : ""
  }, /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement(Sev, {
    level: t.sev
  })), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("div", {
    className: "trig-name"
  }, t.name), /*#__PURE__*/React.createElement("code", {
    className: "trig-expr"
  }, t.expr)), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement(Sparkline, {
    data: t.history,
    color: t.status === "firing" ? "var(--warn)" : "var(--muted-2)",
    width: 110,
    height: 24
  })), /*#__PURE__*/React.createElement("td", {
    className: "mono",
    style: {
      textAlign: "center",
      color: t.fires24h > 0 ? "var(--warn)" : "var(--muted)"
    }
  }, t.fires24h), /*#__PURE__*/React.createElement("td", {
    className: "mono",
    style: {
      textAlign: "center",
      color: t.deps > 0 ? "var(--fg-2)" : "var(--muted)"
    }
  }, t.deps), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("span", {
    className: "trig-status " + t.status
  }, t.status.toUpperCase()))))))));
};

// ───────────────────────────────────────────────────────────────────
// 7. CONFIG BACKUPS
// ───────────────────────────────────────────────────────────────────
const TabBackups = () => {
  const B = window.TAB_BACKUPS;
  const D = window.TAB_DIFF;
  const [sel, setSel] = useStateTAB(1);
  return /*#__PURE__*/React.createElement("div", {
    className: "tab-pane"
  }, /*#__PURE__*/React.createElement("div", {
    className: "backup-layout"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "Configuration backups"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "ext"
  }), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "zbx"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("span", {
    className: "h-meta"
  }, "retention 90d \xB7 last 6 of 312 shown"), /*#__PURE__*/React.createElement("span", {
    className: "h-link"
  }, "Run backup now")), /*#__PURE__*/React.createElement("table", {
    className: "backup-tbl"
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", {
    style: {
      width: 22
    }
  }), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 150
    }
  }, "Timestamp"), /*#__PURE__*/React.createElement("th", null, "User"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 70
    }
  }, "Method"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 70
    }
  }, "Lines"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 70
    }
  }, "\u0394"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 90
    }
  }, "Hash"))), /*#__PURE__*/React.createElement("tbody", null, B.map((b, i) => /*#__PURE__*/React.createElement("tr", {
    key: i,
    className: sel === i ? "sel" : "",
    onClick: () => setSel(i)
  }, /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("span", {
    className: "bk-dot " + (b.user.startsWith("auto") ? "auto" : "human")
  })), /*#__PURE__*/React.createElement("td", {
    className: "mono"
  }, b.ts), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("div", null, b.user), /*#__PURE__*/React.createElement("div", {
    className: "bk-note"
  }, b.note)), /*#__PURE__*/React.createElement("td", null, b.method), /*#__PURE__*/React.createElement("td", {
    className: "mono",
    style: {
      textAlign: "right"
    }
  }, b.lines), /*#__PURE__*/React.createElement("td", {
    className: "mono",
    style: {
      textAlign: "right",
      color: b.changed > 0 ? "var(--warn)" : "var(--muted)"
    }
  }, b.changed > 0 ? `+${b.changed}` : "—"), /*#__PURE__*/React.createElement("td", {
    className: "mono",
    style: {
      color: "var(--muted)"
    }
  }, b.hash)))))), /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "Diff \xB7 ", B[sel].hash, "  \u2192  ", B[Math.max(0, sel - 1)].hash), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "ext"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), /*#__PURE__*/React.createElement("span", {
    className: "h-meta"
  }, B[sel].changed || 0, " changed line", B[sel].changed === 1 ? "" : "s", " \xB7 context \xB12"), /*#__PURE__*/React.createElement("span", {
    className: "h-link"
  }, "Restore this revision")), /*#__PURE__*/React.createElement("div", {
    className: "diff-pane"
  }, /*#__PURE__*/React.createElement("div", {
    className: "diff-meta"
  }, /*#__PURE__*/React.createElement("div", {
    className: "dm-col"
  }, /*#__PURE__*/React.createElement("div", {
    className: "dm-lbl"
  }, "FROM"), /*#__PURE__*/React.createElement("div", {
    className: "dm-ts"
  }, B[sel].ts), /*#__PURE__*/React.createElement("div", {
    className: "dm-by"
  }, B[sel].user)), /*#__PURE__*/React.createElement("div", {
    className: "dm-arrow"
  }, "\u2192"), /*#__PURE__*/React.createElement("div", {
    className: "dm-col"
  }, /*#__PURE__*/React.createElement("div", {
    className: "dm-lbl"
  }, "TO"), /*#__PURE__*/React.createElement("div", {
    className: "dm-ts"
  }, B[Math.max(0, sel - 1)].ts), /*#__PURE__*/React.createElement("div", {
    className: "dm-by"
  }, B[Math.max(0, sel - 1)].user)), /*#__PURE__*/React.createElement("div", {
    className: "dm-spacer"
  }), /*#__PURE__*/React.createElement("div", {
    className: "dm-stat add"
  }, "+", D.filter(d => d.type === "add").length), /*#__PURE__*/React.createElement("div", {
    className: "dm-stat del"
  }, "\u2212", D.filter(d => d.type === "del").length)), /*#__PURE__*/React.createElement("pre", {
    className: "diff-body"
  }, D.map((d, i) => {
    const pre = d.type === "add" ? "+" : d.type === "del" ? "−" : " ";
    return /*#__PURE__*/React.createElement("div", {
      key: i,
      className: "diff-line " + d.type
    }, /*#__PURE__*/React.createElement("span", {
      className: "dl-ln"
    }, d.ln), /*#__PURE__*/React.createElement("span", {
      className: "dl-pre"
    }, pre), /*#__PURE__*/React.createElement("span", {
      className: "dl-tx"
    }, d.txt || "\u00a0"));
  }))))));
};

// ───────────────────────────────────────────────────────────────────
// XIQ tab — looks the switch up in ExtremeCloud IQ and shows the
// XIQ-side connected clients, recent device-scoped events, and any
// open alerts that mention the switch hostname. Fetches lazily on
// first tab activation; result is cached on window so re-clicking
// doesn't refire the lookup.
// ───────────────────────────────────────────────────────────────────
const TabXiq = ({
  host
}) => {
  const [state, setState] = useStateTAB(() => window.SWITCH_XIQ || {
    loading: false,
    loaded: false
  });
  const [now, setNow] = useStateTAB(() => Date.now());

  // Single-flight: per page session we fetch once per host. The
  // bridge exposes window.tcsLoadSwitchXiq for the Refresh button.
  const hostid = host && host.hostid ? String(host.hostid) : "";
  React.useEffect(() => {
    if (!hostid || state.loading || state.loaded) return;
    if (typeof window.tcsLoadSwitchXiq !== "function") return;
    setState(s => ({
      ...s,
      loading: true,
      error: null
    }));
    window.tcsLoadSwitchXiq(hostid).then(d => {
      window.SWITCH_XIQ = {
        ...d,
        loading: false,
        loaded: true
      };
      setState(window.SWITCH_XIQ);
    }).catch(e => setState({
      loading: false,
      loaded: true,
      error: String(e && e.message ? e.message : e)
    }));
  }, [hostid]);

  // Live-aging timer for "X ago" labels.
  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);
  const refresh = () => {
    if (!hostid || typeof window.tcsLoadSwitchXiq !== "function") return;
    setState(s => ({
      ...s,
      loading: true,
      error: null
    }));
    window.tcsLoadSwitchXiq(hostid, true).then(d => {
      window.SWITCH_XIQ = {
        ...d,
        loading: false,
        loaded: true
      };
      setState(window.SWITCH_XIQ);
    }).catch(e => setState({
      loading: false,
      loaded: true,
      error: String(e && e.message ? e.message : e)
    }));
  };
  const fmtAge = sec => {
    if (!sec || sec < 0) return "—";
    if (sec < 60) return sec + "s";
    if (sec < 3600) return Math.floor(sec / 60) + "m";
    if (sec < 86400) return Math.floor(sec / 3600) + "h " + Math.floor(sec % 3600 / 60) + "m";
    return Math.floor(sec / 86400) + "d";
  };
  const tsAgo = ts => fmtAge(Math.max(0, Math.floor(now / 1000 - (Number(ts) || 0))));
  const tsLabel = ts => {
    if (!ts) return "—";
    const d = new Date(Number(ts) * 1000);
    return d.toLocaleString();
  };
  const reasonMsg = {
    no_token: "No XIQ API token configured. For short tokens set {$XIQ_API_TOKEN}; for the longer Platform ONE JWT, set {$XIQ_API_TOKEN_FILE} to a file path containing the token, or drop it at /etc/zabbix/tcs_dashboard/xiq_api_token.",
    unknown_host: "Host not visible in Zabbix.",
    lookup_failed: "XIQ lookup failed — see PHP error log.",
    not_in_xiq: "This switch isn't onboarded in ExtremeCloud IQ.",
    lookup_ambiguous: "Refused to query XIQ — the candidate device matched only the hostname, not the serial/MAC. Verify the Zabbix host inventory serialno_a matches XIQ."
  };
  const device = state.device || null;
  const clients = Array.isArray(state.clients) ? state.clients : [];
  const events = Array.isArray(state.events) ? state.events : [];
  const alerts = Array.isArray(state.alerts) ? state.alerts : [];
  const notes = state.notes && typeof state.notes === "object" ? state.notes : {};

  // ── Merge XIQ + SNMP auth + PF per (port, MAC) ──────────────────────
  // XIQ wired-client rows carry port=`1:1` and a colon-separated MAC.
  // window.PORT_AUTH is keyed by "m.p" (e.g. "1.1") with array of
  // sessions {mac, applied, policy, policyName, agentLabel, vlan, duration}.
  // window._tcsPfByKey same "m.p" keying with PF rows {mac, host, ip, role,
  // owner, os, dhcpFp, lastSeen, reg}.
  // The merged row collects the strongest data from each source and
  // records `sources` (XIQ/SNMP/PF) so the UI can show provenance.
  const normMac = s => String(s || "").toLowerCase().replace(/[^0-9a-f]/g, "");
  const dotKey = port => String(port || "").replace(/:/g, "."); // "1:1" → "1.1"
  const colonPort = k => String(k || "").replace(/\./g, ":");
  const buildMergedClients = () => {
    const xiqWired = clients.filter(c => c.wired);
    // Group all three sources by "port|mac" so rows from different
    // sources for the same physical client collapse together.
    const byKey = new Map(); // key → merged row
    const ensure = (port, mac) => {
      const k = dotKey(port) + "|" + normMac(mac);
      if (!byKey.has(k)) {
        byKey.set(k, {
          key: k,
          port: colonPort(port),
          portDot: dotKey(port),
          mac: mac || "",
          macNorm: normMac(mac),
          host: "",
          ip: "",
          user: "",
          vlan: "",
          os: "",
          ipp: "",
          // XIQ Instant Port Profile
          role: "",
          // PF role
          owner: "",
          // PF dot1x username
          dhcpFp: "",
          lastSeen: "",
          reg: "",
          authPolicy: "",
          // SNMP policy profile name
          authMethod: "",
          // SNMP agent label ("802.1X" / "MAC" / etc.)
          authApplied: false,
          authVlan: "",
          authDuration: 0,
          authSessionCount: 0,
          sources: new Set()
        });
      }
      return byKey.get(k);
    };
    const setIf = (row, field, val) => {
      if (val == null || val === "" || row[field]) return;
      row[field] = val;
    };

    // 1. XIQ wired rows (richest single source for connected clients).
    for (const c of xiqWired) {
      if (!c.port) continue;
      const row = ensure(c.port, c.mac);
      row.sources.add("XIQ");
      setIf(row, "host", c.host);
      setIf(row, "ip", c.ip);
      setIf(row, "user", c.user);
      setIf(row, "vlan", c.vlan);
      setIf(row, "os", c.os);
      setIf(row, "ipp", c.role); // XIQ's "role" is the Instant Port Profile
    }

    // 2. SNMP auth sessions (etsysMultiAuthSessionStationTable). Multiple
    //    sessions per port are common (e.g. dual-supplicant on phone+PC),
    //    one row per MAC.
    const portAuth = window.PORT_AUTH || {};
    const policyNames = window.POLICY_PROFILES || {};
    for (const k of Object.keys(portAuth)) {
      const sessions = Array.isArray(portAuth[k]) ? portAuth[k] : [];
      for (const s of sessions) {
        if (!s || !s.mac) continue;
        const row = ensure(colonPort(k), s.mac);
        row.sources.add("SNMP");
        row.authSessionCount++;
        // The "applied" session wins for the per-row display; track
        // whether any session on this port-MAC is applied separately.
        if (s.applied || !row.authApplied) {
          row.authApplied = !!(s.applied || row.authApplied);
          if (s.policy != null) {
            row.authPolicy = policyNames[s.policy] || String(s.policy);
          }
          if (s.agentLabel) row.authMethod = s.agentLabel;
          if (s.vlan != null && s.vlan !== "") row.authVlan = s.vlan;
          if (s.duration != null) row.authDuration = Math.max(row.authDuration, s.duration);
        }
      }
    }

    // 3. PF nodes (registration / role / dot1x / DHCP fingerprint).
    const pfByKey = window._tcsPfByKey || {};
    for (const k of Object.keys(pfByKey)) {
      const rows = Array.isArray(pfByKey[k]) ? pfByKey[k] : [];
      for (const p of rows) {
        if (!p || !p.mac) continue;
        const row = ensure(colonPort(k), p.mac);
        row.sources.add("PF");
        setIf(row, "host", p.host);
        setIf(row, "ip", p.ip);
        setIf(row, "owner", p.owner);
        setIf(row, "role", p.role);
        setIf(row, "os", p.os);
        setIf(row, "dhcpFp", p.dhcpFp);
        setIf(row, "lastSeen", p.lastSeen);
        setIf(row, "reg", p.reg);
        // PF VLAN is from locationlog — fill it in if XIQ/SNMP didn't
        if (!row.vlan && p.vlan) row.vlan = p.vlan;
      }
    }

    // Sort: by port (member, then port number numerically), then by MAC.
    const portCmp = (a, b) => {
      const pa = a.portDot.split(".").map(n => Number(n) || 0);
      const pb = b.portDot.split(".").map(n => Number(n) || 0);
      return pa[0] - pb[0] || pa[1] - pb[1] || a.macNorm.localeCompare(b.macNorm);
    };
    return Array.from(byKey.values()).sort(portCmp);
  };
  const merged = device ? buildMergedClients() : [];
  const sourceBadge = (label, on) => /*#__PURE__*/React.createElement("span", {
    key: label,
    style: {
      display: "inline-block",
      marginRight: 4,
      padding: "0 5px",
      fontSize: 9,
      lineHeight: "14px",
      borderRadius: 3,
      fontFamily: "var(--mono)",
      color: on ? "var(--fg)" : "var(--muted)",
      background: on ? "var(--bg-3)" : "transparent",
      border: "1px solid " + (on ? "var(--line)" : "transparent")
    }
  }, label);

  // Pill rendered in place of an empty table, explaining why XIQ has
  // nothing to show. Used for switches against /clients/active (XIQ API
  // limitation) and /alerts (token scope).
  const InfoPill = ({
    children,
    kind
  }) => /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "10px 12px",
      margin: "6px 0",
      fontSize: 11,
      lineHeight: 1.5,
      color: kind === "warn" ? "var(--warn, #f5b300)" : "var(--muted)",
      background: kind === "warn" ? "rgba(245,179,0,0.08)" : "var(--bg-2)",
      border: "1px solid " + (kind === "warn" ? "rgba(245,179,0,0.30)" : "var(--line)"),
      borderRadius: 6
    }
  }, children);
  return /*#__PURE__*/React.createElement("div", {
    className: "card",
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h"
  }, /*#__PURE__*/React.createElement("h3", null, "ExtremeCloud IQ"), /*#__PURE__*/React.createElement(SourceBadge, {
    src: "ext"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-spacer"
  }), state.rateLimit && state.rateLimit.remaining != null && /*#__PURE__*/React.createElement("span", {
    className: "h-meta mono",
    title: "XIQ quota remaining (7,500/hr/VIQ)"
  }, "quota ", state.rateLimit.remaining), /*#__PURE__*/React.createElement("button", {
    className: "seg-btn",
    onClick: refresh,
    disabled: state.loading,
    style: {
      marginLeft: 8
    }
  }, state.loading ? "Refreshing…" : "Refresh")), /*#__PURE__*/React.createElement("div", {
    className: "card-b"
  }, state.loading && !state.loaded && /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "30px 12px",
      textAlign: "center",
      color: "var(--muted)",
      fontSize: 12
    }
  }, "Looking up ", /*#__PURE__*/React.createElement("span", {
    className: "mono"
  }, host && host.host), " in ExtremeCloud IQ\u2026"), state.error && /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 12,
      color: "var(--err, #f25f5c)",
      fontSize: 12
    }
  }, state.error), state.loaded && !state.ok && state.reason && /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "20px 12px",
      color: "var(--muted)",
      fontSize: 12
    }
  }, reasonMsg[state.reason] || state.reason), state.loaded && state.ok && device && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    className: "xiq-identity",
    style: {
      display: "grid",
      gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
      gap: 10,
      marginBottom: 14,
      padding: 12,
      background: "var(--bg-2)",
      border: "1px solid var(--line)",
      borderRadius: 6
    }
  }, [["Hostname", device.hostname || "—"], ["Model", device.model || "—"], ["Firmware", device.firmware || "—"], ["Serial", device.serial || "—"], ["MAC", device.mac || "—"], ["IP", device.ip || "—"], ["Policy", device.policy_name || "—"], ["Connected", device.connected ? /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--ok, #34d399)"
    }
  }, "\u25CF online") : /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--err, #f25f5c)"
    }
  }, "\u25CF offline")]].map(([k, v]) => /*#__PURE__*/React.createElement("div", {
    key: k
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10,
      color: "var(--muted)",
      textTransform: "uppercase",
      letterSpacing: 0.4
    }
  }, k), /*#__PURE__*/React.createElement("div", {
    className: "mono",
    style: {
      fontSize: 12,
      marginTop: 2
    }
  }, v)))), /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h",
    style: {
      padding: "4px 0",
      borderBottom: "1px solid var(--line)",
      marginBottom: 6
    }
  }, /*#__PURE__*/React.createElement("h4", {
    style: {
      margin: 0,
      fontSize: 12,
      textTransform: "uppercase",
      letterSpacing: 0.5
    }
  }, "Clients"), /*#__PURE__*/React.createElement("span", {
    className: "h-meta mono"
  }, clients.length)), clients.length === 0 && merged.length === 0 ? notes.clients ? /*#__PURE__*/React.createElement(InfoPill, {
    kind: "warn"
  }, notes.clients) : /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "10px 4px",
      color: "var(--muted)",
      fontSize: 11
    }
  }, "No active clients reported by XIQ.") : (() => {
    // Wireless XIQ rows (APs) render the legacy SSID/Conn table.
    // Switch tabs render the merged XIQ + SNMP-auth + PF view
    // built above, keyed by (port, MAC). Both can coexist if
    // a stack happens to host an AP child.
    const wireless = clients.filter(c => !c.wired);
    return /*#__PURE__*/React.createElement(React.Fragment, null, wireless.length > 0 && /*#__PURE__*/React.createElement("table", {
      className: "tbl",
      style: {
        width: "100%",
        fontSize: 11,
        marginBottom: merged.length ? 12 : 0
      }
    }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", null, "MAC"), /*#__PURE__*/React.createElement("th", null, "Host / IP"), /*#__PURE__*/React.createElement("th", null, "User"), /*#__PURE__*/React.createElement("th", null, "SSID"), /*#__PURE__*/React.createElement("th", null, "VLAN"), /*#__PURE__*/React.createElement("th", null, "OS"), /*#__PURE__*/React.createElement("th", null, "Conn"))), /*#__PURE__*/React.createElement("tbody", null, wireless.slice(0, 200).map(c => /*#__PURE__*/React.createElement("tr", {
      key: "w:" + (c.mac || "?") + ":" + c.duration
    }, /*#__PURE__*/React.createElement("td", {
      className: "mono"
    }, c.mac || "—"), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("div", null, c.host || "—"), /*#__PURE__*/React.createElement("div", {
      className: "mono",
      style: {
        color: "var(--muted)",
        fontSize: 10
      }
    }, c.ip || "")), /*#__PURE__*/React.createElement("td", null, c.user || "—"), /*#__PURE__*/React.createElement("td", null, c.ssid || "—"), /*#__PURE__*/React.createElement("td", {
      className: "mono"
    }, c.vlan || "—"), /*#__PURE__*/React.createElement("td", null, c.os || "—"), /*#__PURE__*/React.createElement("td", {
      className: "mono"
    }, fmtAge(c.duration)))))), merged.length > 0 && /*#__PURE__*/React.createElement("table", {
      className: "tbl",
      style: {
        width: "100%",
        fontSize: 11
      }
    }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", {
      style: {
        width: 110
      }
    }, "Sources"), /*#__PURE__*/React.createElement("th", {
      style: {
        width: 70
      }
    }, "Port"), /*#__PURE__*/React.createElement("th", null, "MAC"), /*#__PURE__*/React.createElement("th", null, "Host / IP"), /*#__PURE__*/React.createElement("th", null, "User"), /*#__PURE__*/React.createElement("th", null, "Role / Profile"), /*#__PURE__*/React.createElement("th", null, "Auth"), /*#__PURE__*/React.createElement("th", null, "VLAN"), /*#__PURE__*/React.createElement("th", null, "OS / Fingerprint"), /*#__PURE__*/React.createElement("th", null, "Last seen"))), /*#__PURE__*/React.createElement("tbody", null, merged.slice(0, 300).map(r => {
      const xiq = r.sources.has("XIQ");
      const snmp = r.sources.has("SNMP");
      const pf = r.sources.has("PF");
      const role = r.role || r.ipp; // PF role beats IPP if both set above
      const authLabel = r.authMethod ? r.authMethod + (r.authApplied ? "" : " (pending)") : "";
      const vlan = r.vlan || r.authVlan;
      const os = r.os;
      return /*#__PURE__*/React.createElement("tr", {
        key: r.key
      }, /*#__PURE__*/React.createElement("td", null, sourceBadge("XIQ", xiq), sourceBadge("SNMP", snmp), sourceBadge("PF", pf)), /*#__PURE__*/React.createElement("td", {
        className: "mono"
      }, r.port || "—"), /*#__PURE__*/React.createElement("td", {
        className: "mono"
      }, r.mac || "—"), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("div", null, r.host || "—"), /*#__PURE__*/React.createElement("div", {
        className: "mono",
        style: {
          color: "var(--muted)",
          fontSize: 10
        }
      }, r.ip || "")), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("div", null, r.owner || r.user || "—"), r.owner && r.user && r.owner !== r.user && /*#__PURE__*/React.createElement("div", {
        className: "mono",
        style: {
          color: "var(--muted)",
          fontSize: 10
        },
        title: "XIQ-side user"
      }, "xiq:", r.user)), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("div", null, role || "—"), r.authPolicy && r.authPolicy !== role && /*#__PURE__*/React.createElement("div", {
        className: "mono",
        style: {
          color: "var(--muted)",
          fontSize: 10
        },
        title: "SNMP policy profile"
      }, "snmp:", r.authPolicy)), /*#__PURE__*/React.createElement("td", null, snmp ? /*#__PURE__*/React.createElement("span", {
        style: {
          color: r.authApplied ? "var(--ok, #34d399)" : "var(--warn, #f5b300)"
        }
      }, authLabel || (r.authApplied ? "applied" : "—")) : "—", r.authSessionCount > 1 && /*#__PURE__*/React.createElement("span", {
        className: "mono",
        style: {
          color: "var(--muted)",
          fontSize: 10,
          marginLeft: 4
        },
        title: "multiple auth sessions"
      }, "\xD7", r.authSessionCount)), /*#__PURE__*/React.createElement("td", {
        className: "mono"
      }, vlan || "—"), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("div", null, os || "—"), r.dhcpFp && /*#__PURE__*/React.createElement("div", {
        className: "mono",
        style: {
          color: "var(--muted)",
          fontSize: 10
        },
        title: "DHCP fingerprint"
      }, r.dhcpFp)), /*#__PURE__*/React.createElement("td", {
        className: "mono",
        style: {
          fontSize: 10
        }
      }, r.lastSeen || "—"));
    }))), merged.length > 0 && (() => {
      const xiqOnly = merged.filter(r => r.sources.size === 1 && r.sources.has("XIQ")).length;
      const pfOnly = merged.filter(r => r.sources.size === 1 && r.sources.has("PF")).length;
      const snmpOnly = merged.filter(r => r.sources.size === 1 && r.sources.has("SNMP")).length;
      const multi = merged.length - xiqOnly - pfOnly - snmpOnly;
      return /*#__PURE__*/React.createElement("div", {
        style: {
          marginTop: 6,
          fontSize: 10,
          color: "var(--muted)",
          fontFamily: "var(--mono)"
        }
      }, merged.length, " clients \xB7 ", multi, " multi-source \xB7 ", xiqOnly, " XIQ-only \xB7 ", snmpOnly, " SNMP-only \xB7 ", pfOnly, " PF-only");
    })());
  })()), /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-h",
    style: {
      padding: "4px 0",
      borderBottom: "1px solid var(--line)",
      marginBottom: 6
    }
  }, /*#__PURE__*/React.createElement("h4", {
    style: {
      margin: 0,
      fontSize: 12,
      textTransform: "uppercase",
      letterSpacing: 0.5
    }
  }, "Events"), /*#__PURE__*/React.createElement("span", {
    className: "h-meta mono"
  }, events.length, " \xB7 last 30d")), events.length === 0 ? /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "10px 4px",
      color: "var(--muted)",
      fontSize: 11
    }
  }, "No device events in the last 30 days.") : /*#__PURE__*/React.createElement("table", {
    className: "tbl",
    style: {
      width: "100%",
      fontSize: 11
    }
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", {
    style: {
      width: 70
    }
  }, "Sev"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 130
    }
  }, "When"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 130
    }
  }, "Category"), /*#__PURE__*/React.createElement("th", null, "Message"))), /*#__PURE__*/React.createElement("tbody", null, events.slice(0, 100).map(e => /*#__PURE__*/React.createElement("tr", {
    key: e.id,
    style: e.value === 0 ? {
      opacity: 0.55
    } : null
  }, /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement(Sev, {
    level: e.severity
  })), /*#__PURE__*/React.createElement("td", {
    className: "mono",
    title: tsLabel(e.clock)
  }, tsAgo(e.clock), " ago"), /*#__PURE__*/React.createElement("td", null, e.category || "—"), /*#__PURE__*/React.createElement("td", null, e.message || "—")))))), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "card-h",
    style: {
      padding: "4px 0",
      borderBottom: "1px solid var(--line)",
      marginBottom: 6
    }
  }, /*#__PURE__*/React.createElement("h4", {
    style: {
      margin: 0,
      fontSize: 12,
      textTransform: "uppercase",
      letterSpacing: 0.5
    }
  }, "Alerts"), /*#__PURE__*/React.createElement("span", {
    className: "h-meta mono"
  }, alerts.length, " \xB7 last 7d")), alerts.length === 0 ? notes.alerts ? /*#__PURE__*/React.createElement(InfoPill, {
    kind: "warn"
  }, notes.alerts) : /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "10px 4px",
      color: "var(--muted)",
      fontSize: 11
    }
  }, "No XIQ alerts reference this host.") : /*#__PURE__*/React.createElement("table", {
    className: "tbl",
    style: {
      width: "100%",
      fontSize: 11
    }
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", {
    style: {
      width: 70
    }
  }, "Sev"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 130
    }
  }, "When"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 130
    }
  }, "Source"), /*#__PURE__*/React.createElement("th", null, "Summary"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 60
    }
  }, "Ack"))), /*#__PURE__*/React.createElement("tbody", null, alerts.map(a => /*#__PURE__*/React.createElement("tr", {
    key: a.id || a.ts + a.summary
  }, /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement(Sev, {
    level: a.severity
  })), /*#__PURE__*/React.createElement("td", {
    className: "mono",
    title: tsLabel(a.ts)
  }, tsAgo(a.ts), " ago"), /*#__PURE__*/React.createElement("td", null, a.source || a.category || "—"), /*#__PURE__*/React.createElement("td", null, a.summary || "—"), /*#__PURE__*/React.createElement("td", {
    className: "mono"
  }, a.acknowledged ? "✓" : "")))))))));
};

// ───────────────────────────────────────────────────────────────────
// Tab definitions table — exported
// ───────────────────────────────────────────────────────────────────
window.SWITCH_TABS = [{
  id: "ports",
  label: "Port Status",
  badge: null
}, {
  id: "topo",
  label: "Topology",
  badge: null
}, {
  id: "health",
  label: "Stack Health",
  badge: null
}, {
  id: "vlan",
  label: "VLAN",
  badge: null
}, {
  id: "poe",
  label: "PoE Budget",
  badge: null
}, {
  id: "xiq",
  label: "XIQ",
  badge: null
}, {
  id: "cli",
  label: "CLI",
  badge: null,
  admin: true
}, {
  id: "triggers",
  label: "Triggers",
  badge: null
}, {
  id: "backups",
  label: "Config Backups",
  badge: null
}];
window.TabTopology = TabTopology;
window.TabStackHealth = TabStackHealth;
window.TabVlan = TabVlan;
window.TabPoe = TabPoe;
window.TabXiq = TabXiq;
window.TabCli = TabCli;
window.TabTriggers = TabTriggers;
window.TabBackups = TabBackups;