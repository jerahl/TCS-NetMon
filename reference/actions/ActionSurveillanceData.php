<?php declare(strict_types=1);

namespace Modules\TcsDashboard\Actions;

use API;
use CControllerResponseData;
use CControllerResponseFatal;

/**
 * GET zabbix.php?action=tcs.surveillance.data
 *
 * Live snapshot for the Surveillance / Milestone XProtect NOC view. Reads
 * items off hosts running the "Milestone XProtect by HTTP" template
 * (one host per XProtect site) plus the per-camera Zabbix hosts the Site
 * template's host_prototype creates (Discovered hosts/Milestone Cameras,
 * each running "Milestone Camera by Direct Polling").
 *
 * Output shape mirrors the window globals that nvr-overview.jsx already
 * consumes (MILESTONE, SITES, SERVERS, CAMERAS, VMS_ALARMS, FLEET_HISTORY);
 * surveillance-bridge.jsx is responsible for the actual window.* assignment.
 *
 * This is a first wiring pass — fields the template doesn't yet supply
 * (storage TB, evidence locks, Smart Client sessions, archive lag) are
 * returned as null so the bridge can fall through to mock values.
 */
class ActionSurveillanceData extends ActionDataBase {

    /** Template name that marks a Milestone XProtect site host. */
    private const SITE_TEMPLATE = 'Milestone XProtect by HTTP';

    /** Template name on each per-camera Zabbix host. */
    private const CAMERA_TEMPLATE = 'Milestone Camera by Direct Polling';

    /** Set by buildCameras() so collect() can surface per-camera grouping
     *  diagnostics on the response. Temporary debug — surfaces which
     *  attribution path is firing for each camera and what fields the
     *  per-camera items currently carry. */
    private array $camGroupDiag = [];

    /** Optional site host-group prefix (matches ActionGlobalData). */
    private const SITE_GROUP_PREFIX = 'Site/';

    /** Item keys we read directly off the Milestone site host. */
    private const SITE_KEYS = [
        'siteName'      => 'milestone.site.name',
        'siteVersion'   => 'milestone.site.version',
        'physicalMem'   => 'milestone.site.physicalmemory',
        'handshakeAge'  => 'milestone.site.handshake.age',
        'lastHandshake' => 'milestone.site.lasthandshake',
        'licenseRaw'    => 'milestone.license.get'
    ];

    protected function checkInput(): bool {
        $ret = $this->validateInput(['hostid' => 'string', 'stage' => 'string']);
        if (!$ret) {
            $this->setResponse(new CControllerResponseFatal());
        }
        return $ret;
    }

    protected function doAction(): void {
        $hostid = $this->getInput('hostid', '');
        $stage  = (string) $this->getInput('stage', '');

        // Staged loading: the frontend fires summary/cameras/servers/history
        // in parallel so the cheap pieces (header tiles, site grid, alarms)
        // paint long before the expensive ones (per-camera roll-up, 24h
        // event.get). Without a stage param the legacy full payload still
        // builds so any external caller / link keeps working.
        $payload = $stage !== ''
            ? $this->collectStage($stage, $hostid)
            : $this->collect($hostid);

        $this->setResponse(new CControllerResponseData(['main_block' => json_encode($payload)]));
    }

    /**
     * Build one slice of the surveillance payload. Each stage is cached
     * independently in APCu (15s TTL) so concurrent NOC tabs share work
     * and the 30s frontend poll doesn't redo the heavy paths.
     *
     *   summary  → milestone + sites + alarms + siteDetails + evidenceLocks
     *   cameras  → cameras list
     *   servers  → recording-server tiles
     *   history  → 24h fleet sparklines
     */
    public function collectStage(string $stage, string $active_hostid = ''): array {
        $cacheKey = 'tcs_dashboard:surveillance_stage:' . $stage . ':' . md5($active_hostid);
        if (function_exists('apcu_fetch')) {
            $hit = apcu_fetch($cacheKey, $ok);
            if ($ok && is_array($hit)) return $hit;
        }

        $site_hosts = $this->findSiteHosts();
        if (!$site_hosts) {
            return ['stage' => $stage, 'ts' => time()];
        }
        $site_host_ids = array_keys($site_hosts);
        $site_items    = $this->collectSiteItems($site_host_ids);

        $out = ['stage' => $stage, 'ts' => time()];

        switch ($stage) {
            case 'summary': {
                // Cheapest stage — gates the loading splash. Per-camera
                // host queries (findCameraHosts) and DVR-agent enrichment
                // (findDvrAgentHosts) are skipped here; buildMilestoneSummary
                // and buildSites don't read cam_hosts, and alarms over the
                // site-host scope is enough to size the activeAlarms tile.
                $problems = $this->collectProblems($site_host_ids);
                $out['milestone']     = $this->buildMilestoneSummary($site_hosts, $site_items, [], $problems);
                $out['sites']         = $this->buildSites($site_hosts, $site_items, [], $problems);
                $out['alarms']        = $this->buildAlarms($problems);
                $out['siteDetails']   = (object) [];
                $out['evidenceLocks'] = [];
                break;
            }
            case 'cameras': {
                $cam_hosts       = $this->findCameraHosts();
                $out['cameras']  = $this->buildCameras($site_hosts, $site_items, $cam_hosts);
                // Surface the per-camera grouping diagnostic so the
                // Cameras-tab navigator issue is debuggable from the
                // payload — directGroupHits vs. snapFallbackHits vs.
                // siteFallbackHits tells you which attribution path
                // (or none) actually fired.
                $out['__camGroupDiag'] = $this->camGroupDiag;
                break;
            }
            case 'servers': {
                $dvr_agents      = $this->findDvrAgentHosts($site_items);
                $out['servers']  = $this->buildServers($site_hosts, $site_items, $dvr_agents);
                break;
            }
            case 'history': {
                $cam_hosts    = $this->findCameraHosts();
                $dvr_agents   = $this->findDvrAgentHosts($site_items);
                $all_host_ids = array_merge(
                    $site_host_ids,
                    array_keys($cam_hosts),
                    array_keys($dvr_agents['hosts'])
                );
                $cameras      = $this->buildCameras($site_hosts, $site_items, $cam_hosts);
                $out['fleetHistory'] = $this->buildFleetHistory($all_host_ids, $cameras);
                break;
            }
        }

        if (function_exists('apcu_store')) {
            apcu_store($cacheKey, $out, 15);
        }
        return $out;
    }

    /**
     * Build the full surveillance boot payload.
     */
    public function collect(string $active_hostid = ''): array {
        // Short-lived APCu cache: the fleet collection is heavy (license, RS
        // LLD, per-camera items, problems) and the page polls every 30s, often
        // across several NOC screens. A 15s TTL keeps data fresh-enough while
        // collapsing concurrent/repeat loads onto one collection.
        $cacheKey = 'tcs_dashboard:surveillance_collect:' . md5($active_hostid);
        if (function_exists('apcu_fetch')) {
            $hit = apcu_fetch($cacheKey, $ok);
            if ($ok && is_array($hit)) return $hit;
        }

        $site_hosts = $this->findSiteHosts();
        if (!$site_hosts) {
            return $this->emptyPayload();
        }

        $site_host_ids = array_keys($site_hosts);

        // ── Site-host items (license, RS LLD, camera LLD per-field) ──
        $site_items = $this->collectSiteItems($site_host_ids);

        // ── Per-camera Zabbix hosts (ICMP, vendor SNMP) ──
        $cam_hosts = $this->findCameraHosts();

        // ── DVR / recording-server Windows hosts running zabbix-agent2,
        //    joined to the Milestone RS rows by hostname. Gives us live
        //    CPU / mem / disk / uptime for the Recording Servers tiles. ──
        $dvr_agents = $this->findDvrAgentHosts($site_items);

        // ── Open problems on the whole fleet (site hosts + per-camera hosts
        //    + the DVR agent hosts so RS-side alerts land in the alarm feed) ──
        $all_host_ids = array_merge(
            $site_host_ids,
            array_keys($cam_hosts),
            array_keys($dvr_agents['hosts'])
        );
        $problems     = $this->collectProblems($all_host_ids);

        $milestone = $this->buildMilestoneSummary($site_hosts, $site_items, $cam_hosts, $problems);
        $sites     = $this->buildSites($site_hosts, $site_items, $cam_hosts, $problems);
        $servers   = $this->buildServers($site_hosts, $site_items, $dvr_agents);
        $cameras   = $this->buildCameras($site_hosts, $site_items, $cam_hosts);
        $alarms    = $this->buildAlarms($problems);
        $history   = $this->buildFleetHistory($all_host_ids, $cameras);

        $payload = [
            'milestone'     => $milestone,
            'sites'         => $sites,
            'servers'       => $servers,
            'cameras'       => $cameras,
            'alarms'        => $alarms,
            'fleetHistory'  => $history,
            // Per-site address / VLAN / AP-count metadata for the Sites
            // tab. Not yet templated — return an empty object so the
            // bridge renders dashes. Future: pull from a host-inventory
            // lookup or a separate /api/rest/v1/sites enrichment.
            'siteDetails'   => (object) [],
            // XProtect /api/rest/v1/evidence rows (case # / locked
            // cameras / footage range). Not yet templated — empty list
            // so the Evidence Lock tab shows a clean empty state.
            'evidenceLocks' => [],
            // Temporary diagnostic for the Cameras-navigator grouping issue.
            // Surfaces which attribution path fired for how many cameras.
            '__camGroupDiag' => $this->camGroupDiag,
            'ts'            => time()
        ];

        if (function_exists('apcu_store')) {
            apcu_store($cacheKey, $payload, 15);
        }
        return $payload;
    }

    /**
     * Per-camera deep-dive payload for the Camera Detail page
     * (tcs.camera.view / tcs.camera.data). Keyed by the per-camera Zabbix
     * host id — the same id the Surveillance camera tiles/rows link with.
     *
     * Reuses the fleet collection path (findSiteHosts → collectSiteItems →
     * buildCameras) and picks out the one row matching $hostid, then layers
     * on a recent-events feed (open problems on that host) and 24h ICMP
     * sparklines. Untemplated fields stay null / empty so the bridge renders
     * honest "—" placeholders rather than mock values.
     *
     * @return array{camera: ?array, history: array, events: array, ts: int}
     */
    public function collectCameraDetail(string $hostid): array {
        if ($hostid === '') {
            return ['camera' => null, 'history' => $this->emptyCamHistory(), 'events' => [], 'ts' => time()];
        }

        $site_hosts = $this->findSiteHosts();
        $site_items = $site_hosts ? $this->collectSiteItems(array_keys($site_hosts)) : [];
        $cam_hosts  = $this->findCameraHosts();

        $camera = null;
        foreach ($this->buildCameras($site_hosts, $site_items, $cam_hosts) as $c) {
            if ((string) ($c['hostid'] ?? '') === $hostid) { $camera = $c; break; }
        }

        // PacketFence enrichment (uplink switch+port, node role/IP/lastSeen,
        // admin URL for the View-in-PF link). Mirrors the AP detail page's
        // PF panel so the buttons + uplink info share one code path.
        $pf = $this->collectCameraPfDetail($hostid, (string) ($camera['mac'] ?? ''));

        return [
            'camera'    => $camera,
            'history'   => $this->buildCameraHistory($hostid),
            'events'    => $this->buildCameraEvents($hostid),
            'pfUplink'  => $pf['uplink'],
            'pfDevice'  => $pf['device'],
            'pfAdmin'   => $pf['adminUrl'],
            'ts'        => time()
        ];
    }

    /**
     * PacketFence enrichment for one camera: upstream switch + port (via PF
     * locationlog by MAC), node info (role/IP/host/lastSeen), and the PF
     * admin UI base for the "View in PacketFence" link. Reuses the AP
     * detail page's helpers (ActionDashboard) so the AP and camera panels
     * stay consistent.
     *
     * Empty fields when PF macros aren't set, the MAC is blank, or PF has
     * no matching locationlog / node — the frontend renders honest "—".
     */
    private function collectCameraPfDetail(string $hostid, string $mac): array {
        $dash = new ActionDashboard();
        $out = [
            'uplink'   => null,
            'device'   => null,
            'adminUrl' => $dash->resolvePfAdminUrl($hostid),
        ];
        if ($mac === '' || $mac === '—' || $hostid === '') return $out;

        // Uplink: PF locationlog → switch + port + switch hostid.
        $uplink = $dash->collectPfApUplink($hostid, $mac);
        if (is_array($uplink)) $out['uplink'] = $uplink;

        // Node info: PFClient->node($mac) for role / status / IP / lastSeen.
        $macros = $dash->resolvePfMacros($hostid);
        if ($macros !== null) {
            try {
                $pf   = \Modules\TcsDashboard\Lib\PFClient::fromMacros($macros);
                $node = $pf->node(strtolower($mac));
                if (is_array($node) && $node) {
                    $out['device'] = [
                        'mac'       => (string) ($node['mac']         ?? $mac),
                        'ip'        => (string) ($node['last_ip']     ?? ($node['ip'] ?? '')),
                        'host'      => (string) ($node['computername'] ?? ($node['device_class'] ?? '')),
                        'role'      => (string) ($node['category']    ?? ''),
                        'reg'       => strtolower((string) ($node['status'] ?? '')) === 'reg' ? 'REG' : 'UNREG',
                        'lastSeen'  => (string) ($node['last_seen']   ?? ''),
                        'lastDhcp'  => (string) ($node['last_dhcp']   ?? ''),
                        'vendor'    => (string) ($node['device_manufacturer'] ?? ''),
                        'os'        => (string) ($node['device_type'] ?? ''),
                        'owner'     => (string) ($node['pid']         ?? ''),
                    ];
                }
            } catch (\Throwable $e) {
                error_log('[tcs_dashboard] camera PF node lookup ('.$mac.'): '.$e->getMessage());
            }
        }
        return $out;
    }

    /** Empty 48-bucket sparkline set for the camera detail telemetry strip. */
    private function emptyCamHistory(): array {
        return [
            'fps'        => [],
            'bitrate'    => [],
            'packetLoss' => [],
            'motion'     => [],
            'cpu'        => [],
            'mem'        => [],
            'temp'       => [],
            'latency'    => []
        ];
    }

    /**
     * 24h sparklines for one camera. Only the ICMP latency / loss series are
     * templated today (the per-camera "Milestone Camera by Direct Polling"
     * host carries the standard icmpping* items); everything else stays an
     * empty array so the bridge zeroes the chart instead of faking a trend.
     */
    private function buildCameraHistory(string $hostid): array {
        $out = $this->emptyCamHistory();

        $items = $this->safeGet(fn() => API::Item()->get([
            'output'   => ['itemid', 'key_', 'value_type'],
            'hostids'  => [$hostid],
            'filter'   => ['key_' => ['icmppingsec', 'icmppingloss']],
            'webitems' => false
        ]));
        if (!$items) return $out;

        $by_key = [];
        foreach ($items as $it) $by_key[$it['key_']] = $it;

        // icmppingsec is seconds → surface as ms for the ONVIF-latency cell.
        if (isset($by_key['icmppingsec'])) {
            $series = $this->bucketHistory($by_key['icmppingsec'], 48);
            $out['latency'] = array_map(fn($v) => round($v * 1000, 1), $series);
        }
        if (isset($by_key['icmppingloss'])) {
            $out['packetLoss'] = $this->bucketHistory($by_key['icmppingloss'], 48);
        }
        return $out;
    }

    /**
     * Down-sample a numeric item's last 24h of history into N averaged
     * buckets. Empty buckets carry the previous bucket's value (last-known)
     * so the sparkline stays continuous instead of dropping to zero.
     */
    private function bucketHistory(array $item, int $bucket_count): array {
        $value_type = (int) ($item['value_type'] ?? 0); // 0 float, 3 uint
        $window     = 24 * 3600;
        $start      = time() - $window;
        $bucket_sec = (int) ($window / $bucket_count);

        $rows = $this->safeGet(fn() => API::History()->get([
            'output'    => ['clock', 'value'],
            'itemids'   => [$item['itemid']],
            'history'   => $value_type,
            'time_from' => $start,
            'sortfield' => 'clock',
            'sortorder' => 'ASC',
            'limit'     => 20000
        ]));

        $sum = array_fill(0, $bucket_count, 0.0);
        $cnt = array_fill(0, $bucket_count, 0);
        foreach ($rows as $r) {
            $b = (int) (((int) $r['clock'] - $start) / $bucket_sec);
            if ($b < 0 || $b >= $bucket_count) continue;
            $sum[$b] += (float) $r['value'];
            $cnt[$b]++;
        }

        $out = array_fill(0, $bucket_count, 0.0);
        $last = 0.0;
        for ($i = 0; $i < $bucket_count; $i++) {
            if ($cnt[$i] > 0) { $last = $sum[$i] / $cnt[$i]; }
            $out[$i] = round($last, 4);
        }
        return $out;
    }

    /** Open problems on a single camera host → Recent Events rows. */
    private function buildCameraEvents(string $hostid): array {
        $sev_label = [0 => 'info', 1 => 'info', 2 => 'warning', 3 => 'warning', 4 => 'high', 5 => 'disaster'];
        $out = [];
        foreach ($this->collectProblems([$hostid]) as $p) {
            $out[] = [
                'ts'  => date('H:i:s', (int) $p['clock']),
                'src' => 'ZBX',
                'sev' => $sev_label[(int) $p['severity']] ?? 'info',
                'msg' => $p['name']
            ];
        }
        return $out;
    }

    private function emptyPayload(): array {
        return [
            'milestone'     => null,
            'sites'         => [],
            'servers'       => [],
            'cameras'       => [],
            'alarms'        => [],
            'fleetHistory'  => null,
            'siteDetails'   => (object) [],
            'evidenceLocks' => [],
            'ts'            => time()
        ];
    }

    /* --------------------------------------------------------------------- */

    /** Hosts that link the Milestone XProtect site template. */
    private function findSiteHosts(): array {
        $tpls = $this->safeGet(fn() => API::Template()->get([
            'output' => ['templateid', 'host'],
            'filter' => ['host' => [self::SITE_TEMPLATE]]
        ]));
        if (!$tpls) return [];

        return $this->safeGet(fn() => API::Host()->get([
            'output'           => ['hostid', 'host', 'name', 'status', 'maintenance_status'],
            'selectInterfaces' => ['ip', 'main', 'available'],
            'selectHostGroups' => ['groupid', 'name'],
            'templateids'      => array_column($tpls, 'templateid'),
            'monitored_hosts'  => true,
            'preservekeys'     => true
        ]));
    }

    /** Per-camera Zabbix hosts (one per Camera-{HW.ID} host_prototype). */
    private function findCameraHosts(): array {
        $tpls = $this->safeGet(fn() => API::Template()->get([
            'output' => ['templateid', 'host'],
            'filter' => ['host' => [self::CAMERA_TEMPLATE]]
        ]));
        if (!$tpls) return [];

        return $this->safeGet(fn() => API::Host()->get([
            'output'           => ['hostid', 'host', 'name', 'status', 'maintenance_status'],
            'selectInterfaces' => ['ip', 'main', 'available'],
            'selectTags'       => 'extend',
            'templateids'      => array_column($tpls, 'templateid'),
            'monitored_hosts'  => true,
            'preservekeys'     => true
        ]));
    }

    /**
     * Does this decoded value look like the camera-groups snapshot? Used to
     * recognise the groups master item by content rather than key, so a
     * renamed reader can't silently disable the Sites-tab name back-fill.
     *
     * Identify by groups-specific markers (not just "has __array", which the
     * cameras / RS snapshots also have): the groups collector stamps
     * __endpoint with the discovered endpoint name, and every group row
     * carries a parentGroupId field that the camera / RS rows never do.
     */
    private function isGroupsSnapshot($blob): bool {
        if (!is_array($blob) || !is_array($blob['__array'] ?? null)) return false;

        $ep = strtolower((string) ($blob['__endpoint'] ?? ''));
        if (in_array($ep, ['cameragroups', 'devicegroups', 'groups'], true)) return true;

        foreach ($blob['__array'] as $g) {
            return is_array($g) && array_key_exists('parentGroupId', $g);
        }
        return false;
    }

    /**
     * Pull every Milestone item on the given site hosts in one call. Returns
     *   [hostid => [
     *       site:    [logical => lastvalue, ...],
     *       rs:      [rsId => [field => value, ...]],
     *       cam:     [camId => [field => value, ...]],
     *       grp:     [groupId => [field => value, cameraIds: [...], ...]]
     *   ]]
     */
    private function collectSiteItems(array $host_ids): array {
        $items = $this->safeGet(fn() => API::Item()->get([
            'output'  => ['itemid', 'hostid', 'key_', 'lastvalue', 'value_type', 'lastclock'],
            'hostids' => $host_ids,
            'search'  => ['key_' => 'milestone.'],
            'startSearch' => true,
            'monitored' => true,
            'webitems' => false
        ]));

        // The Milestone XProtect by HTTP template's per-group dependent items
        // (milestone.grp.name[<id>] etc.) extract from
        // milestone.grp.raw[<id>] via $["<id>"], which assumes the snapshot
        // file written by milestone_groups_refresh.sh exposes each group as a
        // top-level GUID key. On installs where the script only emits the
        // $.__array list, every per-group dep item stays empty and the Sites
        // tab falls through to the bare GUID even though the canonical name
        // is sitting in the snapshot. Pull the snapshot directly so we can
        // back-fill name / path / cameraCount per group when the dep items
        // are blank.
        // NOT scoped to $host_ids: the groups reader external check is
        // commonly attached to a standalone "scripts" host rather than the
        // Milestone XProtect site host, so restricting to site hosts would
        // miss it and the Sites tab would fall through to bare group GUIDs.
        // A camera GUID can't collide with this key, so a global search is
        // safe and returns just the one reader item.
        $snapshots = $this->safeGet(fn() => API::Item()->get([
            'output'      => ['itemid', 'hostid', 'key_', 'lastvalue'],
            'search'      => ['key_' => 'milestone_groups_read.sh'],
            'startSearch' => true,
            'monitored'   => true,
            'webitems'    => false
        ])) ?: [];

        // Fallback: if the canonical reader item isn't found (operator
        // renamed the external check, or it's keyed differently than the
        // bundled milestone_groups_read.sh[3600]), don't silently lose the
        // back-fill. Scan the 'group'-keyed items (any host) and keep any
        // whose value actually parses as the groups snapshot (object with a
        // groups-shaped __array). The value shape — not the key — is the
        // source of truth here.
        if (!$snapshots) {
            $candidates = $this->safeGet(fn() => API::Item()->get([
                'output'    => ['itemid', 'hostid', 'key_', 'lastvalue'],
                'search'    => ['key_' => 'group'],
                'monitored' => true,
                'webitems'  => false
            ])) ?: [];
            foreach ($candidates as $it) {
                $blob = json_decode((string) ($it['lastvalue'] ?? ''), true);
                if ($this->isGroupsSnapshot($blob)) {
                    $snapshots[] = $it;
                }
            }
        }

        $out = [];
        $key_to_site_logical = array_flip(self::SITE_KEYS);

        foreach ($items as $it) {
            $hid = (string) $it['hostid'];
            $key = (string) $it['key_'];
            $val = $it['lastvalue'] ?? '';
            $out[$hid] ??= ['site' => [], 'rs' => [], 'cam' => [], 'grp' => []];

            // Direct site-level scalars
            if (isset($key_to_site_logical[$key])) {
                $out[$hid]['site'][$key_to_site_logical[$key]] = $val;
                continue;
            }

            // Per-RS items: milestone.rs.<field>[<rsId>]
            if (preg_match('/^milestone\.rs\.([a-z.]+)\[([^\]]+)\]$/i', $key, $m)) {
                $field = $m[1]; $rs_id = trim($m[2], '"\'');
                $out[$hid]['rs'][$rs_id][$field] = $val;
                continue;
            }

            // Per-camera items: milestone.cam.<field>[<camId>] (incl. ess.*)
            if (preg_match('/^milestone\.cam\.([a-z.]+)\[([^\]]+)\]$/i', $key, $m)) {
                $field = $m[1]; $cam_id = trim($m[2], '"\'');
                $out[$hid]['cam'][$cam_id][$field] = $val;
                continue;
            }

            // Per-group items: milestone.grp.<field>[<groupId>]
            // The 'raw' field is a JSON blob with cameraIds[] / hardwareIds[];
            // decode it here so buildSites() can bucket cameras by group
            // without re-parsing per row.
            if (preg_match('/^milestone\.grp\.([a-z.]+)\[([^\]]+)\]$/i', $key, $m)) {
                $field  = $m[1];
                $grp_id = trim($m[2], '"\'');
                $out[$hid]['grp'][$grp_id] ??= [];
                if ($field === 'raw' && $val !== '') {
                    $blob = json_decode($val, true);
                    if (is_array($blob)) {
                        // Don't clobber per-item scalars (e.g.
                        // milestone.grp.name[<id>]) with an empty value
                        // from the blob — the API returns items in no
                        // guaranteed order, so a "name": "" in the JSON
                        // could otherwise shadow a real Bryant HS coming
                        // from the direct item.
                        foreach ($blob as $k => $v) {
                            $existing = $out[$hid]['grp'][$grp_id][$k] ?? null;
                            if ($existing === null || $existing === '' || $existing === []) {
                                $out[$hid]['grp'][$grp_id][$k] = $v;
                            }
                        }
                    }
                } else {
                    // Symmetric: an empty direct-item value won't blank a
                    // field the blob already filled in.
                    $existing = $out[$hid]['grp'][$grp_id][$field] ?? null;
                    if ($val !== '' || $existing === null || $existing === '') {
                        $out[$hid]['grp'][$grp_id][$field] = $val;
                    }
                }
                continue;
            }
        }

        // Back-fill per-group fields from the groups snapshot's $.__array
        // when the dep items came through empty (script only emitted the
        // array form, not the GUID-keyed top-level entries the template's
        // $["<id>"] JSONPath needs). Values already populated by the dep
        // items win — we only fill blanks.
        foreach ($snapshots as $snap) {
            $hid = (string) $snap['hostid'];
            $raw = (string) ($snap['lastvalue'] ?? '');
            if ($raw === '') continue;
            $blob = json_decode($raw, true);
            if (!is_array($blob)) continue;
            $arr = is_array($blob['__array'] ?? null) ? $blob['__array'] : [];
            $out[$hid] ??= ['site' => [], 'rs' => [], 'cam' => [], 'grp' => []];
            foreach ($arr as $g) {
                if (!is_array($g)) continue;
                $gid = (string) ($g['id'] ?? '');
                if ($gid === '') continue;
                $out[$hid]['grp'][$gid] ??= [];
                foreach ($g as $k => $v) {
                    $existing = $out[$hid]['grp'][$gid][$k] ?? null;
                    if ($existing === null || $existing === '' || $existing === []) {
                        $out[$hid]['grp'][$gid][$k] = $v;
                    }
                }
            }
        }
        return $out;
    }

    /* --------------------------------------------------------------------- */

    /**
     * Top-of-page summary tile (MILESTONE global). At single-site installs
     * the fields are pulled off the one site host. Multi-site installs roll
     * up across all hosts (license/storage counts not yet implemented —
     * those need history.get over the licenseOverviewAll item).
     */
    private function buildMilestoneSummary(array $site_hosts, array $site_items, array $cam_hosts, array $problems): array {
        // Pick the first site host as the "primary" (Milestone is typically
        // single-mgmt-server per environment). If multiple, the rest still
        // count toward server / camera totals below.
        $primary_hid = (string) array_key_first($site_hosts);
        $primary     = $site_hosts[$primary_hid] ?? [];
        $primary_si  = $site_items[$primary_hid]['site'] ?? [];

        // Roll up RS counts across all site hosts.
        $rs_total = 0; $rs_online = 0;
        foreach ($site_items as $si) {
            foreach ($si['rs'] ?? [] as $rs) {
                $rs_total++;
                $enabled = strtolower((string) ($rs['enabled'] ?? ''));
                $age     = (int) ($rs['handshake.age'] ?? 0);
                if ($enabled === 'true' && $age > 0 && $age < 300) $rs_online++;
            }
        }

        // Cameras: count enabled and worst-state.
        $cam_total = 0; $cam_used = 0;
        foreach ($site_items as $si) {
            foreach ($si['cam'] ?? [] as $cam) {
                $cam_total++;
                if (strtolower((string) ($cam['enabled'] ?? '')) === 'true') $cam_used++;
            }
        }

        // Active VMS alarms = open problems on site hosts (camera-host
        // problems show in the per-site / per-camera rollups).
        $active_alarms = 0; $ack = 0;
        foreach ($problems as $p) {
            $active_alarms++;
            if ((int) $p['acknowledged'] === 1) $ack++;
        }

        // License JSON parse — fields { totalLicenses, activatedLicenses,
        // licensedHardwareDeviceCount, ... } per Milestone REST shape.
        $license = $this->parseLicense($primary_si['licenseRaw'] ?? '');

        return [
            'product'              => $license['product'] ?? 'XProtect',
            'version'              => $primary_si['siteVersion'] ?? '—',
            'managementServer'     => $primary_si['siteName'] ?? ($primary['name'] ?? '—'),
            'smtpRouted'           => null,
            'licenseDeviceTotal'   => $license['totalDevices']   ?? $cam_total,
            'licenseDeviceUsed'    => $license['activatedDevices'] ?? $cam_used,
            'licenseHwTotal'       => $license['totalHardware']  ?? null,
            'recordingServers'     => $rs_total,
            'recordingServersOnline' => $rs_online,
            'failoverServers'      => null,
            'mobileServers'        => null,
            'smartClientSessions'  => null,
            'webClientSessions'    => null,
            'activeAlarms'         => $active_alarms,
            'alarmsAck'            => $ack,
            'retentionDays'        => null,
            'storageTotalTB'       => null,
            'storageUsedTB'        => null,
            'evidenceLockSlots'    => null,
            'evidenceLockUsed'     => null
        ];
    }

    /** Best-effort license overview parse. Returns [] on garbage / empty. */
    private function parseLicense(string $raw): array {
        if ($raw === '') return [];
        $blob = json_decode($raw, true);
        if (!is_array($blob)) return [];
        // The REST shape is { array: [ { ... } ] }. Take the first row.
        $row = $blob['array'][0] ?? $blob;
        return [
            'product'           => $row['productDisplayName'] ?? null,
            'totalDevices'      => isset($row['totalLicensesForDeviceLicense']) ? (int) $row['totalLicensesForDeviceLicense'] : null,
            'activatedDevices'  => isset($row['activatedLicensesForDeviceLicense']) ? (int) $row['activatedLicensesForDeviceLicense'] : null,
            'totalHardware'     => isset($row['licensedHardwareDeviceCount']) ? (int) $row['licensedHardwareDeviceCount'] : null
        ];
    }

    /* --------------------------------------------------------------------- */

    /**
     * Per-site rollup for the dashboard's SITES tile.
     *
     * Two bucketing modes:
     *   1. By Milestone camera-group (preferred). When any site host's
     *      milestone.grp.raw[*] items are populated, each group becomes
     *      a "site" row and cameras are bucketed via the group's
     *      cameraIds list. This matches how operators think about the
     *      fleet in Smart Client (Bryant HS folder → cameras under it).
     *   2. By Zabbix site host (fallback). One row per Milestone host;
     *      cameras bucketed by which host discovered them. Used when
     *      milestone_groups_refresh.sh hasn't run yet or the install
     *      doesn't use camera groups.
     *
     * Storage capacity isn't templated yet so storageGB / storageCapGB
     * stay null in both modes.
     */
    private function buildSites(array $site_hosts, array $site_items, array $cam_hosts, array $problems): array {
        $problems_by_host = [];
        foreach ($problems as $p) {
            foreach ($p['hosts'] ?? [] as $h) {
                $problems_by_host[$h['hostid']] = ($problems_by_host[$h['hostid']] ?? 0) + 1;
            }
        }

        // Group bucketing takes priority when any host has group data.
        $any_groups = false;
        foreach ($site_items as $bundle) {
            if (!empty($bundle['grp'])) { $any_groups = true; break; }
        }
        if ($any_groups) {
            return $this->buildSitesByGroup($site_hosts, $site_items, $problems_by_host);
        }

        // Fallback: one row per Zabbix site host (the original behaviour).
        $out = [];
        foreach ($site_hosts as $hid => $h) {
            $bundle    = $site_items[$hid] ?? ['site' => [], 'rs' => [], 'cam' => []];
            $site_name = trim((string) ($bundle['site']['siteName'] ?? ''));
            $name      = $site_name !== '' ? $site_name : ($h['name'] ?: $h['host']);

            $cams = 0; $online = 0; $warn = 0; $err = 0;
            foreach ($bundle['cam'] ?? [] as $cam_id => $cam) {
                $cams++;
                $enabled = strtolower((string) ($cam['enabled'] ?? ''));
                if ($enabled !== 'true') continue;
                $status = (int) ($cam['status'] ?? 0);
                $cls = $this->camStatusClass($status);
                if      ($cls === 'ok')   $online++;
                elseif  ($cls === 'warn') { $online++; $warn++; }
                else                       $err++;
            }

            // Primary recording server (first RS) for the server label.
            $primary_rs = null;
            foreach ($bundle['rs'] ?? [] as $rs_id => $rs) {
                $primary_rs = $rs['hostname'] ?? $rs_id;
                break;
            }

            $out[] = [
                'name'         => $name,
                'hostid'       => $hid,
                'cams'         => $cams,
                'online'       => $online,
                'warn'         => $warn,
                'err'          => $err,
                'server'       => $primary_rs ?? '—',
                'storageGB'    => null,
                'storageCapGB' => null,
                'problems'     => $problems_by_host[$hid] ?? 0,
                'source'       => 'host'
            ];
        }

        usort($out, fn($a, $b) => $b['err'] <=> $a['err'] ?: $b['warn'] <=> $a['warn'] ?: strcmp($a['name'], $b['name']));
        return $out;
    }

    /**
     * Sites bucketed by Milestone camera group — the operator-facing
     * organisational axis (the folders Smart Client shows). Each group
     * becomes one row; cameras are attributed to a group via the
     * cameraIds list inside milestone.grp.raw[<groupId>].
     *
     * Cross-host group merge: if two Milestone Zabbix hosts both report
     * the same group GUID (unusual — would mean two separate XProtect
     * sites pointing at the same group) the rows are summed.
     */
    private function buildSitesByGroup(array $site_hosts, array $site_items, array $problems_by_host): array {
        // Camera-status lookup keyed by camera GUID (folds enabled / status
        // across every host so a group with cameras spread over multiple
        // hosts still gets the right rollup).
        $cam_state = [];   // cam_id => ['enabled' => bool, 'status' => int, 'rsid' => string]
        foreach ($site_items as $bundle) {
            foreach ($bundle['cam'] ?? [] as $cam_id => $cam) {
                $enabled = strtolower((string) ($cam['enabled'] ?? '')) === 'true';
                $status  = isset($cam['status']) ? (int) $cam['status'] : -2; // -2 = no data
                $cam_state[$cam_id] = [
                    'enabled' => $enabled,
                    'status'  => $status,
                    'rsid'    => (string) ($cam['rsid'] ?? '')
                ];
            }
        }

        // RS GUID → display hostname. Populated from each Milestone host's
        // recording-server LLD so we can label a group with the human
        // hostname instead of the bare GUID.
        $rs_hostname_by_id = [];
        foreach ($site_items as $bundle) {
            foreach ($bundle['rs'] ?? [] as $rs_id => $rs) {
                $hostname = $rs['hostname'] ?? '';
                if ($hostname !== '') {
                    $rs_hostname_by_id[(string) $rs_id] = (string) $hostname;
                }
            }
        }

        // Per-group RS attribution: walk each group's cameraIds and tally
        // which recording server hosts most of them. If a group's cameras
        // are all on one RS → show that RS hostname. Mixed groups (rare,
        // but possible if a logical site has redundant recorders) → show
        // "(multiple)". Groups with no cameraIds yet (LLD fresh or role
        // permissions still blocking) → '—'.
        $sites = [];
        $counted = [];   // group GUIDs already tallied (avoid cross-host double-count)
        foreach ($site_items as $hid => $bundle) {
            foreach ($bundle['grp'] ?? [] as $grp_id => $grp) {
                $key = (string) $grp_id;

                // Resolve this occurrence's label. milestone.grp.name[<id>]
                // is the canonical Zabbix item; the path tail from the raw
                // blob ("/Root/Bryant HS" → "Bryant HS") is the fallback;
                // the bare GUID is the last resort. Resolved per-occurrence
                // so a named back-fill row can upgrade a GUID placeholder
                // that an empty dependent-item row created first.
                $name = trim((string) ($grp['name'] ?? ''));
                if ($name === '') {
                    $p = trim((string) ($grp['path'] ?? ''));
                    if ($p !== '' && str_contains($p, '/')) {
                        $tail = trim((string) strrchr($p, '/'), '/');
                        if ($tail !== '') $name = $tail;
                    } elseif ($p !== '') {
                        $name = $p;
                    }
                }

                if (!isset($sites[$key])) {
                    $sites[$key] = [
                        'name'         => $name !== '' ? $name : (string) $grp_id,
                        'groupId'      => (string) $grp_id,
                        'hostid'       => $hid,
                        'cams'         => 0,
                        'online'       => 0,
                        'warn'         => 0,
                        'err'          => 0,
                        'server'       => '—',
                        'storageGB'    => null,
                        'storageCapGB' => null,
                        // Camera GUIDs in this group — populated below from
                        // the snapshot's cameraIds list. Surfaces the group
                        // membership the Cameras tab navigator needs to
                        // group cameras by their site/group.
                        'cameraIds'    => [],
                        'problems'     => $problems_by_host[$hid] ?? 0,
                        'source'       => 'group'
                    ];
                } elseif ($name !== '' && $sites[$key]['name'] === (string) $grp_id) {
                    // A real name arrived after the GUID placeholder — upgrade.
                    $sites[$key]['name'] = $name;
                }

                // Walk the cameraIds list from the group's raw JSON. If
                // the LLD has fired but the raw item hasn't populated
                // yet (or the role can't read /cameraGroups/{id}/cameras),
                // cameraCount is the only thing we'll have — use it as a
                // best-effort total. If neither is present, the row
                // honestly shows 0 cameras instead of guessing.
                $cam_ids = is_array($grp['cameraIds'] ?? null) ? $grp['cameraIds'] : [];
                $cam_n   = (int) ($grp['cam.count'] ?? $grp['cameraCount'] ?? 0);
                // Tally each group once. With the global snapshot search a
                // group can appear under both its site host (dependent items)
                // and the snapshot's host (back-fill); skip if already done.
                if (isset($counted[$key])) continue;
                if ($cam_ids || $cam_n > 0) $counted[$key] = true;
                $rs_tally = [];  // rs_id => count
                if ($cam_ids) {
                    // Stash the GUID list so the Cameras tab navigator can
                    // group cameras by their site/group without re-walking.
                    $sites[$key]['cameraIds'] = array_values($cam_ids);
                    foreach ($cam_ids as $cid) {
                        $sites[$key]['cams']++;
                        $st = $cam_state[(string) $cid] ?? null;
                        if ($st) {
                            $rsid = $st['rsid'];
                            if ($rsid !== '') {
                                $rs_tally[$rsid] = ($rs_tally[$rsid] ?? 0) + 1;
                            }
                        }
                        if (!$st) { $sites[$key]['online']++; continue; }
                        if (!$st['enabled']) continue;
                        $cls = $this->camStatusClass($st['status']);
                        if      ($cls === 'ok')   $sites[$key]['online']++;
                        elseif  ($cls === 'warn') { $sites[$key]['online']++; $sites[$key]['warn']++; }
                        else                       $sites[$key]['err']++;
                    }
                } else {
                    // No cameraIds list to walk — fall back to the direct
                    // milestone.grp.cam.count[<id>] / hw.count[<id>] items
                    // (or the raw-blob camelCase equivalents if only the
                    // blob is templated). Without per-camera state we
                    // can't break the count into ok/warn/err, so the row
                    // optimistically reports the whole count as online;
                    // the camera-host bridge will correct it once LLD
                    // discovers individual cameras.
                    if ($cam_n > 0) {
                        $sites[$key]['cams']   = $cam_n;
                        $sites[$key]['online'] = $cam_n;
                    }
                }
                // hw.count is informational (Milestone hardware devices,
                // some of which may carry multiple cameras). Surface it
                // so the bridge / UI can display it later — kept
                // alongside cams without overwriting the per-camera roll.
                if (isset($grp['hw.count']) || isset($grp['hardwareCount'])) {
                    $sites[$key]['hwCount'] = (int) ($grp['hw.count'] ?? $grp['hardwareCount']);
                }

                // Attribute the group to an RS.
                if ($rs_tally) {
                    if (count($rs_tally) === 1) {
                        $rs_id = array_key_first($rs_tally);
                        $sites[$key]['server'] = $rs_hostname_by_id[$rs_id] ?? $rs_id;
                    } else {
                        // Mixed group — name the dominant RS plus a "+N"
                        // hint so operators know it's a multi-RS group.
                        arsort($rs_tally);
                        $rs_id = array_key_first($rs_tally);
                        $extra = count($rs_tally) - 1;
                        $sites[$key]['server'] = ($rs_hostname_by_id[$rs_id] ?? $rs_id)
                            . " +{$extra}";
                    }

                    // Roll storage up from the RSs that host this group's
                    // cameras. Each unique RS contributes its full storage
                    // once — over-counting can happen when one RS serves
                    // multiple groups, but per-row that's still the right
                    // number to show ("the storage backing this site").
                    // Source items come from the 'Milestone XProtect RS
                    // extras by HTTP' template; absent → leave null.
                    $cap_b = 0; $used_b = 0; $retention = null; $have_rs_data = false;
                    foreach (array_keys($rs_tally) as $rs_id_inner) {
                        foreach ($site_items as $b) {
                            $rs_row = $b['rs'][$rs_id_inner] ?? null;
                            if (!$rs_row) continue;
                            $have_rs_data = $have_rs_data
                                || isset($rs_row['storage.total.bytes'])
                                || isset($rs_row['storage.used.bytes']);
                            $cap_b  += (int) ($rs_row['storage.total.bytes'] ?? 0);
                            $used_b += (int) ($rs_row['storage.used.bytes']  ?? 0);
                            $r = (int) ($rs_row['storage.retention.minutes'] ?? 0);
                            if ($r > 0 && ($retention === null || $r < $retention)) {
                                $retention = $r;
                            }
                            break;
                        }
                    }
                    if ($have_rs_data) {
                        $sites[$key]['storageGB']    = (int) ($used_b / 1e9);
                        $sites[$key]['storageCapGB'] = (int) ($cap_b  / 1e9);
                        if ($retention !== null) {
                            $sites[$key]['retentionMin'] = $retention;
                        }
                    }
                }
            }
        }

        $out = array_values($sites);
        usort($out, fn($a, $b) => $b['err'] <=> $a['err'] ?: $b['warn'] <=> $a['warn'] ?: strcmp($a['name'], $b['name']));
        return $out;
    }

    /* --------------------------------------------------------------------- */

    /**
     * Recording-server tiles — one row per discovered RS across all sites.
     * Where the Milestone-reported RS hostname matches a Zabbix host
     * running zabbix-agent2 (via findDvrAgentHosts), merge in live OS
     * metrics so CPU / mem / disk / uptime / IP / agent version light up.
     *
     * @param array $dvr_agents { hosts: hostid=>host, by_name: lowerhost=>hostid, metrics: hostid=>[logical=>value] }
     */
    private function buildServers(array $site_hosts, array $site_items, array $dvr_agents): array {
        $by_name  = $dvr_agents['by_name'] ?? [];
        $hosts    = $dvr_agents['hosts']   ?? [];
        $metrics  = $dvr_agents['metrics'] ?? [];

        $out = [];
        foreach ($site_hosts as $hid => $h) {
            $bundle     = $site_items[$hid] ?? [];
            $sn         = trim((string) ($bundle['site']['siteName'] ?? ''));
            $site_label = $sn !== '' ? $sn : ($h['name'] ?: $h['host']);
            foreach ($bundle['rs'] ?? [] as $rs_id => $rs) {
                $enabled = strtolower((string) ($rs['enabled'] ?? ''));
                $age     = (int) ($rs['handshake.age'] ?? 0);
                $stale   = $age > 300;

                // Match Milestone RS hostname → Zabbix agent host. Try the
                // full string first, then the leftmost label so an FQDN
                // like "tcs-rec-bhs-01.tcs.local" still joins a Zabbix
                // host named just "tcs-rec-bhs-01".
                $rs_hostname = (string) ($rs['hostname'] ?? '');
                $agent_hid   = $this->matchAgentHost($rs_hostname, $by_name);
                $agent_host  = $agent_hid !== null ? ($hosts[$agent_hid] ?? null) : null;
                $vals        = $agent_hid !== null ? ($metrics[$agent_hid] ?? []) : [];

                // Milestone-reported service state (from the RS extras
                // template's milestone.rs.state[<id>]). Empty when the
                // extras template isn't linked yet.
                $svc_state_raw = strtolower(trim((string) ($rs['state'] ?? '')));
                $svc_is_bad = ($svc_state_raw !== '' && !in_array(
                    $svc_state_raw,
                    ['server', 'running', 'started', 'ok'],
                    true
                ));

                // State precedence (worst wins):
                //   1. Milestone says RS disabled                     → err
                //   2. Milestone service state not running            → err
                //   3. iDRAC global status critical / nonRecoverable  → err
                //   4. Milestone handshake stale (>5m)                → warn
                //   5. iDRAC global status nonCritical                → warn
                //   6. Agent main interface unreachable               → warn
                //   default                                           → ok
                $hwStatus = $vals['hwStatus'] ?? null;
                $unreachable = $agent_host && (int) ($agent_host['_unreachable'] ?? 0) === 1;
                $state = 'ok';
                if      ($enabled !== 'true')   $state = 'err';
                elseif  ($svc_is_bad)           $state = 'err';
                elseif  ($hwStatus === 'err')   $state = 'err';
                elseif  ($stale)                $state = 'warn';
                elseif  ($hwStatus === 'warn')  $state = 'warn';
                elseif  ($unreachable)          $state = 'warn';

                // RAID indicator on the tile: surface the iDRAC overall
                // hardware status (folds physical / virtual disks,
                // controllers, PSUs, CPUs, memory). 'ok' until we have
                // a reading.
                $raid = $hwStatus ?? 'ok';

                $out[] = [
                    'id'           => $rs_hostname ?: $rs_id,
                    'rsid'         => $rs_id,
                    'site'         => $site_label,
                    'role'         => 'Recording Server',
                    'os'           => $vals['os']       ?? null,
                    'model'        => $vals['model']    ?? null,
                    'serial'       => $vals['serial']   ?? null,
                    'firmware'     => $vals['firmware'] ?? null,
                    'cpu'          => $vals['cpu']      ?? null,
                    'mem'          => $vals['mem']      ?? null,
                    'disk'         => $vals['disk']     ?? null,
                    'raid'         => $raid,
                    'hwStatus'     => $hwStatus,
                    'svcState'     => $svc_state_raw !== '' ? $svc_state_raw : null,
                    'chans'        => isset($rs['cameracount'])
                        ? (int) $rs['cameracount']
                        : null,
                    'hwDevices'    => isset($rs['hardwarecount'])
                        ? (int) $rs['hardwarecount']
                        : null,
                    'storageTotalGB' => isset($rs['storage.total.bytes'])
                        ? (int) (((int) $rs['storage.total.bytes']) / 1e9)
                        : null,
                    'storageUsedGB'  => isset($rs['storage.used.bytes'])
                        ? (int) (((int) $rs['storage.used.bytes']) / 1e9)
                        : null,
                    'retentionMin'   => isset($rs['storage.retention.minutes'])
                        ? (int) $rs['storage.retention.minutes']
                        : null,
                    'recording'    => null,
                    'archiveLagH'  => null,
                    'agent'        => $vals['agentVer'] ?? null,
                    'ip'           => $vals['ip']       ?? null,
                    'uptimeD'      => $vals['uptimeD']  ?? null,
                    'lastBackup'   => null,
                    'state'        => $state,
                    'handshakeAge' => $age,
                    'agentHostid'  => $agent_hid
                ];
            }
        }
        return $out;
    }

    /**
     * Try to find a Zabbix-agent host that matches a Milestone-reported
     * RS hostname. Comparison is case-insensitive on both the technical
     * host name and visible name; FQDNs and bare labels both work
     * (tcs-rec-bhs-01 ≡ TCS-REC-BHS-01.tcs.local).
     */
    private function matchAgentHost(string $hostname, array $by_name): ?string {
        if ($hostname === '') return null;
        $candidates = [strtolower($hostname)];
        if (strpos($hostname, '.') !== false) {
            $candidates[] = strtolower(strstr($hostname, '.', true));
        }
        foreach ($candidates as $k) {
            if (isset($by_name[$k])) return (string) $by_name[$k];
        }
        return null;
    }

    /**
     * Find Zabbix hosts that look like Milestone DVR / recording-server
     * boxes by matching the technical host (or visible name) against the
     * Milestone-reported RS hostnames returned via the LLD. One host.get,
     * one item.get — both keyed to the candidate hostids only so this
     * stays cheap regardless of fleet size.
     *
     * @return array{ hosts: array<string, array>, by_name: array<string, string>, metrics: array<string, array<string, mixed>> }
     */
    private function findDvrAgentHosts(array $site_items): array {
        $rs_hostnames = [];
        foreach ($site_items as $bundle) {
            foreach ($bundle['rs'] ?? [] as $rs) {
                $h = (string) ($rs['hostname'] ?? '');
                if ($h === '') continue;
                $rs_hostnames[strtolower($h)] = true;
                if (strpos($h, '.') !== false) {
                    $rs_hostnames[strtolower(strstr($h, '.', true))] = true;
                }
            }
        }
        if (!$rs_hostnames) {
            return ['hosts' => [], 'by_name' => [], 'metrics' => []];
        }

        // Pull a superset and filter in PHP — host.get's filter[host] is
        // case-sensitive and exact, which won't catch FQDN mismatches.
        $needles = array_keys($rs_hostnames);
        $candidates = [];
        foreach ($needles as $needle) {
            $rows = $this->safeGet(fn() => API::Host()->get([
                'output'           => ['hostid', 'host', 'name'],
                'selectInterfaces' => ['ip', 'main', 'available'],
                'search'           => ['host' => $needle, 'name' => $needle],
                'searchByAny'      => true,
                'monitored_hosts'  => true
            ]));
            foreach ($rows as $r) $candidates[$r['hostid']] = $r;
        }
        if (!$candidates) {
            return ['hosts' => [], 'by_name' => [], 'metrics' => []];
        }

        // Build the by_name index — keyed by the same normalisation we'll
        // do at match time (lowercased; FQDN's left-label also indexed so
        // both forms find the host).
        $by_name = [];
        foreach ($candidates as $hid => $r) {
            foreach ([$r['host'] ?? '', $r['name'] ?? ''] as $label) {
                if ($label === '') continue;
                $k = strtolower($label);
                if (isset($rs_hostnames[$k])) $by_name[$k] = $hid;
                if (strpos($label, '.') !== false) {
                    $kb = strtolower(strstr($label, '.', true));
                    if (isset($rs_hostnames[$kb])) $by_name[$kb] = $hid;
                }
            }
        }
        if (!$by_name) {
            return ['hosts' => [], 'by_name' => [], 'metrics' => []];
        }
        $matched_hids = array_values(array_unique($by_name));

        // One item.get over the matched hosts for the standard agent keys
        // PLUS the Dell iDRAC by SNMP template's identity/health items —
        // every DVR carries both templates, and the iDRAC stack gives us
        // the authoritative hardware state for the RS tiles. First-key-
        // wins inside each logical group lets the same key map work on
        // Windows + Linux + iDRAC fall-backs.
        $key_map = [
            'cpu'         => ['system.cpu.util', 'system.cpu.util[,,avg1]'],
            'mem'         => ['vm.memory.utilization', 'vm.memory.size[pused]'],
            'disk'        => ['vfs.fs.size[C:,pused]', 'vfs.fs.size[/,pused]', 'vfs.fs.pused[/]'],
            // iDRAC hrSystemUptime is more reliable than the OS-agent
            // uptime — counts hardware-boot time, not just service restart.
            'uptime'      => ['system.hw.uptime[hrSystemUptime.0]', 'system.uptime'],
            'os'          => ['system.sw.os[systemOSName]', 'system.sw.os', 'system.sw.os[full]'],
            'agentVer'    => ['agent.version'],
            'model'       => ['system.hw.model'],
            'serial'      => ['system.hw.serialnumber'],
            'firmware'    => ['system.hw.firmware'],
            // Overall hardware health from iDRAC. Enum: 1 other, 2 unknown,
            // 3 ok, 4 nonCritical, 5 critical, 6 nonRecoverable.
            'idracStatus' => ['system.status[globalSystemStatus.0]'],
            'snmpAvail'   => ['zabbix[host,snmp,available]']
        ];
        $all_keys = [];
        foreach ($key_map as $keys) foreach ($keys as $k) $all_keys[] = $k;

        $items = $this->safeGet(fn() => API::Item()->get([
            'output'   => ['itemid', 'hostid', 'key_', 'lastvalue'],
            'hostids'  => $matched_hids,
            'filter'   => ['key_' => $all_keys],
            'webitems' => false
        ]));
        $by_host_key = [];
        foreach ($items as $it) {
            $by_host_key[$it['hostid']][$it['key_']] = $it['lastvalue'];
        }

        // Reduce to per-host logical fields. First matching key wins.
        $metrics = [];
        foreach ($matched_hids as $hid) {
            $row = $by_host_key[$hid] ?? [];
            $logical = [];
            foreach ($key_map as $logical_name => $keys) {
                foreach ($keys as $k) {
                    if (isset($row[$k]) && $row[$k] !== '') {
                        $logical[$logical_name] = $row[$k];
                        break;
                    }
                }
            }
            // Normalise.
            if (isset($logical['cpu']))    $logical['cpu']    = round((float) $logical['cpu'], 1);
            if (isset($logical['mem']))    $logical['mem']    = round((float) $logical['mem'], 1);
            if (isset($logical['disk']))   $logical['disk']   = round((float) $logical['disk'], 1);
            if (isset($logical['uptime'])) {
                $u = (float) $logical['uptime'];
                // hrSystemUptime is in hundredths of a second; agent's
                // system.uptime is in seconds. Detect the iDRAC scale by
                // whether the source key matched the SNMP item.
                $usedKey = $row['system.hw.uptime[hrSystemUptime.0]'] ?? null;
                if ($usedKey !== null && $usedKey === $logical['uptime']) {
                    $u = $u / 100;
                }
                $logical['uptimeD'] = (int) floor($u / 86400);
            }
            // Map iDRAC status enum → simple state token.
            if (isset($logical['idracStatus'])) {
                $code = (int) $logical['idracStatus'];
                $logical['hwStatus'] = match ($code) {
                    3       => 'ok',
                    4       => 'warn',
                    5, 6    => 'err',
                    default => 'unknown'
                };
            }

            // Primary interface IP.
            $host = $candidates[$hid] ?? null;
            if ($host) {
                foreach ($host['interfaces'] ?? [] as $i) {
                    if ((int) ($i['main'] ?? 0) === 1) { $logical['ip'] = $i['ip']; break; }
                }
                $candidates[$hid]['_unreachable'] = 0;
                foreach ($host['interfaces'] ?? [] as $i) {
                    if ((int) ($i['main'] ?? 0) === 1 && (int) ($i['available'] ?? 0) === 2) {
                        $candidates[$hid]['_unreachable'] = 1;
                    }
                }
            }
            $metrics[$hid] = $logical;
        }

        return [
            'hosts'   => $candidates,
            'by_name' => $by_name,
            'metrics' => $metrics
        ];
    }

    /* --------------------------------------------------------------------- */

    /**
     * Normalise a Milestone camera GUID for cross-source joins. Different
     * Milestone REST endpoints can return GUIDs braced vs. bare and with
     * different casing, which silently breaks per-camera lookups; fold both
     * sides through here before storing/looking up in any cam_id-keyed map.
     */
    private function normCamKey(string $id): string {
        return strtolower(trim($id, "{} \t\n\r"));
    }

    /**
     * Camera GUID → group name, read from the cameras snapshot's per-camera
     * groupName field (stamped by milestone_cameras_state.py's
     * /cameraGroups walk). Independent of the groups snapshot, so this is
     * what carries the navigator's bucketing when the groups reader is
     * stripped / stale and the per-group cameraIds path delivers nothing.
     *
     * Empty when the cameras snapshot is unreachable, predates the
     * groupName addition, or has no groupName values populated.
     */
    private function findCameraGroupNamesFromSnapshot(): array {
        $snaps = $this->safeGet(fn() => API::Item()->get([
            'output'      => ['itemid', 'hostid', 'lastvalue'],
            'search'      => ['key_' => 'milestone_cameras_read.sh'],
            'startSearch' => true,
            'monitored'   => true,
            'webitems'    => false
        ])) ?: [];

        $map = [];
        foreach ($snaps as $snap) {
            $raw = (string) ($snap['lastvalue'] ?? '');
            if ($raw === '') continue;
            $blob = json_decode($raw, true);
            if (!is_array($blob)) continue;

            // The cameras snapshot keeps both __array (for LLD) and per-GUID
            // top-level entries (for the milestone.cam.raw[<id>] JSONPath).
            // Either is fine — __array is the canonical iteration.
            $rows = is_array($blob['__array'] ?? null) ? $blob['__array'] : [];
            if (!$rows) {
                // Fall back to top-level GUID-keyed entries.
                foreach ($blob as $k => $v) {
                    if (is_string($k) && !str_starts_with($k, '__') && is_array($v)) {
                        $rows[] = $v;
                    }
                }
            }
            foreach ($rows as $cam) {
                if (!is_array($cam)) continue;
                $cid   = (string) ($cam['id'] ?? '');
                $gname = trim((string) ($cam['groupName'] ?? ''));
                if ($cid !== '' && $gname !== '' && !isset($map[$cid])) {
                    $map[$cid] = $gname;
                }
            }
        }
        return $map;
    }

    /**
     * Camera list — one row per LLD-discovered camera. State derives from
     * milestone.cam.status[id] (0 OK / 1 ESS fault / 2 ping down / 3 both /
     * -1 disabled).
     */
    private function buildCameras(array $site_hosts, array $site_items, array $cam_hosts): array {
        // RS GUID → display hostname, from the per-RS milestone.rs.* items.
        // Used to turn each camera's milestone.cam.rsid[<id>] into a clickable
        // recording-server label (matches the id buildServers() assigns to the
        // per-server page: $rs_hostname ?: $rs_id).
        $rs_hostname_by_id = [];
        foreach ($site_items as $bundle) {
            foreach ($bundle['rs'] ?? [] as $rs_id => $rs) {
                $hostname = trim((string) ($rs['hostname'] ?? ''));
                if ($hostname !== '') $rs_hostname_by_id[(string) $rs_id] = $hostname;
            }
        }

        // Per-Camera Zabbix host lookup by cam_id tag.
        $cam_host_by_id = [];
        foreach ($cam_hosts as $ch) {
            foreach ($ch['tags'] ?? [] as $t) {
                if (($t['tag'] ?? '') === 'cam_id' && ($t['value'] ?? '') !== '') {
                    $cam_host_by_id[$t['value']] = $ch;
                    break;
                }
            }
        }

        // Camera GUID → group (site) name. Mirrors how buildSitesByGroup
        // attributes cameras: walk each group's cameraIds and resolve the
        // group's label the same way. Emitted on each camera as $row['group']
        // so the Cameras-tab navigator can bucket by site/group without
        // re-joining on the frontend.
        $cam_group_by_id = [];
        foreach ($site_items as $bundle) {
            foreach ($bundle['grp'] ?? [] as $grp_id => $grp) {
                $cam_ids = is_array($grp['cameraIds'] ?? null) ? $grp['cameraIds'] : [];
                if (!$cam_ids) continue;
                $gname = trim((string) ($grp['name'] ?? ''));
                if ($gname === '') {
                    $p = trim((string) ($grp['path'] ?? ''));
                    if ($p !== '' && str_contains($p, '/')) {
                        $tail = trim((string) strrchr($p, '/'), '/');
                        if ($tail !== '') $gname = $tail;
                    } elseif ($p !== '') {
                        $gname = $p;
                    }
                }
                if ($gname === '') $gname = (string) $grp_id;
                foreach ($cam_ids as $cid) {
                    // Normalise the key so case/brace differences between
                    // Milestone REST endpoints (LLD-discovered cam_id vs
                    // the cameraIds array in the groups snapshot) can't
                    // silently break the per-camera join.
                    $nk = $this->normCamKey((string) $cid);
                    // First group claiming a camera wins; Milestone groups
                    // are effectively exclusive at the leaf level.
                    if (!isset($cam_group_by_id[$nk])) {
                        $cam_group_by_id[$nk] = $gname;
                    }
                }
            }
        }

        // Secondary path: per-camera groupName stamped by milestone_cameras_
        // state.py via its own /cameraGroups walk. The cameras snapshot is
        // independent of the groups reader, so this is what makes the
        // navigator bucket correctly when the groups reader is stripped /
        // stale (the primary path above quietly yields nothing in that case).
        $cam_groups_from_snap = $this->findCameraGroupNamesFromSnapshot();
        foreach ($cam_groups_from_snap as $cid => $gname) {
            $nk = $this->normCamKey((string) $cid);
            if (!isset($cam_group_by_id[$nk])) {
                $cam_group_by_id[$nk] = $gname;
            }
        }

        // ── Diagnostic accumulators (surfaced on the response as
        // __camGroupDiag) — temporary, to triage why the Cameras navigator
        // still buckets everything under "CO-MILESTONE".
        $diag = [
            'directGroupHits'    => 0,    // cameras with milestone.cam.group[<id>] populated
            'snapFallbackHits'   => 0,    // cameras attributed via snapshot map
            'siteFallbackHits'   => 0,    // cameras that fell through to site_label
            'camGroupItemsSeen'  => 0,    // any-host count of non-empty $cam['group']
            'snapMapSize'        => count($cam_group_by_id),
            'camFieldsSeen'      => [],   // union of all $cam[*] keys across hosts
            'sampleCam'          => null, // first cam encountered, with its parsed fields
        ];
        $fieldSet = [];
        foreach ($site_items as $bundle) {
            foreach ($bundle['cam'] ?? [] as $cid => $c) {
                foreach (array_keys($c) as $k) $fieldSet[$k] = true;
                if (trim((string) ($c['group'] ?? '')) !== '') $diag['camGroupItemsSeen']++;
                if ($diag['sampleCam'] === null) {
                    $diag['sampleCam'] = [
                        'cid'    => (string) $cid,
                        'fields' => array_keys($c),
                        'group'  => $c['group'] ?? null,
                        'hwname' => $c['hwname'] ?? null,
                    ];
                }
            }
        }
        $diag['camFieldsSeen'] = array_keys($fieldSet);

        $out = [];
        foreach ($site_hosts as $hid => $h) {
            $bundle     = $site_items[$hid] ?? [];
            $sn         = trim((string) ($bundle['site']['siteName'] ?? ''));
            $site_label = $sn !== '' ? $sn : ($h['name'] ?: $h['host']);
            foreach ($bundle['cam'] ?? [] as $cam_id => $cam) {
                $status = isset($cam['status']) ? (int) $cam['status'] : null;
                $state = match (true) {
                    $status === null    => 'unknown',
                    $status === -1      => 'disabled',
                    default             => $this->camStatusClass($status)
                };
                $cam_host = $cam_host_by_id[$cam_id] ?? null;
                $rsid     = trim((string) ($cam['rsid'] ?? ''));
                $server   = $rsid !== '' ? ($rs_hostname_by_id[$rsid] ?? $rsid) : null;

                // RS hostname → operator-readable site key. On installs where
                // each school has its own dedicated recording server (e.g.
                // bhs-bcddvr-ms.tcs.tusc.k12.al.us) the leftmost FQDN label
                // already encodes the site identity; trim the trailing domain
                // so the navigator shows "bhs-bcddvr-ms" rather than the full
                // FQDN. Used only when the upstream group readers don't yield
                // anything for this camera.
                $server_group = null;
                if ($server !== null && $server !== '') {
                    $server_group = (string) (strstr($server, '.', true) ?: $server);
                }

                // Group attribution preference, worst to best resolution:
                //   1. milestone.cam.group[<id>]  — per-camera dependent item
                //      (tiny string, survives history-TEXT truncation).
                //   2. snapshot-derived map (groupName from the cameras
                //      snapshot OR cameraIds from the groups snapshot).
                //   3. recording-server hostname  — operator-meaningful when
                //      RS-per-site is the deployment shape (every camera
                //      already carries the RS via milestone.cam.rsid).
                //   4. site host label as a last-resort header.
                $direct_group = trim((string) ($cam['group'] ?? ''));
                $snap_group   = $cam_group_by_id[$this->normCamKey($cam_id)] ?? null;
                if ($direct_group !== '') {
                    $diag['directGroupHits']++;
                } elseif ($snap_group !== null) {
                    $diag['snapFallbackHits']++;
                } elseif ($server_group !== null) {
                    $diag['serverFallbackHits'] = ($diag['serverFallbackHits'] ?? 0) + 1;
                } else {
                    $diag['siteFallbackHits']++;
                }
                $ip = $cam['address'] ?? '';
                if (!$ip && $cam_host) {
                    foreach ($cam_host['interfaces'] ?? [] as $i) {
                        if ((int) ($i['main'] ?? 0) === 1) { $ip = $i['ip']; break; }
                    }
                }
                $out[] = [
                    'id'        => $cam_id,
                    'name'      => $cam_host['name'] ?? ($cam['hwname'] ?? $cam_id),
                    'site'      => $site_label,
                    'group'     => $direct_group !== ''
                                    ? $direct_group
                                    : ($snap_group ?? ($server_group ?? $site_label)),
                    'loc'       => $cam['hwname'] ?? '',
                    'model'     => $cam['hwmodel'] ?? '—',
                    'res'       => null,
                    'fps'       => null,
                    'bitrate'   => null,
                    'codec'     => null,
                    'recording' => null,
                    'state'     => $state,
                    'ip'        => $ip ?: null,
                    'mac'       => $cam['mac'] ?? null,
                    'poe'       => null,
                    'server'    => $server,
                    'motion12h' => null,
                    'hostid'    => $cam_host['hostid'] ?? null
                ];
            }
        }
        $diag['totalCamsOut'] = count($out);
        $this->camGroupDiag = $diag;
        return $out;
    }

    /* --------------------------------------------------------------------- */

    /* --------------------------------------------------------------------- */

    /**
     * 24h sparkline arrays for the Overview "Live Ingress" tile. Returns
     * keys the bridge will overlay onto window.FLEET_HISTORY — any key
     * left null keeps the mock series so the chart still renders.
     *
     * Backed by what the templates actually expose today:
     *   - alarmsPerHour: real 30-min bucket counts from event.get on the
     *     Milestone fleet hosts (TRIGGER_VALUE_TRUE events / bucket).
     *   - camerasOnline: flat baseline at the current online count so
     *     the line isn't dead at zero. Real per-camera trend would cost
     *     2500 history.get calls; defer until we have a templated
     *     aggregate item.
     *   - Everything else (ingress Gbps, storage write MB/s, RS CPU,
     *     archive lag): null — needs OS-level items on the recording-
     *     server Windows hosts that aren't part of the Milestone HTTP
     *     template.
     *
     * @param array $host_ids   site + per-camera Zabbix hostids
     * @param array $cameras    rows from buildCameras() — used to count
     *                          current online for the camerasOnline line
     */
    private function buildFleetHistory(array $host_ids, array $cameras): array {
        $bucket_count = 48;            // 30-min buckets across 24h
        $window_secs  = 24 * 3600;
        $bucket_secs  = (int) ($window_secs / $bucket_count);

        $alarms_per_hour = array_fill(0, $bucket_count, 0);
        if ($host_ids) {
            $events = $this->safeGet(fn() => API::Event()->get([
                'output'    => ['eventid', 'clock', 'value'],
                'source'    => EVENT_SOURCE_TRIGGERS,
                'object'    => EVENT_OBJECT_TRIGGER,
                'hostids'   => $host_ids,
                'time_from' => time() - $window_secs,
                'sortfield' => ['eventid'],
                'sortorder' => 'ASC',
                'limit'     => 10000
            ]));
            $start = time() - $window_secs;
            foreach ($events as $e) {
                if ((int) $e['value'] !== TRIGGER_VALUE_TRUE) continue;
                $b = (int) (((int) $e['clock'] - $start) / $bucket_secs);
                if ($b >= 0 && $b < $bucket_count) $alarms_per_hour[$b]++;
            }
        }

        // Current online count — anything not in err state.
        $online_now = 0;
        foreach ($cameras as $c) {
            $s = $c['state'] ?? '';
            if ($s === 'ok' || $s === 'warn') $online_now++;
        }
        $cameras_online = $online_now > 0
            ? array_fill(0, $bucket_count, $online_now)
            : null;  // empty fleet → keep mock so the chart isn't a flat zero

        return [
            'totalIngressGbps'    => null,
            'storageWriteMBps'    => null,
            'recordingServersCpu' => null,
            'camerasOnline'       => $cameras_online,
            'alarmsPerHour'       => $alarms_per_hour,
            'archiveLagMin'       => null
        ];
    }

    /* --------------------------------------------------------------------- */

    /**
     * Map the bit-summed milestone.cam.status code to a UI status class.
     *
     * The calc on the Site template folds three independent signals into
     * one integer (-1 disabled, 0 OK, +1 ESS comm fault, +2 ICMP down,
     * +4 SNMP down). Translate to:
     *   ok   = 0                        every signal healthy
     *   warn = 1, 4, 5                  device is pingable; service-level fault
     *   err  = 2, 3, 6, 7               ICMP down (device unreachable)
     *
     * Values outside that range (e.g. no data yet, or pre-SNMP cameras
     * that returned the old 0-3 codes) fall through to 'ok' so we don't
     * paint historical OK cameras red after the template upgrade.
     */
    private function camStatusClass(int $code): string {
        if ($code === 0)                return 'ok';
        if ($code & 2)                  return 'err';   // ICMP bit set → unreachable
        if ($code === 1 || $code === 4 || $code === 5) return 'warn';
        return 'ok';
    }

    /** Open problems across the Milestone fleet → VMS_ALARMS rows. */
    private function collectProblems(array $host_ids): array {
        if (!$host_ids) return [];
        $problems = $this->safeGet(fn() => API::Problem()->get([
            'output'    => ['eventid', 'objectid', 'name', 'severity', 'clock', 'acknowledged', 'r_eventid'],
            'recent'    => false,
            'suppressed'=> false,
            'hostids'   => $host_ids,
            'sortfield' => ['eventid'],
            'sortorder' => 'DESC',
            'limit'     => 100
        ]));
        $problems = array_values(array_filter(
            $problems,
            fn($p) => empty($p['r_eventid']) || (int) $p['r_eventid'] === 0
        ));

        $trigger_ids = array_unique(array_column($problems, 'objectid'));
        $trigger_hosts = $this->resolveTriggerHosts($trigger_ids);
        foreach ($problems as &$p) {
            $p['hosts'] = $trigger_hosts[$p['objectid']] ?? [];
        }
        unset($p);
        return $problems;
    }

    private function buildAlarms(array $problems): array {
        $sev_label = [0 => 'info', 1 => 'info', 2 => 'warning', 3 => 'warning', 4 => 'high', 5 => 'disaster'];
        $out = [];
        foreach ($problems as $p) {
            $h = $p['hosts'][0] ?? null;
            $host_label = $h['name'] ?? ($h['host'] ?? '—');
            $out[] = [
                'ts'     => date('H:i:s', (int) $p['clock']),
                'sev'    => $sev_label[(int) $p['severity']] ?? 'info',
                'cam'    => $host_label,
                'hostid' => $h['hostid'] ?? null,
                'msg'    => $p['name'],
                'site'   => '',
                'ack'    => (int) $p['acknowledged'] === 1
            ];
        }
        return $out;
    }

    /** triggerid → [{hostid, host, name}, ...] via one trigger.get. */
    private function resolveTriggerHosts(array $trigger_ids): array {
        if (!$trigger_ids) return [];
        $triggers = $this->safeGet(fn() => API::Trigger()->get([
            'output'      => ['triggerid'],
            'selectHosts' => ['hostid', 'host', 'name'],
            'triggerids'  => array_values($trigger_ids)
        ]));
        $out = [];
        foreach ($triggers as $t) {
            $out[(string) $t['triggerid']] = $t['hosts'] ?? [];
        }
        return $out;
    }

    /** Coerce any API::*->get() result to an array, swallowing exceptions. */
    private function safeGet(callable $fn): array {
        try {
            $r = $fn();
            return is_array($r) ? $r : [];
        } catch (\Throwable $e) {
            error_log('[tcs] Surveillance API call failed: '.$e->getMessage());
            return [];
        }
    }
}
