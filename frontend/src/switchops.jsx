import React from "react";
import { getJSON, postJSON } from "./api.js";

// Direct SNMP switch operations (spec 26): Cycle PoE / Bounce port over SNMP,
// and the live port view. Same opinions as actions.jsx — capabilities come from
// the server, refusals carry their reason, disruptive actions confirm with the
// plain-language effect — plus two of its own:
//
//  * DRY RUN is shown on the button and in the confirm, so nobody believes a
//    port was cycled when only a command was logged;
//  * the server's refusal rules are fetched per port (/check) so a refused
//    uplink shows WHY, and an admin can type the port name to override.

let _caps = null;
let _capsP = null;

export function useSwitchOpsCaps() {
  const [caps, setCaps] = React.useState(_caps);
  React.useEffect(() => {
    if (_caps) return;
    if (!_capsP) _capsP = getJSON("/api/switch-ops").catch(() => null);
    let live = true;
    _capsP.then((c) => { if (c) _caps = c; if (live) setCaps(c); });
    return () => { live = false; };
  }, []);
  return caps;
}

const EFFECT = {
  snmp_poe_cycle: "Resets PoE on this port over SNMP — anything powered by it loses power and reboots.",
  snmp_port_bounce: "Sets this port administratively down, waits, and brings it back up — the device on it loses link.",
};

export function SwitchOpButton({ switchId, ifindex, portName, action, label }) {
  const caps = useSwitchOpsCaps();
  const [check, setCheck] = React.useState(null);
  const [state, setState] = React.useState("idle");     // idle|confirm|running|done|error
  const [result, setResult] = React.useState(null);
  const [downS, setDownS] = React.useState(null);
  const [override, setOverride] = React.useState("");

  const loadCheck = React.useCallback(() => {
    getJSON(`/api/switch-ops/check/${switchId}/${ifindex}?action=${action}`)
      .then(setCheck).catch(() => setCheck(null));
  }, [switchId, ifindex, action]);
  React.useEffect(() => { setResult(null); setState("idle"); setOverride(""); loadCheck(); },
                  [loadCheck]);

  if (!caps || !caps.enabled) return null;
  const enabled = caps.actions?.[action];
  const dry = caps.dry_run;
  const text = (label || action) + (dry ? " (dry run)" : "");
  if (!enabled) {
    return <button type="button" className="btn btn-sm" disabled title={caps.reason || "disabled"}>{text}</button>;
  }
  const isAdmin = caps.your_role === "admin";
  const refused = check && !check.allowed;
  const canOverride = refused && check.overridable && isAdmin;
  if (refused && !canOverride) {
    return (
      <button type="button" className="btn btn-sm" disabled
              title={(check.reasons || []).join("; ")}>{text}</button>
    );
  }

  const run = () => {
    setState("running"); setResult(null);
    const body = { device_id: switchId, ports: [portName] };
    if (action === "snmp_port_bounce" && downS) body.down_s = Number(downS);
    if (canOverride) body.override_confirm = override;
    const path = action === "snmp_poe_cycle" ? "poe-cycle" : "port-bounce";
    postJSON(`/api/switch-ops/${path}`, body)
      .then((r) => {
        const res = r?.results?.[0] || {};
        setState(res.ok ? "done" : "error");
        setResult({ ok: !!res.ok, message: res.message || "accepted", uncertain: !res.ok });
        loadCheck();
      })
      .catch((e) => {
        setState("error");
        setResult({ ok: false, message: e?.detail || e?.message || String(e),
                    uncertain: e?.status === 502 || !e?.status });
      });
  };

  return (
    <span className="act-wrap">
      {state === "confirm" ? (
        <span className="act-confirm">
          <span className="act-effect">
            {dry ? "DRY RUN — NetMon will log the exact SNMP commands and send nothing. " : ""}
            {EFFECT[action]}
            {refused ? ` Refused because: ${(check.reasons || []).join("; ")}.` : ""}
          </span>
          {action === "snmp_port_bounce" && (
            <label className="dim" style={{ fontSize: 11 }}>
              down for{" "}
              <input type="number" min="1" max={caps.bounce_max_s} style={{ width: 48 }}
                     placeholder={String(caps.bounce_down_s)} value={downS ?? ""}
                     onChange={(e) => setDownS(e.target.value || null)} />s
            </label>
          )}
          {canOverride && (
            <label className="dim" style={{ fontSize: 11 }}>
              admin override — type <b className="mono">{portName}</b>:{" "}
              <input className="mono" style={{ width: 64 }} value={override}
                     onChange={(e) => setOverride(e.target.value)} />
            </label>
          )}
          <button type="button" className="btn btn-sm btn-danger" onClick={run}
                  disabled={canOverride && override.trim() !== portName}>
            Yes, {(label || action).toLowerCase()}
          </button>
          <button type="button" className="btn btn-sm" onClick={() => setState("idle")}>Cancel</button>
        </span>
      ) : (
        <button type="button" className="btn btn-sm btn-warn" disabled={state === "running"}
                title={refused ? `Refused (admin may override): ${(check.reasons || []).join("; ")}` : EFFECT[action]}
                onClick={() => setState("confirm")}>
          {state === "running" ? "Working…" : (refused ? "⚠ " : "") + text}
        </button>
      )}
      {result && (
        <span className={"act-result " + (result.ok ? "ok" : result.uncertain ? "warn" : "err")}>
          {result.ok ? `✓ ${result.message}` : `✗ ${result.message}`}
        </span>
      )}
    </span>
  );
}

function fmtKbps(k) {
  if (k === null || k === undefined) return "—";
  if (k >= 1e6) return `${(k / 1e6).toFixed(2)} Gbps`;
  if (k >= 1e3) return `${(k / 1e3).toFixed(1)} Mbps`;
  return `${k.toFixed(1)} kbps`;
}

/** Live port view: polls only while switched on and mounted. */
export function LivePort({ switchId, ifindex }) {
  const caps = useSwitchOpsCaps();
  const [on, setOn] = React.useState(false);
  const [data, setData] = React.useState(null);
  const [err, setErr] = React.useState(null);

  React.useEffect(() => { setOn(false); setData(null); setErr(null); }, [switchId, ifindex]);
  React.useEffect(() => {
    if (!on) return undefined;
    let live = true;
    const tick = () => getJSON(`/api/switch-ops/live/${switchId}/${ifindex}`)
      .then((d) => { if (live) { setData(d); setErr(null); } })
      .catch((e) => { if (live) setErr(e?.detail || e?.message || String(e)); });
    tick();
    const id = setInterval(tick, 1000 * (caps?.live_interval_s || 5));
    return () => { live = false; clearInterval(id); };
  }, [on, switchId, ifindex, caps?.live_interval_s]);

  if (!caps || !caps.live_port) return null;
  const s = data?.sample;
  const r = s?.rates;
  return (
    <div className="live-port" style={{ marginTop: 8 }}>
      <button type="button" className="btn btn-sm" onClick={() => setOn(!on)}>
        {on ? "■ Stop live view" : "▶ Live view"}
      </button>
      {on && (
        <span className="dim" style={{ fontSize: 11, marginLeft: 8 }}>
          polling the switch every {data?.interval_s ?? 5}s
          {data?.age_s !== null && data?.age_s !== undefined ? ` · sample ${data.age_s}s old` : ""}
          {data?.busy ? " · switch busy, showing last sample" : ""}
        </span>
      )}
      {on && err && <div className="msg error" style={{ fontSize: 11 }}>{err}</div>}
      {on && data?.error && <div className="msg error" style={{ fontSize: 11 }}>switch read failed: {data.error}</div>}
      {on && s && (
        <table className="grid" style={{ marginTop: 6 }}>
          <tbody>
            <tr><td>Link</td><td className="mono">{s.oper}{s.admin_up === false ? " (admin down)" : ""}
              {s.speed_mbps ? ` · ${s.speed_mbps} Mb/s` : ""}</td></tr>
            {s.poe && <tr><td>PoE</td><td className="mono">
              {s.poe.admin_on === false ? "admin off" : s.poe.detect || "—"}
              {s.poe.watts !== null ? ` · ${s.poe.watts} W` : ""}</td></tr>}
            <tr><td>In / out</td><td className="mono">{r ? `${fmtKbps(r.in_kbps)} / ${fmtKbps(r.out_kbps)}` : "measuring…"}</td></tr>
            <tr><td>Errors /s</td><td className="mono">{r ? `${r.in_errors_ps ?? "—"} in / ${r.out_errors_ps ?? "—"} out` : "—"}</td></tr>
            <tr><td>Discards /s</td><td className="mono">{r ? `${r.in_discards_ps ?? "—"} in / ${r.out_discards_ps ?? "—"} out` : "—"}</td></tr>
            <tr><td>MACs (live FDB{data.fdb?.age_s != null ? `, ${data.fdb.age_s}s old` : ""})</td>
              <td className="mono">{(data.fdb?.macs || []).length === 0 ? "none" :
                data.fdb.macs.map((m) => (
                  <div key={m.mac}>{m.mac}{m.computername ? ` · ${m.computername}` : ""}{m.owner ? ` · ${m.owner}` : ""}</div>
                ))}</td></tr>
          </tbody>
        </table>
      )}
    </div>
  );
}
