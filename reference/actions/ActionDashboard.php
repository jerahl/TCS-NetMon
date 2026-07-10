<?php declare(strict_types=1);

namespace Modules\TcsDashboard\Actions;

use API;
use CControllerResponseData;
use CControllerResponseFatal;
use Modules\TcsDashboard\Lib\PFClient;
use Modules\TcsDashboard\Lib\XIQClient;

/**
 * GET zabbix.php?action=tcs.dashboard.view[&hostid=NNN]
 *
 * Collects an initial snapshot of host state from the Zabbix API and hands it
 * to the view as $data['boot']. The view inlines this as window.ZBX_BOOT so
 * the React app can render immediately on first paint without a second
 * round-trip. Live updates come from tcs.dashboard.data (JSON).
 */
class ActionDashboard extends ActionBase {

    /** Client-load thresholds shown in the AP Navigator + device card. */
    private const AP_CLIENT_WARN = 35;
    private const AP_CLIENT_HIGH = 50;

    protected function checkInput(): bool {
        $fields = [
            'hostid' => 'string'
        ];

        $ret = $this->validateInput($fields);

        if (!$ret) {
            $this->setResponse(new CControllerResponseFatal());
        }

        return $ret;
    }

    protected function doAction(): void {
        $hostid = $this->getInput('hostid', '');

        $boot = [
            'host'        => null,
            'items'       => new \stdClass(),
            'systemInfo'  => [],
            'networkInfo' => [],
            'events'      => [],
            'alerts'      => [
                'associationFailures' => 0,
                'authFailures'        => 0,
                'networkIssues'       => 0,
                'packetLoss'          => 0,
                'totalClients'        => 0,
                'activeClients'       => 0,
            ],
            // PacketFence is a separate system — populate from your PF API in
            // collectPacketFence() below, or leave empty to let the UI render
            // the empty-state.
            'pfClients'   => [],
            'pfAuthFails' => [],
            'wiredPorts'  => [],
            'ssids'       => [],
            'clientsDebug'=> [],
            'pfApUplinkDebug' => [],
            'pfAdminUrl'  => '',
            'alertsDetail'=> [
                'activeTriggers' => [],
                'triggerCount'   => 0,
                'last24h'        => ['count' => 0, 'bySeverity' => []],
                'lastFiredAgo'   => null
            ],
            // AP Navigator: every wireless host grouped by school. Always
            // collected (independent of $hostid) so the left rail is
            // populated even when the page is opened without a hostid.
            'apSites'     => $this->collectApSites()
        ];

        if ($hostid !== '') {
            $boot['host']        = $this->collectHost($hostid);
            $boot['items']       = $this->collectItems($hostid);

            // Fold per-AP fields from the XIQ fleet host into the host
            // record so device card / page header have clients/location/
            // model/connected without a second backend round trip.
            //
            // Order matters: apStatus is composed here so the downstream
            // PF collectors (collectEvents auth merge, collectPacketFence)
            // can skip their round-trips when the AP is fully down.
            if ($boot['host']) {
                $fleet = $this->resolveXiqFleetFields($hostid, [
                    'clients', 'building', 'floor', 'location', 'model',
                    'connected', 'configmismatch', 'xiqid', 'mac', 'policy'
                ]);
                $boot['host']['clients']        = (int) ($fleet['clients'] ?? 0);
                $boot['host']['loadLevel']      = $boot['host']['clients'] > self::AP_CLIENT_HIGH ? 'high'
                                                : ($boot['host']['clients'] > self::AP_CLIENT_WARN ? 'warn' : 'ok');
                $boot['host']['site']           = $fleet['building'] ?? ($boot['host']['site'] ?? '');
                $boot['host']['floor']          = $fleet['floor']    ?? ($boot['host']['floor'] ?? '');
                $boot['host']['location']       = $fleet['location'] ?? '';
                $boot['host']['model']          = $fleet['model']    ?? ($boot['host']['model'] ?? '');
                // xiq.ap.connected[<serial>] on the fleet host: "1"/"0",
                // or "" when the dependent item hasn't reported yet — and
                // (int)"" === 0, which would mis-render a healthy AP as
                // XIQ=DOWN. Treat empty / missing as unknown (null).
                $xiqRaw = $fleet['connected'] ?? null;
                $boot['host']['xiqConnected'] = ($xiqRaw === null || $xiqRaw === '')
                    ? null
                    : (((int) $xiqRaw) === 1 ? 1 : 0);
                $cmRaw = $fleet['configmismatch'] ?? null;
                $boot['host']['configMismatch'] = ($cmRaw === null || $cmRaw === '')
                    ? null
                    : (int) $cmRaw;
                $boot['host']['xiqId']          = $fleet['xiqid']    ?? '';
                $boot['host']['mac']            = $fleet['mac']      ?? '';
                $boot['host']['policy']         = $fleet['policy']   ?? '';
                $apMacForPf = (string) ($this->readHostMacro($hostid, '{$XIQ_MAC}') ?? '');
                if ($apMacForPf === '') $apMacForPf = (string) ($fleet['mac'] ?? '');
                $boot['host']['pfUplink']       = $this->collectPfApUplink($hostid, $apMacForPf);
                // The PF buttons on the device card (View in PF, Reevaluate
                // access) gate on host.mac. fleet['mac'] is often empty even
                // when {$XIQ_MAC} is set, and the locationlog row itself
                // carries the canonical lowercase-colon MAC PF expects —
                // prefer that, then fall back to whatever input we used.
                $pfMac = $boot['host']['pfUplink']['mac'] ?? '';
                if ($pfMac === '') $pfMac = self::normalizeMacForPf($apMacForPf);
                if ($pfMac !== '') $boot['host']['mac'] = $pfMac;

                // Three-source AP availability — XIQ connected, SNMP
                // interface reachability, ICMP ping. Surface each one
                // separately so the device card can show the operator
                // which signal is failing, and roll them up into a single
                // apStatus for the page header / nav rail.
                $pingItem  = is_array($boot['items']) ? ($boot['items']['pingUp'] ?? null) : null;
                $pingUp    = null;
                if (is_array($pingItem) && empty($pingItem['missing'])
                    && $pingItem['value'] !== null && $pingItem['value'] !== '') {
                    $pingUp = ((int) $pingItem['value']) === 1 ? 1 : 0;
                }
                $boot['host']['pingUp']        = $pingUp;
                $boot['host']['snmpAvailable'] = (int) ($boot['host']['available'] ?? 0);
                $boot['host']['apStatus']      = self::composeApStatus(
                    $boot['host']['xiqConnected'] ?? null,
                    $boot['host']['snmpAvailable'],
                    $pingUp
                );
            }

            $boot['systemInfo']  = $this->collectSystemInfo($hostid);
            $boot['networkInfo'] = $this->collectNetworkInfo($hostid);
            $boot['events']      = $this->collectEvents($hostid, $boot['host']);
            $boot['alerts']      = $this->collectAlertsSummary($hostid);
            $boot['wiredPorts']  = $this->collectWiredPorts($hostid);
            $boot['ssids']       = $this->collectSsidList($hostid);
            $boot['alertsDetail']= $this->collectAlertsDetail($hostid);
            $boot['pfAdminUrl']  = $this->resolvePfAdminUrl($hostid);

            [$pfClients, $pfAuthFails] = $this->collectPacketFence($hostid, $boot['host']);
            // Prefer XIQ /clients/active enriched with PacketFence for the
            // Clients tab — canonical per-AP source, works without PF being
            // configured. Fall back to PF-only when XIQ couldn't run
            // (null: missing device id / token, or API errored). An empty
            // array from XIQ is authoritative — the AP genuinely has zero
            // clients — and must NOT fall through to PF.
            $xiqClients          = $this->collectXiqClients($hostid);
            $boot['pfClients']   = $xiqClients !== null ? $xiqClients : $pfClients;
            $boot['pfAuthFails'] = $pfAuthFails;
            $boot['clientsDebug']    = $this->clientsDebug;
            $boot['pfApUplinkDebug'] = $this->pfApUplinkDebug;

            // Fold PF client counts into the alerts summary. activeClients is
            // anything PF currently has in a non-rejected/non-quarantined
            // posture; tweak the predicate once posture taxonomy is firm.
            $boot['alerts']['totalClients']  = count($pfClients);
            $boot['alerts']['activeClients'] = count(array_filter(
                $pfClients,
                fn($c) => !in_array(($c['posture'] ?? ''), ['rejected', 'quarantined', 'non-compliant'], true)
            ));
            $boot['alerts']['authFailures'] += count($pfAuthFails);
        }

        $data = [
            'title' => _('TCS Dashboard'),
            'boot'  => $boot
        ];

        $response = new CControllerResponseData($data);
        $response->setTitle(_('TCS Dashboard'));
        $this->setResponse($response);
    }

    /* --------------------------------------------------------------------- */
    /* Data collectors — each returns the shape the React frontend expects.  */
    /* Item keys below are PLACEHOLDERS. Swap them for the keys actually     */
    /* defined on your Extreme AP / PacketFence / ICMP templates.            */
    /* --------------------------------------------------------------------- */

    private function collectHost(string $hostid): ?array {
        $hosts = API::Host()->get([
            'output'                  => ['hostid', 'host', 'name', 'status', 'maintenance_status', 'proxy_hostid'],
            'selectInterfaces'        => ['ip', 'main', 'type'],
            'selectParentTemplates'   => ['name'],
            'selectHostGroups'        => ['name'],
            'hostids'                 => [$hostid]
        ]);

        if (!$hosts) {
            return null;
        }

        $h = $hosts[0];

        $primary_ip = '';
        foreach ($h['interfaces'] ?? [] as $iface) {
            if ((int) ($iface['main'] ?? 0) === 1) {
                $primary_ip = $iface['ip'];
                break;
            }
        }

        return [
            'hostid'       => $h['hostid'],
            'host'         => $h['host'],
            'visible_name' => $h['name'],
            'ip'           => $primary_ip,
            'status'       => ((int) $h['status'] === 0) ? 'monitored' : 'not monitored',
            'available'    => $this->resolveAvailability($hostid),
            'maintenance'  => (int) ($h['maintenance_status'] ?? 0),
            'proxy'        => $this->resolveProxy($h['proxy_hostid'] ?? '0'),
            'templates'    => array_column($h['parentTemplates'] ?? [], 'name'),
            'groups'       => array_column($h['hostgroups'] ?? [], 'name'),
            'uptime'       => $this->resolveUptime($hostid),
            'lastSeen'     => 'now'
        ];
    }

    private function collectItems(string $hostid): array {
        // Logical metric → matcher. Match modes:
        //   ['exact',  'system.cpu.util']             — key matches verbatim
        //   ['prefix', 'extremeap.channel[']          — any key starting with prefix
        //   ['suffix', 'extremeap.channel[', '.12]']  — prefix AND suffix
        //
        // These map to items defined in the "Extreme AP via SNMPv2c" template
        // (per-AP SNMP host, auto-created by the XIQ fleet template's host
        // prototype) plus the standard ICMP Ping template.
        //
        // Radio convention (AP305C): ifIndex 12 = wifi0 (2.4 GHz),
        // ifIndex 13 = wifi1 (5 GHz). Override by changing the suffix below
        // if you're running tri-radio hardware.
        $key_map = [
            'cpu'           => ['exact',  'extremeap.cpu.util'],
            'memory'        => ['exact',  'extremeap.mem.util'],
            'firmware'      => ['exact',  'extremeap.firmware.0'],
            'serial'        => ['exact',  'extremeap.serial.0'],
            'uptime'        => ['exact',  'system.uptime'],
            'pingUp'        => ['exact',  'icmpping'],
            'pktLoss'       => ['exact',  'icmppingloss'],
            'latency'       => ['exact',  'icmppingsec'],
            'uplinkIn'      => ['exact',  'net.if.in[ifHCInOctets.10]'],
            'uplinkOut'     => ['exact',  'net.if.out[ifHCOutOctets.10]'],
            'uplinkStatus'  => ['exact',  'net.if.status[ifOperStatus.10]'],
            'uplinkSpeed'   => ['exact',  'net.if.speed[ifSpeed.10]'],
            'noise24'       => ['exact',  'extremeap.noise.wifi0'],
            'noise5'        => ['exact',  'extremeap.noise.wifi1'],
            // Per-radio LLD items — ifIndex baked into the key.
            'channel24'     => ['exact',  'extremeap.channel[12]'],
            'channel5'      => ['exact',  'extremeap.channel[13]'],
            'txpower24'     => ['exact',  'extremeap.txpower[12]'],
            'txpower5'      => ['exact',  'extremeap.txpower[13]'],
            'radioRx24'     => ['exact',  'extremeap.radio.rxbytes[12]'],
            'radioTx24'     => ['exact',  'extremeap.radio.txbytes[12]'],
            'radioRx5'      => ['exact',  'extremeap.radio.rxbytes[13]'],
            'radioTx5'      => ['exact',  'extremeap.radio.txbytes[13]']
        ];

        // Fetch every item on the host once; match in PHP. Cheaper than one
        // item.get per logical metric, and the only way to handle the LLD
        // prefix matches above.
        $items = API::Item()->get([
            'output'   => ['itemid', 'key_', 'lastvalue', 'prevvalue', 'units', 'value_type'],
            'hostids'  => [$hostid],
            'webitems' => true
        ]);

        $now = time();
        $window_from = $now - 24 * 3600; // last 24h for sparklines
        $out = [];

        foreach ($key_map as $logical => $matcher) {
            $found = $this->matchItem($items, $matcher);
            if (!$found) {
                $out[$logical] = [
                    'value'   => null,
                    'unit'    => '',
                    'history' => [],
                    'missing' => true,
                    'key'     => is_array($matcher) ? implode('', array_slice($matcher, 1)) : (string) $matcher
                ];
                continue;
            }

            $it = $found;
            $value_type = (int) $it['value_type'];

            // history.get value_type: 0=float, 1=str, 2=log, 3=uint, 4=text.
            // Only float (0) and uint (3) make sense for sparklines.
            $history = [];
            if ($value_type === 0 || $value_type === 3) {
                $rows = API::History()->get([
                    'output'    => 'extend',
                    'history'   => $value_type,
                    'itemids'   => [$it['itemid']],
                    'time_from' => $window_from,
                    'sortfield' => 'clock',
                    'sortorder' => 'ASC',
                    'limit'     => 48
                ]);
                $history = array_map(static fn($r) => (float) $r['value'], $rows);
            }

            $out[$logical] = [
                'value'   => is_numeric($it['lastvalue']) ? (float) $it['lastvalue'] : $it['lastvalue'],
                'prev'    => is_numeric($it['prevvalue']) ? (float) $it['prevvalue'] : null,
                'unit'    => $it['units'],
                'history' => $history,
                'missing' => false,
                'key'     => $it['key_']
            ];
        }

        return $out;
    }

    /**
     * Match one item out of a host's item list given a matcher tuple from
     * the $key_map in collectItems(). Returns the first match, or null.
     */
    private function matchItem(array $items, array $matcher): ?array {
        [$mode, $a] = [$matcher[0], $matcher[1]];
        $b = $matcher[2] ?? '';
        foreach ($items as $it) {
            $k = $it['key_'];
            $hit = match ($mode) {
                'exact'  => $k === $a,
                'prefix' => str_starts_with($k, $a),
                'suffix' => str_starts_with($k, $a) && str_ends_with($k, $b),
                default  => false
            };
            if ($hit) return $it;
        }
        return null;
    }

    private function collectSystemInfo(string $hostid): array {
        // Each row: [Label, Value, Source]. Source is "zbx" or "ext".
        $hosts = API::Host()->get([
            'output'         => ['name', 'host'],
            'selectInventory'=> ['serialno_a', 'model', 'os', 'tag', 'name', 'type'],
            'hostids'        => [$hostid]
        ]);

        if (!$hosts) {
            return [];
        }

        $h   = $hosts[0];
        $inv = $h['inventory'] ?: [];

        // Pull live SNMP values that override stale inventory data.
        $live = $this->lastValuesByKey($hostid, [
            'extremeap.serial.0',
            'extremeap.firmware.0'
        ]);

        // Pull fleet-side fields the XIQ template publishes per AP, plus the
        // host macros the prototype stamps at creation. Cascading fallbacks
        // keep every row populated even when one source goes stale.
        $fleet     = $this->resolveXiqFleetFields($hostid, [
            'model', 'building', 'floor', 'location', 'adminstate',
            'version', 'hostname', 'connected'
        ]);
        $xiqSerial = (string) ($this->readHostMacro($hostid, '{$XIQ_SERIAL}')    ?? '');
        $xiqDevice = (string) ($this->readHostMacro($hostid, '{$XIQ_DEVICE_ID}') ?? '');

        $serial   = self::firstNonEmpty([(string) ($live['extremeap.serial.0']   ?? ''), (string) ($inv['serialno_a'] ?? ''), $xiqSerial]);
        $firmware = self::firstNonEmpty([(string) ($live['extremeap.firmware.0'] ?? ''), (string) ($fleet['version'] ?? ''), (string) ($inv['os'] ?? '')]);
        $model    = self::firstNonEmpty([(string) ($fleet['model']    ?? ''), (string) ($inv['model'] ?? ''), (string) ($inv['type'] ?? '')]);
        $building = self::firstNonEmpty([(string) ($fleet['building'] ?? '')]);
        $floor    = self::firstNonEmpty([(string) ($fleet['floor']    ?? '')]);
        $adminSt  = self::firstNonEmpty([(string) ($fleet['adminstate'] ?? '')]);
        $location = self::firstNonEmpty([(string) ($fleet['location'] ?? '')]);
        $connect  = $fleet['connected'] !== null && $fleet['connected'] !== ''
            ? ((int) $fleet['connected'] === 1 ? 'connected' : 'disconnected')
            : '—';

        $hostName    = (string) ($h['host'] ?? '');
        $visibleName = (string) ($h['name'] ?? '');
        if ($hostName === '')    $hostName    = '—';
        if ($visibleName === '') $visibleName = $hostName;

        return [
            ['Host Name',      $hostName,                                 'zbx'],
            ['Visible Name',   $visibleName,                              'zbx'],
            ['Device Model',   $model,                                    $fleet['model']  ? 'ext' : 'zbx'],
            ['Serial Number',  $serial,                                   $live['extremeap.serial.0'] ? 'zbx' : ($xiqSerial !== '' ? 'ext' : 'zbx')],
            ['Firmware',       $firmware,                                 $live['extremeap.firmware.0'] ? 'zbx' : 'ext'],
            ['Building',       $building,                                 'ext'],
            ['Floor',          $floor,                                    'ext'],
            ['Location',       $location,                                 'ext'],
            ['Admin state',    $adminSt,                                  'ext'],
            ['Cloud state',    $connect,                                  'ext'],
            ['XIQ Device ID',  $xiqDevice !== '' ? $xiqDevice : '—',      'ext'],
        ];
    }

    private function collectNetworkInfo(string $hostid): array {
        $ifaces = API::HostInterface()->get([
            'output'  => ['ip', 'dns', 'main', 'type'],
            'hostids' => [$hostid]
        ]);

        $primary = null;
        foreach ($ifaces as $i) {
            if ((int) $i['main'] === 1) { $primary = $i; break; }
        }

        $live = $this->lastValuesByKey($hostid, [
            'net.if.status[ifOperStatus.10]',
            'net.if.speed[ifSpeed.10]'
        ]);

        $oper_map = [1 => 'up', 2 => 'down', 3 => 'testing', 4 => 'unknown', 5 => 'dormant', 6 => 'notPresent', 7 => 'lowerLayerDown'];
        $oper_raw = $live['net.if.status[ifOperStatus.10]'] ?? null;
        $oper     = $oper_raw !== null ? ($oper_map[(int) $oper_raw] ?? (string) $oper_raw) : '—';

        $speed_raw = $live['net.if.speed[ifSpeed.10]'] ?? null;
        $speed     = $speed_raw !== null ? $this->formatBps((float) $speed_raw) : '—';

        $fleet     = $this->resolveXiqFleetFields($hostid, ['mac', 'ip', 'policy']);
        $xiqMac    = (string) ($this->readHostMacro($hostid, '{$XIQ_MAC}') ?? '');
        // {$XIQ_MAC} is the canonical AP MAC the XIQ template stamps on the
        // host at prototype creation; prefer it over the fleet-derived
        // lastvalue (which can lag through a master-item refresh).
        $mac       = self::firstNonEmpty([$xiqMac, (string) ($fleet['mac'] ?? '')]);
        $macSrc    = $xiqMac !== '' ? 'zbx' : 'ext';

        return [
            ['Mgt0 IPv4',      self::firstNonEmpty([(string) ($primary['ip']  ?? ''), (string) ($fleet['ip'] ?? '')]), 'zbx'],
            ['DNS Name',       self::firstNonEmpty([(string) ($primary['dns'] ?? '')]),                                'zbx'],
            ['MAC Address',    $mac,                                                                                    $macSrc],
            ['{$XIQ_MAC}',     $xiqMac !== '' ? $xiqMac : '—',                                                          'zbx'],
            ['Uplink eth0',    "$oper · $speed",                                                                        'zbx'],
            ['Network Policy', self::firstNonEmpty([(string) ($fleet['policy'] ?? '')]),                                'ext'],
        ];
    }

    /** Return the first non-empty trimmed string in $candidates, else '—'. */
    private static function firstNonEmpty(array $candidates): string {
        foreach ($candidates as $c) {
            $s = trim((string) $c);
            if ($s !== '') return $s;
        }
        return '—';
    }

    /**
     * Get last values for a set of exact item keys on a single host.
     * Returns ['key' => lastvalue or null].
     */
    private function lastValuesByKey(string $hostid, array $keys): array {
        if (!$keys) return [];
        $items = API::Item()->get([
            'output'  => ['key_', 'lastvalue'],
            'hostids' => [$hostid],
            'filter'  => ['key_' => $keys]
        ]) ?: [];
        $out = array_fill_keys($keys, null);
        foreach ($items as $it) {
            $out[$it['key_']] = $it['lastvalue'];
        }
        return $out;
    }

    /** Format bits/sec as a short human string (1.0 Gbps / 100 Mbps / …). */
    private function formatBps(float $bps): string {
        if ($bps >= 1e9) return number_format($bps / 1e9, 1).' Gbps';
        if ($bps >= 1e6) return number_format($bps / 1e6, 0).' Mbps';
        if ($bps >= 1e3) return number_format($bps / 1e3, 0).' kbps';
        return number_format($bps, 0).' bps';
    }

    /**
     * Cross-join a per-AP SNMP host into the XIQ fleet template. The host
     * macro {$XIQ_SERIAL} points to the serial; we look up
     * xiq.ap.<field>[<serial>] items on the fleet host (any host with the
     * 'Extreme XIQ APs by API' template linked).
     *
     * @param string[] $fields  Fleet fields to pull, e.g. ['model','building','floor','clients']
     * @return array<string, string|null>
     */
    private function resolveXiqFleetFields(string $hostid, array $fields): array {
        $out = array_fill_keys($fields, null);

        // 1. Read the {$XIQ_SERIAL} macro from the per-AP host.
        $macros = API::UserMacro()->get([
            'output'  => ['macro', 'value'],
            'hostids' => [$hostid],
            'filter'  => ['macro' => ['{$XIQ_SERIAL}']]
        ]) ?: [];
        $serial = '';
        foreach ($macros as $m) {
            if ($m['macro'] === '{$XIQ_SERIAL}') { $serial = (string) $m['value']; break; }
        }
        if ($serial === '') return $out;

        // 2. Find the fleet host (cached for the duration of the request).
        $fleet_hostid = $this->resolveXiqFleetHostId();
        if ($fleet_hostid === null) return $out;

        // 3. Pull the specific xiq.ap.<field>[<serial>] items on the fleet host.
        // Use concatenation — "xiq.ap.$f[$serial]" parses $f[$serial] as
        // array-access on the field-name string, which trips an
        // "Uninitialized string offset" notice for serials that look numeric.
        $keys = array_map(fn($f) => 'xiq.ap.'.$f.'['.$serial.']', $fields);
        $items = API::Item()->get([
            'output'  => ['key_', 'lastvalue'],
            'hostids' => [$fleet_hostid],
            'filter'  => ['key_' => $keys]
        ]) ?: [];
        foreach ($items as $it) {
            // array_key_exists, not isset — $out is pre-filled with nulls,
            // and isset($out['x']) returns false when $out['x'] === null,
            // which silently dropped every fleet field on the floor.
            if (preg_match('/^xiq\.ap\.([^[]+)\[/', $it['key_'], $m)
                && array_key_exists($m[1], $out)) {
                $out[$m[1]] = (string) $it['lastvalue'];
            }
        }
        return $out;
    }

    private function collectEvents(string $hostid, ?array $host = null): array {
        // Pull both trigger PROBLEM (value=1) and RECOVERY (value=0) events
        // so the tab can show the full state timeline, not just opens.
        // Zabbix 7.2: sortfield must be 'eventid'; selectAcknowledges
        // (camelCase) replaced the snake_case form.
        $events = API::Event()->get([
            'output'             => ['eventid', 'name', 'severity', 'clock', 'value', 'r_eventid', 'acknowledged'],
            'hostids'            => [$hostid],
            'sortfield'          => ['eventid'],
            'sortorder'          => 'DESC',
            'limit'              => 100,
            'selectAcknowledges' => 'count',
            'selectTags'         => ['tag', 'value'],
            'value'              => [0, 1]
        ]) ?: [];

        // Zabbix severity (0–5) → bucket the UI styles.
        $sev_label = [
            0 => 'info', 1 => 'info', 2 => 'warning',
            3 => 'warning', 4 => 'high', 5 => 'disaster'
        ];

        $today = date('Y-m-d');
        $out = [];
        foreach ($events as $e) {
            $clock = (int) $e['clock'];
            $date  = date('Y-m-d', $clock);
            // Tags from the trigger (model/serial/scope/location etc) make
            // good object hints. Prefer scope, then ap_serial.
            $obj = '';
            foreach (($e['tags'] ?? []) as $t) {
                if (($t['tag'] ?? '') === 'scope' && !empty($t['value'])) {
                    $obj = (string) $t['value'];
                    break;
                }
            }
            if ($obj === '') {
                foreach (($e['tags'] ?? []) as $t) {
                    if (($t['tag'] ?? '') === 'ap_serial' && !empty($t['value'])) {
                        $obj = (string) $t['value'];
                        break;
                    }
                }
            }
            $out[] = [
                'eventid'  => (string) $e['eventid'],
                'ts'       => date('H:i:s', $clock),
                'date'     => $date,
                'today'    => $date === $today,
                'clock'    => $clock,
                'severity' => $sev_label[(int) $e['severity']] ?? 'info',
                'source'   => 'Zabbix',
                'value'    => (int) $e['value'],          // 1 = problem, 0 = recovery
                'acked'    => (int) ($e['acknowledged'] ?? 0) === 1,
                'obj'      => $obj,
                'msg'      => (string) $e['name']
            ];
        }

        // Merge PacketFence RADIUS reject events for this AP if PF is wired
        // — same source field the EventsTab badge consumes. PF only
        // populates nas_ip_address on failed auths (switch / switch_ip /
        // switch_mac stay empty), so look up failures by the AP's Mgt0
        // IPv4 from its primary Zabbix interface.
        //
        // Skip the PF round-trip when the AP is fully unreachable
        // (apStatus === 'down' means XIQ, SNMP, and ping all report
        // down) — there's no live auth traffic for PF to report and the
        // call would just waste a token slot.
        $apDown   = (string) ($host['apStatus'] ?? '') === 'down';
        $pfMacros = $apDown ? null : $this->resolvePfMacros($hostid);
        if ($pfMacros !== null) {
            $apIp = $this->primaryInterfaceIp($hostid);
            if ($apIp !== '') {
                try {
                    $pf   = PFClient::fromMacros($pfMacros);
                    $fails = $pf->authFailuresForNode($apIp, 25);
                    foreach ($fails as $f) {
                        $ts = isset($f['ts']) ? strtotime((string) $f['ts']) : 0;
                        if ($ts <= 0) $ts = time();
                        $date = date('Y-m-d', $ts);
                        $out[] = [
                            'eventid'  => 'pf-'.($f['mac'] ?? '').'-'.$ts,
                            'ts'       => date('H:i:s', $ts),
                            'date'     => $date,
                            'today'    => $date === $today,
                            'clock'    => $ts,
                            'severity' => 'warning',
                            'source'   => 'PF',
                            'value'    => 1,
                            'acked'    => false,
                            'obj'      => (string) ($f['mac'] ?? ''),
                            'msg'      => 'RADIUS reject: '.((string) ($f['reason'] ?? 'unknown'))
                                       .(!empty($f['ssid']) ? ' · '.$f['ssid'] : '')
                        ];
                    }
                } catch (\Throwable $e) {
                    error_log('[tcs_dashboard] PF authFailures merge: '.$e->getMessage());
                }
            }
        }

        // Merge XIQ-side alarms for this device when {$XIQ_DEVICE_ID} and a
        // readable XIQ token are available. Same field shape — different
        // source badge.
        $deviceId = $this->readHostMacro($hostid, '{$XIQ_DEVICE_ID}');
        $xiqToken = self::xiqGlobalToken();
        if ($deviceId !== null && is_numeric($deviceId) && (int) $deviceId > 0 && $xiqToken !== null) {
            try {
                $xiq    = XIQClient::fromToken($xiqToken);
                $alarms = $xiq->getDeviceAlarms((int) $deviceId, 100);
                foreach ($alarms as $a) {
                    $clock = (int) $a['clock'];
                    $date  = date('Y-m-d', $clock);
                    $out[] = [
                        'eventid'  => 'xiq-'.$a['id'],
                        'ts'       => date('H:i:s', $clock),
                        'date'     => $date,
                        'today'    => $date === $today,
                        'clock'    => $clock,
                        'severity' => (string) $a['severity'],
                        'source'   => 'XIQ',
                        'value'    => (int) $a['value'],
                        'acked'    => false,
                        'obj'      => (string) $a['category'],
                        'msg'      => (string) $a['message']
                    ];
                }
            } catch (\Throwable $e) {
                error_log('[tcs_dashboard] XIQ alarms merge: '.$e->getMessage());
            }
        }

        // Merge sort by clock DESC, then eventid DESC to keep determinism.
        usort($out, fn($a, $b) => $b['clock'] <=> $a['clock'] ?: strcmp($b['eventid'], $a['eventid']));
        return array_slice($out, 0, 100);
    }

    private function collectAlertsSummary(string $hostid): array {
        // Currently-open problems on this host. Zabbix returns resolved
        // problems too unless we filter on r_eventid; do it in PHP so the
        // call shape matches what other actions use.
        $problems = API::Problem()->get([
            'output'  => ['eventid', 'name', 'severity', 'r_eventid'],
            'hostids' => [$hostid],
            'recent'  => false
        ]) ?: [];
        $problems = array_filter(
            $problems,
            fn($p) => empty($p['r_eventid']) || (int) $p['r_eventid'] === 0
        );

        // Bucket each open problem by name keyword. A single problem can
        // only fall into one bucket (first match wins) so the counts on the
        // Overview tab line up with the trigger list.
        $assoc = 0;
        $auth  = 0;
        $loss  = 0;
        $other = 0;
        foreach ($problems as $p) {
            $name = strtolower((string) ($p['name'] ?? ''));
            if (str_contains($name, 'associat')) {
                $assoc++;
            }
            elseif (str_contains($name, 'auth') || str_contains($name, 'radius') || str_contains($name, 'eap')) {
                $auth++;
            }
            elseif (str_contains($name, 'packet loss') || str_contains($name, 'icmp') || str_contains($name, 'unreachable')) {
                $loss++;
            }
            elseif ((int) $p['severity'] >= 3) {
                $other++;
            }
        }

        // 24h packet-loss event count: events that ever fired from a packet
        // loss trigger in the window, resolved or not. Lets the Overview
        // tile show a meaningful number when current loss is 0%.
        $loss_events_24h = 0;
        $events = API::Event()->get([
            'output'    => ['name', 'value'],
            'hostids'   => [$hostid],
            'time_from' => time() - 86400,
            'value'     => 1, // PROBLEM events only
            'limit'     => 200
        ]) ?: [];
        foreach ($events as $e) {
            $n = strtolower((string) ($e['name'] ?? ''));
            if (str_contains($n, 'packet loss') || str_contains($n, 'icmp') || str_contains($n, 'unreachable')) {
                $loss_events_24h++;
            }
        }

        return [
            'associationFailures' => $assoc,
            'authFailures'        => $auth,
            'networkIssues'       => $assoc + $auth + $loss + $other,
            'packetLoss'          => $loss_events_24h,
            'totalClients'        => 0, // populated from PacketFence in caller if wired
            'activeClients'       => 0
        ];
    }

    /**
     * Detail data for the Alerts tab: currently-firing triggers on the host,
     * total trigger count, last-fired-ago, and the 24h problem-event count
     * bucketed by severity. Output mirrors the dashboard's existing
     * severity buckets so the UI can colour bars without remapping.
     *
     * @return array{
     *     activeTriggers: array<int, array{id:string,name:string,severity:string,lastChange:int,age:string,ack:bool,scope:string}>,
     *     triggerCount:   int,
     *     last24h:        array{count:int, bySeverity: array<string,int>},
     *     lastFiredAgo:   string|null
     * }
     */
    private function collectAlertsDetail(string $hostid): array {
        $sev_label = [
            0 => 'info', 1 => 'info', 2 => 'warning',
            3 => 'warning', 4 => 'high', 5 => 'disaster'
        ];

        // All triggers monitored on this host — for the "N triggers
        // monitored" subtitle.
        $allTriggers = API::Trigger()->get([
            'output'    => ['triggerid'],
            'hostids'   => [$hostid],
            'monitored' => true
        ]) ?: [];

        // Currently-firing triggers — value=1, with the most-recent change
        // time so we can sort by age.
        $firing = API::Trigger()->get([
            'output'        => ['triggerid', 'description', 'priority', 'lastchange'],
            'hostids'       => [$hostid],
            'filter'        => ['value' => 1, 'status' => 0],
            'only_true'     => true,
            'monitored'     => true,
            'skipDependent' => true,
            'selectTags'    => ['tag', 'value'],
            'selectLastEvent' => ['eventid', 'acknowledged']
        ]) ?: [];

        $active = [];
        $newestChange = 0;
        foreach ($firing as $t) {
            $changed = (int) ($t['lastchange'] ?? 0);
            if ($changed > $newestChange) $newestChange = $changed;
            $scope = '';
            foreach (($t['tags'] ?? []) as $tg) {
                if (($tg['tag'] ?? '') === 'scope' && !empty($tg['value'])) {
                    $scope = (string) $tg['value'];
                    break;
                }
            }
            $acked = false;
            if (isset($t['lastEvent']) && is_array($t['lastEvent'])) {
                $acked = (int) ($t['lastEvent']['acknowledged'] ?? 0) === 1;
            }
            $active[] = [
                'id'         => (string) $t['triggerid'],
                'name'       => (string) ($t['description'] ?? ''),
                'severity'   => $sev_label[(int) ($t['priority'] ?? 0)] ?? 'info',
                'lastChange' => $changed,
                'age'        => $changed > 0 ? $this->formatAge(time() - $changed) : '—',
                'ack'        => $acked,
                'scope'      => $scope
            ];
        }
        usort($active, fn($a, $b) => $b['lastChange'] <=> $a['lastChange']);

        // 24h problem-event volume, bucketed by severity. PROBLEM events
        // only (value=1) so we don't double-count the recovery.
        $now = time();
        $events24h = API::Event()->get([
            'output'    => ['severity'],
            'hostids'   => [$hostid],
            'time_from' => $now - 86400,
            'value'     => 1,
            'limit'     => 1000
        ]) ?: [];
        $bySev = ['disaster' => 0, 'high' => 0, 'warning' => 0, 'info' => 0];
        foreach ($events24h as $e) {
            $bucket = $sev_label[(int) $e['severity']] ?? 'info';
            $bySev[$bucket] = ($bySev[$bucket] ?? 0) + 1;
        }

        // Optional: most-recently-fired-ever, even if not currently active.
        $lastFiredAgo = null;
        if (!$firing) {
            $latestEvent = API::Event()->get([
                'output'    => ['clock'],
                'hostids'   => [$hostid],
                'sortfield' => ['eventid'],
                'sortorder' => 'DESC',
                'value'     => 1,
                'limit'     => 1
            ]) ?: [];
            if ($latestEvent) {
                $age = $now - (int) $latestEvent[0]['clock'];
                $lastFiredAgo = $this->formatAge($age);
            }
        }
        elseif ($newestChange > 0) {
            $lastFiredAgo = $this->formatAge($now - $newestChange);
        }

        return [
            'activeTriggers' => $active,
            'triggerCount'   => count($allTriggers),
            'last24h'        => [
                'count'      => count($events24h),
                'bySeverity' => $bySev
            ],
            'lastFiredAgo'   => $lastFiredAgo
        ];
    }

    /** Short "Nd Nh"/"Nh Nm"/"Nm"/"Ns" duration string for ages. */
    private function formatAge(int $s): string {
        $s = max(0, $s);
        if ($s < 60)    return "{$s}s";
        if ($s < 3600)  return intdiv($s, 60).'m';
        if ($s < 86400) return intdiv($s, 3600).'h '.intdiv($s % 3600, 60).'m';
        return intdiv($s, 86400).'d '.intdiv($s % 86400, 3600).'h';
    }

    private function collectWiredPorts(string $hostid): array {
        // For an Extreme AP this is just eth0 (ifIndex 10). Pull the four
        // uplink items in one Item.get; if none exist this isn't an
        // Extreme-AP-templated host and we return empty.
        $live = $this->lastValuesByKey($hostid, [
            'net.if.status[ifOperStatus.10]',
            'net.if.speed[ifSpeed.10]',
            'net.if.in[ifHCInOctets.10]',
            'net.if.out[ifHCOutOctets.10]'
        ]);
        if (!array_filter($live, fn($v) => $v !== null)) {
            return [];
        }

        $oper_raw = $live['net.if.status[ifOperStatus.10]'] ?? null;
        $state = match ((int) ($oper_raw ?? 0)) {
            1 => 'ok',
            2 => 'down',
            default => 'warn'
        };

        $speed_raw = $live['net.if.speed[ifSpeed.10]'] ?? null;
        $speed_str = $speed_raw !== null ? $this->formatBps((float) $speed_raw) : '—';

        $in_bps  = $live['net.if.in[ifHCInOctets.10]']  ?? null;
        $out_bps = $live['net.if.out[ifHCOutOctets.10]'] ?? null;
        $fmt = fn($v) => $v !== null ? $this->formatBps((float) $v) : '—';

        return [[
            'name'     => 'eth0',
            'state'    => $state,
            'speed'    => $speed_str,
            'duplex'   => '—',  // not exposed by the Extreme AP SNMP template
            'in'       => $fmt($in_bps),
            'out'      => $fmt($out_bps),
            'err'      => '—',  // add when net.if.errors[ifInErrors.10] is templated
            'neighbor' => ''    // LLDP neighbor not collected
        ]];
    }

    /**
     * Pull the per-SSID LLD items defined by "Extreme AP via SNMPv2c" and
     * fold them into one row per SSID for the Wireless tab.
     *
     * Item keys (per the template):
     *   extremeap.ssid.name[<ifIndex>]    — SSID broadcast name
     *   extremeap.ssid.ifname[<ifIndex>]  — subinterface name e.g. wifi0.1
     *   extremeap.ssid.rxbytes[<ifIndex>] — RX bytes/sec (Change/sec preprocessing)
     *   extremeap.ssid.txbytes[<ifIndex>] — TX bytes/sec
     *
     * Band is derived from the ifname prefix: wifi0.* = 2.4 GHz, wifi1.* = 5 GHz.
     * VLAN, auth, encryption, role, and per-SSID client counts are NOT in
     * SNMP and would need an XIQ d360 API call — left null here so the UI
     * renders an em-dash.
     */
    private function collectSsidList(string $hostid): array {
        $items = API::Item()->get([
            'output'      => ['key_', 'lastvalue'],
            'hostids'     => [$hostid],
            'search'      => ['key_' => 'extremeap.ssid.'],
            'startSearch' => true
        ]) ?: [];

        $by_idx = [];
        foreach ($items as $it) {
            if (!preg_match('/^extremeap\.ssid\.(name|ifname|rxbytes|txbytes)\[(\d+)\]$/', $it['key_'], $m)) {
                continue;
            }
            $by_idx[$m[2]][$m[1]] = $it['lastvalue'];
        }

        // Derive band per radio from its current channel — the wifi0/wifi1
        // ifname prefix isn't a reliable band hint (this fleet runs dual-5 GHz
        // AP305Cs). Channels 1–14 = 2.4 GHz, ≥36 = 5 GHz.
        $radio_channels = $this->lastValuesByKey($hostid, [
            'extremeap.channel[12]',
            'extremeap.channel[13]'
        ]);
        $bandOf = function ($ch) {
            if ($ch === null || $ch === '') return null;
            $n = (int) $ch;
            if ($n >= 1 && $n <= 14) return '2.4 GHz';
            if ($n >= 36) return '5 GHz';
            return null;
        };
        $radio_band = [
            'wifi0' => $bandOf($radio_channels['extremeap.channel[12]'] ?? null),
            'wifi1' => $bandOf($radio_channels['extremeap.channel[13]'] ?? null)
        ];

        $out = [];
        foreach ($by_idx as $idx => $row) {
            $name = (string) ($row['name'] ?? '');
            if ($name === '') continue;
            $ifname = (string) ($row['ifname'] ?? '');
            $band = null;
            foreach ($radio_band as $radio => $b) {
                if ($b !== null && str_starts_with($ifname, $radio)) {
                    $band = $b;
                    break;
                }
            }

            $rx_bps = isset($row['rxbytes']) ? (float) $row['rxbytes'] * 8 : null;
            $tx_bps = isset($row['txbytes']) ? (float) $row['txbytes'] * 8 : null;

            $out[] = [
                'id'         => $idx,
                'name'       => $name,
                'ifname'     => $ifname,
                'band'       => $band ?? '—',
                'rxMbps'     => $rx_bps !== null ? round($rx_bps / 1e6, 2) : null,
                'txMbps'     => $tx_bps !== null ? round($tx_bps / 1e6, 2) : null,
                'vlan'       => null,
                'auth'       => null,
                'encryption' => null,
                'clients'    => null,
                'role'       => null
            ];
        }
        usort($out, fn($a, $b) => strnatcasecmp($a['name'], $b['name']));
        return $out;
    }

    /**
     * Pull active wireless clients for this AP from the XIQ REST API
     * (/clients/active?deviceIds=<XIQ device id>) and reshape them into
     * the per-client rows the Clients tab expects.
     *
     * Requires:
     *   - Per-AP host macro {$XIQ_DEVICE_ID} (set by the fleet template's
     *     host prototype; numeric device id).
     *   - Global macro {$XIQ_API_TOKEN} (non-secret read-side token) or
     *     {$XIQ_TOKEN} if it was set as plain text. SECRET_TEXT macros
     *     can't be read back through the Zabbix API so the host-scoped
     *     {$XIQ_TOKEN} from the fleet template isn't usable here.
     *
     * Returns null when the XIQ path is unavailable (no device id, no token,
     * or the API call errored) so the caller can fall back to PacketFence.
     * Returns [] when XIQ ran successfully but reported zero clients — that
     * authoritatively means the AP has no active associations and the PF
     * fallback would only add noise.
     */
    private function collectXiqClients(string $hostid): ?array {
        $deviceId = $this->readHostMacro($hostid, '{$XIQ_DEVICE_ID}');
        if ($deviceId === null || !is_numeric($deviceId) || (int) $deviceId <= 0) {
            $this->clientsDebug['stage']  = 'no_xiq_device_id';
            $this->clientsDebug['detail'] = 'Host macro {$XIQ_DEVICE_ID} is empty or missing.';
            return null;
        }
        $this->clientsDebug['deviceId'] = (int) $deviceId;

        $token = self::xiqGlobalToken();
        if ($token === null) {
            $this->clientsDebug['stage']  = 'no_xiq_token';
            $this->clientsDebug['detail'] = 'Global macro {$XIQ_API_TOKEN} (or {$XIQ_TOKEN}) is unset. SECRET_TEXT macros are unreadable by the API — set a non-secret read-side copy.';
            return null;
        }

        try {
            $client = XIQClient::fromToken($token);
            $rows   = $client->getClients((int) $deviceId);
        }
        catch (\Throwable $e) {
            $msg = $e->getMessage();
            error_log('[tcs_dashboard] XIQClient::getClients failed: '.$msg);
            $this->clientsDebug['stage']  = 'xiq_call_failed';
            $this->clientsDebug['detail'] = $msg;
            return null;
        }
        $this->clientsDebug['xiqRowCount'] = count($rows);

        if (!$rows) {
            $this->clientsDebug['stage']  = 'xiq_empty';
            $this->clientsDebug['detail'] = 'XIQ /clients/active returned no rows for device '.$deviceId.' — no PF fallback (XIQ is authoritative for the empty case).';
            return [];
        }

        // Shape XIQ rows into the dashboard's client record. PF enrichment
        // follows below.
        $clients = [];
        foreach ($rows as $r) {
            $health  = (int) ($r['client_health'] ?? 0);
            $posture = $health >= 80 ? 'compliant'
                     : ($health >= 50 ? 'non-compliant' : 'n/a');

            $secs  = (int) ($r['connected_seconds'] ?? 0);
            $since = $this->formatDuration($secs);

            $clients[] = [
                'host'    => (string) ($r['hostname'] !== '' ? $r['hostname'] : ($r['ip'] ?? $r['mac'])),
                'mac'     => (string) ($r['mac'] ?? ''),
                'macRaw'  => strtolower((string) ($r['mac_raw'] ?? '')),
                'user'    => (string) ($r['username'] ?? ''),
                'role'    => (string) ($r['user_profile'] ?? ''),
                'vlan'    => ((int) ($r['vlan'] ?? 0)) ?: null,
                'ssid'    => (string) ($r['ssid'] ?? ''),
                'auth'    => (string) ($r['protocol'] ?? ''),
                'rssi'    => (int)    ($r['rssi'] ?? 0),
                'rate'    => '',
                'band'    => (string) ($r['band'] ?? ''),
                'os'      => (string) ($r['os_type'] ?? ''),
                'since'   => $since,
                'posture' => $posture,
                'source'  => 'xiq'
            ];
        }

        // PacketFence enrichment — same pattern the switch FDB code uses.
        // Build a list of MACs in PF's preferred form (lowercase, colon-
        // separated — same form XIQClient::macInsertColons produces), then
        // bulk-fetch nodes + locationlogs + the role-id dictionary in three
        // calls regardless of how many clients are connected.
        $macs = [];
        foreach ($clients as $c) {
            $m = strtolower((string) ($c['mac'] ?? ''));
            if ($m !== '') $macs[$m] = true;
        }
        $macList = array_keys($macs);

        $pfMacros = $this->resolvePfMacros($hostid);
        if ($pfMacros === null) {
            $this->clientsDebug['pfStage']  = 'no_pf_macros';
            $this->clientsDebug['pfDetail'] = 'PacketFence macros not set globally or on host — XIQ data only.';
            return $clients;
        }

        try {
            $pf       = PFClient::fromMacros($pfMacros);
            $byMac    = $macList ? $pf->nodesByMac($macList) : [];
            $locByMac = [];
            try {
                $locByMac = $macList ? $pf->locationsByMac($macList) : [];
            } catch (\Throwable $e) {
                error_log('[tcs_dashboard] PF locationsByMac: '.$e->getMessage());
            }
            $catMap = [];
            try {
                $catMap = $pf->nodeCategories();
            } catch (\Throwable $e) {
                error_log('[tcs_dashboard] PF nodeCategories: '.$e->getMessage());
            }
            $this->clientsDebug['pfNodeMatches'] = count($byMac);
            $this->clientsDebug['pfLocMatches']  = count($locByMac);
        }
        catch (\Throwable $e) {
            $msg = $e->getMessage();
            error_log('[tcs_dashboard] PFClient enrichment failed: '.$msg);
            $this->clientsDebug['pfStage']  = 'pf_call_failed';
            $this->clientsDebug['pfDetail'] = $msg;
            return $clients;
        }

        // Numeric category_id → human label.
        $resolveRole = function ($raw) use ($catMap): string {
            $s = trim((string) $raw);
            if ($s === '') return '';
            if (ctype_digit($s) && isset($catMap[$s])) return $catMap[$s];
            return $s;
        };

        // Merge PF data per client. PF wins for hostname/role/user — XIQ
        // sees only what the client advertised; PF has registration data.
        // The raw PF row is also attached as $c['pf'] so the Clients tab
        // detail pane can show the full record without a second lookup.
        foreach ($clients as &$c) {
            $m   = strtolower((string) $c['mac']);
            if ($m === '') continue;
            $pfn = $byMac[$m] ?? null;
            $loc = $locByMac[$m] ?? null;

            if ($pfn) {
                if (!empty($pfn['host']))   $c['host']  = $pfn['host'];
                if (!empty($pfn['owner']))  $c['user']  = $pfn['owner'];
                $roleRaw = (string) ($pfn['role'] ?? '');
                $role    = $resolveRole($roleRaw);
                if ($role !== '') $c['role'] = $role;
                if (!empty($pfn['os']) && $c['os'] === '') $c['os'] = $pfn['os'];
                // posture: PF "REG" → compliant, "UNREG" → non-compliant.
                $reg = strtoupper((string) ($pfn['reg'] ?? ''));
                if ($reg === 'REG')   $c['posture'] = 'compliant';
                if ($reg === 'UNREG') $c['posture'] = 'non-compliant';
                $c['source'] = 'xiq+pf';
                // Stash the resolved role label alongside the raw row so
                // the detail pane can render either.
                $pfn['roleLabel'] = $c['role'];
                $c['pf'] = $pfn;
            }
            if ($loc) {
                if ($c['role'] === '' && !empty($loc['role'])) {
                    $c['role'] = $resolveRole($loc['role']);
                }
                if (!empty($loc['dot1x_username']) && ($c['user'] === '' || $c['user'] === '—')) {
                    $c['user'] = (string) $loc['dot1x_username'];
                }
                if ($c['ssid'] === '' && !empty($loc['ssid']))     $c['ssid'] = (string) $loc['ssid'];
                if ($c['vlan'] === null && !empty($loc['vlan']))   $c['vlan'] = (string) $loc['vlan'];
                // Surface the freshest locationlog row for the detail pane.
                $c['pfLoc'] = $loc;
            }
            // Final cleanup — render placeholders for fields the UI shows
            // raw so consumers don't need a fallback every time.
            $c['user'] = $c['user'] === '' ? '—' : $c['user'];
            $c['role'] = $c['role'] === '' ? 'XIQ Client' : $c['role'];
            $c['ssid'] = $c['ssid'] === '' ? '—' : $c['ssid'];
            $c['auth'] = $c['auth'] === '' ? '—' : $c['auth'];
            $c['band'] = $c['band'] === '' ? '—' : $c['band'];
            $c['os']   = $c['os']   === '' ? '—' : $c['os'];
            if ($c['vlan'] === null) $c['vlan'] = '—';
            unset($c['macRaw']);
        }
        unset($c);

        return $clients;
    }

    /**
     * Per-request scratch space populated by collectXiqClients() so the
     * frontend Debug panel can see exactly where the pipeline stopped.
     * @var array<string, mixed>
     */
    private array $clientsDebug = [];

    /**
     * Diagnostic trace for the PF AP uplink lookup — recorded by
     * collectPfApUplink() and surfaced in boot['pfApUplinkDebug'] so the
     * debug panel can show exactly which MAC was queried, which
     * locationlog rows PF returned, how each one scored, and which one
     * the uplink picker chose. Used to triage the "device card shows a
     * random incorrect switch and port" symptom.
     */
    private array $pfApUplinkDebug = [];

    /**
     * IP of the host's primary (main=1) network interface — the Mgt0 IPv4
     * for an XIQ AP. Empty string when the host has no interfaces or none
     * marked main.
     */
    private function primaryInterfaceIp(string $hostid): string {
        $ifaces = API::HostInterface()->get([
            'output'  => ['ip', 'main'],
            'hostids' => [$hostid]
        ]) ?: [];
        foreach ($ifaces as $i) {
            if ((int) ($i['main'] ?? 0) === 1) return (string) ($i['ip'] ?? '');
        }
        return '';
    }

    /** Read a single host-scoped user macro by name; null when unset. */
    private function readHostMacro(string $hostid, string $macro): ?string {
        $rows = API::UserMacro()->get([
            'output'  => ['macro', 'value'],
            'hostids' => [$hostid],
            'filter'  => ['macro' => [$macro]]
        ]) ?: [];
        foreach ($rows as $r) {
            if ($r['macro'] === $macro) return (string) $r['value'];
        }
        return null;
    }

    /** Read the global XIQ API token (non-secret), or null. */
    private static function xiqGlobalToken(): ?string {
        foreach (['{$XIQ_API_TOKEN}', '{$XIQ_TOKEN}'] as $name) {
            $rows = API::UserMacro()->get([
                'output'      => ['macro', 'value'],
                'globalmacro' => true,
                'filter'      => ['macro' => $name]
            ]) ?: [];
            $v = trim((string) ($rows[0]['value'] ?? ''));
            if ($v !== '') return $v;
        }
        return null;
    }

    /** Format a duration in seconds as "Nd Nh", "Nh Nm", or "Nm". */
    private function formatDuration(int $s): string {
        if ($s <= 0) return '—';
        $d = intdiv($s, 86400); $s %= 86400;
        $h = intdiv($s, 3600);  $s %= 3600;
        $m = intdiv($s, 60);
        if ($d > 0) return "{$d}d {$h}h";
        if ($h > 0) return "{$h}h {$m}m";
        return "{$m}m";
    }

    /**
     * Enumerate every wireless AP under host groups named
     *   Site/Wireless/<school>/<floor>
     * and return them bucketed by school, ready for window.AP_SITES.
     *
     * Each AP record carries hostid, id (visible name), ip, model, floor,
     * status (ok/warn/down), problems count, and clients (from XIQ fleet
     * if available).
     */
    private function collectApSites(): array {
        $groups = API::HostGroup()->get([
            'output'      => ['groupid', 'name'],
            'search'      => ['name' => 'Site/Wireless/'],
            'startSearch' => true
        ]) ?: [];

        // Keep only "Site/Wireless/<school>/..." groups — startSearch is a
        // prefix match so this is mostly belt-and-braces.
        $valid_groupids = [];
        foreach ($groups as $g) {
            if (str_starts_with($g['name'], 'Site/Wireless/')) {
                $valid_groupids[] = $g['groupid'];
            }
        }
        if (!$valid_groupids) return [];

        // Hosts in any matching group. Pull the groups back per-host so we
        // can read the school/floor segments from the host's actual group
        // membership rather than guessing from the group list.
        $hosts = API::Host()->get([
            'output'           => ['hostid', 'host', 'name'],
            'selectInterfaces' => ['ip', 'main'],
            'selectHostGroups' => ['groupid', 'name'],
            'groupids'         => $valid_groupids
        ]) ?: [];
        if (!$hosts) return [];

        $hostids = array_column($hosts, 'hostid');

        // Active-trigger count per host. Problem.get in Zabbix 7 doesn't
        // accept selectHosts, so route the per-host bridge through
        // Trigger.get instead — only_true=true + filter.value=1 gives the
        // currently-firing triggers, which is what "problems" means here.
        $prob_count = [];
        if ($hostids) {
            $triggers = API::Trigger()->get([
                'output'      => ['triggerid'],
                'hostids'     => $hostids,
                'selectHosts' => ['hostid'],
                'filter'      => ['value' => 1, 'status' => 0],
                'only_true'   => true,
                'monitored'   => true,
                'skipDependent' => true
            ]) ?: [];
            foreach ($triggers as $t) {
                foreach ($t['hosts'] ?? [] as $th) {
                    $hid = $th['hostid'];
                    $prob_count[$hid] = ($prob_count[$hid] ?? 0) + 1;
                }
            }
        }

        // Main-interface availability per host (Zabbix 6+: per-interface).
        $avail_map = [];
        if ($hostids) {
            $ifaces = API::HostInterface()->get([
                'output'  => ['hostid', 'available'],
                'hostids' => $hostids,
                'filter'  => ['main' => 1]
            ]) ?: [];
            foreach ($ifaces as $i) {
                $hid = $i['hostid'];
                $av  = (int) $i['available'];
                // If any main iface is up, treat host as up.
                if (!isset($avail_map[$hid]) || $av === 1) {
                    $avail_map[$hid] = $av;
                }
            }
        }

        // Per-host ICMP ping status from the standard "ICMP Ping" template's
        // icmpping item (1 = up, 0 = down). Read in one Item.get for the
        // whole fleet so the nav rail rolls availability up consistently
        // with the device card.
        $ping_map = [];
        if ($hostids) {
            $pingItems = API::Item()->get([
                'output'  => ['hostid', 'lastvalue', 'state'],
                'hostids' => $hostids,
                'filter'  => ['key_' => 'icmpping']
            ]) ?: [];
            foreach ($pingItems as $it) {
                $hid = $it['hostid'];
                if ((int) ($it['state'] ?? 0) !== 0) continue; // item not supported
                $v = $it['lastvalue'];
                if ($v === null || $v === '') continue;
                $ping_map[$hid] = ((int) $v) === 1 ? 1 : 0;
            }
        }

        // Bulk XIQ fleet lookup: gather every host's {$XIQ_SERIAL} macro in
        // one call, then one Item.get on the fleet host for all the
        // xiq.ap.clients[<serial>] + xiq.ap.model[<serial>] keys we need.
        $serial_by_host = [];
        if ($hostids) {
            $macros = API::UserMacro()->get([
                'output'  => ['hostid', 'macro', 'value'],
                'hostids' => $hostids,
                'filter'  => ['macro' => ['{$XIQ_SERIAL}']]
            ]) ?: [];
            foreach ($macros as $m) {
                if ($m['macro'] === '{$XIQ_SERIAL}' && !empty($m['value'])) {
                    $serial_by_host[$m['hostid']] = (string) $m['value'];
                }
            }
        }
        $fleet_by_serial = [];
        $fleet_hostid = $this->resolveXiqFleetHostId();
        if ($fleet_hostid !== null && $serial_by_host) {
            $wanted_keys = [];
            foreach ($serial_by_host as $serial) {
                $wanted_keys[] = 'xiq.ap.clients['.$serial.']';
                $wanted_keys[] = 'xiq.ap.model['.$serial.']';
                $wanted_keys[] = 'xiq.ap.connected['.$serial.']';
                $wanted_keys[] = 'xiq.ap.configmismatch['.$serial.']';
            }
            $items = API::Item()->get([
                'output'  => ['key_', 'lastvalue'],
                'hostids' => [$fleet_hostid],
                'filter'  => ['key_' => $wanted_keys]
            ]) ?: [];
            foreach ($items as $it) {
                if (preg_match('/^xiq\.ap\.([^[]+)\[(.+)\]$/', $it['key_'], $m)) {
                    $fleet_by_serial[$m[2]][$m[1]] = (string) $it['lastvalue'];
                }
            }
        }

        // Build per-school buckets.
        $by_school = [];
        foreach ($hosts as $h) {
            // Pick this host's "Site/Wireless/<school>/<floor>" group(s).
            $school = '';
            $floor  = '';
            foreach ($h['hostgroups'] ?? [] as $hg) {
                $name = $hg['name'] ?? '';
                if (!str_starts_with($name, 'Site/Wireless/')) continue;
                $rest  = substr($name, strlen('Site/Wireless/'));
                $parts = explode('/', $rest);
                // Prefer the most-specific match (one that has both segments).
                if (count($parts) >= 1 && $parts[0] !== '' && $school === '') {
                    $school = $parts[0];
                }
                if (count($parts) >= 2 && $parts[1] !== '') {
                    $floor = $parts[1];
                }
            }
            if ($school === '') continue;

            $primary_ip = '';
            foreach ($h['interfaces'] ?? [] as $iface) {
                if ((int) ($iface['main'] ?? 0) === 1) {
                    $primary_ip = (string) ($iface['ip'] ?? '');
                    break;
                }
            }

            $avail  = $avail_map[$h['hostid']] ?? 0;
            $prob   = $prob_count[$h['hostid']] ?? 0;
            $pingUp = $ping_map[$h['hostid']] ?? null;

            $serial  = $serial_by_host[$h['hostid']] ?? '';
            $fleet   = $serial !== '' ? ($fleet_by_serial[$serial] ?? []) : [];
            $clients = isset($fleet['clients']) ? (int) $fleet['clients'] : 0;
            $model   = $fleet['model'] ?? '';
            $xiqConn = isset($fleet['connected']) && $fleet['connected'] !== ''
                ? (((int) $fleet['connected']) === 1 ? 1 : 0)
                : null;
            $cfgMismatch = isset($fleet['configmismatch']) && $fleet['configmismatch'] !== ''
                ? (((int) $fleet['configmismatch']) === 1 ? 1 : 0)
                : null;

            // Compose XIQ + SNMP + ping into a single nav-rail status. The
            // problem count still bumps a healthy AP to "warn" so other
            // triggers stay surfaced in the rail.
            $status = self::composeApStatus($xiqConn, $avail, $pingUp);
            if ($status === 'ok' && $prob > 0) $status = 'warn';

            // Client-load thresholds: > 50 = high, > 35 = warn, else ok.
            // Kept here so the frontend doesn't have to know the numbers.
            $loadLevel = $clients > self::AP_CLIENT_HIGH ? 'high'
                       : ($clients > self::AP_CLIENT_WARN ? 'warn' : 'ok');

            if (!isset($by_school[$school])) {
                $by_school[$school] = [
                    'id'         => $school,
                    'name'       => $school,
                    // Collapsed by default — the frontend expands the
                    // section containing the active AP at mount time.
                    'expanded'   => false,
                    'problems'   => 0,
                    'overloaded' => 0,
                    'aps'        => []
                ];
            }
            $by_school[$school]['aps'][] = [
                'hostid'         => $h['hostid'],
                'id'             => $h['name'] ?: $h['host'],
                'ip'             => $primary_ip,
                'model'          => $model,
                'floor'          => $floor !== '' ? $floor : '—',
                'status'         => $status,
                'xiqConnected'   => $xiqConn,
                'snmpAvailable'  => $avail,
                'pingUp'         => $pingUp,
                'configMismatch' => $cfgMismatch,
                'clients'        => $clients,
                'loadLevel'      => $loadLevel,
                'problems'       => $prob,
                'serial'         => $serial
            ];
            $by_school[$school]['problems'] += $prob;
            if ($loadLevel !== 'ok') {
                $by_school[$school]['overloaded']++;
            }
        }

        // Sort schools alphabetically; sort APs within each school by id.
        ksort($by_school);
        foreach ($by_school as &$s) {
            usort($s['aps'], fn($a, $b) => strnatcasecmp($a['id'], $b['id']));
        }
        unset($s);

        return array_values($by_school);
    }

    /**
     * Find the XIQ fleet host (the one with the 'Extreme XIQ APs by API'
     * template linked). Cached in a static so multiple calls within the
     * same request only hit the API once. Returns hostid or null.
     */
    private function resolveXiqFleetHostId(): ?string {
        static $cached = false;
        static $value  = null;
        if ($cached) return $value;
        $cached = true;

        $hosts = API::Host()->get([
            'output'                => ['hostid'],
            'selectParentTemplates' => ['name']
        ]) ?: [];
        foreach ($hosts as $h) {
            foreach ($h['parentTemplates'] ?? [] as $t) {
                if (($t['name'] ?? '') === 'Extreme XIQ APs by API') {
                    $value = (string) $h['hostid'];
                    return $value;
                }
            }
        }
        return null;
    }

    /**
     * Pull recent PacketFence clients + auth failures for the given host.
     * Returns [[clients], [authFails]] — empty arrays on any failure so the
     * UI renders its empty-state instead of breaking.
     *
     * Reads PF endpoint creds from host- or template-level user macros:
     *   {$PF.URL}        — base URL, e.g. https://pf.example/api
     *   {$PF.USER}       — API username
     *   {$PF.PASSWORD}   — API password (Secret text recommended)
     *   {$PF.VERIFY.SSL} — "0" to disable TLS verify; anything else verifies
     *
     * Device key passed to PF is the host's `host` field (typically the
     * switch hostname or AP MAC, which PF stores in locationlog.switch).
     */
    /**
     * Look up the AP's current upstream switch + port from PacketFence
     * locationlogs. Drives the "Uplink" block on the device card (replaces
     * the old "Zabbix Templates" listing).
     *
     * Returns null when PF is unconfigured for the host, the MAC is empty,
     * or PF has no locationlog entry for this AP. The card renders an
     * empty state in that case.
     *
     * @return array{switch:string,switchIp:string,port:string,ifDesc:string}|null
     */
    public function collectPfApUplink(string $hostid, string $apMac): ?array {
        $this->pfApUplinkDebug = [
            'inputMac'     => $apMac,
            'normalizedMac'=> '',
            'pfUrl'        => '',
            'apiCall'      => '',
            'macrosOk'     => null,
            'rowCount'     => 0,
            'rows'         => [],
            'pickedIndex'  => null,
            'fallback'     => null,
            'result'       => null,
            'error'        => null,
        ];

        // Normalize whatever the XIQ macro / fleet item gave us
        // (AA-BB-CC..., aabbccddeeff, AABB.CCDD.EEFF, mixed case) into the
        // canonical PF format: lowercase colon-separated hex.
        $mac = self::normalizeMacForPf($apMac);
        $this->pfApUplinkDebug['normalizedMac'] = $mac;
        if ($mac === '') {
            $this->pfApUplinkDebug['error'] = 'empty / unparseable input MAC';
            return null;
        }

        $macros = $this->resolvePfMacros($hostid);
        $this->pfApUplinkDebug['macrosOk'] = ($macros !== null);
        if ($macros === null) {
            $this->pfApUplinkDebug['error'] = 'PF macros not configured for this host';
            error_log('[tcs_dashboard] PF AP uplink: PF macros not configured for host '.$hostid);
            return null;
        }
        $this->pfApUplinkDebug['pfUrl']   = (string) ($macros['url'] ?? '');
        $this->pfApUplinkDebug['apiCall'] = 'POST '.rtrim((string) ($macros['url'] ?? ''), '/')
                                          .'/api/v1/locationlogs/search  mac equals '.$mac.', limit 20, sort start_time DESC';

        try {
            $pf = PFClient::fromMacros($macros);

            // POST /api/v1/locationlogs/search filters by MAC properly;
            // GET /api/v1/locationlogs?mac=… does NOT (it silently ignores
            // the query param and returns the newest row fleet-wide, which
            // is how the device card used to end up pointing at a random
            // unrelated client). Pull a window of recent rows via search,
            // score them, and bail if nothing comes back — no GET fallback.
            $rows = $pf->recentLocationsForMac($mac, 20);
            $this->pfApUplinkDebug['rowCount'] = count($rows);
            $this->pfApUplinkDebug['rows']     = self::summarisePfLocRows($rows);

            $picked      = null;
            $pickedIndex = null;
            $loc         = self::pickApUplinkRowWithIndex($rows, $picked, $pickedIndex);
            $this->pfApUplinkDebug['pickedIndex'] = $pickedIndex;
            // Annotate scores onto the debug row summaries so it's obvious
            // why a particular entry won.
            if (is_array($this->pfApUplinkDebug['rows']) && $picked !== null) {
                foreach ($picked as $i => $score) {
                    if (isset($this->pfApUplinkDebug['rows'][$i])) {
                        $this->pfApUplinkDebug['rows'][$i]['_score']  = $score;
                        $this->pfApUplinkDebug['rows'][$i]['_picked'] = ($i === $pickedIndex);
                    }
                }
            }

            if (!is_array($loc) || self::pfLocRowEmpty($loc)) {
                $this->pfApUplinkDebug['error'] = 'no usable locationlog for '.$mac;
                error_log('[tcs_dashboard] PF AP uplink: no locationlog for '.$mac.' (host '.$hostid.')');
                return null;
            }

            // Defence in depth: PF v11's GET /locationlogs?mac=… ignores
            // the mac query string (only POST /search filters), and a
            // legacy fallback that hit that endpoint was returning the
            // newest fleet-wide row — i.e. someone else's client on a
            // random switch — and we'd happily promote that mac/switch
            // onto the AP. /search shouldn't ever return rows for a
            // different MAC, but verify before trusting the row.
            $rowMac = self::normalizeMacForPf((string) ($loc['mac'] ?? ''));
            if ($rowMac !== '' && $rowMac !== $mac) {
                $this->pfApUplinkDebug['error'] = 'PF returned a row for '.$rowMac
                    .' when we queried '.$mac.' — refusing to use it';
                error_log('[tcs_dashboard] PF AP uplink: MAC mismatch on row (queried '
                    .$mac.', got '.$rowMac.') for host '.$hostid);
                return null;
            }
            if ($rowMac === '') $rowMac = $mac;

            $sw   = (string) ($loc['switch']    ?? '');
            $swIp = (string) ($loc['switch_ip'] ?? '');
            $out = [
                'mac'          => $rowMac,
                'switch'       => $sw,
                'switchIp'     => $swIp,
                'switchHostid' => self::resolveSwitchHostid($sw, $swIp),
                'port'         => (string) ($loc['port']      ?? ''),
                'ifDesc'       => (string) ($loc['ifDesc']    ?? ''),
            ];
            $this->pfApUplinkDebug['result'] = $out;
            return $out;
        }
        catch (\Throwable $e) {
            $this->pfApUplinkDebug['error'] = $e->getMessage();
            error_log('[tcs_dashboard] PF AP uplink lookup ('.$mac.'): '.$e->getMessage());
            return null;
        }
    }

    /**
     * Compact representation of a PF locationlog row for the debug panel —
     * keeps the fields that drive uplink scoring and drops the rest.
     *
     * @param array<int, array<string, mixed>> $rows
     * @return array<int, array<string, mixed>>
     */
    private static function summarisePfLocRows(array $rows): array {
        $out = [];
        foreach ($rows as $r) {
            if (!is_array($r)) continue;
            $out[] = [
                'mac'             => (string) ($r['mac']             ?? ''),
                'switch'          => (string) ($r['switch']          ?? ''),
                'switch_ip'       => (string) ($r['switch_ip']       ?? ''),
                'port'            => (string) ($r['port']            ?? ''),
                'ifDesc'          => (string) ($r['ifDesc']          ?? ''),
                'connection_type' => (string) ($r['connection_type'] ?? ''),
                'role'            => (string) ($r['role']            ?? ''),
                'ssid'            => (string) ($r['ssid']            ?? ''),
                'start_time'      => (string) ($r['start_time']      ?? ''),
                'end_time'        => (string) ($r['end_time']        ?? ''),
            ];
        }
        return $out;
    }

    /**
     * Pick the locationlog row that represents the AP's actual wired
     * uplink, from a DESC-sorted list of recent rows for one MAC.
     *
     * Scoring (highest wins):
     *   +4  session still open (end_time empty / zero-date)
     *   +3  connection_type is wired (Ethernet, etc — not Wireless)
     *   +2  row has a real switch hostname (not just an IP)
     *   +1  port string is non-empty
     *   -3  connection_type is Wireless (this is the AP serving clients,
     *       not the AP plugging in — exclude unless nothing else exists)
     *
     * On ties the input order (DESC by start_time) wins. Fills $scores
     * with the per-row score map and $pickedIndex with the winning
     * index so the debug panel can show the scoring decision.
     *
     * @param array<int, array<string, mixed>> $rows
     * @param array<int, int>|null             $scores      filled by reference
     * @param int|null                         $pickedIndex filled by reference
     */
    private static function pickApUplinkRowWithIndex(array $rows, ?array &$scores, ?int &$pickedIndex): ?array {
        $scores      = [];
        $pickedIndex = null;
        if (!$rows) return null;
        $best      = null;
        $bestScore = PHP_INT_MIN;
        foreach ($rows as $i => $r) {
            if (!is_array($r)) {
                $scores[$i] = PHP_INT_MIN;
                continue;
            }
            $score = 0;
            $end   = trim((string) ($r['end_time'] ?? ''));
            if ($end === '' || $end === '0000-00-00 00:00:00') $score += 4;

            $type = strtolower((string) ($r['connection_type'] ?? ''));
            if ($type !== '' && str_contains($type, 'wireless')) {
                $score -= 3;
            } elseif ($type !== '') {
                $score += 3;
            }
            if (trim((string) ($r['switch'] ?? '')) !== '')    $score += 2;
            if (trim((string) ($r['port']   ?? '')) !== '')    $score += 1;

            $scores[$i] = $score;
            if ($score > $bestScore) {
                $bestScore   = $score;
                $best        = $r;
                $pickedIndex = $i;
            }
        }
        return $best;
    }

    /**
     * Resolve a Zabbix hostid for the upstream switch — matched first by
     * exact host name (PF's locationlog.switch typically holds the Zabbix
     * host name) and then by SNMP/agent interface IP. Returns '' when
     * nothing matches, in which case the Cycle PoE button stays disabled.
     */
    private static function resolveSwitchHostid(string $switchName, string $switchIp): string {
        $name = trim($switchName);
        if ($name !== '') {
            $rows = API::Host()->get([
                'output' => ['hostid'],
                'filter' => ['host' => $name]
            ]) ?: [];
            if (!$rows) {
                $rows = API::Host()->get([
                    'output' => ['hostid'],
                    'filter' => ['name' => $name]
                ]) ?: [];
            }
            if ($rows) return (string) $rows[0]['hostid'];
        }
        $ip = trim($switchIp);
        if ($ip !== '' && $ip !== '0.0.0.0') {
            $ifaces = API::HostInterface()->get([
                'output' => ['hostid', 'type'],
                'filter' => ['ip' => $ip]
            ]) ?: [];
            $snmpHit = '';
            $anyHit  = '';
            foreach ($ifaces as $iface) {
                if ((int) ($iface['type'] ?? 0) === 2 && $snmpHit === '') {
                    $snmpHit = (string) $iface['hostid'];
                } elseif ($anyHit === '') {
                    $anyHit = (string) $iface['hostid'];
                }
            }
            if ($snmpHit !== '') return $snmpHit;
            if ($anyHit  !== '') return $anyHit;
        }
        return '';
    }

    /** PF v11+ canonical MAC format: 12 lowercase hex digits in colon pairs. */
    private static function normalizeMacForPf(string $mac): string {
        $hex = strtolower(preg_replace('/[^0-9a-fA-F]/', '', $mac) ?? '');
        if (strlen($hex) !== 12) return '';
        return implode(':', str_split($hex, 2));
    }

    /** True when a PF locationlog row has no switch / port info to display. */
    private static function pfLocRowEmpty(array $loc): bool {
        return trim((string) ($loc['switch']    ?? '')) === ''
            && trim((string) ($loc['switch_ip'] ?? '')) === ''
            && trim((string) ($loc['port']      ?? '')) === ''
            && trim((string) ($loc['ifDesc']    ?? '')) === '';
    }

    private function collectPacketFence(string $hostid, ?array $host): array {
        // Don't ask PF about an AP that's fully unreachable (apStatus
        // === 'down' means XIQ + SNMP + ping all report down). No live
        // clients can be on it and no auth traffic is flowing — the PF
        // call would just be a wasted round-trip (and would still count
        // against the PF token's request budget).
        if ((string) ($host['apStatus'] ?? '') === 'down') {
            return [[], []];
        }
        $macros = $this->resolvePfMacros($hostid);
        if ($macros === null) {
            return [[], []];
        }

        try {
            $pf     = PFClient::fromMacros($macros);
            $hostIp = (string) ($host['ip'] ?? '');
            if ($hostIp === '') return [[], []];

            return [
                // clientsForNode → locationlogs/search filtered by switch_ip.
                // authFailuresForNode → radius_audit_logs/search filtered
                // by nas_ip_address. Both want the host's Mgt0 IPv4.
                $pf->clientsForNode($hostIp),
                $pf->authFailuresForNode($hostIp)
            ];
        }
        catch (\Throwable $e) {
            error_log('[tcs_dashboard] PFClient: '.$e->getMessage());
            return [[], []];
        }
    }

    /**
     * @return array{url:string,user:string,pass:string,verify_ssl:bool}|null
     */
    public function resolvePfMacros(string $hostid): ?array {
        $names = ['{$PF.URL}', '{$PF.USER}', '{$PF.PASSWORD}', '{$PF.VERIFY.SSL}'];
        // Precedence: globals (lowest) → linked templates → host (highest).
        // The Extreme AP per-AP host typically doesn't carry PF macros — they
        // sit on the global scope — so this walk is what makes the PF
        // enrichment work at all on the AP detail page.
        $bag = [];

        $globals = API::UserMacro()->get([
            'output'      => ['macro', 'value'],
            'globalmacro' => true,
            'filter'      => ['macro' => $names]
        ]) ?: [];
        foreach ($globals as $r) {
            $bag[$r['macro']] = (string) $r['value'];
        }

        $templateIds = self::collectTemplateAncestry($hostid);
        if ($templateIds) {
            $tplMacros = API::UserMacro()->get([
                'output'  => ['macro', 'value'],
                'hostids' => $templateIds,
                'filter'  => ['macro' => $names]
            ]) ?: [];
            foreach ($tplMacros as $r) {
                $bag[$r['macro']] = (string) $r['value'];
            }
        }

        $hostMacros = API::UserMacro()->get([
            'output'  => ['macro', 'value'],
            'hostids' => [$hostid],
            'filter'  => ['macro' => $names]
        ]) ?: [];
        foreach ($hostMacros as $r) {
            $bag[$r['macro']] = (string) $r['value'];
        }

        $url  = $bag['{$PF.URL}']  ?? '';
        $user = $bag['{$PF.USER}'] ?? '';
        $pass = $bag['{$PF.PASSWORD}'] ?? '';
        if ($url === '' || $user === '' || $pass === '') {
            return null;
        }

        return [
            'url'        => $url,
            'user'       => $user,
            'pass'       => $pass,
            'verify_ssl' => ($bag['{$PF.VERIFY.SSL}'] ?? '1') !== '0'
        ];
    }

    /**
     * Resolve {$PF.ADMIN_URL} via the same host → templates → globals chain
     * the switch tab uses. Returns '' if unset. PF's admin UI typically
     * lives on a different port than the API (api on :9999, admin on
     * :1443), so this is a separate macro from {$PF.URL}.
     */
    public function resolvePfAdminUrl(string $hostid): string {
        $names = ['{$PF.ADMIN_URL}'];
        $bag = [];

        $globals = API::UserMacro()->get([
            'output'      => ['macro', 'value'],
            'globalmacro' => true,
            'filter'      => ['macro' => $names]
        ]) ?: [];
        foreach ($globals as $r) {
            if (!array_key_exists('value', $r)) continue;
            $bag[$r['macro']] = (string) $r['value'];
        }

        $templateIds = self::collectTemplateAncestry($hostid);
        if ($templateIds) {
            $tplMacros = API::UserMacro()->get([
                'output'  => ['macro', 'value'],
                'hostids' => $templateIds,
                'filter'  => ['macro' => $names]
            ]) ?: [];
            foreach ($tplMacros as $r) {
                if (!array_key_exists('value', $r)) continue;
                $bag[$r['macro']] = (string) $r['value'];
            }
        }

        $hostMacros = API::UserMacro()->get([
            'output'  => ['macro', 'value'],
            'hostids' => [$hostid],
            'filter'  => ['macro' => $names]
        ]) ?: [];
        foreach ($hostMacros as $r) {
            if (!array_key_exists('value', $r)) continue;
            $bag[$r['macro']] = (string) $r['value'];
        }

        return rtrim((string) ($bag['{$PF.ADMIN_URL}'] ?? ''), '/');
    }

    /**
     * Walk full template ancestry (parents + parents-of-parents).
     * Zabbix's selectParentTemplates is one hop only.
     *
     * @return array<int, string>
     */
    private static function collectTemplateAncestry(string $hostid): array {
        $hosts = API::Host()->get([
            'output'                => ['hostid'],
            'hostids'               => [$hostid],
            'selectParentTemplates' => ['templateid']
        ]) ?: [];
        $seen  = [];
        $queue = [];
        if ($hosts) {
            foreach (($hosts[0]['parentTemplates'] ?? []) as $t) {
                $queue[] = (string) $t['templateid'];
            }
        }
        while ($queue) {
            $batch = [];
            foreach ($queue as $tid) {
                if (!isset($seen[$tid])) {
                    $seen[$tid] = true;
                    $batch[] = $tid;
                }
            }
            $queue = [];
            if (!$batch) break;
            $rows = API::Template()->get([
                'output'                => ['templateid'],
                'templateids'           => $batch,
                'selectParentTemplates' => ['templateid']
            ]) ?: [];
            foreach ($rows as $t) {
                foreach (($t['parentTemplates'] ?? []) as $p) {
                    $pid = (string) $p['templateid'];
                    if (!isset($seen[$pid])) $queue[] = $pid;
                }
            }
        }
        return array_keys($seen);
    }

    /* --------------------------------------------------------------------- */
    /* Helpers                                                               */
    /* --------------------------------------------------------------------- */

    /**
     * Roll the three independent AP availability signals into a single
     * status label the UI can colour-code.
     *
     *   $xiqConnected  — XIQ "connected" flag: 1 / 0 / null (unknown)
     *   $snmpAvailable — Zabbix main-interface availability: 1 (up) / 2 (down) / 0 (unknown)
     *   $pingUp        — ICMP Ping (icmpping item): 1 / 0 / null (unknown / missing)
     *
     * Returns one of: 'ok', 'warn', 'down', 'idle'.
     *
     *  - "down"  — at least one *known* signal says the AP is unreachable
     *              (ping=0, snmp=2, or xiq=0). Unknown signals don't
     *              count as "down" since the AP may simply not be
     *              monitored from that source.
     *  - "warn"  — a strict subset of signals is down (e.g. XIQ is
     *              disconnected but the AP still pings — likely a cloud
     *              comm problem, not a fully dead AP).
     *  - "ok"    — every signal we *do* have says the AP is up.
     *  - "idle"  — no signal known at all yet (newly added host).
     */
    private static function composeApStatus(?int $xiqConnected, int $snmpAvailable, ?int $pingUp): string {
        $known  = [];
        $up     = 0;
        $down   = 0;

        if ($pingUp !== null) {
            $known[] = 'ping';
            $pingUp === 1 ? $up++ : $down++;
        }
        if ($snmpAvailable === 1 || $snmpAvailable === 2) {
            $known[] = 'snmp';
            $snmpAvailable === 1 ? $up++ : $down++;
        }
        if ($xiqConnected !== null) {
            $known[] = 'xiq';
            $xiqConnected === 1 ? $up++ : $down++;
        }
        if (!$known) return 'idle';
        if ($down === 0) return 'ok';
        if ($up   === 0) return 'down';
        return 'warn';
    }

    private function resolveAvailability(string $hostid): int {
        // Zabbix 6.0+: availability is per-interface. Treat the host as
        // "available" if at least one main interface is up.
        $ifaces = API::HostInterface()->get([
            'output'  => ['available'],
            'hostids' => [$hostid],
            'filter'  => ['main' => 1]
        ]);
        foreach ($ifaces as $i) {
            if ((int) $i['available'] === 1) return 1;
        }
        return 2;
    }

    private function resolveProxy(string $proxy_hostid): string {
        if ($proxy_hostid === '0' || $proxy_hostid === '') return '';
        $proxies = API::Proxy()->get([
            'output'   => ['host'],
            'proxyids' => [$proxy_hostid]
        ]);
        return $proxies[0]['host'] ?? '';
    }

    private function resolveUptime(string $hostid): int {
        $items = API::Item()->get([
            'output'  => ['lastvalue'],
            'hostids' => [$hostid],
            'filter'  => ['key_' => 'system.uptime']
        ]);
        return $items ? (int) $items[0]['lastvalue'] : 0;
    }
}
