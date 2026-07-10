// voip-bridge.jsx
//
// Data layer for the VoIP / 3CX page. Fires four endpoints in parallel on
// page load so individual cards light up as soon as their slot's data
// arrives, instead of all waiting on the slowest call:
//
//   tcs.voip.data        — core rollup (30s):  pbx, services, trunks,
//                          sbcs, queues, problems, history
//   tcs.voip.top.data    — slow (60s):         top-talker report
//                          (function-import call, often 404/403)
//   tcs.voip.calls.data  — fast (5s):          live active-calls list
//
// Each fetch updates window.VOIP_LOADING_FLAGS[<key>] = false on completion
// (success or error); voip-app.jsx's loading pill watches that map.

(function () {
    // Payload field → window global.
    const KEYS = [
        ["pbx",      "VOIP_PBX"],
        ["trunks",   "VOIP_TRUNKS"],
        ["sbcs",     "VOIP_SBCS"],
        ["calls",    "VOIP_CALLS"],
        ["top",      "VOIP_TOP"],
        ["queues",   "VOIP_QUEUES"],
        ["quality",  "VOIP_QUALITY"],
        ["problems", "VOIP_PROBLEMS"],
    ];

    // Per-endpoint loading state, exposed for the header pill.
    window.VOIP_LOADING_FLAGS = window.VOIP_LOADING_FLAGS || {
        core:  true,
        top:   true,
        calls: true,
    };

    function setFlag(key, value) {
        window.VOIP_LOADING_FLAGS[key] = value;
    }

    function apply(payload, opts) {
        if (!payload || typeof payload !== "object") return;
        const only = (opts && opts.onlyKeys) ? new Set(opts.onlyKeys) : null;
        for (const [src, dst] of KEYS) {
            if (only && !only.has(src)) continue;
            const v = payload[src];
            // null/undefined = "couldn't fetch this slot" → keep prior data.
            // Explicit [] / {} = "fetched, currently empty" → apply.
            if (v === null || v === undefined) continue;
            window[dst] = v;
        }
        if (payload.sources)  window.VOIP_SOURCES = { ...(window.VOIP_SOURCES || {}), ...payload.sources };
        if (payload.loading !== undefined) window.VOIP_LOADING = !!payload.loading;
        window.VOIP_BANNER = payload.error
            ? { kind: "error",   msg: payload.error }
            : payload.warning
            ? { kind: "warning", msg: payload.warning }
            : window.VOIP_BANNER || null;
        window.dispatchEvent(new CustomEvent("tcs:voip-data", {
            detail: { ts: payload.ts || Date.now(), keys: opts?.onlyKeys || null }
        }));
    }

    // First paint: unpack SSR boot synchronously.
    apply(window.VOIP_BOOT || {});

    const URLS = {
        core:  window.TCS_VOIP_DATA_URL       || "zabbix.php?action=tcs.voip.data",
        top:   window.TCS_VOIP_TOP_DATA_URL   || "zabbix.php?action=tcs.voip.top.data",
        calls: window.TCS_VOIP_CALLS_DATA_URL || "zabbix.php?action=tcs.voip.calls.data",
    };

    async function fetchOne(key, onlyKeys) {
        try {
            const resp = await fetch(URLS[key], {
                credentials: "same-origin",
                headers: { "Accept": "application/json" },
            });
            if (!resp.ok) throw new Error("HTTP " + resp.status);
            const j = await resp.json();
            apply(j || {}, onlyKeys ? { onlyKeys } : undefined);
            return j;
        } catch (e) {
            console.error("[tcs] voip " + key + " fetch failed:", e, "url:", URLS[key]);
            return null;
        } finally {
            setFlag(key, false);
            window.dispatchEvent(new CustomEvent("tcs:voip-data", {
                detail: { ts: Date.now(), flag: key }
            }));
        }
    }

    console.info("[tcs] fetching VoIP snapshot (parallel)…");
    // Fire all endpoints in parallel. Each card re-renders as its slot
    // lands; no card waits on the slowest call.
    fetchOne("core");
    fetchOne("top",   ["top"]);
    fetchOne("calls", ["calls"]);

    // Refresh cadences (skip when tab hidden).
    const visible = () => document.visibilityState === "visible";
    setInterval(() => { if (visible()) fetchOne("core"); },             30_000);
    setInterval(() => { if (visible()) fetchOne("top",   ["top"]); },   60_000);
    setInterval(() => { if (visible()) fetchOne("calls", ["calls"]); }, 5_000);
    document.addEventListener("visibilitychange", () => {
        if (visible()) {
            fetchOne("core");
            fetchOne("calls", ["calls"]);
        }
    });

    // Manual "Refresh now" hook (used by the Tweaks panel).
    window.tcsVoipRefresh = () => Promise.all([
        fetchOne("core"),
        fetchOne("top",   ["top"]),
        fetchOne("calls", ["calls"]),
    ]);
})();
