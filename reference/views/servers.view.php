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
<link rel="stylesheet" href="<?= $asset_base ?>/servers.css">

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
</style>

<div id="root"></div>

<script>
    window.SERVERS_BOOT         = <?= json_encode($data['boot']   ?? null, JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT) ?>;
    window.SERVERS_HOSTID       = <?= json_encode($data['hostid'] ?? '',   JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT) ?>;
    window.TCS_SERVERS_DATA_URL = "zabbix.php?action=tcs.servers.data";
</script>

<script src="https://unpkg.com/react@18.3.1/umd/react.production.min.js" crossorigin="anonymous"></script>
<script src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js" crossorigin="anonymous"></script>
<script src="https://unpkg.com/@babel/standalone@7.29.0/babel.min.js" crossorigin="anonymous"></script>

<!-- Order: tweaks → primitives → unified sidebar → nvr-shell shim → live-data bridge → widgets → app -->
<script type="text/babel" src="<?= $asset_base ?>/tweaks-panel.jsx"></script>
<script type="text/babel" src="<?= $asset_base ?>/primitives.jsx"></script>
<script type="text/babel" src="<?= $asset_base ?>/global-nav.jsx"></script>
<script type="text/babel" src="<?= $asset_base ?>/nvr-shell.jsx"></script>
<script type="text/babel" src="<?= $asset_base ?>/servers-bridge.jsx"></script>
<script type="text/babel" src="<?= $asset_base ?>/servers-widgets.jsx"></script>
<script type="text/babel" src="<?= $asset_base ?>/servers-app.jsx"></script>
