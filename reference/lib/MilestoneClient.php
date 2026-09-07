<?php

declare(strict_types=1);

namespace Modules\TcsDashboard\Lib;

/**
 * MilestoneClient — minimal server-side OAuth + REST helper for the
 * Milestone XProtect API Gateway.
 *
 * The dashboard's browser WS bridge cannot set request headers and must not
 * see the VMS password, so this class exists for ONE primary job:
 *
 *   1. Mint a short-lived bearer token (POST /API/IDP/connect/token) and
 *      hand it back to the page so the JS WS client can authenticate
 *      in-band ({command:"authenticate", token:"Bearer ..."}).
 *
 * REST helpers (get()) are present but kept thin — the camera/groups/RS
 * blobs all live in Zabbix items now (via the Phase 2 collector), so PHP
 * only ever needs the live Gateway for ad-hoc per-camera fetches such as
 * the future camera-wall thumbnail (integration plan §3c).
 *
 * Config sourcing mirrors XIQClient::resolveToken — a caller-supplied
 * Zabbix global-macro lookup callable is the primary source, with /etc and
 * env fallbacks so the helper still works in CLI / unit-test contexts. The
 * required macros already exist on the Milestone template:
 *   {$MILESTONE.HOST}      gateway FQDN/IP
 *   {$MILESTONE.SCHEME}    http | https
 *   {$MILESTONE.USER}      XProtect basic user
 *   {$MILESTONE.PASSWORD}  XProtect basic user password
 *   {$MILESTONE.CLIENT_ID} default GrantValidatorClient
 *
 * Phase 0 confirmed /API/IDP/connect/token works on this Gateway; the
 * template's inline SCRIPTs use the legacy /IDP/connect/token path. Try
 * both, like the collector and probe do.
 */
final class MilestoneClient {
    private string $host;
    private string $scheme;
    private string $user;
    private string $password;
    private string $clientId;
    private bool $verifyTls;

    /** @var array{token: string, expires_at: int}|null */
    private ?array $cachedToken = null;

    /** Refresh a token this many seconds before it actually expires. */
    private const REFRESH_MARGIN_S = 60;

    public function __construct(
        string $host,
        string $scheme,
        string $user,
        string $password,
        string $clientId = 'GrantValidatorClient',
        bool $verifyTls = true
    ) {
        $this->host      = $host;
        $this->scheme    = $scheme === 'http' ? 'http' : 'https';
        $this->user      = $user;
        $this->password  = $password;
        $this->clientId  = $clientId !== '' ? $clientId : 'GrantValidatorClient';
        $this->verifyTls = $verifyTls;
    }

    /**
     * Build a client from Zabbix global macros. Pass a callable that returns
     * the macro value (empty string if unset), e.g.:
     *
     *     MilestoneClient::fromMacros(function (string $name): string {
     *         $rows = API::UserMacro()->get([
     *             'output'      => ['value'],
     *             'globalmacro' => true,
     *             'filter'      => ['macro' => $name],
     *         ]);
     *         return (string) ($rows[0]['value'] ?? '');
     *     });
     *
     * Returns null if HOST/USER/PASSWORD are not all present — caller treats
     * that as "Milestone live data is not configured here" rather than an
     * error.
     */
    public static function fromMacros(callable $lookup): ?self {
        $host     = trim((string) $lookup('{$MILESTONE.HOST}'));
        $user     = trim((string) $lookup('{$MILESTONE.USER}'));
        $password = (string) $lookup('{$MILESTONE.PASSWORD}');
        if ($host === '' || $user === '' || $password === '') {
            return null;
        }
        $scheme   = strtolower(trim((string) $lookup('{$MILESTONE.SCHEME}'))) ?: 'https';
        $clientId = trim((string) $lookup('{$MILESTONE.CLIENT_ID}')) ?: 'GrantValidatorClient';
        // verify_tls is opt-in: default to verifying. Override with the
        // {$MILESTONE.VERIFY_TLS} macro (string "0" disables verification —
        // useful for self-signed dev certs).
        $verify   = trim((string) $lookup('{$MILESTONE.VERIFY_TLS}'));
        $verifyTls = !($verify === '0' || strtolower($verify) === 'false');
        return new self($host, $scheme, $user, $password, $clientId, $verifyTls);
    }

    /** Gateway base URL — exposed so callers can derive the WS URL. */
    public function baseUrl(): string {
        return "{$this->scheme}://{$this->host}";
    }

    public function wsUrl(): string {
        $ws = $this->scheme === 'https' ? 'wss' : 'ws';
        return "{$ws}://{$this->host}/api/ws/events/v1";
    }

    /**
     * Return a non-expired access token. Caches the result on the instance —
     * not across requests; PHP-FPM workers are short-lived, and the same
     * worker rarely handles two surveillance.data calls within a token TTL.
     *
     * @return array{access_token: string, expires_in: int}|null  null on
     *   any failure (caller surfaces a degraded-state message; the page
     *   still renders Zabbix-fed data without the live WS).
     */
    public function mintToken(): ?array {
        if ($this->cachedToken !== null
            && time() < ($this->cachedToken['expires_at'] - self::REFRESH_MARGIN_S)
        ) {
            $remaining = $this->cachedToken['expires_at'] - time();
            return [
                'access_token' => $this->cachedToken['token'],
                'expires_in'   => max(1, $remaining),
            ];
        }

        $body = http_build_query([
            'grant_type' => 'password',
            'username'   => $this->user,
            'password'   => $this->password,
            'client_id'  => $this->clientId,
        ]);

        // Try the documented IDP path first, then the legacy one the older
        // installs use. Stop on the first success.
        foreach (['/API/IDP/connect/token', '/IDP/connect/token'] as $path) {
            $resp = $this->httpPost($this->baseUrl() . $path, $body, [
                'Content-Type: application/x-www-form-urlencoded',
                'Accept: application/json',
            ]);
            if ($resp === null) {
                continue;
            }
            $decoded = json_decode($resp['body'], true);
            if ($resp['status'] !== 200 || !is_array($decoded)) {
                error_log("[milestone] IDP {$path} -> {$resp['status']}");
                continue;
            }
            $token = (string) ($decoded['access_token'] ?? '');
            $exp   = (int) ($decoded['expires_in'] ?? 0);
            if ($token === '' || $exp <= 0) {
                continue;
            }
            $this->cachedToken = [
                'token'      => $token,
                'expires_at' => time() + $exp,
            ];
            return ['access_token' => $token, 'expires_in' => $exp];
        }
        return null;
    }

    /**
     * Thin GET helper for ad-hoc REST calls (e.g. camera thumbnail snapshot
     * in a future patch). Returns decoded JSON or null on failure. Bulk
     * camera/groups/RS inventory does NOT go through here — that's all in
     * Zabbix items now (Phase 2 collector).
     */
    public function get(string $path): mixed {
        $tok = $this->mintToken();
        if ($tok === null) return null;
        $url  = rtrim($this->baseUrl(), '/') . '/api/rest/v1' . $path;
        $resp = $this->httpGet($url, [
            'Authorization: Bearer ' . $tok['access_token'],
            'Accept: application/json',
        ]);
        if ($resp === null || $resp['status'] !== 200) return null;
        return json_decode($resp['body'], true);
    }

    // -----------------------------------------------------------------------
    // HTTP plumbing — curl-based, minimal. Keeps the file dependency-free
    // beyond the PHP curl extension.
    // -----------------------------------------------------------------------

    /** @return array{status:int, body:string}|null */
    private function httpPost(string $url, string $body, array $headers): ?array {
        return $this->httpRequest($url, 'POST', $body, $headers);
    }

    /** @return array{status:int, body:string}|null */
    private function httpGet(string $url, array $headers): ?array {
        return $this->httpRequest($url, 'GET', null, $headers);
    }

    /** @return array{status:int, body:string}|null */
    private function httpRequest(string $url, string $method, ?string $body, array $headers): ?array {
        $ch = curl_init($url);
        if ($ch === false) return null;
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_TIMEOUT        => 30,
            CURLOPT_CONNECTTIMEOUT => 10,
            CURLOPT_HTTPHEADER     => $headers,
            CURLOPT_SSL_VERIFYPEER => $this->verifyTls,
            CURLOPT_SSL_VERIFYHOST => $this->verifyTls ? 2 : 0,
        ]);
        if ($method === 'POST') {
            curl_setopt($ch, CURLOPT_POST, true);
            if ($body !== null) curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
        } elseif ($method !== 'GET') {
            curl_setopt($ch, CURLOPT_CUSTOMREQUEST, $method);
        }
        $resp = curl_exec($ch);
        if ($resp === false) {
            error_log('[milestone] curl: ' . curl_error($ch));
            curl_close($ch);
            return null;
        }
        $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        return ['status' => $status, 'body' => (string) $resp];
    }
}
