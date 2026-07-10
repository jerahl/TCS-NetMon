<?php declare(strict_types=1);

namespace Modules\TcsDashboard\Actions;

use CControllerResponseData;
use CControllerResponseFatal;

/**
 * GET zabbix.php?action=tcs.dashboard.data&hostid=NNN
 *
 * Returns the same shape as ActionDashboard's $boot, as JSON. The frontend
 * polls this every N seconds to refresh values without re-rendering the
 * whole page.
 *
 * Implementation here is intentionally thin — it reuses the collectors on
 * ActionDashboard. If you want a leaner endpoint that only returns items
 * (no inventory / events), copy just collectItems() over.
 */
class ActionDashboardData extends ActionDataBase {

    protected function checkInput(): bool {
        $fields = [
            'hostid' => 'required|string'
        ];

        $ret = $this->validateInput($fields);

        if (!$ret) {
            $this->setResponse(new CControllerResponseFatal());
        }

        return $ret;
    }

    protected function doAction(): void {
        $hostid = $this->getInput('hostid');

        // Reuse the view controller's collectors via a fresh instance. Each
        // collector method is deliberately self-contained so this works.
        $view = new ActionDashboard();

        // Reflection lets us call the private collectors without making them
        // public on ActionDashboard. If you'd rather not use reflection,
        // promote the collectors to a shared trait or service class.
        $rc = new \ReflectionClass($view);
        $invoke = function (string $method, array $args) use ($rc, $view) {
            $m = $rc->getMethod($method);
            $m->setAccessible(true);
            return $m->invokeArgs($view, $args);
        };

        $payload = [
            'host'        => $invoke('collectHost',         [$hostid]),
            'items'       => $invoke('collectItems',        [$hostid]),
            'events'      => $invoke('collectEvents',       [$hostid]),
            'alerts'      => $invoke('collectAlertsSummary',[$hostid]),
            'wiredPorts'  => $invoke('collectWiredPorts',   [$hostid]),
            'ssids'       => $invoke('collectSsidList',     [$hostid]),
            'pfClients'   => $invoke('collectXiqClients',   [$hostid]),
            'alertsDetail'=> $invoke('collectAlertsDetail', [$hostid]),
            'ts'          => time()
        ];

        $this->setResponse(new CControllerResponseData(['main_block' => json_encode($payload)]));
    }
}
