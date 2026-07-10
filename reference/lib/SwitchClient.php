<?php declare(strict_types=1);

namespace Modules\TcsDashboard\Lib;

use API;

/**
 * Read-only switch-state collector built on the Zabbix Item API.
 *
 * Re-implements the operationally-interesting logic from
 * jerahl/ZabbixSwitchPortWidgets/switchports/actions/WidgetView.php as
 * instance methods. No external HTTP — every value is sourced from items
 * already populated by the Extreme EXOS by SNMP w POE template
 * (templates/extreme_exos_by_snmp_with_poe.yaml).
 *
 * Item key conventions (per the lifted template):
 *   stacking.member[<n>]                          — stack member presence/role
 *   net.if.status[ifOperStatus.<member>.<port>]   — link state per port
 *   snmp.interfaces.poe.dstatus[<member>.<port>]  — PoE detection status
 *   net.if.mac[<member>.<port>]                   — FDB / MAC-learning rows
 *
 * Valuemap (PoE): 1=Disabled, 2=Searching, 3=DeliveringPower, 4=Fault,
 *                 5=Test, 6=OtherFault.
 */
class SwitchClient {

    /** Max stack members supported by the EXOS template. */
    private const STACK_LIMIT = 8;

    /**
     * Read stacking.member[1..N] for a host. Returns one entry per discovered
     * member, ordered by index. Missing items are skipped.
     *
     * @return array<int, array{index:int, role:string, raw:string, itemid:string}>
     */
    public function stackMembers(string $hostid): array {
        $items = API::Item()->get([
            'output'    => ['itemid', 'key_', 'lastvalue'],
            'hostids'   => [$hostid],
            'search'    => ['key_' => 'stacking.member['],
            'startSearch' => true
        ]) ?: [];

        $out = [];
        foreach ($items as $it) {
            if (!preg_match('/^stacking\.member\[(\d+)\]$/', $it['key_'], $m)) {
                continue;
            }
            $idx = (int) $m[1];
            if ($idx < 1 || $idx > self::STACK_LIMIT) continue;

            $out[$idx] = [
                'index'  => $idx,
                'role'   => self::stackRoleLabel((string) $it['lastvalue']),
                'raw'    => (string) $it['lastvalue'],
                'itemid' => (string) $it['itemid']
            ];
        }
        ksort($out);
        return array_values($out);
    }

    /**
     * Read port operational status for every discovered interface on the host.
     * Returns one entry per port, keyed by "<member>.<port>".
     *
     * @return array<string, array{member:int, port:int, status:int, label:string, key:string, itemid:string}>
     */
    public function portStatus(string $hostid): array {
        $items = API::Item()->get([
            'output'      => ['itemid', 'key_', 'lastvalue'],
            'hostids'     => [$hostid],
            'search'      => ['key_' => 'net.if.status[ifOperStatus.'],
            'startSearch' => true
        ]) ?: [];

        $out = [];
        foreach ($items as $it) {
            $idx = self::parseMemberPort($it['key_'], 'net.if.status[ifOperStatus.');
            if ($idx === null) continue;
            [$member, $port] = $idx;

            $status = (int) $it['lastvalue'];
            $out[$member.'.'.$port] = [
                'member' => $member,
                'port'   => $port,
                'status' => $status,
                'label'  => self::ifOperLabel($status),
                'key'    => $it['key_'],
                'itemid' => (string) $it['itemid']
            ];
        }
        return $out;
    }

    /**
     * Read PoE detection status per port. Keyed by "<member>.<port>".
     *
     * @return array<string, array{member:int, port:int, status:int, label:string, key:string, itemid:string}>
     */
    public function poeStatus(string $hostid): array {
        $items = API::Item()->get([
            'output'      => ['itemid', 'key_', 'lastvalue'],
            'hostids'     => [$hostid],
            'search'      => ['key_' => 'snmp.interfaces.poe.dstatus['],
            'startSearch' => true
        ]) ?: [];

        $out = [];
        foreach ($items as $it) {
            $idx = self::parseMemberPort($it['key_'], 'snmp.interfaces.poe.dstatus[');
            if ($idx === null) continue;
            [$member, $port] = $idx;

            $status = (int) $it['lastvalue'];
            $out[$member.'.'.$port] = [
                'member' => $member,
                'port'   => $port,
                'status' => $status,
                'label'  => self::poeLabel($status),
                'key'    => $it['key_'],
                'itemid' => (string) $it['itemid']
            ];
        }
        return $out;
    }

    /**
     * Read the MAC-learning table for the host, if items exist. Each row is
     * one MAC observed on one port. Returns [] when no FDB items are present
     * (Bridge-MIB walk not templated on this host).
     *
     * @return array<int, array{member:int, port:int, mac:string, key:string}>
     */
    public function fdbTable(string $hostid): array {
        $items = API::Item()->get([
            'output'      => ['itemid', 'key_', 'lastvalue'],
            'hostids'     => [$hostid],
            'search'      => ['key_' => 'net.if.mac['],
            'startSearch' => true
        ]) ?: [];

        $out = [];
        foreach ($items as $it) {
            $idx = self::parseMemberPort($it['key_'], 'net.if.mac[');
            if ($idx === null) continue;
            [$member, $port] = $idx;

            $mac = trim((string) $it['lastvalue']);
            if ($mac === '') continue;

            $out[] = [
                'member' => $member,
                'port'   => $port,
                'mac'    => self::normalizeMac($mac),
                'key'    => $it['key_']
            ];
        }
        return $out;
    }

    /**
     * Aggregate everything the dashboard needs to render the Switches page
     * for a single host, in one pass.
     *
     * Performance: prior versions made 6 `item.get` calls (one per logical
     * section) — every page load and every navigator click paid all 6. We
     * now do ONE item.get that pulls every item on the host with a single
     * round-trip, then partition by key prefix in PHP. History.get is also
     * batched: items are grouped by `value_type` so we end up with at most
     * 2 history calls instead of 5 (one per KPI). Net result: ~7 fewer
     * API round-trips per request, the dominant cost.
     *
     * @return array{members:array, ports:array, poe:array, fdb:array, kpis:array, history:array, uplinks:array}
     */
    public function snapshot(string $hostid): array {
        $items = API::Item()->get([
            'output'  => ['itemid', 'key_', 'lastvalue', 'value_type', 'units'],
            'hostids' => [$hostid]
        ]) ?: [];

        $members = $this->extractStackMembers($items);
        $ports   = $this->extractPortStatus($items);
        $poe     = $this->extractPoeStatus($items);
        $fdb     = $this->extractFdb($items);
        $kpis    = $this->extractKpis($items);
        // PoE watts is per-port in this template — sum mpower items into a
        // single host-level KPI so the dashboard's "PoE Budget" tile populates.
        $this->derivePoeFromMpower($items, $kpis);

        return [
            'members'      => $members,
            'ports'        => array_values($ports),
            'poe'          => array_values($poe),
            'fdb'          => $fdb,
            'kpis'         => $kpis,
            'history'      => $this->historyForKpis($kpis),
            'uplinks'      => $this->uplinksFromTraffic($traffic = $this->extractTraffic($items)),
            'traffic'      => $traffic,
            'speeds'       => $this->extractSpeeds($items),
            'info'         => $this->extractHostInfo($items),
            'edpNeighbors' => $this->extractEdpNeighbors($items),
            'vlans'        => $this->extractVlans($items),
            'poeBudget'    => $this->extractPoeBudget($items),
            'portAuth'     => $this->extractPortAuth($items)
        ];
    }

    /**
     * Host-level identifying / firmware info pulled from the unified item
     * list. Returns a flat map of strings keyed by logical name so the
     * frontend can drop the right value into header pills without per-key
     * negotiation.
     *
     * Template items consumed:
     *   system.hw.firmware                       → firmware
     *   system.hw.model                          → model
     *   system.hw.serialnumber                   → serial
     *   system.hw.version                        → version
     *   system.sw.os[extremePrimarySoftwareRev.0]→ swOs (firmware fallback)
     *
     * @param array<int,array<string,mixed>> $items
     * @return array<string, string>
     */
    private function extractHostInfo(array $items): array {
        // Logical name → ordered list of accepted key forms.
        $map = [
            'firmware' => ['system.hw.firmware'],
            'model'    => ['system.hw.model'],
            'serial'   => ['system.hw.serialnumber'],
            'version'  => ['system.hw.version'],
            'swOs'     => ['system.sw.os[extremePrimarySoftwareRev.0]', 'system.sw.os']
        ];

        $out = [];
        foreach ($map as $logical => $candidates) {
            foreach ($items as $it) {
                $k = (string) $it['key_'];
                $hit = false;
                foreach ($candidates as $cand) {
                    if ($k === $cand || str_starts_with($k, $cand.'[') || str_starts_with($k, $cand)) {
                        $hit = true;
                        break;
                    }
                }
                if (!$hit) continue;
                $v = trim((string) $it['lastvalue']);
                if ($v === '') continue;
                $out[$logical] = $v;
                break;
            }
        }
        return $out;
    }

    /**
     * Per-port link speed in Mbps, keyed by "m.p". Template items:
     *   net.if.speed[ifHighSpeed.<idx>]   — nominally Mbps, but the Extreme
     *                                       EXOS template ships a × 1,000,000
     *                                       preprocessor + units=bps, so the
     *                                       stored value is bps. We have to
     *                                       check the item's units field
     *                                       rather than guess from the key.
     *   net.if.speed[ifSpeed.<idx>]       — bps (per IF-MIB).
     *
     * @param array<int,array<string,mixed>> $items
     * @return array<string, int>
     */
    private function extractSpeeds(array $items): array {
        $out = [];
        foreach ($items as $it) {
            $k = (string) $it['key_'];
            $idx = self::parseMemberPort($k, 'net.if.speed[ifHighSpeed.');
            if ($idx === null) $idx = self::parseMemberPort($k, 'net.if.speed[ifSpeed.');
            if ($idx === null) continue;

            [$member, $port] = $idx;
            $val   = (float) $it['lastvalue'];
            $units = strtolower(trim((string) ($it['units'] ?? '')));

            // Decide the stored unit.
            //   - units explicitly "bps" → divide by 1e6 to get Mbps.
            //   - units explicitly "mbps"/"" with a small value → already Mbps.
            //   - heuristic fallback: anything > 100,000 must be bps (no
            //     realistic interface speed is 100 Tbps in Mbps).
            if ($units === 'bps' || $val > 100_000) {
                $mbps = (int) round($val / 1_000_000);
            } else {
                $mbps = (int) round($val);
            }
            if ($mbps <= 0) continue;
            $out[$member.'.'.$port] = $mbps;
        }
        return $out;
    }

    /* ------------------------------------------------------------------ */
    /* Partitioners (operate on the unified item list)                    */
    /* ------------------------------------------------------------------ */

    /** @param array<int,array<string,mixed>> $items */
    private function extractStackMembers(array $items): array {
        // Multiple EXOS / generic-SNMP templates use slightly different key
        // names for the stacking LLD prototype. Note that the official
        // Extreme EXOS by SNMP w POE template ships the key
        // `stacking.memeber[…]` (typo, sic) — match it as-is.
        $rxList = [
            '/^(?:extreme\.)?stacking\.member\[(\d+)\]$/',
            '/^(?:extreme\.)?stacking\.memeber\[(\d+)\]$/',
            '/^(?:extreme\.)?stack\.member\[(\d+)\]$/',
            '/^snmp\.(?:stacking|stack)\.(?:member|memeber)\[(\d+)\]$/'
        ];
        $out = [];
        foreach ($items as $it) {
            $k = (string) $it['key_'];
            $idx = null;
            foreach ($rxList as $rx) {
                if (preg_match($rx, $k, $m)) { $idx = (int) $m[1]; break; }
            }
            if ($idx === null || $idx < 1 || $idx > self::STACK_LIMIT) continue;
            $out[$idx] = [
                'index'   => $idx,
                'role'    => self::stackRoleLabel((string) $it['lastvalue']),
                'raw'     => (string) $it['lastvalue'],
                'itemid'  => (string) $it['itemid'],
                'cpu1m'   => null,
                'cpu5m'   => null,
                'mem'     => null,
                'temp'    => null,
                'serial'  => null,
                'version' => null,
                'uptime'  => null,
                'fans'    => [],
                'psus'    => []
            ];
        }

        if (empty($out)) {
            return [];
        }

        // Per-member health metrics. The template ships memory util as a
        // calculated item keyed by slot id (`vm.memory.util[<n>]`); CPU,
        // temperature, EXOS image version and chassis serial are added by
        // the `per-member-health` template patch — see
        // tcs_dashboard/notes/zabbix-template-patches/per-member-health.md.
        // If the patch hasn't been applied yet, the keys are absent and the
        // members come back with null fields (the UI then falls back to its
        // demo data).
        foreach ($items as $it) {
            $k     = (string) $it['key_'];
            $slot  = self::parseSlotFromKey($k);
            if ($slot === null || !isset($out[$slot])) continue;

            $field = self::healthFieldFor($k);
            if ($field === null) continue;

            $val = trim((string) $it['lastvalue']);
            if ($val === '') continue;

            $isNumericField = in_array($field, ['cpu1m','cpu5m','mem','temp'], true);
            $out[$slot][$field] = $isNumericField && is_numeric($val) ? (float) $val : $val;
        }

        // Stack-wide uptime. EXOS doesn't expose per-member uptime through a
        // simple SNMP scalar (extremeStackMemberBootTime is DateAndTime which
        // requires custom preprocessing); use the host-level uptime as a
        // shared value across cards. Members that join mid-stack are rare and
        // would warrant a dedicated boot-time item — track separately.
        $uptime = self::extractHostUptime($items);
        if ($uptime !== null) {
            foreach ($out as $slot => $_) {
                $out[$slot]['uptime'] = $uptime;
            }
        }

        // Fans grouped by slot via the fan→slot mapping item the patch adds.
        $fans = self::extractFansBySlot($items);
        foreach ($fans as $slot => $list) {
            if (isset($out[$slot])) $out[$slot]['fans'] = $list;
        }

        // PSUs grouped by slot via the {$PSU.PER.MEMBER} heuristic. Fans and
        // PSUs both omit graceful fallback fields when their items aren't
        // present — the UI sees an empty array and shows demo cells instead.
        $psus = self::extractPsusBySlot($items, count($out));
        foreach ($psus as $slot => $list) {
            if (isset($out[$slot])) $out[$slot]['psus'] = $list;
        }

        ksort($out);
        return array_values($out);
    }

    /**
     * Pull the slot id out of a per-member item key. Handles both the
     * memory-util keys (where the slot is the only bracket arg) and the
     * cpu/temp/serial/version keys (where it follows `…<descriptor>.<slot>`).
     */
    private static function parseSlotFromKey(string $key): ?int {
        $patterns = [
            // vm.memory.util[1]
            '/^vm\.memory\.util\[(\d+)\]$/',
            // system.cpu.util[extremeCpuMonitorSystemUtilization1min.1]
            '/^system\.cpu\.util\[extremeCpuMonitorSystemUtilization(?:1min|5min)\.(\d+)\]$/',
            // sensor.temp.value[extremeStackMemberCurrentTemperature.1]
            '/^sensor\.temp\.value\[extremeStackMemberCurrentTemperature\.(\d+)\]$/',
            // system.hw.serialnumber[extremeSlotModuleSerialNumber.1]
            '/^system\.hw\.serialnumber\[extremeSlotModuleSerialNumber\.(\d+)\]$/',
            // system.hw.firmware[extremeStackMemberCurImageVersion.1]
            '/^system\.hw\.firmware\[extremeStackMemberCurImageVersion\.(\d+)\]$/'
        ];
        foreach ($patterns as $rx) {
            if (preg_match($rx, $key, $m)) {
                $slot = (int) $m[1];
                if ($slot >= 1 && $slot <= self::STACK_LIMIT) return $slot;
            }
        }
        return null;
    }

    /**
     * Map a per-member item key onto the member-row field it should populate.
     * Returns null for keys that don't carry health data.
     */
    private static function healthFieldFor(string $key): ?string {
        if (str_starts_with($key, 'vm.memory.util['))                                              return 'mem';
        if (str_starts_with($key, 'system.cpu.util[extremeCpuMonitorSystemUtilization1min.'))      return 'cpu1m';
        if (str_starts_with($key, 'system.cpu.util[extremeCpuMonitorSystemUtilization5min.'))      return 'cpu5m';
        if (str_starts_with($key, 'sensor.temp.value[extremeStackMemberCurrentTemperature.'))      return 'temp';
        if (str_starts_with($key, 'system.hw.serialnumber[extremeSlotModuleSerialNumber.'))        return 'serial';
        if (str_starts_with($key, 'system.hw.firmware[extremeStackMemberCurImageVersion.'))        return 'version';
        return null;
    }

    /**
     * Host-level uptime in seconds, taken from hrSystemUptime.0 if present.
     * The Extreme EXOS template ships uptime in 1/100s ticks; convert to
     * whole seconds for the UI. Returns null when no candidate item is found.
     */
    private static function extractHostUptime(array $items): ?int {
        foreach ($items as $it) {
            $k = (string) $it['key_'];
            if ($k !== 'system.hw.uptime[hrSystemUptime.0]'
                && !str_starts_with($k, 'system.net.uptime[')
                && !str_starts_with($k, 'system.uptime')) {
                continue;
            }
            $v = (float) $it['lastvalue'];
            if ($v <= 0) continue;
            // The template's preprocessing usually already converts to
            // seconds (DURATION units). Heuristic: values larger than ~10y
            // in seconds suggest raw 1/100s ticks — divide.
            return $v > 315_360_000 ? (int) round($v / 100) : (int) $v;
        }
        return null;
    }

    /**
     * Group fan speeds by stack slot using extremeFanPositionSlotNum.
     * Returns map of slot → [{idx, rpm, ok}, …]. Empty when the patch
     * isn't applied (no `sensor.fan.slot[…]` items exist).
     *
     * @return array<int, array<int, array{idx:int, rpm:int, ok:bool}>>
     */
    private static function extractFansBySlot(array $items): array {
        $slotByFan = [];
        $rpmByFan  = [];
        $okByFan   = [];
        foreach ($items as $it) {
            $k = (string) $it['key_'];
            if (preg_match('/^sensor\.fan\.slot\[extremeFanPositionSlotNum\.(\d+)\]$/', $k, $m)) {
                $slotByFan[(int) $m[1]] = (int) $it['lastvalue'];
            } elseif (preg_match('/^sensor\.fan\.speed\[extremeFanSpeed\.(\d+)\]$/', $k, $m)) {
                $rpmByFan[(int) $m[1]] = (int) round((float) $it['lastvalue']);
            } elseif (preg_match('/^sensor\.fan\.status\[extremeFanOperational\.(\d+)\]$/', $k, $m)) {
                // Truthvalue: 1=true(ok), 2=false(failed).
                $okByFan[(int) $m[1]] = ((int) $it['lastvalue']) === 1;
            }
        }

        // Two ways to recover the (slot, fanInSlot) pairing:
        //   1. Explicit map from sensor.fan.slot[extremeFanPositionSlotNum.<n>]
        //      — present when the per-member-health template patch's fan
        //      slot-mapping prototype is rolled out.
        //   2. Convention encoded in the fan index itself: <member><fan>
        //      where fan is the last two digits and member is everything
        //      above them. e.g. 101 → member 1 fan 1, 306 → member 3 fan 6.
        //      EXOS uses this scheme for stacked fan numbering when the
        //      explicit mapping isn't available.
        $out = [];
        $fanIdxs = array_unique(array_merge(
            array_keys($slotByFan),
            array_keys($rpmByFan),
            array_keys($okByFan)
        ));
        foreach ($fanIdxs as $fanIdx) {
            $slot       = $slotByFan[$fanIdx] ?? null;
            $fanInSlot  = null;
            if ($slot === null && $fanIdx >= 100) {
                $slot      = intdiv($fanIdx, 100);
                $fanInSlot = $fanIdx % 100;
            } elseif ($slot === null) {
                // Standalone switch (no encoded member) — bucket under slot 1.
                $slot      = 1;
                $fanInSlot = $fanIdx;
            } else {
                // We have explicit slot but no in-slot index; preserve
                // ordering by global fan index instead.
                $fanInSlot = $fanIdx;
            }
            if ($slot < 1 || $slot > self::STACK_LIMIT) continue;

            $out[$slot][] = [
                'idx' => $fanInSlot,
                'rpm' => $rpmByFan[$fanIdx] ?? 0,
                'ok'  => $okByFan[$fanIdx] ?? true
            ];
        }
        foreach ($out as $slot => $list) {
            usort($out[$slot], fn($a, $b) => $a['idx'] <=> $b['idx']);
        }
        return $out;
    }

    /**
     * Group PSU status + wattage by stack slot using the
     * {$PSU.PER.MEMBER} heuristic: PSU number N belongs to slot
     * ceil(N / PSU_PER_MEMBER). Returns map of slot → [{idx, watts, ok,
     * status}, …]. Status 1=notPresent, 2=presentOK, 3=presentNotOK,
     * 4=presentPowerOff.
     *
     * @return array<int, array<int, array{idx:int, watts:int, ok:bool, present:bool, status:int}>>
     */
    private static function extractPsusBySlot(array $items, int $memberCount): array {
        $statusByPsu = [];
        $wattsByPsu  = [];
        foreach ($items as $it) {
            $k = (string) $it['key_'];
            if (preg_match('/^sensor\.psu\.status\[extremePowerSupplyStatus\.(\d+)\]$/', $k, $m)) {
                $statusByPsu[(int) $m[1]] = (int) $it['lastvalue'];
            } elseif (preg_match('/^sensor\.psu\.wattage\[extremePowerSupplyWattage\.(\d+)\]$/', $k, $m)) {
                $wattsByPsu[(int) $m[1]] = (int) round((float) $it['lastvalue']);
            }
        }
        if (empty($statusByPsu) && empty($wattsByPsu)) return [];

        // {$PSU.PER.MEMBER} would let an operator override the heuristic,
        // but reading host macros requires an extra API call. For now,
        // derive it from the PSU count: total / member count, clamped to
        // 1..4. This handles 1-PSU-per-member and 2-PSU-per-member layouts
        // without configuration.
        $psuKeys   = array_unique(array_merge(array_keys($statusByPsu), array_keys($wattsByPsu)));
        $psuTotal  = count($psuKeys);
        $perMember = $memberCount > 0 ? max(1, min(4, (int) round($psuTotal / $memberCount))) : 2;

        $out = [];
        foreach ($psuKeys as $psuIdx) {
            $slot = (int) ceil($psuIdx / $perMember);
            if ($slot < 1 || $slot > self::STACK_LIMIT) continue;
            $status = $statusByPsu[$psuIdx] ?? 0;
            $out[$slot][] = [
                'idx'     => $psuIdx,
                'watts'   => $wattsByPsu[$psuIdx] ?? 0,
                'status'  => $status,
                'present' => $status !== 0 && $status !== 1,
                'ok'      => $status === 2
            ];
        }
        foreach ($out as $slot => $list) {
            usort($out[$slot], fn($a, $b) => $a['idx'] <=> $b['idx']);
        }
        return $out;
    }

    /**
     * Extract EDP neighbors from the unified item list.
     *
     * Keys produced by the vlan-poe-topology.yaml patch:
     *   extreme.edp.name[<idx>]     — neighbor's hostname
     *   extreme.edp.version[<idx>]  — neighbor's EXOS version
     *   extreme.edp.slot[<idx>]     — neighbor's slot number
     *   extreme.edp.port[<idx>]     — neighbor's port number
     *   extreme.edp.age[<idx>]      — seconds since last refresh
     *
     * <idx> is the OID-encoded composite index of extremeEdpTable:
     *   "<localIfIndex>.<8>.<b1>.<b2>.<b3>.<b4>.<b5>.<b6>.<b7>.<b8>"
     * — local ifIndex followed by the 8-octet ExtremeDeviceId (length
     * 8 + 8 bytes). Component 0 is the local ifIndex, which we decode
     * via parseMemberPort to recover (member, port) on the local switch.
     *
     * @return array<int, array{
     *     localIfIndex:int,
     *     localMember:int|null,
     *     localPort:int|null,
     *     localLabel:string,
     *     deviceId:string,
     *     name:string,
     *     version:string,
     *     peerSlot:int|null,
     *     peerPort:int|null,
     *     peerLabel:string,
     *     age:int|null
     * }>
     */
    private function extractEdpNeighbors(array $items): array {
        $bag = [];
        $fieldMap = [
            'extreme.edp.name['    => 'name',
            'extreme.edp.version[' => 'version',
            'extreme.edp.slot['    => 'peerSlot',
            'extreme.edp.port['    => 'peerPort',
            'extreme.edp.age['     => 'age'
        ];
        foreach ($items as $it) {
            $k = (string) $it['key_'];
            foreach ($fieldMap as $prefix => $field) {
                if (!str_starts_with($k, $prefix)) continue;
                $idx = substr($k, strlen($prefix), -1); // strip "]" at the end
                if ($idx === '') break;
                $row = $bag[$idx] ?? ['_idx' => $idx];
                $val = trim((string) $it['lastvalue']);
                if ($val === '') {
                    $bag[$idx] = $row;
                    break;
                }
                $row[$field] = in_array($field, ['peerSlot', 'peerPort', 'age'], true) && is_numeric($val)
                    ? (int) $val
                    : $val;
                $bag[$idx] = $row;
                break;
            }
        }

        $out = [];
        foreach ($bag as $idx => $row) {
            // Decode the composite index. For extremeEdpTable indexed by
            // (extremeEdpPortIfIndex, extremeEdpNeighborId), where
            // NeighborId is OCTET STRING (SIZE (8)) — fixed size, no
            // IMPLIED — SMIv2 maps each octet to its own sub-OID with
            // NO length prefix. So {#SNMPINDEX} is 9 components:
            //   <ifIndex>.<b1>.<b2>.<b3>.<b4>.<b5>.<b6>.<b7>.<b8>
            // Accept the 10-component form too (length-prefixed) defensively
            // in case some EXOS build does include the length byte.
            $parts = explode('.', $idx);
            if (count($parts) < 9) continue;

            $localIfIndex  = (int) $parts[0];
            if (count($parts) >= 10 && (int) $parts[1] === 8) {
                $deviceIdBytes = array_slice($parts, 2, 8);
            } else {
                $deviceIdBytes = array_slice($parts, 1, 8);
            }
            $deviceId = implode(':', array_map(
                fn($b) => sprintf('%02x', max(0, min(255, (int) $b))),
                $deviceIdBytes
            ));

            // Decode local ifIndex → (member, port) using the same Extreme
            // EXOS convention parseMemberPort already handles for the rest
            // of the snapshot. We can't call parseMemberPort directly (it
            // takes a key + prefix) so inline the simple branch here.
            $localMember = null;
            $localPort   = null;
            if ($localIfIndex > 0) {
                if ($localIfIndex < 1000) {
                    $localMember = 1;
                    $localPort   = $localIfIndex;
                } else {
                    $m = intdiv($localIfIndex, 1000);
                    $p = $localIfIndex % 1000;
                    if ($m >= 1 && $m <= self::STACK_LIMIT && $p > 0) {
                        $localMember = $m;
                        $localPort   = $p;
                    }
                }
            }
            $localLabel = ($localMember !== null && $localPort !== null)
                ? "{$localMember}:{$localPort}"
                : (string) $localIfIndex;

            $peerSlot = $row['peerSlot'] ?? null;
            $peerPort = $row['peerPort'] ?? null;
            $peerLabel = ($peerSlot !== null && $peerPort !== null)
                ? "{$peerSlot}:{$peerPort}"
                : '';

            $out[] = [
                'localIfIndex' => $localIfIndex,
                'localMember'  => $localMember,
                'localPort'    => $localPort,
                'localLabel'   => $localLabel,
                'deviceId'     => $deviceId,
                'name'         => (string) ($row['name'] ?? ''),
                'version'      => (string) ($row['version'] ?? ''),
                'peerSlot'     => $peerSlot,
                'peerPort'     => $peerPort,
                'peerLabel'    => $peerLabel,
                'age'          => isset($row['age']) ? (int) $row['age'] : null
            ];
        }

        // Stable order: local port first, then peer name. Helps the
        // dashboard render deterministically across snapshot polls.
        usort($out, function ($a, $b) {
            $cmp = ($a['localIfIndex'] ?? 0) <=> ($b['localIfIndex'] ?? 0);
            if ($cmp !== 0) return $cmp;
            return strcmp($a['name'] ?? '', $b['name'] ?? '');
        });

        return $out;
    }

    /**
     * Parse a PortList octet string (RFC 2674 §5) into a list of 1-based
     * port numbers. Each octet covers eight ports, MSB-first: octet 0
     * bit 7 = port 1, octet 0 bit 0 = port 8, octet 1 bit 7 = port 9,
     * etc. Accepts the various display forms net-snmp can return:
     *   - hex with separators: "FF 00 80", "ff:00:80", "ff-00-80"
     *   - bare hex:            "ff0080"
     *   - "Hex-STRING: …"      (Zabbix preserves the snmpwalk prefix)
     *
     * @return int[]
     */
    private static function parsePortList(string $raw): array {
        $s = trim($raw);
        if ($s === '') return [];
        // Strip common prefixes Zabbix can preserve.
        if (str_starts_with($s, 'Hex-STRING:')) $s = trim(substr($s, 11));
        if (str_starts_with($s, '0x') || str_starts_with($s, '0X')) $s = substr($s, 2);
        // Remove non-hex separators.
        $hex = preg_replace('/[^0-9a-fA-F]/', '', $s) ?? '';
        if ($hex === '' || strlen($hex) % 2 !== 0) return [];

        $ports = [];
        $octetCount = intdiv(strlen($hex), 2);
        for ($i = 0; $i < $octetCount; $i++) {
            $byte = hexdec(substr($hex, $i * 2, 2));
            if ($byte === 0) continue;
            for ($bit = 0; $bit < 8; $bit++) {
                // MSB (bit 7) is the lowest-numbered port in this octet.
                if (($byte >> (7 - $bit)) & 1) {
                    $ports[] = $i * 8 + $bit + 1;
                }
            }
        }
        return $ports;
    }

    /**
     * Build the live VLAN list with per-slot tagged/untagged port sets.
     *
     * Reads items from the vlan-poe-topology template patch:
     *   extreme.vlan.id[<vlanIfIndex>]        — 802.1Q VID
     *   extreme.vlan.descr[<vlanIfIndex>]     — VLAN name (DisplayString)
     *   extreme.vlan.admin[<vlanIfIndex>]     — admin status (1=enabled)
     *   extreme.vlan.encaps[<vlanIfIndex>]    — 1=8021q, 2=none
     *   extreme.vlan.tagged[<vlanIfIndex>.<slot>]   — PortList bitmap
     *   extreme.vlan.untagged[<vlanIfIndex>.<slot>] — PortList bitmap
     *
     * @return array<int, array{
     *     ifIndex:int,
     *     vid:int|null,
     *     name:string,
     *     active:bool,
     *     encaps:int|null,
     *     taggedPorts:array<int,int[]>,
     *     untaggedPorts:array<int,int[]>,
     *     untaggedCount:int,
     *     taggedCount:int
     * }>
     */
    private function extractVlans(array $items): array {
        $vlans = [];

        $scalarMap = [
            'extreme.vlan.id['     => 'vid',
            'extreme.vlan.descr['  => 'name',
            'extreme.vlan.admin['  => 'admin',
            'extreme.vlan.encaps[' => 'encaps'
        ];

        foreach ($items as $it) {
            $k = (string) $it['key_'];

            foreach ($scalarMap as $prefix => $field) {
                if (!str_starts_with($k, $prefix)) continue;
                $ifIdx = (int) substr($k, strlen($prefix), -1);
                if ($ifIdx <= 0) break;
                $row = $vlans[$ifIdx] ?? [
                    'ifIndex'       => $ifIdx,
                    'vid'           => null,
                    'name'          => '',
                    'admin'         => null,
                    'encaps'        => null,
                    'taggedPorts'   => [],
                    'untaggedPorts' => []
                ];
                $val = trim((string) $it['lastvalue']);
                if ($val !== '') {
                    if ($field === 'name') {
                        $row['name'] = $val;
                    } elseif (is_numeric($val)) {
                        $row[$field] = (int) $val;
                    }
                }
                $vlans[$ifIdx] = $row;
                break;
            }

            // Port-membership bitmaps. Key is
            // extreme.vlan.{tagged,untagged}[<ifIndex>.<slot>] — split on
            // the "." inside the bracket.
            if (preg_match('/^extreme\.vlan\.(tagged|untagged)\[(\d+)\.(\d+)\]$/', $k, $m)) {
                $kind  = $m[1];
                $ifIdx = (int) $m[2];
                $slot  = (int) $m[3];
                if ($ifIdx <= 0 || $slot < 1 || $slot > self::STACK_LIMIT) continue;
                $row = $vlans[$ifIdx] ?? [
                    'ifIndex'       => $ifIdx,
                    'vid'           => null,
                    'name'          => '',
                    'admin'         => null,
                    'encaps'        => null,
                    'taggedPorts'   => [],
                    'untaggedPorts' => []
                ];
                $ports = self::parsePortList((string) $it['lastvalue']);
                if (!empty($ports)) {
                    $bucket = $kind === 'tagged' ? 'taggedPorts' : 'untaggedPorts';
                    $row[$bucket][$slot] = $ports;
                }
                $vlans[$ifIdx] = $row;
            }
        }

        // Finalize: derive per-VLAN tagged/untagged port counts, drop the
        // raw admin field, expose `active` boolean.
        $out = [];
        foreach ($vlans as $ifIdx => $row) {
            $taggedCount = array_sum(array_map('count', $row['taggedPorts']));
            $untaggedCount = array_sum(array_map('count', $row['untaggedPorts']));
            $out[] = [
                'ifIndex'       => $row['ifIndex'],
                'vid'           => $row['vid'],
                'name'          => $row['name'],
                'active'        => ($row['admin'] ?? 0) === 1,
                'encaps'        => $row['encaps'],
                'taggedPorts'   => $row['taggedPorts'],
                'untaggedPorts' => $row['untaggedPorts'],
                'taggedCount'   => $taggedCount,
                'untaggedCount' => $untaggedCount
            ];
        }

        // Order by VID where known, falling back to ifIndex.
        usort($out, function ($a, $b) {
            $av = $a['vid'] ?? PHP_INT_MAX;
            $bv = $b['vid'] ?? PHP_INT_MAX;
            $cmp = $av <=> $bv;
            return $cmp !== 0 ? $cmp : ($a['ifIndex'] <=> $b['ifIndex']);
        });

        return $out;
    }

    /**
     * Build the PoE Budget payload — per-slot budget/draw figures from the
     * vlan-poe-topology template patch's extreme.poe.* items, plus the
     * per-port watts/class needed for the top-consumers table.
     *
     * Per-slot items (W unless noted):
     *   extreme.poe.budget[<slot>]    — extremePethSlotPowerLimit
     *   extreme.poe.drawn[<slot>]     — extremePethSlotConsumptionPower (allocated)
     *   extreme.poe.measured[<slot>]  — extremePethSlotMeasuredPower
     *   extreme.poe.available[<slot>] — extremePethSlotMaxAvailPower
     *   extreme.poe.capacity[<slot>]  — extremePethSlotMaxCapacity
     *   extreme.poe.status[<slot>]    — extremePethSlotPoeStatus (2=operational)
     *
     * Per-port items (already in the base template):
     *   snmp.interfaces.poe.mpower[<idx>] — measured power in milliwatts
     *   snmp.interfaces.poe.dstatus[<idx>] — PoE detection status
     * Plus the patch adds:
     *   snmp.interfaces.poe.class[<idx>]  — pethPsePortPowerClassifications
     *
     * @return array{
     *     totals:  array{drawn:float, budget:float, available:float, measured:float, pct:int},
     *     members: array<int, array{idx:int, drawn:float, budget:float, available:float, measured:float|null, capacity:float|null, status:int|null, portCount:int}>,
     *     ports:   array<int, array{member:int, port:int, watts:float, class:int|null}>
     * }
     */
    private function extractPoeBudget(array $items): array {
        $perSlot = [];
        $perPortWatts = []; // "m.p" → watts
        $perPortClass = []; // "m.p" → class (1..5)

        foreach ($items as $it) {
            $k = (string) $it['key_'];
            $v = trim((string) $it['lastvalue']);
            if ($v === '') continue;

            if (preg_match('/^extreme\.poe\.(budget|drawn|measured|available|capacity|status)\[(\d+)\]$/', $k, $m)) {
                $slot  = (int) $m[2];
                $field = $m[1];
                if ($slot < 1 || $slot > self::STACK_LIMIT) continue;
                $perSlot[$slot][$field] = is_numeric($v) ? (float) $v : 0.0;
                continue;
            }

            // Per-port mpower (milliwatts). Reuse parseMemberPort for the
            // single-ifIndex vs "m.p" key shapes.
            $idx = self::parseMemberPort($k, 'snmp.interfaces.poe.mpower[');
            if ($idx !== null) {
                [$mem, $port] = $idx;
                $watts = ((float) $v) / 1000.0;
                if ($watts > 0) $perPortWatts["{$mem}.{$port}"] = $watts;
                continue;
            }

            // Per-port PoE class.
            $idx = self::parseMemberPort($k, 'snmp.interfaces.poe.class[');
            if ($idx !== null) {
                [$mem, $port] = $idx;
                $cls = (int) $v;
                if ($cls >= 1 && $cls <= 5) $perPortClass["{$mem}.{$port}"] = $cls;
                continue;
            }
        }

        // Per-port mpower sums per member, for the headline drawn figure
        // and the port count column on each per-member row.
        $drawnBySlot     = [];
        $portCountBySlot = [];
        foreach ($perPortWatts as $mp => $w) {
            [$mem] = explode('.', $mp);
            $slot = (int) $mem;
            $drawnBySlot[$slot]     = ($drawnBySlot[$slot]     ?? 0.0) + $w;
            $portCountBySlot[$slot] = ($portCountBySlot[$slot] ?? 0)   + 1;
        }

        $members = [];
        $totalDrawn     = 0.0;
        $totalBudget    = 0.0;
        $totalAvailable = 0.0;
        $totalMeasured  = 0.0;
        $memberSlots = array_unique(array_merge(array_keys($perSlot), array_keys($drawnBySlot)));
        sort($memberSlots);

        // Trust the per-slot extremePethPseSlotTable values for budget /
        // available / measured / capacity / status. The template patch
        // now keys these by {#SNMPINDEX} so each member gets its own
        // row. Stack-wide totals are the straight sum across members.
        foreach ($memberSlots as $slot) {
            $row = $perSlot[$slot] ?? [];
            $budget    = (float) ($row['budget']    ?? 0);
            $drawn     = isset($row['drawn'])
                ? (float) $row['drawn']
                : round($drawnBySlot[$slot] ?? 0.0, 1);
            $available = (float) ($row['available'] ?? max(0.0, $budget - $drawn));
            $measured  = isset($row['measured']) ? (float) $row['measured'] : null;
            $totalDrawn     += $drawn;
            $totalBudget    += $budget;
            $totalAvailable += $available;
            if ($measured !== null) $totalMeasured += $measured;
            $members[] = [
                'idx'       => $slot,
                'drawn'     => round($drawn, 1),
                'budget'    => round($budget, 1),
                'available' => round($available, 1),
                'measured'  => $measured !== null ? round($measured, 1) : null,
                'capacity'  => isset($row['capacity']) ? (float) $row['capacity'] : null,
                'status'    => isset($row['status'])   ? (int)   $row['status']   : null,
                'portCount' => $portCountBySlot[$slot] ?? 0
            ];
        }

        $ports = [];
        foreach ($perPortWatts as $mp => $watts) {
            [$mem, $port] = explode('.', $mp);
            $ports[] = [
                'member' => (int) $mem,
                'port'   => (int) $port,
                'watts'  => round($watts, 1),
                'class'  => $perPortClass[$mp] ?? null
            ];
        }
        usort($ports, fn($a, $b) => $b['watts'] <=> $a['watts']);

        return [
            'totals' => [
                'drawn'     => round($totalDrawn, 1),
                'budget'    => round($totalBudget, 1),
                'available' => round($totalAvailable, 1),
                'measured'  => round($totalMeasured, 1),
                'pct'       => $totalBudget > 0 ? (int) round(($totalDrawn / $totalBudget) * 100) : 0
            ],
            'members' => $members,
            'ports'   => $ports
        ];
    }

    /**
     * Per-port authenticated sessions from the port-auth template patch.
     *
     * Keys: extreme.portauth.{status, agent, duration, idle, vlan, policy,
     * applied}[<idx>]
     *
     * Index encoding (etsysMultiAuthSessionStationTable, 4-tuple
     * (StationAddrType, StationAddr, ifIndex, AgentType)) for MAC-keyed
     * sessions is 10 components: "3.6.<m1>.<m2>.<m3>.<m4>.<m5>.<m6>.<ifIndex>.<agentType>"
     * — addrType=3 (mac), addrLen=6, then 6 MAC bytes, then ifIndex,
     * then agentType. We extract the MAC, port ifIndex (→ member.port),
     * and agentType from the index components and group sessions under
     * the local port key "<m>.<p>".
     *
     * AgentType values: 1=ieee8021x, 2=pwa, 3=macAuth, 4=cep,
     *                   5=radiusSnooping, 6=autoTracking, 7=quarantineAgent
     *
     * @return array<string, array<int, array{
     *     mac:string, agent:int, agentLabel:string, status:int,
     *     applied:bool, policy:int|null, vlan:int|null,
     *     duration:int|null, idle:int|null
     * }>>
     */
    private function extractPortAuth(array $items): array {
        $bag = []; // by index → fields
        $fieldMap = [
            'extreme.portauth.status['   => 'status',
            'extreme.portauth.agent['    => 'agent',
            'extreme.portauth.duration[' => 'duration',
            'extreme.portauth.idle['     => 'idle',
            'extreme.portauth.vlan['     => 'vlan',
            'extreme.portauth.policy['   => 'policy',
            'extreme.portauth.applied['  => 'applied'
        ];

        foreach ($items as $it) {
            $k = (string) $it['key_'];
            foreach ($fieldMap as $prefix => $field) {
                if (!str_starts_with($k, $prefix)) continue;
                $idx = substr($k, strlen($prefix), -1);
                if ($idx === '') break;
                $row = $bag[$idx] ?? ['_idx' => $idx];
                $val = trim((string) $it['lastvalue']);
                if ($val !== '' && is_numeric($val)) {
                    $row[$field] = (int) $val;
                }
                $bag[$idx] = $row;
                break;
            }
        }

        $out = [];
        $agentLabels = [
            1 => '802.1X',
            2 => 'web-auth',
            3 => 'MAC-auth',
            4 => 'CEP',
            5 => 'RADIUS-snoop',
            6 => 'auto-track',
            7 => 'quarantine'
        ];
        foreach ($bag as $idx => $row) {
            $parts = explode('.', $idx);
            if (count($parts) < 10) continue;

            // addrType.addrLen.<6 MAC bytes>.<ifIndex>.<agentType>
            $addrType = (int) $parts[0];
            $addrLen  = (int) $parts[1];
            if ($addrType !== 3 || $addrLen !== 6) continue;

            $macBytes  = array_slice($parts, 2, 6);
            $mac       = implode(':', array_map(
                fn($b) => sprintf('%02x', max(0, min(255, (int) $b))),
                $macBytes
            ));
            $ifIndex   = (int) $parts[8];
            $agentType = (int) $parts[9];

            // Decode ifIndex → (member, port) using the same Extreme EXOS
            // convention used elsewhere in this client.
            $member = null; $port = null;
            if ($ifIndex > 0 && $ifIndex < 1000) {
                $member = 1; $port = $ifIndex;
            } elseif ($ifIndex >= 1000) {
                $m = intdiv($ifIndex, 1000);
                $p = $ifIndex % 1000;
                if ($m >= 1 && $m <= self::STACK_LIMIT && $p > 0) {
                    $member = $m; $port = $p;
                }
            }
            if ($member === null || $port === null) continue;

            $key = "{$member}.{$port}";
            $out[$key][] = [
                'mac'        => $mac,
                'agent'      => $agentType,
                'agentLabel' => $agentLabels[$agentType] ?? "agent-{$agentType}",
                'status'     => $row['status'] ?? 0,
                'applied'    => ($row['applied'] ?? 0) === 1,
                'policy'     => $row['policy'] ?? null,
                'vlan'       => $row['vlan'] ?? null,
                'duration'   => $row['duration'] ?? null,
                'idle'       => $row['idle'] ?? null
            ];
        }

        // Sort each port's sessions so applied entries come first.
        foreach ($out as $key => $list) {
            usort($out[$key], function ($a, $b) {
                if ($a['applied'] !== $b['applied']) return $a['applied'] ? -1 : 1;
                return ($b['duration'] ?? 0) <=> ($a['duration'] ?? 0);
            });
        }

        return $out;
    }

    /** @param array<int,array<string,mixed>> $items */
    private function extractPortStatus(array $items): array {
        // Try the prefixes the various EXOS / generic-SNMP templates use, in
        // order of specificity. parseMemberPort returns null on miss so we
        // fall through to the next candidate.
        $prefixes = [
            'net.if.status[ifOperStatus.',
            'net.if.status[',
            'ifOperStatus[',
            'snmp.interfaces.ifoperstatus[',
            'snmp.interfaces.status[',
            'snmp.interfaces.if.status['
        ];
        $out = [];
        foreach ($items as $it) {
            $k = (string) $it['key_'];
            $idx = null;
            foreach ($prefixes as $p) {
                $idx = self::parseMemberPort($k, $p);
                if ($idx !== null) break;
            }
            if ($idx === null) continue;
            [$member, $port] = $idx;
            $status = (int) $it['lastvalue'];
            $out[$member.'.'.$port] = [
                'member' => $member, 'port' => $port, 'status' => $status,
                'label' => self::ifOperLabel($status),
                'key' => $it['key_'], 'itemid' => (string) $it['itemid']
            ];
        }
        return $out;
    }

    /** @param array<int,array<string,mixed>> $items */
    private function extractPoeStatus(array $items): array {
        $out = [];
        foreach ($items as $it) {
            $idx = self::parseMemberPort((string) $it['key_'], 'snmp.interfaces.poe.dstatus[');
            if ($idx === null) continue;
            [$member, $port] = $idx;
            $status = (int) $it['lastvalue'];
            $out[$member.'.'.$port] = [
                'member' => $member, 'port' => $port, 'status' => $status,
                'label' => self::poeLabel($status),
                'key' => $it['key_'], 'itemid' => (string) $it['itemid']
            ];
        }
        return $out;
    }

    /** @param array<int,array<string,mixed>> $items */
    private function extractFdb(array $items): array {
        // Two template variants for the FDB / MAC-learning list:
        //   net.if.mac[<idx>]   (generic SNMP)
        //   port.mac.list[<idx>] (Extreme EXOS by SNMP w POE)
        $prefixes = ['net.if.mac[', 'port.mac.list['];
        $out = [];
        foreach ($items as $it) {
            $k = (string) $it['key_'];
            $idx = null;
            foreach ($prefixes as $p) {
                $idx = self::parseMemberPort($k, $p);
                if ($idx !== null) break;
            }
            if ($idx === null) continue;
            [$member, $port] = $idx;
            $raw = trim((string) $it['lastvalue']);
            if ($raw === '') continue;
            // port.mac.list returns a comma-separated list; explode and emit
            // one FDB row per MAC so the bridge can attach them to the right
            // port detail.
            foreach (preg_split('/[\s,;]+/', $raw) as $tok) {
                $tok = trim((string) $tok);
                if ($tok === '') continue;
                $out[] = [
                    'member' => $member, 'port' => $port,
                    'mac'    => self::normalizeMac($tok),
                    'key'    => $k
                ];
            }
        }
        return $out;
    }

    /** @param array<int,array<string,mixed>> $items */
    private function extractKpis(array $items): array {
        $out = [];
        foreach (self::KPI_MATCHERS as $logical => $matchers) {
            foreach ($matchers as [$mode, $needle]) {
                foreach ($items as $it) {
                    $k = (string) $it['key_'];
                    $hit = match ($mode) {
                        'exact'    => $k === $needle,
                        'prefix'   => str_starts_with($k, $needle),
                        'contains' => str_contains($k, $needle),
                        default    => false
                    };
                    if ($hit) {
                        $out[$logical] = [
                            'itemid'     => (string) $it['itemid'],
                            'key'        => $k,
                            'lastvalue'  => is_numeric($it['lastvalue']) ? (float) $it['lastvalue'] : $it['lastvalue'],
                            'value_type' => (int) $it['value_type'],
                            'units'      => (string) $it['units']
                        ];
                        continue 3;
                    }
                }
            }
        }
        return $out;
    }

    /**
     * Extreme EXOS by SNMP w POE doesn't ship a host-level "total PoE watts"
     * item — it has per-port `snmp.interfaces.poe.mpower[<idx>]` (milliwatts).
     * Sum those into a synthetic KPI so the PoE Budget tile populates.
     *
     * @param array<int,array<string,mixed>> $items
     * @param array<string,array<string,mixed>> $kpis  modified in place
     */
    private function derivePoeFromMpower(array $items, array &$kpis): void {
        if (isset($kpis['poeWatts'])) return; // template provided one directly

        $milliWatts = 0.0;
        $haveAny = false;
        foreach ($items as $it) {
            $k = (string) $it['key_'];
            if (!str_starts_with($k, 'snmp.interfaces.poe.mpower[')) continue;
            $haveAny = true;
            $milliWatts += (float) $it['lastvalue'];
        }
        if (!$haveAny) return;

        $kpis['poeWatts'] = [
            'itemid'     => '',
            'key'        => 'synthetic:sum(snmp.interfaces.poe.mpower[*])',
            'lastvalue'  => round($milliWatts / 1000.0, 1),  // mW → W
            'value_type' => 0,
            'units'      => 'W'
        ];
    }

    /**
     * Extract per-port traffic + errors from net.if.in/out/errors items.
     * Returns one row per (m.p) key with bps values + error count, so
     * uplinksFromTraffic can pick the top N and makePortDetail can read
     * per-port rates without a second fetch.
     *
     * @param array<int,array<string,mixed>> $items
     * @return array<string, array{in:float, out:float, err:int}>
     */
    private function extractTraffic(array $items): array {
        // Per-port rate + error + discard items. Extreme EXOS by SNMP w POE
        // ships in/out variants for each — we keep them separate so the UI
        // can show "in X / out Y" honestly.
        //
        // parseMemberPort handles both single-ifIndex and "m.p" suffixes.
        $prefixes = [
            'in'      => ['net.if.in[ifHCInOctets.',           'net.if.in['],
            'out'     => ['net.if.out[ifHCOutOctets.',         'net.if.out['],
            'errIn'   => ['net.if.in.errors[ifInErrors.',      'net.if.in.errors['],
            'errOut'  => ['net.if.out.errors[ifOutErrors.',    'net.if.out.errors['],
            'discIn'  => ['net.if.in.discards[ifInDiscards.',  'net.if.in.discards['],
            'discOut' => ['net.if.out.discards[ifOutDiscards.','net.if.out.discards[']
        ];

        $by = [];
        foreach ($items as $it) {
            $k = (string) $it['key_'];
            $hit = null; $hitKind = null;
            foreach ($prefixes as $kind => $pfxList) {
                foreach ($pfxList as $p) {
                    $r = self::parseMemberPort($k, $p);
                    if ($r !== null) { $hit = $r; $hitKind = $kind; break 2; }
                }
            }
            if ($hit === null) continue;
            $idx = $hit[0].'.'.$hit[1];
            $by[$idx] ??= [
                'in' => 0.0, 'out' => 0.0,
                'errIn' => 0, 'errOut' => 0,
                'discIn' => 0, 'discOut' => 0
            ];
            $val = (float) $it['lastvalue'];
            if ($hitKind === 'in' || $hitKind === 'out') {
                $by[$idx][$hitKind] = $val;
            } else {
                $by[$idx][$hitKind] = (int) $val;
            }
        }
        return $by;
    }

    /** @param array<string, array<string, int|float>> $traffic */
    private function uplinksFromTraffic(array $traffic, int $limit = 4): array {
        $rows = [];
        foreach ($traffic as $idx => $v) {
            $rows[] = [
                'name'   => str_replace('.', ':', (string) $idx),
                'type'   => '—',
                'peer'   => '—',
                'rxMbps' => round((((float) $v['in'])  * 8) / 1_000_000, 1),
                'txMbps' => round((((float) $v['out']) * 8) / 1_000_000, 1),
                'util'   => 0,
                'errors' => (int) ($v['errIn'] ?? 0) + (int) ($v['errOut'] ?? 0)
            ];
        }
        usort($rows, fn($a, $b) => ($b['rxMbps'] + $b['txMbps']) <=> ($a['rxMbps'] + $a['txMbps']));
        return array_slice($rows, 0, $limit);
    }

    /* ------------------------------------------------------------------ */
    /* KPIs + history                                                     */
    /* ------------------------------------------------------------------ */

    /**
     * Logical KPI → list of candidate item-key matchers, first match wins.
     * Each matcher is [mode, needle]; modes: 'exact' | 'prefix' | 'contains'.
     * Templates vary across EXOS / generic-SNMP / agent — list the common
     * forms so the dashboard binds whichever the host actually has.
     */
    private const KPI_MATCHERS = [
        'cpu' => [
            // Extreme EXOS template:
            ['prefix',   'system.cpu.util[extremeCpuMonitorTotalUtilization'],
            ['exact',    'system.cpu.util'],
            ['prefix',   'system.cpu.util['],
            ['prefix',   'extreme.cpu.util'],
            ['contains', 'cpu.util']
        ],
        'mem' => [
            ['exact',    'vm.memory.utilization'],
            ['prefix',   'vm.memory.util'],
            ['prefix',   'extreme.memory.util'],
            ['contains', 'memory.util']
        ],
        'temp' => [
            // Extreme EXOS template:
            ['prefix',   'sensor.temp.value[extremeCurrentTemperature'],
            ['prefix',   'sensor.temp.value['],
            ['prefix',   'sensor.temp['],
            ['prefix',   'extreme.temp'],
            ['contains', 'temperature']
        ],
        // poeWatts / poeBudget are not first-class items in the Extreme EXOS
        // template — they're derived in extractKpisDerived() from the per-port
        // mpower values. Leave the matchers here for templates that DO have
        // dedicated host-level items.
        'poeWatts' => [
            ['prefix',   'extreme.poe.watts'],
            ['prefix',   'snmp.poe.total'],
            ['contains', 'poe.power.consumed']
        ],
        'poeBudget' => [
            ['contains', 'poe.power.budget'],
            ['contains', 'poe.power.max']
        ]
    ];

    /**
     * Resolve all KPI items in one pass over the host's item list, returning
     * { logical => {itemid, key, lastvalue, value_type, units} } for matches.
     *
     * @return array<string, array<string, mixed>>
     */
    /**
     * Pull 24h history for the resolved KPI items, downsampled to 48 buckets
     * (one per 30 min). Items are grouped by `value_type` so we make at
     * most 2 history.get calls (float + uint) instead of one per KPI.
     *
     * @param array<string, array<string, mixed>> $kpis
     * @return array<string, array<int, float>>
     */
    public function historyForKpis(array $kpis): array {
        $now = time();
        $from = $now - 24 * 3600;
        $buckets = 48;
        $bucketSec = (int) (($now - $from) / $buckets);

        // Group resolved KPIs by their history value_type — only float (0)
        // and unsigned-int (3) make sense for sparklines.
        $byType = [];               // value_type => [logical => itemid]
        foreach ($kpis as $logical => $meta) {
            $vt = (int) $meta['value_type'];
            if ($vt !== 0 && $vt !== 3) continue;
            $byType[$vt] ??= [];
            $byType[$vt][$logical] = (string) $meta['itemid'];
        }

        // Pre-populate the result so missing KPIs render flat.
        $out = [];
        foreach (array_keys($kpis) as $logical) $out[$logical] = [];

        foreach ($byType as $vt => $bag) {
            $itemids = array_values($bag);
            $rows = API::History()->get([
                'output'    => ['itemid', 'clock', 'value'],
                'history'   => $vt,
                'itemids'   => $itemids,
                'time_from' => $from,
                'sortfield' => 'clock',
                'sortorder' => 'ASC'
            ]) ?: [];

            // Bucket per itemid in one pass.
            $accum = [];     // itemid => [sum[], cnt[]]
            foreach ($itemids as $iid) {
                $accum[$iid] = [array_fill(0, $buckets, 0.0), array_fill(0, $buckets, 0)];
            }
            foreach ($rows as $r) {
                $iid = (string) $r['itemid'];
                if (!isset($accum[$iid])) continue;
                $i = (int) (((int) $r['clock'] - $from) / max(1, $bucketSec));
                if ($i < 0 || $i >= $buckets) continue;
                $accum[$iid][0][$i] += (float) $r['value'];
                $accum[$iid][1][$i]++;
            }
            foreach ($bag as $logical => $iid) {
                [$sum, $cnt] = $accum[$iid];
                $series = [];
                for ($i = 0; $i < $buckets; $i++) {
                    $series[] = $cnt[$i] > 0 ? round($sum[$i] / $cnt[$i], 2) : 0.0;
                }
                $out[$logical] = $series;
            }
        }
        return $out;
    }

    /* ------------------------------------------------------------------ */
    /* Internals                                                          */
    /* ------------------------------------------------------------------ */

    /**
     * Parse the port identifier out of an item key, accepting either format
     * the wild encounters:
     *
     *   - `<prefix><member>.<port>]`  (older per-stack-port templates)
     *   - `<prefix><ifIndex>]`        (Extreme EXOS by SNMP w POE — uses SNMP
     *                                  ifIndex; ifIndex = 1000 × member + port
     *                                  in stacks, or just port on standalones)
     *
     * Returns [member, port]. Returns null on mismatch.
     *
     * @return array{0:int,1:int}|null
     */
    private static function parseMemberPort(string $key, string $prefix): ?array {
        if (!str_starts_with($key, $prefix)) return null;
        $rest = substr($key, strlen($prefix));
        $rest = rtrim($rest, ']');
        if (($cpos = strpos($rest, ',')) !== false) {
            $rest = substr($rest, 0, $cpos);
        }
        // Dotted "m.p" form: take verbatim.
        if (preg_match('/^(\d+)\.(\d+)$/', $rest, $m)) {
            return [(int) $m[1], (int) $m[2]];
        }
        // Single ifIndex: derive (member, port) from the standard Extreme
        // EXOS encoding. ifIndex < 1000 → standalone (member 1). >= 1000 →
        // member = ifIndex / 1000, port = ifIndex % 1000. Anything above
        // STACK_LIMIT is rejected — those are usually VLAN / virtual ifs.
        if (preg_match('/^(\d+)$/', $rest, $m)) {
            $idx = (int) $m[1];
            if ($idx <= 0) return null;
            if ($idx < 1000) {
                return [1, $idx];
            }
            $member = intdiv($idx, 1000);
            $port   = $idx % 1000;
            if ($member < 1 || $member > self::STACK_LIMIT || $port <= 0) return null;
            return [$member, $port];
        }
        return null;
    }

    private static function ifOperLabel(int $status): string {
        // IF-MIB::ifOperStatus
        return match ($status) {
            1 => 'up',
            2 => 'down',
            3 => 'testing',
            4 => 'unknown',
            5 => 'dormant',
            6 => 'notPresent',
            7 => 'lowerLayerDown',
            default => 'unknown'
        };
    }

    private static function poeLabel(int $status): string {
        // POWER-ETHERNET-MIB::pethPsePortDetectionStatus
        return match ($status) {
            1 => 'disabled',
            2 => 'searching',
            3 => 'delivering',
            4 => 'fault',
            5 => 'test',
            6 => 'otherFault',
            default => 'unknown'
        };
    }

    private static function stackRoleLabel(string $raw): string {
        $n = is_numeric($raw) ? (int) $raw : -1;
        return match ($n) {
            1 => 'master',
            2 => 'backup',
            3 => 'standby',
            default => $raw === '' ? 'absent' : $raw
        };
    }

    private static function normalizeMac(string $mac): string {
        $hex = strtolower(preg_replace('/[^0-9a-fA-F]/', '', $mac) ?? '');
        if (strlen($hex) !== 12) return $mac;
        return implode(':', str_split($hex, 2));
    }
}
