<?php declare(strict_types=1);

/**
 * @var CView $this
 * @var array $data
 */

$asset_base = 'modules/tcs_dashboard/assets';
$asset_dir  = __DIR__.'/../assets';
$v = static function (string $rel) use ($asset_base, $asset_dir): string {
    $abs = $asset_dir.'/'.$rel;
    $mt  = @filemtime($abs) ?: time();
    return $asset_base.'/'.$rel.'?v='.$mt;
};
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
<link rel="stylesheet" href="<?= $v('styles.css') ?>">
<link rel="stylesheet" href="<?= $v('global.css') ?>">
<link rel="stylesheet" href="<?= $v('xiq.css') ?>">
<link rel="stylesheet" href="<?= $v('fortigate.css') ?>">

<script>
    // SSR snapshot from ActionFortigate; fortigate-bridge.jsx unpacks this into
    // the window.FG_* globals fortigate-app.jsx reads, then refreshes via
    // tcs.fortigate.data.
    window.FG_BOOT = <?= json_encode($data['boot'] ?? new stdClass(), JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE) ?>;
    window.TCS_FORTIGATE_DATA_URL = "zabbix.php?action=tcs.fortigate.data";

    // Disable Zabbix's whole-page refresh on this view (same dance as
    // switches.view.php / xiq.view.php).
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

<style>
    html.hide-src-badges .src-badge { display: none !important; }
    .app[data-density="dense"]    .card-b       { padding: 10px; }
    .app[data-density="dense"]    .fg-kpi-cell  { padding: 10px 12px; }
    .app[data-density="dense"]    .sess-row     { padding: 9px 12px; }
    .app[data-density="dense"]    .ipsec-row,
    .app[data-density="dense"]    .sslvpn-row,
    .app[data-density="dense"]    .thr-row      { padding: 7px 12px; }
    .app[data-density="spacious"] .card-b       { padding: 18px; }
    .app[data-density="spacious"] .fg-kpi-cell  { padding: 18px; }
    .app[data-density="spacious"] .sess-row     { padding: 16px; }
    .app[data-density="spacious"] .ipsec-row,
    .app[data-density="spacious"] .sslvpn-row,
    .app[data-density="spacious"] .thr-row      { padding: 12px 16px; }
    @media (max-width: 1280px) {
        .app { grid-template-columns: 64px 1fr; }
        .sidebar .nav-label, .sidebar .brand div:not(.brand-mark),
        .sidebar .nav-item span:not(.nav-count), .sidebar-footer { display: none; }
        .sidebar .nav-item { justify-content: center; }
    }
</style>

<div id="root"></div>

<script src="https://unpkg.com/react@18.3.1/umd/react.production.min.js" crossorigin="anonymous"></script>
<script src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js" crossorigin="anonymous"></script>
<script src="https://unpkg.com/@babel/standalone@7.29.0/babel.min.js" crossorigin="anonymous"></script>

<script type="text/babel" src="<?= $v('tweaks-panel.jsx') ?>"></script>
<script type="text/babel" src="<?= $v('primitives.jsx') ?>"></script>
<script type="text/babel" src="<?= $v('global-nav.jsx') ?>"></script>
<script type="text/babel" src="<?= $v('fortigate-bridge.jsx') ?>"></script>
<script type="text/babel" src="<?= $v('fortigate-app.jsx') ?>"></script>
