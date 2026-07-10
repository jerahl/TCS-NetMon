<?php declare(strict_types=1);

namespace Modules\TcsDashboard\Actions;

use CControllerResponseData;
use CControllerResponseFatal;

/**
 * GET zabbix.php?action=tcs.fortigate.view
 *
 * Renders the FortiGate firewall dashboard shell. ActionFortigateData drives
 * the real rollup — this action emits a minimal SSR boot envelope so
 * fortigate-bridge.jsx can paint immediately with loading shells, then swap
 * in the live payload after fetching tcs.fortigate.data.
 */
class ActionFortigate extends ActionBase {

    protected function checkInput(): bool {
        $ret = $this->validateInput([]);
        if (!$ret) {
            $this->setResponse(new CControllerResponseFatal());
        }
        return $ret;
    }

    protected function doAction(): void {
        $boot = ActionFortigateData::emptyPayload() + ['async' => true];
        $response = new CControllerResponseData([
            'title' => _('TCS FortiGate'),
            'boot'  => $boot,
        ]);
        $response->setTitle(_('TCS FortiGate'));
        $this->setResponse($response);
    }
}
