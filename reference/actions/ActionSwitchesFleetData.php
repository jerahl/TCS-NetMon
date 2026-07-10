<?php declare(strict_types=1);

namespace Modules\TcsDashboard\Actions;

use CControllerResponseData;

/**
 * GET zabbix.php?action=tcs.switches.fleet.data
 *
 * Modes (?mode= query):
 *   skeleton — fast: sites + hosts + per-host problem counts only.
 *              All counter fields (ports/up/down/poe/model/members) are
 *              zeroed in this response. Drives HostNavigator.
 *              { fleet: [...], ts }
 *   counters — slower: per-host port/PoE/stacking/model rollup, keyed
 *              by hostid. The bridge merges this into SWITCH_SITES.
 *              { counters: { "<hostid>": {ports, up, down, poe, …} }, ts }
 *   full     — both, merged. Default; preserved for legacy callers.
 *              { fleet: [...], ts }
 *
 * Splitting these lets the navigator render the moment the skeleton
 * lands — the heavy per-port item.get can fill in the page-header
 * pills a beat later. Each mode has its own APCu cache (5 min) so a
 * navigator click (full page reload) is sub-millisecond.
 */
class ActionSwitchesFleetData extends ActionDataBase {

    protected function checkInput(): bool {
        return $this->validateInput(['mode' => 'string']);
    }

    protected function doAction(): void {
        $mode = $this->getInput('mode', 'full');
        $view = new ActionSwitches();

        $payload = ['ts' => time()];

        try {
            if ($mode === 'skeleton') {
                $payload['fleet'] = $view->collectFleetSkeleton();
            } elseif ($mode === 'counters') {
                $payload['counters'] = $view->collectFleetCounters();
            } else {
                // Legacy: reflection-walks the private collectFleet() which
                // composes skeleton + counters in one shot.
                $rc = new \ReflectionClass($view);
                $m  = $rc->getMethod('collectFleet');
                $m->setAccessible(true);
                $payload['fleet'] = $m->invoke($view);
            }
        } catch (\Throwable $e) {
            error_log('[tcs_dashboard] fleet.data ('.$mode.'): '.$e->getMessage());
            if ($mode === 'counters') $payload['counters'] = new \stdClass();
            else                       $payload['fleet']    = [];
        }

        $this->setResponse(new CControllerResponseData([
            'main_block' => json_encode($payload, JSON_UNESCAPED_SLASHES)
        ]));
    }
}
