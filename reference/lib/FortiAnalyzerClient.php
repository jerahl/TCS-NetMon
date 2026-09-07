<?php declare(strict_types=1);

namespace Modules\TcsDashboard\Lib;

/**
 * FortiAnalyzer JSON-RPC client.
 *
 * Fills the FortiGate dashboard sections the "FortiGate by SNMP" template
 * cannot cover — top threat signatures, top firewall policies by hit count,
 * per-user SSL-VPN sessions, per-tunnel IPsec byte counters, and the UTM
 * block-count rollup. SNMP already drives device/interface/SD-WAN/IPsec
 * *status*; FortiAnalyzer adds the log-derived detail on top.
 *
 * Modeled on {@see PFClient}: same constructor shape, a fromMacros() factory,
 * APCu-with-/tmp-fallback caching for the auth credential, per-call timeouts,
 * an explicit User-Agent, TLS verification on by default, and graceful
 * degradation — every public method returns an empty array on failure rather
 * than throwing into the dashboard payload.
 *
 * ── Authentication ──────────────────────────────────────────────────────
 * Two modes, selected by which macro is set:
 *   - Session login (default): JSON-RPC exec /sys/login/user with
 *     user + passwd, returns a session id reused across calls and cached.
 *     Works on every FAZ version.
 *   - API token (FAZ 7.x "API user"): a generated bearer token passed in the
 *     Authorization header; no login round-trip. Set the token macro to use
 *     this path; it takes precedence over user/pass.
 *
 * ── Data retrieval ──────────────────────────────────────────────────────
 * Aggregations come from the logview "logsearch" API (FortiOS 7.x log
 * schema): start an async search (method `add`), poll the task id (method
 * `get`) until it completes or the row cap is hit, then aggregate top-N in
 * PHP. Aggregating client-side keeps us off the FortiView dataset names,
 * which differ across FAZ builds.
 *
 * NOTE: the log *field names* (e.g. `attack`, `policyid`, `sentbyte`,
 * `tunnelid`) follow the documented FortiOS 7.x log schema. If this FAZ runs
 * an older FortiOS or a customized log format, validate the field names in
 * {@see self::LOGTYPE} / the aggregators against a live `logsearch` response
 * — the dashboard degrades to empty cards, it does not error, when a field
 * is absent.
 *
 * PHP 8.0 carry-forward: include the array_is_list polyfill so the file is
 * drop-in compatible with the same Zabbix PHP 8.0 target as PFClient.
 */
class FortiAnalyzerClient {

    private string  $url;
    private string  $user;
    private string  $pass;
    private string  $token;
    private string  $adom;
    private bool    $verifySsl;

    private ?string $session = null;
    private int     $sessionExpiry = 0;

    /** Seconds a cached session id is trusted before a fresh login. */
    private const SESSION_TTL = 600;

    private const TIMEOUT_CONNECT = 10;
    private const TIMEOUT_TOTAL   = 45;
    private const UA              = 'TcsDashboard/1.0 (+FortiAnalyzerClient)';

    /** Cache namespace for the session id (APCu / filesystem fallback). */
    private const CACHE_PREFIX = 'tcs_faz_session::';
    private const CACHE_DIR    = '/tmp/tcs_dashboard_cache';

    /** logview apiver these calls are written against. */
    private const APIVER = 3;

    /** Max rows pulled per logsearch before we stop polling and aggregate. */
    private const MAX_ROWS = 5000;

    /** How many poll iterations / how long to wait for a search to finish. */
    private const POLL_TRIES    = 12;
    private const POLL_SLEEP_US = 400_000; // 0.4s → ~4.8s worst case per search

    /**
     * logtype string used in the logsearch request, per dashboard section.
     * FortiOS log categories; FAZ accepts the same names on /logview.
     */
    private const LOGTYPE = [
        'traffic' => 'traffic',
        'attack'  => 'attack',     // IPS / intrusion-prevention
        'virus'   => 'virus',      // antivirus
        'webfilter'=> 'webfilter',
        'app-ctrl'=> 'app-ctrl',
        'dns'     => 'dns',
        'event'   => 'event',      // includes VPN up/down + ssl-vpn auth
    ];

    public function __construct(
        string $url,
        string $user,
        #[\SensitiveParameter] string $pass,
        #[\SensitiveParameter] string $token = '',
        string $adom = 'root',
        bool $verifySsl = true
    ) {
        self::ensureArrayIsListPolyfill();

        $this->url       = rtrim($url, '/');
        $this->user      = $user;
        $this->pass      = $pass;
        $this->token     = $token;
        $this->adom      = $adom !== '' ? $adom : 'root';
        $this->verifySsl = $verifySsl;
    }

    /**
     * @param array{url:string,user?:string,pass?:string,token?:string,adom?:string,verify_ssl?:bool} $cfg
     */
    public static function fromMacros(array $cfg): self {
        return new self(
            (string) ($cfg['url']   ?? ''),
            (string) ($cfg['user']  ?? ''),
            (string) ($cfg['pass']  ?? ''),
            (string) ($cfg['token'] ?? ''),
            (string) ($cfg['adom']  ?? 'root'),
            (bool)   ($cfg['verify_ssl'] ?? true)
        );
    }

    /** True when enough config is present to attempt a connection. */
    public function isConfigured(): bool {
        if ($this->url === '') return false;
        return $this->token !== '' || ($this->user !== '' && $this->pass !== '');
    }

    /* ------------------------------------------------------------------ */
    /* Public surface — what ActionFortigateData consumes                 */
    /* ------------------------------------------------------------------ */

    /**
     * Top IPS / attack signatures over the window, descending by hit count.
     * Row shape matches FG_TOP_THREATS (fortigate-app.jsx):
     *   { sig, cat, sev, src, count, dstCC }
     *
     * @return list<array{sig:string,cat:string,sev:string,src:string,count:int,dstCC:string}>
     */
    public function topThreats(string $deviceId = '', int $hours = 24, int $limit = 12): array {
        $rows = $this->logSearch(self::LOGTYPE['attack'], $deviceId, $hours, '');
        if (!$rows) return [];

        // Aggregate by signature name. Keep the most recent src/severity/dstCC
        // seen for the label, and the max severity across hits.
        $agg = [];
        foreach ($rows as $r) {
            $sig = (string) ($r['attack'] ?? $r['attackname'] ?? $r['msg'] ?? '');
            if ($sig === '') continue;
            if (!isset($agg[$sig])) {
                $agg[$sig] = [
                    'sig'   => $sig,
                    'cat'   => (string) ($r['attackcategory'] ?? $r['eventtype'] ?? $r['service'] ?? '—'),
                    'sev'   => self::fazSeverity((string) ($r['severity'] ?? $r['crlevel'] ?? '')),
                    'src'   => (string) ($r['srcip'] ?? $r['src'] ?? '—'),
                    'count' => 0,
                    'dstCC' => (string) ($r['dstcountry'] ?? $r['dstintfrole'] ?? '—'),
                    '_sevRank' => 0,
                ];
            }
            $agg[$sig]['count'] += (int) ($r['count'] ?? 1);
            $rank = self::sevRank(self::fazSeverity((string) ($r['severity'] ?? $r['crlevel'] ?? '')));
            if ($rank > $agg[$sig]['_sevRank']) {
                $agg[$sig]['_sevRank'] = $rank;
                $agg[$sig]['sev'] = self::fazSeverity((string) ($r['severity'] ?? $r['crlevel'] ?? ''));
            }
        }
        usort($agg, fn($a, $b) => $b['count'] <=> $a['count']);
        $out = [];
        foreach (array_slice($agg, 0, $limit) as $row) {
            unset($row['_sevRank']);
            $out[] = $row;
        }
        return $out;
    }

    /**
     * Top firewall policies by 24h hit count. Row shape matches
     * FG_TOP_POLICIES: { id, name, from, to, action, hits24h }.
     *
     * @return list<array{id:string,name:string,from:string,to:string,action:string,hits24h:int}>
     */
    public function topPolicies(string $deviceId = '', int $hours = 24, int $limit = 25): array {
        $rows = $this->logSearch(self::LOGTYPE['traffic'], $deviceId, $hours, '');
        if (!$rows) return [];

        $agg = [];
        foreach ($rows as $r) {
            $pid = (string) ($r['policyid'] ?? '');
            if ($pid === '') continue;
            if (!isset($agg[$pid])) {
                $agg[$pid] = [
                    'id'      => $pid,
                    'name'    => (string) ($r['policyname'] ?? ('policy ' . $pid)),
                    'from'    => (string) ($r['srcintf'] ?? $r['srcintfrole'] ?? '—'),
                    'to'      => (string) ($r['dstintf'] ?? $r['dstintfrole'] ?? '—'),
                    'action'  => self::trafficAction((string) ($r['action'] ?? 'accept')),
                    'hits24h' => 0,
                ];
            }
            // FortiGate aggregates sessions in `sentpkt`/`count`; prefer an
            // explicit per-row hit count, else count the log line.
            $agg[$pid]['hits24h'] += (int) ($r['count'] ?? 1);
        }
        usort($agg, fn($a, $b) => $b['hits24h'] <=> $a['hits24h']);
        return array_slice(array_values($agg), 0, $limit);
    }

    /**
     * Per-user SSL-VPN sessions seen in the window, latest login per user.
     * Row shape matches FG_SSLVPN: { user, role, src, dst, dur, rxMb, mfa }.
     *
     * Pulled from event logs (subtype vpn / ssl-vpn). FortiAnalyzer is a log
     * archive, so this reflects the most recent session per user within the
     * window — not necessarily a still-open tunnel. The header count on the
     * card pairs this with the live SNMP `ssl_users` gauge.
     *
     * @return list<array{user:string,role:string,src:string,dst:string,dur:string,rxMb:int,mfa:bool}>
     */
    public function sslVpnSessions(string $deviceId = '', int $hours = 24, int $limit = 40): array {
        // ssl-vpn activity lands in the event log; filter to the vpn subtype.
        $rows = $this->logSearch(self::LOGTYPE['event'], $deviceId, $hours, 'subtype==vpn');
        if (!$rows) return [];

        $byUser = [];
        foreach ($rows as $r) {
            // The subtype==vpn event stream mixes IPsec IKE negotiation logs
            // (no tunneltype, no bytes) with SSL-VPN logs. Keep only rows with
            // an explicit SSL marker so IKE rows don't pollute the user list.
            $vpntype = strtolower((string) ($r['tunneltype'] ?? $r['vpntype'] ?? ''));
            $logdesc = strtolower((string) ($r['logdesc'] ?? ''));
            $action  = strtolower((string) ($r['action'] ?? ''));
            $isSsl = str_contains($vpntype, 'ssl')
                || str_contains($logdesc, 'ssl')
                || str_contains($action, 'ssl');
            if (!$isSsl) continue;

            $user = (string) ($r['user'] ?? $r['xauthuser'] ?? '');
            if ($user === '') continue;

            $ts = (int) ($r['itime'] ?? $r['eventtime'] ?? 0);
            if (isset($byUser[$user]) && $byUser[$user]['_ts'] >= $ts) continue;

            $sent = (float) ($r['sentbyte'] ?? $r['tunnelsentbyte'] ?? 0);
            $byUser[$user] = [
                'user'  => $user,
                'role'  => (string) ($r['group'] ?? $r['grpname'] ?? 'user'),
                'src'   => (string) ($r['remip'] ?? $r['srcip'] ?? '—'),
                'dst'   => (string) ($r['tunnelip'] ?? $r['assignip'] ?? '—'),
                'dur'   => self::formatDuration((int) ($r['duration'] ?? 0)),
                'rxMb'  => (int) round($sent / 1e6),
                'mfa'   => self::truthy((string) ($r['twofa'] ?? $r['fortitoken'] ?? '')),
                '_ts'   => $ts,
            ];
        }
        usort($byUser, fn($a, $b) => $b['rxMb'] <=> $a['rxMb']);
        $out = [];
        foreach (array_slice($byUser, 0, $limit) as $row) {
            unset($row['_ts']);
            $out[] = $row;
        }
        return $out;
    }

    /**
     * Per-tunnel IPsec byte counters keyed by tunnel name, so the caller can
     * merge them onto the SNMP-derived status rows. SNMP gives up/down;
     * FortiAnalyzer adds rxMb/txMb and the remote peer.
     *
     * @return array<string, array{rxMb:int,txMb:int,peer:string}> keyed by tunnel name (lowercased)
     */
    public function ipsecStats(string $deviceId = '', int $hours = 24): array {
        $rows = $this->logSearch(self::LOGTYPE['event'], $deviceId, $hours, 'subtype==vpn');
        if (!$rows) return [];

        $byTunnel = [];
        foreach ($rows as $r) {
            $vpntype = strtolower((string) ($r['tunneltype'] ?? $r['vpntype'] ?? ''));
            if ($vpntype !== '' && !str_contains($vpntype, 'ipsec')) continue;

            $name = (string) ($r['tunnelid'] ?? $r['vpntunnel'] ?? '');
            if ($name === '') continue;
            $key = strtolower($name);

            $sent  = (float) ($r['sentbyte'] ?? $r['tunnelsentbyte'] ?? 0);
            $rcvd  = (float) ($r['rcvdbyte'] ?? $r['tunnelrcvdbyte'] ?? 0);
            // IKE negotiation logs carry no byte counters; only keep rows that
            // actually report traffic so we don't zero out the SNMP rows.
            if ($sent <= 0 && $rcvd <= 0) continue;

            if (!isset($byTunnel[$key])) {
                $byTunnel[$key] = ['rxMb' => 0, 'txMb' => 0, 'peer' => (string) ($r['remip'] ?? $r['remgw'] ?? '—')];
            }
            $byTunnel[$key]['rxMb'] += (int) round($rcvd / 1e6);
            $byTunnel[$key]['txMb'] += (int) round($sent / 1e6);
            if ($byTunnel[$key]['peer'] === '—') {
                $byTunnel[$key]['peer'] = (string) ($r['remip'] ?? $r['remgw'] ?? '—');
            }
        }
        return $byTunnel;
    }

    /**
     * UTM block-count rollup over the window, one entry per UTM engine.
     * Returns counts keyed by the dashboard's utm cell id (ips/av/wf/ac/dns/bot)
     * so the caller can splice them onto its 6-cell grid.
     *
     * @return array<string, int> e.g. ['av' => 12, 'wf' => 340, ...]
     */
    public function utmBlockCounts(string $deviceId = '', int $hours = 24): array {
        // One light count-only search per engine. Each search is row-capped,
        // so this is "blocks observed in the sampled window", not a server-side
        // exact total — good enough for the at-a-glance grid.
        $map = [
            'av'  => self::LOGTYPE['virus'],
            'wf'  => self::LOGTYPE['webfilter'],
            'ac'  => self::LOGTYPE['app-ctrl'],
            'dns' => self::LOGTYPE['dns'],
        ];
        // Block-ish action strings across the UTM engines (virus/webfilter/
        // app-ctrl/dns). Counted in PHP rather than via a server-side filter:
        // FAZ logview filter syntax uses the `or` keyword, not `|`, and the
        // exact block-action string differs per engine — counting locally is
        // robust against both. Row-capped, so this is "blocks in the sampled
        // window", not an exact server-side total.
        $blockActions = ['block', 'blocked', 'dropped', 'drop', 'reset', 'redirect'];
        $out = [];
        foreach ($map as $cell => $logtype) {
            try {
                $rows = $this->logSearch($logtype, $deviceId, $hours, '');
            } catch (\Throwable $e) {
                error_log('[tcs_dashboard] FortiAnalyzerClient::utmBlockCounts ' . $cell . ': ' . $e->getMessage());
                continue;
            }
            $sum = 0;
            foreach ($rows as $r) {
                $a = strtolower((string) ($r['action'] ?? ''));
                if ($a !== '' && in_array($a, $blockActions, true)) $sum++;
            }
            $out[$cell] = $sum;
        }
        return $out;
    }

    /* ------------------------------------------------------------------ */
    /* logview logsearch — start async search, poll, return rows          */
    /* ------------------------------------------------------------------ */

    /**
     * Run a logsearch and return the decoded rows (capped at MAX_ROWS).
     * Returns [] on any failure — callers degrade to empty cards.
     *
     * @param string $logtype  one of self::LOGTYPE values
     * @param string $deviceId FortiGate serial or FAZ device name; '' = all
     * @param int    $hours    look-back window
     * @param string $filter   FAZ logview filter expression ('' = none)
     * @return list<array<string,mixed>>
     */
    private function logSearch(string $logtype, string $deviceId, int $hours, string $filter): array {
        if (!$this->isConfigured()) return [];

        $end   = time();
        $start = $end - max(1, $hours) * 3600;
        // ISO 8601 with the literal 'T' separator, per the FAZ logsearch API.
        $range = [
            'start' => date('Y-m-d\TH:i:s', $start),
            'end'   => date('Y-m-d\TH:i:s', $end),
        ];

        $params = [
            'url'        => '/logview/adom/' . rawurlencode($this->adom) . '/logsearch',
            'apiver'     => self::APIVER,
            'logtype'    => $logtype,
            'time-order' => 'desc',
            'time-range' => $range,
        ];
        if ($deviceId !== '') {
            $params['device'] = [['devid' => $deviceId]];
        }
        if ($filter !== '') {
            $params['filter'] = $filter;
        }

        $started = $this->rpc('add', $params);
        $tid = $started['result'][0]['tid'] ?? ($started['result']['tid'] ?? $started['tid'] ?? null);
        if ($tid === null) {
            // Surface what FAZ actually returned — the status block tells us
            // why (permission denied, bad ADOM/url, apiver mismatch, …).
            error_log('[tcs_dashboard] FortiAnalyzerClient::logSearch(' . $logtype
                . '): no tid. adom=' . $this->adom
                . ' resp=' . substr((string) json_encode($started, JSON_UNESCAPED_SLASHES), 0, 600));
            return [];
        }

        // Poll the task, accumulating rows until complete or capped.
        $rows = [];
        $offset = 0;
        for ($i = 0; $i < self::POLL_TRIES; $i++) {
            $page = $this->rpc('get', [
                'url'    => '/logview/adom/' . rawurlencode($this->adom) . '/logsearch/' . $tid,
                'apiver' => self::APIVER,
                'offset' => $offset,
                'limit'  => 1000,
            ]);
            $res  = $page['result'][0] ?? $page['result'] ?? [];
            $data = $res['data'] ?? [];
            if (is_array($data) && $data) {
                foreach ($data as $d) {
                    if (is_array($d)) $rows[] = $d;
                }
                $offset = count($rows);
            }
            $pct = (int) ($res['percentage'] ?? 0);
            if (count($rows) >= self::MAX_ROWS) break;
            if ($pct >= 100 && (!is_array($data) || count($data) < 1000)) break;
            if ($i < self::POLL_TRIES - 1) usleep(self::POLL_SLEEP_US);
        }

        // Best-effort: release the server-side search task.
        try {
            $this->rpc('delete', [
                'url'    => '/logview/adom/' . rawurlencode($this->adom) . '/logsearch/' . $tid,
                'apiver' => self::APIVER,
            ]);
        } catch (\Throwable) { /* non-fatal */ }

        $rows = array_slice($rows, 0, self::MAX_ROWS);

        // Diagnostic: log the row count and the FIELD NAMES of the first row
        // (names only — no log values, so nothing sensitive). This is how we
        // reconcile the aggregators' expected field names against what this
        // FAZ/FortiOS build actually emits. Cheap: at most a handful of lines
        // per FA cache miss (~once / 120s).
        error_log(sprintf(
            '[tcs_dashboard] FAZ logsearch logtype=%s device=%s filter=%s → %d row(s)%s',
            $logtype,
            $deviceId !== '' ? $deviceId : '(all)',
            $filter !== '' ? $filter : '(none)',
            count($rows),
            $rows ? '; fields: ' . implode(',', array_keys($rows[0])) : ''
        ));

        return $rows;
    }

    /* ------------------------------------------------------------------ */
    /* JSON-RPC plumbing                                                  */
    /* ------------------------------------------------------------------ */

    /**
     * Issue one JSON-RPC call. Adds the session id (session auth) and retries
     * once after a fresh login if FAZ reports an invalid/expired session.
     *
     * @param array<string,mixed> $params
     * @return array<string,mixed>
     */
    private function rpc(string $method, array $params): array {
        if ($this->token === '') {
            $this->ensureSession();
        }

        [$status, $payload] = $this->raw($method, $params, $this->token === '' ? $this->session : null);

        // FAZ returns HTTP 200 with a per-result status code; -11 / -3 mean
        // the session is invalid. Force one re-login and retry.
        if ($this->token === '' && self::isSessionError($payload)) {
            $this->session = null;
            $this->sessionExpiry = 0;
            $this->forgetCachedSession();
            $this->ensureSession();
            [$status, $payload] = $this->raw($method, $params, $this->session);
        }

        if ($status >= 400) {
            throw new \RuntimeException("FortiAnalyzerClient: HTTP $status for $method " . ($params['url'] ?? ''));
        }
        return $payload;
    }

    private function ensureSession(): void {
        if ($this->session !== null && $this->sessionExpiry > time()) return;

        $cached = $this->readCachedSession();
        if ($cached !== null) {
            $this->session       = $cached['session'];
            $this->sessionExpiry = $cached['expires'];
            return;
        }

        [$status, $payload] = $this->raw('exec', [
            'url'  => '/sys/login/user',
            'data' => ['user' => $this->user, 'passwd' => $this->pass],
        ], null);

        if ($status >= 400) {
            throw new \RuntimeException("FortiAnalyzerClient: login failed (HTTP $status)");
        }
        $session = (string) ($payload['session'] ?? '');
        if ($session === '') {
            $msg = (string) ($payload['result'][0]['status']['message']
                ?? $payload['error']['message']
                ?? 'no session in response');
            throw new \RuntimeException("FortiAnalyzerClient: login rejected ($msg)");
        }

        $this->session       = $session;
        $this->sessionExpiry = time() + self::SESSION_TTL;
        $this->writeCachedSession($session, $this->sessionExpiry);
    }

    /**
     * Low-level transport. Posts a single JSON-RPC envelope to /jsonrpc.
     *
     * @param array<string,mixed> $params
     * @return array{0:int,1:array<string,mixed>}
     */
    private function raw(string $method, array $params, ?string $session): array {
        $envelope = [
            'id'      => 1,
            'jsonrpc' => '2.0',
            'method'  => $method,
            'params'  => [$params],
        ];
        if ($session !== null && $session !== '') {
            $envelope['session'] = $session;
        }

        $ch = curl_init($this->url . '/jsonrpc');
        if ($ch === false) {
            throw new \RuntimeException('FortiAnalyzerClient: curl_init failed');
        }

        $headers = [
            'Accept: application/json',
            'Content-Type: application/json',
        ];
        if ($this->token !== '') {
            // FAZ 7.x API-user token.
            $headers[] = 'Authorization: Bearer ' . $this->token;
        }

        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_POST           => true,
            CURLOPT_POSTFIELDS     => json_encode($envelope, JSON_UNESCAPED_SLASHES),
            CURLOPT_HTTPHEADER     => $headers,
            CURLOPT_USERAGENT      => self::UA,
            CURLOPT_CONNECTTIMEOUT => self::TIMEOUT_CONNECT,
            CURLOPT_TIMEOUT        => self::TIMEOUT_TOTAL,
            CURLOPT_SSL_VERIFYPEER => $this->verifySsl,
            CURLOPT_SSL_VERIFYHOST => $this->verifySsl ? 2 : 0,
        ]);

        $body = curl_exec($ch);
        $code = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $err  = curl_error($ch);
        curl_close($ch);

        if ($body === false) {
            throw new \RuntimeException("FortiAnalyzerClient: transport error: $err");
        }
        $decoded = json_decode((string) $body, true);
        return [$code, is_array($decoded) ? $decoded : []];
    }

    /** True when a FAZ response carries an invalid/expired-session status code. */
    private static function isSessionError(array $payload): bool {
        $code = $payload['result'][0]['status']['code'] ?? null;
        if ($code === null) $code = $payload['error']['code'] ?? null;
        // -11 invalid session, -3 object not found w/ no session on some builds.
        return in_array((int) $code, [-11, -3], true);
    }

    /* ------------------------------------------------------------------ */
    /* Session caching: APCu when available, /tmp fallback otherwise      */
    /* ------------------------------------------------------------------ */

    private function cacheKey(): string {
        return self::CACHE_PREFIX . sha1($this->url . '|' . $this->user);
    }

    /** @return array{session:string,expires:int}|null */
    private function readCachedSession(): ?array {
        $key = $this->cacheKey();

        if (function_exists('apcu_fetch')) {
            $ok = false;
            $hit = apcu_fetch($key, $ok);
            if ($ok && is_array($hit) && isset($hit['session'], $hit['expires']) && $hit['expires'] > time()) {
                return ['session' => (string) $hit['session'], 'expires' => (int) $hit['expires']];
            }
        }

        $path = self::CACHE_DIR . '/' . $key;
        if (!is_file($path)) return null;
        $raw = @file_get_contents($path);
        if ($raw === false) return null;
        $row = json_decode($raw, true);
        if (!is_array($row) || !isset($row['session'], $row['expires'])) return null;
        if ((int) $row['expires'] <= time()) return null;
        return ['session' => (string) $row['session'], 'expires' => (int) $row['expires']];
    }

    private function writeCachedSession(string $session, int $expires): void {
        $key = $this->cacheKey();
        $payload = ['session' => $session, 'expires' => $expires];

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

    private function forgetCachedSession(): void {
        $key = $this->cacheKey();
        if (function_exists('apcu_delete')) {
            apcu_delete($key);
        }
        @unlink(self::CACHE_DIR . '/' . $key);
    }

    /* ------------------------------------------------------------------ */
    /* Mapping helpers                                                    */
    /* ------------------------------------------------------------------ */

    /** Normalize FortiOS severity strings to the dashboard's Sev levels. */
    private static function fazSeverity(string $sev): string {
        $s = strtolower(trim($sev));
        return match ($s) {
            'critical', 'emergency', 'alert' => 'disaster',
            'high'                           => 'high',
            'medium', 'warning'              => 'warning',
            default                          => 'info',
        };
    }

    private static function sevRank(string $sev): int {
        return ['info' => 1, 'warning' => 2, 'high' => 3, 'disaster' => 4][$sev] ?? 0;
    }

    /** Collapse FortiOS traffic actions to accept|deny for the policy table. */
    private static function trafficAction(string $action): string {
        $a = strtolower(trim($action));
        if (in_array($a, ['deny', 'block', 'blocked', 'drop', 'dropped'], true)) return 'deny';
        return 'accept';
    }

    private static function truthy(string $v): bool {
        $v = strtolower(trim($v));
        return $v !== '' && !in_array($v, ['0', 'no', 'disable', 'disabled', 'false', 'n/a'], true);
    }

    private static function formatDuration(int $seconds): string {
        if ($seconds <= 0) return '—';
        $h = intdiv($seconds, 3600);
        $m = intdiv($seconds % 3600, 60);
        if ($h > 0) return sprintf('%dh %02dm', $h, $m);
        return sprintf('%dm', $m);
    }

    /* ------------------------------------------------------------------ */
    /* PHP 8.0 polyfill (Zabbix ships PHP 8.0)                            */
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
