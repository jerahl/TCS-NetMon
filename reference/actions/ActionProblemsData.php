<?php declare(strict_types=1);

namespace Modules\TcsDashboard\Actions;

use API;
use CControllerResponseData;
use CControllerResponseFatal;

/**
 * GET zabbix.php?action=tcs.problems.data
 *   [&severity=disaster,high,warning,info,none]
 *   [&ack=any|true|false]
 *   [&groupids=1,2,3]
 *   [&search=substr]
 *   [&maxAge=1h|6h|24h|7d|all]
 *
 * Returns the live snapshot consumed by problems-bridge.jsx.
 */
class ActionProblemsData extends ActionDataBase {

    private const MAX_AGE = [
        '1h'  =>     3600,
        '6h'  =>  6 * 3600,
        '24h' => 24 * 3600,
        '7d'  =>  7 * 86400,
        'all' => 0
    ];

    private const SEV_LABEL = [
        0 => 'info', 1 => 'info', 2 => 'warning',
        3 => 'warning', 4 => 'high', 5 => 'disaster'
    ];

    protected function checkInput(): bool {
        $ret = $this->validateInput([
            'severity' => 'string',
            'ack'      => 'string',
            'groupids' => 'string',
            'search'   => 'string',
            'maxAge'   => 'string'
        ]);
        if (!$ret) {
            $this->setResponse(new CControllerResponseFatal());
        }
        return $ret;
    }

    protected function doAction(): void {
        $payload = $this->collect([
            'severity' => $this->getInput('severity', ''),
            'ack'      => $this->getInput('ack', 'any'),
            'groupids' => $this->getInput('groupids', ''),
            'search'   => $this->getInput('search', ''),
            'maxAge'   => $this->getInput('maxAge', 'all')
        ]);
        $this->setResponse(new CControllerResponseData(['main_block' => json_encode($payload)]));
    }

    public function collect(array $filters = []): array {
        $filters = array_merge([
            'severity' => '', 'ack' => 'any', 'groupids' => '',
            'search' => '', 'maxAge' => 'all'
        ], $filters);

        $sev_filter   = array_filter(array_map('trim', explode(',', $filters['severity'])));
        $group_filter = array_filter(array_map('trim', explode(',', $filters['groupids'])));
        $max_age_sec  = self::MAX_AGE[$filters['maxAge']] ?? 0;
        $search       = trim($filters['search']);
        $ack_filter   = $filters['ack'];

        // High explicit limit instead of leaving it to Zabbix's default
        // search.limit (typically 1000). The Problems page is the operator's
        // master list — every open problem must be present, not just the
        // newest N. Real estates rarely exceed a few thousand simultaneous
        // problems; 10k is comfortable headroom without unbounded growth.
        $params = [
            'output'    => ['eventid', 'objectid', 'name', 'severity', 'clock', 'acknowledged', 'r_eventid'],
            'recent'    => false,
            'sortfield' => ['eventid'],
            'sortorder' => 'DESC',
            'limit'     => 10000
        ];
        if ($group_filter) {
            $params['groupids'] = $group_filter;
        }
        $problems = $this->safeGet(fn() => API::Problem()->get($params));
        // Drop anything with a recovery event — problem.get can include
        // recently-resolved rows within the OK-display window.
        $problems = array_values(array_filter(
            $problems,
            fn($p) => empty($p['r_eventid']) || (int) $p['r_eventid'] === 0
        ));

        // Resolve triggerid → hosts (Zabbix 7.2 removed selectHosts on problem.get).
        $trigger_ids = array_unique(array_column($problems, 'objectid'));
        $trigger_hosts = $this->resolveTriggerHosts($trigger_ids);

        // Available hostgroup options (always returned so the filter panel
        // can populate its dropdown without a second call).
        $groups = $this->safeGet(fn() => API::HostGroup()->get([
            'output'             => ['groupid', 'name'],
            'with_monitored_hosts' => true,
            'sortfield'          => ['name']
        ]));

        $now = time();
        $rows = [];
        foreach ($problems as $p) {
            $sev_int = (int) $p['severity'];
            $sev = self::SEV_LABEL[$sev_int] ?? 'info';
            $hosts = $trigger_hosts[$p['objectid']] ?? [];
            $host_label = $hosts[0]['name'] ?? ($hosts[0]['host'] ?? '—');
            $host_id    = $hosts[0]['hostid'] ?? '';
            $hostgroups = array_map(fn($g) => $g['name'], $hosts[0]['hostgroups'] ?? []);
            $age = max(0, $now - (int) $p['clock']);
            $ack = (int) $p['acknowledged'] === 1;

            // Client-side filters (server-side filtering would require
            // separate problem.get queries, since 'severity' on problem.get
            // is fixed-list and 'search' isn't supported).
            if ($sev_filter && !in_array($sev, $sev_filter, true)) continue;
            if ($ack_filter === 'true'  && !$ack) continue;
            if ($ack_filter === 'false' &&  $ack) continue;
            if ($max_age_sec > 0 && $age > $max_age_sec) continue;
            if ($search !== '' && stripos($p['name'].' '.$host_label, $search) === false) continue;

            $rows[] = [
                'eventid'    => $p['eventid'],
                'severity'   => $sev,
                'host'       => $host_label,
                'hostid'     => $host_id,
                'hostgroups' => $hostgroups,
                'trigger'    => $p['name'],
                'clock'      => (int) $p['clock'],
                'ageSec'     => $age,
                'ageStr'     => $this->fmtAge($age),
                'ack'        => $ack
            ];
        }

        return [
            // No slice — the page is meant to be the comprehensive
            // open-problems list. Filters narrow it; the response shouldn't.
            'problems' => $rows,
            'metrics'  => $this->buildMetrics($rows),
            'groups'   => array_map(fn($g) => ['id' => $g['groupid'], 'name' => $g['name']], $groups),
            'filters'  => $filters,
            'ts'       => $now
        ];
    }

    private function buildMetrics(array $rows): array {
        $by_sev = ['disaster' => 0, 'high' => 0, 'warning' => 0, 'info' => 0];
        $by_host = [];
        $by_group = [];
        $age_sum = 0;
        $unacked = 0;
        foreach ($rows as $r) {
            $by_sev[$r['severity']] = ($by_sev[$r['severity']] ?? 0) + 1;
            $by_host[$r['host']]    = ($by_host[$r['host']] ?? 0) + 1;
            foreach ($r['hostgroups'] as $g) {
                $by_group[$g] = ($by_group[$g] ?? 0) + 1;
            }
            $age_sum += $r['ageSec'];
            if (!$r['ack']) $unacked++;
        }
        arsort($by_host); arsort($by_group);
        $top_hosts  = [];
        $top_groups = [];
        foreach (array_slice($by_host, 0, 8, true)  as $h => $n) $top_hosts[]  = ['name' => $h, 'count' => $n];
        foreach (array_slice($by_group, 0, 8, true) as $g => $n) $top_groups[] = ['name' => $g, 'count' => $n];

        return [
            'total'      => count($rows),
            'bySeverity' => $by_sev,
            'unacked'    => $unacked,
            'avgAgeSec'  => count($rows) ? (int) round($age_sum / count($rows)) : 0,
            'avgAgeStr'  => count($rows) ? $this->fmtAge((int) round($age_sum / count($rows))) : '—',
            'topHosts'   => $top_hosts,
            'topGroups'  => $top_groups
        ];
    }

    private function resolveTriggerHosts(array $trigger_ids): array {
        if (!$trigger_ids) return [];
        $triggers = $this->safeGet(fn() => API::Trigger()->get([
            'output'           => ['triggerid'],
            'selectHosts'      => ['hostid', 'host', 'name'],
            'triggerids'       => array_values($trigger_ids),
            'preservekeys'     => true
        ]));
        // Pull hostgroup names per host in one batch call.
        $host_ids = [];
        foreach ($triggers as $t) {
            foreach ($t['hosts'] ?? [] as $h) $host_ids[$h['hostid']] = true;
        }
        $hg_map = [];
        if ($host_ids) {
            $hosts = $this->safeGet(fn() => API::Host()->get([
                'output'           => ['hostid'],
                'selectHostGroups' => ['name'],
                'hostids'          => array_keys($host_ids),
                'preservekeys'     => true
            ]));
            foreach ($hosts as $hid => $h) {
                $hg_map[(string) $hid] = $h['hostgroups'] ?? [];
            }
        }
        $out = [];
        foreach ($triggers as $t) {
            $hosts = [];
            foreach ($t['hosts'] ?? [] as $h) {
                $h['hostgroups'] = $hg_map[(string) $h['hostid']] ?? [];
                $hosts[] = $h;
            }
            $out[(string) $t['triggerid']] = $hosts;
        }
        return $out;
    }

    private function fmtAge(int $s): string {
        if ($s < 60)    return $s.'s';
        if ($s < 3600)  return intdiv($s, 60).'m';
        if ($s < 86400) return sprintf('%dh %dm', intdiv($s, 3600), intdiv($s % 3600, 60));
        return sprintf('%dd %dh', intdiv($s, 86400), intdiv($s % 86400, 3600));
    }

    private function safeGet(callable $fn): array {
        try {
            $r = $fn();
            return is_array($r) ? $r : [];
        } catch (\Throwable $e) {
            error_log('[tcs] problems API call failed: '.$e->getMessage());
            return [];
        }
    }
}
