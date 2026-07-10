<?php declare(strict_types=1);

namespace Modules\TcsDashboard\Actions;

use CControllerResponseData;
use CControllerResponseFatal;

/**
 * GET zabbix.php?action=tcs.problems.view
 *
 * The Problems page is a graphical view of the same event stream the
 * Events Console consumes — we boot from ActionEventsData so both pages
 * share the bridge (events-bridge.jsx → window.EV_EVENTS).
 *
 * Uses the 'open' range so only currently-firing problems are returned;
 * the default 24h range mixes in problem-start rows whose recovery event
 * has already fired and recovery events themselves, which the page would
 * then render as washed-out "resolved" tiles.
 */
class ActionProblems extends ActionBase {

    protected function checkInput(): bool {
        $ret = $this->validateInput([]);
        if (!$ret) {
            $this->setResponse(new CControllerResponseFatal());
        }
        return $ret;
    }

    protected function doAction(): void {
        $boot = (new ActionEventsData())->collect(['range' => 'open']);
        $response = new CControllerResponseData([
            'title' => _('TCS Problems'),
            'boot'  => $boot
        ]);
        $response->setTitle(_('TCS Problems'));
        $this->setResponse($response);
    }
}
