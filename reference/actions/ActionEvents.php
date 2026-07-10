<?php declare(strict_types=1);

namespace Modules\TcsDashboard\Actions;

use CControllerResponseData;
use CControllerResponseFatal;

/** GET zabbix.php?action=tcs.events.view */
class ActionEvents extends ActionBase {

    protected function checkInput(): bool {
        $ret = $this->validateInput([]);
        if (!$ret) {
            $this->setResponse(new CControllerResponseFatal());
        }
        return $ret;
    }

    protected function doAction(): void {
        $boot = (new ActionEventsData())->collect();
        $response = new CControllerResponseData([
            'title' => _('TCS Events Console'),
            'boot'  => $boot
        ]);
        $response->setTitle(_('TCS Events Console'));
        $this->setResponse($response);
    }
}
