<?php declare(strict_types=1);

namespace Modules\TcsDashboard\Actions;

use API;
use CControllerResponseData;
use CControllerResponseFatal;

/**
 * POST zabbix.php?action=tcs.events.update
 *
 * Thin wrapper around API::Event()->acknowledge() so the Events Console can
 * acknowledge, suppress, change severity, add messages, or close events
 * without leaving the page. Returns a small JSON envelope:
 *
 *   { ok: true,  eventids: [...] }
 *   { ok: false, error: "..." }
 *
 * Request body (form-encoded or JSON):
 *   eventids[]       — at least one
 *   op               — bitmask (matches Zabbix ZBX_PROBLEM_UPDATE_* flags):
 *                      1=close, 2=ack, 4=message, 8=severity,
 *                      16=unack, 32=suppress, 64=unsuppress
 *                      (named `op`, not `action`, to avoid colliding with
 *                       Zabbix's own routing `action` query param)
 *   message          — optional, used when bit 4 is set
 *   severity         — optional 0-5, used when bit 8 is set
 *   suppress_until   — optional unix timestamp, used when bit 32 is set
 */
class ActionEventsUpdate extends ActionDataBase {

    protected function checkInput(): bool {
        $ret = $this->validateInput([
            'eventids'       => 'array',
            'op'             => 'int32',
            'message'        => 'string',
            'severity'       => 'int32',
            'suppress_until' => 'int32'
        ]);
        if (!$ret) {
            $this->setResponse(new CControllerResponseFatal());
        }
        return $ret;
    }

    protected function doAction(): void {
        $eventids = $this->getInput('eventids', []);
        $eventids = array_values(array_filter(array_map('strval', (array) $eventids), fn($v) => $v !== ''));
        $op       = (int) $this->getInput('op', 0);

        if (!$eventids) {
            $this->respond(['ok' => false, 'error' => 'no eventids']);
            return;
        }
        if ($op <= 0) {
            $this->respond(['ok' => false, 'error' => 'no op']);
            return;
        }

        $params = [
            'eventids' => count($eventids) === 1 ? $eventids[0] : $eventids,
            'action'   => $op
        ];

        if ($op & 4) {
            $msg = trim((string) $this->getInput('message', ''));
            if ($msg === '') {
                $this->respond(['ok' => false, 'error' => 'message required']);
                return;
            }
            $params['message'] = $msg;
        }
        if ($op & 8) {
            $sev = (int) $this->getInput('severity', -1);
            if ($sev < 0 || $sev > 5) {
                $this->respond(['ok' => false, 'error' => 'severity must be 0-5']);
                return;
            }
            $params['severity'] = $sev;
        }
        if ($op & 32) {
            $until = (int) $this->getInput('suppress_until', 0);
            if ($until <= time()) {
                $until = time() + 3600;
            }
            $params['suppress_until'] = $until;
        }

        try {
            API::Event()->acknowledge($params);
            $this->respond(['ok' => true, 'eventids' => $eventids]);
        } catch (\Throwable $e) {
            error_log('[tcs] events update failed: '.$e->getMessage());
            $this->respond(['ok' => false, 'error' => $e->getMessage()]);
        }
    }

    private function respond(array $payload): void {
        // Bypass the Zabbix view/layout pipeline entirely. Even with
        // layout.json wired up in manifest, POST responses occasionally come
        // back wrapped in HTML chrome (login-expired page, CSRF redirect,
        // etc.). Emitting headers + body + exit gives the fetch() helper a
        // clean JSON document to parse.
        if (!headers_sent()) {
            header('Content-Type: application/json; charset=utf-8');
            header('Cache-Control: no-store');
            header('X-Content-Type-Options: nosniff');
        }
        echo json_encode($payload);
        // We still register an empty response so the framework doesn't
        // complain, but main_block stays empty — output already flushed.
        $this->setResponse(new CControllerResponseData(['main_block' => '']));
        exit;
    }
}
