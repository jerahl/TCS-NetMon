<?php declare(strict_types=1);

namespace Modules\TcsDashboard\Actions;

use CControllerResponseData;
use CControllerResponseFatal;

/**
 * GET zabbix.php?action=tcs.pf.clients.view
 *
 * Renders the PacketFence Connected Devices inventory page from the mock data
 * baked into packetfence-data.jsx. To wire it to live PacketFence data, hit
 * /api/v1/nodes on the PF cluster and pass the payload as $data['boot'].
 */
class ActionPfClients extends ActionBase {

    protected function checkInput(): bool {
        $ret = $this->validateInput([]);
        if (!$ret) {
            $this->setResponse(new CControllerResponseFatal());
        }
        return $ret;
    }

    protected function doAction(): void {
        $response = new CControllerResponseData([
            'title' => _('TCS Connected Devices')
        ]);
        $response->setTitle(_('TCS Connected Devices'));
        $this->setResponse($response);
    }
}
