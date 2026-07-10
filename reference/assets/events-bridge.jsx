// events-bridge.jsx
//
// Adapts the ActionEvents / ActionEventsData payload into the window globals
// the designed events-app.jsx consumes:
//
//   EV_EVENTS, EV_TIMELINE, EV_SITES, EV_HOSTGROUPS, EV_TAGS,
//   EV_SAVED_VIEWS, EV_METRICS, EV_FILTERS
//
// Imperative API:
//   tcsEventsRefresh()        — refetch with current range
//   tcsEventsFetch({range})   — change range AND refetch
//
// Dispatches "tcs:events-data" on every successful refresh.

(function () {
    const EMPTY = {
        events: [],
        timeline: new Array(24).fill(null).map(() => [0, 0, 0, 0]),
        sites: [],
        hostgroups: [],
        tags: [],
        savedViews: [],
        metrics: { open: 0, ack: 0, mttaStr: "—", mttrStr: "—", mttrSec: 0 },
        range: "24h",
        ts: 0
    };

    const apply = (b) => {
        const m = { ...EMPTY, ...(b || {}) };
        m.timeline   = (Array.isArray(m.timeline) && m.timeline.length === 24) ? m.timeline : EMPTY.timeline;
        m.events     = Array.isArray(m.events)     ? m.events     : [];
        m.sites      = Array.isArray(m.sites)      ? m.sites      : [];
        m.hostgroups = Array.isArray(m.hostgroups) ? m.hostgroups : [];
        m.tags       = Array.isArray(m.tags)       ? m.tags       : [];
        m.savedViews = Array.isArray(m.savedViews) ? m.savedViews : [];
        m.metrics    = { ...EMPTY.metrics, ...(m.metrics || {}) };

        window.EV_EVENTS       = m.events;
        window.EV_TIMELINE     = m.timeline;
        window.EV_SITES        = m.sites;
        window.EV_HOSTGROUPS   = m.hostgroups;
        window.EV_TAGS         = m.tags;
        window.EV_SAVED_VIEWS  = m.savedViews;
        window.EV_METRICS      = m.metrics;
        window.EV_FILTERS      = { range: m.range };
    };

    apply(window.EVENTS_BOOT);

    let currentRange = (window.EV_FILTERS && window.EV_FILTERS.range) || "24h";
    const base = window.TCS_EVENTS_DATA_URL;
    const REFRESH_MS = 30_000;

    const fetchNow = async () => {
        if (!base) return;
        const url = `${base}&range=${encodeURIComponent(currentRange)}`;
        try {
            const resp = await fetch(url, {
                credentials: "same-origin",
                headers: { "Accept": "application/json" }
            });
            if (!resp.ok) return;
            const fresh = await resp.json();
            apply(fresh);
            window.dispatchEvent(new CustomEvent("tcs:events-data", {
                detail: { ...fresh, fetchedAt: Date.now() }
            }));
        } catch (e) {
            console.warn("[tcs] events fetch failed:", e);
        }
    };

    window.tcsEventsRefresh = fetchNow;
    window.tcsEventsFetch = (delta) => {
        if (delta && delta.range) currentRange = delta.range;
        return fetchNow();
    };

    // POST helper for acknowledge / suppress / sev change / close / message.
    // opts: { action: int bitmask, message?, severity?, suppress_until? }
    window.tcsEventsUpdate = async (eventids, opts) => {
        const updateUrl = window.TCS_EVENTS_UPDATE_URL;
        if (!updateUrl) return { ok: false, error: "no update url" };
        const ids = (Array.isArray(eventids) ? eventids : [eventids]).map(String).filter(Boolean);
        if (!ids.length) return { ok: false, error: "no eventids" };

        const body = new URLSearchParams();
        ids.forEach(id => body.append("eventids[]", id));
        // Named `op` server-side because `action` collides with Zabbix's
        // own routing parameter (which is `tcs.events.update` here).
        body.append("op", String(opts.action | 0));
        if (opts.message != null)        body.append("message", String(opts.message));
        if (opts.severity != null)       body.append("severity", String(opts.severity | 0));
        if (opts.suppress_until != null) body.append("suppress_until", String(opts.suppress_until | 0));

        try {
            const resp = await fetch(updateUrl, {
                method: "POST",
                credentials: "same-origin",
                headers: {
                    "Accept": "application/json",
                    "Content-Type": "application/x-www-form-urlencoded"
                },
                body: body.toString()
            });
            const text = await resp.text();
            // Older Zabbix module routes occasionally wrap layout.json output
            // in the full HTML page chrome. Try a straight parse first, then
            // fall back to extracting the first JSON object we can find.
            let json;
            try {
                json = JSON.parse(text);
            } catch (_) {
                const start = text.indexOf("{");
                const end   = text.lastIndexOf("}");
                if (start !== -1 && end > start) {
                    try { json = JSON.parse(text.slice(start, end + 1)); }
                    catch (__) { json = { ok: false, error: text.slice(0, 200) }; }
                } else {
                    json = { ok: false, error: text.slice(0, 200) };
                }
            }
            if (json && json.ok) fetchNow();
            return json;
        } catch (e) {
            console.warn("[tcs] events update failed:", e);
            return { ok: false, error: String(e) };
        }
    };

    setInterval(fetchNow, REFRESH_MS);
})();
