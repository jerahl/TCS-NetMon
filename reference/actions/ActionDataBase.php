<?php declare(strict_types=1);

namespace Modules\TcsDashboard\Actions;

use CController;
use CControllerResponseData;
use CWebUser;

/**
 * Shared base for tcs.*.data JSON controllers.
 *
 * Unauthenticated requests get a 401 JSON body so the frontend poller can
 * detect the session expiry cleanly instead of parsing the HTML login page
 * Zabbix would otherwise return.
 */
abstract class ActionDataBase extends CController {

    protected function init(): void {
        $this->disableCsrfValidation();
    }

    protected function checkPermissions(): bool {
        if (!CWebUser::isLoggedIn()) {
            http_response_code(401);
            $this->setResponse(new CControllerResponseData([
                'main_block' => json_encode(['error' => 'unauthenticated'])
            ]));
            return false;
        }

        return $this->getUserType() >= USER_TYPE_ZABBIX_USER;
    }
}
