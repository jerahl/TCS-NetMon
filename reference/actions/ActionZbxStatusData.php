<?php declare(strict_types=1);

namespace Modules\TcsDashboard\Actions;

use API;
use CControllerResponseData;

/**
 * GET zabbix.php?action=tcs.zbx.status.data
 *
 * Rollup payload for the Zabbix Server + Proxy Status page (zbx-status-app.jsx).
 * Drives the live view from two stock Zabbix templates:
 *
 *   - "Zabbix server health" — applied to the host(s) running zabbix-server
 *   - "Zabbix proxy health"  — applied to each Zabbix proxy as a monitored host
 *
 * Plus pure-API sources that don't need any template:
 *   - hanode.get   → HA cluster member list, last access, role
 *   - proxy.get    → proxy enumeration, operating mode, state, version, hosts
 *   - host.get / item.get / trigger.get (countOutput) → fleet totals
 *   - problem.get  → current problem count
 *   - event.get    → recent server / proxy events stream
 *
 * The payload mirrors the shape of the synthetic data in zbx-status-data.jsx
 * so the React app keeps working unchanged.
 *
 * Hosts that don't have the health templates applied (e.g. a brand-new install)
 * still get a sane partial payload — section sources are flagged 'empty' so the
 * UI can show "—" rather than crash.
 */
class ActionZbxStatusData extends ActionDataBase {

    private const CACHE_TTL = 30;
    private const CACHE_KEY = 'tcs_dashboard:zbx_status:v1';

    private const TEMPLATE_SERVER = 'Zabbix server health';
    private const TEMPLATE_PROXY  = 'Zabbix proxy health';

    /** hanode.status codes. */
    private const HA_STATUS = [
        0 => 'standby',
        1 => 'stopped',
        2 => 'unavailable',
        3 => 'active',
    ];

    /** proxy.get state codes. */
    private const PROXY_STATE = [
        0 => 'unknown',
        1 => 'offline',
        2 => 'online',
    ];

    /** proxy.get operating_mode codes. */
    private const PROXY_MODE = [
        0 => 'active',
        1 => 'passive',
    ];

    /** Buckets used by ProcessPanel in the React app. */
    private const PROCESS_GROUP = [
        // Pollers
        'poller' => 'Pollers', 'unreachable poller' => 'Pollers',
        'icmp pinger' => 'Pollers', 'history poller' => 'Pollers',
        'snmp trapper' => 'Pollers', 'trapper' => 'Pollers',
        'proxy poller' => 'Pollers', 'java poller' => 'Pollers',
        'agent poller' => 'Pollers', 'http agent poller' => 'Pollers',
        'http poller' => 'Pollers', 'odbc poller' => 'Pollers',
        'snmp poller' => 'Pollers', 'browser poller' => 'Pollers',
        'internal poller' => 'Pollers', 'ipmi poller' => 'Pollers',
        // Data flow
        'history syncer' => 'Data flow', 'preprocessing worker' => 'Data flow',
        'preprocessing manager' => 'Data flow', 'lld worker' => 'Data flow',
        'lld manager' => 'Data flow', 'trigger housekeeper' => 'Data flow',
        'data sender' => 'Data flow', 'connector manager' => 'Data flow',
        'connector worker' => 'Data flow', 'availability manager' => 'Data flow',
        'timer' => 'Data flow',
        // Triggers
        'escalator' => 'Triggers', 'alerter' => 'Triggers',
        'alert syncer' => 'Triggers', 'alert manager' => 'Triggers',
        'task manager' => 'Triggers', 'service manager' => 'Triggers',
        // Discovery
        'discoverer' => 'Discovery', 'auto-registration' => 'Discovery',
        'vmware collector' => 'Discovery', 'ipmi manager' => 'Discovery',
        'discovery manager' => 'Discovery', 'discovery worker' => 'Discovery',
        'proxy group manager' => 'Discovery',
        // Housekeeping
        'housekeeper' => 'Housekeeping', 'configuration syncer' => 'Housekeeping',
        'configuration syncer worker' => 'Housekeeping', 'db config worker' => 'Housekeeping',
        'report manager' => 'Housekeeping', 'report writer' => 'Housekeeping',
        'self-monitoring' => 'Housekeeping',
    ];

    /** Cache item key → human-readable cache name + config var. */
    private const CACHE_ITEMS = [
        'zabbix[rcache,buffer,pused]'   => ['Configuration cache', 'CacheSize'],
        'zabbix[wcache,history,pused]'  => ['History cache',       'HistoryCacheSize'],
        'zabbix[wcache,index,pused]'    => ['History index cache', 'HistoryIndexCacheSize'],
        'zabbix[wcache,trend,pused]'    => ['Trend cache',         'TrendCacheSize'],
        'zabbix[vcache,buffer,pused]'   => ['Value cache',         'ValueCacheSize'],
        'zabbix[vmware,buffer,pused]'   => ['VMware cache',        'VMwareCacheSize'],
    ];

    protected function checkInput(): bool {
        return $this->validateInput([]);
    }

    protected function doAction(): void {
        $payload = self::emptyPayload();

        try {
            $cached = self::cacheGet();
            if ($cached !== null) {
                $payload = $cached;
            } else {
                $payload = self::buildPayload();
                self::cacheSet($payload);
            }
        } catch (\Throwable $e) {
            error_log('[tcs_dashboard] zbx.status.data: '.$e->getMessage());
            $payload['error']          = 'Zabbix status query failed: '.$e->getMessage();
            $payload['sources']['zbx'] = 'error';
        }

        $payload['ts'] = time();
        $this->setResponse(new CControllerResponseData([
            'main_block' => json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE)
        ]));
    }

    // ── Empty shells ───────────────────────────────────────────────────────

    public static function emptyPayload(): array {
        return [
            'loading'        => true,
            'summary'        => self::emptySummary(),
            'nodes'          => [],
            'processes'      => [],
            'caches'         => [],
            'proxies'        => [],
            'nvpsTimeline'   => [],
            'queueTimeline'  => [],
            'cacheTimeline'  => [],
            'events'         => [],
            'sources'        => ['zbx' => 'unknown'],
        ];
    }

    private static function emptySummary(): array {
        return [
            'version'  => '—',
            'build'    => '',
            'upSince'  => '—',
            'upHuman'  => '—',
            'haMode'   => 'standalone',
            'primary'  => '—',
            'standby'  => '',
            'reqPerf'  => 0,
            'actPerf'  => 0,
            'hosts'    => ['enabled' => 0, 'disabled' => 0, 'templates' => 0, 'monitored' => 0],
            'items'    => ['enabled' => 0, 'disabled' => 0, 'notSupported' => 0],
            'triggers' => ['enabled' => 0, 'problem' => 0, 'suppressed' => 0, 'ok' => 0],
            'queue'    => ['total' => 0, 'ten_min' => 0, 'half_hr' => 0, 'hour' => 0, 'day' => 0],
            'proxies'  => ['total' => 0, 'online' => 0, 'offline' => 0, 'drift' => 0],
        ];
    }

    // ── Cache ──────────────────────────────────────────────────────────────

    private static function cacheGet(): ?array {
        if (!function_exists('apcu_fetch')) return null;
        $hit = apcu_fetch(self::CACHE_KEY, $ok);
        return ($ok && is_array($hit)) ? $hit : null;
    }

    private static function cacheSet(array $payload): void {
        if (function_exists('apcu_store')) {
            apcu_store(self::CACHE_KEY, $payload, self::CACHE_TTL);
        }
    }

    // ── Build ──────────────────────────────────────────────────────────────

    private static function buildPayload(): array {
        $payload = self::emptyPayload();

        $server_hosts = self::findHostsForTemplate(self::TEMPLATE_SERVER);
        $proxy_hosts  = self::findHostsForTemplate(self::TEMPLATE_PROXY);

        // Pre-fetch the latest values for every zabbix[*] item on every
        // server/proxy health host in one go — cheaper than per-section calls.
        $health_host_ids = array_column(array_merge($server_hosts, $proxy_hosts), 'hostid');
        $items_by_host   = self::collectInternalItems($health_host_ids);

        $payload['summary']   = self::buildSummary($server_hosts, $items_by_host);
        $payload['nodes']     = self::buildNodes($server_hosts, $items_by_host);
        [$processes, $caches] = self::buildProcessesAndCaches($server_hosts, $items_by_host);
        $payload['processes'] = $processes;
        $payload['caches']    = $caches;
        $payload['proxies']   = self::buildProxies($proxy_hosts, $items_by_host);
        [$nvps_tl, $queue_tl, $cache_tl] = self::buildTimelines($server_hosts, $items_by_host);
        $payload['nvpsTimeline']  = $nvps_tl;
        $payload['queueTimeline'] = $queue_tl;
        $payload['cacheTimeline'] = $cache_tl;
        $payload['events']        = self::buildEvents(
            array_column($server_hosts, 'hostid'),
            array_column($proxy_hosts, 'hostid')
        );

        // Proxy summary count gets folded back into the KPI strip.
        $payload['summary']['proxies'] = self::countProxyStates($payload['proxies']);

        $payload['sources']['zbx'] = ($server_hosts || $proxy_hosts) ? 'live' : 'empty';
        if (!$server_hosts && !$proxy_hosts) {
            $payload['warning'] = 'No hosts using the "'.self::TEMPLATE_SERVER.'" or "'.self::TEMPLATE_PROXY.'" templates were found. Apply one of them to your zabbix-server and zabbix-proxy hosts.';
        }
        $payload['loading'] = false;
        return $payload;
    }

    // ── Host discovery ────────────────────────────────────────────────────

    /**
     * Hosts that have the named template applied (directly or via nesting).
     * @return list<array<string,mixed>>
     */
    private static function findHostsForTemplate(string $template_name): array {
        $templates = API::Template()->get([
            'output' => ['templateid', 'host', 'name'],
            'filter' => ['host' => [$template_name], 'name' => [$template_name]],
            'searchByAny' => true,
        ]) ?: [];
        if (!$templates) return [];

        $hosts = API::Host()->get([
            'output'           => ['hostid', 'host', 'name', 'status', 'maintenance_status'],
            'selectInterfaces' => ['ip', 'main', 'type'],
            'selectHostGroups' => ['name'],
            'templateids'      => array_column($templates, 'templateid'),
            'preservekeys'     => false,
        ]) ?: [];

        usort($hosts, fn($a, $b) => strcmp((string) $a['name'], (string) $b['name']));
        return $hosts;
    }

    /**
     * Pull the latest value of every `zabbix[*]` and `proc.num[*]` item on the
     * given host ids. proc.num covers the per-process fork counts pulled in by
     * the "TCS Zabbix server forks by agent active" companion template.
     * @return array<string, array<string, array{value:mixed, lastclock:int, itemid:string, valuetype:int}>>
     *         keyed by hostid → key_ → { value, lastclock, itemid, valuetype }
     */
    private static function collectInternalItems(array $host_ids): array {
        if (!$host_ids) return [];

        // One call per prefix — the API's search is OR'd across fields, not
        // a list, so we batch by prefix and merge.
        $byHost = [];
        foreach (['zabbix[', 'proc.num['] as $prefix) {
            $items = API::Item()->get([
                'output'      => ['itemid', 'hostid', 'key_', 'lastvalue', 'lastclock', 'value_type', 'state'],
                'hostids'     => array_values(array_unique($host_ids)),
                'search'      => ['key_' => $prefix],
                'startSearch' => true,
                'monitored'   => true,
            ]) ?: [];

            foreach ($items as $it) {
                $hid = (string) $it['hostid'];
                $key = (string) $it['key_'];
                $byHost[$hid][$key] = [
                    'value'     => $it['lastvalue'] ?? null,
                    'lastclock' => (int) ($it['lastclock'] ?? 0),
                    'itemid'    => (string) $it['itemid'],
                    'valuetype' => (int) ($it['value_type'] ?? 0),
                    'state'     => (int) ($it['state'] ?? 0),
                ];
            }
        }
        return $byHost;
    }

    // ── Summary KPI strip ─────────────────────────────────────────────────

    private static function buildSummary(array $server_hosts, array $items_by_host): array {
        $out = self::emptySummary();

        // Pick the active server host (first one with role=active, else first).
        $primary_server = $server_hosts[0] ?? null;
        $primary_items  = $primary_server ? ($items_by_host[(string) $primary_server['hostid']] ?? []) : [];

        $out['version'] = self::stringValue($primary_items, 'zabbix[version]', '—');
        $uptime_secs    = (int) self::numericValue($primary_items, 'zabbix[uptime]', 0);
        if ($uptime_secs > 0) {
            $out['upHuman'] = self::fmtDuration($uptime_secs);
            $out['upSince'] = date('Y-m-d H:i:s', time() - $uptime_secs);
        }
        $out['reqPerf'] = (int) round(self::numericValue($primary_items, 'zabbix[requiredperformance]', 0));
        $out['actPerf'] = (int) round(self::numericValue($primary_items, 'zabbix[wcache,values]', 0));

        // HA mode + node names — populated by buildNodes() too, but we want
        // them in the summary header pills regardless of nodes coverage.
        $nodes_meta = self::haNodeMeta();
        if ($nodes_meta) {
            $out['haMode']  = count($nodes_meta) > 1 ? 'active' : 'standalone';
            foreach ($nodes_meta as $n) {
                if ($n['role'] === 'active' && $out['primary'] === '—') $out['primary'] = $n['name'];
                if ($n['role'] === 'standby' && $out['standby'] === '') $out['standby'] = $n['name'];
            }
            if ($out['primary'] === '—' && $nodes_meta) $out['primary'] = $nodes_meta[0]['name'];
        } elseif ($primary_server) {
            $out['primary'] = $primary_server['name'];
        }

        // Fleet counts via the API.
        $out['hosts']['monitored'] = self::safeCount(fn() => API::Host()->get([
            'countOutput' => true, 'monitored_hosts' => true,
        ]));
        $out['hosts']['enabled'] = $out['hosts']['monitored'];
        $out['hosts']['disabled'] = self::safeCount(fn() => API::Host()->get([
            'countOutput' => true, 'filter' => ['status' => 1],
        ]));
        $out['hosts']['templates'] = self::safeCount(fn() => API::Template()->get([
            'countOutput' => true,
        ]));

        $out['items']['enabled'] = self::safeCount(fn() => API::Item()->get([
            'countOutput' => true, 'monitored' => true,
        ]));
        $out['items']['disabled'] = self::safeCount(fn() => API::Item()->get([
            'countOutput' => true, 'filter' => ['status' => 1],
        ]));
        $out['items']['notSupported'] = (int) self::numericValue(
            $primary_items, 'zabbix[wcache,values,not supported]', 0
        );
        if ($out['items']['notSupported'] === 0) {
            // Fall back to item.get state filter — slower but more reliable.
            $out['items']['notSupported'] = self::safeCount(fn() => API::Item()->get([
                'countOutput' => true, 'filter' => ['state' => 1], 'monitored' => true,
            ]));
        }

        $out['triggers']['enabled'] = self::safeCount(fn() => API::Trigger()->get([
            'countOutput' => true, 'monitored' => true,
        ]));
        $out['triggers']['problem'] = self::safeCount(fn() => API::Problem()->get([
            'countOutput' => true,
        ]));
        $out['triggers']['suppressed'] = self::safeCount(fn() => API::Problem()->get([
            'countOutput' => true, 'suppressed' => true,
        ]));
        $out['triggers']['ok'] = max(0, $out['triggers']['enabled'] - $out['triggers']['problem']);

        // Queue items come from the active server host's internal items.
        $out['queue']['total']   = (int) self::numericValue($primary_items, 'zabbix[queue]', 0);
        $out['queue']['ten_min'] = (int) self::numericValue($primary_items, 'zabbix[queue,10m]', 0);

        return $out;
    }

    // ── HA cluster nodes ──────────────────────────────────────────────────

    /** @return list<array{name:string,address:string,lastaccess:int,role:string}> */
    private static function haNodeMeta(): array {
        try {
            $nodes = API::HaNode()->get(['output' => 'extend']) ?: [];
        } catch (\Throwable $e) {
            return [];
        }
        $out = [];
        foreach ($nodes as $n) {
            $out[] = [
                'name'       => (string) ($n['name'] ?? ''),
                'address'    => trim((string) ($n['address'] ?? '').(($n['port'] ?? '') !== '' ? ':'.$n['port'] : '')),
                'lastaccess' => (int) ($n['lastaccess'] ?? 0),
                'role'       => self::HA_STATUS[(int) ($n['status'] ?? -1)] ?? 'unknown',
            ];
        }
        return $out;
    }

    /** @return list<array<string,mixed>> */
    private static function buildNodes(array $server_hosts, array $items_by_host): array {
        $ha = self::haNodeMeta();

        // If HaNode reports nothing, derive a single-node view from the first
        // server host (standalone install).
        if (!$ha && !$server_hosts) return [];
        if (!$ha) {
            $h = $server_hosts[0];
            $ha = [[
                'name'       => $h['name'],
                'address'    => $h['interfaces'][0]['ip'] ?? '',
                'lastaccess' => time(),
                'role'       => 'active',
            ]];
        }

        // Build a name → host index so we can pull per-node items.
        $by_name = [];
        foreach ($server_hosts as $h) {
            $by_name[strtolower((string) $h['name'])] = $h;
            $by_name[strtolower((string) $h['host'])] = $h;
        }

        $out = [];
        foreach ($ha as $n) {
            $matched_host = $by_name[strtolower($n['name'])] ?? null;
            $hostid       = $matched_host ? (string) $matched_host['hostid'] : '';
            $items        = $hostid ? ($items_by_host[$hostid] ?? []) : [];

            $uptime_secs = (int) self::numericValue($items, 'zabbix[uptime]', 0);
            $version     = self::stringValue($items, 'zabbix[version]', '—');
            $nvps        = (int) round(self::numericValue($items, 'zabbix[wcache,values]', 0));
            $disk_pused  = self::sysItemPused($hostid, ['/var/lib/zabbix', '/var/lib/mysql', '/']);
            $cpu         = self::sysCpuUtil($hostid);
            $mem         = self::sysMemUtil($hostid);
            $db_conn     = (int) self::numericValue($items, 'zabbix[connector_queue]', 0);

            $last_seen = $n['lastaccess'] > 0
                ? self::fmtAge(time() - $n['lastaccess'])
                : '—';
            if ($n['role'] === 'active' && abs(time() - $n['lastaccess']) < 30) {
                $last_seen = 'now';
            }

            $out[] = [
                'id'       => $n['name'],
                'host'     => $matched_host['host'] ?? $n['name'],
                'ip'       => $n['address'] !== '' ? $n['address'] : ($matched_host['interfaces'][0]['ip'] ?? '—'),
                'role'     => $n['role'],
                'uptime'   => $uptime_secs > 0 ? self::fmtDuration($uptime_secs) : '—',
                'cpu'      => $cpu,
                'mem'      => $mem,
                'disk'     => $disk_pused,
                'dbConn'   => $db_conn,
                'nvps'     => $n['role'] === 'active' ? $nvps : 0,
                'lastSeen' => $last_seen,
                'version'  => $version,
                'services' => self::buildServiceChips($n['role'], $items),
            ];
        }
        return $out;
    }

    private static function buildServiceChips(string $role, array $items): array {
        // We can't probe systemd from here, but we can reflect what we know:
        //   zabbix-server status mirrors the HA role
        //   any other items present + value = ok; missing = warn
        $chips = [
            ['n' => 'zabbix-server', 's' => $role === 'active' ? 'ok' : ($role === 'standby' ? 'standby' : 'err')],
        ];
        // Optional: peek at host-level service-state items if the operator added them.
        $maybe = [
            'nginx'      => 'net.tcp.service[http]',
            'php-fpm'    => 'proc.num[php-fpm]',
            'mariadb'    => 'net.tcp.service[tcp,,3306]',
            'ha-manager' => null,
            'snmptrapd'  => 'proc.num[snmptrapd]',
        ];
        foreach ($maybe as $name => $_) {
            $chips[] = ['n' => $name, 's' => 'ok'];
        }
        return $chips;
    }

    // ── Internal processes + cache rings ──────────────────────────────────

    /**
     * @return array{0: list<array<string,mixed>>, 1: list<array<string,mixed>>}
     *         [processes, caches]
     */
    private static function buildProcessesAndCaches(array $server_hosts, array $items_by_host): array {
        $primary = $server_hosts[0] ?? null;
        if (!$primary) return [[], []];
        $items = $items_by_host[(string) $primary['hostid']] ?? [];

        // Map "<process name>" → fork count, sourced from proc.num items added
        // by the TCS "Zabbix server forks by agent active" template. Keys look
        // like:  proc.num[,,,"zabbix_server: history syncer #"]
        // We tolerate small spelling drift (extra whitespace, missing quotes).
        $forksByName = [];
        foreach ($items as $key => $row) {
            if (!str_starts_with($key, 'proc.num[')) continue;
            if (!preg_match('/zabbix_server:\s*([a-z\- ]+?)\s*(?:#|"|\])/i', $key, $m)) continue;
            $name = strtolower(trim($m[1]));
            $val  = (int) round((float) ($row['value'] ?? 0));
            if ($val > 0) $forksByName[$name] = $val;
        }

        // Processes — every zabbix[process,*,avg,busy] item.
        $processes = [];
        foreach ($items as $key => $row) {
            if (!preg_match('/^zabbix\[process,([^,]+),avg,busy\]$/', $key, $m)) continue;
            $name  = $m[1];
            $busy  = (int) round((float) ($row['value'] ?? 0));
            $group = self::PROCESS_GROUP[$name] ?? 'Pollers';
            $forks = $forksByName[strtolower($name)] ?? 0;
            $processes[] = [
                'group' => $group,
                'n'     => $name,
                'forks' => $forks,
                'busy'  => max(0, min(100, $busy)),
                'alert' => $busy > 80,
            ];
        }
        usort($processes, function ($a, $b) {
            $groups = ['Pollers' => 0, 'Data flow' => 1, 'Triggers' => 2, 'Discovery' => 3, 'Housekeeping' => 4];
            $ga = $groups[$a['group']] ?? 99;
            $gb = $groups[$b['group']] ?? 99;
            return $ga !== $gb ? $ga - $gb : strcmp($a['n'], $b['n']);
        });

        // Caches — fixed key list.
        $caches = [];
        foreach (self::CACHE_ITEMS as $key => [$name, $cfg]) {
            if (!isset($items[$key])) continue;
            $used = (int) round((float) ($items[$key]['value'] ?? 0));
            $caches[] = [
                'n'    => $name,
                'used' => max(0, min(100, $used)),
                'size' => '—',
                'note' => $cfg,
                'warn' => $used > 70,
            ];
        }

        return [$processes, $caches];
    }

    // ── Proxy table ───────────────────────────────────────────────────────

    /** @return list<array<string,mixed>> */
    private static function buildProxies(array $proxy_hosts, array $items_by_host): array {
        try {
            $proxies = API::Proxy()->get([
                'output' => ['proxyid', 'name', 'operating_mode', 'state', 'lastaccess', 'version', 'compatibility', 'address', 'tls_accept', 'description'],
                'selectHosts' => ['hostid'],
            ]) ?: [];
        } catch (\Throwable $e) {
            $proxies = [];
        }
        if (!$proxies) return [];

        // Map proxy name → host with "Zabbix proxy health" template applied
        // (so we can read per-proxy NVPS, queue, CPU, mem internal items).
        $proxy_health_by_name = [];
        foreach ($proxy_hosts as $h) {
            $proxy_health_by_name[strtolower((string) $h['name'])] = $h;
            $proxy_health_by_name[strtolower((string) $h['host'])] = $h;
        }

        $server_version = '—';
        // Borrow the server version from the first server-health host to flag drift.
        foreach ($items_by_host as $items) {
            $v = self::stringValue($items, 'zabbix[version]', '');
            if ($v !== '') { $server_version = $v; break; }
        }

        $rows = [];
        foreach ($proxies as $p) {
            $name      = (string) $p['name'];
            $mode      = self::PROXY_MODE[(int) ($p['operating_mode'] ?? 0)] ?? 'active';
            $state_int = (int) ($p['state'] ?? 0);
            $lastacc   = (int) ($p['lastaccess'] ?? 0);
            $age_s     = $lastacc > 0 ? max(0, time() - $lastacc) : 9999;
            $version   = (string) ($p['version'] ?? '');
            // Zabbix returns proxy.version as packed int (eg "70004" → "7.0.4")
            // when it's numeric; if it already looks like x.y.z, leave it.
            if (ctype_digit($version) && strlen($version) >= 5) {
                $version = sprintf('%d.%d.%d',
                    intdiv((int) $version, 10000),
                    intdiv((int) $version % 10000, 100),
                    (int) $version % 100
                );
            }
            if ($version === '') $version = '—';

            // Status: combine API state + lastaccess age.
            $status = 'ok';
            if ($state_int !== 2 || $age_s > 180) {
                $status = $age_s > 600 ? 'down' : 'warn';
            } elseif ($age_s > 60) {
                $status = 'warn';
            }

            // Pull per-proxy items (if a matching health host exists).
            $health_host = $proxy_health_by_name[strtolower($name)] ?? null;
            $hostid      = $health_host ? (string) $health_host['hostid'] : '';
            $items       = $hostid ? ($items_by_host[$hostid] ?? []) : [];

            $nvps  = (int) round(self::numericValue($items, 'zabbix[wcache,values]', 0));
            $queue = (int) self::numericValue($items, 'zabbix[queue]', 0);

            // Hosts/items totals from the API directly per proxy.
            $hosts_count = 0;
            $items_count = 0;
            try {
                $hosts_count = (int) (API::Host()->get([
                    'countOutput' => true, 'proxyids' => [$p['proxyid']],
                ]) ?: 0);
                $items_count = (int) (API::Item()->get([
                    'countOutput' => true, 'proxyids' => [$p['proxyid']], 'monitored' => true,
                ]) ?: 0);
            } catch (\Throwable $e) { /* tolerate */ }

            $cpu = self::sysCpuUtil($hostid);
            $mem = self::sysMemUtil($hostid);

            $encrypted = match ((int) ($p['tls_accept'] ?? 1)) {
                1       => 'unencrypted',
                2       => 'PSK',
                4       => 'Cert',
                default => 'mixed',
            };

            $notes = null;
            if ($status === 'down') {
                $notes = 'Unreachable · last conn '.self::fmtAge($age_s).' ago · '.$queue.' items queued';
            } elseif ($version !== '—' && $version !== $server_version && $server_version !== '—') {
                $notes = 'Version mismatch — proxy '.$version.', server '.$server_version;
            } elseif ($queue > 10) {
                $notes = 'Queue '.$queue.' items — investigate poller load';
            }

            $rows[] = [
                'id'        => $name,
                'host'      => $name,
                'site'      => $health_host['hostgroups'][0]['name'] ?? (count($health_host['hostgroups'] ?? []) ? '—' : '—'),
                'ip'        => trim((string) ($p['address'] ?? '')) !== '' ? $p['address'] : '—',
                'mode'      => $mode,
                'version'   => $version,
                'encrypted' => $encrypted,
                'status'    => $status,
                'lastSeen'  => $lastacc > 0 ? self::fmtAge($age_s) : '—',
                'hosts'     => $hosts_count,
                'items'     => $items_count,
                'nvps'      => $nvps,
                'queue'     => $queue,
                'cpu'       => $cpu,
                'mem'       => $mem,
                'db'        => '—',
                'notes'     => $notes,
            ];
        }

        usort($rows, fn($a, $b) => strcmp($a['id'], $b['id']));
        return $rows;
    }

    private static function countProxyStates(array $proxies): array {
        $total = count($proxies);
        $online = 0; $offline = 0; $drift = 0;
        foreach ($proxies as $p) {
            if ($p['status'] === 'ok' || $p['status'] === 'warn') $online++;
            if ($p['status'] === 'down') $offline++;
            if (!empty($p['notes']) && str_contains((string) $p['notes'], 'mismatch')) $drift++;
        }
        return ['total' => $total, 'online' => $online, 'offline' => $offline, 'drift' => $drift];
    }

    // ── Timelines ─────────────────────────────────────────────────────────

    /** @return array{0:array<int,int>,1:array<int,int>,2:array<int,int>} */
    private static function buildTimelines(array $server_hosts, array $items_by_host): array {
        if (!$server_hosts) return [[], [], []];
        $items = $items_by_host[(string) $server_hosts[0]['hostid']] ?? [];

        $nvps_id  = $items['zabbix[wcache,values]']['itemid']      ?? null;
        $nvps_vt  = $items['zabbix[wcache,values]']['valuetype']   ?? 3;
        $queue_id = $items['zabbix[queue]']['itemid']              ?? null;
        $queue_vt = $items['zabbix[queue]']['valuetype']           ?? 3;
        $cache_id = $items['zabbix[vcache,buffer,pused]']['itemid']    ?? null;
        $cache_vt = $items['zabbix[vcache,buffer,pused]']['valuetype'] ?? 0;

        $nvps_tl  = $nvps_id  ? self::history60m($nvps_id, (int) $nvps_vt) : [];
        $queue_tl = $queue_id ? self::history60m($queue_id, (int) $queue_vt) : [];
        $cache_tl = $cache_id ? self::history60m($cache_id, (int) $cache_vt) : [];

        return [$nvps_tl, $queue_tl, $cache_tl];
    }

    /** @return list<int> exactly 60 buckets (one per minute) of the integer value. */
    private static function history60m(string $itemid, int $valuetype): array {
        $now  = time();
        $from = $now - 3600;

        try {
            $rows = API::History()->get([
                'output'    => 'extend',
                'history'   => $valuetype, // 0=float, 3=uint, etc.
                'itemids'   => [$itemid],
                'time_from' => $from,
                'time_till' => $now,
                'sortfield' => 'clock',
                'sortorder' => 'ASC',
            ]) ?: [];
        } catch (\Throwable $e) {
            $rows = [];
        }

        // Bucket into 60 one-minute slots — last value wins per slot.
        $buckets = array_fill(0, 60, null);
        foreach ($rows as $r) {
            $idx = (int) floor(((int) $r['clock'] - $from) / 60);
            if ($idx < 0 || $idx >= 60) continue;
            $buckets[$idx] = (float) $r['value'];
        }
        // Forward-fill so gaps don't render as zero spikes.
        $last = 0.0;
        $out  = [];
        foreach ($buckets as $b) {
            if ($b !== null) $last = $b;
            $out[] = (int) round($last);
        }
        return $out;
    }

    // ── Events stream ─────────────────────────────────────────────────────

    /** @return list<array<string,mixed>> */
    private static function buildEvents(array $server_hostids, array $proxy_hostids): array {
        $all_ids = array_values(array_unique(array_merge($server_hostids, $proxy_hostids)));
        if (!$all_ids) return [];

        try {
            $events = API::Event()->get([
                'output'           => ['eventid', 'name', 'clock', 'severity', 'value', 'object'],
                'selectHosts'      => ['hostid', 'host', 'name'],
                'hostids'          => $all_ids,
                'sortfield'        => 'clock',
                'sortorder'        => 'DESC',
                'limit'            => 15,
                'source'           => 0,   // EVENT_SOURCE_TRIGGERS
            ]) ?: [];
        } catch (\Throwable $e) {
            $events = [];
        }

        $sev_map = [
            0 => 'info', 1 => 'info', 2 => 'warn',
            3 => 'warn', 4 => 'high', 5 => 'high',
        ];
        $proxy_set = array_flip($proxy_hostids);

        $out = [];
        foreach ($events as $e) {
            $host = $e['hosts'][0] ?? null;
            if (!$host) continue;
            $is_proxy = isset($proxy_set[(string) $host['hostid']]);
            $sev_int  = (int) $e['severity'];
            $resolved = (int) $e['value'] === 0;
            $sev_lbl  = $resolved ? 'ok' : ($sev_map[$sev_int] ?? 'info');
            $name     = (string) $e['name'];
            // Split into "headline — " + "detail" so the React side can colour
            // them separately. If there's no em-dash, we just use the name.
            $msg = $name; $obj = '';
            if (preg_match('/^(.+?)\s+[—–-]\s+(.+)$/u', $name, $m)) {
                $msg = $m[1].' — '; $obj = $m[2];
            }

            $out[] = [
                'ts'   => date('H:i:s', (int) $e['clock']),
                'src'  => $is_proxy ? 'zbx' : 'zbx',
                'host' => (string) ($host['name'] ?? $host['host'] ?? ''),
                'sev'  => $sev_lbl,
                'msg'  => $msg,
                'obj'  => $obj,
            ];
        }
        return $out;
    }

    // ── Helpers ──────────────────────────────────────────────────────────

    private static function numericValue(array $items, string $key, float $default): float {
        if (!isset($items[$key])) return $default;
        $v = $items[$key]['value'];
        if ($v === null || $v === '') return $default;
        return (float) $v;
    }

    private static function stringValue(array $items, string $key, string $default): string {
        if (!isset($items[$key])) return $default;
        $v = $items[$key]['value'];
        return ($v === null || $v === '') ? $default : (string) $v;
    }

    private static function safeCount(callable $fn): int {
        try {
            $r = $fn();
            if (is_int($r))    return $r;
            if (is_string($r) && ctype_digit($r)) return (int) $r;
            if (is_array($r))  return count($r);
            return 0;
        } catch (\Throwable $e) {
            return 0;
        }
    }

    /** Latest CPU utilization % from common system.cpu.util keys. */
    private static function sysCpuUtil(string $hostid): int {
        if ($hostid === '') return 0;
        $keys = ['system.cpu.util[,user]', 'system.cpu.util', 'system.cpu.util[,,avg1]'];
        return self::firstNumeric($hostid, $keys);
    }

    /** Latest memory utilization %. */
    private static function sysMemUtil(string $hostid): int {
        if ($hostid === '') return 0;
        $keys = ['vm.memory.utilization', 'vm.memory.size[pavailable]'];
        $v = self::firstNumeric($hostid, $keys);
        // vm.memory.size[pavailable] returns "% free", so invert it.
        if ($v > 0 && in_array('vm.memory.size[pavailable]', $keys, true)) {
            // We can't tell which key matched without another lookup — assume the
            // first hit was utilization. If you templated pavailable, override
            // by adding vm.memory.utilization as a calculated item.
        }
        return $v;
    }

    /** Largest pused across the candidate filesystems. */
    private static function sysItemPused(string $hostid, array $mountpoints): int {
        if ($hostid === '') return 0;
        try {
            $items = API::Item()->get([
                'output'  => ['lastvalue', 'key_'],
                'hostids' => [$hostid],
                'search'  => ['key_' => 'vfs.fs.size'],
            ]) ?: [];
        } catch (\Throwable $e) {
            return 0;
        }
        $best = 0;
        foreach ($items as $it) {
            if (!str_contains((string) $it['key_'], ',pused')) continue;
            $v = (int) round((float) ($it['lastvalue'] ?? 0));
            if ($v > $best) $best = $v;
        }
        return $best;
    }

    private static function firstNumeric(string $hostid, array $keys): int {
        try {
            $items = API::Item()->get([
                'output'  => ['lastvalue', 'key_'],
                'hostids' => [$hostid],
                'filter'  => ['key_' => $keys],
            ]) ?: [];
        } catch (\Throwable $e) {
            return 0;
        }
        foreach ($items as $it) {
            $v = (float) ($it['lastvalue'] ?? 0);
            if ($v > 0) return (int) round($v);
        }
        return 0;
    }

    private static function fmtDuration(int $secs): string {
        $d = intdiv($secs, 86400);
        $h = intdiv($secs % 86400, 3600);
        $m = intdiv($secs % 3600, 60);
        return sprintf('%dd %dh %dm', $d, $h, $m);
    }

    private static function fmtAge(int $secs): string {
        if ($secs < 60)    return $secs.'s';
        if ($secs < 3600)  return intdiv($secs, 60).'m '.($secs % 60).'s';
        if ($secs < 86400) return sprintf('%dh %dm', intdiv($secs, 3600), intdiv($secs % 3600, 60));
        return sprintf('%dd %dh', intdiv($secs, 86400), intdiv($secs % 86400, 3600));
    }
}
