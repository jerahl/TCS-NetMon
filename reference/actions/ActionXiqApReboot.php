<?php declare(strict_types=1);

namespace Modules\TcsDashboard\Actions;

use API;
use CController;
use CControllerResponseData;
use CControllerResponseFatal;
use CWebUser;
use Modules\TcsDashboard\Lib\XIQClient;

/**
 * POST zabbix.php?action=tcs.xiq.ap.reboot
 *
 * Operator-triggered reboot of a single XIQ-managed AP. Resolves the
 * Zabbix host's {$XIQ_DEVICE_ID} macro, then issues POST /devices/:reboot
 * via XIQClient using the global {$XIQ_API_TOKEN} (or {$XIQ_TOKEN}) token.
 *
 * Request (form-encoded or JSON):
 *   hostid — required, Zabbix host id of the AP
 *
 * Response envelope:
 *   { ok: true,  message: "..." }
 *   { ok: false, error: "..." }
 */
class ActionXiqApReboot extends CController {

    protected function init(): void {
        $this->disableCsrfValidation();
    }

    protected function checkInput(): bool {
        $ret = $this->validateInput(['hostid' => 'required|string']);
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
        if ($hostid === '') {
            $this->respond(['ok' => false, 'error' => 'hostid is required']);
            return;
        }

        $deviceIdRaw = $this->readHostMacro($hostid, '{$XIQ_DEVICE_ID}');
        if ($deviceIdRaw === null || !is_numeric($deviceIdRaw) || (int) $deviceIdRaw <= 0) {
            $this->respond([
                'ok'    => false,
                'error' => 'host macro {$XIQ_DEVICE_ID} is unset or non-numeric'
            ]);
            return;
        }
        $deviceId = (int) $deviceIdRaw;

        $token = self::xiqGlobalToken();
        if ($token === null) {
            $this->respond([
                'ok'    => false,
                'error' => 'global macro {$XIQ_API_TOKEN} is unset (SECRET_TEXT macros are unreadable — set a non-secret read-side copy)'
            ]);
            return;
        }

        try {
            $client = XIQClient::fromToken($token);
            $result = $client->rebootDevice($deviceId);
            $this->respond([
                'ok'      => (bool) $result['ok'],
                'message' => (string) $result['message']
            ]);
        }
        catch (\Throwable $e) {
            error_log('[tcs_dashboard] xiq.ap.reboot: '.$e->getMessage());
            $this->respond(['ok' => false, 'error' => $e->getMessage()]);
        }
    }

    private function readHostMacro(string $hostid, string $macro): ?string {
        $rows = API::UserMacro()->get([
            'output'  => ['macro', 'value'],
            'hostids' => [$hostid],
            'filter'  => ['macro' => [$macro]]
        ]) ?: [];
        foreach ($rows as $r) {
            if ($r['macro'] === $macro) return (string) $r['value'];
        }
        return null;
    }

    private static function xiqGlobalToken(): ?string {
        foreach (['{$XIQ_API_TOKEN}', '{$XIQ_TOKEN}'] as $name) {
            $rows = API::UserMacro()->get([
                'output'      => ['macro', 'value'],
                'globalmacro' => true,
                'filter'      => ['macro' => $name]
            ]) ?: [];
            $v = trim((string) ($rows[0]['value'] ?? ''));
            if ($v !== '') return $v;
        }
        return null;
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
