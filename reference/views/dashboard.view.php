<?php declare(strict_types=1);

/**
 * @var CView $this
 * @var array $data
 */

// $data['boot'] is the snapshot collected by ActionDashboard.
$boot_json = json_encode($data['boot'], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);

// Asset URLs. Files in ui/modules/tcs_dashboard/assets/ are web-accessible
// directly because they sit under the document root.
$asset_base = 'modules/tcs_dashboard/assets';

// Inline a minimal reset that hides the Zabbix layout chrome that
// layout.htmlpage still emits (header/sidebar shells), so the dashboard gets
// the full viewport. If you'd rather keep Zabbix chrome, delete this block.
?>
<style>
    body > header, body > nav, body > aside, body > footer, body > .menu-main, body > .header-title, .wrapper > footer, footer[role="contentinfo"], .msg-global-footer, #page-footer { display: none !important; }
    body { margin: 0 !important; padding: 0 !important; background: #0d1117 !important; }
    main, .wrapper, .article { padding: 0 !important; margin: 0 !important; max-width: none !important; }
    /* Avoid Zabbix's base styles bleeding through into our cards. */
    main { all: revert; }
</style>

<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="<?= $asset_base ?>/styles.css">

<style>
    /* Density + responsive tweaks lifted from the original Zabbix Dashboard.html */
    html.hide-src-badges .src-badge { display: none !important; }
    .app[data-density="dense"]    .card-b      { padding: 10px; }
    .app[data-density="dense"]    .health-cell { padding: 12px 8px; }
    .app[data-density="dense"]    .kv .k,
    .app[data-density="dense"]    .kv .v,
    .app[data-density="dense"]    .kv .b       { padding: 6px 12px; }
    .app[data-density="spacious"] .card-b      { padding: 18px; }
    .app[data-density="spacious"] .health-cell { padding: 22px 18px; }
    .app[data-density="spacious"] .kv .k,
    .app[data-density="spacious"] .kv .v,
    .app[data-density="spacious"] .kv .b       { padding: 12px 16px; }
    @media (max-width: 1500px) {
        .overview .row[style*="1.4fr 1fr .9fr"] { grid-template-columns: 1fr 1fr !important; }
        .overview .row[style*="1.4fr 1fr .9fr"] > .card:last-child { grid-column: 1 / -1; }
    }
    @media (max-width: 1280px) {
        .app { grid-template-columns: 64px 1fr; }
        .sidebar .nav-label, .sidebar .brand div:not(.brand-mark),
        .sidebar .nav-item span:not(.nav-count), .sidebar-footer { display: none; }
        .sidebar .nav-item { justify-content: center; }
    }
</style>

<div id="root"></div>

<script>
    // Server-collected snapshot. The data-bridge below adapts this into the
    // window.ZBX_HOST / window.ZBX_ITEMS / etc. globals the existing JSX
    // expects, so app.jsx and friends are unmodified.
    window.ZBX_BOOT = <?= $boot_json ?: 'null' ?>;
    window.TCS_DATA_URL = 'zabbix.php?action=tcs.dashboard.data';
    window.TCS_PF_DEVICE_URL = 'zabbix.php?action=tcs.pf.device';
    window.TCS_SWITCH_CYCLEPOE_URL = 'zabbix.php?action=tcs.switch.cyclepoe';
    window.TCS_XIQ_REBOOT_URL = 'zabbix.php?action=tcs.xiq.ap.reboot';
</script>

<!-- React + Babel via CDN. For air-gapped installs, vendor these into assets/ and update the src= paths. -->
<script src="https://unpkg.com/react@18.3.1/umd/react.production.min.js" crossorigin="anonymous"></script>
<script src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js" crossorigin="anonymous"></script>
<script src="https://unpkg.com/@babel/standalone@7.29.0/babel.min.js" crossorigin="anonymous"></script>

<!-- Order matters: bridge first (defines the data globals), then primitives, the unified sidebar, tabs, shell, app. -->
<script type="text/babel" src="<?= $asset_base ?>/data-bridge.jsx"></script>
<script type="text/babel" src="<?= $asset_base ?>/tweaks-panel.jsx"></script>
<script type="text/babel" src="<?= $asset_base ?>/primitives.jsx"></script>
<script type="text/babel" src="<?= $asset_base ?>/global-nav.jsx"></script>
<script type="text/babel" src="<?= $asset_base ?>/tabs.jsx"></script>
<script type="text/babel" src="<?= $asset_base ?>/shell.jsx"></script>
<script type="text/babel" src="<?= $asset_base ?>/app.jsx"></script>
