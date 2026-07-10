// fortigate-bridge.jsx
//
// Data layer for the FortiGate Firewall page. ActionFortigate embeds an SSR
// boot snapshot in window.FG_BOOT. This bridge unpacks it into the per-section
// globals fortigate-app.jsx reads (FG_DEVICE / FG_TOTALS /
// FG_INTERFACES / FG_IPSEC / FG_SSLVPN / FG_SDWAN / FG_UTM / FG_TOP_THREATS /
// FG_TOP_POLICIES / FG_SESSIONS_24H / FG_NEW_SESSIONS_24H / FG_THROUGHPUT_24H
// / FG_EVENTS), then fetches tcs.fortigate.data after first paint to refresh
// the same globals and bump a re-render.
//
// Mirrors the xiq-bridge pattern.

(function () {
  // Per-section default shells (used when the SSR payload arrives empty —
  // e.g. no FortiGate host yet templated). Keep keys in sync with both the
  // PHP emptyPayload() and the React component property reads.
  const DEFAULTS = {
    FG_DEVICE: {
      host: "—",
      model: "—",
      serial: "—",
      fos: "—",
      uptime: "—",
      ha: "—",
      mgmtIp: "—",
      lastSync: "—",
      site: "—",
      serial2: ""
    },
    FG_TOTALS: {
      sessions: {
        active: 0,
        new_per_s: 0,
        peak: 0,
        limit: 0
      },
      throughput: {
        total_gbps: 0,
        wan_in_gbps: 0,
        wan_out_gbps: 0,
        lan_gbps: 0,
        peak_gbps: 0
      },
      cpu: {
        now: 0,
        peak15m: 0,
        target: 70
      },
      mem: {
        now: 0,
        peak15m: 0,
        target: 80
      },
      disk: {
        now: 0,
        target: 75
      },
      threats: {
        ips_blocks_24h: 0,
        av_blocks_24h: 0,
        web_blocks_24h: 0,
        app_blocks_24h: 0
      },
      vpn: {
        ipsec_up: 0,
        ipsec_total: 0,
        ssl_users: 0,
        ssl_peak_24h: 0
      },
      policies: {
        total: 0,
        active: 0,
        unused_30d: 0
      },
      fortiguard: {
        ips: "—",
        av: "—",
        webfilter: "—",
        appctrl: "—",
        expiresDays: 0
      }
    },
    FG_INTERFACES: [],
    FG_IPSEC: [],
    FG_SSLVPN: [],
    FG_SDWAN: {
      rules: 0,
      preferredLink: "",
      sla: [],
      latencyHistory: {}
    },
    FG_UTM: [],
    FG_TOP_THREATS: [],
    FG_TOP_POLICIES: [],
    FG_SESSIONS_24H: new Array(24).fill(0),
    FG_NEW_SESSIONS_24H: new Array(24).fill(0),
    FG_THROUGHPUT_24H: {
      ingress: new Array(24).fill(0),
      egress: new Array(24).fill(0)
    },
    FG_EVENTS: []
  };

  // Map payload field → window global.
  const KEYS = [["device", "FG_DEVICE"], ["totals", "FG_TOTALS"], ["interfaces", "FG_INTERFACES"], ["ipsec", "FG_IPSEC"], ["sslvpn", "FG_SSLVPN"], ["sdwan", "FG_SDWAN"], ["utm", "FG_UTM"], ["topThreats", "FG_TOP_THREATS"], ["topPolicies", "FG_TOP_POLICIES"], ["sessions24h", "FG_SESSIONS_24H"], ["newSessions24h", "FG_NEW_SESSIONS_24H"], ["throughput24h", "FG_THROUGHPUT_24H"], ["events", "FG_EVENTS"]];
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
      // For empty arrays/objects coming from a "loading" boot, fall back
      // to the existing window value or the default shell so cards never
      // crash on undefined.
      if (v === undefined || v === null) {
        if (window[dst] === undefined) window[dst] = DEFAULTS[dst];
      } else if (isEmpty(v) && !isEmpty(window[dst])) {
        // keep current data on transient empty refreshes
      } else {
        window[dst] = v;
      }
    }
    window.FG_LOADING = !!payload.loading;
    window.FG_BANNER = payload.error ? {
      kind: "error",
      msg: payload.error
    } : payload.warning ? {
      kind: "warning",
      msg: payload.warning
    } : null;
    window.FG_SOURCES = payload.sources || null;
    window.dispatchEvent(new CustomEvent("tcs:fortigate-data", {
      detail: {
        ts: payload.ts || Date.now()
      }
    }));
  }

  // Seed defaults for any global the page may read before the first apply().
  for (const [, dst] of KEYS) {
    if (window[dst] === undefined) window[dst] = DEFAULTS[dst];
  }

  // First paint: unpack SSR boot synchronously.
  apply(window.FG_BOOT || {});
  const URL_DATA = window.TCS_FORTIGATE_DATA_URL || "zabbix.php?action=tcs.fortigate.data";
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
      console.info("[tcs] fortigate refresh:", (j.interfaces || []).length, "interface(s),", (j.ipsec || []).length, "tunnel(s)");
      return j;
    } catch (e) {
      console.error("[tcs] fortigate fetch failed:", e, "url:", URL_DATA);
      return null;
    }
  }
  console.info("[tcs] fetching FortiGate snapshot…");
  fetchData();

  // Auto-refresh every 30s. Skip when the tab is hidden.
  const REFRESH_MS = 30_000;
  setInterval(() => {
    if (document.visibilityState === "visible") fetchData();
  }, REFRESH_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") fetchData();
  });

  // Expose a manual refresh hook for the Tweaks "Refresh now" button.
  window.tcsFortigateRefresh = fetchData;
})();