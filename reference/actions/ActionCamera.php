<?php declare(strict_types=1);

namespace Modules\TcsDashboard\Actions;

use CControllerResponseData;
use CControllerResponseFatal;

/**
 * GET zabbix.php?action=tcs.camera.view&id=<cameraId>
 *
 * Renders the Milestone XProtect camera deep-dive (live preview tile, stream
 * health rings, 24h sparklines, stream/recording config, network identity,
 * recent events). Server-collected boot data comes from
 * ActionSurveillanceData::collectCameraDetail() keyed by the per-camera
 * Zabbix host id; camera.view.php embeds it as window.CAMERA_BOOT and
 * camera-bridge.jsx normalises it into the window.CAMERAS / CAM_HISTORY
 * globals nvr-camera.jsx consumes. Fields the template doesn't expose yet
 * render as honest "—" / empty placeholders.
 */
class ActionCamera extends ActionBase {

    protected function checkInput(): bool {
        $fields = [
            'hostid' => 'string',
            'id'     => 'string'
        ];

        $ret = $this->validateInput($fields);

        if (!$ret) {
            $this->setResponse(new CControllerResponseFatal());
        }

        return $ret;
    }

    protected function doAction(): void {
        $hostid = $this->getInput('hostid', '');
        $boot   = (new ActionSurveillanceData())->collectCameraDetail($hostid);

        $data = [
            'title'  => _('TCS Camera Detail'),
            'hostid' => $hostid,
            'id'     => $this->getInput('id', ''),
            'boot'   => $boot
        ];

        $response = new CControllerResponseData($data);
        $response->setTitle(_('TCS Camera Detail'));
        $this->setResponse($response);
    }
}
