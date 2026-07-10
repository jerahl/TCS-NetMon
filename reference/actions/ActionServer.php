<?php declare(strict_types=1);

namespace Modules\TcsDashboard\Actions;

use CControllerResponseData;
use CControllerResponseFatal;

/**
 * GET zabbix.php?action=tcs.server.view&id=<serverId>
 *
 * Renders the Milestone XProtect recording server deep-dive (KPI strip, 24h
 * dual-line CPU/Mem chart, health rings, recording channel grid, RAID array,
 * network interfaces, cameras-on-this-server). Currently powered by mock
 * data in nvr-data.jsx. Real data: a mix of XProtect Mgmt Server REST API
 * and Zabbix items templated against the recording server itself (Dell
 * iDRAC SNMP for hardware health, Windows agent for OS metrics). Mirror the
 * data-bridge pattern from AP Detail.
 */
class ActionServer extends ActionBase {

    protected function checkInput(): bool {
        $fields = [
            'id' => 'string'
        ];

        $ret = $this->validateInput($fields);

        if (!$ret) {
            $this->setResponse(new CControllerResponseFatal());
        }

        return $ret;
    }

    protected function doAction(): void {
        $data = [
            'title' => _('TCS Recording Server Detail'),
            'id'    => $this->getInput('id', '')
        ];

        $response = new CControllerResponseData($data);
        $response->setTitle(_('TCS Recording Server Detail'));
        $this->setResponse($response);
    }
}
