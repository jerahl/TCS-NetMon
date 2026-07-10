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
<link rel="stylesheet" href="<?= $v('xdr.css') ?>">

<style>
    html.hide-src-badges .src-badge { display: none !important; }
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
<script type="text/babel" src="<?= $v('xdr-data.jsx') ?>"></script>
<script type="text/babel" src="<?= $v('xdr-app.jsx') ?>"></script>
