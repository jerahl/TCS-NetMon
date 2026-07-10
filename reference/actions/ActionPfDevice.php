<?php declare(strict_types=1);

namespace Modules\TcsDashboard\Actions;

use API;
use CController;
use CControllerResponseData;
use CControllerResponseFatal;
use CWebUser;
use Modules\TcsDashboard\Lib\PFClient;

/**
 * POST zabbix.php?action=tcs.pf.device
 *
 * Operator-triggered per-node write actions against PacketFence. Used by
 * the Port Detail card's "Reevaluate access" and "Restart switchport"
 * buttons.
 *
 * Request (JSON):
 *   hostid — required, Zabbix host id of the switch (drives macro lookup)
 *   mac    — required, target MAC (any common formatting; normalized
 *            to lowercase colon-separated on the way in)
 *   op     — required, one of: reevaluate_access | restart_switchport
 *
 * Macros consumed (host → linked templates → globals, host wins):
 *   {$PF.URL}        — PF API base URL
 *   {$PF.USER}       — API user
 *   {$PF.PASSWORD}   — API password (Secret text)
 *   {$PF.VERIFY.SSL} — "0" to disable TLS verify; anything else verifies
 *
 * Response envelope:
 *   { ok: true,  message: "..." }
 *   { ok: false, error: "..." }
 *
 * Permissions: ZABBIX_ADMIN minimum. CSRF disabled because the endpoint
 * is invoked from same-origin fetch() with Content-Type: application/json.
 */
class ActionPfDevice extends CController {

    private const ALLOWED_OPS = ['reevaluate_access', 'restart_switchport'];

    protected function init(): void {
        $this->disableCsrfValidation();
    }

    protected function checkInput(): bool {
        $ret = $this->validateInput([
            'hostid' => 'required|string',
            'mac'    => 'required|string',
            'op'     => 'required|string'
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
        $macIn  = (string) $this->getInput('mac', '');
        $op     = (string) $this->getInput('op', '');

        $mac = self::normalizeMac($macIn);
        if ($hostid === '' || $mac === '' || !in_array($op, self::ALLOWED_OPS, true)) {
            $this->respond(['ok' => false, 'error' => 'hostid, mac and a valid op are required']);
            return;
        }

        $macros = $this->resolvePfMacros($hostid);
        if ($macros === null) {
            $this->respond(['ok' => false, 'error' => 'PacketFence macros not configured for this host']);
            return;
        }

        try {
            $pf = PFClient::fromMacros($macros);
            $result = $op === 'reevaluate_access'
                ? $pf->reevaluateAccess($mac)
                : $pf->restartSwitchport($mac);

            $this->respond([
                'ok'      => (bool) $result['ok'],
                'message' => (string) $result['message']
            ]);
        }
        catch (\Throwable $e) {
            error_log('[tcs_dashboard] pf.device '.$op.': '.$e->getMessage());
            $this->respond(['ok' => false, 'error' => $e->getMessage()]);
        }
    }

    /**
     * Walk full template ancestry (parents + parents-of-parents).
     * Zabbix's selectParentTemplates is one hop only.
     *
     * @return array<int, string>
     */
    private static function collectTemplateAncestry(string $hostid): array {
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

    private static function normalizeMac(string $mac): string {
        $hex = strtolower(preg_replace('/[^0-9a-fA-F]/', '', $mac) ?? '');
        if (strlen($hex) !== 12) return '';
        return implode(':', str_split($hex, 2));
    }

    /**
     * Same precedence chain as ActionSwitchesSnapshotData: globals first,
     * then template-inherited, then host-level (winner).
     *
     * @return array{url:string,user:string,pass:string,verify_ssl:bool}|null
     */
    private function resolvePfMacros(string $hostid): ?array {
        $names = ['{$PF.URL}', '{$PF.USER}', '{$PF.PASSWORD}', '{$PF.VERIFY.SSL}'];
        $bag = [];

        $globals = API::UserMacro()->get([
            'output'      => ['macro', 'value', 'type'],
            'globalmacro' => true,
            'filter'      => ['macro' => $names]
        ]) ?: [];
        foreach ($globals as $r) {
            // Secret/vault macros are returned without a `value` field.
            // Skip them so a readable lower-precedence value isn't
            // overwritten with nothing.
            if (!array_key_exists('value', $r)) continue;
            $bag[$r['macro']] = (string) $r['value'];
        }

        $templateIds = self::collectTemplateAncestry($hostid);
        if ($templateIds) {
            $tplMacros = API::UserMacro()->get([
                'output'  => ['macro', 'value', 'type'],
                'hostids' => $templateIds,
                'filter'  => ['macro' => $names]
            ]) ?: [];
            foreach ($tplMacros as $r) {
                if (!array_key_exists('value', $r)) continue;
                $bag[$r['macro']] = (string) $r['value'];
            }
        }

        $hostMacros = API::UserMacro()->get([
            'output'  => ['macro', 'value', 'type'],
            'hostids' => [$hostid],
            'filter'  => ['macro' => $names]
        ]) ?: [];
        foreach ($hostMacros as $r) {
            if (!array_key_exists('value', $r)) continue;
            $bag[$r['macro']] = (string) $r['value'];
        }

        $url  = $bag['{$PF.URL}']  ?? '';
        $user = $bag['{$PF.USER}'] ?? '';
        $pass = $bag['{$PF.PASSWORD}'] ?? '';
        if ($url === '' || $user === '' || $pass === '') return null;

        return [
            'url'        => $url,
            'user'       => $user,
            'pass'       => $pass,
            'verify_ssl' => ($bag['{$PF.VERIFY.SSL}'] ?? '1') !== '0'
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
