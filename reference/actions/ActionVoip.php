<?php declare(strict_types=1);

namespace Modules\TcsDashboard\Actions;

use CControllerResponseData;
use CControllerResponseFatal;

/**
 * GET zabbix.php?action=tcs.voip.view
 *
 * Renders the 3CX VoIP NOC shell. ActionVoipData drives the real rollup —
 * this action emits an empty-shape boot envelope so voip-bridge.jsx can
 * paint loading state immediately, then swap in live data after fetching
 * tcs.voip.data.
 *
 * Wiring details + the Zabbix-vs-XAPI data split live in
 * notes/voip-integration-plan.md.
 */
class ActionVoip extends ActionBase {

    protected function checkInput(): bool {
        $ret = $this->validateInput([]);
        if (!$ret) {
            $this->setResponse(new CControllerResponseFatal());
        }
        return $ret;
    }

    protected function doAction(): void {
        $boot = ActionVoipData::emptyPayload() + ['async' => true];
        $response = new CControllerResponseData([
            'title' => _('TCS VoIP · 3CX'),
            'boot'  => $boot,
        ]);
        $response->setTitle(_('TCS VoIP · 3CX'));
        $this->setResponse($response);
    }
}
