// surveillance-ws.jsx
//
// Live-state bridge for the Surveillance NOC. Companion to
// surveillance-bridge.jsx: that one polls ActionSurveillanceData every 30s
// for inventory + Zabbix-fed state; this one opens a WebSocket directly to
// the Milestone Gateway and applies sub-second state deltas to
// window.CAMERAS / window.SITES.
//
// Trust boundary (Phase 4 brief / rework doc §7):
//   * The VMS password NEVER reaches the browser. ActionSurveillanceData
//     mints a short-lived bearer server-side and ships it in the "summary"
//     stage payload as boot.milestoneWs = {url, token, expiresAt}.
//   * Browser WebSocket can't set headers, so we authenticate in-band:
//       1. open wss://gateway/api/ws/events/v1
//       2. send {command:"authenticate", token:"Bearer <jwt>"}
//       3. send startSession / addSubscription / getState
//   * The 5 camera-level event-type GUIDs match the brief's table and
//     the Phase 2 collector subscription, so the live UI and the
//     unattended monitoring agree on which states matter.
//
// What we DON'T do (deferred):
//   * Background token refresh: the token comes fresh on every 30s
//     surveillance-bridge poll; if the WS is up and we get a new boot
//     payload with a different expiry, we close + reopen with the new
//     token. Cheaper than a separate refresh path.
//   * Camera-wall thumbnails: separate effort (integration plan §3c).
//   * Direct DOM writes: we only mutate window.CAMERAS / window.SITES and
//     dispatch tcs:surveillance-ws-update; the React shell re-renders.

(function () {
    if (window.__TCS_SURVEILLANCE_WS_LOADED__) return;
    window.__TCS_SURVEILLANCE_WS_LOADED__ = true;

    // ── Event-type GUIDs (must match milestone_collector.py EVENT_TYPES) ──
    const COMM_STARTED = "dd3e6464-7dc0-405a-a92f-6150587563e8";
    const COMM_STOPPED = "0ee90664-2924-42a0-a816-4129d0ecabdc";
    const COMM_ERROR   = "a334af1c-4b4b-4957-9e5f-ab8ca07feab6";
    const REC_STARTED  = "4577f552-765a-438c-bc7d-e5ff1f754bc3";
    const REC_STOPPED  = "79a94f89-92de-4fca-8a43-5561d407423d";
    const EVENT_TYPES  = [COMM_STARTED, COMM_STOPPED, COMM_ERROR, REC_STARTED, REC_STOPPED];

    const RECONNECT_INITIAL_MS = 1000;
    const RECONNECT_MAX_MS     = 30000;
    const DISPATCH_THROTTLE_MS = 250;  // batch deltas so React doesn't thrash

    const log = (...a) => { try { console.log("[tcs-ws]", ...a); } catch (e) {} };
    const warn = (...a) => { try { console.warn("[tcs-ws]", ...a); } catch (e) {} };

    // ── State ─────────────────────────────────────────────────────────────
    let ws            = null;
    let cmdSeq        = 0;
    let sessionId     = "";
    let lastEventId   = "";
    let handshake     = null;  // {url, token, expiresAt}
    let reconnectMs   = RECONNECT_INITIAL_MS;
    let reconnectTimer = null;
    let dispatchTimer  = null;
    let dirty          = false;
    let stopped        = false;  // page hidden — don't reconnect
    const pendingReplies = new Map();   // commandId -> resolver
    // per-camera comm + rec state, so a recording change doesn't clobber
    // a comm change applied a second earlier.
    const camLastState = new Map();     // camGuid -> {comm: type, rec: type}

    // ── Dispatch helpers ─────────────────────────────────────────────────
    const markDirty = () => {
        dirty = true;
        if (dispatchTimer) return;
        dispatchTimer = setTimeout(() => {
            dispatchTimer = null;
            if (!dirty) return;
            dirty = false;
            recomputeSiteRollups();
            try {
                window.dispatchEvent(new CustomEvent("tcs:surveillance-ws-update"));
            } catch (e) {}
        }, DISPATCH_THROTTLE_MS);
    };

    // ── Camera lookup — events identify cameras by GUID; window.CAMERAS
    //    items already carry id = Milestone GUID (ActionSurveillanceData
    //    sets it from the per-camera item key). Rebuild the index whenever
    //    surveillance-bridge replaces the array.
    let camIndex = new Map();
    const rebuildCamIndex = () => {
        camIndex = new Map();
        const arr = Array.isArray(window.CAMERAS) ? window.CAMERAS : [];
        for (const c of arr) {
            if (c && c.id) camIndex.set(String(c.id), c);
        }
    };

    // ── Camera state mapping ─────────────────────────────────────────────
    // Translate the comm + rec type GUIDs we've seen for this camera into
    // the {ok, warn, err} string the JSX shell renders. Errors win over
    // warnings; "rec stopped on an otherwise-healthy camera" is a warn.
    const computeCamState = (commType, recType) => {
        if (commType === COMM_STOPPED || commType === COMM_ERROR) return "err";
        if (recType === REC_STOPPED) return "warn";
        return "ok";
    };

    const applyStateEntry = (entry) => {
        const src = String(entry && entry.source || "");
        if (!src.startsWith("cameras/")) return;
        const guid = src.slice("cameras/".length);
        if (!guid) return;
        const cam = camIndex.get(guid);
        if (!cam) return;  // a camera we don't render — ignore silently
        const t   = String(entry.type || "");
        const ts  = entry.time;

        const prev = camLastState.get(guid) || { comm: null, rec: null };
        if (t === COMM_STARTED || t === COMM_STOPPED || t === COMM_ERROR) {
            prev.comm = t;
        } else if (t === REC_STARTED || t === REC_STOPPED) {
            prev.rec = t;
        } else {
            return;  // event type outside our subscription — defence-in-depth
        }
        camLastState.set(guid, prev);

        const newState = computeCamState(prev.comm, prev.rec);
        const changed  = cam.state !== newState;
        cam.state      = newState;
        // Clear the canned mock messages now that we have authoritative state.
        if (newState === "err") {
            cam.errMsg  = t === COMM_ERROR ? "Communication error (live)"
                        : t === COMM_STOPPED ? "Camera offline (live)"
                        : cam.errMsg;
            cam.warnMsg = undefined;
        } else if (newState === "warn") {
            cam.warnMsg = "Recording stopped (live)";
            cam.errMsg  = undefined;
        } else {
            cam.errMsg  = undefined;
            cam.warnMsg = undefined;
        }
        cam.liveStateTs = ts || null;
        if (changed) markDirty();
        else dirty = true;  // still mark for next tick, but no extra timer cost
    };

    // ── Site rollup recompute — runs once per throttle tick, not per event ─
    const recomputeSiteRollups = () => {
        const cams  = Array.isArray(window.CAMERAS) ? window.CAMERAS : [];
        const sites = Array.isArray(window.SITES)   ? window.SITES   : [];
        if (!sites.length) return;
        const tally = new Map();  // site name -> {online, warn, err}
        for (const c of cams) {
            const k = String(c.site || "");
            if (!k) continue;
            const t = tally.get(k) || { online: 0, warn: 0, err: 0 };
            if (c.state === "ok")        { t.online++; }
            else if (c.state === "warn") { t.online++; t.warn++; }
            else if (c.state === "err")  { t.err++; }
            tally.set(k, t);
        }
        for (const s of sites) {
            const t = tally.get(String(s.name));
            if (!t) continue;
            s.online = t.online;
            s.warn   = t.warn;
            s.err    = t.err;
        }
    };

    // ── WS protocol helpers ──────────────────────────────────────────────
    const send = (obj) => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return null;
        const commandId = ++cmdSeq;
        obj.commandId = commandId;
        ws.send(JSON.stringify(obj));
        return new Promise((resolve, reject) => {
            pendingReplies.set(commandId, { resolve, reject });
            // 60s ceiling per command (getState can be tens of seconds at
            // fleet scale, but the browser doesn't see the full Milestone
            // population — only the cameras already in window.CAMERAS).
            setTimeout(() => {
                const r = pendingReplies.get(commandId);
                if (r) {
                    pendingReplies.delete(commandId);
                    r.reject(new Error("ws command timeout cid=" + commandId));
                }
            }, 60000);
        });
    };

    const handleMessage = (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch (e) { return; }

        // Response to a command we sent.
        if (msg.commandId && pendingReplies.has(msg.commandId)) {
            const r = pendingReplies.get(msg.commandId);
            pendingReplies.delete(msg.commandId);
            r.resolve(msg);
            return;
        }

        // Unsolicited: either a baseline-state envelope or an event batch.
        // The protocol uses {states:[...]} for getState and {events:[...]}
        // for streaming deltas; we handle both the same way.
        const entries = msg.states || msg.events;
        if (Array.isArray(entries) && entries.length) {
            for (const e of entries) applyStateEntry(e);
            const tail = entries[entries.length - 1];
            if (tail && tail.id) lastEventId = String(tail.id);
        }
    };

    // ── Connect / reconnect ──────────────────────────────────────────────
    const scheduleReconnect = () => {
        if (stopped || reconnectTimer) return;
        const wait = reconnectMs;
        reconnectMs = Math.min(reconnectMs * 2, RECONNECT_MAX_MS);
        log("reconnect in", wait, "ms");
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connect();
        }, wait);
    };

    const closeWs = () => {
        if (!ws) return;
        try { ws.close(); } catch (e) {}
        ws = null;
        pendingReplies.clear();
    };

    const connect = async () => {
        if (stopped) return;
        if (!handshake || !handshake.url || !handshake.token) {
            log("no handshake yet; waiting for summary stage");
            return;
        }
        // Token expired in our pocket — bail; the next 30s poll will refresh.
        if (handshake.expiresAt && Date.now() / 1000 > handshake.expiresAt - 5) {
            log("token expired before connect; waiting for refresh");
            return;
        }
        rebuildCamIndex();
        try {
            ws = new WebSocket(handshake.url);
        } catch (e) {
            warn("WebSocket construct failed:", e);
            scheduleReconnect();
            return;
        }
        ws.onmessage = (ev) => handleMessage(ev.data);
        ws.onerror   = (e)  => warn("ws error:", e);
        ws.onclose   = (e)  => {
            log("ws closed", e && e.code);
            closeWs();
            if (!stopped) scheduleReconnect();
        };
        ws.onopen = async () => {
            try {
                // 1) authenticate (in-band, because browsers can't set headers)
                const auth = await send({
                    command: "authenticate",
                    token:   "Bearer " + handshake.token,
                });
                if (!auth || (auth.status && auth.status >= 400)) {
                    throw new Error("authenticate failed: " + JSON.stringify(auth));
                }

                // 2) startSession — resume if we have ids, else fresh.
                const start = await send({
                    command:   "startSession",
                    sessionId: sessionId,
                    eventId:   lastEventId,
                });
                if (!start || (start.status !== 200 && start.status !== 201)) {
                    throw new Error("startSession failed: " + JSON.stringify(start));
                }
                if (start.sessionId) sessionId = String(start.sessionId);
                const fresh = start.status === 201;
                log("session", fresh ? "new" : "resumed", sessionId.slice(0, 8));

                if (fresh) {
                    // 3) subscribe to the 5 camera-level GUIDs
                    const sub = await send({
                        command: "addSubscription",
                        filters: [{
                            modifier:      "include",
                            resourceTypes: ["cameras"],
                            sourceIds:     ["*"],
                            eventTypes:    EVENT_TYPES,
                        }],
                    });
                    if (!sub || sub.status !== 200) {
                        throw new Error("addSubscription failed: " + JSON.stringify(sub));
                    }

                    // 4) getState — baseline. Apply via handleMessage path so
                    // we don't duplicate the parse logic.
                    const baseline = await send({ command: "getState" });
                    if (baseline && Array.isArray(baseline.states)) {
                        for (const e of baseline.states) applyStateEntry(e);
                        markDirty();
                    }
                }

                reconnectMs = RECONNECT_INITIAL_MS;
                log("WS up");
            } catch (err) {
                warn("WS handshake:", err);
                closeWs();
                scheduleReconnect();
            }
        };
    };

    // ── Lifecycle: drive off summary-stage events, gate on visibility ────
    const onSummary = (payload) => {
        if (!payload || !payload.milestoneWs) return;
        const next = payload.milestoneWs;
        const changed = !handshake
            || handshake.url   !== next.url
            || handshake.token !== next.token;
        handshake = next;
        if (changed) {
            // New token → reconnect to apply it. The 30s poll is our token
            // refresh path; same code handles both first-connect and rotate.
            log("handshake updated; reconnecting");
            closeWs();
            if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
            reconnectMs = RECONNECT_INITIAL_MS;
            connect();
        } else if (!ws && !reconnectTimer) {
            connect();
        }
    };

    window.addEventListener("tcs:surveillance-data", (ev) => {
        const d = ev && ev.detail;
        if (!d) return;
        // Whenever any stage lands, the camera array may have been rebuilt.
        if (d.stage === "cameras" || d.stage === "summary") rebuildCamIndex();
        if (d.stage === "summary") onSummary(d.payload);
    });

    document.addEventListener("visibilitychange", () => {
        if (document.hidden) {
            stopped = true;
            log("page hidden — closing WS");
            closeWs();
            if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        } else {
            stopped = false;
            log("page visible — reconnecting WS");
            connect();
        }
    });

    // Pick up handshake if surveillance-bridge already fired summary before
    // this script parsed (race on slow boot).
    if (window.SURVEILLANCE_BOOT && window.SURVEILLANCE_BOOT.milestoneWs) {
        onSummary(window.SURVEILLANCE_BOOT);
    }
})();
