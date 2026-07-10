<?php declare(strict_types=1);

namespace Modules\TcsDashboard\Actions;

use API;
use CControllerResponseData;
use CControllerResponseFatal;
use Modules\TcsDashboard\Lib\SwitchClient;

/**
 * GET zabbix.php?action=tcs.switches.view[&switchid=NNN]
 *
 * Collects an initial snapshot of stack / port / PoE state from the Zabbix
 * Item API (via SwitchClient) and hands it to the view as $data['boot'].
 * The view inlines this as window.SWITCH_BOOT so a future switches-bridge.jsx
 * can adapt it into window.SWITCH_SITES / window.ARC_MDF_STACK /
 * window.makePortDetail without changing the React components.
 *
 * Item keys expected on switch hosts (from the lifted EXOS template
 * templates/extreme_exos_by_snmp_with_poe.yaml):
 *   stacking.member[1..8]
 *   net.if.status[ifOperStatus.<member>.<port>]
 *   snmp.interfaces.poe.dstatus[<member>.<port>]
 *   net.if.mac[<member>.<port>]                  (FDB, if discovered)
 */
class ActionSwitches extends ActionBase {

    protected function checkInput(): bool {
        $fields = [
            'switchid' => 'string'  // hostid of the switch to focus on
        ];

        $ret = $this->validateInput($fields);

        if (!$ret) {
            $this->setResponse(new CControllerResponseFatal());
        }

        return $ret;
    }

    protected function doAction(): void {
        $switchid = $this->getInput('switchid', '');

        // Page load is intentionally minimal — fleet, snapshot, and problems
        // are fetched asynchronously by switches-bridge.jsx after first paint
        // (see tcs.switches.fleet.data + tcs.switches.snapshot.data). Only
        // the host's identity is loaded here so the page header pills render
        // immediately with the right hostname.
        $boot = [
            'host'     => null,
            'members'  => [],
            'ports'    => [],
            'poe'      => [],
            'fdb'      => [],
            'kpis'     => new \stdClass(),
            'history'  => new \stdClass(),
            'uplinks'  => [],
            'problems' => [],
            'fleet'    => [],
            // Admin-only features (the live CLI tab exposes SSH credentials)
            // key off this. The server is the real gate — the snapshot
            // endpoint withholds the ssh descriptor from non-admins; this
            // flag just lets the UI hide the tab to match.
            'isAdmin'  => $this->getUserType() >= USER_TYPE_ZABBIX_ADMIN,
            'async'    => true
        ];

        if ($switchid !== '') {
            $boot['host'] = $this->collectHost($switchid);
        }

        $data = [
            'title'    => _('TCS Switch Port Status'),
            'switchid' => $switchid,
            'boot'     => $boot
        ];

        $response = new CControllerResponseData($data);
        $response->setTitle(_('TCS Switch Port Status'));
        $this->setResponse($response);
    }

    private function collectHost(string $hostid): ?array {
        $hosts = API::Host()->get([
            'output'           => ['hostid', 'host', 'name', 'status', 'maintenance_status'],
            'selectInterfaces' => ['ip', 'main', 'type'],
            'hostids'          => [$hostid]
        ]);
        if (!$hosts) return null;

        $h  = $hosts[0];
        $ip = '';
        foreach ($h['interfaces'] ?? [] as $iface) {
            if ((int) ($iface['main'] ?? 0) === 1) {
                $ip = $iface['ip'];
                break;
            }
        }

        return [
            'hostid'       => $h['hostid'],
            'host'         => $h['host'],
            'visible_name' => $h['name'],
            'ip'           => $ip,
            'status'       => ((int) $h['status'] === 0) ? 'monitored' : 'not monitored',
            'maintenance'  => (int) ($h['maintenance_status'] ?? 0)
        ];
    }

    /**
     * Recent problems for one switch host, shaped for the React ProblemsWidget
     * (SWITCH_PROBLEMS schema: { ts, sev, host, trig, age, ack }).
     *
     * Includes open and recently-resolved problems from the last 24h so the
     * "last 24h" header above the list is accurate.
     *
     * @return array<int, array<string, mixed>>
     */
    private function collectProblems(string $hostid, int $limit = 25): array {
        $sinceClock = time() - 24 * 3600;

        $problems = API::Problem()->get([
            'output'        => ['eventid', 'name', 'severity', 'clock', 'r_eventid', 'r_clock', 'acknowledged'],
            'hostids'       => [$hostid],
            'recent'        => true, // include resolved-recent
            'time_from'     => $sinceClock,
            'sortfield'     => ['eventid'],
            'sortorder'     => 'DESC',
            'limit'         => $limit
        ]) ?: [];

        // Single host.get for the display name.
        $hosts = API::Host()->get([
            'output'  => ['hostid', 'host'],
            'hostids' => [$hostid]
        ]);
        $hostName = $hosts[0]['host'] ?? '';

        // Zabbix severity 0..5 → frontend label expected by the widget.
        $sevLabel = [
            0 => 'info', 1 => 'info', 2 => 'warning',
            3 => 'average', 4 => 'high', 5 => 'disaster'
        ];

        $now = time();
        $out = [];
        foreach ($problems as $p) {
            $clock = (int) $p['clock'];
            $ageSec = max(0, $now - $clock);
            $h = intdiv($ageSec, 3600);
            $m = intdiv($ageSec % 3600, 60);
            $age = sprintf('%02d:%02d', $h, $m);

            $out[] = [
                'ts'   => date('H:i:s', $clock),
                'sev'  => $sevLabel[(int) $p['severity']] ?? 'info',
                'host' => $hostName,
                'trig' => (string) $p['name'],
                'age'  => $age,
                'ack'  => (int) $p['acknowledged'] === 1
            ];
        }
        return $out;
    }

    /**
     * Full fleet rollup (skeleton + counters) used by SSR / reflection callers
     * that need a single payload. The JSON data endpoints split this into a
     * fast skeleton fetch and a deferred counters fetch — the navigator only
     * needs the skeleton, so it can render before the heavy item.get for port
     * and PoE state finishes.
     *
     * @return array<int, array<string, mixed>>
     */
    private function collectFleet(): array {
        // Per-request page loads (and every navigator click — tcsNavigateSwitch
        // does a full page reload) used to recompute everything. Cache for 5
        // minutes in APCu so navigator clicks feel instant; counters lag by
        // ≤300s, which is well within the underlying SNMP poll interval (60s+
        // for the heavier items).
        $cacheKey = 'tcs_dashboard:switch_fleet:v2';
        if (function_exists('apcu_fetch')) {
            $hit = apcu_fetch($cacheKey, $ok);
            if ($ok && is_array($hit)) return $hit;
        }

        $skeleton = $this->collectFleetSkeleton();
        $counters = $this->collectFleetCounters();
        $fleet    = self::mergeFleetCounters($skeleton, $counters);

        if (function_exists('apcu_store')) {
            apcu_store($cacheKey, $fleet, 300);
        }
        return $fleet;
    }

    /**
     * Sites + hosts + per-host problem count. NO port / PoE / stacking
     * item.get calls — those are the heavy queries that made the navigator
     * slow. Returns the SWITCH_SITES shape with counter fields zeroed; the
     * bridge merges in the real counters from a deferred fetch.
     *
     * Cached for 5 min in APCu under its own key so the navigator path
     * doesn't share cache invalidation with the slower counters path.
     *
     * @return array<int, array<string, mixed>>
     */
    public function collectFleetSkeleton(): array {
        $cacheKey = 'tcs_dashboard:switch_fleet_skel:v1';
        if (function_exists('apcu_fetch')) {
            $hit = apcu_fetch($cacheKey, $ok);
            if ($ok && is_array($hit)) return $hit;
        }
        $skel = $this->collectFleetSkeletonUncached();
        if (function_exists('apcu_store')) {
            apcu_store($cacheKey, $skel, 300);
        }
        return $skel;
    }

    /**
     * Per-host port / PoE / stacking / model rollup, keyed by hostid. The
     * navigator never reads these directly — they feed the page-header
     * pills on switches-app.jsx — so they can arrive after first paint.
     *
     * @return array<string, array<string, int|string>>
     */
    public function collectFleetCounters(): array {
        $cacheKey = 'tcs_dashboard:switch_fleet_counters:v1';
        if (function_exists('apcu_fetch')) {
            $hit = apcu_fetch($cacheKey, $ok);
            if ($ok && is_array($hit)) return $hit;
        }
        $counters = $this->collectFleetCountersUncached();
        if (function_exists('apcu_store')) {
            apcu_store($cacheKey, $counters, 300);
        }
        return $counters;
    }

    /** Splice counter rollups into the skeleton's switch rows. */
    private static function mergeFleetCounters(array $skeleton, array $counters): array {
        foreach ($skeleton as &$site) {
            foreach (($site['switches'] ?? []) as &$sw) {
                $hid = (string) ($sw['hostid'] ?? '');
                if ($hid === '' || !isset($counters[$hid])) continue;
                foreach ($counters[$hid] as $k => $v) $sw[$k] = $v;
            }
            unset($sw);
        }
        unset($site);
        return $skeleton;
    }

    /** @return array<int, array<string, mixed>> */
    private function collectFleetSkeletonUncached(): array {
        // Step 1: Site/* host groups.
        $siteGroups = API::HostGroup()->get([
            'output'      => ['groupid', 'name'],
            'search'      => ['name' => 'Site/'],
            'startSearch' => true
        ]) ?: [];
        if (!$siteGroups) return [];

        $groupids = array_column($siteGroups, 'groupid');

        // Step 2: hosts in those groups, tag target=exos.
        $taggedHosts = API::Host()->get([
            'output'           => ['hostid', 'host', 'name', 'status'],
            'selectInterfaces' => ['ip', 'main'],
            'selectHostGroups' => ['groupid', 'name'],
            'selectTags'       => ['tag', 'value'],
            'groupids'         => $groupids,
            'tags'             => [['tag' => 'target', 'value' => 'exos', 'operator' => 1]],
            'evaltype'         => 0,
            'inheritedTags'    => true,
            'preservekeys'     => true
        ]) ?: [];
        if (!$taggedHosts) return [];

        $hostids = array_keys($taggedHosts);

        // Per-host open-problem counts. Same logic as the legacy unified
        // collector but lifted out so the navigator skeleton can carry the
        // site/host-level problem badges without waiting on port/PoE rollups.
        $problemByHost = [];
        $problems = API::Problem()->get([
            'output'  => ['eventid'],
            'hostids' => $hostids,
            'recent'  => false
        ]) ?: [];
        if ($problems) {
            $events = API::Event()->get([
                'output'      => ['eventid'],
                'eventids'    => array_column($problems, 'eventid'),
                'selectHosts' => ['hostid']
            ]) ?: [];
            foreach ($events as $ev) {
                foreach ($ev['hosts'] ?? [] as $h) {
                    $hid = (string) $h['hostid'];
                    if (isset($taggedHosts[$hid])) {
                        $problemByHost[$hid] = ($problemByHost[$hid] ?? 0) + 1;
                    }
                }
            }
        }

        // Bucket hosts by Site/* host group.
        $sites = [];
        foreach ($hostids as $hid) {
            $h = $taggedHosts[$hid] ?? null;
            if (!$h) continue;

            $ip = '';
            foreach ($h['interfaces'] ?? [] as $iface) {
                if ((int) ($iface['main'] ?? 0) === 1) { $ip = $iface['ip']; break; }
            }

            $siteName = '';
            foreach ($h['hostgroups'] ?? [] as $g) {
                if (str_starts_with((string) $g['name'], 'Site/')) {
                    $siteName = substr($g['name'], strlen('Site/'));
                    break;
                }
            }
            if ($siteName === '') continue;
            $siteId = strtolower(preg_replace('/[^a-z0-9]+/i', '-', $siteName));

            if (!isset($sites[$siteId])) {
                $sites[$siteId] = [
                    'id'       => $siteId,
                    'name'     => $siteName,
                    'expanded' => false,
                    'problems' => 0,
                    'switches' => []
                ];
            }

            $row = [
                'id'       => $h['host'],
                'hostid'   => (string) $h['hostid'],
                'name'     => $h['name'],
                'ip'       => $ip,
                // Counter fields stay zeroed in the skeleton; the deferred
                // counters fetch fills them in via mergeFleetCounters().
                'model'    => '—',
                'members'  => 1,
                'ports'    => 0,
                'up'       => 0,
                'down'     => 0,
                'poe'      => 0,
                'cpu'      => 0,
                'mem'      => 0,
                'temp'     => 0,
                'problems' => (int) ($problemByHost[$hid] ?? 0)
            ];

            $sites[$siteId]['switches'][] = $row;
            $sites[$siteId]['problems']  += $row['problems'];
        }

        foreach ($sites as &$site) {
            usort($site['switches'], fn($a, $b) => strcmp($a['id'], $b['id']));
        }
        unset($site);
        uasort($sites, fn($a, $b) => strcmp($a['name'], $b['name']));
        return array_values($sites);
    }

    /**
     * Port / PoE / stacking / model rollup, keyed by hostid. Reuses the same
     * host discovery as the skeleton so the same fleet is in scope.
     *
     * @return array<string, array<string, int|string>>
     */
    private function collectFleetCountersUncached(): array {
        // Re-resolve EXOS hosts here so this method can run independently
        // of the skeleton (each has its own APCu cache + endpoint).
        $siteGroups = API::HostGroup()->get([
            'output'      => ['groupid'],
            'search'      => ['name' => 'Site/'],
            'startSearch' => true
        ]) ?: [];
        if (!$siteGroups) return [];

        $taggedHosts = API::Host()->get([
            'output'          => ['hostid'],
            'selectInventory' => ['model'],
            'groupids'        => array_column($siteGroups, 'groupid'),
            'tags'            => [['tag' => 'target', 'value' => 'exos', 'operator' => 1]],
            'evaltype'        => 0,
            'inheritedTags'   => true,
            'preservekeys'    => true
        ]) ?: [];
        if (!$taggedHosts) return [];

        $hostids = array_keys($taggedHosts);

        // Stacking items — counted per host for the members KPI. The EXOS
        // template literally ships the misspelled key `stacking.memeber[…]`
        // (sic); match both forms.
        $stackingItems = API::Item()->get([
            'output'      => ['hostid', 'key_'],
            'hostids'     => $hostids,
            'search'      => ['key_' => 'stacking.'],
            'startSearch' => true
        ]) ?: [];

        $memberCount = [];
        foreach ($stackingItems as $it) {
            $k = (string) $it['key_'];
            if (!preg_match('/^(?:extreme\.)?(?:snmp\.)?stack(?:ing)?\.(?:member|memeber)\[\d+\]$/', $k)) continue;
            $hid = (string) $it['hostid'];
            $memberCount[$hid] = ($memberCount[$hid] ?? 0) + 1;
        }

        // Port + PoE rollups. Both queries return potentially thousands of
        // rows fleet-wide — by far the heaviest part of fleet discovery.
        // `output` is trimmed to the bare minimum (drop key_ — it's already
        // implied by the search filter).
        $portItems = API::Item()->get([
            'output'      => ['hostid', 'lastvalue'],
            'hostids'     => $hostids,
            'search'      => ['key_' => 'net.if.status[ifOperStatus.'],
            'startSearch' => true,
            'monitored'   => true
        ]) ?: [];

        $poeItems = API::Item()->get([
            'output'      => ['hostid', 'lastvalue'],
            'hostids'     => $hostids,
            'search'      => ['key_' => 'snmp.interfaces.poe.dstatus['],
            'startSearch' => true,
            'monitored'   => true
        ]) ?: [];

        $counters = [];
        foreach ($hostids as $hid) {
            $counters[(string) $hid] = [
                'model'   => (string) ($taggedHosts[$hid]['inventory']['model'] ?? '—'),
                'members' => max(1, (int) ($memberCount[(string) $hid] ?? 1)),
                'ports'   => 0,
                'up'      => 0,
                'down'    => 0,
                'poe'     => 0
            ];
        }
        foreach ($portItems as $it) {
            $hid = (string) $it['hostid'];
            if (!isset($counters[$hid])) continue;
            $counters[$hid]['ports']++;
            $s = (int) $it['lastvalue'];
            if      ($s === 1) $counters[$hid]['up']++;
            elseif  ($s === 2) $counters[$hid]['down']++;
        }
        foreach ($poeItems as $it) {
            $hid = (string) $it['hostid'];
            if (!isset($counters[$hid])) continue;
            if ((int) $it['lastvalue'] === 3) {
                $counters[$hid]['poe']++;
            }
        }

        return $counters;
    }
}
