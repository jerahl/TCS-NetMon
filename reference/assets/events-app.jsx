// Events Console — central triage page for events flowing in from Zabbix.
// Ported from the Claude Design prototype and wired to live data published
// by events-bridge.jsx → window.EV_EVENTS / EV_TIMELINE / EV_SITES /
// EV_HOSTGROUPS / EV_TAGS / EV_SAVED_VIEWS / EV_METRICS.
//
// Layout (top → bottom):
//   1. Header w/ live indicator + meta pills (sources, in-window, MTTA/MTTR)
//   2. KPI tile strip (6 tiles, clickable filters)
//   3. 24h stacked-severity histogram
//   4. Filter bar (search · range · sev · status · source · site · group · tags)
//   5. Active filter chip rail
//   6. Events table (sortable, multi-select, bulk actions, group-by)
//   7. Slide-out detail drawer

// Zabbix Event.acknowledge action bitmask.
const ACT_CLOSE = 1, ACT_ACK = 2, ACT_MSG = 4, ACT_SEV = 8, ACT_UNACK = 16, ACT_SUPPRESS = 32, ACT_UNSUPPRESS = 64;

// host.view's filter form rewrites the URL on first render and drops
// `filter_hostids`, so the deep-link never sticks. host.dashboard.view
// takes a plain `hostid` query param and lands on the per-host dashboard.
const hostUrl = (hostid) => {
  if (!hostid) return null;
  const base = window.TCS_HOST_VIEW_URL || "zabbix.php?action=host.dashboard.view";
  return `${base}&hostid=${encodeURIComponent(hostid)}`;
};

const callUpdate = async (eventids, opts) => {
  if (typeof window.tcsEventsUpdate !== "function") {
    alert("Update endpoint unavailable.");
    return false;
  }
  const res = await window.tcsEventsUpdate(eventids, opts);
  if (!res || !res.ok) {
    alert("Update failed: " + ((res && res.error) || "unknown error"));
    return false;
  }
  return true;
};

const SEV_ORDER = { disaster: 5, high: 4, warning: 3, info: 2, ok: 1 };
const SEV_LABEL = { disaster: "Disaster", high: "High", warning: "Warning", info: "Info", ok: "Resolved" };
const STATUS_LABEL = { open: "Open", ack: "Acknowledged", resolved: "Resolved", suppressed: "Suppressed" };
const SOURCE_LABEL = { zbx: "Zabbix", pf: "PacketFence", ext: "ExtremeCloud" };

// ───────── KPI tiles ─────────
const TILES = [
  { id: "all",      label: "All Events",   sevClass: "",             help: "current window" },
  { id: "disaster", label: "Disaster",     sevClass: "sev-disaster", help: "active" },
  { id: "high",     label: "High",         sevClass: "sev-high",     help: "active" },
  { id: "warn",     label: "Warning",      sevClass: "sev-warn",     help: "active" },
  { id: "open",     label: "Open · unack", sevClass: "",             help: "needs triage" },
  { id: "ack",      label: "Acknowledged", sevClass: "",             help: "in progress" }
];

const KPIStrip = ({ events, activeTile, setActiveTile, range }) => {
  const total = events.length;
  const disaster = events.filter(e => e.rawSev === "disaster" && e.status !== "resolved").length;
  const high     = events.filter(e => e.rawSev === "high"     && e.status !== "resolved").length;
  const warn     = events.filter(e => e.rawSev === "warning"  && e.status !== "resolved").length;
  const openUn   = events.filter(e => e.status === "open").length;
  const ack      = events.filter(e => e.status === "ack").length;
  const vals = { all: total, disaster, high, warn, open: openUn, ack };
  const sub = {
    all:      ["", range || "Last 24h", "flat"],
    disaster: ["sev", "active", "flat"],
    high:     ["sev", "active", "flat"],
    warn:     ["sev", "active", "flat"],
    open:     ["needs", "triage", "flat"],
    ack:      ["in", "progress", "flat"]
  };
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="evt-tiles">
        {TILES.map(t => {
          const [d1, d2, dCls] = sub[t.id];
          return (
            <div
              key={t.id}
              className={"evt-tile " + t.sevClass + (activeTile === t.id ? " active" : "")}
              onClick={() => setActiveTile(activeTile === t.id ? null : t.id)}
            >
              <div className="t-lbl">
                {t.label}
                {t.id !== "all" && <SourceBadge src="zbx" />}
              </div>
              <div className="t-v">{vals[t.id]}</div>
              <div className="t-foot">
                {d1 && <span className={"t-delta " + dCls}>{d1}</span>}
                <span>{d2}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

// ───────── 24h Histogram (stacked severity) ─────────
const Histogram = ({ timeline, range }) => {
  const data = (timeline && timeline.length === 24) ? timeline : new Array(24).fill(null).map(() => [0,0,0,0]);
  const totals = data.map(c => c.reduce((a, b) => a + b, 0));
  const max = Math.max(1, ...totals);
  const sumBySev = data.reduce((acc, [d, h, w, i]) => {
    acc.disaster += d; acc.high += h; acc.warning += w; acc.info += i; return acc;
  }, { disaster: 0, high: 0, warning: 0, info: 0 });
  const grand = sumBySev.disaster + sumBySev.high + sumBySev.warning + sumBySev.info;
  const peakIdx = totals.indexOf(Math.max(...totals));
  const quietIdx = totals.indexOf(Math.min(...totals));
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="card-h">
        <h3>Event Volume — {range || "last 24h"}</h3>
        <SourceBadge src="zbx" />
        <div className="h-spacer" />
        <span className="h-meta">{grand} events · {totals[totals.length - 1]} latest bucket</span>
      </div>
      <div className="evt-histo">
        <div className="evt-histo-bars">
          {data.map((col, i) => {
            const [d, h, w, inf] = col;
            const t = d + h + w + inf;
            return (
              <div className="evt-histo-col" key={i} style={{ height: `${(t / max) * 100}%` }}>
                {d   > 0 && <div className="evt-histo-seg disaster" style={{ flex: d }} />}
                {h   > 0 && <div className="evt-histo-seg high"     style={{ flex: h }} />}
                {w   > 0 && <div className="evt-histo-seg warning"  style={{ flex: w }} />}
                {inf > 0 && <div className="evt-histo-seg info"     style={{ flex: inf }} />}
                {i % 4 === 0 && <div className="evt-histo-tick">{i.toString().padStart(2, "0")}</div>}
                <div className="evt-histo-tip">bucket {i.toString().padStart(2, "0")} — {t} events</div>
              </div>
            );
          })}
        </div>
        <div className="evt-histo-side">
          {[
            ["disaster", "Disaster", sumBySev.disaster, "var(--err)"],
            ["high",     "High",     sumBySev.high,     "#ff8a87"],
            ["warning",  "Warning",  sumBySev.warning,  "var(--warn)"],
            ["info",     "Info",     sumBySev.info,     "var(--info)"]
          ].map(([k, l, n, c]) => (
            <div className="h-row" key={k}>
              <span className="h-sw" style={{ background: c }} />
              <span className="h-lbl">{l}</span>
              <span className="h-n">{n}</span>
            </div>
          ))}
          <div style={{ height: 1, background: "var(--line)", margin: "2px 0" }} />
          <div className="h-row">
            <span className="h-lbl muted">Peak bucket</span>
            <span className="h-n">{peakIdx.toString().padStart(2, "0")} · {totals[peakIdx]}</span>
          </div>
          <div className="h-row">
            <span className="h-lbl muted">Quietest</span>
            <span className="h-n">{quietIdx.toString().padStart(2, "0")} · {totals[quietIdx]}</span>
          </div>
        </div>
      </div>
    </div>
  );
};

// ───────── Filter dropdown (multi-select) ─────────
const FilterDrop = ({ label, options, selected, onChange, searchable = false, formatLabel }) => {
  const [open, setOpen] = React.useState(false);
  const [q, setQ] = React.useState("");
  const ref = React.useRef();

  React.useEffect(() => {
    if (!open) return;
    const h = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);

  const filtered = q ? options.filter(o => (o.label || o.value).toLowerCase().includes(q.toLowerCase())) : options;
  const toggle = v => {
    if (selected.includes(v)) onChange(selected.filter(x => x !== v));
    else onChange([...selected, v]);
  };

  return (
    <div className="fb-drop" ref={ref}>
      <button className={"fb-btn" + (selected.length ? " has-value" : "")} onClick={() => setOpen(!open)}>
        <span className="fb-btn-lbl">{label}</span>
        {selected.length === 0
          ? <span>All</span>
          : selected.length === 1
            ? <span>{formatLabel ? formatLabel(selected[0]) : (options.find(o => o.value === selected[0])?.label || selected[0])}</span>
            : <span className="fb-btn-cnt">{selected.length}</span>
        }
        <Icon name="chevron" size={12} />
      </button>
      {open && (
        <div className="fb-menu">
          {searchable && (
            <div className="fb-menu-search">
              <input value={q} onChange={e => setQ(e.target.value)} placeholder="Filter…" autoFocus />
            </div>
          )}
          {filtered.length === 0 && (
            <div className="fb-menu-item" style={{ color: "var(--muted)", cursor: "default" }}>No matches</div>
          )}
          {filtered.map(o => (
            <div
              key={o.value}
              className={"fb-menu-item" + (selected.includes(o.value) ? " checked" : "")}
              onClick={() => toggle(o.value)}
            >
              <span className="fb-check"><Icon name="check" size={10} /></span>
              <span>{o.label}</span>
              {o.count !== undefined && <span className="fb-mi-cnt">{o.count}</span>}
            </div>
          ))}
          {selected.length > 0 && (
            <div className="fb-menu-foot">
              <button className="btn sm ghost" onClick={() => onChange([])}>Clear</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// ───────── Time range dropdown ─────────
const RANGE_LABELS = { "1h": "Last 1h", "6h": "Last 6h", "24h": "Last 24h", "7d": "Last 7d", "open": "All open" };
const TimeRangeDrop = ({ value, onChange }) => {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef();
  React.useEffect(() => {
    if (!open) return;
    const h = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);
  return (
    <div className="fb-drop" ref={ref}>
      <button className="fb-btn has-value" onClick={() => setOpen(!open)}>
        <Icon name="calendar" size={12} />
        <span>{RANGE_LABELS[value] || "Last 24h"}</span>
        <Icon name="chevron" size={12} />
      </button>
      {open && (
        <div className="fb-menu" style={{ minWidth: 180 }}>
          {Object.entries(RANGE_LABELS).map(([k, l]) => (
            <div key={k} className={"fb-menu-item" + (value === k ? " checked" : "")} onClick={() => { onChange(k); setOpen(false); }}>
              <span className="fb-check"><Icon name="check" size={10} /></span>
              {l}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// ───────── Filter bar ─────────
const FilterBar = ({ filters, setFilter, activeView, setActiveView, range, setRange, onRefresh, sev_counts }) => {
  const sevOpts = [
    { value: "disaster", label: "Disaster", count: sev_counts.disaster },
    { value: "high",     label: "High",     count: sev_counts.high },
    { value: "warning",  label: "Warning",  count: sev_counts.warning },
    { value: "info",     label: "Info",     count: sev_counts.info },
    { value: "ok",       label: "Resolved", count: sev_counts.ok }
  ];
  const statusOpts = Object.entries(STATUS_LABEL).map(([v, l]) => ({ value: v, label: l }));
  const sourceOpts = Object.entries(SOURCE_LABEL).map(([v, l]) => ({ value: v, label: l }));
  const siteOpts  = (window.EV_SITES      || []).map(s => ({ value: s, label: s }));
  const groupOpts = (window.EV_HOSTGROUPS || []).map(g => ({ value: g, label: g }));
  const tagOpts   = (window.EV_TAGS       || []).slice(0, 80).map(t => ({ value: t, label: t }));
  const savedViews = window.EV_SAVED_VIEWS || [];

  return (
    <div className="filter-bar">
      <div className="fb-row">
        <div className="fb-search">
          <Icon name="search" />
          <input
            value={filters.search}
            onChange={e => setFilter("search", e.target.value)}
            placeholder='Find: host, trigger, tag — try host:BHS-* or radius'
          />
          <span className="fb-search-help">⌘K</span>
        </div>
        <div className="fb-divider" />
        <TimeRangeDrop value={range} onChange={setRange} />
        <FilterDrop label="Severity"   options={sevOpts}    selected={filters.sev}    onChange={v => setFilter("sev", v)} />
        <FilterDrop label="Status"     options={statusOpts} selected={filters.status} onChange={v => setFilter("status", v)} />
        <FilterDrop label="Source"     options={sourceOpts} selected={filters.source} onChange={v => setFilter("source", v)} />
        <FilterDrop label="Site"       options={siteOpts}   selected={filters.site}   onChange={v => setFilter("site", v)} searchable />
        <FilterDrop label="Host group" options={groupOpts}  selected={filters.group}  onChange={v => setFilter("group", v)} searchable />
        <FilterDrop label="Tags"       options={tagOpts}    selected={filters.tags}   onChange={v => setFilter("tags", v)} searchable />
      </div>

      <div className="fb-row" style={{ paddingTop: 8, paddingBottom: 8 }}>
        <span style={{ fontSize: 10, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.5, marginRight: 4 }}>Saved views</span>
        <div className="fb-views">
          {savedViews.map(v => (
            <button
              key={v.id}
              className={"view-chip" + (activeView === v.id ? " active" : "")}
              onClick={() => setActiveView(activeView === v.id ? null : v.id)}
            >
              {!v.system && <span className="vc-star">★</span>}
              {v.name}
              <span className="vc-cnt">{v.count}</span>
            </button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <button className="btn sm ghost" onClick={onRefresh}><Icon name="refresh" size={11} /> Refresh</button>
      </div>
    </div>
  );
};

// ───────── Active filter chip rail ─────────
const FilterChips = ({ filters, setFilter, clearAll, activeTile, setActiveTile, activeView, setActiveView, range }) => {
  const chips = [];
  if (activeTile) chips.push({ k: "tile", v: TILES.find(t => t.id === activeTile)?.label, clear: () => setActiveTile(null) });
  if (activeView) {
    const v = (window.EV_SAVED_VIEWS || []).find(x => x.id === activeView);
    if (v) chips.push({ k: "view", v: v.name, clear: () => setActiveView(null) });
  }
  filters.sev.forEach(v => chips.push({ k: "sev", v: SEV_LABEL[v] || v, clear: () => setFilter("sev", filters.sev.filter(x => x !== v)) }));
  filters.status.forEach(v => chips.push({ k: "status", v: STATUS_LABEL[v] || v, clear: () => setFilter("status", filters.status.filter(x => x !== v)) }));
  filters.source.forEach(v => chips.push({ k: "source", v: SOURCE_LABEL[v] || v, clear: () => setFilter("source", filters.source.filter(x => x !== v)) }));
  filters.site.forEach(v => chips.push({ k: "site", v, clear: () => setFilter("site", filters.site.filter(x => x !== v)) }));
  filters.group.forEach(v => chips.push({ k: "group", v, clear: () => setFilter("group", filters.group.filter(x => x !== v)) }));
  filters.tags.forEach(v => chips.push({ k: "tag", v, clear: () => setFilter("tags", filters.tags.filter(x => x !== v)) }));
  if (filters.search) chips.push({ k: "search", v: `"${filters.search}"`, clear: () => setFilter("search", "") });
  if (range !== "24h") chips.push({ k: "range", v: RANGE_LABELS[range] || range });

  if (chips.length === 0) return null;
  return (
    <div className="fb-chips" style={{ marginBottom: 10 }}>
      <span className="chips-lbl">Filtering by</span>
      {chips.map((c, i) => (
        <span className="chip" key={i}>
          <span className="chip-k">{c.k}:</span>
          <span className="chip-v">{c.v}</span>
          {c.clear && <span className="chip-x" onClick={c.clear}><Icon name="x" size={10} /></span>}
        </span>
      ))}
      <span className="chip clear" onClick={clearAll}>Clear all</span>
    </div>
  );
};

// ───────── Events table ─────────
const COLUMNS = [
  { id: "sev",     label: "Sev",     width: 60,  sortable: true,  getter: e => SEV_ORDER[e.sev] },
  { id: "status",  label: "Status",  width: 110, sortable: true,  getter: e => e.status },
  { id: "ts",      label: "Time",    width: 80,  sortable: true,  getter: e => e.clock },
  { id: "age",     label: "Age",     width: 90,  sortable: true,  getter: e => -e.clock },
  { id: "source",  label: "Src",     width: 50,  sortable: true,  getter: e => e.source },
  { id: "host",    label: "Host",    width: 170, sortable: true,  getter: e => e.host.toLowerCase() },
  { id: "site",    label: "Site",    width: 90,  sortable: true,  getter: e => e.site },
  { id: "trigger", label: "Problem", width: 0,   sortable: false, getter: e => e.trigger },
  { id: "tags",    label: "Tags",    width: 220, sortable: false },
  { id: "actions", label: "",        width: 90,  sortable: false }
];

const EventRow = ({ e, selected, onSelect, onFocus, onUpdate, busy }) => {
  const stop = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
  const ack = (ev) => { stop(ev); callUpdate([e.id], { action: ACT_ACK }); };
  const suppress = (ev) => { stop(ev); callUpdate([e.id], { action: ACT_SUPPRESS, suppress_until: Math.floor(Date.now()/1000) + 3600 }); };
  const openHost = (ev) => { stop(ev); const u = hostUrl(e.hostid); if (u) window.open(u, "_blank", "noopener"); };
  const update = (ev) => { stop(ev); onUpdate(e); };
  const sevColor = e.sev === "disaster" ? "var(--err)" :
                   e.sev === "high"     ? "var(--err)" :
                   e.sev === "warning"  ? "var(--warn)" :
                   e.sev === "info"     ? "var(--info)" : "var(--ok)";
  return (
    <tr
      className={(selected ? "selected" : "") + (e.status === "suppressed" ? " suppressed" : "") + (e.status === "resolved" ? " resolved" : "")}
      onClick={() => onFocus(e)}
    >
      <td style={{ width: 32 }} onClick={ev => { ev.stopPropagation(); onSelect(e.id); }}>
        <span className={"ev-cb" + (selected ? " checked" : "")}><Icon name="check" size={10} /></span>
      </td>
      <td className="col-sev"><Sev level={e.sev === "ok" ? "info" : e.sev} /></td>
      <td className="col-status"><span className={"ev-status " + e.status}>{STATUS_LABEL[e.status]}</span></td>
      <td className="col-ts">{e.ts}</td>
      <td className="col-age">{e.age}</td>
      <td className="col-src"><SourceBadge src={e.source} /></td>
      <td className="col-host">{e.host}</td>
      <td className="col-site"><span className="site-chip">{e.site}</span></td>
      <td className="col-trigger">
        <span className="ev-trigger" style={{ borderLeft: `2px solid ${sevColor}`, paddingLeft: 8, display: "inline-block" }}>
          {e.trigger}
        </span>
        {e.count > 1 && <span className="ev-count-pill" style={{ marginLeft: 6 }}>×{e.count}</span>}
        <span style={{ fontSize: 10, color: "var(--muted)", fontFamily: "var(--mono)", marginLeft: 8 }}>{e.group}</span>
      </td>
      <td className="col-tags">
        <span className="ev-tags">
          {e.tags.slice(0, 4).map((t, i) => {
            const cls = /outage|auth|down|fail/i.test(t) ? "danger" :
                        /capacity|drift|abuse|warn/i.test(t) ? "warn" : "";
            return <span key={i} className={"ev-tag " + cls}>{t}</span>;
          })}
          {e.tags.length > 4 && <span className="ev-tag">+{e.tags.length - 4}</span>}
        </span>
      </td>
      <td className="col-actions">
        <div className="ev-actions">
          {e.status === "open" && <span className="ev-action-btn" title="Acknowledge" onClick={ack}><Icon name="check" size={12} /></span>}
          <span className="ev-action-btn" title="Suppress 1h" onClick={suppress}><Icon name="lock" size={12} /></span>
          <span className="ev-action-btn" title="Open host" onClick={openHost} style={{ opacity: e.hostid ? 1 : 0.4, cursor: e.hostid ? "pointer" : "not-allowed" }}><Icon name="external" size={12} /></span>
          <span className="ev-action-btn" title="Update problem…" onClick={update}><Icon name="more" size={12} /></span>
        </div>
      </td>
    </tr>
  );
};

const EventsTable = ({ events, selected, setSelected, focused, setFocused, sort, setSort, groupBy, onUpdate }) => {
  const allChecked = events.length > 0 && events.every(e => selected.has(e.id));
  const toggleAll = () => {
    if (allChecked) setSelected(new Set());
    else setSelected(new Set(events.map(e => e.id)));
  };
  const toggleOne = id => {
    const s = new Set(selected);
    if (s.has(id)) s.delete(id); else s.add(id);
    setSelected(s);
  };
  const setSortKey = k => {
    if (sort.key === k) setSort({ key: k, dir: sort.dir === "asc" ? "desc" : "asc" });
    else setSort({ key: k, dir: "desc" });
  };

  let groups;
  if (groupBy && groupBy !== "none") {
    const keyer = groupBy === "site"   ? e => e.site || "—" :
                  groupBy === "host"   ? e => e.host :
                  groupBy === "source" ? e => SOURCE_LABEL[e.source] || e.source :
                  groupBy === "group"  ? e => e.group || "—" :
                                          e => e.sev;
    const map = {};
    events.forEach(e => { const k = keyer(e); (map[k] = map[k] || []).push(e); });
    groups = Object.entries(map).sort((a, b) => b[1].length - a[1].length);
  }

  const totalAvailable = (window.EV_EVENTS || []).length;
  return (
    <div className="evt-table-wrap">
      <div className="evt-table-h">
        <h3>Events</h3>
        <div className="h-spacer" />
        <span className="h-meta">{events.length} matching · {events.filter(e => e.status === "open").length} open</span>
      </div>
      {selected.size > 0 && (
        <div className="bulk-bar">
          <span className="bb-cnt">{selected.size}</span> selected
          <button className="btn sm" onClick={async () => {
            const ok = await callUpdate(Array.from(selected), { action: ACT_ACK });
            if (ok) setSelected(new Set());
          }}><Icon name="check" size={11} /> Acknowledge</button>
          <button className="btn sm" onClick={async () => {
            const ok = await callUpdate(Array.from(selected), { action: ACT_SUPPRESS, suppress_until: Math.floor(Date.now()/1000) + 3600 });
            if (ok) setSelected(new Set());
          }}><Icon name="lock" size={11} /> Suppress 1h</button>
          <button className="btn sm" onClick={() => onUpdate({ bulk: Array.from(selected) })}><Icon name="more" size={11} /> Update…</button>
          <div className="bb-spacer" />
          <button className="btn sm ghost" onClick={() => setSelected(new Set())}>Clear selection</button>
        </div>
      )}
      <div style={{ maxHeight: 560, overflow: "auto" }}>
        <table className="evt-table">
          <thead>
            <tr>
              <th style={{ width: 32 }} onClick={ev => ev.stopPropagation()}>
                <span className={"ev-cb" + (allChecked ? " checked" : "")} onClick={toggleAll}>
                  <Icon name="check" size={10} />
                </span>
              </th>
              {COLUMNS.map(c => (
                <th
                  key={c.id}
                  className={sort.key === c.id ? "sorted" : ""}
                  style={c.width ? { width: c.width } : null}
                  onClick={() => c.sortable && setSortKey(c.id)}
                >
                  {c.label}{c.sortable && <span className="sort-arrow">{sort.key === c.id ? (sort.dir === "asc" ? "▲" : "▼") : "▾"}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groups ? groups.map(([gKey, gEvents]) => (
              <React.Fragment key={gKey}>
                <tr>
                  <td colSpan={COLUMNS.length + 1} style={{ background: "var(--bg-2)", padding: "6px 14px", fontSize: 10, textTransform: "uppercase", letterSpacing: 0.6, color: "var(--muted)", fontWeight: 600, borderBottom: "1px solid var(--line)" }}>
                    <span style={{ marginRight: 8 }}>▾</span>
                    {gKey}
                    <span style={{ marginLeft: 8, fontFamily: "var(--mono)", color: "var(--fg-2)", textTransform: "none", letterSpacing: 0 }}>{gEvents.length}</span>
                  </td>
                </tr>
                {gEvents.map(e => (
                  <EventRow key={e.id} e={e} selected={selected.has(e.id)} onSelect={toggleOne} onFocus={setFocused} onUpdate={onUpdate} />
                ))}
              </React.Fragment>
            )) : events.map(e => (
              <EventRow key={e.id} e={e} selected={selected.has(e.id)} onSelect={toggleOne} onFocus={setFocused} onUpdate={onUpdate} />
            ))}
            {events.length === 0 && (
              <tr><td colSpan={COLUMNS.length + 1} style={{ textAlign: "center", padding: 40, color: "var(--muted)", fontSize: 13 }}>
                No events match the current filters.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="evt-table-foot">
        <span>Showing {events.length} of {totalAvailable}</span>
        <span className="muted">·</span>
        <span>auto-refresh 30s</span>
        <div className="h-spacer" />
        <button className="page-btn" disabled>← Prev</button>
        <span style={{ fontFamily: "var(--mono)" }}>Page 1 / 1</span>
        <button className="page-btn" disabled>Next →</button>
      </div>
    </div>
  );
};

// ───────── Detail drawer ─────────
const Drawer = ({ event, onClose, onUpdate }) => {
  if (!event) return null;
  const timeline = [
    { t: event.ts, msg: `Event opened by ${(event.source || "zbx").toUpperCase()}`, who: "system" },
    ...(event.count > 1 ? [{ t: event.ts, msg: `Recurrence ×${event.count}`, who: "system" }] : []),
    ...(event.status === "ack" ? [{ t: event.ts, msg: `Acknowledged`, who: event.owner || "operator" }] : []),
    ...(event.status === "resolved" ? [{ t: event.ts, msg: `Auto-resolved (duration ${event.duration})`, who: "system" }] : [])
  ];
  return (
    <div className="evt-drawer open">
      <div className="drawer-h">
        <Sev level={event.sev === "ok" ? "info" : event.sev} />
        <h3>{event.id}</h3>
        <span className={"ev-status " + event.status}>{STATUS_LABEL[event.status]}</span>
        <div className="h-spacer" />
        <span className="icon-btn" onClick={onClose}><Icon name="close" /></span>
      </div>
      <div className="drawer-b">
        <div className="drawer-section">
          <div className="drawer-trigger">{event.trigger}</div>
          {event.tags.length > 0 && (
            <span className="ev-tags">
              {event.tags.map((t, i) => <span key={i} className="ev-tag">{t}</span>)}
            </span>
          )}
        </div>

        <div className="drawer-section">
          <h4>Identification</h4>
          <div className="drawer-meta-grid">
            <span className="k">Source</span>     <span className="v"><SourceBadge src={event.source} /> {SOURCE_LABEL[event.source]}</span>
            <span className="k">Host</span>       <span className="v">{event.host}</span>
            <span className="k">Site</span>       <span className="v">{event.site}</span>
            <span className="k">Host group</span> <span className="v">{event.group}</span>
            <span className="k">Owner</span>      <span className="v">{event.owner || <span style={{ color: "var(--muted)" }}>unassigned</span>}</span>
            <span className="k">Count</span>      <span className="v">×{event.count}</span>
          </div>
        </div>

        <div className="drawer-section">
          <h4>Timing</h4>
          <div className="drawer-meta-grid">
            <span className="k">Opened</span>   <span className="v">{event.tsFull || event.ts}</span>
            <span className="k">Age</span>      <span className="v">{event.age}</span>
            <span className="k">Duration</span> <span className="v">{event.duration}</span>
          </div>
        </div>

        <div className="drawer-section">
          <h4>Audit trail</h4>
          <div className="drawer-timeline">
            {timeline.map((t, i) => (
              <div className="t-row" key={i}>
                <span className="t-time">{t.t}</span>
                <span>{t.msg}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="drawer-actions">
        {event.status === "open" && (
          <button className="btn primary" onClick={() => callUpdate([event.id], { action: ACT_ACK })}>
            <Icon name="check" size={12} /> Acknowledge
          </button>
        )}
        {event.status === "ack" && (
          <button className="btn" onClick={() => callUpdate([event.id], { action: ACT_CLOSE })}>
            <Icon name="check" size={12} /> Resolve
          </button>
        )}
        <button className="btn" onClick={() => callUpdate([event.id], { action: ACT_SUPPRESS, suppress_until: Math.floor(Date.now()/1000) + 3600 })}>
          <Icon name="lock" size={12} /> Suppress 1h
        </button>
        <button className="btn" onClick={() => onUpdate(event)}>
          <Icon name="more" size={12} /> Update…
        </button>
        <div className="h-spacer" style={{ flex: 1 }} />
        <button
          className="btn ghost"
          onClick={() => { const u = hostUrl(event.hostid); if (u) window.open(u, "_blank", "noopener"); }}
          disabled={!event.hostid}
        >
          <Icon name="external" size={12} /> Open host
        </button>
      </div>
    </div>
  );
};

// ───────── Update modal ─────────
// `target` is either a single event object, or { bulk: [eventid, ...] } for
// multi-select. Mirrors Zabbix's native "Update problem" dialog (ack, close,
// suppress, change severity, add message) but with the bare minimum surface.
const UpdateModal = ({ target, onClose }) => {
  const isBulk = target && Array.isArray(target.bulk);
  const eventids = isBulk ? target.bulk : [target.id];
  const single = !isBulk ? target : null;

  const [message, setMessage]   = React.useState("");
  const [doAck, setDoAck]       = React.useState(false);
  const [doClose, setDoClose]   = React.useState(false);
  const [doSuppress, setDoSupp] = React.useState(false);
  const [suppressMins, setSuppressMins] = React.useState(60);
  const [chgSev, setChgSev]     = React.useState(false);
  const [severity, setSeverity] = React.useState(single ? (SEV_ORDER[single.rawSev] - 1) : 2);
  const [submitting, setSubmitting] = React.useState(false);

  const submit = async () => {
    let action = 0;
    if (doAck)      action |= ACT_ACK;
    if (doClose)    action |= ACT_CLOSE;
    if (doSuppress) action |= ACT_SUPPRESS;
    if (chgSev)     action |= ACT_SEV;
    if (message.trim()) action |= ACT_MSG;
    if (action === 0) { alert("Choose at least one action or add a message."); return; }

    const opts = { action };
    if (message.trim()) opts.message = message.trim();
    if (chgSev)     opts.severity = severity | 0;
    if (doSuppress) opts.suppress_until = Math.floor(Date.now()/1000) + Math.max(1, suppressMins | 0) * 60;

    setSubmitting(true);
    const ok = await callUpdate(eventids, opts);
    setSubmitting(false);
    if (ok) onClose();
  };

  const sevOpts = [
    { v: 0, l: "Not classified" }, { v: 1, l: "Information" }, { v: 2, l: "Warning" },
    { v: 3, l: "Average" },        { v: 4, l: "High" },        { v: 5, l: "Disaster" }
  ];

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 200,
      display: "flex", alignItems: "center", justifyContent: "center"
    }}>
      <div onClick={ev => ev.stopPropagation()} style={{
        background: "var(--bg-1)", border: "1px solid var(--line)", borderRadius: 8,
        width: 480, maxWidth: "92vw", maxHeight: "90vh", overflow: "auto",
        boxShadow: "0 20px 60px rgba(0,0,0,0.5)"
      }}>
        <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--line)", display: "flex", alignItems: "center", gap: 10 }}>
          <h3 style={{ margin: 0, flex: 1, fontSize: 14 }}>
            Update {isBulk ? `${eventids.length} events` : `event ${single.id}`}
          </h3>
          <span className="icon-btn" onClick={onClose}><Icon name="close" /></span>
        </div>
        <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 12 }}>
          {single && (
            <div style={{ fontSize: 12, color: "var(--muted)" }}>
              <div><b style={{ color: "var(--fg-1)" }}>{single.host}</b> · {single.site}</div>
              <div style={{ marginTop: 2 }}>{single.trigger}</div>
            </div>
          )}

          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
            <span style={{ color: "var(--muted)" }}>Message</span>
            <textarea
              value={message}
              onChange={ev => setMessage(ev.target.value)}
              rows={3}
              placeholder="Optional note (added to event history)"
              style={{ background: "var(--bg-2)", color: "var(--fg-1)", border: "1px solid var(--line)", borderRadius: 4, padding: 8, fontFamily: "inherit", fontSize: 12, resize: "vertical" }}
            />
          </label>

          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
            <input type="checkbox" checked={doAck}   onChange={ev => setDoAck(ev.target.checked)} />
            <span>Acknowledge</span>
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
            <input type="checkbox" checked={doClose} onChange={ev => setDoClose(ev.target.checked)} />
            <span>Close problem</span>
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
            <input type="checkbox" checked={doSuppress} onChange={ev => setDoSupp(ev.target.checked)} />
            <span>Suppress for</span>
            <input
              type="number" min="1" max="10080" value={suppressMins} disabled={!doSuppress}
              onChange={ev => setSuppressMins(parseInt(ev.target.value, 10) || 1)}
              style={{ width: 70, background: "var(--bg-2)", color: "var(--fg-1)", border: "1px solid var(--line)", borderRadius: 4, padding: "3px 6px", fontSize: 12 }}
            />
            <span>minutes</span>
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
            <input type="checkbox" checked={chgSev} onChange={ev => setChgSev(ev.target.checked)} />
            <span>Change severity</span>
            <select
              value={severity} disabled={!chgSev}
              onChange={ev => setSeverity(parseInt(ev.target.value, 10))}
              style={{ background: "var(--bg-2)", color: "var(--fg-1)", border: "1px solid var(--line)", borderRadius: 4, padding: "3px 6px", fontSize: 12 }}
            >
              {sevOpts.map(s => <option key={s.v} value={s.v}>{s.l}</option>)}
            </select>
          </label>
        </div>
        <div style={{ padding: "12px 18px", borderTop: "1px solid var(--line)", display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="btn ghost" onClick={onClose} disabled={submitting}>Cancel</button>
          <button className="btn primary" onClick={submit} disabled={submitting}>
            {submitting ? "Updating…" : "Update"}
          </button>
        </div>
      </div>
    </div>
  );
};

// ───────── App ─────────
const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  density: "balanced",
  showSourceBadges: true,
  groupBy: "none",
  showResolved: true,
  showSuppressed: false,
  autoRefresh: true
}/*EDITMODE-END*/;

const useEventsTick = () => {
  const [tick, setTick] = React.useState(0);
  React.useEffect(() => {
    const onData = () => setTick(n => n + 1);
    window.addEventListener("tcs:events-data", onData);
    return () => window.removeEventListener("tcs:events-data", onData);
  }, []);
  return tick;
};

const EventsAppDesigned = () => {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const tick = useEventsTick();
  const [filters, setFilters] = React.useState(() => {
    const init = { search: "", sev: [], status: [], source: [], site: [], group: [], tags: [] };
    try {
      const params = new URLSearchParams(window.location.search);
      const site = params.get("site");
      if (site) init.site = [site];
    } catch (e) {}
    return init;
  });
  const [range, setRangeState] = React.useState(() => {
    try {
      const r = new URLSearchParams(window.location.search).get("range");
      if (r && RANGE_LABELS[r]) return r;
    } catch (e) {}
    return (window.EV_FILTERS && window.EV_FILTERS.range) || "24h";
  });
  const [activeTile, setActiveTile] = React.useState(null);
  const [activeView, setActiveView] = React.useState(null);
  const [selected, setSelected] = React.useState(new Set());
  const [focused, setFocused] = React.useState(null);
  const [sort, setSort] = React.useState({ key: "ts", dir: "desc" });
  const [refreshing, setRefreshing] = React.useState(false);
  const [updateTarget, setUpdateTarget] = React.useState(null);

  React.useEffect(() => {
    document.documentElement.classList.toggle("hide-src-badges", !t.showSourceBadges);
  }, [t.showSourceBadges]);

  React.useEffect(() => {
    const onData = () => setRefreshing(false);
    window.addEventListener("tcs:events-data", onData);
    return () => window.removeEventListener("tcs:events-data", onData);
  }, []);

  // Boot payload is rendered server-side with the default 24h range. If the
  // URL pinned us to a different range (e.g. tile click → ?range=open), kick
  // a refetch immediately so the visible data matches the dropdown label.
  React.useEffect(() => {
    const bootRange = (window.EV_FILTERS && window.EV_FILTERS.range) || "24h";
    if (range !== bootRange && typeof window.tcsEventsFetch === "function") {
      setRefreshing(true);
      window.tcsEventsFetch({ range });
    }
  }, []);

  const setFilter = (k, v) => setFilters(f => ({ ...f, [k]: v }));
  const clearAll = () => {
    setFilters({ search: "", sev: [], status: [], source: [], site: [], group: [], tags: [] });
    setActiveTile(null);
    setActiveView(null);
  };
  const setRange = (r) => {
    setRangeState(r);
    setRefreshing(true);
    if (typeof window.tcsEventsFetch === "function") window.tcsEventsFetch({ range: r });
  };
  const doRefresh = () => {
    setRefreshing(true);
    if (typeof window.tcsEventsRefresh === "function") window.tcsEventsRefresh();
  };

  // tick acts as a dep so memoized lists re-run after each refetch
  const events = window.EV_EVENTS || [];
  const timeline = window.EV_TIMELINE || new Array(24).fill(null).map(() => [0, 0, 0, 0]);
  const metrics  = window.EV_METRICS  || { open: 0, ack: 0, mttaStr: "—", mttrStr: "—" };

  const sev_counts = React.useMemo(() => {
    const c = { disaster: 0, high: 0, warning: 0, info: 0, ok: 0 };
    events.forEach(e => {
      const k = e.sev === "ok" ? "ok" : e.rawSev;
      if (c[k] !== undefined) c[k]++;
    });
    return c;
  }, [events, tick]);

  // Filter pipeline
  const filtered = React.useMemo(() => {
    let list = events;
    if (!t.showResolved)   list = list.filter(e => e.status !== "resolved");
    if (!t.showSuppressed) list = list.filter(e => e.status !== "suppressed");

    if (activeTile === "disaster") list = list.filter(e => e.rawSev === "disaster" && e.status !== "resolved");
    if (activeTile === "high")     list = list.filter(e => e.rawSev === "high"     && e.status !== "resolved");
    if (activeTile === "warn")     list = list.filter(e => e.rawSev === "warning"  && e.status !== "resolved");
    if (activeTile === "open")     list = list.filter(e => e.status === "open");
    if (activeTile === "ack")      list = list.filter(e => e.status === "ack");

    if (activeView) {
      const v = (window.EV_SAVED_VIEWS || []).find(x => x.id === activeView);
      if (v) {
        const f = v.id;
        if (f === "v1") list = list.filter(e => ["disaster","high"].includes(e.rawSev) && e.status !== "resolved");
        if (f === "v2") list = list.filter(e => e.status === "open");
        if (f === "v3") list = list.filter(e => e.status === "ack");
        if (f === "v4") list = list.filter(e => e.status === "resolved");
        if (f === "v5") list = list.filter(e => e.rawSev === "warning" && e.status !== "resolved");
      }
    }

    if (filters.sev.length)    list = list.filter(e => filters.sev.includes(e.sev) || filters.sev.includes(e.rawSev));
    if (filters.status.length) list = list.filter(e => filters.status.includes(e.status));
    if (filters.source.length) list = list.filter(e => filters.source.includes(e.source));
    if (filters.site.length)   list = list.filter(e => filters.site.includes(e.site));
    if (filters.group.length)  list = list.filter(e => filters.group.includes(e.group));
    if (filters.tags.length)   list = list.filter(e => e.tags.some(x => filters.tags.includes(x)));

    if (filters.search) {
      const q = filters.search.toLowerCase();
      list = list.filter(e =>
        e.host.toLowerCase().includes(q) ||
        e.trigger.toLowerCase().includes(q) ||
        String(e.id).includes(q) ||
        (e.site || "").toLowerCase().includes(q) ||
        e.tags.some(x => x.toLowerCase().includes(q))
      );
    }

    const col = COLUMNS.find(c => c.id === sort.key);
    if (col && col.getter) {
      const dir = sort.dir === "asc" ? 1 : -1;
      list = [...list].sort((a, b) => {
        const va = col.getter(a), vb = col.getter(b);
        if (va < vb) return -1 * dir;
        if (va > vb) return  1 * dir;
        return 0;
      });
    }
    return list;
  }, [events, filters, activeTile, activeView, sort, t.showResolved, t.showSuppressed, tick]);

  return (
    <div className="app" data-density={t.density} data-screen-label="Events Console">
      <GlobalSidebar active="events" />
      <div className="main">
        <GlobalTopbar crumb={["Operations", "Events"]} onRefresh={doRefresh} refreshing={refreshing} />

        <div className="evt-header">
          <div style={{ flex: 1 }}>
            <div className="host-title">
              <h1>Events Console</h1>
              <span className="role-tag faculty" style={{ fontSize: 10, padding: "1px 8px" }}>TRIAGE</span>
              {t.autoRefresh && (
                <span className="live-pill"><span className="live-dot" /> Live · 30s</span>
              )}
            </div>
            <div className="evt-header-meta">
              <span className="pill"><span className="lbl">Sources</span> <SourceBadge src="zbx" /></span>
              <span className="pill"><span className="lbl">In window</span> <span className="v">{filtered.length.toLocaleString()} / {events.length.toLocaleString()}</span></span>
              <span className="pill"><span className="lbl">Open</span> <span className="v" style={{ color: "var(--err)" }}>{metrics.open}</span></span>
              <span className="pill"><span className="lbl">Acknowledged</span> <span className="v">{metrics.ack}</span></span>
              <span className="pill"><span className="lbl">MTTA / MTTR</span> <span className="v">{metrics.mttaStr} / {metrics.mttrStr}</span></span>
            </div>
          </div>
        </div>

        <div className="body">
          <KPIStrip events={events} activeTile={activeTile} setActiveTile={setActiveTile} range={RANGE_LABELS[range]} />
          <Histogram timeline={timeline} range={RANGE_LABELS[range]} />

          <FilterBar
            filters={filters}
            setFilter={setFilter}
            activeView={activeView}
            setActiveView={setActiveView}
            range={range}
            setRange={setRange}
            onRefresh={doRefresh}
            sev_counts={sev_counts}
          />
          <FilterChips
            filters={filters}
            setFilter={setFilter}
            clearAll={clearAll}
            activeTile={activeTile}
            setActiveTile={setActiveTile}
            activeView={activeView}
            setActiveView={setActiveView}
            range={range}
          />

          <EventsTable
            events={filtered}
            selected={selected}
            setSelected={setSelected}
            focused={focused}
            setFocused={setFocused}
            sort={sort}
            setSort={setSort}
            groupBy={t.groupBy}
            onUpdate={setUpdateTarget}
          />
        </div>
      </div>

      {focused && <Drawer event={focused} onClose={() => setFocused(null)} onUpdate={setUpdateTarget} />}
      {updateTarget && <UpdateModal target={updateTarget} onClose={() => setUpdateTarget(null)} />}

      <TweaksPanel title="Tweaks">
        <TweakSection title="Layout">
          <TweakRadio label="Density" value={t.density} options={[
            { value: "spacious", label: "Spacious" },
            { value: "balanced", label: "Balanced" },
            { value: "dense",    label: "Dense" }
          ]} onChange={v => setTweak("density", v)} />
          <TweakSelect label="Group rows by" value={t.groupBy} options={[
            { value: "none",   label: "No grouping" },
            { value: "site",   label: "Site" },
            { value: "host",   label: "Host" },
            { value: "source", label: "Source" },
            { value: "group",  label: "Host group" }
          ]} onChange={v => setTweak("groupBy", v)} />
          <TweakToggle label="Show data-source badges" value={t.showSourceBadges} onChange={v => setTweak("showSourceBadges", v)} />
        </TweakSection>
        <TweakSection title="Visible events">
          <TweakToggle label="Include resolved"   value={t.showResolved}   onChange={v => setTweak("showResolved", v)} />
          <TweakToggle label="Include suppressed" value={t.showSuppressed} onChange={v => setTweak("showSuppressed", v)} />
          <TweakToggle label="Auto-refresh (30s)" value={t.autoRefresh}    onChange={v => setTweak("autoRefresh", v)} />
        </TweakSection>
        <TweakSection title="Quick actions">
          <TweakButton onClick={clearAll}>Clear all filters</TweakButton>
        </TweakSection>
      </TweaksPanel>
    </div>
  );
};

ReactDOM.createRoot(document.getElementById("root")).render(<EventsAppDesigned />);
