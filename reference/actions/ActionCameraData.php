<?php declare(strict_types=1);

namespace Modules\TcsDashboard\Actions;

use CControllerResponseData;
use CControllerResponseFatal;

/**
 * GET zabbix.php?action=tcs.camera.data&hostid=<cameraHostId>
 *
 * Live refresh endpoint for the Camera Detail page. Returns the same
 * { camera, history, events } shape that ActionCamera embeds at page load,
 * so camera-bridge.jsx can poll it on an interval. Thin wrapper over
 * ActionSurveillanceData::collectCameraDetail().
 */
class ActionCameraData extends ActionDataBase {

    protected function checkInput(): bool {
        $ret = $this->validateInput(['hostid' => 'string']);
        if (!$ret) {
            $this->setResponse(new CControllerResponseFatal());
        }
        return $ret;
    }

    protected function doAction(): void {
        $payload = (new ActionSurveillanceData())->collectCameraDetail($this->getInput('hostid', ''));
        $this->setResponse(new CControllerResponseData(['main_block' => json_encode($payload)]));
    }
}
