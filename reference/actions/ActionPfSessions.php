<?php declare(strict_types=1);

namespace Modules\TcsDashboard\Actions;

use CControllerResponseData;
use CControllerResponseFatal;

/**
 * GET zabbix.php?action=tcs.pf.sessions.view
 *
 * Renders the User Sessions page (live 802.1X / MAB / portal sessions) from
 * the mock data in packetfence-data.jsx.
 */
class ActionPfSessions extends ActionBase {

    protected function checkInput(): bool {
        $ret = $this->validateInput([]);
        if (!$ret) {
            $this->setResponse(new CControllerResponseFatal());
        }
        return $ret;
    }

    protected function doAction(): void {
        $response = new CControllerResponseData([
            'title' => _('TCS User Sessions')
        ]);
        $response->setTitle(_('TCS User Sessions'));
        $this->setResponse($response);
    }
}
