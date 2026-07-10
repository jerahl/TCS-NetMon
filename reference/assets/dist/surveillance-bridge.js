// surveillance-bridge.jsx
//
// Live-data bridge for the Surveillance NOC view. Reads
// window.SURVEILLANCE_BOOT (server-collected by ActionSurveillanceData)
// and publishes the window globals that nvr-overview.jsx / nvr-app.jsx
// consume: MILESTONE, SITES, SERVERS, CAMERAS, VMS_ALARMS, FLEET_HISTORY.
//
// This file is now the SOLE source of those globals on the Overview
// page — nvr-data.jsx (mock baseline) is no longer loaded by
// surveillance.view.php. Every key gets a numeric / array / string
// default so the JSX renders zero / "—" rather than crashing on
// undefined when the backend has nothing yet for a field.

(function () {
  const isNum = v => typeof v === "number" && !Number.isNaN(v);
  const num = (v, dflt = 0) => isNum(v) ? v : isNum(Number(v)) ? Number(v) : dflt;
  const str = (v, dflt = "—") => v === null || v === undefined || v === "" ? dflt : String(v);

  // ── Empty defaults — what every global looks like before boot/poll ──
  const EMPTY_MILESTONE = {
    product: "—",
    version: "—",
    managementServer: "—",
    smtpRouted: false,
    licenseDeviceTotal: 0,
    licenseDeviceUsed: 0,
    licenseHwTotal: 0,
    recordingServers: 0,
    recordingServersOnline: 0,
    failoverServers: 0,
    mobileServers: 0,
    smartClientSessions: 0,
    webClientSessions: 0,
    activeAlarms: 0,
    alarmsAck: 0,
    retentionDays: 0,
    storageTotalTB: 0,
    storageUsedTB: 0,
    evidenceLockSlots: 0,
    evidenceLockUsed: 0
  };
  const EMPTY_HISTORY_KEYS = ["totalIngressGbps", "storageWriteMBps", "recordingServersCpu", "camerasOnline", "alarmsPerHour", "archiveLagMin"];
  const zerosArray = n => {
    const a = new Array(n);
    for (let i = 0; i < n; i++) a[i] = 0;
    return a;
  };
  const emptyHistory = () => {
    const out = {};
    for (const k of EMPTY_HISTORY_KEYS) out[k] = zerosArray(48);
    return out;
  };

  // Camera-state mapping: the JSX expects "ok" / "warn" / "err".
  // ActionSurveillanceData emits "ok" / "warn" / "err" / "disabled" /
  // "unknown" — fold disabled+unknown into "err" so the offline tint
  // shows for anything that isn't actively recording.
  const mapCamState = s => {
    if (s === "ok" || s === "warn" || s === "err") return s;
    if (s === "disabled" || s === "unknown") return "err";
    return "ok";
  };

  // Initialise all globals up front so the JSX never sees undefined.
  window.MILESTONE = Object.assign({}, EMPTY_MILESTONE);
  window.SITES = [];
  window.SERVERS = [];
  window.CAMERAS = [];
  window.VMS_ALARMS = [];
  window.FLEET_HISTORY = emptyHistory();
  // Not yet templated on the backend — kept empty so the
  // Sites / Evidence Lock tabs render an honest empty state.
  window.SITE_DETAILS = {};
  window.EVIDENCE_LOCKS = [];
  const applyBoot = boot => {
    if (!boot || typeof boot !== "object") return;

    // ── MILESTONE summary ─────────────────────────────────────────
    const m = boot.milestone || {};
    window.MILESTONE = {
      product: str(m.product, EMPTY_MILESTONE.product),
      version: str(m.version, EMPTY_MILESTONE.version),
      managementServer: str(m.managementServer, EMPTY_MILESTONE.managementServer),
      smtpRouted: !!m.smtpRouted,
      licenseDeviceTotal: num(m.licenseDeviceTotal),
      licenseDeviceUsed: num(m.licenseDeviceUsed),
      licenseHwTotal: num(m.licenseHwTotal),
      recordingServers: num(m.recordingServers),
      recordingServersOnline: num(m.recordingServersOnline),
      failoverServers: num(m.failoverServers),
      mobileServers: num(m.mobileServers),
      smartClientSessions: num(m.smartClientSessions),
      webClientSessions: num(m.webClientSessions),
      activeAlarms: num(m.activeAlarms),
      alarmsAck: num(m.alarmsAck),
      retentionDays: num(m.retentionDays),
      storageTotalTB: num(m.storageTotalTB),
      storageUsedTB: num(m.storageUsedTB),
      evidenceLockSlots: num(m.evidenceLockSlots),
      evidenceLockUsed: num(m.evidenceLockUsed)
    };

    // ── SITES ─────────────────────────────────────────────────────
    window.SITES = (Array.isArray(boot.sites) ? boot.sites : []).map(s => ({
      name: str(s.name, "—"),
      cams: num(s.cams),
      online: num(s.online),
      warn: num(s.warn),
      err: num(s.err),
      hwCount: num(s.hwCount),
      server: str(s.server, "—"),
      // Default capacity to 1 so percent-of math doesn't divide by zero.
      storageGB: num(s.storageGB),
      storageCapGB: num(s.storageCapGB, 1) || 1,
      // Shortest retention across this site's RSs, in minutes.
      // Published by buildSitesByGroup when the RS extras template
      // is linked; 0 when no per-RS retention is templated yet.
      retentionMin: num(s.retentionMin),
      // Camera GUIDs in this site/group — drives the Cameras tab
      // navigator's per-group bucketing.
      cameraIds: Array.isArray(s.cameraIds) ? s.cameraIds : []
    }));

    // ── SERVERS (recording servers) ───────────────────────────────
    window.SERVERS = (Array.isArray(boot.servers) ? boot.servers : []).map(s => ({
      id: str(s.id, "—"),
      rsid: s.rsid || null,
      site: str(s.site, "—"),
      role: str(s.role, "Recording Server"),
      os: str(s.os, "—"),
      model: str(s.model, "—"),
      serial: str(s.serial, ""),
      firmware: str(s.firmware, ""),
      cpu: num(s.cpu),
      mem: num(s.mem),
      disk: num(s.disk),
      // iDRAC-driven RAID / hardware indicator: ok | warn | err | unknown.
      raid: s.raid || "unknown",
      hwStatus: s.hwStatus || null,
      // Milestone-reported service state (from the RS extras
      // template's milestone.rs.state[<id>]). Null if not linked.
      svcState: s.svcState || null,
      chans: num(s.chans),
      hwDevices: num(s.hwDevices),
      storageTotalGB: num(s.storageTotalGB),
      storageUsedGB: num(s.storageUsedGB),
      retentionMin: num(s.retentionMin),
      recording: num(s.recording),
      archiveLagH: num(s.archiveLagH),
      agent: str(s.agent, "—"),
      ip: str(s.ip, "—"),
      uptimeD: num(s.uptimeD),
      lastBackup: str(s.lastBackup, "—"),
      state: s.state || "ok",
      handshakeAge: num(s.handshakeAge),
      agentHostid: s.agentHostid || null
    }));

    // ── CAMERAS ───────────────────────────────────────────────────
    window.CAMERAS = (Array.isArray(boot.cameras) ? boot.cameras : []).map(c => ({
      id: str(c.id, "—"),
      site: str(c.site, "—"),
      group: str(c.group, c.site || "—"),
      loc: str(c.loc || c.name, c.id || "—"),
      model: str(c.model, "—"),
      res: str(c.res, "—"),
      fps: num(c.fps),
      bitrate: num(c.bitrate),
      codec: str(c.codec, "—"),
      recording: str(c.recording, "—"),
      state: mapCamState(c.state),
      ip: str(c.ip, ""),
      mac: str(c.mac, ""),
      poe: num(c.poe),
      server: str(c.server, ""),
      motion12h: num(c.motion12h),
      hostid: c.hostid || null,
      warnMsg: c.warnMsg || null,
      errMsg: c.errMsg || null
    }));

    // ── FLEET_HISTORY (24h sparklines) ────────────────────────────
    // Per-key: any non-null/non-empty array from the backend lands
    // directly; everything else keeps the zero baseline so the
    // SVG charts still have something to draw.
    const baseHistory = emptyHistory();
    const bh = boot.fleetHistory && typeof boot.fleetHistory === "object" ? boot.fleetHistory : {};
    for (const k of EMPTY_HISTORY_KEYS) {
      const v = bh[k];
      if (Array.isArray(v) && v.length) baseHistory[k] = v;
    }
    window.FLEET_HISTORY = baseHistory;

    // ── VMS_ALARMS ────────────────────────────────────────────────
    window.VMS_ALARMS = (Array.isArray(boot.alarms) ? boot.alarms : []).map(a => ({
      ts: str(a.ts, ""),
      sev: a.sev || "info",
      cam: str(a.cam, "—"),
      hostid: a.hostid || null,
      msg: str(a.msg, ""),
      site: str(a.site, ""),
      ack: !!a.ack
    }));

    // ── SITE_DETAILS / EVIDENCE_LOCKS (pass through if backend supplies) ──
    if (boot.siteDetails && typeof boot.siteDetails === "object") {
      window.SITE_DETAILS = boot.siteDetails;
    }
    if (Array.isArray(boot.evidenceLocks)) {
      window.EVIDENCE_LOCKS = boot.evidenceLocks;
    }
  };

  // The page now loads with an empty/async boot (the heavy fleet collect
  // moved to the tcs.surveillance.data endpoint to keep TTFB low). Mark the
  // app as loading until the first fetch lands so it can show a spinner
  // instead of an empty shell.
  const boot = window.SURVEILLANCE_BOOT || {};
  window.SURVEILLANCE_LOADING = !boot || boot.async === true || !boot.milestone;
  applyBoot(window.SURVEILLANCE_BOOT);
  const REFRESH_MS = 30_000;
  const url = window.TCS_SURVEILLANCE_DATA_URL;
  if (!url) return;
  const tick = async () => {
    try {
      const resp = await fetch(url, {
        credentials: "same-origin",
        headers: {
          "Accept": "application/json"
        }
      });
      if (!resp.ok) return;
      const fresh = await resp.json();
      applyBoot(fresh);
      window.SURVEILLANCE_LOADING = false;
      window.dispatchEvent(new CustomEvent("tcs:surveillance-data", {
        detail: fresh
      }));
    } catch (e) {
      console.warn("[tcs] surveillance refresh failed:", e);
      // Don't strand the page on the loading splash — drop the flag and
      // re-render into the (empty) shell; the next poll will retry.
      window.SURVEILLANCE_LOADING = false;
      window.dispatchEvent(new CustomEvent("tcs:surveillance-data", {
        detail: null
      }));
    }
  };
  window.tcsSurveillanceRefresh = tick;
  // Kick off the first fetch immediately (after first paint), then poll.
  tick();
  setInterval(tick, REFRESH_MS);
})();