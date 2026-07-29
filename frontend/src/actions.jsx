import React from "react";
import { getJSON, postJSON } from "./api.js";

// Operator write actions (spec 11 D4). The only place the UI causes NetMon to
// call a source non-GET, so the component is deliberately opinionated:
//
//  * capabilities come from GET /api/actions — the button never guesses whether
//    an action is available, and can say WHY it isn't;
//  * anything marked `disruptive` requires an explicit confirm showing the
//    plain-language effect, because "Cycle PoE" does not tell an operator that
//    the phone on that port is about to reboot;
//  * the result is shown inline and left on screen. A timed-out action is
//    reported as unknown rather than assumed failed — NetMon does not retry,
//    since the call may well have landed.

let _capsCache = null;
let _capsPromise = null;

export function useActionCaps() {
  const [caps, setCaps] = React.useState(_capsCache);
  React.useEffect(() => {
    if (_capsCache) return;
    if (!_capsPromise) _capsPromise = getJSON("/api/actions").catch(() => null);
    let live = true;
    _capsPromise.then((c) => {
      if (c) _capsCache = c;
      if (live) setCaps(c);
    });
    return () => { live = false; };
  }, []);
  return caps;
}

function capFor(caps, key) {
  return (caps?.actions || []).find((a) => a.key === key) || null;
}

/**
 * <ActionButton actionKey="poe_cycle" body={{device_id, port}} label="Cycle PoE" />
 *
 * `body` is sent as-is to /api/actions/<path>. It must contain ids the server
 * can resolve — never a URL or host; the server refuses anything else.
 */
export function ActionButton({ actionKey, path, body, label, compact, onDone }) {
  const caps = useActionCaps();
  const cap = capFor(caps, actionKey);
  const [state, setState] = React.useState("idle");   // idle|confirm|running|done|error
  const [result, setResult] = React.useState(null);

  if (caps === null) return null;                     // capabilities unknown yet
  if (!cap) return null;                              // server doesn't offer it

  const text = label || cap.label;

  if (!cap.enabled) {
    // Present but unavailable, with the reason — more useful than hiding it,
    // and it stops "why is there no button?" tickets.
    return (
      <button type="button" className="btn btn-sm" disabled
              title={cap.reason || "not enabled"}>
        {text}
      </button>
    );
  }

  const run = () => {
    setState("running"); setResult(null);
    postJSON(`/api/actions/${path}`, body)
      .then((r) => {
        setState("done");
        setResult({ ok: true, message: r?.message || "accepted", target: r?.target });
        if (onDone) onDone(r);
      })
      .catch((e) => {
        setState("error");
        // A refusal (409) carries an operator-facing reason; a 502 means the
        // source rejected or never answered — and in that case the action may
        // still have happened, which the operator must be told.
        const status = e?.status;
        const detail = e?.detail || e?.message || String(e);
        setResult({
          ok: false,
          message: detail,
          uncertain: status === 502 || status === 504 || !status,
        });
      });
  };

  return (
    <span className="act-wrap">
      {state === "confirm" ? (
        <span className="act-confirm">
          <span className="act-effect">{cap.effect}</span>
          <button type="button" className="btn btn-sm btn-danger" onClick={run}>
            Yes, {text.toLowerCase()}
          </button>
          <button type="button" className="btn btn-sm" onClick={() => setState("idle")}>
            Cancel
          </button>
        </span>
      ) : (
        <button type="button"
                className={"btn btn-sm" + (cap.disruptive ? " btn-warn" : "")}
                disabled={state === "running"}
                title={cap.effect}
                onClick={() => (cap.disruptive ? setState("confirm") : run())}>
          {state === "running" ? "Working…" : text}
        </button>
      )}
      {result && (
        <span className={"act-result " + (result.ok ? "ok" : result.uncertain ? "warn" : "err")}>
          {result.ok
            ? `✓ ${result.message}`
            : result.uncertain
              ? `? ${result.message} — the action may still have been carried out; re-check before retrying`
              : `✗ ${result.message}`}
        </span>
      )}
      {!compact && cap.disruptive && state === "idle" && !result && (
        <span className="act-hint dim">audited</span>
      )}
    </span>
  );
}

/** Recent attempts for one device — the audit trail, shown where it's relevant. */
export function ActionAudit({ deviceId, limit = 10 }) {
  const [rows, setRows] = React.useState(null);
  React.useEffect(() => {
    const q = deviceId ? `?device_id=${deviceId}&limit=${limit}` : `?limit=${limit}`;
    getJSON(`/api/actions/audit${q}`).then(setRows).catch(() => setRows([]));
  }, [deviceId, limit]);
  if (!rows || rows.length === 0) return null;
  return (
    <table className="grid">
      <thead><tr><th>When</th><th>Action</th><th>Target</th><th>By</th><th>Outcome</th><th>Detail</th></tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <td className="mono dim">{String(r.requested_at || "").replace("T", " ").slice(0, 19)}</td>
            <td>{r.action}</td>
            <td className="mono dim">{r.target || "—"}</td>
            <td className="dim">{r.actor}</td>
            <td className={"act-outcome " + r.outcome}>{r.outcome}</td>
            <td className="dim">{r.message || "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
