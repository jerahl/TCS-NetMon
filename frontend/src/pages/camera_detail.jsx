import React from "react";
import { getJSON, postJSON } from "../api.js";
import {
  Card, Loading, ErrorMsg, sevColor, PageHeader, Tabs, StatCell, Dot, SevText, SourceBadge,
} from "../primitives.jsx";
import { ActionButton } from "../actions.jsx";
import { CameraPreview } from "./camera_snapshot.jsx";
import { ageOf } from "../format.js";

// Camera detail — ZCD's `tcs.camera.view` layout (spec 20 S5), filled with live
// data.
//
// ZCD's own camera page is DEMO-bannered: its health rings, telemetry
// sparklines and stream fields render from `nvr-data.jsx` fixtures, and its
// Smart Client / Restart Stream buttons do nothing. So this borrows the
// *structure* — sidecar with a preview, four tabs, the same card sequence in
// the same order — and puts real values in the slots that have a source, naming
// the ones that do not rather than showing a plausible number.
//
// Where NetMon's data is shaped differently from ZCD's, the slot keeps its
// position and changes its mark:
//
//   * Device Health is four probe cells, not four rings. ZCD's rings are CPU /
//     memory / ICMP latency / packet loss, and NetMon has none of those per
//     camera — CPU and memory need D10's SNMP sweeps, and the poller records
//     up/down without timing. What NetMon does have is four *categorical*
//     verdicts, which is more than ZCD shows and cannot be drawn as a dial.
//   * Live Telemetry · 24h is a transition strip from `state_events`, not
//     sparklines. Per-camera series would mean 2,662 series in a ring buffer
//     kept deliberately low-cardinality (D3); transitions are per-device and
//     real.

const REFRESH_MS = 30000;

const STATUS = {
  up: { label: "Up", tone: "ok", hint: "Milestone and ICMP both reach it" },
  down_confirmed: { label: "Down", tone: "err",
    hint: "Milestone and ICMP agree it is unreachable" },
  down_source_only: { label: "Milestone down", tone: "err",
    hint: "Milestone cannot reach it; the network can — platform-side, not a dead camera" },
  down_network_only: { label: "No ICMP", tone: "warn",
    hint: "does not answer ping while Milestone is content — most camera models never do" },
  unknown: { label: "Unknown", tone: "", hint: "no probe has an opinion" },
};

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "live", label: "Live" },
  { id: "events", label: "Events" },
  { id: "config", label: "Configuration" },
];
const TAB_IDS = TABS.map((t) => t.id);

// The camera's own web UI. Real and useful today — the browser prompts for the
// camera's login — and the only "live view" NetMon can offer before D7. Built
// from the registered address, never from anything a caller supplied.
function liveUrl(cam) {
  if (!cam.ip) return null;
  const port = cam.http_port ? `:${cam.http_port}` : "";
  return `http://${cam.ip}${port}/`;
}

export function CameraDetailPage({ id, embedded = false, query = {} }) {
  const [cam, setCam] = React.useState(null);
  const [meta, setMeta] = React.useState(null);
  const [alerts, setAlerts] = React.useState(null);
  const [error, setError] = React.useState(null);

  React.useEffect(() => {
    let live = true;
    getJSON("/api/meta").then((m) => live && setMeta(m)).catch(() => {});
    return () => { live = false; };
  }, []);

  React.useEffect(() => {
    let live = true;
    setCam(null);
    setAlerts(null);
    const load = () => {
      getJSON(`/api/surveillance/cameras/${id}`)
        .then((c) => live && setCam(c))
        .catch((e) => live && setError(e));
      // Open alerts on this camera drive the Active Issue card. Separate
      // endpoint because alerts are the engine's domain and carry their own
      // actions (ack, suppress) — not facts about the device.
      getJSON(`/api/alerts?device_id=${encodeURIComponent(id)}`)
        .then((a) => live && setAlerts(a))
        .catch(() => live && setAlerts([]));
    };
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => { live = false; clearInterval(t); };
  }, [id]);

  // The URL owns the active tab here as it does on the Surveillance page, so a
  // deep link opens the tab it names and the back button steps through them.
  // The base differs by route: embedded inside the Cameras page it is
  // #/cameras/:id, standalone it is #/camera/:id.
  const tab = TAB_IDS.includes(query.tab) ? query.tab : "overview";
  const setTab = (next) => {
    const base = embedded ? `#/cameras/${id}` : `#/camera/${id}`;
    location.hash = base + (next === "overview" ? "" : `?tab=${encodeURIComponent(next)}`);
  };

  if (error) return <ErrorMsg error={error} />;
  if (!cam) return <Loading what={`camera ${id}`} />;
  return <CameraDetailView cam={cam} meta={meta} alerts={alerts} embedded={embedded}
                           tab={tab} onTab={setTab} />;
}

// The render half, split from the fetching half so it can be rendered with
// fixed props. esbuild does not resolve identifiers, so a variable used outside
// its scope fails only in a browser — which is how "usedKnown is not defined"
// reached production on the Surveillance page. A component that only ever
// renders after a fetch cannot be checked that way.
export function CameraDetailView({ cam, meta, alerts, embedded = false,
                                   tab = "overview", onTab }) {
  // Controlled by the page (which keeps the tab in the URL); self-managed when
  // rendered without an `onTab`, which is how the render check drives it.
  const [localTab, setLocalTab] = React.useState(tab);
  const active = onTab ? tab : localTab;
  const pick = onTab || setLocalTab;
  const st = cam.state || {};
  const blind = st.source_status?.value === "blind";
  const tier = st.reachability?.value;
  const s = STATUS[tier] || STATUS.unknown;
  const sp = cam.switch_port;
  const url = liveUrl(cam);
  const show = (...ids) => ids.includes(active);
  const open = (alerts || []).filter((a) => !a.closed_at);

  return (
    <div className={embedded ? "" : "page"}>
      <PageHeader
        title={cam.name}
        ip={cam.ip ? `${cam.ip}${cam.http_port ? `:${cam.http_port}` : ""}` : null}
        tag={cam.model || null}
        back={embedded ? null : { href: "#/cameras", label: "Back to cameras" }}
        pills={[
          blind
            ? { label: "state", value: "Blind", severity: "warn",
                title: "Milestone has no verdict for this camera" }
            : { label: "state", value: s.label, title: s.hint,
                severity: s.tone === "ok" ? "ok" : s.tone === "err" ? "crit"
                          : s.tone === "warn" ? "warn" : undefined },
          // The Milestone group is how the surveillance team refers to a
          // camera; the site is where the network resolver placed it. Both,
          // because they are different facts (migration 026).
          cam.groups?.length
            ? { label: "group",
                value: cam.groups.map((g) => g.name).join(" · "),
                title: cam.groups.map((g) => g.site_display_name || g.name).join(" · ") }
            : null,
          { label: "site", value: cam.site || "—" },
          { label: "recording", value: cam.recording_state || "unknown",
            title: "motion-triggered on this estate — stopped is the resting state" },
          cam.recording_server
            ? { label: "recorder", value: cam.recording_server }
            : null,
          cam.mac ? { label: "mac", value: cam.mac } : null,
          { label: "cache", value: `${ageOf(cam.updated_at) || "?"} old` },
        ]}
        range="Live · 24h history"
      />

      <Tabs tabs={TABS} active={active} onChange={pick} />

      {/* ZCD's `320px 1fr`: preview and physical facts pinned on the left, the
          tab's content on the right. */}
      <div className="cam-detail-cols">
        <div className="cam-detail-side">
          <Card tight>
            <div className="device-hero" style={{ padding: 14 }}>
              <div className="status-line">
                <Dot severity={blind ? "warn" : s.tone === "ok" ? "ok"
                               : s.tone === "err" ? "crit" : "warn"} />
                <span style={{ color: blind ? sevColor("warn")
                               : s.tone === "ok" ? sevColor("ok")
                               : s.tone === "err" ? sevColor("crit") : sevColor("warn") }}>
                  {blind ? "Blind" : s.label}
                </span>
              </div>
              <CameraPreview cam={cam} url={url} />
              <div style={{ display: "flex", gap: 6, marginTop: 10, width: "100%" }}>
                {url ? (
                  <a className="btn primary" style={{ flex: 1, justifyContent: "center" }}
                     href={url} target="_blank" rel="noopener noreferrer"
                     title="the camera's own web interface — it will prompt for its login">
                    Open live view ↗
                  </a>
                ) : (
                  <span className="btn" style={{ flex: 1, justifyContent: "center", opacity: 0.5 }}
                        title="no address registered for this camera">No address</span>
                )}
              </div>
            </div>

            <div className="location-block">
              <div className="label">Location</div>
              <div className="v">
                {cam.groups?.length
                  ? cam.groups.map((g) => g.site_display_name || g.name).join(", ")
                  : (cam.site || "—")}
                {cam.site && <div className="dim" style={{ fontSize: 11 }}>{cam.site}</div>}
              </div>
            </div>
            <div className="location-block">
              <div className="label">Hardware</div>
              <div className="v">
                <div>{cam.model || "—"}</div>
                {cam.vendor && <div className="dim" style={{ fontSize: 11 }}>{cam.vendor}</div>}
                <div className="dim mono" style={{ fontSize: 11 }}>
                  MAC {cam.mac || "not collected"}
                </div>
                {cam.serial && (
                  <div className="dim mono" style={{ fontSize: 11 }}>S/N {cam.serial}</div>
                )}
                {cam.firmware && (
                  <div className="dim mono" style={{ fontSize: 11 }}>FW {cam.firmware}</div>
                )}
                {/* ZCD shows a PoE draw here from a Zabbix item. NetMon reads
                    PoE from the switch, so it belongs with the uplink — and
                    only when the port is resolved. */}
                <div className="dim" style={{ fontSize: 11 }}>
                  PoE {sp?.poe_watts ? `${sp.poe_watts} W (at the switch)` : "—"}
                </div>
              </div>
            </div>
            <div className="location-block">
              <div className="label">Recording server</div>
              <div className="v" style={{ fontSize: 11 }}>{cam.recording_server || "—"}</div>
            </div>
          </Card>
        </div>

        <div className="cam-detail-main">
          {/* Always shown when present, whatever the tab — an open problem is
              not something to have to go looking for. */}
          {open.length > 0 && <ActiveIssue alerts={open} />}

          {show("overview", "live") && <DeviceHealth cam={cam} st={st} tier={tier} blind={blind} />}

          {show("overview") && <ReachabilityStrip events={cam.events} />}

          {show("live", "config") && (
            <Card title="Stream configuration" source="milestone">
              <table className="grid kv">
                <tbody>
                  <tr><td>Codec</td><td className="mono">{cam.codec || "—"}</td></tr>
                  <tr><td>Resolution</td><td className="mono">{cam.resolution || "—"}</td></tr>
                  <tr><td>FPS target</td><td className="mono">{cam.fps_target ?? "—"}</td></tr>
                  <tr><td>Bitrate mode</td><td className="mono">{cam.bitrate_mode || "—"}</td></tr>
                  <tr><td>Recording mode</td><td className="mono">{cam.recording_mode || "—"}</td></tr>
                  <tr><td>Recording now</td><td>
                    <span className={"rec-pill" + (cam.recording_state === "up" ? "" : " off")}>
                      {cam.recording_state || "unknown"}</span>
                    <span className="dim" style={{ fontSize: 11, marginLeft: 8 }}>
                      motion-triggered — stopped is normal</span>
                  </td></tr>
                  <tr><td>Live view</td><td className="mono" style={{ fontSize: 11 }}>
                    {url
                      ? <a href={url} target="_blank" rel="noopener noreferrer">{url}</a>
                      : "—"}</td></tr>
                </tbody>
              </table>
              {/* ZCD lists a measured bitrate and FPS here. The Config API
                  reports the configured target only; the achieved rate needs
                  the camera itself (D10). */}
              <div className="msg" style={{ fontSize: 11, marginTop: 10 }}>
                These are the <em>configured</em> values from Milestone. Achieved
                bitrate and frame rate come from the camera and need direct SNMP
                (not enabled).
              </div>
            </Card>
          )}

          {show("config") && (
            <Card title="Network &amp; identity" source="milestone">
              <table className="grid kv">
                <tbody>
                  <tr><td>IPv4</td><td className="mono">{cam.ip || "—"}</td></tr>
                  {/* Six cameras on this estate sit on a non-default port, five
                      of them :443 over http — a fetch that assumes 80 misses
                      them entirely. */}
                  <tr><td>HTTP port</td><td className="mono">
                    {cam.http_port ?? <span className="dim">default</span>}</td></tr>
                  <tr><td>MAC</td><td className="mono">
                    {cam.mac || <span className="dim">not yet collected</span>}</td></tr>
                  {/* Device identity from hardwareDriverSettings (migration
                      025). Per hardware, so every camera on a multi-camera
                      device shows the same values — they are one device. */}
                  <tr><td>Vendor</td><td>{cam.vendor || "—"}</td></tr>
                  <tr><td>Model</td><td>{cam.model || "—"}</td></tr>
                  <tr><td>Firmware</td><td className="mono">{cam.firmware || "—"}</td></tr>
                  <tr><td>Serial</td><td className="mono">{cam.serial || "—"}</td></tr>
                  <tr><td>Recording server</td><td>{cam.recording_server || "—"}</td></tr>
                  <tr><td>Milestone group</td><td>
                    {cam.groups?.length
                      ? cam.groups.map((g) => g.name).join(", ")
                      : <span className="dim">none</span>}</td></tr>
                  <tr><td>State message</td><td className="dim">{cam.state_msg || "—"}</td></tr>
                </tbody>
              </table>
            </Card>
          )}

          {show("overview", "config") && (
            <UplinkCard cam={cam} meta={meta} sp={sp} />
          )}

          {show("live") && <LiveView cam={cam} url={url} />}

          {show("overview", "events") && <RecentEvents events={cam.events} />}

          {show("config") && cam.siblings?.length > 0 && (
            <Card title="Other cameras on this device"
                  kicker={`${cam.siblings.length} sibling(s)`} source="milestone">
              {/* 61 hardware records here carry more than one camera, up to
                  eleven on one AXIS M3007. They share a network interface, so a
                  fault on one is a fault on all — worth seeing before anyone
                  power-cycles a port on the strength of one camera. */}
              <table className="grid">
                <thead><tr><th>Camera</th><th>Recording</th></tr></thead>
                <tbody>
                  {cam.siblings.map((sib) => (
                    <tr key={sib.device_id}>
                      <td><a href={`#/cameras/${sib.device_id}`}>{sib.name}</a></td>
                      <td><span className={"rec-pill" + (sib.recording_state === "up" ? "" : " off")}>
                        {sib.recording_state || "unknown"}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

// ZCD's Device Health card. Four rings there; four probe cells here, because
// what NetMon knows per camera is categorical — which probe says what — and a
// dial cannot express "Milestone cannot reach it but the network can", the
// distinction that decides what to do about it (spec 19 §13).
export function DeviceHealth({ cam, st, tier, blind }) {
  const s = STATUS[tier] || STATUS.unknown;
  return (
    <Card title="Device health" source="netmon"
          kicker="one cell per probe — not one collapsed verdict" tight>
      <div className="stat-grid cols-4">
        <StatCell label="Reachability"
                  value={blind ? "blind" : (tier || "unknown")}
                  sub={blind ? "Milestone has no verdict" : s.hint}
                  severity={blind ? "warn" : s.tone === "ok" ? "ok"
                            : s.tone === "err" ? "crit" : s.tone === "warn" ? "warn" : undefined} />
        <StatCell label="Milestone" source="milestone-ess"
                  value={st.source_status?.value || "—"}
                  sub={st.source_status
                    ? `${st.source_status.source || "?"} · ${ageOf(st.source_status.updated_at) || "?"} old`
                    : "no reading"}
                  severity={st.source_status?.value === "up" ? "ok"
                            : st.source_status?.value === "down" ? "crit" : "warn"} />
        <StatCell label="ICMP" source="poller"
                  value={st.ping?.value || "—"}
                  sub={st.ping ? `${ageOf(st.ping.updated_at) || "?"} old` : "not swept"}
                  severity={st.ping?.value === "up" ? "ok"
                            : st.ping?.value === "down" ? "warn" : undefined} />
        <StatCell label="Recording" source="milestone"
                  value={st.recording?.value || "—"}
                  sub="motion-triggered — stopped is normal" />
      </div>
      {/* Named rather than left as four empty dials, which is what ZCD's card
          actually renders on this estate. */}
      <div className="msg" style={{ fontSize: 11, margin: "10px 14px 14px" }}>
        CPU, memory, temperature and packet loss come from the camera itself and
        need direct SNMP (spec 13, not enabled). The ICMP sweep records
        reachability without timing, so there is no latency figure to show.
      </div>
    </Card>
  );
}

// ZCD's "Live Telemetry · 24h" slot. Sparklines there, a transition strip here:
// `state_events` is per-device and real, where per-camera series would need
// 2,662 of them in a ring buffer kept deliberately low-cardinality (D3).
export function ReachabilityStrip({ events }) {
  const rows = (events || []).filter((e) => e.dimension === "reachability"
                                         || e.dimension === "source_status"
                                         || e.dimension === "ping");
  const since = Date.now() - 24 * 3600 * 1000;
  const day = rows.filter((e) => {
    const t = Date.parse(e.occurred_at);
    return Number.isFinite(t) && t >= since;
  });
  return (
    <Card title="Reachability · 24h" source="netmon"
          kicker={day.length ? `${day.length} change(s)` : "no changes"}>
      {day.length === 0 ? (
        <div className="msg">
          No probe changed its verdict in the last 24 hours
          {rows.length > 0 && ` (last change ${ageOf(rows[0].occurred_at) || "?"} ago)`}.
          {" "}A steady camera produces no transitions, which is the intended
          quiet — this is a change log, not a sampled series.
        </div>
      ) : (
        <div className="tl-strip">
          {day.map((e, i) => (
            <div key={i} className="tl-item" title={`${e.dimension}: ${e.old_value || "—"} → ${e.new_value || "—"}`}>
              <span className="tl-dot" style={{ background: sevColor(e.severity || "unknown") }} />
              <span className="tl-when">{ageOf(e.occurred_at) || "?"} ago</span>
              <span className="tl-what">
                <span className="dim">{e.dimension}</span>{" "}
                {e.old_value || "—"} → <b>{e.new_value || "—"}</b>
              </span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// ZCD's Active Issue card, with the engine's real lifecycle behind it: ZCD's
// Acknowledge button is inert, and NetMon's alerts carry ack and suppress.
export function ActiveIssue({ alerts }) {
  const [busy, setBusy] = React.useState(null);
  const [done, setDone] = React.useState({});
  const worst = alerts.some((a) => a.severity === "crit") ? "crit" : "warn";

  const act = async (id, what) => {
    setBusy(`${id}:${what}`);
    try {
      await postJSON(`/api/alerts/${id}/${what}`);
      setDone((d) => ({ ...d, [`${id}:${what}`]: "done" }));
    } catch (e) {
      setDone((d) => ({ ...d, [`${id}:${what}`]: String(e?.message || e) }));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card title="Active issue" source="netmon"
          kicker={`${alerts.length} open alert(s)`}
          link={{ href: "#/problems", label: "Problems console" }} tight>
      <div style={{ borderLeft: `3px solid ${sevColor(worst)}` }}>
        {alerts.map((a) => {
          const ackKey = `${a.id}:ack`;
          const supKey = `${a.id}:suppress`;
          return (
            <div key={a.id} className="alarm-row">
              <div className="ts">{ageOf(a.opened_at) || "?"} ago</div>
              <SevText severity={a.severity} />
              <div><Dot severity={a.severity} /></div>
              <div className="obj">{a.rule_name}</div>
              <div className="msg">
                {a.acked_by
                  ? <span className="dim">acknowledged by {a.acked_by}</span>
                  : <span className="dim">unacknowledged</span>}
                {done[ackKey] && <span className="dim"> · {done[ackKey]}</span>}
                {done[supKey] && <span className="dim"> · suppressed: {done[supKey]}</span>}
              </div>
              <div style={{ display: "flex", gap: 4 }}>
                {!a.acked_by && (
                  <button type="button" className="btn btn-sm"
                          disabled={busy === ackKey || done[ackKey] === "done"}
                          onClick={() => act(a.id, "ack")}>
                    {done[ackKey] === "done" ? "Acked" : busy === ackKey ? "…" : "Ack"}
                  </button>
                )}
                <button type="button" className="btn btn-sm"
                        disabled={busy === supKey || done[supKey] === "done"}
                        title="mute this device for an hour (creates a maintenance window)"
                        onClick={() => act(a.id, "suppress")}>
                  {done[supKey] === "done" ? "Suppressed" : busy === supKey ? "…" : "Suppress 1h"}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// ZCD's Live View card. Its still comes from the snapshot proxy; ours says why
// there is no still and offers the click-out that works.
export function LiveView({ cam, url }) {
  return (
    <Card title="Live view" source="milestone"
          link={url ? { href: url, label: "Open live view", external: true } : null}>
      <CameraPreview cam={cam} url={url} />
      <div className="msg" style={{ fontSize: 12, marginTop: 10 }}>
        {url
          ? <>The camera's own player opens in a new tab and will prompt for its
              login. Stills inside NetMon need the snapshot proxy, which streams
              them through the server so the camera credential never reaches the
              browser — not enabled yet.</>
          : <>No address is registered for this camera, so there is nothing to
              open. Use the Milestone Smart Client to view it.</>}
      </div>
    </Card>
  );
}

// ZCD's "PacketFence &amp; Uplink" — one card with the switch, the port, the PF
// node, and the four operator actions. NetMon's version resolves the port from
// its own FDB sweep rather than from PF alone, and cross-checks the two.
export function UplinkCard({ cam, meta, sp }) {
  const pf = cam.pf;
  const mac = cam.mac || pf?.mac;
  return (
    <Card title="PacketFence &amp; uplink" source="snmp"
          kicker={sp ? `${sp.candidates} FDB candidate(s)` : "port not resolved"}>
      {!sp ? (
        <div className="msg">
          {cam.ip
            ? "No switch has learned this camera's MAC. The MAC comes from Milestone where the identity backfill has reached the device, and from PacketFence's IP→MAC record otherwise; a camera on a switch NetMon does not sweep has no FDB row either way."
            : "No address, so no way to resolve a port."}
        </div>
      ) : (
        <table className="grid kv">
          <tbody>
            <tr><td>Switch</td><td>
              <a href={`#/switches/${sp.switch_device_id}`}>{sp.switch_name}</a>
              {sp.switch_site && <span className="dim"> · {sp.switch_site}</span>}
            </td></tr>
            <tr><td>Port</td><td className="mono">{sp.port || `ifIndex ${sp.ifindex}`}</td></tr>
            <tr><td>Link</td><td className="mono dim">
              {sp.oper_state || "—"}{sp.speed_mbps ? ` · ${sp.speed_mbps} Mbps` : ""}
              {sp.is_sfp === 1 ? " · SFP/fiber" : ""}</td></tr>
            <tr><td>PoE</td><td className="mono">
              {sp.poe_delivering === 1
                ? <span style={{ color: sevColor("ok") }}>
                    delivering{sp.poe_watts ? ` · ${sp.poe_watts} W` : ""}</span>
                : <span className="dim">not delivering</span>}</td></tr>
            <tr><td>MACs on port</td><td className="mono">{sp.macs_on_port}</td></tr>
            <tr><td>PacketFence</td><td className="mono">
              {sp.pf_agrees === true
                ? <span style={{ color: sevColor("ok") }}>agrees ({sp.pf_port})</span>
                : sp.pf_agrees === false
                ? <span style={{ color: sevColor("warn") }}>disagrees — PF saw {sp.pf_port}</span>
                : <span className="dim">no PF port recorded</span>}</td></tr>
          </tbody>
        </table>
      )}

      {pf && (
        <table className="grid kv" style={{ marginTop: 10 }}>
          <tbody>
            <tr><td>PF node</td><td className="mono">{pf.mac}</td></tr>
            <tr><td>Computer name</td><td>{pf.computername || "—"}</td></tr>
            <tr><td>Role</td><td>{pf.role || "—"}</td></tr>
            <tr><td>Registration</td><td>{pf.reg_status || "—"}</td></tr>
            <tr><td>VLAN</td><td className="mono dim">{pf.vlan || "—"}</td></tr>
            <tr><td>Last switch / port</td><td className="mono dim">
              {pf.last_switch || "—"}{pf.last_port ? ` · ${pf.last_port}` : ""}</td></tr>
            <tr><td>Online</td><td>{pf.online === 1 ? "yes" : pf.online === 0 ? "no" : "—"}</td></tr>
          </tbody>
        </table>
      )}

      {sp && (
        <div className={"msg" + (sp.poe_cycle_safe ? "" : " error")}
             style={{ fontSize: 11, marginTop: 10 }}>
          {sp.poe_cycle_safe
            ? `Access port confirmed: ${sp.why}.`
            : `Cycle PoE unavailable: ${sp.why}. Bouncing an unconfirmed port risks power-cycling an uplink.`}
        </div>
      )}

      {/* ZCD's four buttons, in its order. All four act through NetMon's
          audited chokepoint; each self-hides when its target is unknown rather
          than offering a call the source would reject. */}
      <div className="pf-actions" style={{ marginTop: 10 }}>
        {meta?.packetfence_url && mac ? (
          <a className="btn btn-sm"
             href={`${meta.packetfence_url}/admin/#/node/${encodeURIComponent(mac)}`}
             target="_blank" rel="noopener noreferrer">View in PacketFence ↗</a>
        ) : (
          <span className="btn btn-sm" style={{ opacity: 0.5 }}
                title={mac ? "set [web] packetfence_url to enable the deep-link"
                           : "no MAC known for this camera"}>View in PacketFence</span>
        )}
        {/* PacketFence acts on a node it has seen; without a PF record the call
            would be rejected, so the buttons appear only when it has one. */}
        {pf?.mac && (
          <ActionButton actionKey="reevaluate_access" path="reevaluate-access"
                        body={{ mac: pf.mac, device_id: sp?.switch_device_id }} compact />
        )}
        {pf?.mac && (
          <ActionButton actionKey="restart_port" path="restart-port"
                        body={{ mac: pf.mac, device_id: sp?.switch_device_id }} compact />
        )}
        {sp?.poe_cycle_safe && (
          <ActionButton actionKey="poe_cycle" path="poe-cycle"
                        body={{ device_id: sp.switch_device_id, port: sp.port }}
                        label={`Cycle PoE (${sp.port})`} compact />
        )}
      </div>
    </Card>
  );
}

// ZCD's Recent Events. Its source is Zabbix problems; NetMon's is the
// transition log, which is finer-grained — it records the change, not just the
// alert that a rule eventually raised from it.
export function RecentEvents({ events }) {
  const rows = events || [];
  return (
    <Card title="Recent events" source="netmon"
          kicker={rows.length ? `last ${rows.length} transition(s)` : "none recorded"}
          link={{ href: "#/events", label: "Events console" }} tight>
      {rows.length === 0 ? (
        <div className="msg" style={{ padding: 14 }}>
          No state transitions recorded for this camera. Every change of verdict
          appends here, so an empty list means nothing has changed since the
          device was registered.
        </div>
      ) : (
        <table className="grid nvr-tbl">
          <thead><tr><th>When</th><th>Severity</th><th>Dimension</th>
                     <th>Change</th><th>Source</th></tr></thead>
          <tbody>
            {rows.map((e, i) => (
              <tr key={i} className={e.severity === "crit" ? "row-err"
                                     : e.severity === "warn" ? "row-warn" : ""}>
                <td className="mono dim">{ageOf(e.occurred_at) || "?"} ago</td>
                <td><SevText severity={e.severity} /></td>
                <td className="dim">{e.dimension}</td>
                <td className="mono">
                  {e.old_value || "—"} → <b>{e.new_value || "—"}</b>
                </td>
                <td className="dim"><SourceBadge source={e.source} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
