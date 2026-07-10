<?php declare(strict_types=1);

namespace Modules\TcsDashboard\Actions;

use API;
use CControllerResponseFatal;

/**
 * GET zabbix.php?action=tcs.camera.snapshot&hostid=<perCameraZabbixHost>[&size=M]
 *
 * Server-side image proxy for the camera still used by the Surveillance grid
 * thumbnails and the Camera Detail device card. Browsers strip embedded
 * user:pass credentials from <img>/<iframe> subrequests, so the still can't be
 * fetched directly with the cameras' login; this endpoint injects the shared
 * read-only credential server-side and streams the JPEG back same-origin.
 *
 * SSRF posture: the caller passes a Zabbix hostid, never a raw address. We
 * resolve the target IP from that host's own interface (and only if the host
 * is a Milestone camera, i.e. carries a cam_id tag), so the proxy can only
 * ever reach addresses already configured on camera hosts the user can see.
 *
 * Credentials live in non-secret global macros {$TCS.CAM.USER} /
 * {$TCS.CAM.PASS} — Zabbix masks SECRET_TEXT macro values when read via the
 * API, so these must be plain Text macros (the login is read-only).
 */
class ActionCameraSnapshot extends ActionDataBase {

    private const CAMERA_TEMPLATE = 'Milestone Camera by Direct Polling';
    private const SNAPSHOT_PATH   = '/snap.jpg';
    private const CONNECT_TIMEOUT = 3;
    private const TOTAL_TIMEOUT   = 6;

    protected function checkInput(): bool {
        $ret = $this->validateInput([
            'hostid' => 'required|string',
            'size'   => 'string'
        ]);
        if (!$ret) {
            $this->setResponse(new CControllerResponseFatal());
        }
        return $ret;
    }

    protected function doAction(): void {
        // Release the session lock up front: a grid can fire ~24 thumbnail
        // requests at once and PHP would otherwise serialise them all behind
        // the per-session file lock.
        if (function_exists('session_write_close')) {
            session_write_close();
        }

        $hostid = $this->getInput('hostid', '');
        $size   = $this->normSize($this->getInput('size', 'M'));

        $ip = $this->resolveCameraIp($hostid);
        if ($ip === null) {
            $this->fail(404);
            return;
        }

        [$user, $pass] = $this->credentials();
        if ($user === null) {
            $this->fail(503); // credentials not configured
            return;
        }

        $url = 'https://'.$ip.self::SNAPSHOT_PATH.'?JpegSize='.rawurlencode($size);

        $ch = curl_init();
        curl_setopt_array($ch, [
            CURLOPT_URL            => $url,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_CONNECTTIMEOUT => self::CONNECT_TIMEOUT,
            CURLOPT_TIMEOUT        => self::TOTAL_TIMEOUT,
            // Cameras use self-signed certs on the private VMS network.
            CURLOPT_SSL_VERIFYPEER => false,
            CURLOPT_SSL_VERIFYHOST => 0,
            // Auto-negotiate Basic/Digest from the camera's 401 challenge.
            CURLOPT_HTTPAUTH       => CURLAUTH_ANY,
            CURLOPT_USERPWD        => $user.':'.$pass,
        ]);
        $body = curl_exec($ch);
        $code = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $type = (string) curl_getinfo($ch, CURLINFO_CONTENT_TYPE);
        curl_close($ch);

        if ($body === false || $code !== 200 || $body === '') {
            $this->fail($code >= 400 ? $code : 502);
            return;
        }

        $this->clearOutput();
        header('Content-Type: '.($type !== '' && stripos($type, 'image/') === 0 ? $type : 'image/jpeg'));
        header('Content-Length: '.strlen($body));
        header('Cache-Control: private, max-age=5');
        echo $body;
        exit;
    }

    /** Whitelist the JpegSize value so it can't inject into the query string. */
    private function normSize(string $size): string {
        $size = trim($size);
        if (in_array(strtoupper($size), ['S', 'M', 'L', 'XL'], true)) {
            return strtoupper($size);
        }
        if (preg_match('/^\d{2,4}x\d{2,4}$/', $size)) {
            return $size;
        }
        return 'M';
    }

    /**
     * Map a per-camera Zabbix hostid to its interface IP, but only for hosts
     * that are actually Milestone cameras (cam_id tag present). Returns null
     * for unknown hosts, non-camera hosts, or hosts without a usable IP.
     */
    private function resolveCameraIp(string $hostid): ?string {
        if ($hostid === '' || !ctype_digit($hostid)) return null;

        $hosts = API::Host()->get([
            'output'           => ['hostid'],
            'hostids'          => [$hostid],
            'selectInterfaces' => ['ip', 'main'],
            'selectTags'       => 'extend',
            'selectParentTemplates' => ['host'],
            'monitored_hosts'  => true,
        ]) ?: [];
        $host = $hosts[0] ?? null;
        if (!$host) return null;

        $is_camera = false;
        foreach ($host['tags'] ?? [] as $t) {
            if (($t['tag'] ?? '') === 'cam_id') { $is_camera = true; break; }
        }
        if (!$is_camera) {
            foreach ($host['parentTemplates'] ?? [] as $t) {
                if (($t['host'] ?? '') === self::CAMERA_TEMPLATE) { $is_camera = true; break; }
            }
        }
        if (!$is_camera) return null;

        $ip = '';
        foreach ($host['interfaces'] ?? [] as $i) {
            if ((int) ($i['main'] ?? 0) === 1 && ($i['ip'] ?? '') !== '') { $ip = $i['ip']; break; }
            if ($ip === '' && ($i['ip'] ?? '') !== '') $ip = $i['ip'];
        }
        return filter_var($ip, FILTER_VALIDATE_IP) ? $ip : null;
    }

    /** Shared read-only camera login from non-secret global macros. */
    private function credentials(): array {
        $user = $this->macro('{$TCS.CAM.USER}');
        $pass = $this->macro('{$TCS.CAM.PASS}');
        if ($user === null || $user === '') return [null, null];
        return [$user, $pass ?? ''];
    }

    private function macro(string $name): ?string {
        $rows = API::UserMacro()->get([
            'output'      => ['value'],
            'globalmacro' => true,
            'filter'      => ['macro' => $name],
        ]) ?: [];
        $v = $rows[0]['value'] ?? null;
        return $v === null ? null : (string) $v;
    }

    private function clearOutput(): void {
        while (ob_get_level() > 0) {
            ob_end_clean();
        }
    }

    private function fail(int $code): void {
        $this->clearOutput();
        http_response_code($code ?: 502);
        exit;
    }
}
