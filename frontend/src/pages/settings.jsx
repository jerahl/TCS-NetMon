// Settings — admin configuration overlay (docs/spec/12-settings-engine.md).
//
// Effective value = DB override → netmon.conf → default; every override is
// individually revertible ("Reset to file"). Secrets are WRITE-ONLY: the API
// never returns them, so the inputs here only ever send a new value.
// Editing is server-gated by [security] allow_web_edit; this page renders
// read-only (with an explanatory banner) when the flag is off.

import React from "react";
import { getJSON, postJSON, putJSON, deleteJSON } from "../api.js";
import { Card, Loading, ErrorMsg } from "../primitives.jsx";

function SourceTag({ s }) {
  if (s.error) return <span className="set-tag set-tag-err" title={s.error}>error</span>;
  if (s.source === "override") return <span className="set-tag set-tag-ovr">override</span>;
  if (s.source === "file") return <span className="set-tag">file</span>;
  return <span className="set-tag set-tag-dim">default</span>;
}

// One setting row. `disabled` = read-only mode (allow_web_edit off).
function Row({ s, disabled, onSaved, onError }) {
  const [draft, setDraft] = React.useState(null); // null = clean
  const [busy, setBusy] = React.useState(false);
  const dirty = draft !== null;

  const save = (value) => {
    setBusy(true);
    putJSON(`/api/settings/${s.key}`, { value })
      .then((updated) => { setDraft(null); onSaved(updated); })
      .catch((e) => onError(`${s.key}: ${e.message}`))
      .finally(() => setBusy(false));
  };
  const reset = () => {
    setBusy(true);
    deleteJSON(`/api/settings/${s.key}`)
      .then(() => { setDraft(null); onSaved(null, s.key); })
      .catch((e) => onError(`${s.key}: ${e.message}`))
      .finally(() => setBusy(false));
  };

  let input;
  if (s.secret) {
    input = (
      <span className="set-input-wrap">
        <input
          type="password"
          placeholder={s.is_set ? "•••••• (set — hidden)" : "(not set)"}
          value={draft ?? ""}
          autoComplete="new-password"
          disabled={disabled || busy}
          onChange={(e) => setDraft(e.target.value)}
        />
        {dirty && (
          <>
            <button className="btn" disabled={busy || !draft} onClick={() => save(draft)}>
              {s.is_set ? "Replace" : "Set"}
            </button>
            <button className="btn" disabled={busy} onClick={() => setDraft(null)}>Discard</button>
          </>
        )}
      </span>
    );
  } else if (s.kind === "bool") {
    input = (
      <select
        value={String(draft ?? s.value)}
        disabled={disabled || busy}
        onChange={(e) => save(e.target.value === "true")}
      >
        <option value="true">on</option>
        <option value="false">off</option>
      </select>
    );
  } else {
    input = (
      <span className="set-input-wrap">
        <input
          type={s.kind === "int" ? "number" : "text"}
          min={s.min ?? undefined}
          max={s.max ?? undefined}
          value={draft ?? (s.value ?? "")}
          disabled={disabled || busy}
          onChange={(e) => setDraft(e.target.value)}
        />
        {dirty && (
          <>
            <button className="btn" disabled={busy}
                    onClick={() => save(s.kind === "int" ? Number(draft) : draft)}>
              Save
            </button>
            <button className="btn" disabled={busy} onClick={() => setDraft(null)}>Discard</button>
          </>
        )}
      </span>
    );
  }

  return (
    <tr className={dirty ? "set-row-dirty" : ""}>
      <td>
        <div>{s.label}</div>
        <div className="dim set-key mono">{s.key}{s.restart ? " · needs service restart" : ""}</div>
        {s.description && <div className="dim set-desc">{s.description}</div>}
      </td>
      <td className="set-cell-input">{input}</td>
      <td>
        <SourceTag s={s} />
        {s.source === "override" && !disabled && (
          <button className="btn set-reset" disabled={busy} onClick={reset}
                  title="Remove the override; the netmon.conf / default value takes effect again.">
            Reset to file
          </button>
        )}
      </td>
    </tr>
  );
}

export function SettingsPage() {
  const [data, setData] = React.useState(null);
  const [audit, setAudit] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [notice, setNotice] = React.useState(null);
  const [applying, setApplying] = React.useState(false);

  const load = React.useCallback(() => {
    getJSON("/api/settings").then(setData).catch(setError);
    getJSON("/api/settings/audit?limit=50").then(setAudit).catch(() => setAudit([]));
  }, []);
  React.useEffect(load, [load]);

  if (error) return <div className="page"><ErrorMsg error={error} /></div>;
  if (!data) return <div className="page"><Loading what="settings" /></div>;

  const disabled = !data.edit_enabled;

  // A row saved (updated entry) or cleared (null + key) — refetch groups so
  // provenance/effective values stay honest, and refresh the audit trail.
  const onSaved = () => { setNotice(null); load(); };
  const onError = (msg) => setNotice({ kind: "err", text: msg });

  const apply = () => {
    setApplying(true);
    setNotice(null);
    postJSON("/api/settings/apply")
      .then((r) => {
        const restart = r.restart_required?.length
          ? ` Still needing a service restart: ${r.restart_required.join(", ")}.`
          : "";
        setNotice({ kind: "ok", text: `Applied — collectors restarted (${r.tasks.length} task(s)).${restart}` });
      })
      .catch((e) => setNotice({ kind: "err", text: `apply: ${e.message}` }))
      .finally(() => setApplying(false));
  };

  return (
    <div className="page">
      <h2>Settings</h2>
      <div className="subtitle">
        Overrides stored in NetMon's database on top of netmon.conf. Secrets are
        write-only — they can be replaced here but never viewed.
      </div>

      {disabled && (
        <div className="set-banner">
          Read-only: web editing is disabled. Set <span className="mono">[security] allow_web_edit = true</span>{" "}
          in /etc/netmon/netmon.conf to enable it.
        </div>
      )}
      {!disabled && !data.secrets_enabled && (
        <div className="set-banner">
          Secrets can't be stored yet: add a <span className="mono">[security] settings_key</span>{" "}
          to netmon.conf (see netmon.conf.example). Non-secret settings work.
        </div>
      )}

      {!disabled && (
        <div className="set-applybar">
          <button className="btn" disabled={applying} onClick={apply}>
            {applying ? "Applying…" : "Apply changes"}
          </button>
          <span className="dim">
            Saved changes take effect on the next service restart — or now, by
            restarting the collector tasks in place.
          </span>
        </div>
      )}
      {notice && <div className={"set-banner " + (notice.kind === "ok" ? "set-banner-ok" : "set-banner-err")}>{notice.text}</div>}

      {data.groups.map((g) => (
        <Card title={g.label} key={g.section}>
          <table className="grid set-grid">
            <tbody>
              {g.settings.map((s) => (
                <Row key={s.key} s={s} disabled={disabled} onSaved={onSaved} onError={onError} />
              ))}
            </tbody>
          </table>
        </Card>
      ))}

      <Card title="Change history" kicker="settings_audit — secret values are never recorded">
        {!audit ? <Loading what="audit trail" /> : audit.length === 0 ? (
          <div className="msg">No settings changes yet.</div>
        ) : (
          <table className="grid">
            <thead>
              <tr><th>When</th><th>Setting</th><th>Action</th><th>Change</th><th>By</th></tr>
            </thead>
            <tbody>
              {audit.map((a) => (
                <tr key={a.id}>
                  <td className="mono dim">{a.changed_at || "—"}</td>
                  <td className="mono">{a.key}</td>
                  <td>{a.action}</td>
                  <td className="mono">
                    {a.old_value === null && a.new_value === null
                      ? <span className="dim">(secret — redacted)</span>
                      : <>{a.old_value ?? "—"} <span className="dim">→</span> {a.new_value ?? "—"}</>}
                  </td>
                  <td>{a.changed_by}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
