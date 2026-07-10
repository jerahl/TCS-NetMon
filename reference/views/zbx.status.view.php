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
<link rel="stylesheet" href="<?= $v('packetfence.css') ?>">

<script>
    // SSR snapshot from ActionZbxStatus; zbx-status-bridge.jsx unpacks this into
    // the window.ZBX_* globals zbx-status-app.jsx reads, then refreshes via
    // tcs.zbx.status.data.
    window.ZBX_BOOT = <?= json_encode($data['boot'] ?? new stdClass(), JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE) ?>;
    window.TCS_ZBX_STATUS_DATA_URL = "zabbix.php?action=tcs.zbx.status.data";

    // Disable Zabbix's whole-page refresh on this view.
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
    .app[data-density="dense"]    .card-b   { padding: 10px; }
    .app[data-density="dense"]    .pf-kpi   { padding: 11px 12px; }
    .app[data-density="dense"]    .pf-kpi-v { font-size: 22px; }
    .app[data-density="spacious"] .card-b   { padding: 18px; }
    .app[data-density="spacious"] .pf-kpi   { padding: 22px 18px; }
    @media (max-width: 1280px) {
        .app { grid-template-columns: 64px 1fr; }
        .sidebar .nav-label, .sidebar .brand div:not(.brand-mark),
        .sidebar .nav-item span:not(.nav-count), .sidebar-footer { display: none; }
        .sidebar .nav-item { justify-content: center; }
    }

    /* ───────── Proxy table ───────── */
    .zbx-proxy-table { font-size: 12px; }
    .zbx-proxy-row {
        display: grid;
        grid-template-columns:
            24px        /* status dot */
            1.4fr       /* proxy id + ip */
            1.4fr       /* site */
            80px        /* mode */
            72px        /* version */
            72px        /* hosts */
            90px        /* items */
            90px        /* nvps */
            66px        /* queue */
            110px       /* CPU / Mem bars */
            88px        /* last seen */
            54px;       /* actions */
        gap: 12px;
        padding: 10px 14px;
        align-items: center;
        border-bottom: 1px solid var(--line);
    }
    .zbx-proxy-row:last-child { border-bottom: 0; }
    .zbx-proxy-row:hover { background: var(--bg-2); }
    .zbx-proxy-head {
        background: rgba(255,255,255,0.015);
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.6px;
        color: var(--muted);
        padding-top: 9px; padding-bottom: 9px;
        border-bottom: 1px solid var(--line);
    }
    .zbx-proxy-head:hover { background: rgba(255,255,255,0.015); }
    .zbx-proxy-down { background: rgba(242,95,92,0.04); }
    .zbx-proxy-down:hover { background: rgba(242,95,92,0.08); }

    .zbx-proxy-name { min-width: 0; }
    .zbx-proxy-name > .mono { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

    .zbx-mini-bar {
        height: 4px; background: var(--bg-2); border-radius: 2px; overflow: hidden;
    }
    .zbx-mini-bar > div { height: 100%; }

    @media (max-width: 1500px) {
        .zbx-proxy-row {
            grid-template-columns:
                24px 1.4fr 1.2fr 70px 60px 60px 80px 80px 56px 88px 80px 44px;
            gap: 10px;
        }
    }
    @media (max-width: 1280px) {
        .zbx-proxy-row { font-size: 11px; gap: 8px; }
    }

    /* 6-column KPI strip — collapses to 3 on narrower screens */
    .pf-kpis { grid-template-columns: repeat(6, 1fr); }
    @media (max-width: 1600px) {
        .pf-kpis { grid-template-columns: repeat(3, 1fr); }
        .pf-kpi:nth-child(3) { border-right: 0; }
        .pf-kpi:nth-child(-n+3) { border-bottom: 1px solid var(--line); }
    }

    /* Ring centering inside the cache panel */
    .ring { position: relative; display: inline-grid; place-items: center; }
    .ring-label { position: absolute; inset: 0; display: grid; place-items: center; text-align: center; }
</style>

<div id="root"></div>

<script src="https://unpkg.com/react@18.3.1/umd/react.production.min.js" crossorigin="anonymous"></script>
<script src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js" crossorigin="anonymous"></script>
<script src="https://unpkg.com/@babel/standalone@7.29.0/babel.min.js" crossorigin="anonymous"></script>

<script type="text/babel" src="<?= $v('tweaks-panel.jsx') ?>"></script>
<script type="text/babel" src="<?= $v('primitives.jsx') ?>"></script>
<script type="text/babel" src="<?= $v('global-nav.jsx') ?>"></script>
<script type="text/babel" src="<?= $v('zbx-status-bridge.jsx') ?>"></script>
<script type="text/babel" src="<?= $v('zbx-status-app.jsx') ?>"></script>
