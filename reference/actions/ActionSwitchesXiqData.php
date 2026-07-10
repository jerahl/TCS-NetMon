<?php declare(strict_types=1);

namespace Modules\TcsDashboard\Actions;

use API;
use CControllerResponseData;
use CControllerResponseFatal;
use Modules\TcsDashboard\Lib\XIQClient;
use Modules\TcsDashboard\Lib\XIQFleetClient;

/**
 * GET zabbix.php?action=tcs.switches.xiq.data&switchid=NNN
 *
 * Looks the Zabbix switch host up in ExtremeCloud IQ by hostname + serial
 * and returns the matching XIQ device's connected clients, recent
 * device-scoped alarm history, and any unacknowledged global alerts whose
 * keyword matches the switch hostname.
 *
 * Lookup strategy:
 *   1. Pull the host's technical name + inventory.serialno_a from Zabbix.
 *   2. XIQFleetClient::findDevice() — one /devices call filtered by sns
 *      (most reliable) then hostnames. Cached 5 min in APCu under a key
 *      keyed on the hostname+serial pair.
 *   3. With the XIQ deviceId in hand, fan out three XIQ calls:
 *        GET /clients/active?deviceIds=<id>      → connected clients
 *        GET /devices/<id>/alarms                → 7-day event log
 *        GET /alerts?keyword=<hostname>           → open alerts
 *
 * Response shape mirrors what the React TabXiq component renders:
 *   {
 *     ok: bool,
 *     reason?: string,            // when ok=false (e.g. "no_token")
 *     device: {id, hostname, model, mac, ip, connected, ...} | null,
 *     clients: [{mac, host, user, ssid, ...}],
 *     events:  [{id, ts, severity, category, message}],
 *     alerts:  [{id, ts, severity, source, summary, acknowledged}],
 *     rateLimit: { remaining, reset }
 *   }
 */
class ActionSwitchesXiqData extends ActionDataBase {

    protected function checkInput(): bool {
        $ret = $this->validateInput([
            'switchid' => 'required|string',
            'debug'    => 'string'
        ]);
        if (!$ret) {
            $this->setResponse(new CControllerResponseFatal());
        }
        return $ret;
    }

    protected function doAction(): void {
        $hostid = (string) $this->getInput('switchid');
        $debug  = $this->getInput('debug', '') !== '';

        $payload = [
            'ok'        => false,
            'reason'    => '',
            'device'    => null,
            'clients'   => [],
            'events'    => [],
            'alerts'    => [],
            'rateLimit' => ['remaining' => null, 'reset' => 0],
            'ts'        => time()
        ];
        $diag = [
            'serial_used'        => '',
            'hostname_used'      => '',
            'mac_used'           => '',
            'lookup_match_by'    => '',
            'lookup_match_score' => 0,
            'lookup_candidates'  => 0,
            'lookup_verified'    => false,
            'device_raw_keys'    => [],
            'clients_total'      => null,
            'clients_returned'   => null,
            'clients_first_keys' => [],
            'events_total'       => null,
            'alerts_total'       => null,
            'errors'             => []
        ];

        $token = $this->xiqToken();
        if ($token === null) {
            $payload['reason'] = 'no_token';
            $this->respond($payload);
            return;
        }

        $hostMeta = $this->collectHostMeta($hostid);
        if ($hostMeta === null) {
            $payload['reason'] = 'unknown_host';
            if ($debug) $payload['_debug'] = $diag;
            $this->respond($payload);
            return;
        }
        $payload['host'] = $hostMeta;
        $diag['serial_used']   = $hostMeta['serial'];
        $diag['hostname_used'] = $hostMeta['hostname'];
        $diag['mac_used']      = $hostMeta['mac'];

        try {
            $fleet  = XIQFleetClient::fromToken($token);
            $device = $fleet->findDevice($hostMeta['hostname'], $hostMeta['serial'], $hostMeta['mac']);
            $payload['rateLimit'] = [
                'remaining' => $fleet->getRateLimitRemaining(),
                'reset'     => $fleet->getRateLimitReset()
            ];
        } catch (\Throwable $e) {
            error_log('[tcs_dashboard] xiq lookup failed: ' . $e->getMessage());
            $diag['errors'][] = 'lookup: ' . $e->getMessage();
            $payload['reason'] = 'lookup_failed';
            if ($debug) $payload['_debug'] = $diag;
            $this->respond($payload);
            return;
        }

        if (!$device || empty($device['id'])) {
            $payload['reason'] = 'not_in_xiq';
            if ($debug) $payload['_debug'] = $diag;
            $this->respond($payload);
            return;
        }

        // Cross-check the resolved device against the identifiers we
        // asked for. The lookup is "ambiguous" when ONLY the hostname
        // agreed AND we had a serial/MAC to compare against — that's
        // the classic "matched an AP that shares the closet hostname"
        // failure mode. Refuse rather than silently fetch the wrong
        // device's clients.
        $match = is_array($device['__match'] ?? null) ? $device['__match'] : [];
        $diag['lookup_match_score'] = (int) ($match['score'] ?? 0);
        $diag['lookup_candidates']  = (int) ($match['candidates'] ?? 1);
        $diag['lookup_verified']    = (bool) ($match['verified'] ?? false);
        // Compose a human-readable summary of which identifiers agreed.
        $matchBy = [];
        if (!empty($match['by_serial'])) $matchBy[] = 'serial';
        if (!empty($match['by_mac']))    $matchBy[] = 'mac';
        if (!empty($match['by_host']))   $matchBy[] = 'hostname';
        $diag['lookup_match_by'] = implode('+', $matchBy) ?: 'none';

        // Acceptable if the match is by serial or MAC alone, by any
        // combination of two filters, or by hostname when no other
        // identifier was available to cross-check.
        $hadStrongKey  = $hostMeta['serial'] !== '' || $hostMeta['mac'] !== '';
        $matchedStrong = !empty($match['by_serial']) || !empty($match['by_mac']);
        if ($hadStrongKey && !$matchedStrong) {
            $payload['reason'] = 'lookup_ambiguous';
            $payload['device'] = $this->shapeDevice($device);
            $payload['notes']  = [
                'clients' => 'Refused to fetch XIQ data: the only matching XIQ device shares the Zabbix host name but has a different serial/MAC. Verify the Zabbix host inventory serialno_a (got "' . $hostMeta['serial'] . '") matches the XIQ device, or correct the hostname.'
            ];
            if ($debug) $payload['_debug'] = $diag;
            $this->respond($payload);
            return;
        }

        $payload['device'] = $this->shapeDevice($device);
        $deviceId = (int) $device['id'];
        $diag['device_raw_keys'] = array_keys($device);

        $isSwitch = stripos((string) ($device['device_function'] ?? ''), 'switch') !== false;
        $payload['notes'] = [];

        // Clients. Two endpoints are in play:
        //   • /clients/active (main XIQ API) — wireless-association centric.
        //     Returns the AP-attached station list. Used for wireless
        //     devices (the original AP-detail use case).
        //   • Platform ONE /wired/grid — the wired-client equivalent, on a
        //     separate base URL with its own token scope. This is the ONLY
        //     public endpoint that returns the switch-attached station
        //     list, and it's required for switches (XIQ's wired FDB is
        //     not exposed on /clients/active even though the console
        //     shows the data).
        // We always try /clients/active first since it works for both APs
        // and returns 0 cheaply for switches, then for switches fall back
        // to /wired/grid to fill in the wired stations.
        try {
            $rawClients = $fleet->getJson('/clients/active', [
                'deviceIds' => $deviceId,
                'views'     => 'FULL',
                'page'      => 1,
                'limit'     => 100
            ]);
            $rows = $rawClients['data'] ?? (is_array($rawClients) && array_values($rawClients) === $rawClients ? $rawClients : []);
            $diag['clients_total']    = (int) ($rawClients['total_count'] ?? count(is_array($rows) ? $rows : []));
            $diag['clients_returned'] = is_array($rows) ? count($rows) : 0;
            if (is_array($rows) && $rows) {
                $diag['clients_first_keys'] = array_keys($rows[0]);
                if ($debug) $diag['clients_first_row'] = $rows[0];
            }
            $payload['clients'] = $this->shapeClientsRaw(is_array($rows) ? $rows : []);
        } catch (\Throwable $e) {
            error_log('[tcs_dashboard] xiq clients failed: ' . $e->getMessage());
            $diag['errors'][] = 'clients: ' . $e->getMessage();
        }

        // Collect the device IDs to query: the primary plus any sibling
        // XIQ devices with the same hostname. Switch stacks and re-
        // onboarded devices often register multiple XIQ records under
        // one hostname; wired-client telemetry may attach to a sibling
        // instead of the serial-matched primary, so we fan out across
        // all of them and merge results.
        $siblings = is_array($match['siblings'] ?? null) ? $match['siblings'] : [];
        $idsToQuery = [$deviceId];
        foreach ($siblings as $s) {
            $sid = (int) ($s['id'] ?? 0);
            if ($sid > 0 && $sid !== $deviceId) $idsToQuery[] = $sid;
        }
        $diag['device_ids_queried'] = $idsToQuery;
        $diag['siblings_seen']      = $siblings;

        if ($isSwitch) {
            $totalAcrossSiblings = 0;
            foreach ($idsToQuery as $idx => $did) {
                try {
                    [$wired, $wiredMeta] = $fleet->getWiredClientsForDeviceDetailed($did, 100, 5);
                    // First (primary) call drives the diag fields; siblings
                    // just contribute clients into the merged payload.
                    if ($idx === 0) {
                        $diag['wired_clients_total']    = (int) ($wiredMeta['total_count'] ?? count($wired));
                        $diag['wired_clients_returned'] = count($wired);
                        $diag['wired_meta']             = $wiredMeta;
                        if ($wired) $diag['wired_first_keys'] = array_keys($wired[0]);
                        if ($debug && $wired) $diag['wired_first_row'] = $wired[0];
                    } else {
                        $diag['siblings_wired'][] = [
                            'device_id'   => $did,
                            'total_count' => (int) ($wiredMeta['total_count'] ?? 0),
                            'returned'    => count($wired)
                        ];
                    }
                    $totalAcrossSiblings += count($wired);
                    $payload['clients'] = array_merge($payload['clients'], $this->shapeWiredClients($wired));
                } catch (\Throwable $e) {
                    $msg = $e->getMessage();
                    if ($idx === 0 && (stripos($msg, '403') !== false || stripos($msg, 'AUTH_ACCESS_DENIED') !== false)) {
                        $payload['notes']['clients'] = 'XIQ returned 403 on /dashboard/wired/client-health/grid — the API token is missing the Dashboard / wired-client read scope. Edit the token under XIQ Administration → API Access Tokens.';
                    } else {
                        error_log('[tcs_dashboard] xiq wired clients failed (device ' . $did . '): ' . $msg);
                    }
                    $diag['errors'][] = 'wired_clients[' . $did . ']: ' . $msg;
                }
            }
            $diag['wired_clients_merged_total'] = $totalAcrossSiblings;

            // Cross-check against the legacy /clients/active count endpoint
            // when the grid returned nothing. Two zeroes from two
            // independent endpoints is a definitive "XIQ has no wired-
            // client telemetry indexed for this switch" — not a transient
            // grid-side issue. The Python SDK confirms these are the only
            // public wired-client list endpoints.
            $gridTotal = (int) ($diag['wired_clients_total'] ?? 0);
            if ($gridTotal === 0 && empty($payload['clients'])) {
                try {
                    // /clients/active/count returns a bare integer body
                    // (e.g. `42`). XIQFleetClient::execAndParse wraps
                    // scalar JSON into ['count' => N, '__scalar' => true]
                    // so we can read it with a uniform shape.
                    $cnt = $fleet->getJson('/clients/active/count', [
                        'deviceIds'             => $deviceId,
                        'clientConnectionTypes' => 2,   // 2 = WIRED
                        'excludeLocallyManaged' => 'false'
                    ]);
                    $diag['clients_active_wired_count'] = (int) ($cnt['count'] ?? $cnt['total_count'] ?? 0);
                } catch (\Throwable $e) {
                    $diag['errors'][] = 'wired_count_probe: ' . $e->getMessage();
                }

                // Org-wide unfiltered probe. Issue the SAME wired-grid call
                // but with no device_ids filter, asking for the first 50
                // rows. Three possible outcomes pin down where the gap is:
                //
                //   total = 0      → XIQ org has no wired-client telemetry
                //                    anywhere → org-wide config (Wired
                //                    Client Visibility / Instant Port
                //                    Profile not deployed).
                //   total > 0, our device_id missing from any row
                //                  → other devices report wired clients;
                //                    THIS switch is silent → per-device
                //                    config issue (IPP not assigned to
                //                    this switch's port profile).
                //   total > 0, our device_id present in some row
                //                  → the per-device filter is dropping
                //                    matches → bug in our request shape.
                //
                // Only run under ?debug=1; it can be expensive on large
                // orgs (50 rows of FULL data) and is purely diagnostic.
                if ($debug) {
                    try {
                        $orgWide = $fleet->postJson('/dashboard/wired/client-health/grid', [
                            'page'      => 1,
                            'limit'     => 50,
                            'sortField' => 'MAC',
                            'sortOrder' => 'ASC'
                        ], [
                            'site_ids'     => [],
                            'device_ids'   => [],
                            'filter_field' => []
                        ]);
                        $orgRows  = is_array($orgWide['data'] ?? null) ? $orgWide['data'] : [];
                        $orgTotal = (int) ($orgWide['total_count'] ?? count($orgRows));
                        $distinctDevices = [];
                        $hostnamesByDevice = [];
                        $thisDeviceHits = 0;     // strict match against $deviceId
                        $anyQueriedHits = 0;     // match against any id we queried
                        $hostnameHits   = 0;     // any row where switch_name == our hostname
                        $queriedSet = array_flip(array_map('strval', $idsToQuery));
                        $ourHostLower = strtolower($hostMeta['hostname']);
                        foreach ($orgRows as $r) {
                            if (!is_array($r)) continue;
                            $did = (string) ($r['device_id'] ?? '');
                            if ($did === '') continue;
                            $distinctDevices[$did] = ($distinctDevices[$did] ?? 0) + 1;
                            $hostnamesByDevice[$did] = $hostnamesByDevice[$did]
                                ?? (string) ($r['switch_name'] ?? '');
                            if ((string) $did === (string) $deviceId) $thisDeviceHits++;
                            if (isset($queriedSet[$did])) $anyQueriedHits++;
                            if (strtolower((string) ($r['switch_name'] ?? '')) === $ourHostLower) $hostnameHits++;
                        }
                        arsort($distinctDevices);
                        $sampleDevices = [];
                        foreach (array_slice($distinctDevices, 0, 8, true) as $did => $n) {
                            $sampleDevices[] = [
                                'device_id'  => $did,
                                'switch'     => $hostnamesByDevice[$did] ?? '',
                                'rows'       => $n,
                                'we_queried' => isset($queriedSet[$did])
                            ];
                        }
                        // Identify any XIQ devices using OUR hostname that
                        // we didn't already query (i.e. they weren't picked
                        // up by findDevice as siblings). This is the
                        // "wrong device id resolved" smoking gun.
                        $unqueriedHostnameMatches = [];
                        foreach ($distinctDevices as $did => $n) {
                            if (isset($queriedSet[$did])) continue;
                            $h = strtolower((string) ($hostnamesByDevice[$did] ?? ''));
                            if ($h === $ourHostLower) {
                                $unqueriedHostnameMatches[] = [
                                    'device_id' => $did,
                                    'switch'    => $hostnamesByDevice[$did] ?? '',
                                    'rows'      => $n
                                ];
                            }
                        }
                        $diag['orgwide_wired'] = [
                            'total_count'                => $orgTotal,
                            'rows_returned'              => count($orgRows),
                            'distinct_devices'           => count($distinctDevices),
                            'this_device_hits'           => $thisDeviceHits,
                            'any_queried_device_hits'    => $anyQueriedHits,
                            'hostname_match_hits'        => $hostnameHits,
                            'unqueried_hostname_matches' => $unqueriedHostnameMatches,
                            'top_devices_sample'         => $sampleDevices
                        ];

                        // Refine the operator-facing note based on what
                        // the org-wide probe actually saw.
                        if (empty($payload['notes']['clients'])) {
                            if ($orgTotal === 0) {
                                $payload['notes']['clients'] =
                                    'XIQ-wide /dashboard/wired/client-health/grid returns 0 '
                                    . 'rows even with no device filter — wired-client '
                                    . 'telemetry isn\'t flowing for ANY device in this org. '
                                    . 'Enable Wired Client Visibility on the network policy / '
                                    . 'attach an Instant Port Profile to access ports. Until '
                                    . 'that\'s set up org-wide, no switch will return clients '
                                    . 'via the public API; the Port Status tab\'s SNMP-sourced '
                                    . 'FDB is the source of truth.';
                            } elseif ($unqueriedHostnameMatches) {
                                // XIQ has a device using OUR hostname that
                                // findDevice didn't catch as a sibling
                                // (most likely it didn't show up in the
                                // 25-row /devices?hostnames filter). The
                                // wired clients are attributed to THAT
                                // device id, not the one we resolved. The
                                // operator should reconcile the duplicate.
                                $other = $unqueriedHostnameMatches[0];
                                $payload['notes']['clients'] =
                                    'Wired clients in XIQ are attributed to a DIFFERENT XIQ '
                                    . 'device record sharing this switch\'s hostname: '
                                    . 'device_id ' . $other['device_id'] . ' (' . $other['rows'] . ' '
                                    . 'sample rows). The serial-matched device we resolved '
                                    . '(' . $deviceId . ') reports no clients. This usually '
                                    . 'means XIQ has a duplicate / stale registration after '
                                    . 'a re-onboard, or stack members register under separate '
                                    . 'IDs and telemetry attaches to a sibling. Remove the '
                                    . 'stale registration in XIQ (or update Zabbix inventory '
                                    . 'serialno_a to the device id that\'s actually reporting).';
                            } elseif ($anyQueriedHits === 0) {
                                $sampleHost = $sampleDevices[0]['switch'] ?? '(unknown)';
                                $payload['notes']['clients'] =
                                    'XIQ has wired-client telemetry for OTHER devices in this '
                                    . 'org (e.g. "' . $sampleHost . '") but not for this '
                                    . 'switch — it isn\'t pushing wired-client info. Check '
                                    . 'this switch\'s policy: ensure access ports have an '
                                    . 'Instant Port Profile and that Wired Client Visibility '
                                    . 'is enabled on the device.';
                            } else {
                                $payload['notes']['clients'] =
                                    'Org-wide probe DID see ' . $anyQueriedHits . ' rows '
                                    . 'for queried device_ids in the first 50 unfiltered '
                                    . 'results — but the device-filtered call returned 0. '
                                    . 'This is a request-shape mismatch in the dashboard, '
                                    . 'not an XIQ config issue. See server log for details.';
                                error_log(sprintf(
                                    '[tcs_dashboard] xiq wired-clients filter mismatch: '
                                    . 'unfiltered probe saw %d row(s) for queried ids %s but '
                                    . 'filtered grid returned 0. Check request body shape.',
                                    $anyQueriedHits, implode(',', $idsToQuery)
                                ));
                            }
                        }
                    } catch (\Throwable $e) {
                        $diag['errors'][] = 'wired_orgwide_probe: ' . $e->getMessage();
                    }
                }

                // Fall-through default note when debug isn't requested
                // and we still have nothing useful to say.
                if (empty($payload['notes']['clients'])) {
                    $payload['notes']['clients'] =
                        'XIQ has no wired-client telemetry indexed for this switch — both '
                        . '/dashboard/wired/client-health/grid and /clients/active (count) '
                        . 'returned 0. This is typically because the switch isn\'t pushing '
                        . 'client telemetry to XIQ: assign an Instant Port Profile to the '
                        . 'access ports in the device\'s policy, or enable Wired Client '
                        . 'Visibility on the device. The switch FDB shown on the Port Status '
                        . 'tab (sourced from Zabbix via SNMP) is the source of truth in the '
                        . 'meantime. Append ?debug=1 to the data URL for an org-wide cross-'
                        . 'check that pins down whether this is a device-side or org-wide gap.';
                }
            }
        }

        // Events: widen the window to 30 days and paginate up to 5 pages
        // (500 alarms) so we don't drop older entries. Most switches
        // generate a handful of events per day at most; 500 is a generous
        // ceiling without dragging the request into multi-second territory.
        try {
            $payload['events'] = $this->collectEventsPaged($token, $deviceId, /*windowHours*/ 720, /*pages*/ 5);
        } catch (\Throwable $e) {
            error_log('[tcs_dashboard] xiq alarms failed: ' . $e->getMessage());
            $diag['errors'][] = 'events: ' . $e->getMessage();
        }
        $diag['events_total'] = count($payload['events']);

        try {
            $payload['alerts'] = $this->collectAlerts($fleet, $hostMeta['hostname']);
            $diag['alerts_total'] = count($payload['alerts']);
        } catch (\Throwable $e) {
            $msg = $e->getMessage();
            // /alerts is gated by the "Alert Read" token scope. Surface a
            // user-actionable note instead of just an error string so the
            // tab can explain what's missing.
            if (stripos($msg, '403') !== false || stripos($msg, 'AUTH_ACCESS_DENIED') !== false) {
                $payload['notes']['alerts'] = 'XIQ returned 403 on /alerts — the API token is missing the "Alert" read scope. Edit the token under XIQ Administration → API Access Tokens.';
            } else {
                error_log('[tcs_dashboard] xiq alerts failed: ' . $msg);
            }
            $diag['errors'][] = 'alerts: ' . $msg;
        }

        $payload['ok'] = true;
        if ($debug) $payload['_debug'] = $diag;
        $this->respond($payload);
    }

    private function respond(array $payload): void {
        $this->setResponse(new CControllerResponseData([
            'main_block' => json_encode($payload, JSON_UNESCAPED_SLASHES)
        ]));
    }

    /**
     * Pull the hostname + inventory.serialno_a + management IP for one host.
     * Returns null when the host isn't visible to this user.
     *
     * @return array{hostid:string, hostname:string, visible_name:string, serial:string, ip:string}|null
     */
    private function collectHostMeta(string $hostid): ?array {
        $hosts = API::Host()->get([
            'output'           => ['hostid', 'host', 'name'],
            'selectInventory'  => ['serialno_a', 'serialno_b', 'macaddress_a', 'macaddress_b'],
            'selectInterfaces' => ['ip', 'main', 'type'],
            'hostids'          => [$hostid]
        ]) ?: [];
        if (!$hosts) return null;
        $h = $hosts[0];

        $serial = trim((string) ($h['inventory']['serialno_a'] ?? ''));
        if ($serial === '') {
            $serial = trim((string) ($h['inventory']['serialno_b'] ?? ''));
        }
        // MAC: prefer inventory.macaddress_a, then macaddress_b. XIQ matches
        // on the colon-less form so we normalise here too.
        $macRaw = trim((string) ($h['inventory']['macaddress_a'] ?? ''));
        if ($macRaw === '') {
            $macRaw = trim((string) ($h['inventory']['macaddress_b'] ?? ''));
        }
        $mac = preg_replace('/[^0-9A-Fa-f]/', '', $macRaw);
        if (strlen((string) $mac) !== 12 || $mac === '000000000000') $mac = '';

        $ip = '';
        foreach ($h['interfaces'] ?? [] as $iface) {
            if ((int) ($iface['main'] ?? 0) === 1 && ($iface['ip'] ?? '') !== '') {
                $ip = (string) $iface['ip'];
                break;
            }
        }

        return [
            'hostid'       => (string) $h['hostid'],
            'hostname'     => (string) $h['host'],
            'visible_name' => (string) $h['name'],
            'serial'       => $serial,
            'mac'          => (string) $mac,
            'ip'           => $ip
        ];
    }

    /** XIQ device row → the slim shape TabXiq renders in its header card. */
    private function shapeDevice(array $d): array {
        // BASIC view fields per /devices?views=BASIC. Field names vary across
        // XIQ build numbers — accept the common aliases.
        $first = function (array $r, array $keys, $default = '') {
            foreach ($keys as $k) {
                if (isset($r[$k]) && $r[$k] !== '' && $r[$k] !== null) return $r[$k];
            }
            return $default;
        };
        $mac = (string) $first($d, ['mac_address', 'macAddress', 'mac'], '');
        if ($mac !== '' && strpos($mac, ':') === false) {
            $mac = XIQClient::macInsertColons($mac);
        }
        return [
            'id'            => (int) ($d['id'] ?? 0),
            'hostname'      => (string) $first($d, ['hostname', 'host_name', 'name']),
            'serial'        => (string) $first($d, ['serial_number', 'serialNumber', 'serial']),
            'model'         => (string) $first($d, ['product_type', 'productType', 'model']),
            'function'      => (string) $first($d, ['device_function', 'deviceFunction', 'function']),
            'firmware'      => (string) $first($d, ['software_version', 'softwareVersion', 'firmware']),
            'mac'           => $mac,
            'ip'            => (string) $first($d, ['ip_address', 'ipAddress', 'ip']),
            'connected'     => (bool)   $first($d, ['connected', 'is_connected'], false),
            'last_connect'  => (int)    $first($d, ['last_connect_time_ms', 'lastConnectTimeMs', 'last_connect'], 0),
            'policy_id'     => (int)    $first($d, ['network_policy_id', 'networkPolicyId'], 0),
            'policy_name'   => (string) $first($d, ['network_policy_name', 'networkPolicyName']),
            'site_id'       => (int)    $first($d, ['site_id', 'siteId'], 0),
            'location'      => (string) $first($d, ['location', 'location_name', 'locationName'])
        ];
    }

    /** Project raw /clients/active rows into the slim shape TabXiq renders.
     *  Tolerant of XIQ field-name churn — wired clients on a switch may
     *  use `client_mac` / `wired_mac` instead of `mac_address`, and we
     *  must not silently drop rows just because the wireless field is
     *  missing. Only rows with NO MAC under any alias are skipped.
     *
     *  @param array<int, array<string,mixed>> $rows
     *  @return array<int, array<string,mixed>>
     */
    private function shapeClientsRaw(array $rows): array {
        $first = function (array $r, array $keys, $default = '') {
            foreach ($keys as $k) {
                if (isset($r[$k]) && $r[$k] !== '' && $r[$k] !== null) return $r[$k];
            }
            return $default;
        };
        $out = [];
        foreach ($rows as $c) {
            if (!is_array($c)) continue;
            $macRaw = (string) $first($c, ['mac_address', 'mac', 'client_mac', 'station_mac', 'wired_mac', 'macAddress', 'clientMac']);
            if ($macRaw === '') continue;
            $mac = strpos($macRaw, ':') === false ? XIQClient::macInsertColons($macRaw) : $macRaw;
            $connType = (int) $first($c, ['client_connection_type', 'clientConnectionType', 'connection_type'], 0);
            $band = (string) $first($c, ['band', 'frequency']);
            if ($band === '') {
                $proto = strtolower((string) $first($c, ['mac_protocol', 'macProtocol', 'protocol']));
                if (strpos($proto, '2.4') !== false || strpos($proto, '2_4') !== false) $band = '2.4G';
                elseif (strpos($proto, '5') !== false) $band = '5G';
                elseif (strpos($proto, '6') !== false) $band = '6G';
            }
            $out[] = [
                'mac'      => $mac,
                'host'     => (string) $first($c, ['host_name', 'hostname', 'device_name', 'hostName']),
                'ip'       => (string) $first($c, ['ip_address', 'ipAddress', 'ip']),
                'user'     => (string) $first($c, ['user_name', 'username', 'userName']),
                'role'     => (string) $first($c, ['user_profile_name', 'user_profile', 'userProfileName', 'userProfile']),
                'ssid'     => (string) $first($c, ['ssid']),
                'vlan'     => (int)    $first($c, ['vlan', 'vlan_id', 'vlanId'], 0),
                'rssi'     => (int)    $first($c, ['rssi'], 0),
                'snr'      => (int)    $first($c, ['snr'], 0),
                'health'   => (int)    $first($c, ['client_health_status', 'client_health', 'clientHealthStatus'], 0),
                'duration' => (int)    $first($c, ['connection_duration', 'connected_seconds', 'connectionDuration'], 0),
                'os'       => trim(((string) $first($c, ['os_type', 'osType', 'os']))
                                  . ' '
                                  . ((string) $first($c, ['os_version', 'osVersion']))),
                'protocol' => (string) $first($c, ['mac_protocol', 'macProtocol', 'protocol']),
                'band'     => $band,
                'wired'    => $connType === 2,
                'port'     => (string) $first($c, ['ifname', 'port_name', 'switch_port', 'switchPort'])
            ];
        }
        return $out;
    }

    /** Project Platform ONE /wired/grid rows into the same slim shape the
     *  Clients sub-table renders. Different field names than /clients/active
     *  — see the WiredDataInner schema in the spec. */
    private function shapeWiredClients(array $rows): array {
        $out = [];
        foreach ($rows as $c) {
            if (!is_array($c)) continue;
            $macRaw = (string) ($c['mac'] ?? $c['client_mac'] ?? '');
            if ($macRaw === '') continue;
            $mac = strpos($macRaw, ':') === false ? XIQClient::macInsertColons($macRaw) : $macRaw;
            $out[] = [
                'mac'      => $mac,
                'host'     => (string) ($c['client_hostname'] ?? ''),
                'ip'       => (string) ($c['client_ip'] ?? $c['ipv4'] ?? ''),
                'user'     => (string) ($c['username'] ?? ''),
                'role'     => (string) ($c['instant_port_profile'] ?? ''),
                'ssid'     => '',
                'vlan'     => (int)    ($c['vlan'] ?? 0),
                'rssi'     => 0,
                'snr'      => 0,
                'health'   => 0,
                'duration' => 0,
                'os'       => (string) ($c['operating_system'] ?? ''),
                'protocol' => '',
                'band'     => '',
                'wired'    => true,
                'port'     => (string) ($c['port_number'] ?? ''),
                'switch'   => (string) ($c['switch_name'] ?? ''),
                'status'   => strtoupper((string) ($c['connection_status'] ?? 'CONNECTED'))
            ];
        }
        return $out;
    }

    /** Slim a normalised XIQClient::getClients() row down to the columns the
     *  Clients sub-table renders. Drops the heavy raw blob. */
    private function shapeClient(array $c): array {
        return [
            'mac'      => (string) ($c['mac']      ?? ''),
            'host'     => (string) ($c['hostname'] ?? ''),
            'ip'       => (string) ($c['ip']       ?? ''),
            'user'     => (string) ($c['username'] ?? ''),
            'role'     => (string) ($c['user_profile'] ?? ''),
            'ssid'     => (string) ($c['ssid']     ?? ''),
            'vlan'     => (int)    ($c['vlan']     ?? 0),
            'rssi'     => (int)    ($c['rssi']     ?? 0),
            'snr'      => (int)    ($c['snr']      ?? 0),
            'health'   => (int)    ($c['client_health'] ?? 0),
            'duration' => (int)    ($c['connected_seconds'] ?? 0),
            'os'       => trim(((string) ($c['os_type'] ?? '')) . ' ' . ((string) ($c['os_version'] ?? ''))),
            'protocol' => (string) ($c['protocol'] ?? ''),
            'band'     => (string) ($c['band']     ?? '')
        ];
    }

    /**
     * Paginate /devices/{id}/alarms across multiple pages so we don't drop
     * entries past the first 100. Each call goes through XIQClient so the
     * row shape stays compatible with the rest of the dashboard.
     *
     * @return array<int, array<string, mixed>>
     */
    private function collectEventsPaged(string $token, int $deviceId, int $windowHours, int $maxPages): array {
        $client = XIQClient::fromToken($token);
        // XIQClient's helper handles page 1; if it returned a full 100 we
        // walk forward until either an empty page or maxPages.
        $page1 = $client->getDeviceAlarms($deviceId, 100, $windowHours);
        if (count($page1) < 100) return $page1;

        $all   = $page1;
        $endMs = (int) (microtime(true) * 1000);
        $startMs = $endMs - ($windowHours * 3600 * 1000);
        for ($p = 2; $p <= $maxPages; $p++) {
            $raw = XIQFleetClient::fromToken($token)->getJson("/devices/{$deviceId}/alarms", [
                'page'      => $p,
                'limit'     => 100,
                'startTime' => $startMs,
                'endTime'   => $endMs
            ]);
            $rows = $raw['data'] ?? (is_array($raw) && array_values($raw) === $raw ? $raw : []);
            if (!is_array($rows) || !$rows) break;
            foreach ($rows as $r) {
                if (!is_array($r)) continue;
                $tsRaw = $r['raised_time'] ?? $r['event_time'] ?? $r['created_time'] ?? $r['timestamp'] ?? 0;
                $ts = is_numeric($tsRaw) ? (int) $tsRaw : (int) strtotime((string) $tsRaw);
                if ($ts > 9999999999) $ts = intdiv($ts, 1000);
                $sevRaw = strtoupper((string) ($r['severity'] ?? ''));
                $sevMap = ['CRITICAL'=>'disaster','EMERGENCY'=>'disaster','ALERT'=>'disaster',
                           'MAJOR'=>'high','ERROR'=>'high','MINOR'=>'warning','WARNING'=>'warning',
                           'NOTICE'=>'info','INFO'=>'info','INFORM'=>'info'];
                $all[] = [
                    'id'       => (string) ($r['id'] ?? $r['alarm_id'] ?? ('xiq-'.$ts.'-'.md5((string) ($r['description'] ?? '')))),
                    'message'  => (string) ($r['description'] ?? $r['summary'] ?? $r['name'] ?? 'XIQ alarm'),
                    'severity' => $sevMap[$sevRaw] ?? 'warning',
                    'clock'    => $ts > 0 ? $ts : time(),
                    'value'    => 1,
                    'category' => (string) ($r['category'] ?? ''),
                    'raw'      => $r
                ];
            }
            if (count($rows) < 100) break;
        }
        return $all;
    }

    /**
     * Open XIQ alerts referencing the switch. /alerts has no deviceId param —
     * we filter by `keyword` (XIQ matches against summary / source / etc.)
     * using the host's technical name. Returns the freshest 50 from the last
     * 7 days, normalised for the React table.
     *
     * @return array<int, array<string,mixed>>
     */
    private function collectAlerts(XIQFleetClient $fleet, string $hostname): array {
        if ($hostname === '') return [];
        $end   = (int) (microtime(true) * 1000);
        $start = $end - (7 * 86400 * 1000);
        // XiqAlertSortField enum is { TIMESTAMP, SOURCE } — passing
        // CREATE_TIME / CREATED_AT yields HTTP 400 from XIQ. The
        // ordering direction stays under `order` (descending by default,
        // which is what we want anyway, so it's omitted).
        $resp  = $fleet->getJson('/alerts', [
            'page'      => 1,
            'limit'     => 50,
            'startTime' => $start,
            'endTime'   => $end,
            'keyword'   => $hostname,
            'sortField' => 'TIMESTAMP'
        ]);
        $rows = $resp['data'] ?? (is_array($resp) && array_values($resp) === $resp ? $resp : []);
        if (!is_array($rows)) return [];

        static $sevMap = [
            1 => 'disaster',  // CRITICAL per XIQ docs
            2 => 'warning',
            3 => 'info'
        ];
        $out = [];
        foreach ($rows as $r) {
            if (!is_array($r)) continue;
            $tsMs = (int) ($r['createdTime'] ?? $r['create_time'] ?? $r['timestamp'] ?? 0);
            if ($tsMs > 9999999999) $tsMs = intdiv($tsMs, 1000);
            $sevId = (int) ($r['severityId'] ?? $r['severity_id'] ?? 0);
            $out[] = [
                'id'           => (string) ($r['id'] ?? $r['alertId'] ?? ''),
                'ts'           => $tsMs > 0 ? $tsMs : time(),
                'severity'     => $sevMap[$sevId] ?? 'warning',
                'source'       => (string) ($r['source'] ?? $r['sourceName'] ?? ''),
                'category'     => (string) ($r['category'] ?? $r['categoryName'] ?? ''),
                'summary'      => (string) ($r['summary'] ?? $r['description'] ?? $r['message'] ?? ''),
                'acknowledged' => (bool)   ($r['acknowledged'] ?? false)
            ];
        }
        return $out;
    }

    /**
     * Resolve the XIQ API token through the standard chain (macro →
     * macro-pointed file → conventional path → env var → legacy macro).
     * See {@see XIQFleetClient::resolveToken()} for the full order.
     */
    private function xiqToken(): ?string {
        $lookup = function (string $name): ?string {
            $rows = API::UserMacro()->get([
                'output'      => ['macro', 'value'],
                'globalmacro' => true,
                'filter'      => ['macro' => $name]
            ]) ?: [];
            return (string) ($rows[0]['value'] ?? '');
        };
        return XIQFleetClient::resolveToken($lookup);
    }
}
