<?php declare(strict_types=1);

namespace Modules\TcsDashboard\Actions;

use CController;
use CControllerResponseRedirect;
use CWebUser;

/**
 * Shared base for tcs.*.view controllers.
 *
 * Unauthenticated requests bounce to the Zabbix login page with `request`
 * pointing back at the original URL, instead of falling through to the
 * generic "page not found" response.
 */
abstract class ActionBase extends CController {

    protected function init(): void {
        $this->disableCsrfValidation();
    }

    protected function checkPermissions(): bool {
        if (!CWebUser::isLoggedIn()) {
            $request = $_SERVER['REQUEST_URI'] ?? '';
            $this->setResponse(new CControllerResponseRedirect(
                'index.php?request='.urlencode($request)
            ));
            return false;
        }

        return $this->getUserType() >= USER_TYPE_ZABBIX_USER;
    }
}
