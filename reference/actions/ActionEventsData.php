<?php declare(strict_types=1);

namespace Modules\TcsDashboard\Actions;

use API;
use CControllerResponseData;
use CControllerResponseFatal;

/**
 * GET zabbix.php?action=tcs.events.data[&range=1h|6h|24h|7d]
 *
 * Returns a windowed event stream + derived aux arrays. Filtering happens
 * client-side per the Events Console design (search / sev / status /
 * source / site / group / tags) so this endpoint is range-only.
 */
class ActionEventsData extends ActionDataBase {

    private const RANGES = [
        '1h'  =>     3600,
        '6h'  =>  6 * 3600,
        '24h' => 24 * 3600,
        '7d'  =>  7 * 86400
    ];

    private const SEV_LABEL = [
        0 => 'info', 1 => 'info', 2 => 'warning',
        3 => 'warning', 4 => 'high', 5 => 'disaster'
    ];

    private const SITE_GROUP_PREFIX = 'Site/';

    protected function checkInput(): bool {
        $ret = $this->validateInput(['range' => 'string']);
        if (!$ret) {
            $this->setResponse(new CControllerResponseFatal());
        }
        return $ret;
    }

    protected function doAction(): void {
        $payload = $this->collect(['range' => $this->getInput('range', '24h')]);
        $this->setResponse(new CControllerResponseData(['main_block' => json_encode($payload)]));
    }

    public function collect(array $filters = []): array {
        $range = $filters['range'] ?? '24h';
        $now = time();

        // "open" — every currently-firing, unsuppressed problem regardless of
        // age. Sourced from API::Problem so the dashboard's health-map count
        // and the events console can finally agree on the same denominator.
        if ($range === 'open') {
            $payload = $this->collectOpen($now);
            $payload['range'] = $range;
            $payload['ts']    = $now;
            return $payload;
        }

        $window_secs = self::RANGES[$range] ?? self::RANGES['24h'];

        $raw = $this->safeGet(fn() => API::Event()->get([
            'output'      => ['eventid', 'objectid', 'name', 'severity', 'clock', 'value', 'acknowledged', 'r_eventid'],
            'source'      => EVENT_SOURCE_TRIGGERS,
            'object'      => EVENT_OBJECT_TRIGGER,
            'time_from'   => $now - $window_secs,
            'suppressed'  => false,
            'selectTags'  => ['tag', 'value'],
            'sortfield'   => ['eventid'],
            'sortorder'   => 'DESC',
            'limit'       => 1000
        ]));

        $trigger_ids   = array_unique(array_column($raw, 'objectid'));
        $trigger_hosts = $this->resolveTriggerHosts($trigger_ids);

        // Build events list (DESC, newest first — design expects this order).
        $rows = [];
        $events_by_trigger_asc = []; // for duration pairing
        foreach (array_reverse($raw) as $e) {
            $events_by_trigger_asc[$e['objectid']][] = $e;
        }
        // First pass: compute duration for resolution events.
        $durations = []; // eventid → seconds
        foreach ($events_by_trigger_asc as $tid => $list) {
            $open_clock = null;
            foreach ($list as $e) {
                if ((int) $e['value'] === TRIGGER_VALUE_TRUE) {
                    if ($open_clock === null) $open_clock = (int) $e['clock'];
                } else {
                    if ($open_clock !== null) {
                        $durations[$e['eventid']] = (int) $e['clock'] - $open_clock;
                        $open_clock = null;
                    }
                }
            }
        }
        // Mean time to resolve from same pairings.
        $mttr_secs = $durations ? (int) round(array_sum($durations) / count($durations)) : 0;

        foreach ($raw as $e) {
            $sev_int = (int) $e['severity'];
            $sev = self::SEV_LABEL[$sev_int] ?? 'info';
            $hosts = $trigger_hosts[$e['objectid']] ?? [];
            $h     = $hosts[0] ?? [];
            $host_label = $h['name'] ?? ($h['host'] ?? '—');
            $groups_all = array_map(fn($g) => $g['name'], $h['hostgroups'] ?? []);
            [$site, $group] = $this->splitGroups($groups_all);
            $is_firing    = (int) $e['value'] === TRIGGER_VALUE_TRUE;
            // A problem-start event (value=1) is still "open" only when no
            // recovery event has been recorded against it (r_eventid is 0).
            $has_recovery = !empty($e['r_eventid']) && (int) $e['r_eventid'] !== 0;
            $ack          = (int) $e['acknowledged'] === 1;
            $status       = (!$is_firing || $has_recovery)
                ? 'resolved'
                : ($ack ? 'ack' : 'open');
            $clock     = (int) $e['clock'];

            $tags = [];
            foreach ($e['tags'] ?? [] as $t) {
                $val = $t['value'] ?? '';
                $tags[] = $val === '' ? $t['tag'] : ($t['tag'].':'.$val);
            }

            $duration_secs = $durations[$e['eventid']] ?? null;

            $rows[] = [
                'id'       => $e['eventid'],
                'sev'      => $is_firing ? $sev : 'ok',
                'rawSev'   => $sev,
                'status'   => $status,
                'ts'       => date('H:i', $clock),
                'tsFull'   => date('Y-m-d H:i:s', $clock),
                'clock'    => $clock,
                'age'      => $this->fmtAge(max(0, $now - $clock)),
                'source'   => 'zbx',
                'host'     => $host_label,
                'hostid'   => $h['hostid'] ?? '',
                'site'     => $site,
                'group'    => $group,
                'trigger'  => $e['name'],
                'tags'     => $tags,
                'owner'    => '',
                'count'    => 1,
                'duration' => $duration_secs !== null ? $this->fmtAge($duration_secs) : '—'
            ];
        }

        return [
            'events'     => $rows,
            'timeline'   => $this->buildStackedTimeline($rows, $window_secs),
            'sites'      => $this->uniqueSorted(array_column($rows, 'site')),
            'hostgroups' => $this->uniqueSorted(array_column($rows, 'group')),
            'tags'       => $this->uniqueSorted(array_merge(...array_map(fn($r) => $r['tags'], $rows ?: [[]]))),
            'savedViews' => $this->savedViews($rows),
            'metrics'    => [
                'open'    => count(array_filter($rows, fn($r) => $r['status'] === 'open')),
                'ack'     => count(array_filter($rows, fn($r) => $r['status'] === 'ack')),
                'mttaStr' => '—',  // requires selectAcknowledges; skipped for v1
                'mttrStr' => $this->fmtAge($mttr_secs),
                'mttrSec' => $mttr_secs
            ],
            'range'      => $range,
            'ts'         => $now
        ];
    }

    /**
     * "All open" path: walks API::Problem so we don't drop problems older
     * than the largest event-window range. Only firing rows are emitted —
     * resolution counterparts have no meaning here. MTTR/MTTA are blanked
     * because the unresolved set has no duration.
     */
    private function collectOpen(int $now): array {
        // High explicit limit so the Problems page (which boots via this
        // "open" path) shows the complete set of currently-firing
        // problems, not just the newest 1000. Operators rely on this list
        // as the master triage view — truncation silently hides work.
        $problems = $this->safeGet(fn() => API::Problem()->get([
            'output'     => ['eventid', 'objectid', 'name', 'severity', 'clock', 'acknowledged', 'r_eventid'],
            'source'     => EVENT_SOURCE_TRIGGERS,
            'object'     => EVENT_OBJECT_TRIGGER,
            'recent'     => false,
            'suppressed' => false,
            'selectTags' => ['tag', 'value'],
            'sortfield'  => ['eventid'],
            'sortorder'  => 'DESC',
            'limit'      => 10000
        ]));
        $problems = array_values(array_filter(
            $problems,
            fn($p) => empty($p['r_eventid']) || (int) $p['r_eventid'] === 0
        ));

        // Drop problems whose underlying trigger has been disabled. Zabbix
        // does not fire a recovery event when a trigger is disabled, so the
        // problem row keeps showing up with r_eventid=0 indefinitely even
        // though it is effectively dead.
        $trigger_ids = array_unique(array_column($problems, 'objectid'));
        if ($trigger_ids) {
            $enabled_triggers = $this->safeGet(fn() => API::Trigger()->get([
                'output'       => ['triggerid'],
                'triggerids'   => array_values($trigger_ids),
                'filter'       => ['status' => 0],
                'preservekeys' => true
            ]));
            $problems = array_values(array_filter(
                $problems,
                fn($p) => isset($enabled_triggers[(string) $p['objectid']])
            ));
        }

        $trigger_ids   = array_unique(array_column($problems, 'objectid'));
        $trigger_hosts = $this->resolveTriggerHosts($trigger_ids);

        $rows = [];
        foreach ($problems as $p) {
            $sev_int = (int) $p['severity'];
            $sev = self::SEV_LABEL[$sev_int] ?? 'info';
            $hosts = $trigger_hosts[$p['objectid']] ?? [];
            $h     = $hosts[0] ?? [];
            $host_label = $h['name'] ?? ($h['host'] ?? '—');
            $groups_all = array_map(fn($g) => $g['name'], $h['hostgroups'] ?? []);
            [$site, $group] = $this->splitGroups($groups_all);
            $ack    = (int) $p['acknowledged'] === 1;
            $clock  = (int) $p['clock'];

            $tags = [];
            foreach ($p['tags'] ?? [] as $t) {
                $val = $t['value'] ?? '';
                $tags[] = $val === '' ? $t['tag'] : ($t['tag'].':'.$val);
            }

            $rows[] = [
                'id'       => $p['eventid'],
                'sev'      => $sev,
                'rawSev'   => $sev,
                'status'   => $ack ? 'ack' : 'open',
                'ts'       => date('H:i', $clock),
                'tsFull'   => date('Y-m-d H:i:s', $clock),
                'clock'    => $clock,
                'age'      => $this->fmtAge(max(0, $now - $clock)),
                'source'   => 'zbx',
                'host'     => $host_label,
                'hostid'   => $h['hostid'] ?? '',
                'site'     => $site,
                'group'    => $group,
                'trigger'  => $p['name'],
                'tags'     => $tags,
                'owner'    => '',
                'count'    => 1,
                'duration' => $this->fmtAge(max(0, $now - $clock))
            ];
        }

        return [
            'events'     => $rows,
            // Histogram + saved-view counts still operate on these rows. The
            // timeline buckets across the oldest-to-newest span so spikes are
            // visible at any age.
            'timeline'   => $this->buildOpenTimeline($rows, $now),
            'sites'      => $this->uniqueSorted(array_column($rows, 'site')),
            'hostgroups' => $this->uniqueSorted(array_column($rows, 'group')),
            'tags'       => $this->uniqueSorted(array_merge(...array_map(fn($r) => $r['tags'], $rows ?: [[]]))),
            'savedViews' => $this->savedViews($rows),
            'metrics'    => [
                'open'    => count(array_filter($rows, fn($r) => $r['status'] === 'open')),
                'ack'     => count(array_filter($rows, fn($r) => $r['status'] === 'ack')),
                'mttaStr' => '—',
                'mttrStr' => '—',
                'mttrSec' => 0
            ]
        ];
    }

    /** Histogram for the "open" view: 24 buckets spanning oldest→now. */
    private function buildOpenTimeline(array $rows, int $now): array {
        $buckets = [];
        for ($i = 0; $i < 24; $i++) $buckets[$i] = [0, 0, 0, 0];
        if (!$rows) return $buckets;
        $oldest = min(array_column($rows, 'clock'));
        $span   = max(1, $now - $oldest);
        $bucket_secs = max(1, intdiv($span, 24));
        foreach ($rows as $r) {
            $b = intdiv($r['clock'] - $oldest, $bucket_secs);
            if ($b < 0)  $b = 0;
            if ($b > 23) $b = 23;
            $idx = match ($r['rawSev']) {
                'disaster' => 0,
                'high'     => 1,
                'warning'  => 2,
                default    => 3
            };
            $buckets[$b][$idx]++;
        }
        return array_values($buckets);
    }

    /** 24 buckets, each is [disaster, high, warning, info] counts. */
    private function buildStackedTimeline(array $rows, int $window_secs): array {
        $buckets = [];
        for ($i = 0; $i < 24; $i++) $buckets[$i] = [0, 0, 0, 0];
        $start = time() - $window_secs;
        $bucket_secs = max(1, intdiv($window_secs, 24));
        foreach ($rows as $r) {
            if ($r['status'] === 'resolved') continue;
            $b = intdiv($r['clock'] - $start, $bucket_secs);
            if ($b < 0 || $b >= 24) continue;
            $idx = match ($r['rawSev']) {
                'disaster' => 0,
                'high'     => 1,
                'warning'  => 2,
                default    => 3
            };
            $buckets[$b][$idx]++;
        }
        return array_values($buckets);
    }

    /** Static-ish saved-view set, with live row counts. */
    private function savedViews(array $rows): array {
        $views = [
            ['id' => 'v1', 'name' => 'Disaster + High open',  'system' => false,
             'fn'  => fn($e) => in_array($e['rawSev'], ['disaster', 'high'], true) && $e['status'] !== 'resolved'],
            ['id' => 'v2', 'name' => 'Open / unack',          'system' => false,
             'fn'  => fn($e) => $e['status'] === 'open'],
            ['id' => 'v3', 'name' => 'Acknowledged',          'system' => false,
             'fn'  => fn($e) => $e['status'] === 'ack'],
            ['id' => 'v4', 'name' => 'Resolved · 24h',        'system' => true,
             'fn'  => fn($e) => $e['status'] === 'resolved'],
            ['id' => 'v5', 'name' => 'Warning only',          'system' => true,
             'fn'  => fn($e) => $e['rawSev'] === 'warning' && $e['status'] !== 'resolved']
        ];
        $out = [];
        foreach ($views as $v) {
            $count = 0;
            foreach ($rows as $r) if (($v['fn'])($r)) $count++;
            unset($v['fn']);
            $v['count'] = $count;
            $out[] = $v;
        }
        return $out;
    }

    private function splitGroups(array $groups): array {
        $site = '—';
        $hg   = '—';
        foreach ($groups as $g) {
            if (str_starts_with($g, self::SITE_GROUP_PREFIX)) {
                $site = substr($g, strlen(self::SITE_GROUP_PREFIX));
            } elseif ($hg === '—') {
                $hg = $g;
            }
        }
        return [$site, $hg];
    }

    private function uniqueSorted(array $values): array {
        $values = array_values(array_unique(array_filter($values, fn($v) => $v !== '' && $v !== '—')));
        sort($values);
        return $values;
    }

    private function resolveTriggerHosts(array $trigger_ids): array {
        if (!$trigger_ids) return [];
        $triggers = $this->safeGet(fn() => API::Trigger()->get([
            'output'       => ['triggerid'],
            'selectHosts'  => ['hostid', 'host', 'name'],
            'triggerids'   => array_values($trigger_ids),
            'preservekeys' => true
        ]));
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
        if ($s <= 0)    return '—';
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
            error_log('[tcs] events API call failed: '.$e->getMessage());
            return [];
        }
    }
}
