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
<link rel="stylesheet" href="<?= $asset_base ?>/global.css">
<link rel="stylesheet" href="<?= $asset_base ?>/xiq.css">

<style>
    html.hide-src-badges .src-badge { display: none !important; }
    .app[data-density="dense"]    .card-b       { padding: 10px; }
    .app[data-density="dense"]    .xiq-kpi-cell { padding: 10px 12px; }
    .app[data-density="dense"]    .band-row     { padding: 9px 12px; }
    .app[data-density="dense"]    .pap-row      { padding: 8px 12px; }
    .app[data-density="spacious"] .card-b       { padding: 18px; }
    .app[data-density="spacious"] .xiq-kpi-cell { padding: 18px; }
    .app[data-density="spacious"] .band-row     { padding: 16px; }
    .app[data-density="spacious"] .pap-row      { padding: 14px 16px; }
    @media (max-width: 1280px) {
        .app { grid-template-columns: 64px 1fr; }
        .sidebar .nav-label, .sidebar .brand div:not(.brand-mark), .sidebar .nav-item span:not(.nav-count), .sidebar-footer { display: none; }
        .sidebar .nav-item { justify-content: center; }
    }
    .tcs-boot {
        position: fixed; inset: 0; display: flex; flex-direction: column;
        align-items: center; justify-content: center; gap: 14px;
        background: #0d1117; color: #c9d1d9; font: 13px/1.4 "Inter", system-ui, sans-serif;
    }
    .tcs-boot .spinner {
        width: 36px; height: 36px; border-radius: 50%;
        border: 3px solid rgba(124, 92, 255, 0.15);
        border-top-color: #7c5cff;
        animation: tcs-spin 0.8s linear infinite;
    }
    .tcs-boot .label { color: #6e7681; font-size: 12px; letter-spacing: 0.04em; text-transform: uppercase; }
    @keyframes tcs-spin { to { transform: rotate(360deg); } }
</style>

<div id="root">
    <div class="tcs-boot" role="status" aria-live="polite">
        <div class="spinner" aria-hidden="true"></div>
        <div class="label">Loading wireless fleet…</div>
    </div>
</div>

<script>
    // SSR snapshot from ActionXiq; xiq-bridge.jsx unpacks this into the
    // window.XIQ_* globals xiq-app.jsx reads, then refreshes via tcs.xiq.data.
    window.XIQ_BOOT = <?= json_encode($data['boot'] ?? new stdClass(), JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE) ?>;
    window.TCS_XIQ_DATA_URL = "zabbix.php?action=tcs.xiq.data";

    // Disable Zabbix's whole-page refresh on this view (see switches.view.php
    // for the same dance — Zabbix sometimes (re)installs PageRefresh after
    // DOMContentLoaded, so we kill it twice).
    (function disableZabbixRefresh() {
        const kill = () => {
            try {
                if (window.PageRefresh && typeof window.PageRefresh.stop === "function") {
                    window.PageRefresh.stop();
                }
            } catch (e) { /* no-op */ }
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

<!-- Order matters: tweaks → primitives → shared shell → bridge → app entry -->
<script type="text/babel" src="<?= $asset_base ?>/tweaks-panel.jsx"></script>
<script type="text/babel" src="<?= $asset_base ?>/primitives.jsx"></script>
<script type="text/babel" src="<?= $asset_base ?>/global-nav.jsx"></script>
<script type="text/babel" src="<?= $asset_base ?>/xiq-bridge.jsx"></script>
<script type="text/babel" src="<?= $asset_base ?>/xiq-app.jsx"></script>
