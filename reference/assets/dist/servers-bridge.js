// servers-bridge.jsx
//
// Replaces servers-data.jsx. Reads window.SERVERS_BOOT (inlined by the view)
// and publishes the window globals servers-app.jsx / servers-widgets.jsx
// already consume:
//   - SERVER_SITES, SERVER_PROBLEMS
//   - ACTIVE_SERVER_HISTORY, ACTIVE_SERVER_FS, ACTIVE_SERVER_IFACES,
//     ACTIVE_SERVER_SERVICES, ACTIVE_SERVER_PROCS, ACTIVE_SERVER_SESSIONS
//
// When ?hostid is not provided, the "active" block is empty — the right-hand
// detail panel just renders dashes.

(function () {
  // Widgets call .at(-1).toFixed(2) on these unconditionally, so every
  // series must have at least one numeric element.
  const HISTORY_KEYS = ["cpu1m", "cpu5m", "memUsed", "diskRead", "diskWrite", "netIn", "netOut", "swap", "load1m"];
  const num = (v, dflt = 0) => typeof v === "number" && !isNaN(v) ? v : dflt;
  const normaliseHistory = h => {
    const out = {};
    const src = h || {};
    for (const k of HISTORY_KEYS) {
      const arr = Array.isArray(src[k]) ? src[k] : [];
      out[k] = arr.length ? arr : [0];
    }
    return out;
  };
  const normaliseServer = sv => ({
    ...sv,
    cpu: num(sv.cpu),
    mem: num(sv.mem),
    ram: num(sv.ram),
    cores: num(sv.cores),
    diskTb: num(sv.diskTb),
    diskPct: num(sv.diskPct),
    netMbps: num(sv.netMbps),
    uptimeDays: num(sv.uptimeDays),
    problems: num(sv.problems)
  });
  const normaliseFs = f => ({
    ...f,
    sizeGb: num(f.sizeGb),
    usedPct: num(f.usedPct),
    freeGb: num(f.freeGb),
    latMs: num(f.latMs)
  });
  const normaliseIface = i => ({
    ...i,
    speed: num(i.speed),
    inMbps: num(i.inMbps),
    outMbps: num(i.outMbps),
    errs: num(i.errs)
  });
  const applyBoot = boot => {
    const b = boot || {};
    const sites = Array.isArray(b.sites) ? b.sites : [];
    window.SERVER_SITES = sites.map(s => ({
      ...s,
      servers: Array.isArray(s.servers) ? s.servers.map(normaliseServer) : []
    }));
    window.SERVER_PROBLEMS = Array.isArray(b.problems) ? b.problems : [];
    const active = b.active || {};
    window.ACTIVE_SERVER_HISTORY = normaliseHistory(active.history);
    window.ACTIVE_SERVER_FS = Array.isArray(active.fs) ? active.fs.map(normaliseFs) : [];
    window.ACTIVE_SERVER_IFACES = Array.isArray(active.ifaces) ? active.ifaces.map(normaliseIface) : [];
    window.ACTIVE_SERVER_SERVICES = Array.isArray(active.services) ? active.services : [];
    window.ACTIVE_SERVER_PROCS = Array.isArray(active.procs) ? active.procs : [];
    window.ACTIVE_SERVER_SESSIONS = Array.isArray(active.sessions) ? active.sessions : [];
  };
  applyBoot(window.SERVERS_BOOT);
  window.TWEAK_DEFAULTS = window.TWEAK_DEFAULTS || {
    accent: "#d92929",
    fontMono: "JetBrains Mono",
    density: "comfortable",
    showSourceBadges: true,
    showSidecar: true
  };
  const REFRESH_MS = 30_000;
  const url = window.TCS_SERVERS_DATA_URL;
  if (!url) return;
  let activeHostid = window.SERVERS_HOSTID || "";
  const tick = async () => {
    const fullUrl = activeHostid ? `${url}&hostid=${encodeURIComponent(activeHostid)}` : url;
    try {
      const resp = await fetch(fullUrl, {
        credentials: "same-origin",
        headers: {
          "Accept": "application/json"
        }
      });
      if (!resp.ok) return;
      const fresh = await resp.json();
      applyBoot(fresh);
      window.dispatchEvent(new CustomEvent("tcs:servers-data", {
        detail: fresh
      }));
    } catch (e) {
      console.warn("[tcs] servers refresh failed:", e);
    }
  };

  // Imperative API used by servers-app when the user picks a server in
  // the sidecar — switch active host AND refetch immediately so the
  // Services/Procs/Network tabs populate without waiting 30s.
  window.tcsServersRefresh = tick;
  window.tcsServersSetActive = hostid => {
    const next = String(hostid || "");
    if (next === activeHostid) return;
    activeHostid = next;
    return tick();
  };
  setInterval(tick, REFRESH_MS);
})();