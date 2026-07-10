<?php declare(strict_types=1);

namespace Modules\TcsDashboard\Actions;

use CControllerResponseData;
use CControllerResponseFatal;

/**
 * GET zabbix.php?action=tcs.pf.quarantine.view
 *
 * Renders the Quarantine page (isolated endpoints, violation catalog,
 * remediation queue) from the mock data in packetfence-data.jsx.
 */
class ActionPfQuarantine extends ActionBase {

    protected function checkInput(): bool {
        $ret = $this->validateInput([]);
        if (!$ret) {
            $this->setResponse(new CControllerResponseFatal());
        }
        return $ret;
    }

    protected function doAction(): void {
        $response = new CControllerResponseData([
            'title' => _('TCS Quarantine')
        ]);
        $response->setTitle(_('TCS Quarantine'));
        $this->setResponse($response);
    }
}
