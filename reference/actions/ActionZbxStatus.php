<?php declare(strict_types=1);

namespace Modules\TcsDashboard\Actions;

use CControllerResponseData;
use CControllerResponseFatal;

/**
 * GET zabbix.php?action=tcs.zbx.status.view
 *
 * Renders the Zabbix server + proxy health view. ActionZbxStatusData drives
 * the live rollup — this action emits a minimal SSR boot envelope so
 * zbx-status-bridge.jsx can paint immediately with loading shells, then swap
 * in the live payload after fetching tcs.zbx.status.data.
 *
 * The data action reads from the stock Zabbix templates "Zabbix server health"
 * and "Zabbix proxy health" plus the API (hanode.get, proxy.get,
 * host/item/trigger/problem/event.get).
 */
class ActionZbxStatus extends ActionBase {

    protected function checkInput(): bool {
        $ret = $this->validateInput([]);
        if (!$ret) {
            $this->setResponse(new CControllerResponseFatal());
        }
        return $ret;
    }

    protected function doAction(): void {
        $boot = ActionZbxStatusData::emptyPayload() + ['async' => true];
        $response = new CControllerResponseData([
            'title' => _('TCS Zabbix Server Status'),
            'boot'  => $boot,
        ]);
        $response->setTitle(_('TCS Zabbix Server Status'));
        $this->setResponse($response);
    }
}
