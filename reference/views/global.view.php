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

<style>
    html.hide-src-badges .src-badge { display: none !important; }
    .app[data-density="dense"]    .card-b   { padding: 10px; }
    .app[data-density="dense"]    .sev-cell { padding: 11px 12px; }
    .app[data-density="dense"]    .domain-row { padding: 9px 12px; }
    .app[data-density="spacious"] .card-b   { padding: 18px; }
    .app[data-density="spacious"] .sev-cell { padding: 22px 18px; }
    .app[data-density="spacious"] .domain-row { padding: 16px; }
    @media (max-width: 1280px) {
        .app { grid-template-columns: 64px 1fr; }
        .sidebar .nav-label, .sidebar .brand div:not(.brand-mark),
        .sidebar .nav-item span:not(.nav-count), .sidebar-footer { display: none; }
        .sidebar .nav-item { justify-content: center; }
    }
</style>

<div id="root"></div>

<script>
    window.GLOBAL_BOOT         = <?= json_encode($data['boot'] ?? null, JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT) ?>;
    window.TCS_GLOBAL_DATA_URL = "zabbix.php?action=tcs.global.data";
</script>

<script defer src="<?= $asset_base ?>/vendor/react.production.min.js"></script>
<script defer src="<?= $asset_base ?>/vendor/react-dom.production.min.js"></script>

<!-- Order: tweaks → primitives → unified sidebar → live-data bridge → global app -->
<script defer src="<?= $asset_base ?>/dist/tweaks-panel.js"></script>
<script defer src="<?= $asset_base ?>/dist/primitives.js"></script>
<script defer src="<?= $asset_base ?>/dist/global-nav.js"></script>
<script defer src="<?= $asset_base ?>/dist/global-bridge.js"></script>
<script defer src="<?= $asset_base ?>/dist/global-app.js"></script>
