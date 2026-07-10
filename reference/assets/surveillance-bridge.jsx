// surveillance-bridge.jsx
//
// Live-data bridge for the Surveillance NOC view. Reads
// window.SURVEILLANCE_BOOT (server-collected by ActionSurveillanceData)
// and publishes the window globals that nvr-overview.jsx / nvr-app.jsx
// consume: MILESTONE, SITES, SERVERS, CAMERAS, VMS_ALARMS, FLEET_HISTORY.
//
// Loading is staged: the page fires four parallel fetches against
// tcs.surveillance.data?stage=... so the cheap pieces (header tiles +
// sites grid + alarms) paint long before the expensive per-camera and
// 24h-event rollups land. Each stage updates its slice of state in
// place and dispatches "tcs:surveillance-data" with the stage label so
// the React tree re-renders progressively.

(function () {
    const isNum = (v) => typeof v === "number" && !Number.isNaN(v);
    const num   = (v, dflt = 0) => (isNum(v) ? v : (isNum(Number(v)) ? Number(v) : dflt));
    const str   = (v, dflt = "—") => (v === null || v === undefined || v === "" ? dflt : String(v));

    // ── Empty defaults — what every global looks like before boot/poll ──
    const EMPTY_MILESTONE = {
        product:                "—",
        version:                "—",
        managementServer:       "—",
        smtpRouted:             false,
        licenseDeviceTotal:     0,
        licenseDeviceUsed:      0,
        licenseHwTotal:         0,
        recordingServers:       0,
        recordingServersOnline: 0,
        failoverServers:        0,
        mobileServers:          0,
        smartClientSessions:    0,
        webClientSessions:      0,
        activeAlarms:           0,
        alarmsAck:              0,
        retentionDays:          0,
        storageTotalTB:         0,
        storageUsedTB:          0,
        evidenceLockSlots:      0,
        evidenceLockUsed:       0
    };

    const EMPTY_HISTORY_KEYS = [
        "totalIngressGbps", "storageWriteMBps", "recordingServersCpu",
        "camerasOnline", "alarmsPerHour", "archiveLagMin"
    ];

    const zerosArray = (n) => {
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
    const mapCamState = (s) => {
        if (s === "ok" || s === "warn" || s === "err") return s;
        if (s === "disabled" || s === "unknown") return "err";
        return "ok";
    };

    // Initialise all globals up front so the JSX never sees undefined.
    window.MILESTONE      = Object.assign({}, EMPTY_MILESTONE);
    window.SITES          = [];
    window.SERVERS        = [];
    window.CAMERAS        = [];
    window.VMS_ALARMS     = [];
    window.FLEET_HISTORY  = emptyHistory();
    // Not yet templated on the backend — kept empty so the
    // Sites / Evidence Lock tabs render an honest empty state.
    window.SITE_DETAILS   = {};
    window.EVIDENCE_LOCKS = [];

    // ── Per-key appliers ──────────────────────────────────────────────
    // Each one writes one global from a partial payload. A stage that
    // doesn't carry a key just doesn't call the applier, so a "cameras"
    // response can't blank out SITES from the prior "summary" response.
    const applyMilestone = (m) => {
        m = m || {};
        window.MILESTONE = {
            product:                str(m.product, EMPTY_MILESTONE.product),
            version:                str(m.version, EMPTY_MILESTONE.version),
            managementServer:       str(m.managementServer, EMPTY_MILESTONE.managementServer),
            smtpRouted:             !!m.smtpRouted,
            licenseDeviceTotal:     num(m.licenseDeviceTotal),
            licenseDeviceUsed:      num(m.licenseDeviceUsed),
            licenseHwTotal:         num(m.licenseHwTotal),
            recordingServers:       num(m.recordingServers),
            recordingServersOnline: num(m.recordingServersOnline),
            failoverServers:        num(m.failoverServers),
            mobileServers:          num(m.mobileServers),
            smartClientSessions:    num(m.smartClientSessions),
            webClientSessions:      num(m.webClientSessions),
            activeAlarms:           num(m.activeAlarms),
            alarmsAck:              num(m.alarmsAck),
            retentionDays:          num(m.retentionDays),
            storageTotalTB:         num(m.storageTotalTB),
            storageUsedTB:          num(m.storageUsedTB),
            evidenceLockSlots:      num(m.evidenceLockSlots),
            evidenceLockUsed:       num(m.evidenceLockUsed)
        };
    };

    const applySites = (sites) => {
        window.SITES = (Array.isArray(sites) ? sites : []).map(s => ({
            name:         str(s.name, "—"),
            cams:         num(s.cams),
            online:       num(s.online),
            warn:         num(s.warn),
            err:          num(s.err),
            hwCount:      num(s.hwCount),
            server:       str(s.server, "—"),
            storageGB:    num(s.storageGB),
            storageCapGB: num(s.storageCapGB, 1) || 1,
            retentionMin: num(s.retentionMin),
            cameraIds:    Array.isArray(s.cameraIds) ? s.cameraIds : []
        }));
    };

    const applyServers = (servers) => {
        window.SERVERS = (Array.isArray(servers) ? servers : []).map(s => ({
            id:           str(s.id, "—"),
            rsid:         s.rsid || null,
            site:         str(s.site, "—"),
            role:         str(s.role, "Recording Server"),
            os:           str(s.os, "—"),
            model:        str(s.model, "—"),
            serial:       str(s.serial, ""),
            firmware:     str(s.firmware, ""),
            cpu:          num(s.cpu),
            mem:          num(s.mem),
            disk:         num(s.disk),
            raid:         s.raid || "unknown",
            hwStatus:     s.hwStatus || null,
            svcState:     s.svcState || null,
            chans:        num(s.chans),
            hwDevices:    num(s.hwDevices),
            storageTotalGB: num(s.storageTotalGB),
            storageUsedGB:  num(s.storageUsedGB),
            retentionMin:   num(s.retentionMin),
            recording:    num(s.recording),
            archiveLagH:  num(s.archiveLagH),
            agent:        str(s.agent, "—"),
            ip:           str(s.ip, "—"),
            uptimeD:      num(s.uptimeD),
            lastBackup:   str(s.lastBackup, "—"),
            state:        s.state || "ok",
            handshakeAge: num(s.handshakeAge),
            agentHostid:  s.agentHostid || null
        }));
    };

    const applyCameras = (cameras) => {
        window.CAMERAS = (Array.isArray(cameras) ? cameras : []).map(c => ({
            id:        str(c.id, "—"),
            site:      str(c.site, "—"),
            group:     str(c.group, c.site || "—"),
            loc:       str(c.loc || c.name, c.id || "—"),
            model:     str(c.model, "—"),
            res:       str(c.res, "—"),
            fps:       num(c.fps),
            bitrate:   num(c.bitrate),
            codec:     str(c.codec, "—"),
            recording: str(c.recording, "—"),
            state:     mapCamState(c.state),
            ip:        str(c.ip, ""),
            mac:       str(c.mac, ""),
            poe:       num(c.poe),
            server:    str(c.server, ""),
            motion12h: num(c.motion12h),
            hostid:    c.hostid || null,
            warnMsg:   c.warnMsg || null,
            errMsg:    c.errMsg  || null
        }));
    };

    const applyAlarms = (alarms) => {
        window.VMS_ALARMS = (Array.isArray(alarms) ? alarms : []).map(a => ({
            ts:     str(a.ts, ""),
            sev:    a.sev || "info",
            cam:    str(a.cam, "—"),
            hostid: a.hostid || null,
            msg:    str(a.msg, ""),
            site:   str(a.site, ""),
            ack:    !!a.ack
        }));
    };

    const applyHistory = (fleetHistory) => {
        const base = emptyHistory();
        const bh = fleetHistory && typeof fleetHistory === "object" ? fleetHistory : {};
        for (const k of EMPTY_HISTORY_KEYS) {
            const v = bh[k];
            if (Array.isArray(v) && v.length) base[k] = v;
        }
        window.FLEET_HISTORY = base;
    };

    // applyBoot — only writes keys actually present on the payload, so a
    // partial (staged) response doesn't clobber the other globals.
    const applyBoot = (boot) => {
        if (!boot || typeof boot !== "object") return;
        if (boot.milestone     !== undefined) applyMilestone(boot.milestone);
        if (boot.sites         !== undefined) applySites(boot.sites);
        if (boot.servers       !== undefined) applyServers(boot.servers);
        if (boot.cameras       !== undefined) applyCameras(boot.cameras);
        if (boot.alarms        !== undefined) applyAlarms(boot.alarms);
        if (boot.fleetHistory  !== undefined) applyHistory(boot.fleetHistory);
        if (boot.siteDetails   && typeof boot.siteDetails === "object") {
            window.SITE_DETAILS = boot.siteDetails;
        }
        if (Array.isArray(boot.evidenceLocks)) {
            window.EVIDENCE_LOCKS = boot.evidenceLocks;
        }
    };

    // ── Stage tracking ────────────────────────────────────────────────
    // The four stages the backend exposes. "summary" is the gate: once
    // it lands the page can render the header / sites / alarms and the
    // boot splash drops. The other stages backfill as they arrive.
    const STAGES = ["summary", "cameras", "servers", "history"];
    const STAGE_LABELS = {
        summary: "Loading fleet summary",
        cameras: "Loading cameras",
        servers: "Loading recording servers",
        history: "Loading 24h history"
    };

    const initialStageState = () => {
        const s = {};
        for (const k of STAGES) s[k] = "pending";  // pending | done | error
        return s;
    };
    window.SURVEILLANCE_STAGES = initialStageState();

    const boot = window.SURVEILLANCE_BOOT || {};
    window.SURVEILLANCE_LOADING = !boot || boot.async === true || !boot.milestone;
    applyBoot(window.SURVEILLANCE_BOOT);

    const REFRESH_MS = 30_000;
    const url = window.TCS_SURVEILLANCE_DATA_URL;
    if (!url) return;

    const stageUrl = (stage) =>
        url + (url.indexOf("?") >= 0 ? "&" : "?") + "stage=" + encodeURIComponent(stage);

    const dispatch = (stage, payload) => {
        window.dispatchEvent(new CustomEvent("tcs:surveillance-data", {
            detail: { stage, payload }
        }));
    };

    const fetchStage = async (stage) => {
        try {
            const resp = await fetch(stageUrl(stage), {
                credentials: "same-origin",
                headers: { "Accept": "application/json" }
            });
            if (!resp.ok) {
                window.SURVEILLANCE_STAGES[stage] = "error";
                dispatch(stage, null);
                return;
            }
            const data = await resp.json();
            applyBoot(data);
            window.SURVEILLANCE_STAGES[stage] = "done";
            // Summary lands → page can render; later stages fill in.
            if (stage === "summary") window.SURVEILLANCE_LOADING = false;
            dispatch(stage, data);
        } catch (e) {
            console.warn(`[tcs] surveillance ${stage} failed:`, e);
            window.SURVEILLANCE_STAGES[stage] = "error";
            dispatch(stage, null);
        }
    };

    const tick = async () => {
        window.SURVEILLANCE_STAGES = initialStageState();
        // Don't re-trigger the splash on the periodic poll — only the first
        // load (no milestone yet) keeps SURVEILLANCE_LOADING true.
        dispatch("start", null);
        await Promise.all(STAGES.map(fetchStage));
        // Guarantee the loading flag is cleared even if "summary" errored
        // (we still want the page to render its empty shell + the error
        // state on each stage chip).
        window.SURVEILLANCE_LOADING = false;
        dispatch("complete", null);
    };

    window.tcsSurveillanceRefresh = tick;
    window.TCS_SURVEILLANCE_STAGE_LABELS = STAGE_LABELS;
    // Kick off the first set of fetches immediately (after first paint),
    // then poll every 30s.
    tick();
    setInterval(tick, REFRESH_MS);
})();
