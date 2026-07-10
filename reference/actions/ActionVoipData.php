<?php declare(strict_types=1);

namespace Modules\TcsDashboard\Actions;

use API;
use CControllerResponseData;
use Modules\TcsDashboard\Lib\ThreeCXClient;

/**
 * GET zabbix.php?action=tcs.voip.data
 *
 * 30-second rollup for the VoIP / 3CX dashboard. The 3CX XAPI is the
 * authoritative source for almost every slot (PBX header, services,
 * trunks, queues, top extensions, per-extension grid, call-quality
 * history); Zabbix supplies the 24h active-calls history (via
 * history.get on the template's calls-active item) and the host
 * problems list.
 *
 * The live active-calls list is served by a separate action
 * (tcs.voip.calls.data) so the bridge can poll it on a tighter cadence
 * without re-doing the full rollup every 5s.
 */
class ActionVoipData extends ActionDataBase {

    private const CACHE_TTL = 30;
    private const CACHE_KEY = 'tcs_dashboard:voip:v1';

    /** Template name the 3CX host is expected to use. */
    private const TEMPLATE_NAME = '3CX Phone System by HTTP';

    /** Override macro for primary host selection. */
    private const HOST_MACRO = '{$TCS.VOIP.HOST}';

    /** Substrings (lowercased) we try to spot the "active calls" item by. */
    private const ACTIVE_CALLS_KEY_HINTS = ['active.calls', 'activecalls', 'calls.active', 'callsactive'];

    protected function checkInput(): bool {
        return $this->validateInput(['debug' => 'in 0,1']);
    }

    protected function doAction(): void {
        // Release the session lock early — the page now fires four parallel
        // tcs.voip.* fetches and PHP would otherwise serialise them all
        // behind the per-session file lock. Same trick the camera snapshot
        // action uses.
        if (function_exists('session_write_close')) {
            session_write_close();
        }
        $payload = self::emptyPayload();
        $debug   = (int) $this->getInput('debug', 0) === 1;

        try {
            // Debug bypasses the cache so the operator always sees fresh raw rows.
            $cached = $debug ? null : self::cacheGet();
            if ($cached !== null) {
                $payload = $cached;
            } else {
                $payload = self::buildPayload($debug);
                // Don't pin a broken rollup in APCu for 30 s — operators
                // re-poll-to-debug will just hit the same stale failure.
                $cxOk  = ($payload['sources']['3cx'] ?? '') === 'live' || ($payload['sources']['3cx'] ?? '') === 'partial';
                $zbxOk = ($payload['sources']['zbx'] ?? '') === 'live';
                if (!$debug && ($cxOk || $zbxOk)) {
                    self::cacheSet($payload);
                }
            }
        } catch (\Throwable $e) {
            error_log('[tcs_dashboard] voip.data: ' . $e->getMessage());
            $payload['error']           = 'VoIP data query failed: ' . $e->getMessage();
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
            'loading'  => true,
            'pbx'      => null,
            'trunks'   => null,
            'sbcs'     => null,
            'calls'    => null,
            'top'      => null,
            'queues'   => null,
            'quality'  => null,
            'problems' => null,
            'sources'  => ['zbx' => 'unknown', '3cx' => 'unknown'],
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

    private static function buildPayload(bool $debug = false): array {
        $payload = self::emptyPayload();
        $rawSamples = [];

        // 1. Resolve the 3CX host (template match + optional macro override).
        //    Used for the problems list and history.get even when XAPI is the
        //    primary data source.
        $host = self::findVoipHost();

        // 2. Instantiate the XAPI client if macros are present. Each call is
        //    individually try/wrapped so a single XAPI failure only blanks
        //    its own slot — the rest of the rollup still ships.
        $cfg    = self::voipMacros();
        $client = null;
        if ($cfg['url'] !== '' && $cfg['client_id'] !== '' && $cfg['client_secret'] !== '') {
            $client = ThreeCXClient::fromMacros($cfg);
        } else {
            $payload['sources']['3cx'] = 'unconfigured';
            $payload['warning']        = '3CX XAPI macros not set ({$TCS.3CX.URL} / .CLIENT_ID / .CLIENT_SECRET).';
        }

        $xapiOk = 0;
        $xapiFail = 0;
        $errors   = [];   // first-failure-wins, per-endpoint, surfaced to UI

        $runXapi = static function (string $label, callable $fn, bool $critical = true) use (&$xapiOk, &$xapiFail, &$errors, $debug) {
            try { $fn(); $xapiOk++; }
            catch (\Throwable $e) {
                if ($critical) $xapiFail++;
                $msg = sprintf('%s: %s', $label, $e->getMessage());
                error_log('[tcs_dashboard] voip ' . $msg);
                // Non-critical endpoints (the report-style ones) walk a
                // candidate path list; on full failure they 404 — that's
                // expected on 3CX builds without those reports, so don't
                // pollute the operator-visible warning unless we're in
                // explicit debug mode.
                if ($critical || $debug) $errors[$label] = $e->getMessage();
            }
        };

        // 2a. SystemStatus → pbx header + services
        if ($client) {
            $runXapi('SystemStatus', function () use ($client, &$payload, $host, $debug, &$rawSamples) {
                $s = $client->systemStatus();
                if ($debug) $rawSamples['SystemStatus'] = $s;
                $payload['pbx'] = self::mapPbx($s, $host);
            });
            // 2b. Trunks
            $runXapi('Trunks', function () use ($client, &$payload, $debug, &$rawSamples) {
                $rows = $client->trunks();
                if ($debug) $rawSamples['Trunks'] = array_slice($rows, 0, 2);
                $payload['trunks'] = self::mapTrunks($rows);
            });
            // 2b'. SBCs — remote session border controllers w/ live link metrics.
            $runXapi('Sbcs', function () use ($client, &$payload, $debug, &$rawSamples) {
                $rows = $client->sbcs();
                if ($debug) $rawSamples['Sbcs'] = array_slice($rows, 0, 2);
                $payload['sbcs'] = self::mapSbcs($rows);
            });
            // 2c. Queues + per-queue performance
            $runXapi('Queues', function () use ($client, &$payload, $debug, &$rawSamples) {
                if ($debug) {
                    try { $rawSamples['Queues'] = array_slice($client->queues(), 0, 2); } catch (\Throwable $_) {}
                }
                $payload['queues'] = $client->queuesWithPerformance();
            });
            // 2f. Call quality — non-critical; v20 has no pre-bucketed endpoint.
            $runXapi('Quality', function () use ($client, &$payload) {
                $payload['quality'] = self::mapCallQuality($client->callQuality('30m'));
            }, false);
            // NOTE: TopExt is served by its own action (tcs.voip.top.data)
            // so the report-endpoint call doesn't block this fast core
            // rollup. The bridge fires it in parallel with this one.
        }
        if ($debug) $payload['xapi_raw'] = $rawSamples;

        if ($client) {
            if ($xapiOk > 0 && $xapiFail === 0)      $payload['sources']['3cx'] = 'live';
            elseif ($xapiOk > 0)                     $payload['sources']['3cx'] = 'partial';
            else                                     $payload['sources']['3cx'] = 'error';
            if ($errors) {
                // Surface the first failure verbatim so it's visible in the
                // network response without having to grep PHP error logs.
                $first = array_key_first($errors);
                $payload['warning'] = sprintf('3CX %s call failed: %s', $first, $errors[$first]);
                $payload['xapi_errors'] = $errors;
                $payload['xapi_url']    = $cfg['url'];
                $payload['xapi_verify'] = $cfg['verify_ssl'];
            }
        }

        // 3. Zabbix-side: 24h calls-active history → pbx.history.concur
        if ($host) {
            try {
                $hist = self::buildCallsHistory((string) $host['hostid']);
                if ($hist) {
                    $payload['pbx'] = self::ensurePbx($payload['pbx'], $host);
                    $payload['pbx']['history'] = $hist;
                }
            } catch (\Throwable $e) {
                error_log('[tcs_dashboard] voip history: ' . $e->getMessage());
            }
        }

        // 4. Problems list — always from Zabbix
        if ($host) {
            $payload['problems'] = self::buildProblems((string) $host['hostid'], (string) ($host['name'] ?: $host['host']));
        }

        $payload['sources']['zbx'] = $host ? 'live' : 'empty';
        $payload['loading']        = false;
        if ($host) {
            $payload['zbx_host'] = [
                'hostid' => (string) $host['hostid'],
                'host'   => (string) ($host['host'] ?? ''),
                'name'   => (string) ($host['name'] ?? ''),
            ];
        }

        if (!$host && !$client) {
            $payload['warning'] = $payload['warning']
                ?? 'No 3CX host in Zabbix and no XAPI macros set — page is rendering mock data.';
        }
        return $payload;
    }

    // ── XAPI → JSX shape mappers ───────────────────────────────────────────

    /** @param array<string,mixed> $s SystemStatus payload */
    private static function mapPbx(array $s, ?array $host): array {
        $fqdn    = self::pick($s, ['FQDN', 'Fqdn', 'fqdn'], '—');
        $version = self::pick($s, ['Version', 'version'], '—');
        // 3CX v20 doesn't ship a license-edition string; ProductCode is the
        // closest analogue (e.g. "3CXPSPROFENTSPLA" → "PROFENT SPLA").
        $edition = self::pick($s, ['LicenseEdition', 'Edition', 'License', 'ProductCode'], '—');
        $maxSim  = (int) self::pick($s, ['MaxSimCalls', 'MaximumSimultaneousCalls', 'SimultaneousCalls'], 0);
        $active  = (int) self::pick($s, ['CallsActive', 'ActiveCalls', 'CurrentCalls'], 0);
        $extReg  = (int) self::pick($s, ['ExtensionsRegistered', 'RegisteredExtensions'], 0);
        $extTot  = (int) self::pick($s, ['ExtensionsTotal', 'TotalExtensions', 'Extensions'], 0);
        $uptimeS = (int) self::pick($s, ['Uptime', 'UptimeSeconds', 'SystemUptime'], 0);
        $trunksReg   = (int) self::pick($s, ['TrunksRegistered'], 0);
        $trunksTotal = (int) self::pick($s, ['TrunksTotal'], 0);

        // Prefer 3CX-reported IP, fall back to the Zabbix host interface.
        $pbxIp = (string) self::pick($s, ['CurrentLocalIp', 'IpV4', 'Ip'], '');

        // Calls today: SystemStatus rarely carries this on every build; the
        // template item is more reliable but we don't have it here. Default
        // to 0 and let CallHistoryView fill it on a future iteration.
        $callsToday    = (int) self::pick($s, ['CallHistoryCount', 'TotalCallsToday'], 0);
        $callsInbound  = (int) self::pick($s, ['CallsInbound',  'InboundCallsToday'],  0);
        $callsOutbound = (int) self::pick($s, ['CallsOutbound', 'OutboundCallsToday'], 0);
        $callsInternal = max(0, $callsToday - $callsInbound - $callsOutbound);

        $ip = $pbxIp !== '' ? $pbxIp : '—';
        if ($ip === '—' && $host) {
            foreach (($host['interfaces'] ?? []) as $iface) {
                if ((int) ($iface['main'] ?? 0) === 1) { $ip = (string) ($iface['ip'] ?? '—'); break; }
            }
            if ($ip === '—' && !empty($host['interfaces'])) {
                $ip = (string) ($host['interfaces'][0]['ip'] ?? '—');
            }
        }

        return [
            'fqdn'          => (string) $fqdn,
            'ip'            => $ip,
            'version'       => (string) $version,
            'edition'       => (string) $edition,
            'uptime'        => $uptimeS > 0 ? self::formatUptime($uptimeS) : '—',
            'region'        => (string) ($host['inventory']['location'] ?? '—'),
            'activeNow'     => $active,
            'capacity'      => $maxSim,
            'peakToday'     => $active,
            'callsToday'    => $callsToday,
            'callsInbound'  => $callsInbound,
            'callsOutbound' => $callsOutbound,
            'callsInternal' => $callsInternal,
            'registeredExt' => $extReg,
            'totalExt'      => $extTot,
            'trunksReg'     => $trunksReg,
            'trunksTotal'   => $trunksTotal,
            'avgMos'        => (float) self::pick($s, ['AverageMos', 'AvgMos', 'Mos'], 0),
            'asr'           => (float) self::pick($s, ['Asr', 'AnswerSeizureRatio'], 0),
            'acd'           => (string) self::pick($s, ['Acd', 'AverageCallDuration'], '—'),
            // History gets filled in by buildCallsHistory(); shipping zeroed arrays
            // so the chart doesn't crash if Zabbix has no history yet.
            'history'       => [
                'concur'   => array_fill(0, 96, 0),
                'inbound'  => array_fill(0, 96, 0),
                'outbound' => array_fill(0, 96, 0),
            ],
        ];
    }

/**
     * /xapi/v1/Trunks rows → VOIP_TRUNKS shape.
     *
     * 3CX v20 shape (confirmed against tusck12 with ?debug=1):
     *   {
     *     Number, AuthID, IsOnline (bool), Direction,
     *     SimultaneousCalls, DidNumbers: [..],
     *     Tags: [..],
     *     Gateway: {
     *       Name, Host, ProxyHost, Port, Type ("Provider" / "BridgeMaster" /
     *       "Gateway"), TemplateFilename ("asterisk.pv.xml" → carrier hint),
     *       Codecs: [..], ...
     *     },
     *     TrunkRegTimes: [{Name:"sent_time"|"ok_time"|"failed_time"|"fail_code", Value}],
     *   }
     *
     * Display name preference: Gateway.Name → AuthID → "Trunk <Number>".
     * Registration: IsOnline true === "reg", false === "unreg". 3CX
     * surfaces "degraded" via TrunkRegTimes.fail_code being set while
     * IsOnline is still true.
     */
    private static function mapTrunks(array $rows): array {
        $out = [];
        foreach ($rows as $t) {
            if (!is_array($t)) continue;

            $gw     = is_array($t['Gateway'] ?? null) ? $t['Gateway'] : [];
            $number = (string) ($t['Number'] ?? '');
            $authId = (string) ($t['AuthID'] ?? '');

            $name = (string) ($gw['Name'] ?? '');
            if ($name === '') $name = $authId !== '' ? $authId : ($number !== '' ? 'Trunk ' . $number : 'trunk');

            $isOnline = (bool) ($t['IsOnline'] ?? false);

            // TrunkRegTimes carries the most recent failure reason; if
            // fail_code is set and the trunk is still considered online,
            // mark it degraded so the operator sees it.
            $failCode = '';
            foreach (($t['TrunkRegTimes'] ?? []) as $rt) {
                if (is_array($rt) && ($rt['Name'] ?? '') === 'fail_code') {
                    $failCode = (string) ($rt['Value'] ?? '');
                    break;
                }
            }
            $status = $isOnline ? ($failCode !== '' ? 'dgr' : 'reg') : 'unreg';

            $host = (string) ($gw['Host'] ?? '');
            $port = (int)    ($gw['Port'] ?? 0);
            if ($host !== '' && $port > 0) $host .= ':' . $port;
            elseif ($host === '') $host = (string) ($gw['ProxyHost'] ?? '');

            // Provider: 3CX doesn't carry a carrier name directly. Best we
            // can do is the Gateway.Type ("Provider" / "BridgeMaster" /
            // "Gateway") + the TemplateFilename when set (e.g. "twilio.xml",
            // "asterisk.pv.xml" → strip the .xml).
            $provider = (string) ($gw['Type'] ?? '');
            $tmpl     = (string) ($gw['TemplateFilename'] ?? '');
            if ($tmpl !== '') {
                $provider = preg_replace('/\.xml$/i', '', $tmpl) ?: $provider;
            }

            // DID: prefer DidNumbers[0] (the public-facing number), fall
            // back to Number (the extension/peer id).
            $did = '';
            if (!empty($t['DidNumbers']) && is_array($t['DidNumbers'])) {
                $did = (string) ($t['DidNumbers'][0] ?? '');
            }
            if ($did === '') $did = $number;

            $out[] = [
                'name'     => $name,
                'provider' => $provider,
                'host'     => $host,
                'status'   => $status,
                'chTotal'  => (int) ($t['SimultaneousCalls'] ?? 0),
                'chIn'     => 0,    // not in /Trunks; would need /ActiveCalls aggregation
                'chOut'    => 0,
                'asr'      => 0.0,  // not in /Trunks; comes from CallHistoryView reports
                'mos'      => 0.0,
                'errors'   => $failCode !== '' ? 1 : 0,
                'did'      => $did,
            ];
        }
        return $out;
    }

    /**
     * /xapi/v1/Sbcs rows → VOIP_SBCS shape.
     *
     * PbxSbc:
     *   { Name, DisplayName, Group, Version, LocalIPv4, PublicIP,
     *     HasConnection, Connection: { Up, Calls, RegisteredPhones,
     *     Latency, Cpu, Memory, Disk, ElapsedTime, UdpActive } }
     *
     * Cpu / Memory / Disk come back as strings — usually a percentage
     * ("17%") or "n/a" when the SBC isn't reporting. We pass them through
     * verbatim and let the JSX render them as-is.
     */
    private static function mapSbcs(array $rows): array {
        $out = [];
        foreach ($rows as $s) {
            if (!is_array($s)) continue;
            $conn = is_array($s['Connection'] ?? null) ? $s['Connection'] : [];
            $hasConn = (bool) ($s['HasConnection'] ?? false);
            $up      = (bool) ($conn['Up'] ?? false);

            $out[] = [
                'name'       => (string) ($s['DisplayName'] ?? $s['Name'] ?? 'SBC'),
                'id'         => (string) ($s['Name'] ?? ''),
                'group'      => (string) ($s['Group']     ?? ''),
                'version'    => (string) ($s['Version']   ?? ''),
                'localIp'    => (string) ($s['LocalIPv4'] ?? ''),
                'publicIp'   => (string) ($s['PublicIP']  ?? ''),
                'up'         => $up && $hasConn,
                'hasConn'    => $hasConn,
                'calls'      => (int)    ($conn['Calls']             ?? 0),
                'phones'     => (int)    ($conn['RegisteredPhones']  ?? 0),
                'latency'    => (int)    ($conn['Latency']           ?? 0),
                'cpu'        => (string) ($conn['Cpu']               ?? ''),
                'memory'     => (string) ($conn['Memory']            ?? ''),
                'disk'       => (string) ($conn['Disk']              ?? ''),
                'uptime'     => (string) ($conn['ElapsedTime']       ?? ''),
                'udpActive'  => (bool)   ($conn['UdpActive']         ?? false),
            ];
        }
        // Down SBCs first so the operator sees outages without scrolling.
        usort($out, function ($a, $b) {
            if ($a['up'] !== $b['up']) return $a['up'] ? 1 : -1;
            return strcmp($a['name'], $b['name']);
        });
        return $out;
    }

    /**
     * /ReportExtensionStatistics/Pbx.GetExtensionStatisticsData rows → VOIP_TOP.
     *
     * Real PbxExtensionStatistics shape (v20):
     *   { DisplayName, Dn, InboundAnsweredCount, InboundUnansweredCount,
     *     OutboundAnsweredCount, OutboundUnansweredCount,
     *     InboundAnsweredTalkingDur, OutboundAnsweredTalkingDur }
     * Talk-durations are ISO 8601 "HH:MM:SS" strings.
     *
     * "Top by calls" = sum of all four count fields. We re-sort because
     * 3CX's $top happens before our derived total.
     */
    /** Re-export for ActionVoipTopData, which lives in a sibling file. */
    public static function mapTopExtensionsPublic(array $rows): array { return self::mapTopExtensions($rows); }

    private static function mapTopExtensions(array $rows): array {
        $out = [];
        foreach ($rows as $r) {
            if (!is_array($r)) continue;
            $calls = (int) ($r['InboundAnsweredCount']   ?? 0)
                   + (int) ($r['InboundUnansweredCount'] ?? 0)
                   + (int) ($r['OutboundAnsweredCount']  ?? 0)
                   + (int) ($r['OutboundUnansweredCount']?? 0);
            $mins  = self::durationToMinutes($r['InboundAnsweredTalkingDur']  ?? 0)
                   + self::durationToMinutes($r['OutboundAnsweredTalkingDur'] ?? 0);

            $out[] = [
                'ext'   => (string) ($r['Dn'] ?? ''),
                'name'  => (string) ($r['DisplayName'] ?? '—'),
                'site'  => '',
                'calls' => $calls,
                'mins'  => $mins,
                'role'  => '',
            ];
        }
        usort($out, fn($a, $b) => $b['calls'] <=> $a['calls']);
        return $out;
    }

    /** /xapi/v1/Defs/CallQualityStatistics → VOIP_QUALITY shape. */
    private static function mapCallQuality(array $resp): array {
        // The endpoint returns either `{ value: [...] }` or a flat bucketed
        // object. Handle both: try value[] first, then named arrays.
        $rows = $resp['value'] ?? null;
        $mos = []; $jitter = []; $loss = []; $rtt = [];
        if (is_array($rows)) {
            foreach ($rows as $r) {
                if (!is_array($r)) continue;
                $mos[]    = (float) self::pick($r, ['Mos', 'MOS', 'AvgMos'], 0);
                $jitter[] = (float) self::pick($r, ['Jitter', 'AvgJitter'], 0);
                $loss[]   = (float) self::pick($r, ['PacketLoss', 'Loss'], 0);
                $rtt[]    = (float) self::pick($r, ['RoundTripTime', 'RTT', 'Rtt'], 0);
            }
        } else {
            $mos    = self::asFloatList($resp['Mos']        ?? $resp['MosHistory']    ?? []);
            $jitter = self::asFloatList($resp['Jitter']     ?? $resp['JitterHistory'] ?? []);
            $loss   = self::asFloatList($resp['PacketLoss'] ?? $resp['LossHistory']   ?? []);
            $rtt    = self::asFloatList($resp['RTT']        ?? $resp['RttHistory']    ?? []);
        }
        // Pad to 48 buckets so the JSX sparklines line up with the chart axis.
        return [
            'mos'    => self::padArray($mos,    48),
            'jitter' => self::padArray($jitter, 48),
            'loss'   => self::padArray($loss,   48),
            'rtt'    => self::padArray($rtt,    48),
        ];
    }

    /**
     * Build the 24h concurrent-calls history from Zabbix history.get.
     * Looks for the template's active-calls item (key contains one of the
     * ACTIVE_CALLS_KEY_HINTS substrings), then bins values into 96
     * 15-minute buckets.
     *
     * @return array{concur:array<int,int>,inbound:array<int,int>,outbound:array<int,int>}|null
     */
    private static function buildCallsHistory(string $hostid): ?array {
        $items = API::Item()->get([
            'output'       => ['itemid', 'key_', 'value_type'],
            'hostids'      => [$hostid],
            'monitored'    => true,
            'webitems'     => true,
        ]) ?: [];
        if (!$items) return null;

        $itemId    = null;
        $valueType = 3;
        foreach ($items as $it) {
            $k = strtolower((string) $it['key_']);
            foreach (self::ACTIVE_CALLS_KEY_HINTS as $hint) {
                if (str_contains($k, $hint)) {
                    $itemId    = (string) $it['itemid'];
                    $valueType = (int) $it['value_type'];
                    break 2;
                }
            }
        }
        if ($itemId === null) return null;

        $now  = time();
        $from = $now - 24 * 3600;
        $rows = API::History()->get([
            'output'    => ['clock', 'value'],
            'itemids'   => [$itemId],
            'history'   => $valueType,
            'time_from' => $from,
            'time_till' => $now,
            'sortfield' => 'clock',
            'sortorder' => 'ASC',
            'limit'     => 10000,
        ]) ?: [];
        if (!$rows) return null;

        // Bucket into 96 × 15-minute slots, taking the max in each (we want peak
        // concurrency per bucket, not average).
        $buckets = array_fill(0, 96, 0);
        foreach ($rows as $r) {
            $delta = (int) $r['clock'] - $from;
            $i     = (int) floor($delta / 900);
            if ($i < 0 || $i > 95) continue;
            $v = (int) $r['value'];
            if ($v > $buckets[$i]) $buckets[$i] = $v;
        }

        // Inbound/outbound split isn't exposed by the template — approximate
        // 60/40 so the stacked area chart still reads correctly. Replace
        // with real item data when the template grows separate keys.
        $inbound  = array_map(fn($v) => (int) round($v * 0.6), $buckets);
        $outbound = array_map(fn($v, $in) => max(0, $v - $in), $buckets, $inbound);
        return ['concur' => $buckets, 'inbound' => $inbound, 'outbound' => $outbound];
    }

    /**
     * Recent events stream — host problems from the 3CX host in the last 24h,
     * severity-mapped.
     * @return list<array<string,mixed>>
     */
    private static function buildProblems(string $hostid, string $hostname): array {
        $problems = API::Problem()->get([
            'output'    => ['eventid', 'name', 'severity', 'clock', 'acknowledged'],
            'hostids'   => [$hostid],
            'recent'    => true,
            'time_from' => time() - 24 * 3600,
            'sortfield' => ['eventid'],
            'sortorder' => 'DESC',
            'limit'     => 50,
        ]) ?: [];
        $now = time();
        $rows = [];
        foreach ($problems as $p) {
            $ts = (int) $p['clock'];
            $rows[] = [
                'ts'   => date('H:i:s', $ts),
                'sev'  => self::zabbixSevToLabel((int) $p['severity']),
                'host' => $hostname,
                'trig' => (string) $p['name'],
                'age'  => self::ago($now - $ts),
                'ack'  => ((int) ($p['acknowledged'] ?? 0)) === 1,
            ];
            if (count($rows) >= 12) break;
        }
        return $rows;
    }

    // ── Host discovery ─────────────────────────────────────────────────────

    /**
     * Resolve which Zabbix host backs the VoIP dashboard.
     *
     * Resolution order:
     *   1. {$TCS.VOIP.HOST} global macro — authoritative when set. Matches by
     *      technical name ("host"), visible name, or hostid. No template
     *      requirement, so operators can point the page at any monitored
     *      host (a custom 3CX template, the OS host the PBX runs on, etc.)
     *      and still get history + problems out of Zabbix.
     *   2. First host using the community "3CX Phone System by HTTP" template,
     *      ordered by name. Convenient default when the template is in use.
     *
     * Returns null only when both paths come up empty. The page then runs
     * XAPI-only (no Zabbix history / problems, but the rest still works).
     */
    private static function findVoipHost(): ?array {
        $select = [
            'output'           => ['hostid', 'host', 'name', 'status'],
            'selectInterfaces' => ['interfaceid', 'ip', 'main', 'type'],
            'selectInventory'  => ['model', 'os_full', 'location'],
        ];

        // 1. Operator-pinned host wins, regardless of template.
        $override = self::globalMacro(self::HOST_MACRO);
        if ($override !== '') {
            // Try hostid first (purely numeric value), then host / visible name.
            if (ctype_digit($override)) {
                $rows = API::Host()->get($select + ['hostids' => [$override]]) ?: [];
                if ($rows) return $rows[0];
            }
            $rows = API::Host()->get($select + [
                'filter'      => ['host' => [$override], 'name' => [$override]],
                'searchByAny' => true,
            ]) ?: [];
            if ($rows) {
                // Prefer an exact name match if multiple came back.
                foreach ($rows as $h) {
                    if (strcasecmp((string) $h['host'], $override) === 0 ||
                        strcasecmp((string) $h['name'], $override) === 0) {
                        return $h;
                    }
                }
                return $rows[0];
            }
            // Last resort: substring search.
            $rows = API::Host()->get($select + [
                'search'      => ['host' => $override, 'name' => $override],
                'searchByAny' => true,
                'limit'       => 1,
            ]) ?: [];
            if ($rows) return $rows[0];

            error_log('[tcs_dashboard] voip: {$TCS.VOIP.HOST}="' . $override . '" did not match any Zabbix host');
        }

        // 2. Fall back to template lookup.
        $templates = API::Template()->get([
            'output'      => ['templateid', 'host', 'name'],
            'search'      => ['name' => self::TEMPLATE_NAME],
            'startSearch' => true,
        ]) ?: [];
        if (!$templates) return null;

        $hosts = API::Host()->get($select + [
            'templateids' => array_column($templates, 'templateid'),
        ]) ?: [];
        if (!$hosts) return null;

        usort($hosts, fn($a, $b) => strcmp((string) $a['name'], (string) $b['name']));
        return $hosts[0];
    }

    /** @return array{url:string,client_id:string,client_secret:string,verify_ssl:bool} */
    private static function voipMacros(): array {
        return [
            'url'           => self::globalMacro('{$TCS.3CX.URL}'),
            'client_id'     => self::globalMacro('{$TCS.3CX.CLIENT_ID}'),
            'client_secret' => self::globalMacro('{$TCS.3CX.CLIENT_SECRET}'),
            'verify_ssl'    => self::globalMacro('{$TCS.3CX.VERIFY.SSL}') !== '0',
        ];
    }

    private static function globalMacro(string $name): string {
        $rows = API::UserMacro()->get([
            'output'      => ['macro', 'value'],
            'globalmacro' => true,
            'filter'      => ['macro' => $name],
        ]) ?: [];
        return trim((string) ($rows[0]['value'] ?? ''));
    }

    // ── Misc helpers ───────────────────────────────────────────────────────

    /**
     * Read the first non-empty value at any of $keys, case-sensitive.
     * @param array<string,mixed> $a
     * @param list<string> $keys
     */
    private static function pick(array $a, array $keys, $default) {
        foreach ($keys as $k) {
            if (array_key_exists($k, $a) && $a[$k] !== null && $a[$k] !== '') return $a[$k];
        }
        return $default;
    }

    /** SystemStatus may carry pbx fields directly; guarantee the array exists for buildCallsHistory(). */
    private static function ensurePbx(?array $pbx, ?array $host): array {
        if (is_array($pbx)) return $pbx;
        return self::mapPbx([], $host);
    }

    private static function asFloatList($v): array {
        if (!is_array($v)) return [];
        $out = [];
        foreach ($v as $x) $out[] = (float) $x;
        return $out;
    }

    private static function padArray(array $vals, int $n): array {
        $vals = array_values($vals);
        if (count($vals) >= $n) return array_slice($vals, -$n);
        return array_merge(array_fill(0, $n - count($vals), 0), $vals);
    }

    /** Accept either ISO 8601-ish "HH:MM:SS" or a numeric seconds value. */
    private static function durationToMinutes($v): int {
        if (is_numeric($v)) return (int) round(((float) $v) / 60);
        if (is_string($v) && preg_match('/^(\d+):(\d{2}):(\d{2})$/', $v, $m)) {
            return (int) round(((int) $m[1] * 3600 + (int) $m[2] * 60 + (int) $m[3]) / 60);
        }
        return 0;
    }

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
        if ($delta < 60)    return '00:' . str_pad((string) $delta, 2, '0', STR_PAD_LEFT);
        if ($delta < 3600)  return sprintf('00:%02d', intdiv($delta, 60));
        if ($delta < 86400) return sprintf('%02d:%02d', intdiv($delta, 3600), intdiv($delta % 3600, 60));
        return intdiv($delta, 86400) . 'd';
    }
}
