<?php declare(strict_types=1);

namespace Modules\TcsDashboard\Actions;

use CControllerResponseData;
use CControllerResponseFatal;

/**
 * GET zabbix.php?action=tcs.global.view
 *
 * Renders the unified Global Dashboard (severity strip, 24h trigger trend,
 * site-health heatmap, problems-by-domain, active triggers, top hotspots,
 * recent events). Currently powered by the synthetic data baked into
 * global-data.jsx. To wire to real data, build a global-bridge.jsx that
 * adapts a server snapshot into window.GLOBAL_KPIS / window.GLOBAL_SITES /
 * window.GLOBAL_TRIGGERS, parallel to data-bridge.jsx for AP Detail.
 */
class ActionGlobal extends ActionBase {

    protected function checkInput(): bool {
        $fields = [];

        $ret = $this->validateInput($fields);

        if (!$ret) {
            $this->setResponse(new CControllerResponseFatal());
        }

        return $ret;
    }

    protected function doAction(): void {
        // Render the shell instantly — the React app fetches data in two
        // staged calls (core + enrich) via ActionGlobalData once mounted.
        // This shaves the worst-case ~1-3s synchronous wait (3CX HTTP +
        // wide Item.get scans + 10k-row event fetch) off first paint.
        $data = [
            'title' => _('TCS Global Dashboard'),
            'boot'  => null
        ];

        $response = new CControllerResponseData($data);
        $response->setTitle(_('TCS Global Dashboard'));
        $this->setResponse($response);
    }
}
