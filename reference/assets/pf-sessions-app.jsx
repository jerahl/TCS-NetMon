// User Sessions — live 802.1X / portal sessions with auth method, NAS, duration.

const SessionsHeader = () => (
  <div className="page-header" style={{ alignItems: "center" }}>
    <div style={{ flex: 1 }}>
      <div className="host-title">
        <h1>User Sessions</h1>
        <span className="role-tag" style={{ fontSize: 10, padding: "1px 8px", background: "rgba(245,179,0,0.10)", color: "var(--pf)", border: "1px solid rgba(245,179,0,0.4)" }}>
          IDENTITY · PACKETFENCE
        </span>
        <span className="role-tag faculty" style={{ fontSize: 10, padding: "1px 8px" }}>LIVE · 5s POLL</span>
      </div>
      <div className="host-meta">
        <span className="pill"><span className="dot" style={{ background: "var(--ok)" }} /> 12,847 active sessions</span>
        <span className="pill"><span className="lbl">Accept rate 1h</span> <span className="v">98.9%</span></span>
        <span className="pill"><span className="lbl">Reject 1h</span> <span className="v">142</span></span>
        <span className="pill"><span className="lbl">Avg auth</span> <span className="v">4.2 ms</span></span>
        <span className="pill"><span className="lbl">RADIUS req/s</span> <span className="v">418</span></span>
      </div>
    </div>
    <div className="timerange">
      <Icon name="refresh" />
      <span className="range-val">Live · 5s</span>
      <Icon name="chevron" />
    </div>
  </div>
);

// KPI strip
const SessionsKPIs = () => {
  const cells = [
    { lbl: "Active sessions",   v: "12,847",       note: "across 26 sites",       cls: "" },
    { lbl: "802.1X · EAP-TLS",  v: "8,222",        note: "64.0% · cert auth",     cls: "pf" },
    { lbl: "802.1X · PEAP",     v: "2,698",        note: "21.0% · AD password",   cls: "" },
    { lbl: "MAB",               v: "1,413",        note: "11.0% · OUI / device-class", cls: "" },
    { lbl: "Captive portal",    v: 385,            note: "3.0% · self-reg",       cls: "" },
    { lbl: "Rejected 1h",       v: 142,            note: "1.0% · investigated 4", cls: "warn" },
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

// Auth method donut
const AuthDonut = () => {
  const m = PF_AUTH_METHODS;
  const total = m.reduce((n, x) => n + x.value, 0);
  return (
    <div className="pf-donut-wrap">
      <svg width="120" height="120" viewBox="0 0 120 120">
        <circle cx="60" cy="60" r="48" stroke="rgba(255,255,255,0.06)" strokeWidth="14" fill="none" />
        {(() => {
          let acc = 0; const C = 2 * Math.PI * 48;
          return m.map((x, i) => {
            const frac = x.value / total;
            const dash = C * frac;
            const off = -C * acc;
            acc += frac;
            return (
              <circle key={x.key} cx="60" cy="60" r="48"
                stroke={x.color} strokeWidth="14" fill="none"
                strokeDasharray={`${dash} ${C}`} strokeDashoffset={off}
                transform="rotate(-90 60 60)" />
            );
          });
        })()}
        <text x="60" y="56" textAnchor="middle" fill="var(--fg)" fontFamily="var(--mono)" fontSize="18" fontWeight="600">418</text>
        <text x="60" y="73" textAnchor="middle" fill="var(--muted)" fontSize="9" letterSpacing="0.5">REQ/SEC</text>
      </svg>
      <div className="pf-donut-legend">
        {m.map(x => (
          <div className="pf-leg-row" key={x.key}>
            <span className="pf-leg-sw" style={{ background: x.color }} />
            <span className="pf-leg-lbl">{x.label}</span>
            <span className="pf-leg-pct">{x.value}%</span>
          </div>
        ))}
      </div>
    </div>
  );
};

// Per-SSID sessions split
const SSID_SPLIT = [
  { name: "tcs-secure", count: 8210, color: "var(--pf)" },
  { name: "tcs-byod",   count: 1408, color: "#6ee0b3"   },
  { name: "tcs-guest",  count: 712,  color: "#ffd25e"   },
  { name: "eduroam",    count: 42,   color: "var(--ext)" },
  { name: "wired",      count: 2475, color: "var(--info)" },
];
const SsidSplit = () => {
  const total = SSID_SPLIT.reduce((n, s) => n + s.count, 0);
  return (
    <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", height: 18, borderRadius: 4, overflow: "hidden", border: "1px solid var(--line)" }}>
        {SSID_SPLIT.map(s => (
          <div key={s.name} style={{ width: `${s.count / total * 100}%`, background: s.color }} title={`${s.name}: ${s.count}`} />
        ))}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {SSID_SPLIT.map(s => (
          <div key={s.name} className="pf-leg-row">
            <span className="pf-leg-sw" style={{ background: s.color }} />
            <span className="pf-leg-lbl" style={{ fontFamily: "var(--mono)", fontSize: 11.5 }}>{s.name}</span>
            <span className="pf-leg-v">{s.count.toLocaleString()}</span>
            <span className="pf-leg-pct">{(s.count / total * 100).toFixed(1)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
};

// Format duration sec → "Hh Mm"
const formatDur = (sec) => {
  if (sec >= 99000) return "≥ 5d";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
};

// Sessions table
const SessionsTable = ({ filterMethod, setFilterMethod }) => {
  const rows = PF_SESSIONS.filter(s => {
    if (filterMethod === "all") return true;
    if (filterMethod === "tls")    return s.method.includes("EAP-TLS");
    if (filterMethod === "peap")   return s.method.includes("PEAP");
    if (filterMethod === "mab")    return s.method.startsWith("MAB");
    if (filterMethod === "portal") return s.method.includes("Portal");
    return true;
  });
  return (
    <div className="card">
      <div className="card-h">
        <h3>Live Sessions</h3>
        <SourceBadge src="pf" />
        <div className="h-spacer" />
        <span className="h-meta">{rows.length} shown · sorted by start time</span>
        <a className="h-link">Disconnect selected <Icon name="external" size={11} /></a>
      </div>
      <div className="pf-filterbar">
        {[
          { k: "all",    l: "All methods",  c: 12847 },
          { k: "tls",    l: "EAP-TLS",      c: 8222  },
          { k: "peap",   l: "PEAP",         c: 2698  },
          { k: "mab",    l: "MAB",          c: 1413  },
          { k: "portal", l: "Portal",       c: 385   },
        ].map(f => (
          <button key={f.k}
            className={"pf-chip" + (filterMethod === f.k ? " active" : "")}
            onClick={() => setFilterMethod(f.k)}>
            {f.l} <span className="pf-chip-c">{f.c.toLocaleString()}</span>
          </button>
        ))}
        <span className="pf-filter-spacer" />
        <div className="pf-search-mini">
          <Icon name="search" size={12} />
          <input placeholder="Find user, MAC, NAS…" readOnly />
        </div>
      </div>
      <div style={{ maxHeight: 540, overflowY: "auto" }}>
        <table className="tbl">
          <thead>
            <tr>
              <th>User</th>
              <th style={{ width: 110 }}>Role</th>
              <th style={{ width: 130 }}>MAC</th>
              <th style={{ width: 170 }}>Auth method</th>
              <th>NAS · port / AP</th>
              <th style={{ width: 110 }}>SSID</th>
              <th style={{ width: 60, textAlign: "center" }}>VLAN</th>
              <th style={{ width: 95 }}>Started</th>
              <th style={{ width: 150 }}>Duration</th>
              <th style={{ width: 110 }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s, i) => {
              const pct = Math.min(100, (s.dur / 14400) * 100); // session age bar (4h scale)
              return (
                <tr key={i}>
                  <td className="fg">{s.user}</td>
                  <td><span className={"role-tag " + s.role}>{s.role}</span></td>
                  <td>{s.mac}</td>
                  <td>{s.method}</td>
                  <td>{s.nas}</td>
                  <td>{s.ssid}</td>
                  <td style={{ textAlign: "center" }}>{s.vlan}</td>
                  <td className="mono">{s.started}</td>
                  <td>
                    <span className="dur-bar"><div style={{ width: `${pct}%` }} /></span>
                    {formatDur(s.dur)}
                  </td>
                  <td>
                    <span className={"reg-pill " + (s.status === "isolated" ? "isolated" : s.status === "registering" ? "pending" : "registered")}>
                      <span className="dot" style={{ background: "currentColor" }} />{s.status}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};

// Recent rejects (small list)
const RECENT_REJECTS = [
  { ts: "10:51:22", user: "—",         mac: "ec:0c:9a:11:42:8a", nas: "BHS-SW-2F-08:14", reason: "Invalid cert (untrusted CA)",          sev: "warn" },
  { ts: "10:51:09", user: "—",         mac: "9c:b6:54:af:78:e1", nas: "NHS-AP-Cafe-South", reason: "Unknown MAB · no matching OUI",      sev: "info" },
  { ts: "10:50:44", user: "j.smith",   mac: "70:5a:0f:32:c2:e8", nas: "CHS-AP-3F-East",  reason: "AD: account disabled",                 sev: "warn" },
  { ts: "10:50:31", user: "—",         mac: "00:1b:21:5e:00:9a", nas: "BHS-SW-1F-04:22", reason: "Fingerbank: EOL OS · violation 1100001", sev: "err"  },
  { ts: "10:50:18", user: "k.harris",  mac: "d8:80:39:c4:0a:7b", nas: "BHS-AP-2F-South", reason: "BYOD cert expired (re-onboard)",        sev: "warn" },
  { ts: "10:49:58", user: "guest.78",  mac: "f0:99:b6:11:0a:c4", nas: "NHS-AP-Lobby",    reason: "Sponsor approval expired",              sev: "info" },
  { ts: "10:49:14", user: "—",         mac: "00:1d:c1:99:08:00", nas: "OPS-SW-Core:48",  reason: "MAC spoof — already on different NAS",  sev: "err"  },
];
const RecentRejects = () => (
  <div className="card">
    <div className="card-h">
      <h3>Recent Rejects</h3>
      <SourceBadge src="pf" />
      <div className="h-spacer" />
      <span className="h-meta">last 5 min · 142 total / 1h</span>
    </div>
    <div className="events">
      {RECENT_REJECTS.map((r, i) => (
        <div className="event" key={i} style={{ gridTemplateColumns: "70px 130px 1fr 90px" }}>
          <div className="ts">{r.ts}</div>
          <div className="mono" style={{ fontSize: 11, color: "var(--fg-2)" }}>{r.mac}</div>
          <div className="msg">
            <span style={{ color: r.sev === "err" ? "var(--err)" : r.sev === "warn" ? "var(--warn)" : "var(--info)", fontWeight: 500 }}>{r.reason}</span>{" "}
            <span style={{ color: "var(--fg)" }}>· {r.user || "—"} · {r.nas}</span>
          </div>
          <div><Sev level={r.sev === "err" ? "high" : r.sev === "warn" ? "warning" : "info"} /></div>
        </div>
      ))}
    </div>
  </div>
);

// ───────── App ─────────
const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "density": "balanced",
  "showSourceBadges": true,
  "filterMethod": "all"
}/*EDITMODE-END*/;

const App = () => {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  React.useEffect(() => {
    document.documentElement.classList.toggle("hide-src-badges", !t.showSourceBadges);
  }, [t.showSourceBadges]);

  return (
    <div className="app" data-density={t.density} data-pf="1" data-screen-label="User Sessions">
      <GlobalSidebar active="sessions" />
      <div className="main">
        <GlobalTopbar crumb={["Tuscaloosa City Schools", "Identity", "User Sessions"]} search="Find user, MAC, NAS…" />
        <SessionsHeader />
        <div className="body">
          <DemoBanner name="User Sessions" />
          <SessionsKPIs />

          <div className="row" style={{ gridTemplateColumns: "1fr 1fr", marginBottom: 14 }}>
            <div className="card">
              <div className="card-h">
                <h3>Auth Methods</h3>
                <SourceBadge src="pf" />
                <div className="h-spacer" />
                <span className="h-meta">RADIUS req/sec</span>
              </div>
              <AuthDonut />
            </div>
            <div className="card">
              <div className="card-h">
                <h3>Sessions by SSID / wired</h3>
                <SourceBadge src="pf" />
                <SourceBadge src="ext" />
                <div className="h-spacer" />
                <span className="h-meta">{SSID_SPLIT.reduce((n,s)=>n+s.count,0).toLocaleString()} total</span>
              </div>
              <SsidSplit />
            </div>
          </div>

          <div style={{ marginBottom: 14 }}>
            <SessionsTable filterMethod={t.filterMethod} setFilterMethod={v => setTweak("filterMethod", v)} />
          </div>

          <RecentRejects />
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
        <TweakSection title="Filter">
          <TweakSelect label="Auth method" value={t.filterMethod} options={[
            { value: "all",    label: "All" },
            { value: "tls",    label: "EAP-TLS" },
            { value: "peap",   label: "PEAP" },
            { value: "mab",    label: "MAB" },
            { value: "portal", label: "Captive portal" },
          ]} onChange={v => setTweak("filterMethod", v)} />
        </TweakSection>
      </TweaksPanel>
    </div>
  );
};

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
