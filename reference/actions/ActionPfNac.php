<?php declare(strict_types=1);

namespace Modules\TcsDashboard\Actions;

use CControllerResponseData;
use CControllerResponseFatal;

/**
 * GET zabbix.php?action=tcs.pf.nac.view
 *
 * Renders the NAC Policies page (auth sources, role/VLAN map, profiles,
 * enforcement rules) from the mock data in packetfence-data.jsx.
 */
class ActionPfNac extends ActionBase {

    protected function checkInput(): bool {
        $ret = $this->validateInput([]);
        if (!$ret) {
            $this->setResponse(new CControllerResponseFatal());
        }
        return $ret;
    }

    protected function doAction(): void {
        $response = new CControllerResponseData([
            'title' => _('TCS NAC Policies')
        ]);
        $response->setTitle(_('TCS NAC Policies'));
        $this->setResponse($response);
    }
}
