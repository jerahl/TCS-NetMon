<?php declare(strict_types=1);

namespace Modules\TcsDashboard\Lib;

/**
 * Fleet-level ExtremeCloud IQ client.
 *
 * Sits alongside XIQClient (which is verbatim from jerahl/ZabbixExtremeIQ and
 * scoped to per-device queries). XIQFleetClient hits the cloud-wide list
 * endpoints — /devices, /clients/active — and handles paging, caching, and
 * rate-limit accounting on its own minimal cURL shim so the upstream client
 * stays unmodified for easy re-syncs.
 *
 * Token-only auth: pass a permanent API token from Zabbix global macro
 * {$XIQ_API_TOKEN}. JWT credential flow lives in XIQClient if needed.
 *
 * Caching: APCu, per-endpoint TTL. Defaults are sized for a ~30s page-refresh
 * cadence — devices change slowly (5min), active clients churn faster (60s).
 *
 * Rate-limit awareness: every response updates getRateLimitRemaining(). The
 * 7,500-req/hr quota is shared across all XIQ integrations on the tenant.
 */
final class XIQFleetClient {

    private const BASE_URL      = 'https://api.extremecloudiq.com';
    private const CACHE_PREFIX  = 'tcs_dashboard:xiq_fleet_client:';
    private const PAGE_LIMIT    = 100;
    private const MAX_PAGES     = 200;       // hard ceiling — defends against runaway pagination
    private const HTTP_TIMEOUT  = 30;
    /** Cap on simultaneous in-flight HTTP requests across curl_multi batches.
     *  XIQ tolerates dozens of concurrent requests easily and the 7,500-req/hr
     *  quota is on TOTAL volume, not concurrency. We cap at 12 to be polite. */
    private const MULTI_CONCURRENCY = 12;

    private string $token;
    private int $rateLimitRemaining = -1;
    private int $rateLimitReset     = 0;

    private function __construct(string $token) {
        $this->token = $token;
    }

    public static function fromToken(string $token): self {
        if ($token === '') {
            throw new \InvalidArgumentException('XIQFleetClient: empty API token');
        }
        return new self($token);
    }

    /**
     * Resolve the XIQ API token from any of the supported sources, in
     * priority order. Returns null when no source produces a non-empty
     * value.
     *
     * The Platform ONE bearer tokens are JWTs in the 1.5–3 KB range,
     * which exceeds the Zabbix macro value cap (255 chars on 6.x, 2048
     * on 7.x). To keep the macro path working for shorter tokens AND
     * accommodate the longer ones, we look in this order:
     *
     *   1. Global macro {$XIQ_API_TOKEN}                    — short tokens
     *   2. Global macro {$XIQ_API_TOKEN_FILE} (path)        — path to a
     *      file containing the token. Macro stores the path, file holds
     *      the (potentially multi-KB) token. Works around the macro cap
     *      while keeping configuration in Zabbix.
     *   3. /etc/zabbix/tcs_dashboard/xiq_api_token          — conventional
     *      default path so a fresh install can just drop the token in.
     *   4. Environment variable TCS_XIQ_API_TOKEN           — Docker-
     *      friendly path; readable by PHP-FPM via fastcgi_param /
     *      clear_env=no.
     *   5. Global macro {$XIQ_TOKEN}                        — legacy
     *      fallback for instances that already had this set non-secret.
     *
     * File contents are trimmed of trailing whitespace + BOM so a stray
     * newline doesn't make the bearer header malformed.
     *
     * @param \Closure(string):?string $macroLookup
     *        callback returning the macro value (caller supplies, since
     *        this lib doesn't depend on Zabbix's API class directly).
     */
    public static function resolveToken(\Closure $macroLookup): ?string {
        $clean = function (string $s): string {
            // Strip UTF-8 BOM + trailing whitespace; tokens are ASCII.
            if (str_starts_with($s, "\xEF\xBB\xBF")) $s = substr($s, 3);
            return trim($s);
        };

        $v = $clean((string) $macroLookup('{$XIQ_API_TOKEN}'));
        if ($v !== '') return $v;

        $path = $clean((string) $macroLookup('{$XIQ_API_TOKEN_FILE}'));
        if ($path === '') $path = '/etc/zabbix/tcs_dashboard/xiq_api_token';
        if (is_readable($path)) {
            $raw = (string) @file_get_contents($path);
            $tok = $clean($raw);
            if ($tok !== '') return $tok;
        }

        $env = $clean((string) (getenv('TCS_XIQ_API_TOKEN') ?: ($_SERVER['TCS_XIQ_API_TOKEN'] ?? '')));
        if ($env !== '') return $env;

        $legacy = $clean((string) $macroLookup('{$XIQ_TOKEN}'));
        if ($legacy !== '') return $legacy;

        return null;
    }

    public function getRateLimitRemaining(): int { return $this->rateLimitRemaining; }
    public function getRateLimitReset(): int     { return $this->rateLimitReset; }
    public function isRateLimitLow(): bool       { return $this->rateLimitRemaining >= 0 && $this->rateLimitRemaining < 500; }

    /**
     * Whole-fleet AP list.
     *
     * Each row is the BASIC view of GET /devices — id, hostname, mac_address,
     * device_function, product_type, network_policy_id, software_version,
     * connected (bool), last_connect_time_ms, ip_address. Use views=FULL only
     * if you need d360 telemetry (much heavier).
     */
    public function getDevices(int $cacheTtl = 300): array {
        return $this->cached('devices', $cacheTtl, function () {
            return $this->getPaged('/devices', ['views' => 'BASIC']);
        });
    }

    /**
     * Whole-fleet active client list. We only consume id / radio_type / os_type
     * / ssid in the dashboard, so request just those fields instead of the
     * FULL view — much smaller pages = faster paging on large client fleets.
     */
    public function getActiveClients(int $cacheTtl = 60): array {
        return $this->cached('clients_active', $cacheTtl, function () {
            return $this->getPaged('/clients/active', ['fields' => 'ID,RADIO_TYPE,OS_TYPE,SSID']);
        });
    }

    /**
     * Resolve a XIQ device by serial, hostname, and/or MAC address.
     *
     * Strategy: hit GET /devices once per available identifier (sns,
     * hostnames, macAddresses) and intersect the candidate sets. A device
     * id that comes back from MORE than one filter is the strongest match
     * because it agrees on independent identifiers — that's how we avoid
     * resolving e.g. an AP that happens to share a hostname with a
     * switch. Ties are broken in order serial > MAC > hostname (most
     * canonical first).
     *
     * Once we've picked the best candidate, we re-fetch it via the
     * single-device endpoint (GET /devices/{id}) — this serves two
     * purposes: (a) confirms the id actually resolves on its own (the
     * filtered list endpoint occasionally returns stale rows under
     * device-renames / re-onboards), and (b) gives us the freshest copy
     * of `connected` / `last_connect_time_ms` for the identity card.
     *
     * Cross-checks are recorded on the returned row under the special
     * `__match` key so callers (and the ?debug=1 path) can surface what
     * identifiers actually agreed.
     *
     * Cached 5 min under "find:<sha1(hostname|serial|mac)>" since the
     * mapping is stable — switches rarely change name or get re-
     * onboarded in XIQ.
     *
     * @param string $hostname  Zabbix host technical name.
     * @param string $serial    Inventory serial (most reliable identifier).
     * @param string $mac       MAC address (colon-less or colon-separated).
     * @return array<string,mixed>|null
     */
    public function findDevice(string $hostname, string $serial = '', string $mac = '', int $cacheTtl = 300): ?array {
        $hostname = trim($hostname);
        $serial   = trim($serial);
        $macClean = strtoupper((string) preg_replace('/[^0-9A-Fa-f]/', '', trim($mac)));
        if (strlen($macClean) !== 12) $macClean = '';
        if ($hostname === '' && $serial === '' && $macClean === '') return null;

        $bucket = 'find:' . sha1($hostname . '|' . $serial . '|' . $macClean);
        $found = $this->cached($bucket, $cacheTtl, function () use ($hostname, $serial, $macClean) {
            $tryFilter = function (array $extra) {
                $query = http_build_query($extra + [
                    'page'  => 1,
                    'limit' => 25,
                    'views' => 'BASIC'
                ]);
                $resp = $this->getRaw('/devices?' . $query);
                $isList = is_array($resp) && (array_values($resp) === $resp);
                $rows = $resp['data'] ?? ($isList ? $resp : []);
                return is_array($rows) ? $rows : [];
            };

            // Gather candidates from every filter we can use. Each
            // candidate set is keyed by device id so duplicates from the
            // same filter don't double-count toward the agreement score.
            $bySerial   = []; $byHostname = []; $byMac = [];
            $rowById    = [];

            if ($serial !== '') {
                foreach ($tryFilter(['sns' => $serial]) as $r) {
                    if (!is_array($r) || empty($r['id'])) continue;
                    $id = (string) $r['id'];
                    $bySerial[$id] = true;
                    $rowById[$id]  = $r;
                }
            }
            if ($macClean !== '') {
                foreach ($tryFilter(['macAddresses' => $macClean]) as $r) {
                    if (!is_array($r) || empty($r['id'])) continue;
                    $id = (string) $r['id'];
                    $byMac[$id]   = true;
                    $rowById[$id] = $rowById[$id] ?? $r;
                }
            }
            if ($hostname !== '') {
                $candHosts = [$hostname];
                $lower = strtolower($hostname);
                if ($lower !== $hostname) $candHosts[] = $lower;
                foreach ($candHosts as $h) {
                    foreach ($tryFilter(['hostnames' => $h]) as $r) {
                        if (!is_array($r) || empty($r['id'])) continue;
                        $id = (string) $r['id'];
                        $byHostname[$id] = true;
                        $rowById[$id]    = $rowById[$id] ?? $r;
                    }
                }
            }

            if (!$rowById) return ['__not_found' => true];

            // Score each candidate by how many independent filters it
            // appeared in. Tie-break order: serial > MAC > hostname.
            $score = [];
            foreach ($rowById as $id => $_) {
                $score[$id] = (isset($bySerial[$id])   ? 1 : 0)
                            + (isset($byMac[$id])      ? 1 : 0)
                            + (isset($byHostname[$id]) ? 1 : 0);
            }
            uksort($score, function ($a, $b) use ($score, $bySerial, $byMac, $byHostname) {
                if ($score[$a] !== $score[$b]) return $score[$b] - $score[$a];
                if (isset($bySerial[$a])   !== isset($bySerial[$b]))   return isset($bySerial[$a])   ? -1 : 1;
                if (isset($byMac[$a])      !== isset($byMac[$b]))      return isset($byMac[$a])      ? -1 : 1;
                if (isset($byHostname[$a]) !== isset($byHostname[$b])) return isset($byHostname[$a]) ? -1 : 1;
                return 0;
            });
            $bestId = (string) array_key_first($score);

            // Verify the winner directly via GET /devices/{id}. This
            // gives us a fresh, authoritative copy of the device record
            // and catches the edge case where the filter endpoint
            // returned a stale id that no longer exists.
            try {
                $verified = $this->getJson('/devices/' . $bestId, []);
            } catch (\Throwable $e) {
                error_log('[tcs] /devices/{id} verify failed for ' . $bestId . ': ' . $e->getMessage());
                $verified = $rowById[$bestId];
            }
            if (!is_array($verified) || empty($verified['id'])) {
                $verified = $rowById[$bestId];
            }

            // Collect every sibling candidate that shares the SAME
            // hostname as the primary, minus the primary itself. Switch
            // stacks and re-onboarded devices often register multiple
            // XIQ device IDs under the same hostname; the wired-client
            // telemetry sometimes attaches to a sibling instead of the
            // record whose serial matched. The action layer fetches
            // clients/events for the union to avoid missing data.
            $primaryHost = strtolower((string) ($verified['hostname'] ?? $rowById[$bestId]['hostname'] ?? ''));
            $siblings = [];
            foreach ($rowById as $id => $row) {
                if ((string) $id === $bestId) continue;
                $rowHost = strtolower((string) ($row['hostname'] ?? ''));
                if ($primaryHost !== '' && $rowHost === $primaryHost) {
                    $siblings[] = [
                        'id'       => (int) ($row['id'] ?? 0),
                        'hostname' => (string) ($row['hostname'] ?? ''),
                        'serial'   => (string) ($row['serial_number'] ?? ''),
                        'model'    => (string) ($row['product_type'] ?? ''),
                        'function' => (string) ($row['device_function'] ?? ''),
                        'mac'      => (string) ($row['mac_address'] ?? '')
                    ];
                }
            }

            // Decorate with the cross-check info so the action can decide
            // whether to trust the match (and the ?debug=1 path can show it).
            $verified['__match'] = [
                'score'      => (int) ($score[$bestId] ?? 0),
                'by_serial'  => isset($bySerial[$bestId]),
                'by_mac'     => isset($byMac[$bestId]),
                'by_host'    => isset($byHostname[$bestId]),
                'candidates' => count($rowById),
                'verified'   => (string) ($verified['id'] ?? '') === $bestId,
                'siblings'   => $siblings
            ];
            return $verified;
        });

        if (!is_array($found) || ($found['__not_found'] ?? false)) return null;
        return $found;
    }

    /**
     * Fetch wired clients connected to one switch device via the main XIQ
     * Dashboard API.
     *
     * Endpoint: POST /dashboard/wired/client-health/grid
     * Query:    page=N&limit=100&sortField=MAC&sortOrder=ASC
     * Body:     { "device_ids": [<switchId>], "site_ids": [], "filter_field": [] }
     *
     * This is the public endpoint that returns the wired station list for
     * a switch — /clients/active is wireless-association centric and
     * returns 0 rows for switches even when the console shows attached
     * devices. Same base URL and token scope as the other Dashboard
     * endpoints (no separate Platform ONE service required).
     *
     * Pages through total_pages on the response so deployments with more
     * than `limit` clients on one switch still come back in full. Returns
     * the flat data rows.
     *
     * @return array<int, array<string,mixed>>
     */
    public function getWiredClientsForDevice(int $deviceId, int $limit = 100, int $maxPages = 5): array {
        [$rows, ] = $this->getWiredClientsForDeviceDetailed($deviceId, $limit, $maxPages);
        return $rows;
    }

    /**
     * Same as {@see getWiredClientsForDevice()} but also returns XIQ's
     * first-page envelope so callers can see total_count / total_pages /
     * any non-data fields (used by the debug diagnostics path).
     *
     * @return array{0: array<int,array<string,mixed>>, 1: array<string,mixed>}
     */
    public function getWiredClientsForDeviceDetailed(int $deviceId, int $limit = 100, int $maxPages = 5): array {
        if ($deviceId <= 0) return [[], []];
        $limit = max(1, min(100, $limit));   // /dashboard/wired/client-health/grid caps limit at 100

        $body = [
            'device_ids'   => [$deviceId],
            'site_ids'     => [],
            'filter_field' => []
        ];

        $first = $this->postJson('/dashboard/wired/client-health/grid', [
            'page'      => 1,
            'limit'     => $limit,
            'sortField' => 'MAC',
            'sortOrder' => 'ASC'
        ], $body);
        $rows = $first['data'] ?? [];
        if (!is_array($rows)) $rows = [];
        $all = $rows;

        $totalPages = (int) ($first['total_pages'] ?? 0);
        $last       = min($totalPages, $maxPages);
        for ($p = 2; $p <= $last; $p++) {
            $resp = $this->postJson('/dashboard/wired/client-health/grid', [
                'page'      => $p,
                'limit'     => $limit,
                'sortField' => 'MAC',
                'sortOrder' => 'ASC'
            ], $body);
            $more = $resp['data'] ?? [];
            if (!is_array($more) || !$more) break;
            foreach ($more as $r) $all[] = $r;
            if (count($more) < $limit) break;
        }
        // Strip data from the returned envelope to keep the meta small.
        $meta = $first;
        unset($meta['data']);
        return [$all, is_array($meta) ? $meta : []];
    }

    /**
     * List of network policies (id + name). Use as the seed for SSID rollups
     * via XIQClient::getPolicySsids($policyId).
     */
    public function getNetworkPolicies(int $cacheTtl = 600): array {
        return $this->cached('policies', $cacheTtl, function () {
            return $this->getPaged('/network-policies', []);
        });
    }

    /**
     * Whole-fleet wireless usage & capacity grid (POST, paged).
     *
     * Each row exposes the fields we need for the Band Health card:
     *   device_id, hostname, mac_address, site, building, floor,
     *   radio_5g_utilization_score (0–100), wifi1_noise (dBm),
     *   wifi1_interference_score, wifi1_packet_loss, wifi1_retry_score,
     *   healthy_clients, unhealthy_clients,
     *   has_usage_capacity_issue, link_error5g
     *
     * Requires the "Dashboard" API scope on the bearer token. The 7,500-
     * req/hr quota easily absorbs ceil(879/100)=9 paged calls per cache
     * miss; we wrap in the bridge's 5-min APCu cache so steady-state cost
     * is zero.
     */
    public function getUsageCapacityGrid(int $cacheTtl = 0, string $sortField = 'RADIO_5G_UTILIZATION_SCORE'): array {
        $bucket = 'ucGrid_' . $sortField;
        return $this->cached($bucket, $cacheTtl, function () use ($sortField) {
            $path = '/dashboard/wireless/usage-capacity/grid';
            $mkQuery = fn(int $page) => [
                'page'      => $page,
                'limit'     => self::PAGE_LIMIT,
                'sortField' => $sortField,
                'sortOrder' => 'DESC',
            ];

            // Page 1 — also tells us total_pages.
            $first = $this->postJson($path, $mkQuery(1), new \stdClass());
            $firstRows = $first['data'] ?? [];
            if (!is_array($firstRows) || !$firstRows) return [];

            $all = $firstRows;
            $totalPages = (int) ($first['total_pages'] ?? 0);

            if ($totalPages > 1) {
                // Parallel-fetch pages 2..N via curl_multi.
                $last = min($totalPages, self::MAX_PAGES);
                $reqs = [];
                for ($p = 2; $p <= $last; $p++) {
                    $url = self::BASE_URL . $path . '?' . http_build_query($mkQuery($p));
                    $reqs[$p] = ['method' => 'POST', 'url' => $url, 'body' => new \stdClass(), 'label' => 'usage-capacity?page=' . $p];
                }
                foreach ($this->multiJson($reqs) as $resp) {
                    $rows = $resp['data'] ?? [];
                    if (!is_array($rows)) continue;
                    foreach ($rows as $r) $all[] = $r;
                }
                return $all;
            }

            if ($totalPages === 0 && count($firstRows) >= self::PAGE_LIMIT) {
                // No total_pages metadata — sequential fallback.
                $page = 2;
                do {
                    $resp = $this->postJson($path, $mkQuery($page), new \stdClass());
                    $rows = $resp['data'] ?? [];
                    if (!is_array($rows) || !$rows) break;
                    foreach ($rows as $r) $all[] = $r;
                    if (count($rows) < self::PAGE_LIMIT) break;
                    $page++;
                    if ($page > self::MAX_PAGES) break;
                } while (true);
            }

            return $all;
        });
    }

    /**
     * Per-AP current wireless interface snapshot.
     *
     * GET /d360/wireless/interfaces-stats — returns wifi0/wifi1/wifi2, each
     * with channel, channel_utilization, channel_width, number_of_clients,
     * channel_utilization_details. One snapshot value, not a time series.
     *
     * Time window must be at least 10 minutes per XIQ docs (G6); we pass
     * a 15-min trailing window like XIQClient::getWifiStats.
     */
    public function getInterfacesStats(int $deviceId): array {
        $end   = time();
        $start = $end - 900;
        return $this->getJson('/d360/wireless/interfaces-stats', [
            'deviceId'  => $deviceId,
            'startTime' => $start * 1000,
            'endTime'   => $end   * 1000,
        ]);
    }

    /**
     * Batched /d360/wireless/interfaces-stats. One call per device id,
     * dispatched in parallel via curl_multi. Failures per device are stored
     * as the literal string error so the caller can skip them — we don't want
     * one bad AP to take down the whole heatmap.
     *
     * @param array<int|string, int> $deviceIdsByKey
     * @return array<int|string, array|string>  decoded array on success, error string on failure
     */
    public function getInterfacesStatsMulti(array $deviceIdsByKey): array {
        if (!$deviceIdsByKey) return [];
        $end   = time();
        $start = $end - 900;
        $reqs = [];
        foreach ($deviceIdsByKey as $k => $deviceId) {
            $query = http_build_query([
                'deviceId'  => (int) $deviceId,
                'startTime' => $start * 1000,
                'endTime'   => $end   * 1000,
            ]);
            $url = self::BASE_URL . '/d360/wireless/interfaces-stats?' . $query;
            $reqs[$k] = ['method' => 'GET', 'url' => $url, 'label' => 'interfaces-stats[' . $deviceId . ']'];
        }
        return $this->multiJsonLenient($reqs);
    }

    // ── Internals ────────────────────────────────────────────────────────────

    /** @param callable():array $producer */
    private function cached(string $bucket, int $ttl, callable $producer): array {
        $key = self::CACHE_PREFIX . $bucket;
        if ($ttl > 0 && function_exists('apcu_fetch')) {
            $hit = apcu_fetch($key, $ok);
            if ($ok && is_array($hit)) return $hit;
        }
        $value = $producer();
        if ($ttl > 0 && function_exists('apcu_store')) {
            apcu_store($key, $value, $ttl);
        }
        return $value;
    }

    /**
     * Drain a paginated XIQ list endpoint. XIQ list responses follow one of
     * two shapes; we handle both:
     *   { data: [...], total_pages: N, page: M }                 (wrapped)
     *   [ ... ]                                                  (raw)
     *
     * Optimization: fetch page 1 sequentially to learn total_pages, then
     * dispatch pages 2..N in parallel via curl_multi. Falls back to the
     * sequential drain when the response is a raw list (no total_pages).
     */
    private function getPaged(string $path, array $query): array {
        // Page 1 — also tells us total_pages when XIQ wraps the list.
        $first      = $this->getJson($path, $query + ['page' => 1, 'limit' => self::PAGE_LIMIT]);
        $firstRows  = $first['data'] ?? (array_is_list($first) ? $first : []);
        if (!is_array($firstRows) || !$firstRows) return [];

        $all = $firstRows;
        $totalPages = (int) ($first['total_pages'] ?? 0);

        if ($totalPages > 1) {
            // Parallel-fetch the remaining pages.
            $last = min($totalPages, self::MAX_PAGES);
            $reqs = [];
            for ($p = 2; $p <= $last; $p++) {
                $url = self::BASE_URL . $path . '?' . http_build_query($query + ['page' => $p, 'limit' => self::PAGE_LIMIT]);
                $reqs[$p] = ['method' => 'GET', 'url' => $url, 'label' => $path . '?page=' . $p];
            }
            foreach ($this->multiJson($reqs) as $resp) {
                $rows = $resp['data'] ?? (array_is_list($resp) ? $resp : []);
                if (!is_array($rows)) continue;
                foreach ($rows as $r) $all[] = $r;
            }
            return $all;
        }

        if ($totalPages === 0) {
            // No total_pages metadata — fall back to a sequential drain that
            // stops on the first short page.
            if (count($firstRows) < self::PAGE_LIMIT) return $all;
            $page = 2;
            do {
                $resp = $this->getJson($path, $query + ['page' => $page, 'limit' => self::PAGE_LIMIT]);
                $rows = $resp['data'] ?? (array_is_list($resp) ? $resp : []);
                if (!is_array($rows) || !$rows) break;
                foreach ($rows as $r) $all[] = $r;
                if (count($rows) < self::PAGE_LIMIT) break;
                $page++;
                if ($page > self::MAX_PAGES) break;
            } while (true);
        }

        return $all;
    }

    /** @return array<string, mixed> */
    public function getJson(string $path, array $query): array {
        return $this->request('GET', $path, $query, null);
    }

    /**
     * GET with a pre-built `path?query` string. Use when array params need
     * a non-PHP-default encoding (e.g. repeated keys without `[]`).
     */
    public function getRaw(string $pathAndQuery): array {
        $url = self::BASE_URL . $pathAndQuery;
        $ch  = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_HTTPHEADER     => [
                'Authorization: Bearer ' . $this->token,
                'Accept: application/json',
            ],
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HEADER         => true,
            CURLOPT_TIMEOUT        => self::HTTP_TIMEOUT,
            CURLOPT_FOLLOWLOCATION => false,
        ]);
        return $this->execAndParse($ch, $pathAndQuery);
    }

    /** @return array<string, mixed> */
    public function postJson(string $path, array $query, $body): array {
        return $this->request('POST', $path, $query, $body);
    }

    /** @return array<string, mixed> */
    private function request(string $method, string $path, array $query, $body): array {
        $url = self::BASE_URL . $path . ($query ? '?' . http_build_query($query) : '');
        $ch  = curl_init($url);
        $headers = [
            'Authorization: Bearer ' . $this->token,
            'Accept: application/json',
        ];
        $opts = [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HEADER         => true,
            CURLOPT_TIMEOUT        => self::HTTP_TIMEOUT,
            CURLOPT_FOLLOWLOCATION => false,
        ];
        if ($method === 'POST') {
            $opts[CURLOPT_POST] = true;
            $opts[CURLOPT_POSTFIELDS] = json_encode($body ?? new \stdClass(), JSON_UNESCAPED_SLASHES);
            $headers[] = 'Content-Type: application/json';
        }
        $opts[CURLOPT_HTTPHEADER] = $headers;
        curl_setopt_array($ch, $opts);
        return $this->execAndParse($ch, $path);
    }

    private function execAndParse($ch, string $path): array {

        $raw = curl_exec($ch);
        if ($raw === false) {
            $err = curl_error($ch);
            curl_close($ch);
            throw new \RuntimeException("XIQ transport: $err");
        }
        $status     = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $headerSize = (int) curl_getinfo($ch, CURLINFO_HEADER_SIZE);
        curl_close($ch);

        $headers = (string) substr($raw, 0, $headerSize);
        $body    = (string) substr($raw, $headerSize);

        // RateLimit headers are advisory but cheap to track for the warning banner.
        if (preg_match('/^RateLimit-Remaining:\s*(\d+)/im', $headers, $m)) {
            $this->rateLimitRemaining = (int) $m[1];
        }
        if (preg_match('/^RateLimit-Reset:\s*(\d+)/im', $headers, $m)) {
            $this->rateLimitReset = (int) $m[1];
        }

        if ($status === 401) throw new \RuntimeException('XIQ 401 — token revoked or invalid');
        if ($status === 429) throw new \RuntimeException('XIQ 429 — rate limit exceeded');
        if ($status < 200 || $status >= 300) {
            $snip = substr($body, 0, 240);
            throw new \RuntimeException("XIQ HTTP $status on $path — $snip");
        }

        // Most XIQ endpoints return JSON objects/arrays, but a few count
        // endpoints (/clients/active/count, /devices/count) return a bare
        // integer as the response body. json_decode("42", true) → 42, which
        // is valid JSON. Wrap scalar results in a uniform shape so callers
        // can read $resp['count'] without special-casing per endpoint.
        $decoded = json_decode($body, true, 512, JSON_BIGINT_AS_STRING);
        if (is_int($decoded) || is_float($decoded) || (is_string($decoded) && ctype_digit($decoded))) {
            return ['count' => (int) $decoded, '__scalar' => true];
        }
        if (is_bool($decoded)) return ['value' => $decoded, '__scalar' => true];
        if (!is_array($decoded)) {
            throw new \RuntimeException('XIQ returned non-JSON body');
        }
        return $decoded;
    }

    // ── Parallel HTTP (curl_multi) ───────────────────────────────────────────

    /**
     * Run a batch of HTTP requests in parallel.
     *
     * @param array<int|string, array{method?:string,url:string,body?:mixed,label?:string}> $reqs
     * @param int $concurrency  Maximum simultaneous in-flight requests.
     * @return array<int|string, array{status:int,body:string,headers:string,error:?string,label:string}>
     *                                  Keyed identically to $reqs, in input order.
     */
    private function multiRun(array $reqs, int $concurrency = self::MULTI_CONCURRENCY): array {
        if (!$reqs) return [];
        $concurrency = max(1, $concurrency);

        $mh = curl_multi_init();
        $pending = $reqs;          // remaining keys to start
        $inflight = [];            // (int) $ch => ['handle' => ch, 'key' => k, 'label' => str]
        $results  = [];

        $startOne = function () use (&$pending, &$inflight, $mh) {
            if (!$pending) return false;
            $k = array_key_first($pending);
            $r = $pending[$k];
            unset($pending[$k]);

            $ch = curl_init($r['url']);
            $headers = [
                'Authorization: Bearer ' . $this->token,
                'Accept: application/json',
            ];
            $opts = [
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_HEADER         => true,
                CURLOPT_TIMEOUT        => self::HTTP_TIMEOUT,
                CURLOPT_FOLLOWLOCATION => false,
            ];
            if (($r['method'] ?? 'GET') === 'POST') {
                $opts[CURLOPT_POST] = true;
                $opts[CURLOPT_POSTFIELDS] = json_encode($r['body'] ?? new \stdClass(), JSON_UNESCAPED_SLASHES);
                $headers[] = 'Content-Type: application/json';
            }
            $opts[CURLOPT_HTTPHEADER] = $headers;
            curl_setopt_array($ch, $opts);

            curl_multi_add_handle($mh, $ch);
            $inflight[(int) $ch] = ['handle' => $ch, 'key' => $k, 'label' => $r['label'] ?? $r['url']];
            return true;
        };

        // Prime the window.
        for ($i = 0; $i < $concurrency; $i++) {
            if (!$startOne()) break;
        }

        do {
            do { $mrc = curl_multi_exec($mh, $active); } while ($mrc === CURLM_CALL_MULTI_PERFORM);

            if ($active || $pending) {
                // Wait for activity. Older libcurl returns -1 on select; clamp to a short sleep.
                if (curl_multi_select($mh, 1.0) === -1) usleep(50_000);
            }

            while ($info = curl_multi_info_read($mh)) {
                $ch   = $info['handle'];
                $key  = (int) $ch;
                $meta = $inflight[$key] ?? null;
                if ($meta === null) {
                    curl_multi_remove_handle($mh, $ch);
                    curl_close($ch);
                    continue;
                }

                $raw = curl_multi_getcontent($ch);
                $err = null;
                if ($info['result'] !== CURLM_OK) {
                    $err = curl_error($ch) ?: ('cURL multi error ' . $info['result']);
                } elseif ($raw === null || $raw === false) {
                    $err = curl_error($ch) ?: 'empty response';
                }

                $statusCode = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
                $headerSize = (int) curl_getinfo($ch, CURLINFO_HEADER_SIZE);
                $headersStr = is_string($raw) ? (string) substr($raw, 0, $headerSize) : '';
                $body       = is_string($raw) ? (string) substr($raw, $headerSize) : '';

                // Rate-limit tracking — keep the lowest remaining seen this batch.
                if (preg_match('/^RateLimit-Remaining:\s*(\d+)/im', $headersStr, $m)) {
                    $r = (int) $m[1];
                    if ($this->rateLimitRemaining < 0 || $r < $this->rateLimitRemaining) {
                        $this->rateLimitRemaining = $r;
                    }
                }
                if (preg_match('/^RateLimit-Reset:\s*(\d+)/im', $headersStr, $m)) {
                    $this->rateLimitReset = (int) $m[1];
                }

                $results[$meta['key']] = [
                    'status'  => $statusCode,
                    'body'    => $body,
                    'headers' => $headersStr,
                    'error'   => $err,
                    'label'   => $meta['label'],
                ];

                unset($inflight[$key]);
                curl_multi_remove_handle($mh, $ch);
                curl_close($ch);

                $startOne();
            }
        } while ($active || $pending);

        curl_multi_close($mh);

        // Re-order to input order.
        $ordered = [];
        foreach (array_keys($reqs) as $k) {
            if (array_key_exists($k, $results)) $ordered[$k] = $results[$k];
        }
        return $ordered;
    }

    /**
     * Batch of HTTP requests → keyed array of decoded JSON. Throws on any failure
     * (transport, non-2xx, non-JSON body) so callers see the same error contract
     * as the single-request {@see execAndParse}.
     *
     * @param array<int|string, array{method?:string,url:string,body?:mixed,label?:string}> $reqs
     * @return array<int|string, array<string, mixed>>
     */
    private function multiJson(array $reqs): array {
        $out = [];
        foreach ($this->multiRun($reqs) as $k => $r) {
            $label = $r['label'];
            if ($r['error'] !== null)                    throw new \RuntimeException("XIQ transport ($label): {$r['error']}");
            if ($r['status'] === 401)                    throw new \RuntimeException('XIQ 401 — token revoked or invalid');
            if ($r['status'] === 429)                    throw new \RuntimeException('XIQ 429 — rate limit exceeded');
            if ($r['status'] < 200 || $r['status'] >= 300) {
                $snip = substr($r['body'], 0, 240);
                throw new \RuntimeException("XIQ HTTP {$r['status']} on $label — $snip");
            }
            $decoded = json_decode($r['body'], true);
            if (!is_array($decoded)) throw new \RuntimeException("XIQ non-JSON body on $label");
            $out[$k] = $decoded;
        }
        return $out;
    }

    /**
     * Like {@see multiJson} but returns a string error per failed entry instead
     * of throwing. Useful when one bad subrequest shouldn't take down the batch
     * (e.g. one offline AP shouldn't drop the whole channel heatmap).
     *
     * @return array<int|string, array<string, mixed>|string>
     */
    private function multiJsonLenient(array $reqs): array {
        $out = [];
        foreach ($this->multiRun($reqs) as $k => $r) {
            $label = $r['label'];
            if ($r['error'] !== null) {
                $out[$k] = "transport: {$r['error']}";
                continue;
            }
            if ($r['status'] === 401) throw new \RuntimeException('XIQ 401 — token revoked or invalid');
            if ($r['status'] === 429) throw new \RuntimeException('XIQ 429 — rate limit exceeded');
            if ($r['status'] < 200 || $r['status'] >= 300) {
                $out[$k] = "HTTP {$r['status']}: " . substr($r['body'], 0, 200);
                continue;
            }
            $decoded = json_decode($r['body'], true);
            if (!is_array($decoded)) { $out[$k] = 'non-JSON body'; continue; }
            $out[$k] = $decoded;
        }
        return $out;
    }
}
