// camera-bridge.jsx
//
// Live-data bridge for the Camera Detail page. Reads window.CAMERA_BOOT
// (server-collected by ActionSurveillanceData::collectCameraDetail and
// embedded by camera.view.php) and publishes the window globals that
// nvr-camera.jsx consumes: CAMERAS (single-element list), CAM_HISTORY,
// CAM_EVENTS. Polls window.TCS_CAMERA_DATA_URL on an interval so the page
// stays fresh without a reload.
//
// This file replaces nvr-data.jsx as the sole source of those globals on
// the Camera Detail page. Untemplated fields land as null / "—" / empty
// arrays so the JSX renders honest placeholders instead of mock values.

(function () {
  const isNum = v => typeof v === "number" && !Number.isNaN(v);
  const num = (v, dflt = 0) => isNum(v) ? v : isNum(Number(v)) ? Number(v) : dflt;
  const str = (v, dflt = "—") => v === null || v === undefined || v === "" ? dflt : String(v);
  const HISTORY_KEYS = ["fps", "bitrate", "packetLoss", "motion", "cpu", "mem", "temp", "latency"];
  const zerosArray = n => {
    const a = new Array(n);
    for (let i = 0; i < n; i++) a[i] = 0;
    return a;
  };
  const emptyHistory = () => {
    const out = {};
    for (const k of HISTORY_KEYS) out[k] = zerosArray(48);
    return out;
  };

  // Camera-state mapping mirrors surveillance-bridge: the JSX expects
  // "ok" / "warn" / "err"; fold disabled+unknown into "err".
  const mapCamState = s => {
    if (s === "ok" || s === "warn" || s === "err") return s;
    if (s === "disabled" || s === "unknown") return "err";
    return "ok";
  };
  const normCamera = c => {
    if (!c || typeof c !== "object") return null;
    return {
      id: str(c.id, "—"),
      name: str(c.name, c.id || "—"),
      site: str(c.site, "—"),
      loc: str(c.loc || c.name, c.id || "—"),
      model: str(c.model, "—"),
      res: str(c.res, "—"),
      fps: num(c.fps),
      bitrate: num(c.bitrate),
      codec: str(c.codec, "—"),
      recording: str(c.recording, "—"),
      state: mapCamState(c.state),
      ip: str(c.ip, "—"),
      mac: str(c.mac, "—"),
      poe: num(c.poe),
      server: str(c.server, "—"),
      motion12h: num(c.motion12h),
      hostid: c.hostid || null,
      warnMsg: c.warnMsg || null,
      errMsg: c.errMsg || null
    };
  };

  // Initialise globals up front so the JSX never sees undefined.
  window.CAMERAS = [];
  window.CAM_HISTORY = emptyHistory();
  window.CAM_EVENTS = [];
  window.CAMERA_UPLINK = null; // { switch, switchHostid, port, ifDesc, switchIp }
  window.CAMERA_PF = null; // { mac, ip, host, role, reg, lastSeen, vendor, … }
  window.PF_ADMIN_BASE = "";
  const applyBoot = boot => {
    if (!boot || typeof boot !== "object") return;
    const cam = normCamera(boot.camera);
    window.CAMERAS = cam ? [cam] : [];
    const base = emptyHistory();
    const bh = boot.history && typeof boot.history === "object" ? boot.history : {};
    for (const k of HISTORY_KEYS) {
      const v = bh[k];
      if (Array.isArray(v) && v.length) base[k] = v;
    }
    window.CAM_HISTORY = base;
    window.CAM_EVENTS = Array.isArray(boot.events) ? boot.events.map(e => ({
      ts: str(e.ts, ""),
      src: str(e.src, "ZBX"),
      sev: e.sev || "info",
      msg: str(e.msg, "")
    })) : [];

    // PacketFence enrichment: uplink switch+port, node info, admin URL.
    window.CAMERA_UPLINK = boot.pfUplink && typeof boot.pfUplink === "object" ? boot.pfUplink : null;
    window.CAMERA_PF = boot.pfDevice && typeof boot.pfDevice === "object" ? boot.pfDevice : null;
    if (boot.pfAdmin) window.PF_ADMIN_BASE = String(boot.pfAdmin);
  };
  applyBoot(window.CAMERA_BOOT);
  const REFRESH_MS = 30_000;
  const baseUrl = window.TCS_CAMERA_DATA_URL;
  const hostid = window.CAMERA_HOSTID || "";
  if (!baseUrl || !hostid) return;
  const url = baseUrl + (baseUrl.includes("?") ? "&" : "?") + "hostid=" + encodeURIComponent(hostid);
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
      window.dispatchEvent(new CustomEvent("tcs:camera-data", {
        detail: fresh
      }));
    } catch (e) {
      console.warn("[tcs] camera refresh failed:", e);
    }
  };
  window.tcsCameraRefresh = tick;
  setInterval(tick, REFRESH_MS);

  // PacketFence per-node write actions (Reevaluate access, Restart
  // switchport). Same envelope and backend (tcs.pf.device) the switches /
  // AP page use; we just bind it on the camera page too so the action row
  // can call it without the data-bridge polling loop coming along.
  window.tcsPfDeviceAction = async function (mac, op) {
    const actionUrl = window.TCS_PF_DEVICE_URL;
    const hid = window.CAMERA_HOSTID || "";
    if (!actionUrl || !hid) return {
      ok: false,
      error: "endpoint not configured"
    };
    if (!mac || !op) return {
      ok: false,
      error: "mac and op required"
    };
    const pfMac = String(mac).toLowerCase();
    try {
      const form = new URLSearchParams({
        hostid: String(hid),
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

  // Cycle PoE on the camera's upstream switch port via tcs.switch.cyclepoe.
  // The action uses the switch host's {$RCONFIG.*} macros to drive the
  // PoE off/on snippet, so we pass the resolved switch hostid + port here.
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
})();