// switches-bridge.jsx
//
// Async data layer for the Switches page. The PHP controller (ActionSwitches)
// renders just the page shell + host metadata to keep TTFB low; this file
// fetches the heavy data (fleet, snapshot, problems) in parallel after first
// paint and updates the window globals the React widgets read on each render.
//
// Globals managed here (kept compatible with the mock-data names so the
// widgets need no edits):
//   window.SWITCH_SITES      — fleet for HostNavigator
//   window.ARC_MDF_STACK     — per-member port arrays
//   window.SWITCH_KPIS       — scalar KPI values (cpu/mem/temp/poeWatts/...)
//   window.ARC_MDF_HISTORY   — 24h sparkline series
//   window.ARC_MDF_LINKS     — uplink top-talker rows
//   window.SWITCH_PROBLEMS   — recent problems
//   window.makePortDetail()  — per-port detail panel builder
//
// Events dispatched on window:
//   "tcs:switch-data"   — fired whenever a global was just updated, so the
//                         React app can bump a re-render counter.
//
// Helpers exposed:
//   window.tcsNavigateSwitch(hostid)  — reloads page targeting a different host
//   window.tcsCyclePoe(member, port)  — POSTs to tcs.switch.cyclepoe

(function () {
    const boot = window.SWITCH_BOOT || {};
    const host = boot.host || null;

    // Expose the bound hostid so the CYCLE button can POST without prop-drilling.
    window.TCS_SWITCH_HOSTID = host ? String(host.hostid || "") : "";

    // Navigation: SPA-style. No page reload — just re-fetch the snapshot for
    // the new hostid and update the URL via pushState so refresh / back-button
    // still target the right switch.
    window.tcsNavigateSwitch = function (hostid) {
        if (!hostid) return;
        const id = String(hostid);
        const params = new URLSearchParams(window.location.search);
        params.set("action", "tcs.switches.view");
        params.set("switchid", id);
        try {
            window.history.pushState({ switchid: id }, "", "?" + params.toString());
        } catch (e) { /* ignore — pushState rarely fails */ }
        window.TCS_SWITCH_HOSTID = id;
        // Reset port-status / KPI state so the user sees the empty skeleton
        // for the new host while the snapshot is in flight.
        window.ARC_MDF_STACK   = [{ idx: 1, ports: [], sfp: [], upCount: 0, downCount: 0, poeCount: 0 }];
        window.SWITCH_KPIS     = { cpu: null, mem: null, temp: null, poeWatts: null, poeBudget: null };
        window.ARC_MDF_HISTORY = { cpu: [], mem: [], temp: [], poeWatts: [], uplinkRx: [], uplinkTx: [] };
        window.ARC_MDF_LINKS   = [];
        window.STACK_MEMBERS   = [];
        window.EDP_NEIGHBORS   = [];
        window.VLANS           = [];
        window.POE_BUDGET      = null;
        window.PORT_AUTH       = {};
        window.SWITCH_PROBLEMS = [];
        window.SWITCH_TRIGGERS = [];
        window.SWITCH_SSH      = null;
        window.SWITCH_LOADING  = { ...window.SWITCH_LOADING, snapshot: true };
        window.dispatchEvent(new CustomEvent("tcs:switch-data", { detail: { section: "navigate" } }));
        fetchSnapshot(id);
    };

    // Initial empty defaults. The page is data-source-truthy: nothing renders
    // until the JSON endpoints respond. No mock fixtures are loaded at all
    // (switches-data.jsx was removed) — empty arrays are the empty state.
    window.SWITCH_KPIS      = { cpu: null, mem: null, temp: null, poeWatts: null, poeBudget: null };
    window.SWITCH_PROBLEMS  = [];
    window.ARC_MDF_LINKS    = [];
    window.ARC_MDF_HISTORY  = { cpu: [], mem: [], temp: [], poeWatts: [], uplinkRx: [], uplinkTx: [] };
    // Per-stack-member CPU/mem/temp from the snapshot. Empty until the
    // per-member-health template patch is applied — see
    // tcs_dashboard/notes/zabbix-template-patches/per-member-health.md.
    window.STACK_MEMBERS    = [];
    // EDP-discovered neighbors. Empty until the vlan-poe-topology
    // template patch (extreme.edp.* items) is applied.
    window.EDP_NEIGHBORS    = [];
    // VLAN list with per-slot tagged/untagged port sets. Empty until
    // the vlan-poe-topology template patch (extreme.vlan.* items) is
    // applied.
    window.VLANS            = [];
    // PoE budget snapshot. null until the snapshot arrives; empty
    // members/ports arrays once it does if the patch isn't applied.
    window.POE_BUDGET       = null;
    // Per-port auth sessions, keyed by "m.p". Empty until the port-auth
    // patch is applied.
    window.PORT_AUTH        = {};
    window.SWITCH_SITES     = [];
    window.SWITCH_INFO      = {};
    // Per-host trigger inventory for the Triggers tab. Empty until the
    // snapshot lands; populated from live Zabbix trigger + event data.
    window.SWITCH_TRIGGERS  = [];
    window.PF_ADMIN_BASE    = "";
    // CLI tab. SWITCH_SSH stays null (admin-only; the snapshot withholds it
    // from non-admins, and the CLI pane shows its "not configured" empty
    // state) until the snapshot lands.
    window.SWITCH_SSH       = null;
    // Single empty stack member keeps the port grid renderable until the
    // snapshot arrives (the grid expects at least one member to map over).
    window.ARC_MDF_STACK    = [{ idx: 1, ports: [], sfp: [], upCount: 0, downCount: 0, poeCount: 0 }];
    // Loading flags so widgets / future skeletons can show "loading…" affordances.
    window.SWITCH_LOADING   = { fleet: true, snapshot: true };

    // Self-contained port-detail builder. Returns the fields PortDetailPane
    // / PacketFenceDevicePane read. Per-port histories aren't fetched (the
    // snapshot's history bucket is per-KPI, not per-port) — that would need a
    // dedicated per-port endpoint. Rates and errors come from the traffic
    // bag, populated by applySnapshot.
    const FLAT60 = Array.from({ length: 60 }, () => 0);
    const _fdbByKey     = Object.create(null);
    const _trafficByKey = Object.create(null);
    const _pfByKey      = Object.create(null);
    window._tcsFdbByKey     = _fdbByKey;
    window._tcsTrafficByKey = _trafficByKey;
    window._tcsPfByKey      = _pfByKey;

    // Role tags in the design system: faculty/student/guest/av/byod/quarantine/unknown.
    // PF category names rarely match these 1:1 — coerce unknown values to "unknown"
    // so the CSS still renders a sensible chip.
    const _PF_ROLE_CLASSES = new Set(["faculty","student","guest","av","byod","quarantine","unknown"]);
    const pfRoleClass = (raw) => {
        const s = String(raw || "").toLowerCase().trim();
        if (!s) return "unknown";
        if (_PF_ROLE_CLASSES.has(s)) return s;
        // Look for a known token inside e.g. "BYOD-Wifi" → "byod"
        for (const c of _PF_ROLE_CLASSES) if (s.includes(c)) return c;
        return "unknown";
    };

    const pfAgeMin = (lastSeen) => {
        if (!lastSeen) return 0;
        // PF returns "YYYY-MM-DD HH:MM:SS" in server-local time. Replacing the
        // space with "T" lets Date.parse handle it as a local timestamp.
        const t = Date.parse(String(lastSeen).replace(" ", "T"));
        if (!isFinite(t)) return 0;
        return Math.max(0, Math.round((Date.now() - t) / 60000));
    };

    // Static policy-profile lookup — RADIUS Filter-ID maps to a policy
    // profile index, which on Extreme stacks corresponds to a named
    // entry in the policy profile config. Static because the profile
    // names rarely change and aren't pollable via SNMP.
    window.POLICY_PROFILES = {
        1:  "Failsafe",
        2:  "Teachers",
        3:  "Administrator",
        4:  "isolation",
        5:  "ITAdmins",
        6:  "Voice",
        7:  "Door Access",
        8:  "CNP",
        9:  "Guest Access",
        10: "Permit Traffic",
        11: "Computers",
        12: "Projectors",
        13: "Deny Access",
        14: "WirelessAP",
        15: "Unregistered",
        16: "Printers",
        17: "Registration",
        18: "gaming",
        19: "SecCameras",
        20: "HVAC",
        21: "Students"
    };

    // Find the untagged VLAN for a given member+port from the live
    // VLAN snapshot. Returns {vid, name} or null when no VLAN claims
    // the port as untagged (typical for trunk/uplink ports or ports
    // not in the snapshot yet).
    const _portUntaggedVlan = (member, portNum) => {
        const vlans = Array.isArray(window.VLANS) ? window.VLANS : [];
        for (const v of vlans) {
            const slotPorts = (v.untaggedPorts || {})[member];
            if (Array.isArray(slotPorts) && slotPorts.includes(portNum)) {
                return { vid: v.vid, name: v.name };
            }
        }
        return null;
    };

    window.makePortDetail = function (memberIdx, port) {
        const k = `${memberIdx}.${port.n}`;
        const macs = _fdbByKey[k] || [];
        const tr   = _trafficByKey[k] || null;
        const pfRows = _pfByKey[k] || [];

        // Project every PF row into the device shape the React tile reads
        // and sort by recency so the freshest MAC is tab #0 by default.
        const _toDevice = (r) => ({
            mac:       r.mac,
            reg:       r.reg,
            ip:        r.ip,
            host:      r.host || "—",
            vendor:    r.vendor || "—",
            os:        r.os || "—",
            owner:     r.owner || "—",
            dhcpFp:    r.dhcpFp || "—",
            lastSeen:  r.lastSeen || "—",
            lastArp:   r.lastArp || "—",
            lastDhcp:  r.lastDhcp || "—",
            // Raw label for display, normalized class for the chip's color.
            role:      r.role || "",
            roleClass: pfRoleClass(r.role)
        });
        const _seenMs = (ls) => {
            const t = Date.parse(String(ls || "").replace(" ", "T"));
            return Number.isFinite(t) ? t : 0;
        };
        const devices = pfRows
            .map(_toDevice)
            .sort((a, b) => _seenMs(b.lastSeen) - _seenMs(a.lastSeen));
        // detail.device kept for any caller still reading the singular —
        // freshest device wins as the default primary.
        const device = devices[0] || null;

        // Server gives us bytes/sec on each side. Convert to kbps for the
        // detail panel, then derive a coarse utilization % off the port's
        // assumed speed (default 1G = 1_000_000 kbps line rate).
        const inKbps  = tr ? Math.round(((tr.in  || 0) * 8) / 1000 * 10) / 10 : 0;
        const outKbps = tr ? Math.round(((tr.out || 0) * 8) / 1000 * 10) / 10 : 0;
        const lineKbps = (port.speed || 1000) * 1000;
        const utilPct  = lineKbps > 0 ? Math.min(100, Math.round((Math.max(inKbps, outKbps) / lineKbps) * 100)) : 0;

        const errIn   = tr ? (tr.errIn   || 0) : 0;
        const errOut  = tr ? (tr.errOut  || 0) : 0;
        const discIn  = tr ? (tr.discIn  || 0) : 0;
        const discOut = tr ? (tr.discOut || 0) : 0;

        // Port's static untagged VLAN (from extremeVlanOpaqueTable).
        const portVlan = _portUntaggedVlan(memberIdx, port.n);

        // Auth sessions on this port from etsysMultiAuthSessionStationTable.
        // Pre-sorted server-side so applied sessions come first.
        const authSessions = (window.PORT_AUTH || {})[`${memberIdx}.${port.n}`] || [];
        // Decorate each session with the human policy-profile name so the
        // detail pane can render it directly. policyName is "" when the
        // index isn't in POLICY_PROFILES.
        const policyName = (idx) => (window.POLICY_PROFILES || {})[idx] || "";
        const decoratedSessions = authSessions.map(s => ({
            ...s,
            policyName: s.policy != null ? policyName(s.policy) : ""
        }));
        const primaryAuth = decoratedSessions.find(s => s.applied) || decoratedSessions[0] || null;

        return {
            label:      `${memberIdx}:${port.n}`,
            state:      port.state,
            speed:      port.speed || 0,
            poe:        !!port.poe,
            poeWatts:   0,
            inKbps,
            outKbps,
            utilPct,
            inHist:     FLAT60,
            outHist:    FLAT60,
            onlineHist: FLAT60.map(() => port.state === "up" ? "ok" : "off"),
            errors1h:   errIn + errOut,
            errIn,
            errOut,
            discards1h: discIn + discOut,
            discIn,
            discOut,
            device,
            devices,
            extraMacs:  device
                ? Math.max(pfRows.length - 1, macs.length > 1 ? macs.length - 1 : 0)
                : (macs.length > 1 ? macs.length - 1 : 0),
            macs,
            ifIndex:    (Number(memberIdx) || 1) * 1000 + (Number(port.n) || 0),
            ageMin:     device ? pfAgeMin(device.lastSeen) : 0,
            // Static port VLAN: vid + name (e.g., "FACULTY"); null when the
            // port isn't untagged on any VLAN (trunk port etc.).
            portVlan,
            // Auth sessions: primaryAuth is the active "applied" session;
            // authSessions is the full list (typically 0..2 entries).
            authSessions: decoratedSessions,
            primaryAuth
        };
    };

    /* --------------------------------------------------------------------- */
    /* Adapters: payload sections → window globals                           */
    /* --------------------------------------------------------------------- */

    const ifOperToState = (s) => {
        switch (Number(s)) {
            case 1: return "up";
            case 2: return "down";
            case 5: return "dormant";
            case 6: return "absent";
            default: return "down";
        }
    };
    const poeDelivering = (s) => Number(s) === 3;

    function buildStack(members, ports, poe) {
        const speedByKey = window._tcsSpeedByKey || {};
        const portByKey  = Object.create(null);
        for (const p of ports) portByKey[`${p.member}.${p.port}`] = p;
        const poeByKey   = Object.create(null);
        const poePresent = Object.create(null);   // any PoE item, even "searching"
        for (const p of poe) {
            poeByKey[`${p.member}.${p.port}`] = poeDelivering(p.status);
            poePresent[`${p.member}.${p.port}`] = true;
        }

        const keys = new Set();
        for (const k of Object.keys(portByKey)) keys.add(k);
        for (const k of Object.keys(poePresent)) keys.add(k);
        if (!keys.size) return null;

        // Compute per-member highest port number that has ANY PoE item. Ports
        // numbered above that are SFP/uplink (Extreme convention: PoE LLD walks
        // the copper ports; SFP cages don't appear in the PoE table). Members
        // with zero PoE items skip the split (probably a non-PoE switch — all
        // regular).
        const maxPoePortByMember = new Map();
        for (const key of Object.keys(poePresent)) {
            const [mStr, pStr] = key.split(".");
            const m = Number(mStr), p = Number(pStr);
            const cur = maxPoePortByMember.get(m) || 0;
            if (p > cur) maxPoePortByMember.set(m, p);
        }

        const byMember = new Map();
        for (const key of keys) {
            const [mStr, pStr] = key.split(".");
            const m = Number(mStr) || 1;
            const portNum = Number(pStr) || 0;
            const portRow = portByKey[key];
            const isDelivering = !!poeByKey[key];

            let state;
            if (portRow) {
                state = ifOperToState(portRow.status);
            } else {
                state = isDelivering ? "up" : "down";
            }

            const speed = Number(speedByKey[key]) || (state === "up" ? 1000 : 0);
            const maxPoe = maxPoePortByMember.get(m) || 0;
            const isSfp = maxPoe > 0 && portNum > maxPoe;

            // Flag the cell red when the port has *any* in/out errors so the
            // user can spot bad ports at a glance.
            const tr = (window._tcsTrafficByKey || {})[key] || null;
            const errCount = tr ? ((tr.errIn || 0) + (tr.errOut || 0)) : 0;

            if (!byMember.has(m)) byMember.set(m, []);
            byMember.get(m).push({
                n: portNum,
                state,
                speed,
                poe: isDelivering,
                alert: false,
                err: errCount > 0,
                sfp: isSfp
            });
        }

        const memberIdxs = members.length
            ? members.map(m => Number(m.index)).filter(n => n > 0)
            : [...byMember.keys()].sort((a, b) => a - b);

        const stack = [];
        for (const idx of memberIdxs) {
            const full = (byMember.get(idx) || []).slice().sort((a, b) => a.n - b.n);
            const regular = full.filter(p => !p.sfp);
            const sfp     = full.filter(p =>  p.sfp);
            stack.push({
                idx,
                ports: regular,
                sfp,
                upCount:   full.filter(p => p.state === "up").length,
                downCount: full.filter(p => p.state === "down").length,
                poeCount:  full.filter(p => p.poe).length
            });
        }
        return stack.length ? stack : null;
    }

    function applyFleet(fleet) {
        const activeHostid = host ? String(host.hostid || "") : "";
        const activeHost   = host ? String(host.host   || "") : "";
        const matches = (sw) => activeHostid !== ""
            ? String(sw.hostid) === activeHostid
            : sw.id === activeHost;
        window.SWITCH_SITES = fleet.map(site => {
            const switches = (site.switches || []).map(sw => ({ ...sw, selected: matches(sw) }));
            return {
                ...site,
                expanded: switches.some(sw => sw.selected),
                switches
            };
        });
        const total = fleet.reduce((n, s) => n + (s.switches || []).length, 0);
        console.info(`[tcs] switch fleet: ${fleet.length} site(s), ${total} host(s)`);
        if (total === 0) {
            console.warn("[tcs] switch fleet empty — verify Site/* host groups exist and EXOS hosts carry tag target=exos.");
        }
    }

    function applySnapshot(snap) {
        const members  = Array.isArray(snap.members)      ? snap.members      : [];
        const ports    = Array.isArray(snap.ports)        ? snap.ports        : [];
        const poe      = Array.isArray(snap.poe)          ? snap.poe          : [];
        const fdb      = Array.isArray(snap.fdb)          ? snap.fdb          : [];
        const uplinks  = Array.isArray(snap.uplinks)      ? snap.uplinks      : [];
        const problems = Array.isArray(snap.problems)     ? snap.problems     : [];
        const edp      = Array.isArray(snap.edpNeighbors) ? snap.edpNeighbors : [];
        const vlans    = Array.isArray(snap.vlans)        ? snap.vlans        : [];
        const poeBudget = (snap.poeBudget && typeof snap.poeBudget === "object") ? snap.poeBudget : null;
        const portAuth  = (snap.portAuth  && typeof snap.portAuth  === "object") ? snap.portAuth  : {};
        const kpis     = (snap.kpis    && typeof snap.kpis    === "object") ? snap.kpis    : {};
        const history  = (snap.history && typeof snap.history === "object") ? snap.history : {};
        const traffic  = (snap.traffic && typeof snap.traffic === "object") ? snap.traffic : {};
        const speeds   = (snap.speeds  && typeof snap.speeds  === "object") ? snap.speeds  : {};
        const info     = (snap.info    && typeof snap.info    === "object") ? snap.info    : {};

        // EDP neighbors — populated when the vlan-poe-topology template
        // patch (extreme.edp.* items) is rolled out. Empty array until
        // then; the Topology tab shows a loading / no-data state.
        window.EDP_NEIGHBORS = edp;
        // VLANs + per-slot tagged/untagged port lists from
        // extreme.vlan.* items (vlan-poe-topology patch).
        window.VLANS = vlans;
        // PoE budget — stack totals, per-slot draw/budget, and per-port
        // wattages (sorted desc) ready to join with PF data for the
        // top-consumers table.
        window.POE_BUDGET = poeBudget;
        // Per-port authenticated sessions from etsysMultiAuthSessionStationTable
        // (port-auth template patch). Keyed by "<member>.<port>".
        window.PORT_AUTH = portAuth;

        // Stash speeds for buildStack to consume.
        window._tcsSpeedByKey = speeds;
        // Host firmware / model / serial — consumed by the page-header pills.
        window.SWITCH_INFO = info;

        // Per-port traffic — makePortDetail reads from this on demand so port
        // clicks pick up the freshest rates without a second fetch.
        const tbag = window._tcsTrafficByKey;
        for (const k of Object.keys(tbag)) delete tbag[k];
        for (const k of Object.keys(traffic)) {
            tbag[k] = traffic[k];
        }

        const stack = buildStack(members, ports, poe);
        if (stack) window.ARC_MDF_STACK = stack;

        // Per-stack-member CPU/mem/temp + inventory. Members come from the
        // snapshot with null fields until the per-member-health template
        // patch is applied; the Stack Health tab falls back to demo data
        // when nothing useful has arrived yet.
        window.STACK_MEMBERS = members.map(m => ({
            idx:     m.index,
            role:    m.role,
            cpu:     typeof m.cpu1m === "number" ? m.cpu1m : null,
            cpu5:    typeof m.cpu5m === "number" ? m.cpu5m : null,
            mem:     typeof m.mem   === "number" ? m.mem   : null,
            temp:    typeof m.temp  === "number" ? m.temp  : null,
            serial:  (typeof m.serial  === "string" && m.serial)  ? m.serial  : null,
            version: (typeof m.version === "string" && m.version) ? m.version : null,
            uptime:  typeof m.uptime === "number" ? m.uptime : null,
            fans:    Array.isArray(m.fans) ? m.fans : [],
            psus:    Array.isArray(m.psus) ? m.psus : []
        }));

        const kpiVal = (k) => (kpis[k] && typeof kpis[k].lastvalue === "number") ? kpis[k].lastvalue : null;
        window.SWITCH_KPIS = {
            cpu:       kpiVal("cpu"),
            mem:       kpiVal("mem"),
            temp:      kpiVal("temp"),
            poeWatts:  kpiVal("poeWatts"),
            poeBudget: kpiVal("poeBudget")
        };

        const h = (key) => Array.isArray(history[key]) ? history[key] : [];
        window.ARC_MDF_HISTORY = {
            cpu:      h("cpu"),
            mem:      h("mem"),
            temp:     h("temp"),
            poeWatts: h("poeWatts"),
            uplinkRx: h("uplinkRx").length ? h("uplinkRx") : h("poeWatts").map(v => v * 4 + 200),
            uplinkTx: h("uplinkTx").length ? h("uplinkTx") : h("poeWatts").map(v => v * 2 + 80)
        };

        window.ARC_MDF_LINKS   = uplinks;
        window.SWITCH_PROBLEMS = problems;
        window.SWITCH_TRIGGERS = Array.isArray(snap.triggers) ? snap.triggers : [];

        // CLI tab: ssheasy connect descriptor (admin-only; null otherwise).
        window.SWITCH_SSH  = (snap.ssh && typeof snap.ssh === "object") ? snap.ssh : null;

        // Repopulate the FDB bag — makePortDetail (defined once at IIFE time)
        // reads from this on demand so the next click on a port picks up the
        // freshest MAC list without rebinding the builder.
        const bag = window._tcsFdbByKey;
        for (const k of Object.keys(bag)) delete bag[k];
        for (const row of fdb) {
            const k = `${row.member}.${row.port}`;
            (bag[k] = bag[k] || []).push(row.mac);
        }

        // PF admin base URL (for the "View in PacketFence" link).
        if (typeof snap.pfBase === "string") window.PF_ADMIN_BASE = snap.pfBase;

        // PacketFence-resolved devices per port. Server pre-buckets by m.p.
        const pfBag = window._tcsPfByKey;
        for (const k of Object.keys(pfBag)) delete pfBag[k];
        const pfNodes = (snap.pfNodes && typeof snap.pfNodes === "object") ? snap.pfNodes : {};
        let pfPorts = 0, pfDevices = 0;
        for (const k of Object.keys(pfNodes)) {
            const rows = pfNodes[k];
            if (Array.isArray(rows) && rows.length) {
                pfBag[k] = rows;
                pfPorts++;
                pfDevices += rows.length;
            }
        }
        console.info("[tcs] pf nodes:", pfPorts, "port(s),", pfDevices, "device(s)");
    }

    /** Fire a re-render in the React app. */
    function notify(section) {
        window.dispatchEvent(new CustomEvent("tcs:switch-data", { detail: { section } }));
    }

    /* --------------------------------------------------------------------- */
    /* Async fetches                                                         */
    /* --------------------------------------------------------------------- */

    const URL_FLEET    = window.TCS_SWITCH_FLEET_URL    || "zabbix.php?action=tcs.switches.fleet.data";
    const URL_SNAPSHOT = window.TCS_SWITCH_SNAPSHOT_URL || "zabbix.php?action=tcs.switches.snapshot.data";
    const URL_PORTHIST = window.TCS_SWITCH_PORTHIST_URL || "zabbix.php?action=tcs.switches.port.history.data";

    async function fetchJson(url) {
        const resp = await fetch(url, {
            credentials: "same-origin",
            headers: { "Accept": "application/json" }
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return resp.json();
    }

    function fetchSnapshot(switchid) {
        if (!switchid) return;
        const url = `${URL_SNAPSHOT}&switchid=${encodeURIComponent(switchid)}`;
        return fetchJson(url)
            .then(j => {
                applySnapshot(j || {});
                const counts = {
                    members: (j.members || []).length,
                    ports:   (j.ports   || []).length,
                    poe:     (j.poe     || []).length,
                    uplinks: (j.uplinks || []).length,
                    problems: (j.problems || []).length
                };
                console.info("[tcs] snapshot for hostid", switchid, counts);
            })
            .catch(e => console.error("[tcs] snapshot fetch failed:", e, "url:", url))
            .finally(() => {
                window.SWITCH_LOADING.snapshot = false;
                notify("snapshot");
            });
    }

    /**
     * Splice {hostid: counters} into SWITCH_SITES rows. Called after the
     * counters fetch lands — the skeleton already rendered the navigator.
     */
    function applyCounters(byHostid) {
        if (!byHostid || typeof byHostid !== "object") return;
        const sites = Array.isArray(window.SWITCH_SITES) ? window.SWITCH_SITES : [];
        let merged = 0;
        for (const site of sites) {
            for (const sw of (site.switches || [])) {
                const c = byHostid[String(sw.hostid || "")];
                if (!c) continue;
                Object.assign(sw, c);
                merged++;
            }
        }
        console.info("[tcs] switch counters merged into", merged, "host(s)");
    }

    // Two-stage fleet load:
    //   1) skeleton — sites + hosts + problem counts (drives navigator).
    //                 Cheap; no per-port item.get.
    //   2) counters — port / PoE / stacking / model rollup. Heavier; the
    //                 navigator is already rendered when this lands.
    // Both run in parallel with the snapshot fetch.
    console.info("[tcs] fetching switch fleet (skeleton + counters) + snapshot…");
    fetchJson(URL_FLEET + "&mode=skeleton")
        .then(j => {
            const fleet = Array.isArray(j && j.fleet) ? j.fleet : [];
            applyFleet(fleet);
        })
        .catch(e => console.error("[tcs] fleet skeleton fetch failed:", e))
        .finally(() => {
            window.SWITCH_LOADING.fleet = false;
            notify("fleet");
        });

    fetchJson(URL_FLEET + "&mode=counters")
        .then(j => {
            const c = (j && j.counters && typeof j.counters === "object") ? j.counters : {};
            applyCounters(c);
            notify("fleet");
        })
        .catch(e => console.error("[tcs] fleet counters fetch failed:", e));

    const switchid = host ? String(host.hostid || "") : "";
    if (switchid) {
        fetchSnapshot(switchid);
    } else {
        window.SWITCH_LOADING.snapshot = false;
        console.info("[tcs] no switchid in URL — skipping snapshot fetch");
    }

    // Browser back/forward should also re-snapshot, not full-reload.
    window.addEventListener("popstate", () => {
        const p = new URLSearchParams(window.location.search);
        const id = p.get("switchid") || "";
        if (id && id !== window.TCS_SWITCH_HOSTID) {
            window.tcsNavigateSwitch(id);
        }
    });

    /* --------------------------------------------------------------------- */
    /* CYCLE PoE handler                                                     */
    /* --------------------------------------------------------------------- */

    // Lazy per-port sparkline history. SwitchesApp calls this on port click
    // and patches the detail when the response arrives. Errors return flat
    // arrays so the panel stays renderable.
    window.tcsLoadPortHistory = async function (member, port) {
        const hostid = window.TCS_SWITCH_HOSTID;
        if (!hostid || !member || !port) return { inHist: FLAT60, outHist: FLAT60 };
        const url = `${URL_PORTHIST}&hostid=${encodeURIComponent(hostid)}`
                  + `&member=${encodeURIComponent(member)}&port=${encodeURIComponent(port)}`;
        try {
            const j = await fetchJson(url);
            return {
                inHist:  Array.isArray(j.inHist)  ? j.inHist  : FLAT60,
                outHist: Array.isArray(j.outHist) ? j.outHist : FLAT60
            };
        } catch (e) {
            console.warn("[tcs] port history fetch failed:", e);
            return { inHist: FLAT60, outHist: FLAT60 };
        }
    };

    window.tcsCyclePoe = async function (member, port) {
        const url = window.TCS_SWITCH_CYCLEPOE_URL;
        const hostid = window.TCS_SWITCH_HOSTID;
        if (!url || !hostid) {
            return { ok: false, error: "endpoint not configured" };
        }
        try {
            const form = new URLSearchParams({
                hostid,
                member: String(Number(member) || 1),
                port:   String(Number(port)   || 0)
            });
            const resp = await fetch(url, {
                method: "POST",
                credentials: "same-origin",
                headers: {
                    "Accept": "application/json",
                    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"
                },
                body: form.toString()
            });
            const body = await resp.json().catch(() => ({}));
            if (!resp.ok) {
                return { ok: false, error: body.error || `HTTP ${resp.status}` };
            }
            return body;
        } catch (e) {
            return { ok: false, error: String(e && e.message ? e.message : e) };
        }
    };

    // XIQ tab loader — single-flight per hostid + page session. The XIQ
    // lookup is the slowest data fetch on the page (one XIQ /devices probe
    // + per-device /clients + /alarms + global /alerts), so it only runs
    // when the user actually clicks the XIQ tab. Result is cached on
    // window.SWITCH_XIQ so flipping back to the tab is instant. Pass
    // `force=true` to bypass the cache (the tab's Refresh button does).
    let _xiqInFlight = null;
    let _xiqCachedHostid = "";
    window.tcsLoadSwitchXiq = function (hostid, force) {
        const id = String(hostid || "");
        if (!id) return Promise.reject(new Error("no hostid"));
        if (!force && _xiqCachedHostid === id && window.SWITCH_XIQ && window.SWITCH_XIQ.loaded) {
            return Promise.resolve(window.SWITCH_XIQ);
        }
        if (_xiqInFlight && _xiqCachedHostid === id && !force) return _xiqInFlight;
        const url = (window.TCS_SWITCH_XIQ_URL || "zabbix.php?action=tcs.switches.xiq.data")
                  + "&switchid=" + encodeURIComponent(id);
        _xiqCachedHostid = id;
        _xiqInFlight = fetchJson(url)
            .then(j => {
                const data = { ...j, loaded: true, loading: false };
                window.SWITCH_XIQ = data;
                return data;
            })
            .catch(e => {
                window.SWITCH_XIQ = { loaded: true, loading: false, error: String(e && e.message ? e.message : e) };
                throw e;
            })
            .finally(() => { _xiqInFlight = null; });
        return _xiqInFlight;
    };

    // PacketFence per-device write-actions (reevaluate access / restart
    // switchport). Same envelope as tcsCyclePoe: returns { ok, message? }
    // on success, { ok:false, error } otherwise. Backend is admin-gated.
    window.tcsPfDeviceAction = async function (mac, op) {
        const url = window.TCS_PF_DEVICE_URL;
        const hostid = window.TCS_SWITCH_HOSTID;
        if (!url || !hostid) return { ok: false, error: "endpoint not configured" };
        if (!mac || !op)     return { ok: false, error: "mac and op required" };
        try {
            // Zabbix's CController::validateInput reads $_REQUEST, which is
            // populated from form-encoded bodies — JSON bodies don't reach
            // it. Form-encode the payload so the server-side mandatory-field
            // check finds hostid / mac / op.
            const form = new URLSearchParams({ hostid, mac: String(mac), op: String(op) });
            const resp = await fetch(url, {
                method: "POST",
                credentials: "same-origin",
                headers: {
                    "Accept": "application/json",
                    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"
                },
                body: form.toString()
            });
            const body = await resp.json().catch(() => ({}));
            if (!resp.ok) {
                return { ok: false, error: body.error || `HTTP ${resp.status}` };
            }
            return body;
        } catch (e) {
            return { ok: false, error: String(e && e.message ? e.message : e) };
        }
    };
})();
