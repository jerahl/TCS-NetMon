// Connected Devices — PacketFence endpoint inventory across the district.
// Layout: KPI strip → 24h connect-trend → device-type split + filters → main table.

const PFHeader = ({ title, tag, crumb, kpiRow }) => (
  <div className="page-header" style={{ alignItems: "center" }}>
    <div style={{ flex: 1 }}>
      <div className="host-title">
        <h1>{title}</h1>
        <span className="role-tag" style={{ fontSize: 10, padding: "1px 8px", background: "rgba(245,179,0,0.10)", color: "var(--pf)", border: "1px solid rgba(245,179,0,0.4)" }}>
          IDENTITY · PACKETFENCE
        </span>
        {tag && <span className="role-tag faculty" style={{ fontSize: 10, padding: "1px 8px" }}>{tag}</span>}
      </div>
      <div className="host-meta">
        <span className="pill"><span className="dot" style={{ background: "var(--ok)" }} /> Cluster 3/3 online</span>
        <span className="pill"><span className="lbl">PacketFence</span> <span className="v">v{PF_SUMMARY.pfVersion}</span></span>
        <span className="pill"><span className="lbl">Sites</span> <span className="v">{PF_SUMMARY.sites}</span></span>
        <span className="pill"><span className="lbl">Endpoints</span> <span className="v">{PF_SUMMARY.total.toLocaleString()}</span></span>
        <span className="pill"><span className="lbl">Last sync</span> <span className="v">{PF_SUMMARY.lastSync}</span></span>
      </div>
    </div>
    <div className="timerange">
      <Icon name="calendar" />
      <span className="range-val">Last 24h</span>
      <Icon name="chevron" />
    </div>
  </div>
);

// ───────── KPI strip ─────────
const ClientsKPIs = () => {
  const s = PF_SUMMARY;
  const cells = [
    { lbl: "Total endpoints", v: s.total.toLocaleString(),    note: "12,704 unique users", cls: "" },
    { lbl: "Registered",      v: s.registered.toLocaleString(),note: "93.1% of total",     cls: "ok"   },
    { lbl: "Guest · portal",  v: s.guest,                      note: "24h · self-reg",     cls: "pf"   },
    { lbl: "Unregistered",    v: s.unregistered,               note: "pending · OUI",      cls: "warn" },
    { lbl: "Isolated",        v: s.isolated,                   note: "VLAN 666",           cls: "err"  },
    { lbl: "New today",       v: 142,                          note: "+12 vs avg",         cls: ""     },
  ];
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="pf-kpis">
        {cells.map(c => (
          <div className="pf-kpi" key={c.lbl}>
            <div className="pf-kpi-h">
              <span className="pf-kpi-lbl">{c.lbl}</span>
              <SourceBadge src="pf" />
            </div>
            <div className={"pf-kpi-v " + c.cls}>{c.v}</div>
            <div className="pf-kpi-note">{c.note}</div>
          </div>
        ))}
      </div>
    </div>
  );
};

// ───────── 24h connections ─────────
const ConnectsTrend = () => {
  const data = PF_CONNECTS_24H;
  const max = Math.max(...data);
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="card-h">
        <h3>Endpoint Connections (24h)</h3>
        <SourceBadge src="pf" />
        <div className="h-spacer" />
        <span className="h-meta">{data.reduce((a,b)=>a+b,0).toLocaleString()} auth attempts · peak {max.toLocaleString()} @ 09:00</span>
      </div>
      <div className="pf-bars24">
        {data.map((v, i) => (
          <div className="pf-bar" key={i} title={`${i}:00 — ${v} connections`}>
            <div style={{ height: `${(v / max) * 100}%` }} className={i === 7 || i === 8 || i === 9 ? "" : ""} />
            {i % 4 === 0 && <div className="pf-bar-tick">{i.toString().padStart(2, "0")}</div>}
          </div>
        ))}
      </div>
    </div>
  );
};

// ───────── Device type / role split (visual breakdown) ─────────
const RolePie = () => {
  const roles = PF_ROLES.filter(r => r.id !== "isolation");
  const total = roles.reduce((n, r) => n + r.count, 0);
  const palette = ["var(--pf)", "var(--info)", "#e8843c", "var(--ext)", "var(--ok)", "var(--zbx)", "#c084fc", "#22d3ee"];
  return (
    <div className="pf-donut-wrap">
      <svg width="120" height="120" viewBox="0 0 120 120">
        <circle cx="60" cy="60" r="48" stroke="rgba(255,255,255,0.06)" strokeWidth="14" fill="none" />
        {(() => {
          let acc = 0; const C = 2 * Math.PI * 48;
          return roles.map((r, i) => {
            const frac = r.count / total;
            const dash = C * frac;
            const off  = -C * acc;
            acc += frac;
            return (
              <circle key={r.id} cx="60" cy="60" r="48"
                stroke={palette[i % palette.length]} strokeWidth="14" fill="none"
                strokeDasharray={`${dash} ${C}`} strokeDashoffset={off}
                transform="rotate(-90 60 60)" />
            );
          });
        })()}
        <text x="60" y="58" textAnchor="middle" fill="var(--fg)" fontFamily="var(--mono)" fontSize="16" fontWeight="600">
          {total.toLocaleString()}
        </text>
        <text x="60" y="74" textAnchor="middle" fill="var(--muted)" fontSize="9" letterSpacing="0.5">DEVICES</text>
      </svg>
      <div className="pf-donut-legend">
        {roles.map((r, i) => (
          <div className="pf-leg-row" key={r.id}>
            <span className="pf-leg-sw" style={{ background: palette[i % palette.length] }} />
            <span className="pf-leg-lbl">{r.name}</span>
            <span className="pf-leg-v">{r.count.toLocaleString()}</span>
            <span className="pf-leg-pct">{(r.count / total * 100).toFixed(1)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
};

// ───────── Filter bar + main table ─────────
const STATUS_FILTERS = [
  { k: "all",          l: "All",         c: 12847 },
  { k: "registered",   l: "Registered",  c: 11962 },
  { k: "guest",        l: "Guest",       c: 712   },
  { k: "pending",      l: "Pending",     c: 4     },
  { k: "unregistered", l: "Unregistered",c: 173   },
  { k: "isolated",     l: "Isolated",    c: 2     },
];

const DevicesTable = ({ filterStatus, setFilterStatus, filterRole, setFilterRole }) => {
  const rows = PF_DEVICES.filter(d => {
    if (filterStatus !== "all" && d.status !== filterStatus) return false;
    if (filterRole   !== "all" && d.role   !== filterRole)   return false;
    return true;
  });
  return (
    <div className="card">
      <div className="card-h">
        <h3>Endpoint Inventory</h3>
        <SourceBadge src="pf" />
        <SourceBadge src="ext" />
        <div className="h-spacer" />
        <span className="h-meta">{rows.length} of {PF_DEVICES.length} shown</span>
        <a className="h-link">Export CSV <Icon name="external" size={11} /></a>
      </div>
      <div className="pf-filterbar">
        {STATUS_FILTERS.map(f => (
          <button key={f.k}
            className={"pf-chip" + (filterStatus === f.k ? " active" : "")}
            onClick={() => setFilterStatus(f.k)}>
            {f.l} <span className="pf-chip-c">{f.c.toLocaleString()}</span>
          </button>
        ))}
        <span className="pf-filter-spacer" />
        <select
          value={filterRole}
          onChange={e => setFilterRole(e.target.value)}
          style={{ background: "var(--bg-2)", border: "1px solid var(--line)", color: "var(--fg-2)", fontSize: 11.5, padding: "4px 8px", borderRadius: 6, fontFamily: "inherit" }}>
          <option value="all">All roles</option>
          {PF_ROLES.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
        <div className="pf-search-mini">
          <Icon name="search" size={12} />
          <input placeholder="Find MAC, hostname, owner…" readOnly />
        </div>
      </div>
      <div style={{ maxHeight: 520, overflowY: "auto" }}>
        <table className="tbl">
          <thead>
            <tr>
              <th style={{ width: 130 }}>MAC</th>
              <th>Hostname / device</th>
              <th>Owner</th>
              <th style={{ width: 110 }}>Role</th>
              <th style={{ width: 60, textAlign: "center" }}>VLAN</th>
              <th>NAS / location</th>
              <th style={{ width: 110 }}>SSID</th>
              <th style={{ width: 95 }}>Last seen</th>
              <th style={{ width: 115 }}>Status</th>
              <th style={{ width: 32 }}></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((d, i) => (
              <tr key={i}>
                <td className="fg">{d.mac}</td>
                <td className="fg">
                  <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.3 }}>
                    <span>{d.host}</span>
                    <span style={{ fontSize: 10, color: "var(--muted)" }}>{d.vendor} · {d.os}</span>
                  </div>
                </td>
                <td style={{ fontFamily: "var(--sans)", fontSize: 11.5 }}>{d.owner}</td>
                <td><span className={"role-tag " + d.role}>{d.role}</span></td>
                <td style={{ textAlign: "center" }}>{d.vlan}</td>
                <td>
                  <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.3 }}>
                    <span>{d.loc}</span>
                    <span style={{ fontSize: 10, color: "var(--muted)" }}>site {d.site}</span>
                  </div>
                </td>
                <td>{d.ssid}</td>
                <td className="mono">{d.lastSeen}</td>
                <td><span className={"reg-pill " + d.status}><span className="dot" style={{ background: "currentColor" }} />{d.status}</span></td>
                <td><SourceBadge src={d.src} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

// ───────── App ─────────
const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "density": "balanced",
  "showSourceBadges": true,
  "filterStatus": "all",
  "filterRole": "all"
}/*EDITMODE-END*/;

const App = () => {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  React.useEffect(() => {
    document.documentElement.classList.toggle("hide-src-badges", !t.showSourceBadges);
  }, [t.showSourceBadges]);

  return (
    <div className="app" data-density={t.density} data-pf="1" data-screen-label="Connected Devices">
      <GlobalSidebar active="clients" />
      <div className="main">
        <GlobalTopbar crumb={["Tuscaloosa City Schools", "Identity", "Connected Devices"]} search="Find MAC, hostname, user, IP…" />
        <PFHeader title="Connected Devices" />
        <div className="body">
          <DemoBanner name="Connected Devices" />
          <ClientsKPIs />

          <div className="row" style={{ gridTemplateColumns: "1.6fr 1fr", marginBottom: 14 }}>
            <ConnectsTrend />
            <div className="card">
              <div className="card-h">
                <h3>Devices by Role</h3>
                <SourceBadge src="pf" />
                <div className="h-spacer" />
                <a className="h-link">Manage roles <Icon name="external" size={11} /></a>
              </div>
              <RolePie />
            </div>
          </div>

          <DevicesTable
            filterStatus={t.filterStatus}
            setFilterStatus={v => setTweak("filterStatus", v)}
            filterRole={t.filterRole}
            setFilterRole={v => setTweak("filterRole", v)} />
        </div>
      </div>

      <TweaksPanel title="Tweaks">
        <TweakSection title="Layout">
          <TweakRadio label="Density" value={t.density} options={[
            { value: "spacious", label: "Spacious" },
            { value: "balanced", label: "Balanced" },
            { value: "dense",    label: "Dense"    }
          ]} onChange={v => setTweak("density", v)} />
          <TweakToggle label="Show data-source badges" value={t.showSourceBadges} onChange={v => setTweak("showSourceBadges", v)} />
        </TweakSection>
        <TweakSection title="Filters">
          <TweakSelect label="Status" value={t.filterStatus}
            options={STATUS_FILTERS.map(f => ({ value: f.k, label: f.l }))}
            onChange={v => setTweak("filterStatus", v)} />
          <TweakSelect label="Role" value={t.filterRole}
            options={[{ value: "all", label: "All roles" }, ...PF_ROLES.map(r => ({ value: r.id, label: r.name }))]}
            onChange={v => setTweak("filterRole", v)} />
        </TweakSection>
      </TweaksPanel>
    </div>
  );
};

window.PFHeader = PFHeader; // exposed for other PF pages that share the file via include order is not used, but just for safety in inspection
ReactDOM.createRoot(document.getElementById("root")).render(<App />);
