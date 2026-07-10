<?php declare(strict_types=1);

namespace Modules\TcsDashboard\Actions;

use API;
use CController;
use CControllerResponseData;
use CControllerResponseFatal;
use CWebUser;
use Modules\TcsDashboard\Lib\RConfigClient;

/**
 * POST zabbix.php?action=tcs.switch.cyclepoe
 *
 * Operator-triggered PoE-cycle for a switch port. Lifted from
 * jerahl/ZabbixSwitchPortWidgets/portdetail/actions/CyclePoe.php and adapted
 * to this module's action-controller pattern.
 *
 * Request (JSON or form-encoded):
 *   hostid   — required, Zabbix host id of the switch
 *   port     — required, port number (1..N) — passed to the rConfig snippet
 *              as the `port` variable
 *   member   — optional, stack-member index (1..8). Defaults to 1.
 *
 * Macros consumed (resolved on the host):
 *   {$RCONFIG.URL}            — base URL, https only
 *   {$RCONFIG.TOKEN}          — bearer token (Secret text recommended)
 *   {$RCONFIG.POE_SNIPPET_ID} — integer id of the stored "cycle PoE" snippet
 *   {$RCONFIG.DEVICE_ID}      — optional integer; pins device lookup
 *
 * Response envelope:
 *   { ok: true,  message: "...", http_status: 200 }
 *   { ok: false, error: "..."[, http_status: N] }
 *
 * Permissions: ZABBIX_ADMIN minimum. CSRF is disabled because the endpoint
 * is invoked from same-origin fetch() with Content-Type: application/json
 * (the harness rejects cross-site form submissions and JSON bodies require
 * a preflight under CORS, so form-style CSRF doesn't apply). Authentication
 * still goes through CWebUser::isLoggedIn() + the admin gate below.
 */
class ActionSwitchCyclePoe extends CController {

    protected function init(): void {
        $this->disableCsrfValidation();
    }

    protected function checkInput(): bool {
        $ret = $this->validateInput([
            'hostid' => 'required|string',
            'port'   => 'required|int32',
            'member' => 'int32'
        ]);
        if (!$ret) {
            $this->setResponse(new CControllerResponseFatal());
        }
        return $ret;
    }

    protected function checkPermissions(): bool {
        if (!CWebUser::isLoggedIn()) {
            http_response_code(401);
            $this->respond(['ok' => false, 'error' => 'unauthenticated']);
            return false;
        }
        if ($this->getUserType() < USER_TYPE_ZABBIX_ADMIN) {
            http_response_code(403);
            $this->respond(['ok' => false, 'error' => 'admin required']);
            return false;
        }
        return true;
    }

    protected function doAction(): void {
        $hostid = (string) $this->getInput('hostid', '');
        $port   = (int) $this->getInput('port', 0);
        $member = (int) $this->getInput('member', 1);

        if ($hostid === '' || $port <= 0) {
            $this->respond(['ok' => false, 'error' => 'hostid and port are required']);
            return;
        }

        $host = $this->loadHost($hostid);
        if ($host === null) {
            $this->respond(['ok' => false, 'error' => 'unknown hostid']);
            return;
        }

        $macros = $this->resolveRConfigMacros($hostid);
        if ($macros === null) {
            $this->respond(['ok' => false, 'error' => 'rConfig macros not configured on host']);
            return;
        }

        try {
            $client = new RConfigClient($macros['url'], $macros['token'], $macros['verify_ssl']);
            $deviceId = $client->resolveDeviceId(
                $hostid,
                $host['host'],
                $host['visible_name'],
                $host['snmp_ips'],
                $host['any_ips'],
                $macros['device_id']
            );
            // Snippet placeholder is `interface_name` (e.g. "1:7"); matches
            // the reference rConfig snippet shipped with the pf_device widget.
            $result = $client->deploySnippet($deviceId, $macros['snippet_id'], [
                'interface_name' => $member.':'.$port
            ]);

            $this->respond([
                'ok'          => (bool) $result['ok'],
                'message'     => (string) $result['message'],
                'http_status' => (int) $result['http_status']
            ]);
        }
        catch (\Throwable $e) {
            error_log('[tcs_dashboard] cyclepoe: '.$e->getMessage());
            $this->respond(['ok' => false, 'error' => $e->getMessage()]);
        }
    }

    /**
     * Walk the full template ancestry of a host (direct parents + their
     * parents, etc.) so macro lookups catch inheritance through nested
     * templates. Returns a deduped list of template ids.
     *
     * @return array<int, string>
     */
    private function collectTemplateAncestry(string $hostid): array {
        $hosts = API::Host()->get([
            'output'                => ['hostid'],
            'hostids'               => [$hostid],
            'selectParentTemplates' => ['templateid']
        ]) ?: [];
        $seen  = [];
        $queue = [];
        if ($hosts) {
            foreach (($hosts[0]['parentTemplates'] ?? []) as $t) {
                $queue[] = (string) $t['templateid'];
            }
        }
        while ($queue) {
            $batch = [];
            foreach ($queue as $tid) {
                if (!isset($seen[$tid])) {
                    $seen[$tid] = true;
                    $batch[] = $tid;
                }
            }
            $queue = [];
            if (!$batch) break;
            $rows = API::Template()->get([
                'output'                => ['templateid'],
                'templateids'           => $batch,
                'selectParentTemplates' => ['templateid']
            ]) ?: [];
            foreach ($rows as $t) {
                foreach (($t['parentTemplates'] ?? []) as $p) {
                    $pid = (string) $p['templateid'];
                    if (!isset($seen[$pid])) $queue[] = $pid;
                }
            }
        }
        return array_keys($seen);
    }

    /** @return array{host:string, ip:?string}|null */
    /** @return array{host:string, visible_name:string, snmp_ips:array<int,string>, any_ips:array<int,string>}|null */
    private function loadHost(string $hostid): ?array {
        $hosts = API::Host()->get([
            'output'           => ['hostid', 'host', 'name'],
            'selectInterfaces' => ['ip', 'main', 'type'],
            'hostids'          => [$hostid]
        ]);
        if (!$hosts) return null;

        $h = $hosts[0];
        $snmpIps = [];
        $anyIps  = [];
        foreach ($h['interfaces'] ?? [] as $iface) {
            $ip = trim((string) ($iface['ip'] ?? ''));
            if ($ip === '' || $ip === '0.0.0.0') continue;
            $anyIps[] = $ip;
            // INTERFACE_TYPE_SNMP == 2 — preferred match key for switches.
            if ((int) ($iface['type'] ?? 0) === 2) $snmpIps[] = $ip;
        }
        return [
            'host'         => (string) $h['host'],
            'visible_name' => (string) ($h['name'] ?? ''),
            'snmp_ips'     => $snmpIps,
            'any_ips'      => $anyIps
        ];
    }

    /**
     * Resolve {$RCONFIG.*} macros through the host → linked templates →
     * global chain. Host-level wins, then template-inherited, then
     * globals — matching how Zabbix itself resolves macros at runtime.
     *
     * Secret macros come through fine via output=['macro','value'] as
     * long as the requesting user has read access (admin does).
     *
     * @return array{url:string, token:string, verify_ssl:bool, snippet_id:int, device_id:?int}|null
     */
    private function resolveRConfigMacros(string $hostid): ?array {
        $names = [
            '{$RCONFIG.URL}',
            '{$RCONFIG.TOKEN}',
            '{$RCONFIG.POE_SNIPPET_ID}',
            '{$RCONFIG.DEVICE_ID}',
            '{$RCONFIG.VERIFY.SSL}'
        ];
        $bag = [];
        $diag = ['globals' => [], 'tpls' => [], 'host' => []];

        // 1. Global macros (lowest precedence). Pull ALL globals matching
        // the RCONFIG prefix — drop the exact-name filter so a single typo
        // (extra space, case mismatch, …) doesn't silently hide them. Log
        // what we actually see so misconfigurations are easy to spot.
        $globals = API::UserMacro()->get([
            'output'      => ['macro', 'value', 'type'],
            'globalmacro' => true,
            'search'      => ['macro' => '{$RCONFIG.'],
            'startSearch' => true
        ]) ?: [];
        foreach ($globals as $r) {
            $isSecret = isset($r['type']) && (int) $r['type'] !== 0;
            $diag['globals'][] = $r['macro'].($isSecret ? '(secret/vault)' : '');
            if (!in_array($r['macro'], $names, true)) continue;
            if (!array_key_exists('value', $r)) continue; // secret/vault — value not exposed via API
            $bag[$r['macro']] = (string) $r['value'];
        }

        // 2. Template-inherited macros — walk the full ancestry, not just
        // the direct parents. selectParentTemplates is one hop only, so a
        // macro on a base template that a mid-tier template inherits from
        // gets missed without recursion.
        $templateIds = $this->collectTemplateAncestry($hostid);
        if ($templateIds) {
            $tpl = API::UserMacro()->get([
                'output'      => ['macro', 'value', 'type', 'hostid'],
                'hostids'     => $templateIds,
                'search'      => ['macro' => '{$RCONFIG.'],
                'startSearch' => true
            ]) ?: [];
            foreach ($tpl as $r) {
                $isSecret = isset($r['type']) && (int) $r['type'] !== 0;
                $diag['tpls'][] = $r['macro'].'@'.$r['hostid'].($isSecret ? '(secret/vault)' : '');
                if (!in_array($r['macro'], $names, true)) continue;
                if (!array_key_exists('value', $r)) continue;
                $bag[$r['macro']] = (string) $r['value'];
            }
        }

        // 3. Host-level (highest precedence).
        $hostRows = API::UserMacro()->get([
            'output'      => ['macro', 'value', 'type'],
            'hostids'     => [$hostid],
            'search'      => ['macro' => '{$RCONFIG.'],
            'startSearch' => true
        ]) ?: [];
        foreach ($hostRows as $r) {
            $isSecret = isset($r['type']) && (int) $r['type'] !== 0;
            $diag['host'][] = $r['macro'].($isSecret ? '(secret/vault)' : '');
            if (!in_array($r['macro'], $names, true)) continue;
            if (!array_key_exists('value', $r)) continue;
            $bag[$r['macro']] = (string) $r['value'];
        }

        error_log(sprintf(
            '[tcs_dashboard] cyclepoe macros found — host[%s]=[%s] tpls(%d)=[%s] globals=[%s]',
            $hostid,
            implode(',', $diag['host']),
            count($templateIds),
            implode(',', $diag['tpls']),
            implode(',', $diag['globals'])
        ));

        $url     = $bag['{$RCONFIG.URL}'] ?? '';
        $token   = $bag['{$RCONFIG.TOKEN}'] ?? '';
        $snippet = (int) ($bag['{$RCONFIG.POE_SNIPPET_ID}'] ?? 0);
        if ($url === '' || $token === '' || $snippet <= 0) {
            error_log(sprintf(
                '[tcs_dashboard] cyclepoe: macros missing — url=%s token=%s snippet=%s (host %s + %d template(s) + globals)',
                $url !== '' ? 'set' : 'EMPTY',
                $token !== '' ? 'set' : 'EMPTY',
                $snippet > 0 ? (string) $snippet : 'EMPTY',
                $hostid, count($templateIds)
            ));
            return null;
        }

        $deviceMacro = isset($bag['{$RCONFIG.DEVICE_ID}']) && $bag['{$RCONFIG.DEVICE_ID}'] !== ''
            ? (int) $bag['{$RCONFIG.DEVICE_ID}']
            : null;

        return [
            'url'        => $url,
            'token'      => $token,
            'verify_ssl' => ($bag['{$RCONFIG.VERIFY.SSL}'] ?? '1') !== '0',
            'snippet_id' => $snippet,
            'device_id'  => $deviceMacro
        ];
    }

    private function respond(array $payload): void {
        if (!headers_sent()) {
            header('Content-Type: application/json; charset=utf-8');
            header('Cache-Control: no-store');
            header('X-Content-Type-Options: nosniff');
        }
        echo json_encode($payload);
        $this->setResponse(new CControllerResponseData(['main_block' => '']));
        exit;
    }
}
