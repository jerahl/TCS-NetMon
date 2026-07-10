// NAC Policies — authentication sources, connection profiles, role/VLAN map, rules.

const NACHeader = () => (
  <div className="page-header" style={{ alignItems: "center" }}>
    <div style={{ flex: 1 }}>
      <div className="host-title">
        <h1>NAC Policies</h1>
        <span className="role-tag" style={{ fontSize: 10, padding: "1px 8px", background: "rgba(245,179,0,0.10)", color: "var(--pf)", border: "1px solid rgba(245,179,0,0.4)" }}>
          IDENTITY · PACKETFENCE
        </span>
        <span className="role-tag faculty" style={{ fontSize: 10, padding: "1px 8px" }}>ADMIN · TIER-2</span>
      </div>
      <div className="host-meta">
        <span className="pill"><span className="dot" style={{ background: "var(--ok)" }} /> All policies in sync</span>
        <span className="pill"><span className="lbl">Profiles</span> <span className="v">{PF_PROFILES.length}</span></span>
        <span className="pill"><span className="lbl">Auth sources</span> <span className="v">{PF_AUTH_SOURCES.length}</span></span>
        <span className="pill"><span className="lbl">Roles</span> <span className="v">{PF_ROLES.length}</span></span>
        <span className="pill"><span className="lbl">Last change</span> <span className="v">Apr 12 · 09:14</span></span>
      </div>
    </div>
    <div style={{ display: "flex", gap: 8 }}>
      <button className="btn">Test policy</button>
      <button className="btn primary">New profile</button>
    </div>
  </div>
);

// KPIs
const PolicyKPIs = () => {
  const cells = [
    { lbl: "Connection profiles", v: 18, note: "8 wireless · 10 wired",    cls: ""    },
    { lbl: "Auth sources",        v: 6,  note: "AD · SAML · RADIUS · Local", cls: ""  },
    { lbl: "Network roles",       v: 9,  note: "→ VLANs 110 – 666",         cls: "pf" },
    { lbl: "Enforcement points",  v: 312,note: "switches + APs polled",     cls: ""   },
    { lbl: "Rules evaluated 24h", v: "52.8k", note: "44.1k accept · 8.7k step-up", cls: "ok" },
    { lbl: "Reject rate 24h",     v: "1.0%", note: "527 access-reject",     cls: "warn" },
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

// Authentication sources card
const AuthSources = () => (
  <div className="card">
    <div className="card-h">
      <h3>Authentication Sources</h3>
      <SourceBadge src="pf" />
      <div className="h-spacer" />
      <a className="h-link">Edit chain <Icon name="external" size={11} /></a>
    </div>
    <div className="card-b tight">
      {PF_AUTH_SOURCES.map(s => (
        <div className="pf-source" key={s.id}>
          <div className="pf-source-ico">{s.short}</div>
          <div style={{ minWidth: 0 }}>
            <div className="pf-source-name">{s.name}</div>
            <div className="pf-source-sub">{s.type} · {s.host} — {s.note}</div>
          </div>
          <div className="pf-source-c">
            {s.daily.toLocaleString()}
            <span className="u">auth / 24h</span>
          </div>
          {s.status === "ok"
            ? <span className="reg-pill registered"><span className="dot" style={{ background: "currentColor" }} />OK</span>
            : <span className="reg-pill isolated" style={{ color: "var(--warn)", borderColor: "rgba(245,179,0,0.45)", background: "rgba(245,179,0,0.10)" }}><span className="dot" style={{ background: "currentColor" }} />warn</span>}
        </div>
      ))}
    </div>
  </div>
);

// Role / VLAN map
const ROLE_COLOR = {
  faculty:    "#8eb0ff",
  student:    "#b6a3ff",
  byod:       "#6ee0b3",
  guest:      "#ffd25e",
  av:         "#87c4e2",
  voip:       "#f1a87f",
  camera:     "#87c4e2",
  iot:        "#7c5cff",
  isolation:  "#ff8a87",
};
const RoleVlanMap = () => (
  <div className="card">
    <div className="card-h">
      <h3>Roles → VLAN Mapping</h3>
      <SourceBadge src="pf" />
      <div className="h-spacer" />
      <span className="h-meta">9 roles · 9 VLANs</span>
    </div>
    <div className="card-b tight">
      {PF_ROLES.map(r => (
        <div className="pf-role-row" key={r.id}>
          <div className="pf-role-sw" style={{ background: ROLE_COLOR[r.id] || "var(--pf)" }}>{r.vlan}</div>
          <div className="pf-role-h">
            <span className="pf-role-name">{r.name}</span>
            <span className="pf-role-sub">role: {r.id} · {r.count.toLocaleString()} endpoints</span>
          </div>
          <div className="pf-role-kv"><div className="pf-role-k">VLAN</div><div className="pf-role-v">{r.vlan}</div></div>
          <div className="pf-role-kv"><div className="pf-role-k">ACL</div><div className="pf-role-v">{r.acl}</div></div>
          <div className="pf-role-kv"><div className="pf-role-k">Bandwidth</div><div className="pf-role-v">{r.bw}</div></div>
          <Icon name="chevron" size={14} />
        </div>
      ))}
    </div>
  </div>
);

// Connection profiles table
const Profiles = () => (
  <div className="card">
    <div className="card-h">
      <h3>Connection Profiles</h3>
      <SourceBadge src="pf" />
      <div className="h-spacer" />
      <a className="h-link">All profiles <Icon name="external" size={11} /></a>
    </div>
    <table className="tbl">
      <thead>
        <tr>
          <th>Profile</th>
          <th style={{ width: 130 }}>SSID / medium</th>
          <th>Auth source chain</th>
          <th>Resulting role(s)</th>
          <th style={{ width: 100, textAlign: "right" }}>24h auths</th>
          <th style={{ width: 32 }}></th>
        </tr>
      </thead>
      <tbody>
        {PF_PROFILES.map(p => (
          <tr key={p.id}>
            <td className="fg" style={{ fontWeight: 600, fontFamily: "var(--sans)", fontSize: 12 }}>{p.name}</td>
            <td>{p.ssids === "—" ? <span className="muted">wired</span> : p.ssids}</td>
            <td>{p.sources}</td>
            <td>{p.roles}</td>
            <td style={{ textAlign: "right" }} className="fg">{p.auths.toLocaleString()}</td>
            <td><Icon name="chevron" size={14} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

// Enforcement rules (small condition-tree-ish list)
const RULES = [
  { id: "R-01", when: "source = AD-TCS AND group ∋ Staff",                       then: "role → faculty · VLAN 110",  hits: "8,210 / 24h", sev: "ok"    },
  { id: "R-02", when: "source = AD-Student AND OU = Students",                   then: "role → student · VLAN 120",  hits: "31,420 / 24h", sev: "ok"    },
  { id: "R-03", when: "source = Google AND domain = tcs.k12 AND device-class = BYOD", then: "role → byod · VLAN 122 · BW 10Mb", hits: "1,408 / 24h", sev: "ok" },
  { id: "R-04", when: "source = Guest portal · sponsor approved",                 then: "role → guest · VLAN 199 · BW 5Mb · 24h cap", hits: "712 / 24h",  sev: "ok" },
  { id: "R-05", when: "OUI ∋ Yealink AND CDP-port-vlan = voice",                  then: "role → voip · VLAN 140",     hits: "204 / 24h",   sev: "ok" },
  { id: "R-06", when: "OUI ∋ Axis/Hikvision AND switch.group = NVR-uplink",       then: "role → camera · VLAN 150",   hits: "1,147 / 24h", sev: "ok" },
  { id: "R-07", when: "Fingerbank.os ∈ {Win 10 ≤ 1909, Server 2008}",             then: "isolate → VLAN 666 · violation 1100001", hits: "2 / 24h", sev: "err" },
  { id: "R-08", when: "RADIUS-Reject count ≥ 10 / 60s per MAC",                    then: "rate-limit · alert tier-1", hits: "4 / 24h",    sev: "warn" },
  { id: "R-09", when: "Cortex XDR · endpoint-agent = missing AND role = faculty", then: "step-up → captive remediation", hits: "14 / 24h", sev: "warn" },
];
const RulesTable = () => (
  <div className="card">
    <div className="card-h">
      <h3>Enforcement Rules</h3>
      <SourceBadge src="pf" />
      <SourceBadge src="xdr" />
      <div className="h-spacer" />
      <span className="h-meta">{RULES.length} rules · evaluated top-down</span>
      <a className="h-link">Rule editor <Icon name="external" size={11} /></a>
    </div>
    <table className="tbl">
      <thead>
        <tr>
          <th style={{ width: 50 }}>#</th>
          <th>WHEN</th>
          <th>THEN</th>
          <th style={{ width: 120, textAlign: "right" }}>Hits</th>
          <th style={{ width: 60 }}>Sev</th>
        </tr>
      </thead>
      <tbody>
        {RULES.map(r => (
          <tr key={r.id}>
            <td className="mono">{r.id}</td>
            <td className="fg">{r.when}</td>
            <td>{r.then}</td>
            <td style={{ textAlign: "right" }} className="fg">{r.hits}</td>
            <td>
              {r.sev === "ok"   && <Sev level="info" />}
              {r.sev === "warn" && <Sev level="warning" />}
              {r.sev === "err"  && <Sev level="high" />}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

// ───────── App ─────────
const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "density": "balanced",
  "showSourceBadges": true
}/*EDITMODE-END*/;

const App = () => {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  React.useEffect(() => {
    document.documentElement.classList.toggle("hide-src-badges", !t.showSourceBadges);
  }, [t.showSourceBadges]);

  return (
    <div className="app" data-density={t.density} data-pf="1" data-screen-label="NAC Policies">
      <GlobalSidebar active="nac" />
      <div className="main">
        <GlobalTopbar crumb={["Tuscaloosa City Schools", "Identity", "NAC Policies"]} />
        <NACHeader />
        <div className="body">
          <DemoBanner name="NAC Policies" />
          <PolicyKPIs />

          <div className="row" style={{ gridTemplateColumns: "1fr 1fr", marginBottom: 14 }}>
            <AuthSources />
            <RoleVlanMap />
          </div>

          <div style={{ marginBottom: 14 }}>
            <Profiles />
          </div>

          <RulesTable />
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
      </TweaksPanel>
    </div>
  );
};

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
