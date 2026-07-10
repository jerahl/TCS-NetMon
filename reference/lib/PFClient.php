<?php declare(strict_types=1);

namespace Modules\TcsDashboard\Lib;

/**
 * PacketFence v15 REST client.
 *
 * Modeled on the apdetail/includes/PFClient.php surface documented in
 * notes/lift-manifest.md §C — same constructor signature, same factory
 * (fromMacros), same call-sites in ActionDashboard. When the verbatim
 * 984-line lift lands, drop this file and keep the same public methods.
 *
 * Features:
 *   - Token login + auto-refresh on 401 (retries once)
 *   - APCu cache for the bearer token with a filesystem fallback so the
 *     same token is shared across PHP requests (configurable TTL)
 *   - Per-call connect/total timeouts and explicit User-Agent
 *   - TLS verification on by default; opt-out via constructor flag
 *   - Helpers for the dashboard surfaces consumed by the React tabs pane:
 *     nodes, locationlog, radius audit, fingerbank category lookup
 *
 * PHP 8.0 carry-forward: include array_is_list polyfill (AP G21) so the
 * file is drop-in compatible with the apdetail lift target.
 */
class PFClient {

    private string $url;
    private string $user;
    private string $pass;
    private bool   $verifySsl;

    private ?string $token = null;
    private int     $tokenExpiry = 0;

    /** Seconds. Tokens are re-used until either expiry or a 401 forces refresh. */
    private const TOKEN_TTL_DEFAULT = 1800;

    private const TIMEOUT_CONNECT = 10;
    private const TIMEOUT_TOTAL   = 30;
    private const UA              = 'TcsDashboard/1.0 (+PFClient)';

    /** Cache namespace for APCu / filesystem fallback. */
    private const CACHE_PREFIX = 'tcs_pf_token::';
    private const CACHE_DIR    = '/tmp/tcs_dashboard_cache';

    public function __construct(
        string $url,
        string $user,
        #[\SensitiveParameter] string $pass,
        bool $verifySsl = true
    ) {
        self::ensureArrayIsListPolyfill();

        $this->url       = rtrim($url, '/');
        $this->user      = $user;
        $this->pass      = $pass;
        $this->verifySsl = $verifySsl;
    }

    /**
     * @param array{url:string,user:string,pass:string,verify_ssl?:bool} $cfg
     */
    public static function fromMacros(array $cfg): self {
        return new self(
            (string) ($cfg['url']  ?? ''),
            (string) ($cfg['user'] ?? ''),
            (string) ($cfg['pass'] ?? ''),
            (bool)   ($cfg['verify_ssl'] ?? true)
        );
    }

    /* ------------------------------------------------------------------ */
    /* Public surface — what ActionDashboard / the tabs UI consumes       */
    /* ------------------------------------------------------------------ */

    /**
     * Currently-associated clients on a switch / AP, keyed by the device's
     * IP. Result shape matches the rows window.PF_CLIENTS expects
     * (assets/tabs.jsx).
     *
     * Uses POST /api/v1/locationlogs/search filtered to open sessions
     * (end_time = '0000-00-00 00:00:00'). The /api/v1/nodes listing PF
     * exposes does NOT accept locationlog.* filter params — it silently
     * ignores them and returns nodes for the entire cluster, which is
     * how this method previously over-reported by 200 rows.
     *
     * @return array<int, array<string, mixed>>
     */
    public function clientsForNode(string $deviceIp, int $limit = 200): array {
        $body = [
            'cursor' => 0,
            'limit'  => max(1, $limit),
            'sort'   => ['start_time DESC'],
            'fields' => [
                'mac', 'switch', 'switch_ip', 'port', 'vlan', 'role',
                'ssid', 'connection_type', 'connection_sub_type',
                'dot1x_username', 'realm', 'ifDesc', 'start_time', 'end_time'
            ],
            'query'  => [
                'op' => 'and',
                'values' => [
                    ['op' => 'equals', 'field' => 'switch_ip', 'value' => $deviceIp],
                    ['op' => 'equals', 'field' => 'end_time',  'value' => '0000-00-00 00:00:00'],
                ]
            ]
        ];
        try {
            $rows = $this->call('POST', '/api/v1/locationlogs/search', [], $body);
        } catch (\RuntimeException $e) {
            // PF answers 404 instead of 200+empty when nothing matches.
            if (str_contains($e->getMessage(), 'HTTP 404')) return [];
            throw $e;
        }

        $out = [];
        foreach (($rows['items'] ?? []) as $r) {
            $out[] = [
                'mac'      => (string) ($r['mac'] ?? ''),
                'name'     => '',
                'ip'       => '',
                'port'     => (string) ($r['port'] ?? ($r['ifDesc'] ?? '')),
                'ssid'     => (string) ($r['ssid'] ?? ''),
                'vlan'     => (string) ($r['vlan'] ?? ''),
                'role'     => (string) ($r['role'] ?? ''),
                'user'     => (string) ($r['dot1x_username'] ?? ''),
                'auth'     => (string) ($r['connection_sub_type'] ?? ($r['connection_type'] ?? '')),
                'status'   => '',
                'category' => '',
                'lastSeen' => (string) ($r['start_time'] ?? '')
            ];
        }
        return $out;
    }

    /**
     * Rich per-node detail for an explicit list of MACs. Returns the full
     * field set the Port Detail card consumes, keyed by lowercased MAC.
     *
     * PF v11+ doesn't support filtering /api/v1/nodes by `locationlog.switch`
     * (locationlog is a separate table linked by MAC), so the working pf_device
     * reference resolves the per-switch MAC list out-of-band (FDB / bridge
     * table on the switch) and looks each MAC up here. We do the same — the
     * FDB already comes back in the snapshot via SwitchClient.
     *
     * Uses POST /api/v1/nodes/search with an OR'd MAC-equals query.
     *
     * @param array<int, string> $macs
     * @return array<string, array<string, mixed>>  keyed by lowercased MAC
     */
    public function nodesByMac(array $macs): array {
        $clean = [];
        foreach ($macs as $m) {
            $norm = self::canonMac((string) $m);
            if ($norm === '') continue;
            $clean[$norm] = true;
        }
        if (!$clean) return [];
        $list = array_keys($clean);

        // PF's nodes/search builds one SQL clause per OR value. Some PF
        // deployments 400 (or silently truncate) when the OR clause list
        // gets huge — a 600-port switch with a packed FDB would happily
        // push the request past whatever ceiling each version enforces.
        // Chunk into batches so each request stays well under the limit
        // and one oversized switch can't blank the whole port-detail
        // pane. Per-batch failures degrade gracefully: log and keep
        // whatever the surviving batches returned.
        $out = [];
        foreach (array_chunk($list, 100) as $batch) {
            $clauses = array_map(fn($m) => [
                'op'    => 'equals',
                'field' => 'mac',
                'value' => $m
            ], $batch);

            $body = [
                'cursor' => 0,
                'limit'  => max(25, count($batch) + 10),
                'sort'   => ['mac ASC'],
                'fields' => [
                    'mac', 'pid', 'computername', 'status', 'category_id',
                    'device_class', 'device_type', 'device_manufacturer', 'device_version',
                    'dhcp_fingerprint', 'dhcp_vendor',
                    'last_seen', 'last_arp', 'last_dhcp',
                    'ip4log.ip'
                ],
                'query'  => count($clauses) === 1
                    ? $clauses[0]
                    : ['op' => 'or', 'values' => $clauses]
            ];

            try {
                $rows = $this->call('POST', '/api/v1/nodes/search', [], $body);
            } catch (\RuntimeException $e) {
                // PF answers 404 instead of 200+empty when nothing matches.
                if (str_contains($e->getMessage(), 'HTTP 404')) {
                    error_log('[tcs_dashboard] PFClient::nodesByMac: batch of '.count($batch).' MACs returned 404 (no matches)');
                    continue;
                }
                error_log('[tcs_dashboard] PFClient::nodesByMac: batch of '.count($batch).' MACs failed: '.$e->getMessage());
                continue;
            }

            $items = $rows['items'] ?? [];
            foreach ($items as $r) {
                // Re-canonicalize the response MAC to the same colon-lower
                // form the FDB uses. PF normally returns aa:bb:cc:dd:ee:ff,
                // but a misconfigured Inverse install or a v8/v9 carry-over
                // can return AABBCCDDEEFF or aabbccddeeff — that would
                // make $out[$mac] miss the FDB-side lookup key entirely.
                $mac = self::canonMac((string) ($r['mac'] ?? ''));
                if ($mac === '') continue;
                $out[$mac] = [
                    'mac'      => $mac,
                    'host'     => (string) ($r['computername'] ?? ''),
                    'ip'       => (string) ($r['ip4log.ip'] ?? ''),
                    'reg'      => strtolower((string) ($r['status'] ?? '')) === 'reg' ? 'REG' : 'UNREG',
                    'role'     => (string) ($r['category_id'] ?? ''),
                    'vendor'   => (string) ($r['device_manufacturer'] ?? $r['device_class'] ?? ''),
                    'os'       => (string) ($r['device_type'] ?? ($r['device_class'] ?? '')),
                    'owner'    => (string) ($r['pid'] ?? ''),
                    'dhcpFp'   => (string) ($r['dhcp_fingerprint'] ?? $r['dhcp_vendor'] ?? ''),
                    'lastSeen' => (string) ($r['last_seen'] ?? ''),
                    'lastArp'  => (string) ($r['last_arp'] ?? ''),
                    'lastDhcp' => (string) ($r['last_dhcp'] ?? '')
                ];
            }
        }

        error_log(sprintf(
            '[tcs_dashboard] PFClient::nodesByMac: requested %d unique MAC(s), matched %d',
            count($list), count($out)
        ));
        return $out;
    }

    /**
     * Strip any non-hex character and re-emit aa:bb:cc:dd:ee:ff. Mirrors
     * SwitchClient::normalizeMac() so both sides of the FDB ↔ PF join
     * land on the same canonical key regardless of how either upstream
     * formats the MAC. Returns '' when the input doesn't contain exactly
     * 12 hex digits.
     */
    private static function canonMac(string $mac): string {
        $hex = strtolower(preg_replace('/[^0-9a-fA-F]/', '', $mac) ?? '');
        if (strlen($hex) !== 12) return '';
        return implode(':', str_split($hex, 2));
    }

    /**
     * Free-text node search for the global command palette. Matches the
     * fragment against MAC, computername (hostname), and pid (owner /
     * 802.1X username) with PF's `contains` operator, OR'd together.
     *
     * Returns the same row shape as {@see nodesByMac}, keyed by lowercased
     * MAC, so callers can enrich with locationlog (switch / port) the same
     * way.
     *
     * @return array<string, array<string, mixed>>  keyed by lowercased MAC
     */
    public function searchNodesText(string $q, int $limit = 25): array {
        $q = trim($q);
        if ($q === '') return [];

        $clauses = [
            ['op' => 'contains', 'field' => 'mac',          'value' => strtolower($q)],
            ['op' => 'contains', 'field' => 'computername', 'value' => $q],
            ['op' => 'contains', 'field' => 'pid',          'value' => $q],
        ];

        $body = [
            'cursor' => 0,
            'limit'  => max(1, $limit),
            'sort'   => ['mac ASC'],
            'fields' => [
                'mac', 'pid', 'computername', 'status', 'category_id',
                'device_class', 'device_type', 'device_manufacturer', 'device_version',
                'dhcp_fingerprint', 'dhcp_vendor',
                'last_seen', 'last_arp', 'last_dhcp',
                'ip4log.ip'
            ],
            'query'  => ['op' => 'or', 'values' => $clauses]
        ];

        try {
            $rows = $this->call('POST', '/api/v1/nodes/search', [], $body);
        } catch (\RuntimeException $e) {
            // PF answers 404 instead of 200+empty when nothing matches.
            if (str_contains($e->getMessage(), 'HTTP 404')) return [];
            throw $e;
        }

        $out = [];
        foreach (($rows['items'] ?? []) as $r) {
            $mac = strtolower((string) ($r['mac'] ?? ''));
            if ($mac === '') continue;
            $out[$mac] = [
                'mac'      => $mac,
                'host'     => (string) ($r['computername'] ?? ''),
                'ip'       => (string) ($r['ip4log.ip'] ?? ''),
                'reg'      => strtolower((string) ($r['status'] ?? '')) === 'reg' ? 'REG' : 'UNREG',
                'role'     => (string) ($r['category_id'] ?? ''),
                'vendor'   => (string) ($r['device_manufacturer'] ?? $r['device_class'] ?? ''),
                'os'       => (string) ($r['device_type'] ?? ($r['device_class'] ?? '')),
                'owner'    => (string) ($r['pid'] ?? ''),
                'dhcpFp'   => (string) ($r['dhcp_fingerprint'] ?? $r['dhcp_vendor'] ?? ''),
                'lastSeen' => (string) ($r['last_seen'] ?? ''),
                'lastArp'  => (string) ($r['last_arp'] ?? ''),
                'lastDhcp' => (string) ($r['last_dhcp'] ?? '')
            ];
        }
        return $out;
    }

    /* ------------------------------------------------------------------ */
    /* Write actions                                                      */
    /* ------------------------------------------------------------------ */

    /**
     * Re-evaluate access (role / vlan / acls) for a node. PF re-runs its
     * registration / role-mapping rules and triggers a CoA so the switch
     * sees the new role without the operator having to bounce the port.
     *
     * @return array{ok:bool, message:string}
     */
    public function reevaluateAccess(string $mac): array {
        return $this->nodeAction($mac, 'reevaluate_access');
    }

    /**
     * Restart the switch port the node is currently learned on. PF uses
     * its switches.conf SNMP credentials to shutdown / no-shutdown the
     * port, which forces the supplicant to re-auth.
     *
     * @return array{ok:bool, message:string}
     */
    public function restartSwitchport(string $mac): array {
        return $this->nodeAction($mac, 'restart_switchport');
    }

    /**
     * Shared plumbing for the per-node POST actions. PF returns a JSON
     * body with a `message` field on success; on failure the message
     * comes back in `message` or `errors[]`.
     *
     * @return array{ok:bool, message:string}
     */
    private function nodeAction(string $mac, string $op): array {
        $mac = strtolower(trim($mac));
        if ($mac === '') {
            return ['ok' => false, 'message' => 'mac required'];
        }
        // PF v11+ exposes per-node actions under both /api/v1/node/<mac>/<op>
        // and /api/v1/nodes/<mac>/<op>. The singular `node` form is the
        // documented action endpoint.
        try {
            $resp = $this->call('POST', '/api/v1/node/'.rawurlencode($mac).'/'.$op, [], null);
        }
        catch (\Throwable $e) {
            return ['ok' => false, 'message' => $e->getMessage()];
        }
        $msg = (string) ($resp['message'] ?? $resp['status_msg'] ?? '');
        if ($msg === '' && isset($resp['errors']) && is_array($resp['errors'])) {
            $msg = (string) ($resp['errors'][0]['message'] ?? '');
        }
        return ['ok' => true, 'message' => $msg !== '' ? $msg : 'ok'];
    }

    /**
     * Map of node category id (string) → human role name. PF stores roles
     * on /nodes as `category_id` (numeric) and only sometimes surfaces the
     * label on locationlog.role; this endpoint is the canonical id-to-name
     * dictionary.
     *
     * @return array<string, string>
     */
    public function nodeCategories(): array {
        try {
            $rows = $this->get('/api/v1/node_categories', ['limit' => 500]);
        } catch (\Throwable) {
            return [];
        }
        $out = [];
        foreach (($rows['items'] ?? []) as $r) {
            $id   = (string) ($r['category_id'] ?? $r['id'] ?? '');
            $name = (string) ($r['name'] ?? '');
            if ($id !== '' && $name !== '') {
                $out[$id] = $name;
            }
        }
        return $out;
    }

    /**
     * Latest locationlog entry per MAC — gives us the human role name,
     * 802.1X username, VLAN, SSID, switch port, and ifDesc that the
     * /nodes endpoint doesn't carry (nodes only has category_id, which
     * is the numeric internal id, not the role label).
     *
     * One OR'd POST to /api/v1/locationlogs/search, sorted newest first,
     * deduped to the first hit per MAC on the way out.
     *
     * @param array<int, string> $macs
     * @return array<string, array<string, mixed>>  keyed by lowercased MAC
     */
    public function locationsByMac(array $macs): array {
        $clean = [];
        foreach ($macs as $m) {
            $norm = self::canonMac((string) $m);
            if ($norm !== '') $clean[$norm] = true;
        }
        if (!$clean) return [];
        $list = array_keys($clean);

        $out = [];
        foreach (array_chunk($list, 100) as $batch) {
            $clauses = array_map(fn($m) => [
                'op'    => 'equals',
                'field' => 'mac',
                'value' => $m
            ], $batch);

            $body = [
                'cursor' => 0,
                // Buffer for stale entries; one MAC can have many locationlog rows.
                'limit'  => max(100, count($batch) * 4),
                'sort'   => ['start_time DESC'],
                'fields' => [
                    'mac', 'switch', 'switch_ip', 'port', 'vlan', 'role',
                    'ssid', 'connection_type', 'connection_sub_type',
                    'dot1x_username', 'realm', 'ifDesc', 'start_time', 'end_time'
                ],
                'query' => count($clauses) === 1
                    ? $clauses[0]
                    : ['op' => 'or', 'values' => $clauses]
            ];

            try {
                $rows = $this->call('POST', '/api/v1/locationlogs/search', [], $body);
            } catch (\RuntimeException $e) {
                if (str_contains($e->getMessage(), 'HTTP 404')) continue;
                error_log('[tcs_dashboard] PFClient::locationsByMac: batch of '.count($batch).' MACs failed: '.$e->getMessage());
                continue;
            }

            // Sorted DESC by start_time — first hit per MAC wins across batches.
            foreach (($rows['items'] ?? []) as $r) {
                $mac = self::canonMac((string) ($r['mac'] ?? ''));
                if ($mac === '' || isset($out[$mac])) continue;
                $out[$mac] = $r;
            }
        }
        return $out;
    }

    /**
     * Recent 802.1X auth failures (radius_audit_logs filtered to reject).
     *
     * Filters by `nas_ip_address` — the IP of the NAS (AP / switch) that
     * initiated the RADIUS request. Callers must pass the device's IP,
     * not its MAC or hostname.
     *
     * @return array<int, array<string, mixed>>
     */
    public function authFailuresForNode(string $deviceId, int $limit = 50): array {
        // PF's /search endpoint requires the `query` field, returns 404
        // ("entries not found") when zero rows match, and only accepts
        // the `equals` / `contains` operator family (NOT `is`).
        $body = [
            'cursor' => 0,
            'limit'  => max(1, $limit),
            'sort'   => ['created_at DESC'],
            'fields' => [
                'mac', 'user_name', 'nas_ip_address', 'nas_port_id',
                'auth_status', 'reason', 'created_at'
            ],
            'query'  => [
                'op' => 'and',
                'values' => [
                    ['op' => 'equals', 'field' => 'auth_status',    'value' => 'reject'],
                    ['op' => 'equals', 'field' => 'nas_ip_address', 'value' => $deviceId],
                ]
            ]
        ];
        try {
            $rows = $this->call('POST', '/api/v1/radius_audit_logs/search', [], $body);
        } catch (\RuntimeException $e) {
            // PF answers 404 instead of 200+empty when nothing matches.
            if (str_contains($e->getMessage(), 'HTTP 404')) return [];
            throw $e;
        }

        $out = [];
        foreach (($rows['items'] ?? []) as $r) {
            $out[] = [
                'mac'    => (string) ($r['mac'] ?? ''),
                'user'   => (string) ($r['user_name'] ?? ''),
                'port'   => (string) ($r['nas_port_id'] ?? ''),
                'reason' => (string) ($r['reason'] ?? ''),
                'ts'     => (string) ($r['created_at'] ?? '')
            ];
        }
        return $out;
    }

    /**
     * Lookup a single node by MAC. Returns null when the node isn't known.
     *
     * @return array<string, mixed>|null
     */
    public function node(string $mac): ?array {
        $rows = $this->get('/api/v1/nodes/'.rawurlencode($mac), []);
        $item = $rows['item'] ?? $rows;
        return is_array($item) && !empty($item) ? $item : null;
    }

    /**
     * Recent locationlog rows for a single MAC, newest first.
     *
     * Unlike {@see locationsByMac} this does NOT dedupe — callers need to
     * see the full history to filter for the *correct* row (still-open
     * session, wired connection, sane port string). Same field list as
     * locationsByMac so consumers can share their row-shape assumptions.
     *
     * @return array<int, array<string, mixed>>
     */
    public function recentLocationsForMac(string $mac, int $limit = 20): array {
        $mac = strtolower(trim($mac));
        if ($mac === '') return [];
        $body = [
            'cursor' => 0,
            'limit'  => max(1, $limit),
            'sort'   => ['start_time DESC'],
            'fields' => [
                'mac', 'switch', 'switch_ip', 'switch_mac', 'port', 'vlan', 'role',
                'ssid', 'connection_type', 'connection_sub_type',
                'dot1x_username', 'realm', 'ifDesc', 'start_time', 'end_time'
            ],
            'query'  => ['op' => 'equals', 'field' => 'mac', 'value' => $mac]
        ];
        $rows = $this->call('POST', '/api/v1/locationlogs/search', [], $body);
        $items = $rows['items'] ?? [];
        return is_array($items) ? $items : [];
    }

    /**
     * Fingerbank device-class label for a MAC, if PF has fingerprinted it.
     */
    public function fingerbankCategory(string $mac): ?string {
        try {
            $row = $this->get('/api/v1/fingerbank/local/device/'.rawurlencode($mac), []);
            $name = $row['item']['name'] ?? ($row['name'] ?? null);
            return is_string($name) && $name !== '' ? $name : null;
        }
        catch (\Throwable) {
            return null;
        }
    }

    /* ------------------------------------------------------------------ */
    /* HTTP plumbing                                                      */
    /* ------------------------------------------------------------------ */

    /**
     * @param array<string, mixed> $query
     * @return array<string, mixed>
     */
    private function get(string $path, array $query): array {
        return $this->call('GET', $path, $query, null);
    }

    /**
     * Run the call. Refreshes the token once on 401 and retries.
     *
     * @param array<string, mixed> $query
     * @param array<string, mixed>|null $body
     * @return array<string, mixed>
     */
    private function call(string $method, string $path, array $query, ?array $body): array {
        $this->ensureToken();

        [$status, $payload] = $this->raw($method, $path, $query, $body, [
            // PF accepts the raw token (no "Bearer " prefix) — confirmed against the
            // pf_device reference client in jerahl/ZabbixSwitchPortWidgets.
            'Authorization: '.($this->token ?? '')
        ]);

        if ($status === 401) {
            // Token may have been revoked / expired server-side. Force one refresh.
            $this->token = null;
            $this->tokenExpiry = 0;
            $this->forgetCachedToken();
            $this->ensureToken();

            [$status, $payload] = $this->raw($method, $path, $query, $body, [
                // PF accepts the raw token (no "Bearer " prefix) — confirmed against the
            // pf_device reference client in jerahl/ZabbixSwitchPortWidgets.
            'Authorization: '.($this->token ?? '')
            ]);
        }

        if ($status >= 400) {
            throw new \RuntimeException("PFClient: HTTP $status for $method $path");
        }
        return $payload;
    }

    private function ensureToken(): void {
        if ($this->token !== null && $this->tokenExpiry > time()) return;

        $cached = $this->readCachedToken();
        if ($cached !== null) {
            $this->token       = $cached['token'];
            $this->tokenExpiry = $cached['expires'];
            return;
        }

        [$status, $payload] = $this->raw('POST', '/api/v1/login', [], [
            'username' => $this->user,
            'password' => $this->pass
        ], []);

        if ($status >= 400) {
            throw new \RuntimeException("PFClient: login failed (HTTP $status)");
        }

        $token = (string) ($payload['token'] ?? '');
        if ($token === '') {
            throw new \RuntimeException('PFClient: login returned no token');
        }

        $this->token       = $token;
        $this->tokenExpiry = time() + self::TOKEN_TTL_DEFAULT;
        $this->writeCachedToken($token, $this->tokenExpiry);
    }

    /**
     * @param array<string, mixed> $query
     * @param array<string, mixed>|null $body
     * @param array<int, string> $extraHeaders
     * @return array{0:int, 1:array<string,mixed>}
     */
    private function raw(string $method, string $path, array $query, ?array $body, array $extraHeaders): array {
        $url = $this->url . $path;
        if ($query) {
            $url .= (str_contains($path, '?') ? '&' : '?') . http_build_query($query);
        }

        $ch = curl_init($url);
        if ($ch === false) {
            throw new \RuntimeException('PFClient: curl_init failed');
        }

        $headers = array_merge([
            'Accept: application/json',
            'Content-Type: application/json'
        ], $extraHeaders);

        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CUSTOMREQUEST  => $method,
            CURLOPT_HTTPHEADER     => $headers,
            CURLOPT_USERAGENT      => self::UA,
            CURLOPT_CONNECTTIMEOUT => self::TIMEOUT_CONNECT,
            CURLOPT_TIMEOUT        => self::TIMEOUT_TOTAL,
            CURLOPT_SSL_VERIFYPEER => $this->verifySsl,
            CURLOPT_SSL_VERIFYHOST => $this->verifySsl ? 2 : 0
        ]);

        if ($body !== null) {
            curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body, JSON_UNESCAPED_SLASHES));
        }

        $raw  = curl_exec($ch);
        $code = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $err  = curl_error($ch);
        curl_close($ch);

        if ($raw === false) {
            throw new \RuntimeException("PFClient: transport error: $err");
        }

        $decoded = json_decode((string) $raw, true);
        return [$code, is_array($decoded) ? $decoded : []];
    }

    /* ------------------------------------------------------------------ */
    /* Token caching: APCu when available, /tmp fallback otherwise        */
    /* ------------------------------------------------------------------ */

    private function cacheKey(): string {
        return self::CACHE_PREFIX . sha1($this->url.'|'.$this->user);
    }

    /** @return array{token:string, expires:int}|null */
    private function readCachedToken(): ?array {
        $key = $this->cacheKey();

        if (function_exists('apcu_fetch')) {
            $ok = false;
            /** @var mixed $hit */
            $hit = apcu_fetch($key, $ok);
            if ($ok && is_array($hit) && isset($hit['token'], $hit['expires']) && $hit['expires'] > time()) {
                return ['token' => (string) $hit['token'], 'expires' => (int) $hit['expires']];
            }
        }

        $path = self::CACHE_DIR . '/' . $key;
        if (!is_file($path)) return null;
        $raw = @file_get_contents($path);
        if ($raw === false) return null;
        $row = json_decode($raw, true);
        if (!is_array($row) || !isset($row['token'], $row['expires'])) return null;
        if ((int) $row['expires'] <= time()) return null;
        return ['token' => (string) $row['token'], 'expires' => (int) $row['expires']];
    }

    private function writeCachedToken(string $token, int $expires): void {
        $key = $this->cacheKey();
        $payload = ['token' => $token, 'expires' => $expires];

        if (function_exists('apcu_store')) {
            apcu_store($key, $payload, max(1, $expires - time()));
            return;
        }

        if (!is_dir(self::CACHE_DIR)) {
            @mkdir(self::CACHE_DIR, 0700, true);
        }
        @file_put_contents(self::CACHE_DIR . '/' . $key, json_encode($payload));
        @chmod(self::CACHE_DIR . '/' . $key, 0600);
    }

    private function forgetCachedToken(): void {
        $key = $this->cacheKey();
        if (function_exists('apcu_delete')) {
            apcu_delete($key);
        }
        @unlink(self::CACHE_DIR . '/' . $key);
    }

    /* ------------------------------------------------------------------ */
    /* PHP 8.0 polyfill (AP G21 — Zabbix ships PHP 8.0)                   */
    /* ------------------------------------------------------------------ */

    private static function ensureArrayIsListPolyfill(): void {
        if (function_exists('array_is_list')) return;
        eval('function array_is_list(array $a): bool {
            if ($a === []) return true;
            $i = 0;
            foreach ($a as $k => $_) { if ($k !== $i++) return false; }
            return true;
        }');
    }
}
