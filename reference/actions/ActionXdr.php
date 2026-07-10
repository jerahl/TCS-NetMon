<?php declare(strict_types=1);

namespace Modules\TcsDashboard\Actions;

use CControllerResponseData;
use CControllerResponseFatal;

/**
 * GET zabbix.php?action=tcs.xdr.view
 *
 * Renders the Cortex XDR security ops dashboard from the mock data in
 * xdr-data.jsx. To wire to live data, call the Cortex XDR REST API
 * (incidents, alerts, agents) and pass the payload as $data['boot'].
 */
class ActionXdr extends ActionBase {

    protected function checkInput(): bool {
        $ret = $this->validateInput([]);
        if (!$ret) {
            $this->setResponse(new CControllerResponseFatal());
        }
        return $ret;
    }

    protected function doAction(): void {
        $response = new CControllerResponseData([
            'title' => _('TCS Cortex XDR')
        ]);
        $response->setTitle(_('TCS Cortex XDR'));
        $this->setResponse($response);
    }
}
