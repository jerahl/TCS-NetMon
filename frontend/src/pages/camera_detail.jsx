import React from "react";
import { getJSON } from "../api.js";
import { Card, Loading, ErrorMsg, sevColor } from "../primitives.jsx";
import { ActionButton } from "../actions.jsx";
import { ageOf } from "../format.js";

// Individual camera page (#/camera/:id) — the counterpart to AP Detail, and the
// page ZCD had at tcs.camera.view. ZCD's own is DEMO-bannered, so this borrows
// its layout and fills it with live data rather than porting its contents.
//
// The organising idea is the same as AP Detail: show which probe said what,
// rather than one collapsed verdict. A camera Milestone cannot reach but the
// network can is a different problem from one that is simply gone, and the page
// should make that visible without the operator having to know the vocabulary.

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

export function CameraDetailPage({ id, embedded = false }) {
  const [cam, setCam] = React.useState(null);
  const [meta, setMeta] = React.useState(null);
  const [error, setError] = React.useState(null);

  React.useEffect(() => {
    let live = true;
    getJSON("/api/meta").then((m) => live && setMeta(m)).catch(() => {});
    return () => { live = false; };
  }, []);

  React.useEffect(() => {
    let live = true;
    setCam(null);
    getJSON(`/api/surveillance/cameras/${id}`)
      .then((c) => live && setCam(c))
      .catch((e) => live && setError(e));
    return () => { live = false; };
  }, [id]);

  if (error) return <ErrorMsg error={error} />;
  if (!cam) return <Loading what={`camera ${id}`} />;
  return <CameraDetailView cam={cam} meta={meta} embedded={embedded} />;
}

// The render half, split from the fetching half so it can be rendered with
// fixed props. esbuild does not resolve identifiers, so a variable used outside
// its scope fails only in a browser — which is how "usedKnown is not defined"
// reached production on the Surveillance page. A component that only ever
// renders after a fetch cannot be checked that way.
export function CameraDetailView({ cam, meta, embedded = false }) {
  const st = cam.state || {};
  const blind = st.source_status?.value === "blind";
  const tier = st.reachability?.value;
  const s = STATUS[tier] || STATUS.unknown;
  const sp = cam.switch_port;

  return (
    <div className={embedded ? "" : "page"}>
      {!embedded && <a className="back" href="#/surveillance">← Back to cameras</a>}

      <div className="host-title">
        <h1>{cam.name}</h1>
        {cam.ip && <span className="ip">{cam.ip}{cam.http_port ? `:${cam.http_port}` : ""}</span>}
        {blind
          ? <span className="state-pill warn" title="Milestone has no state for this camera">Blind</span>
          : <span className={"state-pill " + s.tone} title={s.hint}>{s.label}</span>}
      </div>
      <div className="host-meta">
        <span className="pill"><span className="lbl">site</span><span className="v">{cam.site || "—"}</span></span>
        <span className="pill"><span className="lbl">model</span><span className="v">{cam.model || "—"}</span></span>
        {cam.recording_server && (
          <span className="pill"><span className="lbl">recorder</span><span className="v">{cam.recording_server}</span></span>
        )}
        <span className="pill"><span className="lbl">cache</span>
          <span className="v">{ageOf(cam.updated_at) || "?"} old</span></span>
      </div>

      {/* Each probe on its own cell, with the source named. One collapsed
          verdict cannot express "Milestone cannot see it but the network can",
          which is the distinction that decides what to do about it. */}
      <Card tight>
        <div className="stat-grid cols-4">
          <ProbeCell label="Reachability"
                     value={blind ? "blind" : (tier || "unknown")}
                     sub={blind ? "Milestone has no verdict" : s.hint}
                     tone={blind ? "warn" : s.tone} />
          <ProbeCell label="Milestone" value={st.source_status?.value || "—"}
                     sub={st.source_status?.source || "no reading"}
                     tone={st.source_status?.value === "up" ? "ok"
                           : st.source_status?.value === "down" ? "err" : "warn"} />
          <ProbeCell label="ICMP" value={st.ping?.value || "—"}
                     sub={st.ping ? `${ageOf(st.ping.updated_at) || "?"} old` : "not swept"}
                     tone={st.ping?.value === "up" ? "ok" : st.ping?.value === "down" ? "warn" : ""} />
          {/* Motion-triggered: "stopped" is the resting state, not a fault. */}
          <ProbeCell label="Recording" value={st.recording?.value || "—"}
                     sub="motion-triggered — stopped is normal" tone="" />
        </div>
      </Card>

      <div className="global-cols">
        <div className="global-col">
          <Card title="Camera">
            <table className="grid kv">
              <tbody>
                <tr><td>Model</td><td>{cam.model || "—"}</td></tr>
                <tr><td>Resolution</td><td className="mono">{cam.resolution || "—"}</td></tr>
                <tr><td>FPS target</td><td className="mono">{cam.fps_target ?? "—"}</td></tr>
                <tr><td>Codec</td><td className="mono">{cam.codec || "—"}</td></tr>
                <tr><td>Bitrate mode</td><td className="mono">{cam.bitrate_mode || "—"}</td></tr>
                <tr><td>Recording mode</td><td className="mono">{cam.recording_mode || "—"}</td></tr>
                <tr><td>IP</td><td className="mono">{cam.ip || "—"}</td></tr>
                {/* Six cameras on this estate sit on a non-default port, five of
                    them :443 over http — a snapshot fetch that assumes 80 misses
                    them entirely. */}
                <tr><td>HTTP port</td><td className="mono">{cam.http_port ?? <span className="dim">default</span>}</td></tr>
                <tr><td>Recording server</td><td>{cam.recording_server || "—"}</td></tr>
                <tr><td>State message</td><td className="dim">{cam.state_msg || "—"}</td></tr>
              </tbody>
            </table>
          </Card>

          {cam.siblings?.length > 0 && (
            <Card title="Other cameras on this device"
                  kicker={`${cam.siblings.length} sibling(s)`}>
              {/* 61 hardware records here carry more than one camera, up to
                  eleven on one AXIS M3007. They share a network interface, so a
                  fault on one is a fault on all — worth seeing before anyone
                  power-cycles a port on the strength of one camera. */}
              <table className="grid">
                <thead><tr><th>Camera</th><th>Recording</th></tr></thead>
                <tbody>
                  {cam.siblings.map((sib) => (
                    <tr key={sib.device_id}>
                      <td><a href={`#/camera/${sib.device_id}`}>{sib.name}</a></td>
                      <td><span className={"rec-pill" + (sib.recording_state === "up" ? "" : " off")}>
                        {sib.recording_state || "unknown"}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
        </div>

        <div className="global-col">
          <Card title="Uplink — switch port"
                kicker={sp ? `${sp.candidates} FDB candidate(s)` : "not resolved"}>
            {!sp ? (
              <div className="msg">
                {cam.ip
                  ? "No switch has learned this camera's MAC. Milestone exposes no camera MAC, so the port is resolved through PacketFence's IP→MAC record — which covers 1,532 of 2,651 cameras."
                  : "No address, so no way to resolve a port."}
              </div>
            ) : (
              <React.Fragment>
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
                <div className={"msg" + (sp.poe_cycle_safe ? "" : " error")} style={{ fontSize: 11 }}>
                  {sp.poe_cycle_safe
                    ? `Access port confirmed: ${sp.why}.`
                    : `Cycle PoE unavailable: ${sp.why}. Bouncing an unconfirmed port risks power-cycling an uplink.`}
                </div>
                {sp.poe_cycle_safe && (
                  <ActionButton actionKey="poe_cycle" path="poe-cycle"
                                body={{ device_id: sp.switch_device_id, port: sp.port }}
                                label={`Cycle PoE (${sp.switch_name} ${sp.port})`} />
                )}
              </React.Fragment>
            )}
          </Card>

          {cam.pf && (
            <Card title="PacketFence" kicker={`node cache · ${ageOf(cam.pf.updated_at) || "?"} old`}>
              <table className="grid kv">
                <tbody>
                  <tr><td>MAC</td><td className="mono">{cam.pf.mac}</td></tr>
                  <tr><td>Computer name</td><td>{cam.pf.computername || "—"}</td></tr>
                  <tr><td>Role</td><td>{cam.pf.role || "—"}</td></tr>
                  <tr><td>Registration</td><td>{cam.pf.reg_status || "—"}</td></tr>
                  <tr><td>VLAN</td><td className="mono dim">{cam.pf.vlan || "—"}</td></tr>
                  <tr><td>Last switch / port</td><td className="mono dim">
                    {cam.pf.last_switch || "—"}{cam.pf.last_port ? ` · ${cam.pf.last_port}` : ""}</td></tr>
                  <tr><td>Online</td><td>{cam.pf.online === 1 ? "yes" : cam.pf.online === 0 ? "no" : "—"}</td></tr>
                </tbody>
              </table>
              {meta?.packetfence_url && (
                <a className="btn btn-sm"
                   href={`${meta.packetfence_url}/admin/#/node/${encodeURIComponent(cam.pf.mac)}`}
                   target="_blank" rel="noopener noreferrer">View in PacketFence ↗</a>
              )}
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function ProbeCell({ label, value, sub, tone }) {
  const colour = tone === "ok" ? sevColor("ok") : tone === "err" ? sevColor("crit")
    : tone === "warn" ? sevColor("warn") : undefined;
  return (
    <div className="stat-cell">
      <span className="lbl">{label}</span>
      <span className="val" style={colour ? { color: colour } : undefined}>{value}</span>
      <span className="sub">{sub}</span>
    </div>
  );
}
