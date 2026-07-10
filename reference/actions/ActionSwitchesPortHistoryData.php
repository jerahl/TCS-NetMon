<?php declare(strict_types=1);

namespace Modules\TcsDashboard\Actions;

use API;
use CControllerResponseData;
use CControllerResponseFatal;

/**
 * GET zabbix.php?action=tcs.switches.port.history.data
 *      &hostid=NNN&member=N&port=N
 *
 * Returns the last 60 minutes of in/out traffic for a single switch port
 * as { inHist: [...60 floats], outHist: [...60 floats] } downsampled to one
 * value per minute. Fired by the bridge when the user clicks a port so the
 * detail panel's sparklines fill in lazily, instead of bloating the
 * snapshot with per-port history (192 ports × 2 items × 60 buckets).
 *
 * The (member, port) → itemid mapping is re-resolved per request: we walk
 * the host's net.if.in / net.if.out items, parse each key's SNMP ifIndex,
 * and pick the one whose derived (member, port) matches. Cheap because the
 * search is prefix-scoped to net.if.in[ / net.if.out[.
 */
class ActionSwitchesPortHistoryData extends ActionDataBase {

    /** Stack-member ceiling for sanity-checking ifIndex decoding. */
    private const STACK_LIMIT = 8;

    /** Sparkline window + buckets — keep in sync with the FLAT60 in the bridge. */
    private const WINDOW_SECONDS = 3600;
    private const BUCKETS        = 60;

    protected function checkInput(): bool {
        $ret = $this->validateInput([
            'hostid' => 'required|string',
            'member' => 'required|int32',
            'port'   => 'required|int32'
        ]);
        if (!$ret) {
            $this->setResponse(new CControllerResponseFatal());
        }
        return $ret;
    }

    protected function doAction(): void {
        $hostid = (string) $this->getInput('hostid');
        $member = (int)    $this->getInput('member');
        $port   = (int)    $this->getInput('port');

        $payload = [
            'inHist'  => array_fill(0, self::BUCKETS, 0.0),
            'outHist' => array_fill(0, self::BUCKETS, 0.0),
            'ts'      => time()
        ];

        try {
            [$inItem, $outItem] = $this->resolvePortItems($hostid, $member, $port);
            if ($inItem)  $payload['inHist']  = $this->bucketHistory($inItem);
            if ($outItem) $payload['outHist'] = $this->bucketHistory($outItem);
        }
        catch (\Throwable $e) {
            error_log('[tcs_dashboard] port.history.data: '.$e->getMessage());
        }

        $this->setResponse(new CControllerResponseData([
            'main_block' => json_encode($payload, JSON_UNESCAPED_SLASHES)
        ]));
    }

    /**
     * @return array{0:?array<string,mixed>, 1:?array<string,mixed>}
     */
    private function resolvePortItems(string $hostid, int $member, int $port): array {
        $items = API::Item()->get([
            'output'      => ['itemid', 'key_', 'value_type'],
            'hostids'     => [$hostid],
            'search'      => ['key_' => 'net.if.'],
            'startSearch' => true
        ]) ?: [];

        $inPrefixes  = ['net.if.in[ifHCInOctets.',  'net.if.in['];
        $outPrefixes = ['net.if.out[ifHCOutOctets.', 'net.if.out['];

        $inItem = null;
        $outItem = null;
        foreach ($items as $it) {
            $k = (string) $it['key_'];
            foreach ($inPrefixes as $p) {
                $idx = self::parseMemberPort($k, $p);
                if ($idx !== null && $idx[0] === $member && $idx[1] === $port) {
                    $inItem = $it;
                    break;
                }
            }
            foreach ($outPrefixes as $p) {
                $idx = self::parseMemberPort($k, $p);
                if ($idx !== null && $idx[0] === $member && $idx[1] === $port) {
                    $outItem = $it;
                    break;
                }
            }
            if ($inItem !== null && $outItem !== null) break;
        }
        return [$inItem, $outItem];
    }

    /**
     * Pull 60 minutes of history for one item, averaged into 60 one-minute
     * buckets. Returns bytes/sec values as-is — the bridge converts to kbps.
     *
     * @param array<string,mixed> $item
     * @return array<int, float>
     */
    private function bucketHistory(array $item): array {
        $vt = (int) $item['value_type'];
        if ($vt !== 0 && $vt !== 3) {
            return array_fill(0, self::BUCKETS, 0.0);
        }
        $now  = time();
        $from = $now - self::WINDOW_SECONDS;
        $bucketSec = (int) (self::WINDOW_SECONDS / self::BUCKETS);

        $rows = API::History()->get([
            'output'    => ['clock', 'value'],
            'history'   => $vt,
            'itemids'   => [$item['itemid']],
            'time_from' => $from,
            'sortfield' => 'clock',
            'sortorder' => 'ASC'
        ]) ?: [];

        $sum = array_fill(0, self::BUCKETS, 0.0);
        $cnt = array_fill(0, self::BUCKETS, 0);
        foreach ($rows as $r) {
            $i = (int) (((int) $r['clock'] - $from) / max(1, $bucketSec));
            if ($i < 0 || $i >= self::BUCKETS) continue;
            $sum[$i] += (float) $r['value'];
            $cnt[$i]++;
        }
        $series = [];
        for ($i = 0; $i < self::BUCKETS; $i++) {
            $series[] = $cnt[$i] > 0 ? round($sum[$i] / $cnt[$i], 2) : 0.0;
        }
        return $series;
    }

    /**
     * Same logic as SwitchClient::parseMemberPort — duplicated here to keep
     * the controller standalone. Accepts dotted "m.p" or bare SNMP ifIndex.
     *
     * @return array{0:int,1:int}|null
     */
    private static function parseMemberPort(string $key, string $prefix): ?array {
        if (!str_starts_with($key, $prefix)) return null;
        $rest = substr($key, strlen($prefix));
        $rest = rtrim($rest, ']');
        if (($cpos = strpos($rest, ',')) !== false) {
            $rest = substr($rest, 0, $cpos);
        }
        if (preg_match('/^(\d+)\.(\d+)$/', $rest, $m)) {
            return [(int) $m[1], (int) $m[2]];
        }
        if (preg_match('/^(\d+)$/', $rest, $m)) {
            $idx = (int) $m[1];
            if ($idx <= 0) return null;
            if ($idx < 1000) return [1, $idx];
            $member = intdiv($idx, 1000);
            $port   = $idx % 1000;
            if ($member < 1 || $member > self::STACK_LIMIT || $port <= 0) return null;
            return [$member, $port];
        }
        return null;
    }
}
