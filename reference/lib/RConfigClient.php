<?php declare(strict_types=1);

namespace Modules\TcsDashboard\Lib;

/**
 * rConfig v7+ API client — surface needed to deploy a stored snippet
 * against a managed device (PoE-cycle button on the Port Detail card).
 *
 * Matches the working reference at
 * jerahl/ZabbixSwitchPortWidgets/portdetail/actions/CyclePoe.php:
 *   - Auth header: `apitoken: <token>` (NOT Authorization: Bearer)
 *   - Device list: GET /api/v2/devices?per_page=100&page=N
 *     → returns { data: [...], last_page: N }
 *     → match `device_ip` / `device_name` client-side
 *   - Snippet deploy: POST /api/v1/snippets/<id>/deploy
 *     → body { devices: [id], dynamic_vars: { interface_name: "1:7" } }
 *
 * Constraints (unchanged):
 *   - HTTPS only — constructor rejects http://
 *   - TLS verification on by default
 *   - 15s connect / 30s total
 */
class RConfigClient {

    private string $url;
    private string $token;
    private bool   $verifySsl;

    private const TIMEOUT_CONNECT = 15;
    private const TIMEOUT_TOTAL   = 30;
    private const UA              = 'TcsDashboard/1.0 (+RConfigClient)';
    /** Cap on device-list pagination — 20 * 100 = 2000-device ceiling. */
    private const DEVICE_LIST_MAX_PAGES = 20;

    public function __construct(
        string $url,
        #[\SensitiveParameter] string $token,
        bool $verifySsl = true
    ) {
        $url = rtrim($url, '/');
        if (!preg_match('#^https://#i', $url)) {
            throw new \InvalidArgumentException('RConfigClient: URL must be https://');
        }
        if ($token === '') {
            throw new \InvalidArgumentException('RConfigClient: token is required');
        }

        $this->url       = $url;
        $this->token     = $token;
        $this->verifySsl = $verifySsl;
    }

    /**
     * Resolve a Zabbix host to its rConfig device id by listing devices
     * and matching client-side. Priority (first match wins):
     *   1. SNMP-interface IP   → device_ip
     *   2. Any-interface IP    → device_ip
     *   3. Technical hostname  → device_name (case-insensitive)
     *   4. Visible name        → device_name (case-insensitive)
     *
     * Ambiguous matches (multiple rConfig devices with the same key) are
     * rejected so the operator can pin the id via {$RCONFIG.DEVICE_ID}.
     *
     * @param array<int, string> $snmpIps  IPs of SNMP-typed Zabbix interfaces
     * @param array<int, string> $anyIps   IPs of any interface on the host
     * @throws \RuntimeException when nothing resolves or the match is ambiguous.
     */
    public function resolveDeviceId(
        string $hostId,
        string $hostName,
        string $visibleName,
        array $snmpIps,
        array $anyIps,
        ?int $deviceIdMacro
    ): int {
        if ($deviceIdMacro !== null && $deviceIdMacro > 0) {
            return $deviceIdMacro;
        }

        $snmpIps = array_values(array_unique(array_filter($snmpIps, fn($s) => $s !== '' && $s !== '0.0.0.0')));
        $anyIps  = array_values(array_unique(array_filter($anyIps,  fn($s) => $s !== '' && $s !== '0.0.0.0')));
        $tech    = strtolower(trim($hostName));
        $visible = strtolower(trim($visibleName));

        if (!$snmpIps && !$anyIps && $tech === '' && $visible === '') {
            throw new \RuntimeException("RConfigClient: no interface IP, hostname, or visible name on host $hostId to match against");
        }

        $devices = $this->listAllDevices();
        if (!$devices) {
            throw new \RuntimeException('RConfigClient: rConfig returned an empty device list');
        }

        $tries = [
            ['snmp_ip',      fn(array $d) => in_array(trim((string) ($d['device_ip']   ?? '')), $snmpIps, true)],
            ['interface_ip', fn(array $d) => in_array(trim((string) ($d['device_ip']   ?? '')), $anyIps,  true)],
            ['hostname',     fn(array $d) => $tech    !== '' && strtolower(trim((string) ($d['device_name'] ?? ''))) === $tech],
            ['visible_name', fn(array $d) => $visible !== '' && strtolower(trim((string) ($d['device_name'] ?? ''))) === $visible],
        ];

        foreach ($tries as [$label, $matcher]) {
            $hits = [];
            foreach ($devices as $d) {
                if ($matcher($d)) {
                    $id = (int) ($d['id'] ?? 0);
                    if ($id > 0) $hits[$id] = true;
                }
            }
            if (count($hits) === 1) {
                return (int) array_key_first($hits);
            }
            if (count($hits) > 1) {
                throw new \RuntimeException(
                    "RConfigClient: multiple rConfig devices match by $label — set {\$RCONFIG.DEVICE_ID} on host $hostId to pin"
                );
            }
        }

        $tried = [];
        if ($snmpIps) $tried[] = 'snmp ips ['.implode(',', $snmpIps).']';
        if ($anyIps)  $tried[] = 'ips ['.implode(',', $anyIps).']';
        if ($tech)    $tried[] = "host '$hostName'";
        if ($visible) $tried[] = "name '$visibleName'";
        throw new \RuntimeException(
            'RConfigClient: no rConfig device matches '.implode(' / ', $tried).' — set {$RCONFIG.DEVICE_ID} on the host to pin'
        );
    }

    /**
     * Deploy a stored snippet against a device with optional variable
     * substitution. The snippet's placeholder is whatever the operator
     * named it in rConfig; for the PoE-cycle snippet that ships with
     * the reference widget it's `interface_name` (e.g. "1:7").
     *
     * @param array<string, scalar> $dynamicVars
     * @return array{ok:bool, message:string, http_status:int}
     */
    public function deploySnippet(int $deviceId, int $snippetId, array $dynamicVars): array {
        if ($deviceId <= 0) {
            return ['ok' => false, 'message' => 'invalid device id', 'http_status' => 0];
        }
        if ($snippetId <= 0) {
            return ['ok' => false, 'message' => 'invalid snippet id', 'http_status' => 0];
        }

        [$status, $payload] = $this->raw('POST', '/api/v1/snippets/'.$snippetId.'/deploy', [], [
            'devices'      => [$deviceId],
            'dynamic_vars' => $dynamicVars
        ]);

        $ok = $status >= 200 && $status < 300 && !empty($payload['success']);
        $msg = '';
        if (isset($payload['data']) && is_string($payload['data'])) {
            $msg = $payload['data'];
        } elseif (isset($payload['message']) && is_string($payload['message'])) {
            $msg = $payload['message'];
        } elseif (isset($payload['error']) && is_string($payload['error'])) {
            $msg = $payload['error'];
        }
        if ($msg === '') {
            $msg = $ok ? 'queued' : "rConfig HTTP $status";
        }

        return ['ok' => $ok, 'message' => $msg, 'http_status' => $status];
    }

    /* ------------------------------------------------------------------ */
    /* Internals                                                          */
    /* ------------------------------------------------------------------ */

    /**
     * Page through GET /api/v2/devices and collect every device. Caps at
     * DEVICE_LIST_MAX_PAGES so a runaway last_page can't lock us into an
     * unbounded loop.
     *
     * @return array<int, array<string, mixed>>
     */
    private function listAllDevices(): array {
        $all = [];
        $page = 1;
        while ($page <= self::DEVICE_LIST_MAX_PAGES) {
            [$status, $payload] = $this->raw('GET', '/api/v2/devices', [
                'per_page' => 100,
                'page'     => $page
            ], null);

            if ($status < 200 || $status >= 300) {
                throw new \RuntimeException("RConfigClient: device list HTTP $status");
            }
            $batch = $payload['data'] ?? null;
            if (!is_array($batch)) {
                throw new \RuntimeException('RConfigClient: unexpected /api/v2/devices response shape');
            }
            foreach ($batch as $row) {
                if (is_array($row)) $all[] = $row;
            }
            $lastPage = (int) ($payload['last_page'] ?? 1);
            if ($page >= $lastPage) break;
            $page++;
        }
        return $all;
    }

    /**
     * @param array<string, mixed> $query
     * @param array<string, mixed>|null $body
     * @return array{0:int, 1:array<string,mixed>}
     */
    private function raw(string $method, string $path, array $query, ?array $body): array {
        $url = $this->url . $path;
        if ($query) {
            $url .= '?' . http_build_query($query);
        }

        $ch = curl_init($url);
        if ($ch === false) {
            throw new \RuntimeException('RConfigClient: curl_init failed');
        }

        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CUSTOMREQUEST  => $method,
            CURLOPT_HTTPHEADER     => [
                'Accept: application/json',
                'Content-Type: application/json',
                // rConfig uses a custom apitoken header, NOT Authorization.
                'apitoken: '.$this->token
            ],
            CURLOPT_USERAGENT      => self::UA,
            CURLOPT_CONNECTTIMEOUT => self::TIMEOUT_CONNECT,
            CURLOPT_TIMEOUT        => self::TIMEOUT_TOTAL,
            CURLOPT_SSL_VERIFYPEER => $this->verifySsl,
            CURLOPT_SSL_VERIFYHOST => $this->verifySsl ? 2 : 0,
            CURLOPT_PROTOCOLS      => CURLPROTO_HTTPS
        ]);

        if ($body !== null) {
            curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body, JSON_UNESCAPED_SLASHES));
        }

        $raw  = curl_exec($ch);
        $code = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $err  = curl_error($ch);
        curl_close($ch);

        if ($raw === false) {
            throw new \RuntimeException("RConfigClient: transport error: $err");
        }

        $decoded = json_decode((string) $raw, true);
        return [$code, is_array($decoded) ? $decoded : []];
    }
}
