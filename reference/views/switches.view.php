<?php declare(strict_types=1);

/**
 * @var CView $this
 * @var array $data
 */

$asset_base = 'modules/tcs_dashboard/assets';
?>
<style>
    body > header, body > nav, body > aside, body > footer, body > .menu-main, body > .header-title, .wrapper > footer, footer[role="contentinfo"], .msg-global-footer, #page-footer { display: none !important; }
    body { margin: 0 !important; padding: 0 !important; background: #0d1117 !important; }
    main, .wrapper, .article { padding: 0 !important; margin: 0 !important; max-width: none !important; }
    main { all: revert; }
</style>

<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="<?= $asset_base ?>/styles.css">
<link rel="stylesheet" href="<?= $asset_base ?>/surveillance.css">
<link rel="stylesheet" href="<?= $asset_base ?>/switches.css">

<style>
    html.hide-src-badges .src-badge { display: none !important; }
    .app[data-density="dense"]    .card-b { padding: 10px; }
    .app[data-density="spacious"] .card-b { padding: 18px; }
    @media (max-width: 1280px) {
        .app { grid-template-columns: 64px 1fr; }
        .sidebar .nav-label, .sidebar .brand div:not(.brand-mark),
        .sidebar .nav-item span:not(.nav-count), .sidebar-footer { display: none; }
        .sidebar .nav-item { justify-content: center; }
    }
    /* Boot splash: rendered inside #root and replaced when React mounts.
       Covers the gap between HTML arrival and Babel finishing its parse. */
    .tcs-boot {
        position: fixed; inset: 0; display: flex; flex-direction: column;
        align-items: center; justify-content: center; gap: 14px;
        background: #0d1117; color: #c9d1d9; font: 13px/1.4 "Inter", system-ui, sans-serif;
    }
    .tcs-boot .spinner {
        width: 36px; height: 36px; border-radius: 50%;
        border: 3px solid rgba(217, 41, 41, 0.15);
        border-top-color: #d92929;
        animation: tcs-spin 0.8s linear infinite;
    }
    .tcs-boot .label { color: #6e7681; font-size: 12px; letter-spacing: 0.04em; text-transform: uppercase; }
    @keyframes tcs-spin { to { transform: rotate(360deg); } }
</style>

<div id="root">
    <div class="tcs-boot" role="status" aria-live="polite">
        <div class="spinner" aria-hidden="true"></div>
        <div class="label">Loading switch fleet…</div>
    </div>
</div>

<script>
    // Server-side snapshot from ActionSwitches; switches-bridge.jsx adapts
    // this into window.SWITCH_SITES / window.ARC_MDF_STACK / makePortDetail.
    window.SWITCH_BOOT = <?= json_encode($data['boot'] ?? new stdClass(), JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE) ?>;
    // POST target for the CYCLE PoE button (admin-only on the server side).
    window.TCS_SWITCH_CYCLEPOE_URL = "zabbix.php?action=tcs.switch.cyclepoe";
    // POST target for PacketFence per-device actions (reevaluate / restart).
    window.TCS_PF_DEVICE_URL = "zabbix.php?action=tcs.pf.device";
    // Async data endpoints — switches-bridge.jsx fetches these after first paint.
    window.TCS_SWITCH_FLEET_URL    = "zabbix.php?action=tcs.switches.fleet.data";
    window.TCS_SWITCH_SNAPSHOT_URL = "zabbix.php?action=tcs.switches.snapshot.data";
    window.TCS_SWITCH_PORTHIST_URL = "zabbix.php?action=tcs.switches.port.history.data";
    window.TCS_SWITCH_XIQ_URL      = "zabbix.php?action=tcs.switches.xiq.data";

    // Disable Zabbix's standard whole-page refresh on this view. The user
    // profile "Refresh time" setting drives PageRefresh / location.reload
    // timers that we don't want clobbering our React tree state (selected
    // port, expanded site, active tab). Run-once at load + a follow-up tick
    // because Zabbix sometimes (re)installs the timer after DOMContentLoaded.
    (function disableZabbixRefresh() {
        const kill = () => {
            try {
                if (window.PageRefresh && typeof window.PageRefresh.stop === "function") {
                    window.PageRefresh.stop();
                }
            } catch (e) { /* no-op */ }
            // Strip any <meta http-equiv="refresh"> tags the layout emitted.
            document.querySelectorAll('meta[http-equiv="refresh" i]').forEach(m => m.remove());
        };
        kill();
        document.addEventListener("DOMContentLoaded", kill);
        setTimeout(kill, 0);
        setTimeout(kill, 250);
    })();
</script>

<script src="https://unpkg.com/react@18.3.1/umd/react.production.min.js" crossorigin="anonymous"></script>
<script src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js" crossorigin="anonymous"></script>
<script src="https://unpkg.com/@babel/standalone@7.29.0/babel.min.js" crossorigin="anonymous"></script>

<!-- Order matters: tweaks → primitives → shared shell → bridge → widgets/tabs → app entry -->
<script type="text/babel" src="<?= $asset_base ?>/tweaks-panel.jsx"></script>
<script type="text/babel" src="<?= $asset_base ?>/primitives.jsx"></script>
<script type="text/babel" src="<?= $asset_base ?>/global-nav.jsx"></script>
<script type="text/babel" src="<?= $asset_base ?>/nvr-shell.jsx"></script>
<script type="text/babel" src="<?= $asset_base ?>/switches-bridge.jsx"></script>
<script type="text/babel" src="<?= $asset_base ?>/switches-widgets.jsx"></script>
<script type="text/babel" src="<?= $asset_base ?>/switches-tabs.jsx"></script>
<script type="text/babel" src="<?= $asset_base ?>/switches-app.jsx"></script>
