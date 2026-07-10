// xiq-bridge.jsx
//
// Data layer for the XIQ Wireless Status page. ActionXiq embeds the SSR boot
// snapshot in window.XIQ_BOOT. This bridge unpacks it into the per-section
// globals xiq-app.jsx reads (XIQ_TOTALS / XIQ_SITES / XIQ_SSIDS /
// XIQ_TOP_CLIENT_APS / XIQ_CHANNEL_GRID / XIQ_CLIENT_MIX /
// XIQ_FIRMWARE / XIQ_ROAMING / XIQ_EVENTS), then fetches tcs.xiq.data after
// first paint to refresh the same globals and bump a re-render.
//
// Mirrors the switches-bridge pattern.

(function () {
  const KEYS = [["totals", "XIQ_TOTALS", {}], ["sites", "XIQ_SITES", []], ["ssids", "XIQ_SSIDS", []], ["topClientAps", "XIQ_TOP_CLIENT_APS", []], ["channelGrid", "XIQ_CHANNEL_GRID", {
    sites: [],
    channels: [],
    matrix: []
  }], ["clientMix", "XIQ_CLIENT_MIX", {
    standards: [],
    os: []
  }], ["firmware", "XIQ_FIRMWARE", {
    versions: []
  }], ["roaming", "XIQ_ROAMING", {
    buckets: [],
    rate24h: 0
  }], ["events", "XIQ_EVENTS", []]];
  function apply(payload) {
    if (!payload || typeof payload !== "object") return;
    for (const [src, dst, fallback] of KEYS) {
      const v = payload[src];
      window[dst] = v !== undefined && v !== null ? v : window[dst] || fallback;
    }
    // Loading flag — true on the SSR boot (empty arrays), flips false on
    // the first successful refresh. Widgets read this to choose between
    // empty-state and spinner rendering.
    window.XIQ_LOADING = !!payload.loading;
    // Banner state — App renders if non-null. error wins over warning so
    // the user sees the most important condition.
    window.XIQ_BANNER = payload.error ? {
      kind: "error",
      msg: payload.error
    } : payload.warning ? {
      kind: "warning",
      msg: payload.warning
    } : null;
    window.XIQ_SOURCES = payload.sources || null;
    window.dispatchEvent(new CustomEvent("tcs:xiq-data", {
      detail: {
        ts: payload.ts || Date.now()
      }
    }));
  }

  // First paint: unpack the SSR boot synchronously so xiq-app.jsx sees
  // populated globals on its initial render.
  apply(window.XIQ_BOOT || {});
  const URL_DATA = window.TCS_XIQ_DATA_URL || "zabbix.php?action=tcs.xiq.data";
  async function fetchOnce(suffix, label) {
    const url = URL_DATA + suffix;
    try {
      const resp = await fetch(url, {
        credentials: "same-origin",
        headers: {
          "Accept": "application/json"
        }
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const j = await resp.json();
      apply(j || {});
      console.info("[tcs] " + label + " refresh:", (j.sites || []).length, "site(s),", j.totals && j.totals.aps && j.totals.aps.total || 0, "AP(s)");
      return j;
    } catch (e) {
      console.error("[tcs] " + label + " fetch failed:", e, "url:", url);
      return null;
    }
  }

  // Two-stage refresh on FIRST load: render Zabbix-side fleet immediately
  // (fast), then enrich with XIQ overlays (slow). On subsequent polls just
  // fetch the full payload to avoid a flicker where XIQ fields briefly
  // reset to zero between the zbx response and the xiq response.
  let firstLoad = true;
  async function fetchData() {
    if (firstLoad) {
      firstLoad = false;
      await fetchOnce("&source=zbx", "zbx");
      fetchOnce("", "xiq+zbx");
    } else {
      fetchOnce("", "xiq+zbx");
    }
  }
  console.info("[tcs] fetching Zabbix fleet snapshot first, XIQ enrichment to follow…");
  fetchData();

  // Auto-refresh every 30s. Skip when the tab is hidden so a backgrounded
  // dashboard doesn't keep hammering the Zabbix server. Server-side caches
  // for 30s anyway, so this is the natural cadence.
  const REFRESH_MS = 30_000;
  setInterval(() => {
    if (document.visibilityState === "visible") fetchData();
  }, REFRESH_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") fetchData();
  });

  // Expose a manual refresh hook for the Tweaks "Refresh now" button.
  window.tcsXiqRefresh = fetchData;
})();