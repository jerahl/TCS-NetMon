// data-bridge.jsx
//
// Replaces the original mock-data data.jsx. Reads window.ZBX_BOOT (inlined by
// the PHP view) and exposes the same window globals the rest of the app
// already consumes. Then sets up a polling loop against TCS_DATA_URL so the
// values refresh without a full page reload.
//
// IMPORTANT: the consumer JSX (tabs.jsx, etc.) reads keys like
//   I.cpu.value, I.poeDraw.history, I.channelUtil5.value
// without guarding for missing keys, so we ALWAYS publish a fully-keyed
// ZBX_ITEMS object — even when the server returned nothing. Missing keys
// get a stub with value=null, history=[], missing=true; consumers then
// render dashes instead of crashing.

(function () {
  const STUB_HOST = {
    hostid: "",
    host: "—",
    visible_name: "Select a host (?hostid=NNNN)",
    ip: "",
    status: "unknown",
    available: 2,
    maintenance: 0,
    proxy: "",
    templates: [],
    groups: [],
    uptime: 0,
    lastSeen: "—"
  };

  // Every key the React app reads from window.ZBX_ITEMS. Keep this list in
  // sync with the $key_map in ActionDashboard::collectItems(). If you add
  // a new metric to either side, add it here too.
  //
  // Temp, PoE draw, and channel utilization are intentionally absent — the
  // AP305C SNMP MIBs don't expose temperature or PoE, and channel
  // utilization would need a separate XIQ d360 API call.
  const EXPECTED_ITEM_KEYS = ["cpu", "memory", "firmware", "serial", "uptime", "pingUp", "pktLoss", "latency", "uplinkIn", "uplinkOut", "uplinkStatus", "uplinkSpeed", "noise24", "noise5", "channel24", "channel5", "txpower24", "txpower5", "radioRx24", "radioTx24", "radioRx5", "radioTx5"];
  const emptyItem = () => ({
    value: null,
    prev: null,
    unit: "",
    trigger: null,
    history: [],
    missing: true,
    key: ""
  });
  const buildItems = serverItems => {
    const out = {};
    for (const k of EXPECTED_ITEM_KEYS) {
      const incoming = serverItems && serverItems[k];
      if (incoming && typeof incoming === "object") {
        // Merge: server fields win, stub fills gaps. Defensive coercion
        // for history so .map / .length always work in consumers.
        out[k] = {
          ...emptyItem(),
          ...incoming,
          history: Array.isArray(incoming.history) ? incoming.history : []
        };
      } else {
        out[k] = emptyItem();
      }
    }
    return out;
  };

  // Build a minimal AP_SITES list when the controller didn't supply one — the
  // APNavigator (shell.jsx) reads window.AP_SITES directly. With one host
  // we just put it under an "Active host" group; once collectApSites() is
  // implemented in ActionDashboard, the real fleet will replace this.
  const buildApSites = (boot, host) => {
    if (Array.isArray(boot && boot.apSites) && boot.apSites.length > 0) {
      return boot.apSites;
    }
    if (!host || !host.host) return [];
    return [{
      id: "active",
      name: host.site || "Active host",
      expanded: true,
      problems: 0,
      aps: [{
        id: host.host,
        ip: host.ip || "",
        model: host.model || Array.isArray(host.templates) && host.templates[0] || "—",
        floor: host.floor || "—",
        status: host.available === 2 ? "down" : host.available === 1 ? "ok" : "warn",
        clients: host.clients ?? 0,
        since: host.lastSeen || "—",
        problems: 0,
        current: true
      }]
    }];
  };
  function applyBoot(boot) {
    const b = boot || {};
    window.ZBX_HOST = b.host || STUB_HOST;
    window.ZBX_ITEMS = buildItems(b.items);
    window.SYSTEM_INFO = Array.isArray(b.systemInfo) ? b.systemInfo : [];
    window.NETWORK_INFO = Array.isArray(b.networkInfo) ? b.networkInfo : [];
    window.PF_CLIENTS = Array.isArray(b.pfClients) ? b.pfClients : [];
    window.PF_AUTH_FAILS = Array.isArray(b.pfAuthFails) ? b.pfAuthFails : [];
    window.ZBX_EVENTS = Array.isArray(b.events) ? b.events : [];
    window.WIRED_PORTS = Array.isArray(b.wiredPorts) ? b.wiredPorts : [];
    window.SSIDS = Array.isArray(b.ssids) ? b.ssids : [];
    window.TCS_CLIENTS_DEBUG = b.clientsDebug && typeof b.clientsDebug === 'object' ? b.clientsDebug : {};
    window.TCS_PF_AP_UPLINK_DEBUG = b.pfApUplinkDebug && typeof b.pfApUplinkDebug === 'object' ? b.pfApUplinkDebug : {};
    window.PF_ADMIN_BASE = typeof b.pfAdminUrl === 'string' ? b.pfAdminUrl : '';
    window.ALERTS_DETAIL = b.alertsDetail && typeof b.alertsDetail === 'object' ? b.alertsDetail : {
      activeTriggers: [],
      triggerCount: 0,
      last24h: {
        count: 0,
        bySeverity: {}
      },
      lastFiredAgo: null
    };
    window.AP_SITES = buildApSites(b, window.ZBX_HOST);
    window.ALERTS_SUMMARY = b.alerts || {
      associationFailures: 0,
      authFailures: 0,
      networkIssues: 0,
      packetLoss: 0,
      totalClients: 0,
      activeClients: 0
    };
  }

  // Debug state — exposed on window.TCS_DEBUG so the DebugPanel can render
  // last-fetch info, errors, and the raw boot payload without re-fetching.
  window.TCS_DEBUG = {
    bootRaw: window.ZBX_BOOT,
    bootApplied: false,
    url: null,
    lastFetchAt: null,
    lastFetchOk: null,
    lastError: null,
    fetchCount: 0,
    version: '1'
  };
  const recordFetch = (ok, err, payload) => {
    const d = window.TCS_DEBUG;
    d.lastFetchAt = new Date().toISOString();
    d.lastFetchOk = ok;
    d.lastError = err ? String(err) : null;
    d.fetchCount++;
    if (ok && payload) d.lastPayload = payload;
    window.dispatchEvent(new CustomEvent('tcs:debug'));
  };

  // Initial paint comes from the server-inlined snapshot.
  applyBoot(window.ZBX_BOOT);
  window.TCS_DEBUG.bootApplied = true;

  // Tweak defaults expected by app.jsx — kept here so we don't have to
  // touch app.jsx at all.
  window.TWEAK_DEFAULTS = window.TWEAK_DEFAULTS || {
    accent: "#d92929",
    fontMono: "JetBrains Mono",
    density: "comfortable",
    showSourceBadges: true,
    showSidecar: true
  };

  // ----- Live refresh ------------------------------------------------------
  // Poll the JSON endpoint every 30s. The existing components read
  // window.ZBX_ITEMS each render, so updating the global is enough to
  // refresh on the next setState. If you'd rather wire real reactivity,
  // listen for the 'tcs:data' CustomEvent dispatched below.

  const REFRESH_MS = 30_000;
  const hostid = window.ZBX_HOST && window.ZBX_HOST.hostid;
  const url = window.TCS_DATA_URL;
  window.TCS_DEBUG.url = url ? `${url}&hostid=${hostid || '(none)'}` : '(TCS_DATA_URL not set)';
  const tick = async () => {
    if (!hostid || !url) {
      recordFetch(false, !hostid ? "no hostid on host" : "TCS_DATA_URL missing");
      return;
    }
    try {
      const resp = await fetch(`${url}&hostid=${encodeURIComponent(hostid)}`, {
        credentials: "same-origin",
        headers: {
          "Accept": "application/json"
        }
      });
      if (!resp.ok) {
        recordFetch(false, `HTTP ${resp.status} ${resp.statusText}`);
        return;
      }
      const fresh = await resp.json();
      applyBoot({
        ...(window.ZBX_BOOT || {}),
        host: fresh.host ?? window.ZBX_HOST,
        items: fresh.items ?? {},
        events: fresh.events ?? window.ZBX_EVENTS,
        alerts: fresh.alerts ?? window.ALERTS_SUMMARY,
        wiredPorts: fresh.wiredPorts ?? window.WIRED_PORTS,
        ssids: fresh.ssids ?? window.SSIDS,
        pfClients: fresh.pfClients ?? window.PF_CLIENTS,
        alertsDetail: fresh.alertsDetail ?? window.ALERTS_DETAIL
      });
      recordFetch(true, null, fresh);
      window.dispatchEvent(new CustomEvent("tcs:data", {
        detail: fresh
      }));
    } catch (e) {
      console.warn("[tcs] data refresh failed:", e);
      recordFetch(false, e);
    }
  };

  // Expose a manual refresh so the DebugPanel button works.
  window.tcsDashboardRefresh = tick;

  // PacketFence per-node write actions (Reevaluate access, Restart
  // switchport). Same envelope as the switch-page helper of the same
  // name: returns { ok, message? } on success, { ok:false, error }
  // otherwise. Backend (tcs.pf.device) is admin-gated.
  window.tcsPfDeviceAction = async function (mac, op) {
    const actionUrl = window.TCS_PF_DEVICE_URL;
    const hostid = window.ZBX_HOST && window.ZBX_HOST.hostid;
    if (!actionUrl || !hostid) return {
      ok: false,
      error: "endpoint not configured"
    };
    if (!mac || !op) return {
      ok: false,
      error: "mac and op required"
    };
    // PF API matches MACs case-sensitively in path-style endpoints —
    // force lowercase here so callers don't have to remember.
    const pfMac = String(mac).toLowerCase();
    try {
      const form = new URLSearchParams({
        hostid: String(hostid),
        mac: pfMac,
        op: String(op)
      });
      const resp = await fetch(actionUrl, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Accept": "application/json",
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"
        },
        body: form.toString()
      });
      const body = await resp.json().catch(() => ({}));
      if (!resp.ok) return {
        ok: false,
        error: body.error || `HTTP ${resp.status}`
      };
      return body;
    } catch (e) {
      return {
        ok: false,
        error: String(e && e.message ? e.message : e)
      };
    }
  };

  // Cycle PoE on the AP's upstream switch port. Same backend as the
  // switches page (tcs.switch.cyclepoe) — but on the AP page we don't
  // know about TCS_SWITCH_HOSTID, so the caller passes the resolved
  // switch hostid in directly. The action uses that host's
  // {$RCONFIG.*} macros to look up the rConfig device + snippet.
  window.tcsCyclePoeOnSwitch = async function (switchHostid, member, port) {
    const actionUrl = window.TCS_SWITCH_CYCLEPOE_URL;
    if (!actionUrl) return {
      ok: false,
      error: "endpoint not configured"
    };
    if (!switchHostid) return {
      ok: false,
      error: "upstream switch unknown"
    };
    if (!member || !port) return {
      ok: false,
      error: "bad port"
    };
    try {
      const form = new URLSearchParams({
        hostid: String(switchHostid),
        member: String(Number(member) || 1),
        port: String(Number(port) || 0)
      });
      const resp = await fetch(actionUrl, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Accept": "application/json",
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"
        },
        body: form.toString()
      });
      const body = await resp.json().catch(() => ({}));
      if (!resp.ok) return {
        ok: false,
        error: body.error || `HTTP ${resp.status}`
      };
      return body;
    } catch (e) {
      return {
        ok: false,
        error: String(e && e.message ? e.message : e)
      };
    }
  };

  // Reboot the current AP via XIQ. Resolves the host's {$XIQ_DEVICE_ID}
  // server-side and issues POST /devices/:reboot. Same envelope as the
  // other write helpers: { ok, message? } / { ok:false, error }.
  window.tcsXiqRebootAp = async function () {
    const actionUrl = window.TCS_XIQ_REBOOT_URL;
    const hid = window.ZBX_HOST && window.ZBX_HOST.hostid;
    if (!actionUrl) return {
      ok: false,
      error: "endpoint not configured"
    };
    if (!hid) return {
      ok: false,
      error: "no hostid"
    };
    try {
      const form = new URLSearchParams({
        hostid: String(hid)
      });
      const resp = await fetch(actionUrl, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Accept": "application/json",
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"
        },
        body: form.toString()
      });
      const body = await resp.json().catch(() => ({}));
      if (!resp.ok) return {
        ok: false,
        error: body.error || `HTTP ${resp.status}`
      };
      return body;
    } catch (e) {
      return {
        ok: false,
        error: String(e && e.message ? e.message : e)
      };
    }
  };
  if (hostid && url) {
    setInterval(tick, REFRESH_MS);
  }
})();