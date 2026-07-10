<?php declare(strict_types=1);

namespace Modules\TcsDashboard\Actions;

use CControllerResponseData;
use CControllerResponseFatal;

/**
 * GET zabbix.php?action=tcs.pf.status.view
 *
 * Renders the PacketFence cluster/performance status page from the mock data
 * in packetfence-data.jsx.
 */
class ActionPfStatus extends ActionBase {

    protected function checkInput(): bool {
        $ret = $this->validateInput([]);
        if (!$ret) {
            $this->setResponse(new CControllerResponseFatal());
        }
        return $ret;
    }

    protected function doAction(): void {
        $response = new CControllerResponseData([
            'title' => _('TCS PacketFence Status')
        ]);
        $response->setTitle(_('TCS PacketFence Status'));
        $this->setResponse($response);
    }
}
