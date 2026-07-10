<?php declare(strict_types=1);

namespace Modules\TcsDashboard\Actions;

use API;
use CControllerResponseData;

/**
 * GET zabbix.php?action=tcs.fortigate.data
 *
 * Rollup payload for the FortiGate firewall dashboard (fortigate-app.jsx).
 * Driven entirely by the "FortiGate by SNMP" template — pulls host metadata,
 * device-level counters (CPU/mem/disk/sessions/IPS/VPN), interfaces (LLD),
 * SD-WAN links (LLD), and VPN tunnels (LLD), plus recent host problems for
 * the events stream. The HA mode label is included in the header pill but
 * the dashboard no longer renders a dedicated HA cluster tile.
 *
 * Discovery: any host whose template ancestry includes "FortiGate by SNMP".
 * When multiple FortiGate hosts exist (e.g. an HA pair monitored as two
 * separate hosts), one is picked as the primary view — preference order:
 *   1. {$TCS.FORTIGATE.HOST} global macro (host name match)
 *   2. host with HA mode != Standalone, lowest hostid
 *   3. first host alphabetically
 *
 * Sections the SNMP template does NOT cover (per-IPsec byte counters with
 * site labels, per-user SSL-VPN, top threat signatures, top firewall
 * policies) come back empty — the cards render an empty state.
 */
class ActionFortigateData extends ActionDataBase {

    private const CACHE_TTL = 30;
    private const CACHE_KEY = 'tcs_dashboard:fortigate:v1';

    /** Template name. The dashboard expects items keyed by this template. */
    private const TEMPLATE_NAME = 'FortiGate by SNMP';

    /** Override macro for primary host selection. */
    private const HOST_MACRO = '{$TCS.FORTIGATE.HOST}';

    /** SNMPv2 ha.mode codes (FORTINET-FORTIGATE-MIB::fgHaSystemMode). */
    private const HA_MODE = [
        1 => 'Standalone',
        2 => 'Active-Active',
        3 => 'Active-Passive',
    ];

    /** ifOperStatus codes (IF-MIB). */
    private const IF_OPER = [
        1 => 'up', 2 => 'down', 3 => 'testing', 4 => 'unknown',
        5 => 'dormant', 6 => 'notPresent', 7 => 'lowerLayerDown',
    ];

    /** vpn.tunnel.status mapping (per valuemap). */
    private const VPN_TUNNEL = [1 => 'up', 2 => 'down'];

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
            error_log('[tcs_dashboard] fortigate.data: ' . $e->getMessage());
            $payload['error']           = 'FortiGate data query failed: ' . $e->getMessage();
            $payload['sources']['zbx']  = 'error';
        }

        $payload['ts'] = time();
        $this->setResponse(new CControllerResponseData([
            'main_block' => json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE)
        ]));
    }

    // ── Public: empty shell, used both for SSR boot and as a fallback ──────

    public static function emptyPayload(): array {
        return [
            'loading'    => true,
            'device'     => self::emptyDevice(),
            'totals'     => self::emptyTotals(),
            'interfaces' => [],
            'ipsec'      => [],
            'sslvpn'     => [],
            'sdwan'      => ['rules' => 0, 'preferredLink' => '', 'sla' => [], 'latencyHistory' => new \stdClass()],
            'utm'        => self::emptyUtm(),
            'topThreats' => [],
            'topPolicies'=> [],
            'sessions24h'   => [],
            'newSessions24h'=> [],
            'throughput24h' => ['ingress' => [], 'egress' => []],
            'events'     => [],
            'sources'    => ['zbx' => 'unknown'],
        ];
    }

    private static function emptyDevice(): array {
        return [
            'host'    => '—',
            'model'   => '—',
            'serial'  => '—',
            'fos'     => '—',
            'uptime'  => '—',
            'ha'      => '—',
            'mgmtIp'  => '—',
            'lastSync'=> '—',
            'site'    => '—',
            'serial2' => '',
        ];
    }

    private static function emptyTotals(): array {
        return [
            'sessions'   => ['active' => 0, 'new_per_s' => 0, 'peak' => 0, 'limit' => 0],
            'throughput' => ['total_gbps' => 0.0, 'wan_in_gbps' => 0.0, 'wan_out_gbps' => 0.0, 'lan_gbps' => 0.0, 'peak_gbps' => 0.0],
            'cpu'        => ['now' => 0, 'peak15m' => 0, 'target' => 70],
            'mem'        => ['now' => 0, 'peak15m' => 0, 'target' => 80],
            'disk'       => ['now' => 0, 'target' => 75],
            'threats'    => ['ips_blocks_24h' => 0, 'av_blocks_24h' => 0, 'web_blocks_24h' => 0, 'app_blocks_24h' => 0],
            'vpn'        => ['ipsec_up' => 0, 'ipsec_total' => 0, 'ssl_users' => 0, 'ssl_peak_24h' => 0],
            'policies'   => ['total' => 0, 'active' => 0, 'unused_30d' => 0],
            'fortiguard' => ['ips' => '—', 'av' => '—', 'webfilter' => '—', 'appctrl' => '—', 'expiresDays' => 0],
        ];
    }

    private static function emptyUtm(): array {
        // The dashboard renders a 6-cell grid; keep the shape even when empty.
        return [
            ['id' => 'ips', 'label' => 'IPS / IDS',       'blocks' => 0, 'unique' => 0, 'severity_hi' => 0, 'color' => 'var(--err)'],
            ['id' => 'av',  'label' => 'Antivirus',       'blocks' => 0, 'unique' => 0, 'severity_hi' => 0, 'color' => 'var(--warn)'],
            ['id' => 'wf',  'label' => 'Web filter',      'blocks' => 0, 'unique' => 0, 'severity_hi' => 0, 'color' => 'var(--info)'],
            ['id' => 'ac',  'label' => 'Application ctrl','blocks' => 0, 'unique' => 0, 'severity_hi' => 0, 'color' => 'var(--ext)'],
            ['id' => 'dns', 'label' => 'DNS filter',      'blocks' => 0, 'unique' => 0, 'severity_hi' => 0, 'color' => 'var(--cx)'],
            ['id' => 'bot', 'label' => 'Botnet C&C',      'blocks' => 0, 'unique' => 0, 'severity_hi' => 0, 'color' => 'var(--zbx)'],
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

        // 1. Find FortiGate hosts via template
        $hosts = self::findFortigateHosts();
        if (!$hosts) {
            $payload['sources']['zbx'] = 'empty';
            $payload['error'] = 'No FortiGate hosts found. Looked for hosts using the "' . self::TEMPLATE_NAME . '" template.';
            return $payload;
        }

        $primary = self::pickPrimaryHost($hosts);
        $primaryId = (string) $primary['hostid'];

        // 2. Pull items for the primary host in a single call
        $items = self::collectItems($primaryId);
        $byKey   = $items['byKey'];
        $lldKeys = $items['lld'];

        // 3. Device fields
        $payload['device'] = self::buildDevice($primary, $byKey);

        // 4. Totals (CPU / mem / disk / sessions / IPS / VPN)
        $payload['totals'] = self::buildTotals($byKey, $lldKeys);

        // 5. Interfaces
        $payload['interfaces'] = self::buildInterfaces($lldKeys);

        // 6. IPsec / VPN tunnels (status only — byte counters aren't in template)
        $tunnels = self::buildIpsec($lldKeys);
        $payload['ipsec'] = $tunnels['rows'];
        $payload['totals']['vpn']['ipsec_up']    = $tunnels['up'];
        $payload['totals']['vpn']['ipsec_total'] = $tunnels['total'];

        // 7. SD-WAN per-link SLA
        $payload['sdwan'] = self::buildSdwan($lldKeys);

        // 8. UTM rollup from ips.detected/blocked counters
        $payload['utm'] = self::buildUtm($byKey);

        // 9. Events from host problems
        $payload['events'] = self::buildEvents(array_column($hosts, 'hostid'), $hosts);

        $payload['sources']['zbx'] = 'live';
        $payload['loading']        = false;
        return $payload;
    }

    // ── Host discovery ─────────────────────────────────────────────────────

    /** @return list<array{hostid:string,host:string,name:string,interfaces:array,inventory:array}> */
    private static function findFortigateHosts(): array {
        $templates = API::Template()->get([
            'output' => ['templateid', 'host', 'name'],
            'filter' => ['host' => [self::TEMPLATE_NAME], 'name' => [self::TEMPLATE_NAME]],
            'searchByAny' => true,
        ]) ?: [];
        // Also try a search for the template by partial name (case where the
        // operator imported it under a slightly different alias).
        if (!$templates) {
            $templates = API::Template()->get([
                'output'      => ['templateid', 'host', 'name'],
                'search'      => ['name' => 'FortiGate by SNMP'],
                'startSearch' => true,
            ]) ?: [];
        }
        if (!$templates) return [];

        $hosts = API::Host()->get([
            'output'           => ['hostid', 'host', 'name', 'status', 'maintenance_status'],
            'selectInterfaces' => ['interfaceid', 'ip', 'main', 'type', 'available'],
            'selectInventory'  => ['model', 'serialno_a', 'serialno_b', 'location', 'contact', 'os', 'os_full', 'site_address_a'],
            'selectTags'       => ['tag', 'value'],
            'templateids'      => array_column($templates, 'templateid'),
            'preservekeys'     => false,
        ]) ?: [];

        usort($hosts, fn($a, $b) => strcmp((string) $a['name'], (string) $b['name']));
        return $hosts;
    }

    /** Choose which host's items drive the main dashboard view. */
    private static function pickPrimaryHost(array $hosts): array {
        // 1. Operator override
        $override = self::globalMacro(self::HOST_MACRO);
        if ($override !== '') {
            foreach ($hosts as $h) {
                if (strcasecmp((string) $h['name'], $override) === 0 ||
                    strcasecmp((string) $h['host'], $override) === 0) {
                    return $h;
                }
            }
        }
        // 2. Just the first by name — most deployments only template the
        //    cluster's management VIP as a single host anyway.
        return $hosts[0];
    }

    private static function globalMacro(string $name): string {
        $rows = API::UserMacro()->get([
            'output'      => ['macro', 'value'],
            'globalmacro' => true,
            'filter'      => ['macro' => $name],
        ]) ?: [];
        return trim((string) ($rows[0]['value'] ?? ''));
    }

    // ── Item collection ────────────────────────────────────────────────────

    /**
     * Pull every item from a host once, then bucket:
     *   - byKey: items keyed by the literal full key (`system.cpu.util[fgSysCpuUsage.0]`)
     *            Used for fixed device-level items.
     *   - lld:   items keyed by the leading "key prefix" (everything before "["),
     *            each entry a list of rows tagged with their {#SNMPINDEX} and
     *            associated tag values.
     */
    private static function collectItems(string $hostid): array {
        $rows = API::Item()->get([
            'output'      => ['itemid', 'key_', 'name', 'lastvalue', 'lastclock', 'units', 'value_type'],
            'selectTags'  => ['tag', 'value'],
            'hostids'     => [$hostid],
            'webitems'    => true,
            'limit'       => 50000,
        ]) ?: [];

        $byKey = [];
        $lld   = [];
        foreach ($rows as $r) {
            $key = (string) $r['key_'];
            $byKey[$key] = $r;

            // Bucket by prefix for LLD-discovered items (...[<INDEX>])
            if (preg_match('/^([a-zA-Z0-9_.]+)\[(.+)\]$/', $key, $m)) {
                $prefix = $m[1];
                $index  = $m[2];
                $r['_index'] = $index;
                $lld[$prefix][] = $r;
            }
        }
        return ['byKey' => $byKey, 'lld' => $lld];
    }

    private static function itemVal(array $byKey, string $key, $default = null) {
        if (!isset($byKey[$key])) return $default;
        $v = $byKey[$key]['lastvalue'] ?? null;
        return ($v === null || $v === '') ? $default : $v;
    }

    private static function itemNum(array $byKey, string $key, float $default = 0.0): float {
        $v = self::itemVal($byKey, $key, null);
        return $v === null ? $default : (float) $v;
    }

    private static function itemInt(array $byKey, string $key, int $default = 0): int {
        $v = self::itemVal($byKey, $key, null);
        return $v === null ? $default : (int) $v;
    }

    private static function itemStr(array $byKey, string $key, string $default = ''): string {
        $v = self::itemVal($byKey, $key, null);
        return $v === null ? $default : (string) $v;
    }

    private static function tagByName(array $row, string $tag): string {
        foreach (($row['tags'] ?? []) as $t) {
            if (($t['tag'] ?? '') === $tag) return (string) ($t['value'] ?? '');
        }
        return '';
    }

    // ── Section builders ───────────────────────────────────────────────────

    private static function buildDevice(array $host, array $byKey): array {
        // sysDescr: parse for model + FortiOS build. Example:
        // "FortiGate-600F v7.4.4,build2662,240625 (GA.M)"
        $descr = self::itemStr($byKey, 'system.descr[sysDescr.0]', '');
        $model = '—'; $fos = '—';
        if ($descr !== '') {
            if (preg_match('/^(FortiGate[^\s,]+)/i', $descr, $m)) $model = $m[1];
            if (preg_match('/v[\d.]+,build\d+/i', $descr, $m))    $fos   = $m[0];
        }
        if ($model === '—' && !empty($host['inventory']['model'])) {
            $model = (string) $host['inventory']['model'];
        }

        $uptimeS = self::itemInt($byKey, 'system.uptime[fgSysUpTime.0]', 0);
        $uptime  = $uptimeS > 0 ? self::formatUptime($uptimeS) : '—';

        $haModeCode = self::itemInt($byKey, 'ha.mode[fgHaSystemMode.0]', 0);
        $haGroup    = self::itemStr($byKey, 'ha.cluster.group_name[fgHaGroupName.0]', '');
        $haGid      = self::itemInt($byKey, 'ha.cluster.group_id[fgHaGroupId.0]', 0);
        $haLabel    = self::HA_MODE[$haModeCode] ?? '—';
        if ($haLabel !== 'Standalone' && $haLabel !== '—') {
            $haLabel .= ' · group ' . ($haGroup !== '' ? $haGroup : (string) $haGid);
        }

        // Pick the SNMP interface IP for mgmt
        $mgmtIp = '—';
        foreach (($host['interfaces'] ?? []) as $iface) {
            if ((int) ($iface['type'] ?? 0) === 2 /* SNMP */ && (int) ($iface['main'] ?? 0) === 1) {
                $mgmtIp = (string) ($iface['ip'] ?? '—');
                break;
            }
        }
        if ($mgmtIp === '—' && !empty($host['interfaces'])) {
            $mgmtIp = (string) ($host['interfaces'][0]['ip'] ?? '—');
        }

        // Use the most recent item clock as "last SNMP poll"
        $maxClock = 0;
        foreach ($byKey as $r) {
            $c = (int) ($r['lastclock'] ?? 0);
            if ($c > $maxClock) $maxClock = $c;
        }
        $lastSync = $maxClock > 0 ? self::ago(time() - $maxClock) : '—';

        return [
            'host'    => (string) ($host['name'] ?: $host['host']),
            'model'   => $model,
            'serial'  => (string) ($host['inventory']['serialno_a'] ?? '—'),
            'fos'     => $fos,
            'uptime'  => $uptime,
            'ha'      => $haLabel,
            'mgmtIp'  => $mgmtIp,
            'lastSync'=> $lastSync,
            'site'    => (string) ($host['inventory']['location']
                            ?? self::itemStr($byKey, 'system.location[sysLocation.0]', '—')),
            'serial2' => (string) ($host['inventory']['serialno_b'] ?? ''),
        ];
    }

    private static function buildTotals(array $byKey, array $lld): array {
        $t = self::emptyTotals();

        // CPU / mem / disk (device-level)
        $t['cpu']['now']     = (int) round(self::itemNum($byKey, 'system.cpu.util[fgSysCpuUsage.0]'));
        $t['mem']['now']     = (int) round(self::itemNum($byKey, 'vm.memory.util[memoryUsedPercentage.0]'));
        $diskTotal = self::itemNum($byKey, 'vfs.fs.total[fgSysDiskCapacity.0]'); // Mbytes
        $diskUsed  = self::itemNum($byKey, 'vfs.fs.used[fgSysDiskUsage.0]');
        if ($diskTotal > 0) {
            $t['disk']['now'] = (int) round(($diskUsed / $diskTotal) * 100);
        }
        // Peak15m approximation — without history.get we just show "now" for
        // both. (history.get could fill this in but adds latency.)
        $t['cpu']['peak15m'] = $t['cpu']['now'];
        $t['mem']['peak15m'] = $t['mem']['now'];

        // Sessions
        $t['sessions']['active'] = self::itemInt($byKey, 'net.ipv4.sessions[fgSysSesCount.0]');
        $t['sessions']['peak']   = $t['sessions']['active'];

        // Throughput — sum WAN-tagged interface bps. Identify WAN by name prefix.
        $thr = self::aggregateThroughput($lld);
        $t['throughput'] = array_merge($t['throughput'], $thr);

        // VPN
        $t['vpn']['ssl_users'] = self::itemInt($byKey, 'vpn.users.count[fgVpnSslStatsLoginUsers.0]');

        // IPS / threat counters (24h is approximated by current cumulative — the
        // template's items are counters, not deltas).
        $t['threats']['ips_blocks_24h'] = self::itemInt($byKey, 'ips.blocked[fgIpsIntrusionsBlocked.0]');

        return $t;
    }

    /**
     * Aggregate WAN throughput from interface LLD items.
     * Returns Gbps figures (template units are bps).
     */
    private static function aggregateThroughput(array $lld): array {
        $rxByIdx = [];
        $txByIdx = [];
        $nameByIdx = [];
        foreach ($lld['net.if.in'] ?? [] as $r) {
            $rxByIdx[$r['_index']] = (float) ($r['lastvalue'] ?? 0);
            $nameByIdx[$r['_index']] = self::tagByName($r, 'interface');
        }
        foreach ($lld['net.if.out'] ?? [] as $r) {
            $txByIdx[$r['_index']] = (float) ($r['lastvalue'] ?? 0);
            $nameByIdx[$r['_index']] = $nameByIdx[$r['_index']] ?? self::tagByName($r, 'interface');
        }

        $wanRx = 0.0; $wanTx = 0.0; $lan = 0.0;
        foreach ($rxByIdx as $idx => $rx) {
            $tx   = $txByIdx[$idx] ?? 0;
            $name = strtolower($nameByIdx[$idx] ?? '');
            if ($name === '') continue;
            if (str_starts_with($name, 'wan') || str_starts_with($name, 'ppp') ||
                str_contains($name, 'internet') || str_contains($name, 'isp')) {
                $wanRx += $rx; $wanTx += $tx;
            } else {
                $lan += max($rx, $tx);
            }
        }
        return [
            'total_gbps'   => round(($wanRx + $wanTx) / 1e9, 2),
            'wan_in_gbps'  => round($wanRx / 1e9, 2),
            'wan_out_gbps' => round($wanTx / 1e9, 2),
            'lan_gbps'     => round($lan / 1e9, 2),
            'peak_gbps'    => round(($wanRx + $wanTx) / 1e9, 2),
        ];
    }

    /**
     * Build the interface rows. Joins ifHCInOctets / ifHCOutOctets / ifOperStatus
     * / ifHighSpeed by {#SNMPINDEX}; pulls the interface name from the
     * `interface` tag the template puts on every per-interface item.
     */
    private static function buildInterfaces(array $lld): array {
        $byIdx = [];
        $fields = [
            'net.if.in'           => 'rx',
            'net.if.out'          => 'tx',
            'net.if.in.errors'    => 'rxErr',
            'net.if.out.errors'   => 'txErr',
            'net.if.in.discards'  => 'rxDisc',
            'net.if.out.discards' => 'txDisc',
            'net.if.status'       => 'oper',
            'net.if.speed'        => 'speed',
            'net.if.type'         => 'type',
        ];
        foreach ($fields as $prefix => $field) {
            foreach ($lld[$prefix] ?? [] as $r) {
                $idx = (string) $r['_index'];
                $byIdx[$idx] = $byIdx[$idx] ?? ['_name' => self::tagByName($r, 'interface')];
                $byIdx[$idx][$field] = $r['lastvalue'] ?? '';
                if (empty($byIdx[$idx]['_name'])) {
                    $byIdx[$idx]['_name'] = self::tagByName($r, 'interface');
                }
            }
        }

        $rows = [];
        foreach ($byIdx as $idx => $r) {
            $name = (string) ($r['_name'] ?? $idx);
            if ($name === '' || $name === $idx) continue;
            // Skip non-physical interface types (53=propVirtual, 24=loopback,
            // 6=ethernetCsmacd, 117=gigabitEthernet, 71=ieee80211 etc.)
            $type = (int) ($r['type'] ?? 0);
            if ($type === 24 /* loopback */ || $type === 1) continue;

            $rxBps  = (float) ($r['rx'] ?? 0);
            $txBps  = (float) ($r['tx'] ?? 0);
            $speedMbps = (int) ($r['speed'] ?? 0);
            $oper      = (int) ($r['oper'] ?? 0);

            $rows[] = [
                'id'      => $name,
                'role'    => self::guessIfRole($name),
                'speed'   => $speedMbps >= 1000 ? ((int) ($speedMbps / 1000)) . 'G' : ($speedMbps . 'M'),
                'up'      => $oper === 1,
                'vlans'   => 0,
                'rx_mbps' => (int) round($rxBps / 1e6),
                'tx_mbps' => (int) round($txBps / 1e6),
                'util'    => $speedMbps > 0 ? (int) round(max($rxBps, $txBps) / 1e6 / $speedMbps * 100) : 0,
                'errors'  => (int) (($r['rxErr'] ?? 0) + ($r['txErr'] ?? 0)),
                'state'   => $oper === 1 ? 'ok' : ($oper === 2 ? 'warn' : 'info'),
            ];
        }
        // Sort: WAN first, then by name
        usort($rows, function ($a, $b) {
            $aw = str_starts_with(strtolower($a['id']), 'wan');
            $bw = str_starts_with(strtolower($b['id']), 'wan');
            if ($aw !== $bw) return $aw ? -1 : 1;
            return strcmp($a['id'], $b['id']);
        });
        return $rows;
    }

    private static function guessIfRole(string $name): string {
        $n = strtolower($name);
        if (str_starts_with($n, 'wan'))   return 'WAN';
        if (str_starts_with($n, 'lan'))   return 'LAN';
        if (str_starts_with($n, 'dmz'))   return 'DMZ';
        if (str_starts_with($n, 'mgmt'))  return 'Management';
        if (str_starts_with($n, 'ha'))    return 'HA heartbeat';
        if (str_starts_with($n, 'port'))  return 'switch port';
        if (str_starts_with($n, 'vlan'))  return 'VLAN';
        if (str_contains($n, 'ssl'))      return 'SSL-VPN';
        return '—';
    }

    /**
     * IPsec tunnel status from vpn.tunnel.status LLD. The template doesn't
     * expose byte counters per tunnel, so rxMb/txMb are zeroed; status drives
     * the green/red badge.
     */
    private static function buildIpsec(array $lld): array {
        $rows = [];
        $up = 0;
        foreach ($lld['vpn.tunnel.status'] ?? [] as $r) {
            $status = (int) ($r['lastvalue'] ?? 0);
            $name   = self::tagByName($r, 'tunnel');
            if ($name === '') $name = 'tunnel ' . $r['_index'];
            $state  = $status === 1 ? 'up' : 'down';
            if ($state === 'up') $up++;
            $rows[] = [
                'id'      => $name,
                'peer'    => '—',
                'phase2'  => 0,
                'rxMb'    => 0,
                'txMb'    => 0,
                'latency' => 0,
                'state'   => $state,
                'since'   => '—',
            ];
        }
        usort($rows, function ($a, $b) {
            if ($a['state'] !== $b['state']) return $a['state'] === 'down' ? -1 : 1;
            return strcmp($a['id'], $b['id']);
        });
        return ['rows' => $rows, 'up' => $up, 'total' => count($rows)];
    }

    /** SD-WAN per-link SLA from sdwan_health.* LLD. */
    private static function buildSdwan(array $lld): array {
        $byIdx = [];
        $fields = [
            'sdwan_health.latency' => 'latency',
            'sdwan_health.jitter'  => 'jitter',
            'sdwan_health.loss'    => 'loss',
            'sdwan_health.state'   => 'state',
        ];
        foreach ($fields as $prefix => $field) {
            foreach ($lld[$prefix] ?? [] as $r) {
                $idx = (string) $r['_index'];
                $byIdx[$idx] = $byIdx[$idx] ?? [
                    '_name' => self::tagByName($r, 'link') ?: self::tagByName($r, 'sla'),
                ];
                $byIdx[$idx][$field] = $r['lastvalue'] ?? '';
                if (empty($byIdx[$idx]['_name'])) {
                    $byIdx[$idx]['_name'] = self::tagByName($r, 'link') ?: self::tagByName($r, 'sla');
                }
            }
        }

        $sla = [];
        $history = [];
        $bestLatency = INF;
        $bestKey = '';
        foreach ($byIdx as $idx => $r) {
            $name    = (string) ($r['_name'] ?? '');
            if ($name === '') $name = 'link ' . $idx;
            $state   = (int) ($r['state'] ?? 0);
            $latency = (float) ($r['latency'] ?? 0);
            $jitter  = (float) ($r['jitter'] ?? 0);
            $loss    = (float) ($r['loss'] ?? 0);
            $status  = $state === 1 ? 'ok' : ($loss > 0.5 || $latency > 30 ? 'warn' : 'ok');

            $key = preg_split('/[\s·\-]+/', $name)[0] ?? $name;
            $sla[] = [
                'link'    => $name,
                'latency' => round($latency, 2),
                'jitter'  => round($jitter, 2),
                'loss'    => round($loss, 2),
                'bw_up'   => 0,
                'bw_down' => 0,
                'status'  => $status,
                'weight'  => 0,
            ];
            // History stub: a flat line at current latency for the sparkline.
            $history[$key] = array_fill(0, 24, round($latency, 2));
            if ($status === 'ok' && $latency < $bestLatency) {
                $bestLatency = $latency;
                $bestKey = $key;
            }
        }
        return [
            'rules'         => 0,
            'preferredLink' => $bestKey,
            'sla'           => $sla,
            'latencyHistory'=> $history ?: new \stdClass(),
        ];
    }

    /**
     * UTM rollup from device-level IPS counters. The template exposes
     * blocked / detected.total / detected.crit / .high / .med / .low / .info /
     * .anomaly / .sign — these are SNMP-cumulative, so values are lifetime
     * counters; we surface "blocks" as the lifetime number until a delta
     * preprocessor is added template-side.
     */
    private static function buildUtm(array $byKey): array {
        $ipsBlocks = self::itemInt($byKey, 'ips.blocked[fgIpsIntrusionsBlocked.0]');
        $ipsTotal  = self::itemInt($byKey, 'ips.detected.total[fgIpsIntrusionsDetected.0]');
        $ipsCrit   = self::itemInt($byKey, 'ips.detected.crit[fgIpsCritSevDetections.0]');
        $ipsHigh   = self::itemInt($byKey, 'ips.detected.high[fgIpsHighSevDetections.0]');
        $ipsMed    = self::itemInt($byKey, 'ips.detected.med[fgIpsMedSevDetections.0]');
        $ipsLow    = self::itemInt($byKey, 'ips.detected.low[fgIpsLowSevDetections.0]');

        $utm = self::emptyUtm();
        $utm[0] = [
            'id' => 'ips', 'label' => 'IPS / IDS',
            'blocks' => $ipsBlocks, 'unique' => $ipsTotal,
            'severity_hi' => $ipsCrit + $ipsHigh,
            'color' => 'var(--err)',
        ];
        // Web / AV / App ctrl / DNS / Bot — not in this template. Surface as 0.
        return $utm;
    }

    /**
     * Recent events stream — host problems from the FortiGate host(s) in the
     * last hour, severity-mapped and joined with hostname.
     */
    private static function buildEvents(array $hostids, array $hosts): array {
        if (!$hostids) return [];
        $hostids = array_values(array_unique(array_map('strval', $hostids)));
        $nameByHost = [];
        foreach ($hosts as $h) $nameByHost[(string) $h['hostid']] = (string) ($h['name'] ?: $h['host']);

        $problems = API::Problem()->get([
            'output'    => ['eventid', 'name', 'severity', 'clock'],
            'hostids'   => $hostids,
            'recent'    => true,
            'time_from' => time() - 24 * 3600,
            'sortfield' => ['eventid'],
            'sortorder' => 'DESC',
            'limit'     => 50,
        ]) ?: [];
        if (!$problems) return [];

        $events = API::Event()->get([
            'output'      => ['eventid'],
            'eventids'    => array_column($problems, 'eventid'),
            'selectHosts' => ['hostid'],
        ]) ?: [];
        $hostByEvent = [];
        foreach ($events as $ev) {
            $first = $ev['hosts'][0] ?? null;
            if ($first) $hostByEvent[(string) $ev['eventid']] = (string) $first['hostid'];
        }

        $rows = [];
        foreach ($problems as $p) {
            $hid = $hostByEvent[(string) $p['eventid']] ?? $hostids[0];
            $rows[] = [
                'ts'     => date('H:i:s', (int) $p['clock']),
                'source' => 'zbx',
                'host'   => $nameByHost[$hid] ?? '—',
                'sev'    => self::zabbixSevToLabel((int) $p['severity']),
                'msg'    => 'Problem: ',
                'obj'    => (string) $p['name'],
            ];
            if (count($rows) >= 12) break;
        }
        return $rows;
    }

    // ── Misc helpers ───────────────────────────────────────────────────────

    private static function zabbixSevToLabel(int $sev): string {
        return [0 => 'info', 1 => 'info', 2 => 'warning', 3 => 'warning', 4 => 'high', 5 => 'disaster'][$sev] ?? 'info';
    }

    private static function formatUptime(int $seconds): string {
        $d = intdiv($seconds, 86400);
        $h = intdiv($seconds % 86400, 3600);
        $m = intdiv($seconds % 3600, 60);
        return sprintf('%dd %02dh %02dm', $d, $h, $m);
    }

    private static function ago(int $delta): string {
        if ($delta < 60)    return $delta . 's ago';
        if ($delta < 3600)  return intdiv($delta, 60) . 'm ago';
        if ($delta < 86400) return intdiv($delta, 3600) . 'h ago';
        return intdiv($delta, 86400) . 'd ago';
    }
}
