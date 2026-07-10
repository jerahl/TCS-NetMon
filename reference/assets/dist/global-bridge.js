// global-bridge.jsx
//
// Adapts the JSON payload emitted by ActionGlobal / ActionGlobalData into the
// window globals global-app.jsx already reads: GLOBAL_TOTALS, GLOBAL_SITES,
// GLOBAL_DOMAINS, GLOBAL_TRIGGERS, GLOBAL_EVENTS, PROBLEM_TIMELINE.
//
// Loaded INSTEAD OF global-data.jsx — same window globals, real data instead
// of mock. Falls back to the synthetic shapes if the boot payload is missing,
// so loading order accidents render dashes rather than crashing.
//
// Staged loading: ActionGlobal no longer ships data inline. The shell paints
// instantly; we fire two parallel fetches on script load:
//   - stage=core   → totals + sites + triggers + events (Zabbix-only, fast)
//   - stage=enrich → domains + timeline (XIQ items / 3CX HTTP / Milestone /
//                     24h event scan — the slow path)
// Each fetch dispatches "tcs:global-data" with detail.stage set so the React
// app can clear per-section skeletons as data lands. The recurring auto-
// refresh uses stage=all for a single coalesced call.
//
// Exposes an imperative refresh API used by the header buttons:
//   window.tcsGlobalRefresh(rangeKey?)   — fetch immediately
//   window.tcsGlobalSetRange(rangeKey)   — change range AND refetch
// Dispatches "tcs:global-data" on every successful refresh with the parsed
// payload so the app can update the "Last refresh" timestamp.

(function () {
  const EMPTY_TOTALS = {
    hosts: {
      total: 0,
      up: 0,
      down: 0,
      unknown: 0
    },
    problems: {
      disaster: 0,
      high: 0,
      warning: 0,
      info: 0,
      ack: 0
    },
    sla: {
      value: null,
      target: 99.5
    },
    devices: {
      total: null,
      online: null,
      quarantine: null,
      byod: null
    },
    proxies: {
      total: 0,
      online: 0
    },
    templates: {
      total: null,
      version: "—"
    }
  };

  // Range key → human label. Server-side parsed to a seconds window.
  const RANGES = {
    "1h": "Last 1h",
    "6h": "Last 6h",
    "24h": "Last 24h",
    "7d": "Last 7d"
  };
  const normaliseSite = s => ({
    id: s.id ?? "—",
    name: s.name ?? "—",
    hosts: s.hosts ?? 0,
    problems: s.problems ?? 0,
    sev: s.sev ?? "ok",
    sla: typeof s.sla === "number" ? s.sla : 100,
    kind: s.kind ?? null,
    type: s.type ?? null
  });
  const normaliseTotals = t => {
    const merged = {
      ...EMPTY_TOTALS,
      ...(t || {})
    };
    if (typeof merged.sla?.value !== "number") {
      merged.sla = {
        ...merged.sla,
        value: merged.sla?.target ?? 100
      };
    }
    if (typeof merged.templates?.total !== "number") {
      merged.templates = {
        ...merged.templates,
        total: 0
      };
    }
    if (typeof merged.devices?.total !== "number") {
      merged.devices = {
        total: 0,
        online: 0,
        quarantine: 0,
        byod: 0
      };
    }
    return merged;
  };
  const normaliseDomain = d => ({
    id: d.id ?? "—",
    label: d.label ?? "—",
    sub: d.sub ?? "",
    icon: d.icon ?? "ap",
    src: d.src ?? "zbx",
    status: d.status ?? "ok",
    href: d.href ?? "#",
    total: d.total ?? 0,
    ok: d.ok ?? 0,
    warn: d.warn ?? 0,
    err: d.err ?? 0,
    problems: d.problems ?? 0,
    top: d.top ?? "",
    kpis: Array.isArray(d.kpis) ? d.kpis : [],
    spark: Array.isArray(d.spark) && d.spark.length === 24 ? d.spark : new Array(24).fill(0),
    sparkColor: d.sparkColor ?? "var(--zbx)",
    sparkLabel: d.sparkLabel ?? ""
  });

  // Apply whichever sections of the payload are present. Unset sections
  // keep their previous values so a staged response never wipes out
  // earlier-arrived data.
  const applyPartial = boot => {
    const b = boot || {};
    if (b.totals) window.GLOBAL_TOTALS = normaliseTotals(b.totals);
    if (b.sites) window.GLOBAL_SITES = b.sites.map(normaliseSite);
    if (b.domains) window.GLOBAL_DOMAINS = b.domains.map(normaliseDomain);
    if (b.triggers) window.GLOBAL_TRIGGERS = b.triggers;
    if (b.events) window.GLOBAL_EVENTS = b.events;
    if (Array.isArray(b.timeline) && b.timeline.length === 24) {
      window.PROBLEM_TIMELINE = b.timeline;
    }
  };

  // Seed empty containers so first paint reads dashes / zeros rather
  // than ReferenceErrors before any fetch lands.
  const seedEmpty = () => {
    if (!window.GLOBAL_TOTALS) window.GLOBAL_TOTALS = normaliseTotals(null);
    if (!window.GLOBAL_SITES) window.GLOBAL_SITES = [];
    if (!window.GLOBAL_DOMAINS) window.GLOBAL_DOMAINS = [];
    if (!window.GLOBAL_TRIGGERS) window.GLOBAL_TRIGGERS = [];
    if (!window.GLOBAL_EVENTS) window.GLOBAL_EVENTS = [];
    if (!window.PROBLEM_TIMELINE) window.PROBLEM_TIMELINE = new Array(24).fill(0);
  };
  seedEmpty();
  if (window.GLOBAL_BOOT) applyPartial(window.GLOBAL_BOOT);
  window.TWEAK_DEFAULTS = window.TWEAK_DEFAULTS || {
    accent: "#d92929",
    fontMono: "JetBrains Mono",
    density: "comfortable",
    showSourceBadges: true,
    showSidecar: true
  };

  // --- Live refresh state ---
  let currentRange = "24h";
  const REFRESH_MS = 30_000;
  const baseUrl = window.TCS_GLOBAL_DATA_URL;
  const fetchStage = async stage => {
    if (!baseUrl) return null;
    const url = `${baseUrl}&range=${encodeURIComponent(currentRange)}&stage=${encodeURIComponent(stage)}`;
    try {
      const resp = await fetch(url, {
        credentials: "same-origin",
        headers: {
          "Accept": "application/json"
        }
      });
      if (!resp.ok) {
        window.dispatchEvent(new CustomEvent("tcs:global-data", {
          detail: {
            stage,
            error: `HTTP ${resp.status}`,
            fetchedAt: Date.now()
          }
        }));
        return null;
      }
      const fresh = await resp.json();
      applyPartial(fresh);
      window.dispatchEvent(new CustomEvent("tcs:global-data", {
        detail: {
          ...fresh,
          stage: fresh.stage || stage,
          range: currentRange,
          fetchedAt: Date.now()
        }
      }));
      return fresh;
    } catch (e) {
      console.warn(`[tcs] global refresh (${stage}) failed:`, e);
      window.dispatchEvent(new CustomEvent("tcs:global-data", {
        detail: {
          stage,
          error: String(e),
          fetchedAt: Date.now()
        }
      }));
      return null;
    }
  };

  // Full refresh = both stages, in parallel. The server-side cache
  // coalesces overlapping work, but firing both means whichever stage
  // finishes first paints early — operators see the cheap KPIs while
  // the slow 3CX/Item.get path is still in flight.
  const refreshAll = () => Promise.all([fetchStage("core"), fetchStage("enrich")]);
  window.tcsGlobalRefresh = refreshAll;
  window.tcsGlobalSetRange = r => {
    if (!RANGES[r]) return;
    currentRange = r;
    return refreshAll();
  };
  window.tcsGlobalRanges = RANGES;

  // Kick off the initial staged fetch as soon as the bridge is parsed.
  // Don't wait for the React app to mount — the slow path can be in
  // flight while React boots.
  refreshAll();

  // Periodic refresh: ActionGlobalData caches the full payload for 5s
  // and the per-stage filter peels the right subset back out, so calling
  // both stages in parallel here is cheap after the first call.
  setInterval(refreshAll, REFRESH_MS);
})();