// zbx-status-bridge.jsx
//
// Data layer for the Zabbix Server + Proxy Status page. ActionZbxStatus embeds
// an SSR boot snapshot in window.ZBX_BOOT. This bridge unpacks it into the
// per-section globals zbx-status-app.jsx reads (ZBX_SUMMARY, ZBX_NODES,
// ZBX_PROCESSES, ZBX_CACHES, ZBX_PROXIES, ZBX_NVPS_TIMELINE,
// ZBX_QUEUE_TIMELINE, ZBX_CACHE_TIMELINE, ZBX_EVENTS), then fetches
// tcs.zbx.status.data after first paint to refresh the same globals and
// bump a re-render.
//
// Mirrors the fortigate-bridge pattern.

(function () {
  const DEFAULTS = {
    ZBX_SUMMARY: {
      version: "—",
      build: "",
      upSince: "—",
      upHuman: "—",
      haMode: "standalone",
      primary: "—",
      standby: "",
      reqPerf: 0,
      actPerf: 0,
      hosts: {
        enabled: 0,
        disabled: 0,
        templates: 0,
        monitored: 0
      },
      items: {
        enabled: 0,
        disabled: 0,
        notSupported: 0
      },
      triggers: {
        enabled: 0,
        problem: 0,
        suppressed: 0,
        ok: 0
      },
      queue: {
        total: 0,
        ten_min: 0,
        half_hr: 0,
        hour: 0,
        day: 0
      },
      proxies: {
        total: 0,
        online: 0,
        offline: 0,
        drift: 0
      }
    },
    ZBX_NODES: [],
    ZBX_PROCESSES: [],
    ZBX_CACHES: [],
    ZBX_PROXIES: [],
    ZBX_NVPS_TIMELINE: new Array(60).fill(0),
    ZBX_QUEUE_TIMELINE: new Array(60).fill(0),
    ZBX_CACHE_TIMELINE: new Array(60).fill(0),
    ZBX_EVENTS: []
  };

  // payload field → window global
  const KEYS = [["summary", "ZBX_SUMMARY"], ["nodes", "ZBX_NODES"], ["processes", "ZBX_PROCESSES"], ["caches", "ZBX_CACHES"], ["proxies", "ZBX_PROXIES"], ["nvpsTimeline", "ZBX_NVPS_TIMELINE"], ["queueTimeline", "ZBX_QUEUE_TIMELINE"], ["cacheTimeline", "ZBX_CACHE_TIMELINE"], ["events", "ZBX_EVENTS"]];
  function isEmpty(v) {
    if (v === null || v === undefined) return true;
    if (Array.isArray(v)) return v.length === 0;
    if (typeof v === "object") return Object.keys(v).length === 0;
    return false;
  }
  function apply(payload) {
    if (!payload || typeof payload !== "object") return;
    for (const [src, dst] of KEYS) {
      const v = payload[src];
      if (v === undefined || v === null) {
        if (window[dst] === undefined) window[dst] = DEFAULTS[dst];
      } else if (isEmpty(v) && !isEmpty(window[dst])) {
        // Keep current data on transient empty refreshes — avoids the
        // KPI strip blinking to zero when a single batch fails.
      } else {
        window[dst] = v;
      }
    }
    window.ZBX_LOADING = !!payload.loading;
    window.ZBX_BANNER = payload.error ? {
      kind: "error",
      msg: payload.error
    } : payload.warning ? {
      kind: "warning",
      msg: payload.warning
    } : null;
    window.ZBX_SOURCES = payload.sources || null;
    window.dispatchEvent(new CustomEvent("tcs:zbx-status-data", {
      detail: {
        ts: payload.ts || Date.now()
      }
    }));
  }

  // Seed defaults for any global the app may read before the first apply().
  for (const [, dst] of KEYS) {
    if (window[dst] === undefined) window[dst] = DEFAULTS[dst];
  }

  // First paint: unpack SSR boot synchronously.
  apply(window.ZBX_BOOT || {});
  const URL_DATA = window.TCS_ZBX_STATUS_DATA_URL || "zabbix.php?action=tcs.zbx.status.data";
  async function fetchData() {
    try {
      const resp = await fetch(URL_DATA, {
        credentials: "same-origin",
        headers: {
          "Accept": "application/json"
        }
      });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const j = await resp.json();
      apply(j || {});
      console.info("[tcs] zbx-status refresh:", (j.nodes || []).length, "node(s),", (j.proxies || []).length, "proxie(s),", (j.events || []).length, "event(s)");
      return j;
    } catch (e) {
      console.error("[tcs] zbx-status fetch failed:", e, "url:", URL_DATA);
      return null;
    }
  }
  console.info("[tcs] fetching Zabbix status snapshot…");
  fetchData();

  // Auto-refresh every 30s, skip while tab is hidden.
  const REFRESH_MS = 30_000;
  setInterval(() => {
    if (document.visibilityState === "visible") fetchData();
  }, REFRESH_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") fetchData();
  });

  // Manual refresh hook for the Tweaks panel.
  window.tcsZbxStatusRefresh = fetchData;
})();