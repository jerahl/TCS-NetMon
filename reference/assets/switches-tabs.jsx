// Switches dashboard — extra tab views (Topology, Stack Health, VLAN, PoE, Macros/CLI, Triggers, Backups)

const { useState: useStateTAB } = React;

// ───────────────────────────────────────────────────────────────────
// Shared data for tab content
// ───────────────────────────────────────────────────────────────────

window.TAB_STACK_HEALTH = [
  { idx: 1, role: "Backup",  serial: "1903N-72101", uptime: "127d 04h", cpu: 22, cpu5: 18, mem: 36, temp: 67,  fan1: 5400, fan2: 5320, psu1: 240, psu2: 238, version: "31.7.1.4" },
  { idx: 2, role: "Primary", serial: "1903N-72104", uptime: "127d 04h", cpu: 28, cpu5: 24, mem: 38, temp: 69,  fan1: 5480, fan2: 5410, psu1: 244, psu2: 240, version: "31.7.1.4" },
  { idx: 3, role: "Standby", serial: "1903N-72107", uptime: "127d 04h", cpu: 25, cpu5: 22, mem: 36, temp: 71,  fan1: 5620, fan2: 5580, psu1: 236, psu2: 0,   version: "31.7.1.4", warn: "PSU2 absent" },
  { idx: 4, role: "Backup",  serial: "1903N-72112", uptime: "  6d 11h", cpu: 19, cpu5: 17, mem: 34, temp: 65,  fan1: 5380, fan2: 5290, psu1: 232, psu2: 230, version: "31.7.1.4" },
];

// Sparkline seed generator (deterministic small history)
function _spark(seed, base, jitter, len = 24) {
  let x = seed;
  return Array.from({ length: len }, () => {
    x = (x * 9301 + 49297) % 233280;
    return Math.round(base + (x / 233280 - 0.5) * 2 * jitter);
  });
}

window.TAB_BACKUPS = [
  { ts: "2026-05-09 04:00:02", user: "auto (zbx-conf)", method: "SSH+SCP", size: "118.4 KB", lines: 4112, changed: 0,  hash: "9c4e…f30a", note: "Nightly scheduled backup" },
  { ts: "2026-05-08 14:18:55", user: "ksimmons@tcs",    method: "Web UI",  size: "118.4 KB", lines: 4112, changed: 2,  hash: "9c4e…f30a", note: "Added VLAN 100 untagged to 2:31" },
  { ts: "2026-05-08 04:00:01", user: "auto (zbx-conf)", method: "SSH+SCP", size: "118.3 KB", lines: 4110, changed: 0,  hash: "8b9d…2e74", note: "Nightly scheduled backup" },
  { ts: "2026-05-07 11:42:11", user: "tservice@tcs",    method: "SSH",     size: "118.3 KB", lines: 4110, changed: 5,  hash: "8b9d…2e74", note: "Updated uplink trunk config" },
  { ts: "2026-05-07 04:00:01", user: "auto (zbx-conf)", method: "SSH+SCP", size: "117.9 KB", lines: 4105, changed: 0,  hash: "73af…ec01", note: "Nightly scheduled backup" },
  { ts: "2026-05-06 09:11:48", user: "ksimmons@tcs",    method: "Web UI",  size: "117.9 KB", lines: 4105, changed: 1,  hash: "73af…ec01", note: "Updated SNMP location string" },
];

window.TAB_DIFF = [
  { type: "ctx",  ln: 1242, txt: "configure vlan FACULTY tag 20" },
  { type: "ctx",  ln: 1243, txt: "configure vlan FACULTY add ports 1:7,1:9,1:11 tagged" },
  { type: "del",  ln: 1244, txt: "configure vlan PRINTERS add ports 2:31 untagged" },
  { type: "add",  ln: 1244, txt: "configure vlan CAMERAS add ports 2:31 untagged" },
  { type: "ctx",  ln: 1245, txt: "configure vlan VOIP add ports 1:42,4:11 untagged" },
];

// ───────────────────────────────────────────────────────────────────
// 1. TOPOLOGY (EDP-driven)
// ───────────────────────────────────────────────────────────────────
// EDP gives us, for each Extreme neighbor: which local port it's on,
// the neighbor's hostname, EXOS version, the neighbor's slot/port, and
// the age of the entry. EDP doesn't classify direction (uplink vs.
// downstream) so we render all neighbors in a single tier below the
// stack and let the operator infer.
const _fmtAge = (sec) => {
  if (sec == null || !isFinite(sec)) return "—";
  if (sec < 60)   return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d`;
};

const TabTopology = ({ host }) => {
  const stack = window.ARC_MDF_STACK;
  const edp = Array.isArray(window.EDP_NEIGHBORS) ? window.EDP_NEIGHBORS : [];
  const loading = (window.SWITCH_LOADING && window.SWITCH_LOADING.snapshot);
  // EDP entries are considered stale if older than 90s — the default
  // EDP advertisement interval is 60s, so two missed updates means the
  // peer's likely gone but the table hasn't aged out yet.
  const isStale = (n) => typeof n.age === "number" && n.age > 90;

  return (
    <div className="tab-pane">
      <div className="topo-layout">
        <div className="card topo-canvas-card">
          <div className="card-h">
            <h3>Stack &amp; EDP neighbors</h3>
            <SourceBadge src="zbx" />
            <div className="h-spacer" />
            <span className="h-meta">
              {loading ? "loading…" : `EDP · ${edp.length} neighbor${edp.length === 1 ? "" : "s"}`}
            </span>
          </div>
          <div className="topo-canvas">
            {/* Stack */}
            <div className="topo-stack">
              <div className="topo-tier-label">STACK · {host.id}</div>
              <div className="topo-stack-rack">
                {stack.map((m, i) => {
                  const live = (window.STACK_MEMBERS || [])[i];
                  const role = (live && live.role) || "—";
                  return (
                    <div key={m.idx} className="topo-stack-member">
                      <div className="m-bezel">
                        <div className="m-led" />
                        <div className="m-id">M{m.idx}</div>
                        <div className="m-role">{role}</div>
                        <div className="m-ports">{m.upCount}↑ {m.downCount}↓</div>
                        <div className="m-bays">
                          {[0,1,2,3].map(b => <div key={b} className={"bay " + (b < 2 ? "lit" : "")} />)}
                        </div>
                        <div className="m-sfp">SFP+</div>
                      </div>
                      {i < stack.length - 1 && <div className="m-link" />}
                    </div>
                  );
                })}
                <div className="topo-stack-ring">
                  <svg viewBox="0 0 40 220" preserveAspectRatio="none">
                    <path d="M 8 12 C -8 60 -8 160 8 208" />
                    <path d="M 32 12 C 48 60 48 160 32 208" />
                    <circle cx="8" cy="12" r="3" />
                    <circle cx="32" cy="12" r="3" />
                    <circle cx="8" cy="208" r="3" />
                    <circle cx="32" cy="208" r="3" />
                  </svg>
                  <div className="ring-label">stack ring</div>
                </div>
              </div>
            </div>

            {/* Neighbor tier */}
            <div className="topo-tier topo-tier-down">
              <div className="topo-tier-label">EXTREME NEIGHBORS · EDP</div>
              {loading && (
                <div className="topo-row" style={{ color: "var(--muted)", padding: "12px 0" }}>
                  Loading EDP neighbor data from Zabbix…
                </div>
              )}
              {!loading && edp.length === 0 && (
                <div className="topo-row" style={{ color: "var(--muted)", padding: "12px 0" }}>
                  No EDP neighbors discovered. Confirm the
                  vlan-poe-topology template patch is applied and EDP is
                  enabled on the switch (`enable edp ports all`).
                </div>
              )}
              {!loading && edp.length > 0 && (
                <div className="topo-row">
                  {edp.map((n, i) => (
                    <div key={`${n.localIfIndex}-${n.deviceId}-${i}`}
                         className={"topo-node edge" + (isStale(n) ? " down" : "")}>
                      <div className="n-id">{n.name || "(unknown)"}</div>
                      <div className="n-port">
                        {n.localLabel || "—"}
                        {n.peerLabel ? ` → ${n.peerLabel}` : ""}
                      </div>
                      {n.version && (
                        <div className="n-port" style={{ color: "var(--muted)" }}>
                          EXOS {n.version}
                        </div>
                      )}
                      {isStale(n) && (
                        <div className="n-err">
                          <Icon name="alert" size={9}/> stale · {_fmtAge(n.age)}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-h">
            <h3>EDP neighbors</h3>
            <SourceBadge src="zbx" />
            <div className="h-spacer" />
            <span className="h-meta">
              {loading ? "loading…" : `${edp.length} learned`}
            </span>
          </div>
          {loading && (
            <div style={{ padding: "18px 14px", color: "var(--muted)" }}>
              Loading EDP neighbor data from Zabbix…
            </div>
          )}
          {!loading && edp.length === 0 && (
            <div style={{ padding: "18px 14px", color: "var(--muted)" }}>
              No EDP neighbors learned on this switch.
            </div>
          )}
          {!loading && edp.length > 0 && (
            <table className="link-tbl">
              <thead>
                <tr>
                  <th style={{width: 56}}>Local</th>
                  <th>Neighbor</th>
                  <th style={{width: 70}}>R-Port</th>
                  <th style={{width: 56}}>Age</th>
                </tr>
              </thead>
              <tbody>
                {edp.map((n, i) => (
                  <tr key={`${n.localIfIndex}-${n.deviceId}-${i}`}>
                    <td className="fg" style={{color:"var(--accent)"}}>{n.localLabel || "—"}</td>
                    <td style={{whiteSpace: "normal", lineHeight: 1.35}}>
                      <div style={{color: "var(--fg)"}}>{n.name || "(unknown)"}</div>
                      <div style={{color: "var(--muted)", fontSize: 10}}>
                        {n.version ? `EXOS ${n.version}` : n.deviceId}
                      </div>
                    </td>
                    <td>{n.peerLabel || "—"}</td>
                    <td style={{color: isStale(n) ? "var(--warn)" : "var(--muted)"}}>{_fmtAge(n.age)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
};

// ───────────────────────────────────────────────────────────────────
// 2. STACK HEALTH
// ───────────────────────────────────────────────────────────────────
const HealthMetric = ({ label, val, unit, threshold, hist, color }) => {
  const isWarn = threshold && val >= threshold;
  return (
    <div className="hm-cell">
      <div className="hm-lbl">{label}</div>
      <div className={"hm-val" + (isWarn ? " warn" : "")}>{val}<span className="hm-unit">{unit}</span></div>
      <Sparkline data={hist} color={color || (isWarn ? "var(--warn)" : "var(--ok)")} width={120} height={22} threshold={threshold} />
    </div>
  );
};

// Build per-member rows from the live snapshot (window.STACK_MEMBERS).
// Returns [] when nothing has loaded yet; the tab shows a loading state
// in that case instead of falling back to fixture data.
const _fmtUptime = (sec) => {
  if (sec == null || !isFinite(sec) || sec <= 0) return null;
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  return `${d}d ${String(h).padStart(2, "0")}h`;
};

const buildMemberRows = () => {
  const live = Array.isArray(window.STACK_MEMBERS) ? window.STACK_MEMBERS : [];
  return live.map(m => {
    const fans = Array.isArray(m.fans) ? m.fans : [];
    const psus = Array.isArray(m.psus) ? m.psus : [];
    return {
      idx:     m.idx,
      role:    m.role || "Member",
      cpu:     m.cpu  != null ? Math.round(m.cpu)  : null,
      cpu5:    m.cpu5 != null ? Math.round(m.cpu5) : null,
      mem:     m.mem  != null ? Math.round(m.mem)  : null,
      temp:    m.temp != null ? Math.round(m.temp) : null,
      serial:  m.serial  || null,
      version: m.version || null,
      uptime:  _fmtUptime(m.uptime),
      fanCells: [0, 1].map(i => {
        const f = fans[i];
        return f ? { rpm: f.rpm || 0, ok: f.ok !== false } : null;
      }),
      psuCells: [0, 1].map(i => {
        const p = psus[i];
        return p ? { watts: p.watts || 0, status: p.status || 0, present: !!p.present, ok: !!p.ok } : null;
      })
    };
  });
};

const TabStackHealth = () => {
  const H = buildMemberRows();
  const loading = (window.SWITCH_LOADING && window.SWITCH_LOADING.snapshot) || H.length === 0;
  return (
    <div className="tab-pane">
      <div className="card-h-bar">
        <span className="h-title">Stack member health</span>
        <SourceBadge src="zbx" />
        <div className="h-spacer" />
      </div>
      {loading && (
        <div className="card" style={{ padding: "24px 18px", textAlign: "center", color: "var(--muted)" }}>
          Loading stack member data from Zabbix…
        </div>
      )}
      {!loading && (
      <div className="health-grid">
        {H.map(m => (
          <div key={m.idx} className="card health-card">
            <div className="hc-head">
              <div className="hc-id-block">
                <div className="hc-id">MEMBER {m.idx}</div>
                <div className={"hc-role " + String(m.role || "").toLowerCase()}>{m.role}</div>
              </div>
              <div className="hc-side">
                <div className="kv"><span>Serial</span><b>{m.serial || "—"}</b></div>
                <div className="kv"><span>EXOS</span><b>{m.version || "—"}</b></div>
                <div className="kv"><span>Uptime</span><b>{m.uptime || "—"}</b></div>
              </div>
            </div>
            <div className="hm-grid">
              <HealthMetric label="CPU 1m"  val={m.cpu  != null ? m.cpu  : "—"} unit={m.cpu  != null ? "%"  : ""} threshold={85} hist={_spark(m.idx * 11, m.cpu  || 0, 6)} color="var(--info)" />
              <HealthMetric label="CPU 5m"  val={m.cpu5 != null ? m.cpu5 : "—"} unit={m.cpu5 != null ? "%"  : ""} threshold={75} hist={_spark(m.idx * 17, m.cpu5 || 0, 4)} color="var(--info)" />
              <HealthMetric label="Memory"  val={m.mem  != null ? m.mem  : "—"} unit={m.mem  != null ? "%"  : ""} threshold={90} hist={_spark(m.idx * 23, m.mem  || 0, 3)} color="var(--zbx)" />
              <HealthMetric label="Temp"    val={m.temp != null ? m.temp : "—"} unit={m.temp != null ? "°C" : ""} threshold={72} hist={_spark(m.idx * 29, m.temp || 0, 5)} color="var(--pf)" />
            </div>
            <div className="hc-foot">
              {[0, 1].map(i => {
                const f = m.fanCells[i];
                if (!f) return (
                  <div key={`fan${i}`} className="hcf-cell">
                    <span className="lbl">FAN {i + 1}</span>
                    <span className="val">—</span>
                  </div>
                );
                const failed = !f.ok;
                return (
                  <div key={`fan${i}`} className="hcf-cell">
                    <span className="lbl">FAN {i + 1}</span>
                    <span className={"val " + (failed ? "err" : (f.rpm > 6000 ? "warn" : ""))}>
                      {f.rpm > 0 ? `${f.rpm} RPM` : "—"}
                    </span>
                  </div>
                );
              })}
              {[0, 1].map(i => {
                const p = m.psuCells[i];
                if (!p) return (
                  <div key={`psu${i}`} className="hcf-cell">
                    <span className="lbl">PSU {i + 1}</span>
                    <span className="val">—</span>
                  </div>
                );
                const absent = !p.present;
                return (
                  <div key={`psu${i}`} className="hcf-cell">
                    <span className="lbl">PSU {i + 1}</span>
                    <span className={"val " + (absent ? "err" : (p.ok ? "" : "warn"))}>
                      {absent ? "absent" : (p.watts > 0 ? `${p.watts} W` : (p.ok ? "ok" : "fault"))}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      )}
    </div>
  );
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
  const un  = (vlan.untaggedPorts || {})[member] || [];
  if (un.includes(portNum))  return "u-in";
  if (tag.includes(portNum)) return "u-tag";
  return "u-out";
};

const TabVlan = () => {
  const V = Array.isArray(window.VLANS) ? window.VLANS : [];
  const loading = (window.SWITCH_LOADING && window.SWITCH_LOADING.snapshot);
  // Pick the first VLAN by default; track by ifIndex so it stays stable
  // across snapshot refreshes even if a VID gets renumbered.
  const [sel, setSel] = useStateTAB(null);
  const selected = sel !== null
    ? V.find(v => v.ifIndex === sel)
    : (V.find(v => v.active) || V[0] || null);
  const selVid = selected ? selected.vid : null;
  const userCount = V.filter(v => v.active && (v.vid ?? 0) !== 1).length;
  const sysCount  = V.length - userCount;

  return (
    <div className="tab-pane">
      <div className="vlan-layout">
        <div className="card">
          <div className="card-h">
            <h3>VLAN table</h3>
            <SourceBadge src="zbx" />
            <div className="h-spacer" />
            <span className="h-meta">
              {loading
                ? "loading…"
                : `${V.length} VLAN${V.length === 1 ? "" : "s"} · ${userCount} user · ${sysCount} system`}
            </span>
          </div>
          {loading && (
            <div style={{ padding: "18px 14px", color: "var(--muted)" }}>
              Loading VLAN data from Zabbix…
            </div>
          )}
          {!loading && V.length === 0 && (
            <div style={{ padding: "18px 14px", color: "var(--muted)" }}>
              No VLAN items found on this switch. Confirm the
              vlan-poe-topology template patch is applied.
            </div>
          )}
          {!loading && V.length > 0 && (
            <table className="vlan-tbl">
              <thead>
                <tr>
                  <th style={{width: 50}}>VID</th>
                  <th>Name</th>
                  <th style={{width: 80}}>Untagged</th>
                  <th style={{width: 70}}>Tagged</th>
                  <th style={{width: 60}}>State</th>
                </tr>
              </thead>
              <tbody>
                {V.map(v => (
                  <tr key={v.ifIndex}
                      className={selected && selected.ifIndex === v.ifIndex ? "sel" : ""}
                      onClick={() => setSel(v.ifIndex)}>
                    <td className="mono fg" style={{color:"var(--accent)"}}>{v.vid ?? "—"}</td>
                    <td>
                      <div className="vname">{v.name || "(unnamed)"}</div>
                    </td>
                    <td className="mono">
                      <span className="port-pill">{v.untaggedCount}</span>
                    </td>
                    <td className="mono">
                      <span className="port-pill tag">{v.taggedCount}</span>
                    </td>
                    <td>{v.active
                      ? <span className="state-dot ok" title="enabled" />
                      : <span className="state-dot off" title="disabled" />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div style={{display:"flex", flexDirection:"column", gap: 14, minWidth: 0}}>
          <div className="card">
            <div className="card-h">
              <h3>{selected ? `VLAN ${selVid ?? "?"} · ${selected.name || "(unnamed)"}` : "Port membership"}</h3>
              <SourceBadge src="zbx" />
              <div className="h-spacer" />
              <span className="h-meta">
                {selected
                  ? `${selected.untaggedCount} untagged · ${selected.taggedCount} tagged`
                  : "—"}
              </span>
            </div>
            <div className="vlan-portmap">
              {!selected && (
                <div style={{ padding: "12px 4px", color: "var(--muted)" }}>
                  Select a VLAN to see its per-port membership.
                </div>
              )}
              {selected && (window.ARC_MDF_STACK || []).map(m => (
                <div key={m.idx} className="vp-row">
                  <span className="vp-id">M{m.idx}</span>
                  <div className="vp-grid">
                    {m.ports.map(p => {
                      let cls = "u-absent";
                      if (p.state !== "absent") {
                        cls = _vlanPortClass(selected, m.idx, p.n);
                      }
                      return <i key={p.n} className={cls} title={`${m.idx}:${p.n}`} />;
                    })}
                  </div>
                </div>
              ))}
              {selected && (
                <div className="vp-legend">
                  <span><i className="u-in" /> Untagged in VLAN {selVid}</span>
                  <span><i className="u-tag" /> Tagged in VLAN {selVid}</span>
                  <span><i className="u-out" /> Other VLAN</span>
                  <span><i className="u-absent" /> Not present</span>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
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
    mac:    r.mac || ""
  };
};

const TabPoe = () => {
  const P       = window.POE_BUDGET;
  const loading = (window.SWITCH_LOADING && window.SWITCH_LOADING.snapshot) || P === null;

  if (loading) {
    return (
      <div className="tab-pane">
        <div className="card" style={{ padding: "24px 18px", textAlign: "center", color: "var(--muted)" }}>
          Loading PoE budget data from Zabbix…
        </div>
      </div>
    );
  }

  const totals  = P.totals  || { drawn: 0, budget: 0, available: 0, measured: 0, pct: 0 };
  const members = Array.isArray(P.members) ? P.members : [];
  const ports   = Array.isArray(P.ports)   ? P.ports   : [];

  if (members.length === 0 && ports.length === 0) {
    return (
      <div className="tab-pane">
        <div className="card" style={{ padding: "24px 18px", textAlign: "center", color: "var(--muted)" }}>
          No PoE items found on this switch. Confirm the vlan-poe-topology
          template patch is applied and the switch has PoE-capable hardware.
        </div>
      </div>
    );
  }

  // PSU redundancy comes from the per-member-health PSU data the Stack
  // Health tab already uses. Worst-case across members: any "absent" PSU
  // → N+0 / err; any "fault" → degraded / warn; otherwise N+1 / ok.
  const allPsus = (window.STACK_MEMBERS || []).flatMap(m => Array.isArray(m.psus) ? m.psus : []);
  let psuLabel = "—", psuClass = "", psuSub = "";
  if (allPsus.length > 0) {
    const absent = allPsus.filter(p => !p.present).length;
    const fault  = allPsus.filter(p => p.present && !p.ok).length;
    if (absent > 0)      { psuLabel = "N+0"; psuClass = "err";  psuSub = `${absent} PSU absent`; }
    else if (fault > 0)  { psuLabel = "DEGRADED"; psuClass = "warn"; psuSub = `${fault} PSU fault`; }
    else                 { psuLabel = "N+1"; psuClass = "ok";   psuSub = `${allPsus.length} PSUs ok`; }
  }

  // Stack-wide totals from the available PSE envelope (sum of per-member
  // extremePethSlotMaxAvailPower) and the measured draw — fall back to
  // the allocated/configured-limit fields when those aren't present so
  // the headline still populates.
  const hlMeasured  = totals.measured > 0 ? totals.measured : totals.drawn;
  const hlAvailable = members.reduce((acc, m) => acc + (m.available != null ? m.available : (m.capacity != null ? m.capacity : m.budget)), 0)
                      || totals.budget;
  const hlPct       = hlAvailable > 0 ? Math.round((hlMeasured / hlAvailable) * 100) : 0;
  const hlHeadroom  = Math.max(0, hlAvailable - hlMeasured);

  return (
    <div className="tab-pane">
      <div className="poe-top">
        <div className="card poe-headline">
          <div className="poe-hl-left">
            <Ring
              value={hlMeasured}
              max={Math.max(hlAvailable, hlMeasured, 1)}
              size={140}
              color="var(--warn)"
              label={`${Math.round(hlMeasured)} W`}
              sub={`of ${Math.round(hlAvailable)} W available`}
              threshold={hlAvailable * 0.85}
            />
          </div>
          <div className="poe-hl-stats">
            <div className="phs">
              <span className="lbl">Measured</span>
              <span className="v warn">{Math.round(hlMeasured)} W</span>
              <span className="sub">{hlPct}% utilised</span>
            </div>
            <div className="phs">
              <span className="lbl">Max available</span>
              <span className="v">{Math.round(hlAvailable)} W</span>
              <span className="sub">across {members.length} member{members.length === 1 ? "" : "s"}</span>
            </div>
            <div className="phs">
              <span className="lbl">Headroom</span>
              <span className="v ok">{Math.round(hlHeadroom)} W</span>
              <span className="sub">{ports.length} port{ports.length === 1 ? "" : "s"} drawing</span>
            </div>
            <div className="phs">
              <span className="lbl">PSU redundancy</span>
              <span className={"v " + psuClass}>{psuLabel}</span>
              <span className="sub">{psuSub || "—"}</span>
            </div>
          </div>
        </div>

        <div className="card poe-perm">
          <div className="card-h">
            <h3>Per-member draw</h3>
            <SourceBadge src="zbx" />
          </div>
          <div className="poe-perm-body">
            {members.length === 0 && (
              <div style={{ padding: "12px 4px", color: "var(--muted)" }}>
                No per-slot PoE items reported.
              </div>
            )}
            {members.map(m => {
              // Show actual measured PSE draw against the slot's max
              // available power envelope. measured =
              // extremePethSlotMeasuredPower, available =
              // extremePethSlotMaxAvailPower (the operational ceiling
              // given the current PSU mode and status).
              const measured = m.measured != null ? m.measured : m.drawn;
              const cap = m.available != null && m.available > 0
                ? m.available
                : (m.capacity != null ? m.capacity : m.budget);
              const pct = cap > 0 ? Math.round((measured / cap) * 100) : 0;
              return (
                <div key={m.idx} className="ppm-row">
                  <div className="ppm-id">MEMBER {m.idx}</div>
                  <div className="ppm-bar">
                    <i className={pct > 80 ? "warn" : ""} style={{ width: `${Math.min(100, pct)}%` }} />
                    <span className="ppm-val">{Math.round(measured)} / {Math.round(cap)} W</span>
                  </div>
                  <div className="ppm-ports">{m.portCount} port{m.portCount === 1 ? "" : "s"}</div>
                  <div className="ppm-pct">{pct}%</div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="card" style={{marginTop: 14}}>
        <div className="card-h">
          <h3>Top PoE consumers</h3>
          <SourceBadge src="zbx" />
          <SourceBadge src="pf" />
          <div className="h-spacer" />
          <span className="h-meta">
            {ports.length === 0 ? "no ports drawing" : `${Math.min(ports.length, 25)} of ${ports.length} shown · sorted by W`}
          </span>
        </div>
        {ports.length === 0 && (
          <div style={{ padding: "18px 14px", color: "var(--muted)" }}>
            No ports reporting measured PoE draw.
          </div>
        )}
        {ports.length > 0 && (
          <table className="link-tbl poe-tbl">
            <thead>
              <tr>
                <th style={{width: 60}}>Port</th>
                <th>Device</th>
                <th>Vendor</th>
                <th style={{width: 90}}>Class</th>
                <th style={{width: 160}}>Draw</th>
                <th style={{width: 80, textAlign:"right"}}>Watts</th>
              </tr>
            </thead>
            <tbody>
              {ports.slice(0, 25).map((c, i) => {
                const pf = _poePfDevice(c.member, c.port);
                // class-4 ports can draw up to 25.5W; use that as the bar
                // ceiling so the bar reflects "fraction of class-4 max".
                const pct = Math.min(100, Math.round((c.watts / 25.5) * 100));
                const isClass4 = c.class === 5; // 5 = class4 (802.3at), 1..4 → class 0..3
                return (
                  <tr key={`${c.member}.${c.port}`}>
                    <td className="fg" style={{color: "var(--accent)"}}>{c.member}:{c.port}</td>
                    <td style={{color: "var(--fg)"}}>{pf ? pf.device : "—"}</td>
                    <td>{pf ? pf.vendor : "—"}</td>
                    <td>
                      {c.class != null
                        ? <span className={"poe-cls cls-" + c.class}>Class {c.class - 1}</span>
                        : <span style={{color: "var(--muted)"}}>—</span>}
                    </td>
                    <td>
                      <span className="util-bar"><i style={{ width: `${pct}%`, background: isClass4 ? "var(--warn)" : "var(--ok)" }} /></span>
                    </td>
                    <td style={{textAlign:"right"}}>{c.watts.toFixed(1)} W</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};

// ───────────────────────────────────────────────────────────────────
// 5. CLI (admin-only — server withholds window.SWITCH_SSH from non-admins)
// ───────────────────────────────────────────────────────────────────
const TabCli = ({ host }) => {
  const ssh = window.SWITCH_SSH || null;
  return (
    <div className="tab-pane">
      <div className="card">
        <div className="card-h">
          <h3>CLI · ssh {host.id}</h3>
          <SourceBadge src="ext" />
          <div className="h-spacer" />
          {ssh ? (
            <>
              <span className="h-meta">{ssh.user ? ssh.user + "@" : ""}{ssh.host}:{ssh.port} · ssheasy</span>
              <span className="h-link" onClick={() => window.open(ssh.url, "_blank", "noopener")}>Open in tab</span>
            </>
          ) : (
            <span className="h-meta">SSH not configured</span>
          )}
        </div>
        <div className="cli-pane">
          {ssh ? (
            <iframe
              className="cli-frame"
              src={ssh.url}
              title={"ssh " + ssh.host}
              allow="clipboard-read; clipboard-write"
            />
          ) : (
            <div className="cli-empty">
              Set <code>{"{$SSHEASY.URL}"}</code> (and a host management IP) to enable the live SSH console.
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

// ───────────────────────────────────────────────────────────────────
// 6. TRIGGERS
// ───────────────────────────────────────────────────────────────────
const TabTriggers = () => {
  const T = Array.isArray(window.SWITCH_TRIGGERS) ? window.SWITCH_TRIGGERS : [];
  const [filter, setFilter] = useStateTAB("all");
  const counts = {
    firing:   T.filter(t => t.status === "firing").length,
    enabled:  T.filter(t => t.status === "enabled").length,
    disabled: T.filter(t => t.status === "disabled").length,
  };
  const rows = filter === "all" ? T : T.filter(t => t.status === filter);
  const loading = window.SWITCH_LOADING && window.SWITCH_LOADING.snapshot;
  return (
    <div className="tab-pane">
      <div className="card-h-bar">
        <span className="h-title">Triggers</span>
        <SourceBadge src="zbx" />
        <div className="h-spacer" />
        <div className="trig-filter">
          <span
            className={"tf" + (filter === "all" ? " active" : "")}
            onClick={() => setFilter("all")}
          >All <b>{T.length}</b></span>
          <span
            className={"tf warn" + (filter === "firing" ? " active" : "")}
            onClick={() => setFilter("firing")}
          >Firing <b>{counts.firing}</b></span>
          <span
            className={"tf" + (filter === "enabled" ? " active" : "")}
            onClick={() => setFilter("enabled")}
          >Enabled <b>{counts.enabled}</b></span>
          <span
            className={"tf" + (filter === "disabled" ? " active" : "")}
            onClick={() => setFilter("disabled")}
          >Disabled <b>{counts.disabled}</b></span>
        </div>
        <span className="h-meta">Live · Zabbix trigger.get</span>
      </div>

      <div className="card">
        <table className="trig-tbl">
          <thead>
            <tr>
              <th style={{width: 90}}>Severity</th>
              <th>Name &amp; expression</th>
              <th style={{width: 120}}>24h history</th>
              <th style={{width: 75}}>Fires 24h</th>
              <th style={{width: 60}}>Deps</th>
              <th style={{width: 80}}>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} style={{ textAlign: "center", color: "var(--muted)", padding: 28 }}>
                  {loading            ? "Loading triggers…"
                   : T.length === 0   ? "No triggers defined on this host."
                   :                    `No ${filter} triggers.`}
                </td>
              </tr>
            )}
            {rows.map((t, i) => (
              <tr key={i} className={t.status === "firing" ? "firing" : ""}>
                <td><Sev level={t.sev} /></td>
                <td>
                  <div className="trig-name">{t.name}</div>
                  <code className="trig-expr">{t.expr}</code>
                </td>
                <td><Sparkline data={t.history} color={t.status === "firing" ? "var(--warn)" : "var(--muted-2)"} width={110} height={24} /></td>
                <td className="mono" style={{textAlign:"center", color: t.fires24h > 0 ? "var(--warn)" : "var(--muted)"}}>{t.fires24h}</td>
                <td className="mono" style={{textAlign:"center", color: t.deps > 0 ? "var(--fg-2)" : "var(--muted)"}}>{t.deps}</td>
                <td>
                  <span className={"trig-status " + t.status}>{t.status.toUpperCase()}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

// ───────────────────────────────────────────────────────────────────
// 7. CONFIG BACKUPS
// ───────────────────────────────────────────────────────────────────
const TabBackups = () => {
  const B = window.TAB_BACKUPS;
  const D = window.TAB_DIFF;
  const [sel, setSel] = useStateTAB(1);
  return (
    <div className="tab-pane">
      <div className="backup-layout">
        <div className="card">
          <div className="card-h">
            <h3>Configuration backups</h3>
            <SourceBadge src="ext" />
            <SourceBadge src="zbx" />
            <div className="h-spacer" />
            <span className="h-meta">retention 90d · last 6 of 312 shown</span>
            <span className="h-link">Run backup now</span>
          </div>
          <table className="backup-tbl">
            <thead>
              <tr>
                <th style={{width: 22}}></th>
                <th style={{width: 150}}>Timestamp</th>
                <th>User</th>
                <th style={{width: 70}}>Method</th>
                <th style={{width: 70}}>Lines</th>
                <th style={{width: 70}}>Δ</th>
                <th style={{width: 90}}>Hash</th>
              </tr>
            </thead>
            <tbody>
              {B.map((b, i) => (
                <tr key={i} className={sel === i ? "sel" : ""} onClick={() => setSel(i)}>
                  <td><span className={"bk-dot " + (b.user.startsWith("auto") ? "auto" : "human")} /></td>
                  <td className="mono">{b.ts}</td>
                  <td>
                    <div>{b.user}</div>
                    <div className="bk-note">{b.note}</div>
                  </td>
                  <td>{b.method}</td>
                  <td className="mono" style={{textAlign:"right"}}>{b.lines}</td>
                  <td className="mono" style={{textAlign:"right", color: b.changed > 0 ? "var(--warn)" : "var(--muted)"}}>
                    {b.changed > 0 ? `+${b.changed}` : "—"}
                  </td>
                  <td className="mono" style={{color: "var(--muted)"}}>{b.hash}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card">
          <div className="card-h">
            <h3>Diff · {B[sel].hash}  →  {B[Math.max(0, sel - 1)].hash}</h3>
            <SourceBadge src="ext" />
            <div className="h-spacer" />
            <span className="h-meta">{B[sel].changed || 0} changed line{B[sel].changed === 1 ? "" : "s"} · context ±2</span>
            <span className="h-link">Restore this revision</span>
          </div>
          <div className="diff-pane">
            <div className="diff-meta">
              <div className="dm-col">
                <div className="dm-lbl">FROM</div>
                <div className="dm-ts">{B[sel].ts}</div>
                <div className="dm-by">{B[sel].user}</div>
              </div>
              <div className="dm-arrow">→</div>
              <div className="dm-col">
                <div className="dm-lbl">TO</div>
                <div className="dm-ts">{B[Math.max(0, sel - 1)].ts}</div>
                <div className="dm-by">{B[Math.max(0, sel - 1)].user}</div>
              </div>
              <div className="dm-spacer" />
              <div className="dm-stat add">+{D.filter(d => d.type === "add").length}</div>
              <div className="dm-stat del">−{D.filter(d => d.type === "del").length}</div>
            </div>
            <pre className="diff-body">
              {D.map((d, i) => {
                const pre = d.type === "add" ? "+" : d.type === "del" ? "−" : " ";
                return (
                  <div key={i} className={"diff-line " + d.type}>
                    <span className="dl-ln">{d.ln}</span>
                    <span className="dl-pre">{pre}</span>
                    <span className="dl-tx">{d.txt || "\u00a0"}</span>
                  </div>
                );
              })}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
};

// ───────────────────────────────────────────────────────────────────
// XIQ tab — looks the switch up in ExtremeCloud IQ and shows the
// XIQ-side connected clients, recent device-scoped events, and any
// open alerts that mention the switch hostname. Fetches lazily on
// first tab activation; result is cached on window so re-clicking
// doesn't refire the lookup.
// ───────────────────────────────────────────────────────────────────
const TabXiq = ({ host }) => {
  const [state, setState] = useStateTAB(() => window.SWITCH_XIQ || { loading: false, loaded: false });
  const [now, setNow] = useStateTAB(() => Date.now());

  // Single-flight: per page session we fetch once per host. The
  // bridge exposes window.tcsLoadSwitchXiq for the Refresh button.
  const hostid = host && host.hostid ? String(host.hostid) : "";

  React.useEffect(() => {
    if (!hostid || state.loading || state.loaded) return;
    if (typeof window.tcsLoadSwitchXiq !== "function") return;
    setState(s => ({ ...s, loading: true, error: null }));
    window.tcsLoadSwitchXiq(hostid)
      .then(d => { window.SWITCH_XIQ = { ...d, loading: false, loaded: true }; setState(window.SWITCH_XIQ); })
      .catch(e => setState({ loading: false, loaded: true, error: String(e && e.message ? e.message : e) }));
  }, [hostid]);

  // Live-aging timer for "X ago" labels.
  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);

  const refresh = () => {
    if (!hostid || typeof window.tcsLoadSwitchXiq !== "function") return;
    setState(s => ({ ...s, loading: true, error: null }));
    window.tcsLoadSwitchXiq(hostid, true)
      .then(d => { window.SWITCH_XIQ = { ...d, loading: false, loaded: true }; setState(window.SWITCH_XIQ); })
      .catch(e => setState({ loading: false, loaded: true, error: String(e && e.message ? e.message : e) }));
  };

  const fmtAge = (sec) => {
    if (!sec || sec < 0) return "—";
    if (sec < 60) return sec + "s";
    if (sec < 3600) return Math.floor(sec / 60) + "m";
    if (sec < 86400) return Math.floor(sec / 3600) + "h " + Math.floor((sec % 3600) / 60) + "m";
    return Math.floor(sec / 86400) + "d";
  };
  const tsAgo = (ts) => fmtAge(Math.max(0, Math.floor(now / 1000 - (Number(ts) || 0))));
  const tsLabel = (ts) => {
    if (!ts) return "—";
    const d = new Date(Number(ts) * 1000);
    return d.toLocaleString();
  };

  const reasonMsg = {
    no_token:      "No XIQ API token configured. For short tokens set {$XIQ_API_TOKEN}; for the longer Platform ONE JWT, set {$XIQ_API_TOKEN_FILE} to a file path containing the token, or drop it at /etc/zabbix/tcs_dashboard/xiq_api_token.",
    unknown_host:  "Host not visible in Zabbix.",
    lookup_failed: "XIQ lookup failed — see PHP error log.",
    not_in_xiq:    "This switch isn't onboarded in ExtremeCloud IQ.",
    lookup_ambiguous: "Refused to query XIQ — the candidate device matched only the hostname, not the serial/MAC. Verify the Zabbix host inventory serialno_a matches XIQ.",
  };

  const device  = state.device || null;
  const clients = Array.isArray(state.clients) ? state.clients : [];
  const events  = Array.isArray(state.events)  ? state.events  : [];
  const alerts  = Array.isArray(state.alerts)  ? state.alerts  : [];
  const notes   = (state.notes && typeof state.notes === "object") ? state.notes : {};

  // ── Merge XIQ + SNMP auth + PF per (port, MAC) ──────────────────────
  // XIQ wired-client rows carry port=`1:1` and a colon-separated MAC.
  // window.PORT_AUTH is keyed by "m.p" (e.g. "1.1") with array of
  // sessions {mac, applied, policy, policyName, agentLabel, vlan, duration}.
  // window._tcsPfByKey same "m.p" keying with PF rows {mac, host, ip, role,
  // owner, os, dhcpFp, lastSeen, reg}.
  // The merged row collects the strongest data from each source and
  // records `sources` (XIQ/SNMP/PF) so the UI can show provenance.
  const normMac = (s) => String(s || "").toLowerCase().replace(/[^0-9a-f]/g, "");
  const dotKey  = (port) => String(port || "").replace(/:/g, ".");      // "1:1" → "1.1"
  const colonPort = (k)  => String(k || "").replace(/\./g, ":");

  const buildMergedClients = () => {
    const xiqWired = clients.filter(c => c.wired);
    // Group all three sources by "port|mac" so rows from different
    // sources for the same physical client collapse together.
    const byKey = new Map();   // key → merged row
    const ensure = (port, mac) => {
      const k = dotKey(port) + "|" + normMac(mac);
      if (!byKey.has(k)) {
        byKey.set(k, {
          key: k,
          port: colonPort(port),
          portDot: dotKey(port),
          mac: mac || "",
          macNorm: normMac(mac),
          host: "", ip: "", user: "", vlan: "", os: "",
          ipp: "",        // XIQ Instant Port Profile
          role: "",       // PF role
          owner: "",      // PF dot1x username
          dhcpFp: "",
          lastSeen: "",
          reg: "",
          authPolicy: "", // SNMP policy profile name
          authMethod: "", // SNMP agent label ("802.1X" / "MAC" / etc.)
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
      setIf(row, "host",  c.host);
      setIf(row, "ip",    c.ip);
      setIf(row, "user",  c.user);
      setIf(row, "vlan",  c.vlan);
      setIf(row, "os",    c.os);
      setIf(row, "ipp",   c.role);     // XIQ's "role" is the Instant Port Profile
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
        setIf(row, "host",   p.host);
        setIf(row, "ip",     p.ip);
        setIf(row, "owner",  p.owner);
        setIf(row, "role",   p.role);
        setIf(row, "os",     p.os);
        setIf(row, "dhcpFp", p.dhcpFp);
        setIf(row, "lastSeen", p.lastSeen);
        setIf(row, "reg",    p.reg);
        // PF VLAN is from locationlog — fill it in if XIQ/SNMP didn't
        if (!row.vlan && p.vlan) row.vlan = p.vlan;
      }
    }

    // Sort: by port (member, then port number numerically), then by MAC.
    const portCmp = (a, b) => {
      const pa = a.portDot.split(".").map(n => Number(n) || 0);
      const pb = b.portDot.split(".").map(n => Number(n) || 0);
      return (pa[0] - pb[0]) || (pa[1] - pb[1]) || a.macNorm.localeCompare(b.macNorm);
    };
    return Array.from(byKey.values()).sort(portCmp);
  };

  const merged = device ? buildMergedClients() : [];
  const sourceBadge = (label, on) => (
    <span key={label} style={{
      display: "inline-block", marginRight: 4, padding: "0 5px",
      fontSize: 9, lineHeight: "14px", borderRadius: 3, fontFamily: "var(--mono)",
      color: on ? "var(--fg)" : "var(--muted)",
      background: on ? "var(--bg-3)" : "transparent",
      border: "1px solid " + (on ? "var(--line)" : "transparent")
    }}>{label}</span>
  );

  // Pill rendered in place of an empty table, explaining why XIQ has
  // nothing to show. Used for switches against /clients/active (XIQ API
  // limitation) and /alerts (token scope).
  const InfoPill = ({ children, kind }) => (
    <div style={{
      padding: "10px 12px",
      margin: "6px 0",
      fontSize: 11,
      lineHeight: 1.5,
      color: kind === "warn" ? "var(--warn, #f5b300)" : "var(--muted)",
      background: kind === "warn" ? "rgba(245,179,0,0.08)" : "var(--bg-2)",
      border: "1px solid " + (kind === "warn" ? "rgba(245,179,0,0.30)" : "var(--line)"),
      borderRadius: 6
    }}>
      {children}
    </div>
  );

  return (
    <div className="card" style={{ flex: 1 }}>
      <div className="card-h">
        <h3>ExtremeCloud IQ</h3>
        <SourceBadge src="ext" />
        <div className="h-spacer" />
        {state.rateLimit && state.rateLimit.remaining != null && (
          <span className="h-meta mono" title="XIQ quota remaining (7,500/hr/VIQ)">
            quota {state.rateLimit.remaining}
          </span>
        )}
        <button className="seg-btn" onClick={refresh} disabled={state.loading} style={{ marginLeft: 8 }}>
          {state.loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      <div className="card-b">
        {state.loading && !state.loaded && (
          <div style={{ padding: "30px 12px", textAlign: "center", color: "var(--muted)", fontSize: 12 }}>
            Looking up <span className="mono">{host && host.host}</span> in ExtremeCloud IQ…
          </div>
        )}

        {state.error && (
          <div style={{ padding: 12, color: "var(--err, #f25f5c)", fontSize: 12 }}>
            {state.error}
          </div>
        )}

        {state.loaded && !state.ok && state.reason && (
          <div style={{ padding: "20px 12px", color: "var(--muted)", fontSize: 12 }}>
            {reasonMsg[state.reason] || state.reason}
          </div>
        )}

        {state.loaded && state.ok && device && (
          <React.Fragment>
            {/* ── Identity card ─────────────────────────────────────── */}
            <div className="xiq-identity" style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
              gap: 10,
              marginBottom: 14,
              padding: 12,
              background: "var(--bg-2)",
              border: "1px solid var(--line)",
              borderRadius: 6
            }}>
              {[
                ["Hostname",  device.hostname || "—"],
                ["Model",     device.model || "—"],
                ["Firmware",  device.firmware || "—"],
                ["Serial",    device.serial || "—"],
                ["MAC",       device.mac || "—"],
                ["IP",        device.ip || "—"],
                ["Policy",    device.policy_name || "—"],
                ["Connected", device.connected
                    ? <span style={{ color: "var(--ok, #34d399)" }}>● online</span>
                    : <span style={{ color: "var(--err, #f25f5c)" }}>● offline</span>]
              ].map(([k, v]) => (
                <div key={k}>
                  <div style={{ fontSize: 10, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.4 }}>{k}</div>
                  <div className="mono" style={{ fontSize: 12, marginTop: 2 }}>{v}</div>
                </div>
              ))}
            </div>

            {/* ── Connected clients ─────────────────────────────────── */}
            <div style={{ marginBottom: 14 }}>
              <div className="card-h" style={{ padding: "4px 0", borderBottom: "1px solid var(--line)", marginBottom: 6 }}>
                <h4 style={{ margin: 0, fontSize: 12, textTransform: "uppercase", letterSpacing: 0.5 }}>Clients</h4>
                <span className="h-meta mono">{clients.length}</span>
              </div>
              {clients.length === 0 && merged.length === 0 ? (
                notes.clients
                  ? <InfoPill kind="warn">{notes.clients}</InfoPill>
                  : <div style={{ padding: "10px 4px", color: "var(--muted)", fontSize: 11 }}>No active clients reported by XIQ.</div>
              ) : (() => {
                // Wireless XIQ rows (APs) render the legacy SSID/Conn table.
                // Switch tabs render the merged XIQ + SNMP-auth + PF view
                // built above, keyed by (port, MAC). Both can coexist if
                // a stack happens to host an AP child.
                const wireless = clients.filter(c => !c.wired);
                return (
                  <React.Fragment>
                    {wireless.length > 0 && (
                      <table className="tbl" style={{ width: "100%", fontSize: 11, marginBottom: merged.length ? 12 : 0 }}>
                        <thead>
                          <tr>
                            <th>MAC</th>
                            <th>Host / IP</th>
                            <th>User</th>
                            <th>SSID</th>
                            <th>VLAN</th>
                            <th>OS</th>
                            <th>Conn</th>
                          </tr>
                        </thead>
                        <tbody>
                          {wireless.slice(0, 200).map(c => (
                            <tr key={"w:" + (c.mac || "?") + ":" + c.duration}>
                              <td className="mono">{c.mac || "—"}</td>
                              <td>
                                <div>{c.host || "—"}</div>
                                <div className="mono" style={{ color: "var(--muted)", fontSize: 10 }}>{c.ip || ""}</div>
                              </td>
                              <td>{c.user || "—"}</td>
                              <td>{c.ssid || "—"}</td>
                              <td className="mono">{c.vlan || "—"}</td>
                              <td>{c.os || "—"}</td>
                              <td className="mono">{fmtAge(c.duration)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                    {merged.length > 0 && (
                      <table className="tbl" style={{ width: "100%", fontSize: 11 }}>
                        <thead>
                          <tr>
                            <th style={{ width: 110 }}>Sources</th>
                            <th style={{ width: 70 }}>Port</th>
                            <th>MAC</th>
                            <th>Host / IP</th>
                            <th>User</th>
                            <th>Role / Profile</th>
                            <th>Auth</th>
                            <th>VLAN</th>
                            <th>OS / Fingerprint</th>
                            <th>Last seen</th>
                          </tr>
                        </thead>
                        <tbody>
                          {merged.slice(0, 300).map(r => {
                            const xiq  = r.sources.has("XIQ");
                            const snmp = r.sources.has("SNMP");
                            const pf   = r.sources.has("PF");
                            const role = r.role || r.ipp;            // PF role beats IPP if both set above
                            const authLabel = r.authMethod
                              ? r.authMethod + (r.authApplied ? "" : " (pending)")
                              : "";
                            const vlan = r.vlan || r.authVlan;
                            const os   = r.os;
                            return (
                              <tr key={r.key}>
                                <td>
                                  {sourceBadge("XIQ",  xiq)}
                                  {sourceBadge("SNMP", snmp)}
                                  {sourceBadge("PF",   pf)}
                                </td>
                                <td className="mono">{r.port || "—"}</td>
                                <td className="mono">{r.mac || "—"}</td>
                                <td>
                                  <div>{r.host || "—"}</div>
                                  <div className="mono" style={{ color: "var(--muted)", fontSize: 10 }}>{r.ip || ""}</div>
                                </td>
                                <td>
                                  <div>{r.owner || r.user || "—"}</div>
                                  {r.owner && r.user && r.owner !== r.user && (
                                    <div className="mono" style={{ color: "var(--muted)", fontSize: 10 }} title="XIQ-side user">xiq:{r.user}</div>
                                  )}
                                </td>
                                <td>
                                  <div>{role || "—"}</div>
                                  {r.authPolicy && r.authPolicy !== role && (
                                    <div className="mono" style={{ color: "var(--muted)", fontSize: 10 }} title="SNMP policy profile">snmp:{r.authPolicy}</div>
                                  )}
                                </td>
                                <td>
                                  {snmp ? (
                                    <span style={{ color: r.authApplied ? "var(--ok, #34d399)" : "var(--warn, #f5b300)" }}>
                                      {authLabel || (r.authApplied ? "applied" : "—")}
                                    </span>
                                  ) : "—"}
                                  {r.authSessionCount > 1 && (
                                    <span className="mono" style={{ color: "var(--muted)", fontSize: 10, marginLeft: 4 }} title="multiple auth sessions">×{r.authSessionCount}</span>
                                  )}
                                </td>
                                <td className="mono">{vlan || "—"}</td>
                                <td>
                                  <div>{os || "—"}</div>
                                  {r.dhcpFp && (
                                    <div className="mono" style={{ color: "var(--muted)", fontSize: 10 }} title="DHCP fingerprint">{r.dhcpFp}</div>
                                  )}
                                </td>
                                <td className="mono" style={{ fontSize: 10 }}>{r.lastSeen || "—"}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    )}
                    {/* Footer note: how many rows have multi-source coverage */}
                    {merged.length > 0 && (() => {
                      const xiqOnly = merged.filter(r => r.sources.size === 1 && r.sources.has("XIQ")).length;
                      const pfOnly  = merged.filter(r => r.sources.size === 1 && r.sources.has("PF")).length;
                      const snmpOnly= merged.filter(r => r.sources.size === 1 && r.sources.has("SNMP")).length;
                      const multi   = merged.length - xiqOnly - pfOnly - snmpOnly;
                      return (
                        <div style={{ marginTop: 6, fontSize: 10, color: "var(--muted)", fontFamily: "var(--mono)" }}>
                          {merged.length} clients · {multi} multi-source · {xiqOnly} XIQ-only · {snmpOnly} SNMP-only · {pfOnly} PF-only
                        </div>
                      );
                    })()}
                  </React.Fragment>
                );
              })()}
            </div>

            {/* ── Events (per-device alarm log) ─────────────────────── */}
            <div style={{ marginBottom: 14 }}>
              <div className="card-h" style={{ padding: "4px 0", borderBottom: "1px solid var(--line)", marginBottom: 6 }}>
                <h4 style={{ margin: 0, fontSize: 12, textTransform: "uppercase", letterSpacing: 0.5 }}>Events</h4>
                <span className="h-meta mono">{events.length} · last 30d</span>
              </div>
              {events.length === 0 ? (
                <div style={{ padding: "10px 4px", color: "var(--muted)", fontSize: 11 }}>No device events in the last 30 days.</div>
              ) : (
                <table className="tbl" style={{ width: "100%", fontSize: 11 }}>
                  <thead>
                    <tr>
                      <th style={{ width: 70 }}>Sev</th>
                      <th style={{ width: 130 }}>When</th>
                      <th style={{ width: 130 }}>Category</th>
                      <th>Message</th>
                    </tr>
                  </thead>
                  <tbody>
                    {events.slice(0, 100).map(e => (
                      <tr key={e.id} style={e.value === 0 ? { opacity: 0.55 } : null}>
                        <td><Sev level={e.severity} /></td>
                        <td className="mono" title={tsLabel(e.clock)}>{tsAgo(e.clock)} ago</td>
                        <td>{e.category || "—"}</td>
                        <td>{e.message || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {/* ── Alerts (global, hostname-keyword filtered) ────────── */}
            <div>
              <div className="card-h" style={{ padding: "4px 0", borderBottom: "1px solid var(--line)", marginBottom: 6 }}>
                <h4 style={{ margin: 0, fontSize: 12, textTransform: "uppercase", letterSpacing: 0.5 }}>Alerts</h4>
                <span className="h-meta mono">{alerts.length} · last 7d</span>
              </div>
              {alerts.length === 0 ? (
                notes.alerts
                  ? <InfoPill kind="warn">{notes.alerts}</InfoPill>
                  : <div style={{ padding: "10px 4px", color: "var(--muted)", fontSize: 11 }}>No XIQ alerts reference this host.</div>
              ) : (
                <table className="tbl" style={{ width: "100%", fontSize: 11 }}>
                  <thead>
                    <tr>
                      <th style={{ width: 70 }}>Sev</th>
                      <th style={{ width: 130 }}>When</th>
                      <th style={{ width: 130 }}>Source</th>
                      <th>Summary</th>
                      <th style={{ width: 60 }}>Ack</th>
                    </tr>
                  </thead>
                  <tbody>
                    {alerts.map(a => (
                      <tr key={a.id || (a.ts + a.summary)}>
                        <td><Sev level={a.severity} /></td>
                        <td className="mono" title={tsLabel(a.ts)}>{tsAgo(a.ts)} ago</td>
                        <td>{a.source || a.category || "—"}</td>
                        <td>{a.summary || "—"}</td>
                        <td className="mono">{a.acknowledged ? "✓" : ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </React.Fragment>
        )}
      </div>
    </div>
  );
};

// ───────────────────────────────────────────────────────────────────
// Tab definitions table — exported
// ───────────────────────────────────────────────────────────────────
window.SWITCH_TABS = [
  { id: "ports",    label: "Port Status",   badge: null },
  { id: "topo",     label: "Topology",      badge: null },
  { id: "health",   label: "Stack Health",  badge: null },
  { id: "vlan",     label: "VLAN",          badge: null },
  { id: "poe",      label: "PoE Budget",    badge: null },
  { id: "xiq",      label: "XIQ",           badge: null },
  { id: "cli",      label: "CLI",           badge: null, admin: true },
  { id: "triggers", label: "Triggers",      badge: null },
  { id: "backups",  label: "Config Backups",badge: null },
];

window.TabTopology    = TabTopology;
window.TabStackHealth = TabStackHealth;
window.TabVlan        = TabVlan;
window.TabPoe         = TabPoe;
window.TabXiq         = TabXiq;
window.TabCli         = TabCli;
window.TabTriggers    = TabTriggers;
window.TabBackups     = TabBackups;
