// Quarantine — currently isolated endpoints, active violations, remediation queue.

const QuarantineHeader = () => (
  <div className="page-header" style={{ alignItems: "center" }}>
    <div style={{ flex: 1 }}>
      <div className="host-title">
        <h1>Quarantine</h1>
        <span className="role-tag" style={{ fontSize: 10, padding: "1px 8px", background: "rgba(245,179,0,0.10)", color: "var(--pf)", border: "1px solid rgba(245,179,0,0.4)" }}>
          IDENTITY · PACKETFENCE
        </span>
        <span className="role-tag quarantine" style={{ fontSize: 10, padding: "1px 8px" }}>ISOLATION · VLAN 666</span>
      </div>
      <div className="host-meta">
        <span className="pill"><span className="dot" style={{ background: "var(--err)" }} /> 2 endpoints isolated</span>
        <span className="pill"><span className="lbl">Violations 24h</span> <span className="v">98</span></span>
        <span className="pill"><span className="lbl">Self-remediated</span> <span className="v">47</span></span>
        <span className="pill"><span className="lbl">Open tickets</span> <span className="v">2</span></span>
        <span className="pill"><span className="lbl">Last isolate</span> <span className="v">10:38</span></span>
      </div>
    </div>
    <div style={{ display: "flex", gap: 8 }}>
      <button className="btn">Bulk · re-evaluate</button>
      <button className="btn primary">Release selected</button>
    </div>
  </div>
);

// KPI strip
const QuarKPIs = () => {
  const cells = [
    { lbl: "Currently isolated",  v: 2,  note: "VLAN 666 · captive page",     cls: "err"  },
    { lbl: "New violations 24h",  v: 98, note: "44 unique endpoints",         cls: "warn" },
    { lbl: "Self-remediated",     v: 47, note: "via captive portal",          cls: "ok"   },
    { lbl: "Manual release",      v: 6,  note: "admin action · last 24h",     cls: ""     },
    { lbl: "Avg time-to-clear",   v: "27m", note: "from isolation → clear",   cls: ""     },
    { lbl: "Open tickets",        v: 2,  note: "TKT-9302 · TKT-9311",         cls: "warn" },
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

// Isolated endpoints — focal card
const ISOLATED = [
  {
    mac: "d4:6e:0e:33:b8:7c", host: "Win10-LegacyLab-04", owner: "—",
    site: "NHS", loc: "NHS-SW-Lab-A · port 11", vlan: 666, since: "10:38:21 (today)",
    violation: { id: 1100001, name: "EOL operating system", sev: "err" },
    detail: "Endpoint reports Windows 10 build 1909 (EOS Aug-2021). Auto-isolation applied via Fingerbank rule R-07. Captive remediation page presents reimage instructions.",
    actions: ["Release (one-time)", "Whitelist for 24h", "Open ticket"],
    history: [
      { ts: "10:38:21", ev: "Auto-isolated · rule R-07" },
      { ts: "10:38:09", ev: "Fingerbank OS = Win10·1909" },
      { ts: "10:37:55", ev: "EAP-TLS accept · pre-isolation" },
    ],
  },
  {
    mac: "fc:fb:fb:11:90:0a", host: "WIN-EOL-2008", owner: "—",
    site: "NHS", loc: "NHS-SW-3F-08 · port 14", vlan: 666, since: "Yesterday · 14:22",
    violation: { id: 1100002, name: "EOL server", sev: "err" },
    detail: "Server 2008 R2 discovered on student VLAN during port-scan correlation. Ticket TKT-9302 open with Facilities — pending physical decommissioning.",
    actions: ["Snooze (notify in 24h)", "Open ticket", "Force re-auth"],
    history: [
      { ts: "Y · 14:22", ev: "Auto-isolated · rule R-07" },
      { ts: "Y · 14:21", ev: "OS fingerprint via DHCP" },
      { ts: "Y · 14:20", ev: "MAB · port-up" },
    ],
  },
];
const IsolatedCard = ({ d }) => (
  <div className="card">
    <div className="card-h" style={{ background: "rgba(242,95,92,0.06)" }}>
      <Icon name="lock" />
      <h3 style={{ color: "var(--err)" }}>{d.host}</h3>
      <span className="mono" style={{ fontSize: 11, color: "var(--muted)" }}>{d.mac}</span>
      <div className="h-spacer" />
      <span className="reg-pill isolated"><span className="dot" style={{ background: "currentColor" }} />isolated</span>
      <SourceBadge src="pf" />
    </div>
    <div className="card-b" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
      <div className="kv" style={{ gridTemplateColumns: "120px 1fr", borderRight: "1px solid var(--line)", marginRight: -14, paddingRight: 0 }}>
        <div className="k">Site</div>
        <div className="v">{d.site}</div>
        <div className="k">Location</div>
        <div className="v">{d.loc}</div>
        <div className="k">VLAN</div>
        <div className="v">{d.vlan} · ACL-QUARANTINE</div>
        <div className="k">Isolated since</div>
        <div className="v">{d.since}</div>
        <div className="k">Violation</div>
        <div className="v">
          <span className="mono" style={{ color: "var(--err)" }}>#{d.violation.id}</span> · {d.violation.name}
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ fontSize: 11.5, color: "var(--fg-2)", lineHeight: 1.5, borderLeft: "2px solid var(--err)", paddingLeft: 10 }}>
          {d.detail}
        </div>
        <div>
          <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 0.6, color: "var(--muted)", marginBottom: 6 }}>Recent activity</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {d.history.map((h, i) => (
              <div key={i} style={{ display: "flex", gap: 10, fontSize: 11 }}>
                <span className="mono" style={{ color: "var(--muted)", width: 80 }}>{h.ts}</span>
                <span style={{ color: "var(--fg-2)" }}>{h.ev}</span>
              </div>
            ))}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {d.actions.map(a => <button key={a} className="btn sm">{a}</button>)}
          <button className="btn sm primary">Release</button>
        </div>
      </div>
    </div>
  </div>
);

// Violation catalog
const ViolationCatalog = () => (
  <div className="card">
    <div className="card-h">
      <h3>Active Violations</h3>
      <SourceBadge src="pf" />
      <SourceBadge src="xdr" />
      <div className="h-spacer" />
      <span className="h-meta">{PF_VIOLATIONS.length} configured · sorted by 24h hit-count</span>
      <a className="h-link">Catalog <Icon name="external" size={11} /></a>
    </div>
    <div className="card-b tight">
      {[...PF_VIOLATIONS].sort((a, b) => b.count - a.count).map(v => (
        <div className="pf-violation" key={v.id}>
          <div className={"pf-violation-rail " + (v.sev === "err" ? "err" : v.sev === "warn" ? "warn" : "info")} />
          <div>
            <div className="pf-violation-h">
              <span className="pf-violation-name">{v.name}</span>
              <span className="pf-violation-id">#{v.id}</span>
              {v.sev === "err"   && <Sev level="high" />}
              {v.sev === "warn"  && <Sev level="warning" />}
              {v.sev === "info"  && <Sev level="info" />}
            </div>
            <div className="pf-violation-body">{v.body}</div>
            <div className="pf-violation-meta">
              <span>↳ Trigger · {v.trigger}</span>
              <span>↳ Remediation · {v.remediation}</span>
            </div>
          </div>
          <div className="pf-violation-count">
            {v.count}
            <span className="u">hits 24h</span>
          </div>
        </div>
      ))}
    </div>
  </div>
);

// Remediation queue — small list of items in-flight
const REMEDIATION = [
  { mac: "d8:80:39:c4:0a:7b", user: "k.harris",  why: "BYOD cert expiring · 3d left",  state: "User notified · email + portal",   age: "1h" },
  { mac: "70:5a:0f:32:c2:e8", user: "subteacher.51", why: "Cortex XDR agent missing", state: "Step-up captive presented",         age: "20m" },
  { mac: "ec:b1:d7:6a:5f:09", user: "—",        why: "Switch firmware compliance",     state: "Auto-deferred · maintenance window", age: "3h" },
  { mac: "9c:b6:54:af:78:e1", user: "—",        why: "Captive portal abandoned",       state: "Awaiting AUP accept · 4h left",    age: "42m" },
  { mac: "00:1b:21:5e:00:9a", user: "—",        why: "EOL OS (Win10·1909)",            state: "Pending reimage · TKT-9311",        age: "5h" },
];
const Remediation = () => (
  <div className="card">
    <div className="card-h">
      <h3>Remediation Queue</h3>
      <SourceBadge src="pf" />
      <div className="h-spacer" />
      <span className="h-meta">5 in-flight · clearing automatically</span>
    </div>
    <table className="tbl">
      <thead>
        <tr>
          <th style={{ width: 130 }}>MAC</th>
          <th>User</th>
          <th>Reason</th>
          <th>State</th>
          <th style={{ width: 60, textAlign: "right" }}>Age</th>
          <th style={{ width: 30 }}></th>
        </tr>
      </thead>
      <tbody>
        {REMEDIATION.map((r, i) => (
          <tr key={i}>
            <td className="fg">{r.mac}</td>
            <td className="fg">{r.user}</td>
            <td>{r.why}</td>
            <td>{r.state}</td>
            <td style={{ textAlign: "right" }} className="mono">{r.age}</td>
            <td><Icon name="chevron" size={14} /></td>
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
    <div className="app" data-density={t.density} data-pf="1" data-screen-label="Quarantine">
      <GlobalSidebar active="quar" />
      <div className="main">
        <GlobalTopbar crumb={["Tuscaloosa City Schools", "Identity", "Quarantine"]} />
        <QuarantineHeader />
        <div className="body">
          <DemoBanner name="Quarantine" />
          <QuarKPIs />

          <div style={{ marginBottom: 14, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            {ISOLATED.map(d => <IsolatedCard key={d.mac} d={d} />)}
          </div>

          <div className="row" style={{ gridTemplateColumns: "1.4fr 1fr", marginBottom: 14 }}>
            <ViolationCatalog />
            <Remediation />
          </div>
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
        <TweakSection title="Quick actions">
          <TweakButton onClick={() => alert("This would release both isolated endpoints back to their previous role.")}>Release all isolated</TweakButton>
          <TweakButton onClick={() => alert("This would force a re-evaluation of all open violations.")}>Re-evaluate violations</TweakButton>
        </TweakSection>
      </TweaksPanel>
    </div>
  );
};

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
