<?php declare(strict_types=1);

namespace Modules\TcsDashboard\Actions;

use API;
use CControllerResponseData;
use Modules\TcsDashboard\Lib\ThreeCXClient;

/**
 * GET zabbix.php?action=tcs.voip.top.data
 *
 * Top-talker table (VOIP_TOP). Split off from the main rollup because
 * /ReportExtensionStatistics returns 404/403 on builds without the
 * report module licensed — and even when it works, the query is
 * relatively expensive on large districts. 60s cache.
 */
class ActionVoipTopData extends ActionDataBase {

    private const CACHE_TTL = 60;
    private const CACHE_KEY = 'tcs_dashboard:voip:top:v1';

    protected function checkInput(): bool {
        return $this->validateInput([]);
    }

    protected function doAction(): void {
        if (function_exists('session_write_close')) {
            session_write_close();
        }

        $payload = ['top' => null, 'sources' => ['3cx' => 'unknown'], 'ts' => time()];

        try {
            $cached = self::cacheGet();
            if ($cached !== null) {
                $payload = $cached;
                $payload['ts'] = $payload['ts'] ?? time();
            } else {
                $cfg = [
                    'url'           => self::globalMacro('{$TCS.3CX.URL}'),
                    'client_id'     => self::globalMacro('{$TCS.3CX.CLIENT_ID}'),
                    'client_secret' => self::globalMacro('{$TCS.3CX.CLIENT_SECRET}'),
                    'verify_ssl'    => self::globalMacro('{$TCS.3CX.VERIFY.SSL}') !== '0',
                ];
                if ($cfg['url'] === '' || $cfg['client_id'] === '') {
                    $payload['sources']['3cx'] = 'unconfigured';
                } else {
                    $client            = ThreeCXClient::fromMacros($cfg);
                    $rows              = $client->topExtensions(10);
                    $payload['top']    = ActionVoipData::mapTopExtensionsPublic($rows);
                    $payload['sources']['3cx'] = $rows ? 'live' : 'empty';
                }
                $payload['ts'] = time();
                if (in_array($payload['sources']['3cx'] ?? '', ['live', 'empty'], true)) {
                    self::cacheSet($payload);
                }
            }
        } catch (\Throwable $e) {
            error_log('[tcs_dashboard] voip.top.data: ' . $e->getMessage());
            $payload['error']          = $e->getMessage();
            $payload['sources']['3cx'] = 'error';
        }

        $this->setResponse(new CControllerResponseData([
            'main_block' => json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE)
        ]));
    }

    private static function cacheGet(): ?array {
        if (!function_exists('apcu_fetch')) return null;
        $hit = apcu_fetch(self::CACHE_KEY, $ok);
        return ($ok && is_array($hit)) ? $hit : null;
    }

    private static function cacheSet(array $payload): void {
        if (function_exists('apcu_store')) {
            apcu_store(self::CACHE_KEY, $payload, self::CACHE_TTL);
        }
    }

    private static function globalMacro(string $name): string {
        $rows = API::UserMacro()->get([
            'output'      => ['macro', 'value'],
            'globalmacro' => true,
            'filter'      => ['macro' => $name],
        ]) ?: [];
        return trim((string) ($rows[0]['value'] ?? ''));
    }
}
