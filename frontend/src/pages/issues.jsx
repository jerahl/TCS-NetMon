import React from "react";
import { LinkedTickets } from "../helpdesk.jsx";
import { getJSON, postJSON, patchJSON, deleteJSON, putFile, qs } from "../api.js";
import { Card, Dot, Loading, ErrorMsg, SevText } from "../primitives.jsx";
import { ChangesForIssue, ComposeChange } from "./changes.jsx";

// Issues — human-authored problem records (docs/spec/24).
//
// The counterpart to Problems. Problems is the engine's open-fault list, which
// the engine opens and closes on its own; this is what a person found out,
// what they plan to do, and the evidence. An alert closes when the symptom
// stops — which is exactly when the finding becomes worth keeping.

const REFRESH_MS = 60000;

const STATUS_LABEL = {
  open: "Open",
  investigating: "Investigating",
  waiting: "Waiting on others",
  planned: "Fix planned",
  resolved: "Resolved",
  closed: "Closed",
};

// Status drives a colour independently of severity: a crit issue that is
// resolved should not still read as red in the list.
const STATUS_TONE = {
  open: "err", investigating: "warn", waiting: "warn",
  planned: "info", resolved: "ok", closed: "dim",
};

const CATEGORY_LABEL = {
  wireless: "Wireless", switching: "Switching", surveillance: "Surveillance",
  voip: "VoIP", nac: "NAC", facilities: "Facilities", other: "Other",
};

function fmtBytes(n) {
  if (!n && n !== 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// Timestamps arrive as naive UTC (the API writes them that way). Render them
// as local wall-clock, which is what "10:14 in room 204" means to a reader.
function fmtWhen(ts) {
  if (!ts) return "—";
  const d = new Date(ts.endsWith("Z") ? ts : ts.replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

function fmtAge(ts) {
  if (!ts) return "";
  const d = new Date(ts.endsWith("Z") ? ts : ts.replace(" ", "T") + "Z");
  const mins = Math.floor((Date.now() - d.getTime()) / 60000);
  if (Number.isNaN(mins)) return "";
  if (mins < 60) return `${Math.max(mins, 0)}m ago`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h ago`;
  return `${Math.floor(mins / 1440)}d ago`;
}

function StatusPill({ status }) {
  return (
    <span className={"isu-status isu-status-" + (STATUS_TONE[status] || "dim")}>
      {STATUS_LABEL[status] || status}
    </span>
  );
}

// ── attachments ─────────────────────────────────────────────────────────────

// One drop zone that takes dragged files, a file picker, AND a pasted
// clipboard image. The paste path is the one that matters: the reports this
// page exists for arrive as screenshots, and asking somebody to save a
// screenshot to disk before they can attach it loses half of them.
function DropZone({ onFiles, meta, busy, hint }) {
  const [over, setOver] = React.useState(false);
  const inputRef = React.useRef(null);

  React.useEffect(() => {
    const onPaste = (e) => {
      const items = [...(e.clipboardData?.items || [])];
      const files = items
        .filter((i) => i.kind === "file")
        .map((i) => i.getAsFile())
        .filter(Boolean)
        .map((f, n) => {
          // A pasted screenshot is usually called "image.png" or nothing at
          // all. Name it for when it was pasted so three of them in one issue
          // are still tellable apart.
          if (f.name && f.name !== "image.png") return f;
          const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
          const ext = (f.type.split("/")[1] || "png").replace("jpeg", "jpg");
          return new File([f], `pasted-${stamp}${n ? "-" + n : ""}.${ext}`,
                          { type: f.type });
        });
      if (files.length) { e.preventDefault(); onFiles(files); }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [onFiles]);

  return (
    <div
      className={"isu-drop" + (over ? " over" : "") + (busy ? " busy" : "")}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault(); setOver(false);
        const files = [...(e.dataTransfer?.files || [])];
        if (files.length) onFiles(files);
      }}
      onClick={() => inputRef.current?.click()}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") inputRef.current?.click(); }}
    >
      <input ref={inputRef} type="file" multiple hidden
             onChange={(e) => {
               const files = [...(e.target.files || [])];
               if (files.length) onFiles(files);
               e.target.value = "";
             }} />
      <div className="isu-drop-main">
        {busy ? "Uploading…" : (hint || "Drop files, paste a screenshot, or click to browse")}
      </div>
      {meta && (
        <div className="isu-drop-sub">
          up to {meta.max_attachment_mb} MB each ·{" "}
          {meta.accepted_extensions.slice(0, 8).map((e) => "." + e).join(" ")}
          {meta.accepted_extensions.length > 8 ? " …" : ""}
        </div>
      )}
    </div>
  );
}

function AttachmentTile({ a, canDelete, onDelete }) {
  return (
    <div className="isu-att">
      {a.is_image ? (
        <a href={a.url} target="_blank" rel="noopener noreferrer" className="isu-att-thumb">
          <img src={a.url} alt={a.filename} loading="lazy" />
        </a>
      ) : (
        <a href={a.url} target="_blank" rel="noopener noreferrer"
           className="isu-att-thumb isu-att-file">
          <span className="isu-att-ext">{(a.filename.split(".").pop() || "?").toUpperCase()}</span>
        </a>
      )}
      <div className="isu-att-meta">
        <a href={a.url} target="_blank" rel="noopener noreferrer"
           className="isu-att-name" title={a.filename}>{a.filename}</a>
        <div className="dim">{fmtBytes(a.size_bytes)} · {a.uploaded_by}</div>
      </div>
      {canDelete && (
        <button className="isu-att-x" title="Delete this attachment"
                onClick={() => onDelete(a)}>×</button>
      )}
    </div>
  );
}

// ── device picker ───────────────────────────────────────────────────────────

// Searches the registry through the existing ⌘K search endpoint rather than
// loading 2,600 devices into a <select>.
function DevicePicker({ value, onChange }) {
  const [q, setQ] = React.useState("");
  const [hits, setHits] = React.useState([]);
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    if (q.trim().length < 2) { setHits([]); return; }
    let live = true;
    const id = setTimeout(() => {
      getJSON("/api/search" + qs({ q: q.trim(), limit: 8 }))
        .then((r) => {
          if (!live) return;
          const rows = (r?.hits || r?.results || r || []).filter(
            (h) => h.device_id || h.id);
          setHits(rows.slice(0, 8));
        })
        .catch(() => { if (live) setHits([]); });
    }, 200);
    return () => { live = false; clearTimeout(id); };
  }, [q]);

  const add = (h) => {
    const id = h.device_id || h.id;
    if (!value.some((v) => v.device_id === id)) {
      onChange([...value, { device_id: id, name: h.name || h.title || `device ${id}` }]);
    }
    setQ(""); setHits([]); setOpen(false);
  };

  return (
    <div className="isu-devpick">
      <div className="isu-chips">
        {value.map((d) => (
          <span className="isu-chip" key={d.device_id}>
            {d.name}
            <button type="button" title="Remove"
                    onClick={() => onChange(value.filter((v) => v.device_id !== d.device_id))}>×</button>
          </span>
        ))}
      </div>
      <input
        type="text" value={q} placeholder="Search APs, switches, cameras…"
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
      />
      {open && hits.length > 0 && (
        <div className="isu-devpick-menu">
          {hits.map((h) => (
            <button type="button" key={h.device_id || h.id} onClick={() => add(h)}>
              <span>{h.name || h.title}</span>
              <span className="dim">{h.site || h.subtitle || ""}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── compose ─────────────────────────────────────────────────────────────────

function Compose({ meta, onDone, onCancel }) {
  const [form, setForm] = React.useState({
    title: "", body: "", severity: "warn", category: "wireless", site: "",
  });
  const [devices, setDevices] = React.useState([]);
  const [pending, setPending] = React.useState([]);   // files chosen before the issue exists
  const [sites, setSites] = React.useState([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);

  React.useEffect(() => {
    getJSON("/api/sites")
      .then((r) => setSites((r || []).map((s) => s.name).filter(Boolean).sort()))
      .catch(() => { /* free-text site still works */ });
  }, []);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    if (form.title.trim().length < 3) { setError(new Error("Give it a title first.")); return; }
    setBusy(true); setError(null);
    try {
      const created = await postJSON("/api/issues", {
        title: form.title.trim(),
        body: form.body,
        severity: form.severity,
        category: form.category,
        site: form.site || null,
        device_ids: devices.map((d) => d.device_id),
      });
      // Files chosen during compose upload after the issue exists — there is
      // no id to hang them off until then.
      for (const f of pending) {
        await putFile(`/api/issues/${created.id}/attachments/${encodeURIComponent(f.name)}`, f);
      }
      onDone(created.id);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Card title="New issue">
      <form className="isu-form" onSubmit={submit}>
        <label>
          <span>Title</span>
          <input type="text" value={form.title} onChange={set("title")} autoFocus
                 placeholder="What is wrong, in one line" maxLength={200} />
        </label>

        <div className="isu-form-row">
          <label>
            <span>Severity</span>
            <select value={form.severity} onChange={set("severity")}>
              {meta.severities.map((s) => (
                <option key={s} value={s}>
                  {s === "crit" ? "Critical" : s === "warn" ? "Warning" : "Info"}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Category</span>
            <select value={form.category} onChange={set("category")}>
              {meta.categories.map((c) => (
                <option key={c} value={c}>{CATEGORY_LABEL[c] || c}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Site</span>
            <input type="text" value={form.site} onChange={set("site")}
                   list="isu-sites" placeholder="School or location" />
            <datalist id="isu-sites">
              {sites.map((s) => <option key={s} value={s} />)}
            </datalist>
          </label>
        </div>

        <label>
          <span>What happened</span>
          {/* The placeholder is the ask, not decoration: exact time, room,
              asset tag and what the user saw are the four things an
              investigation needs and almost never gets. */}
          <textarea rows={8} value={form.body} onChange={set("body")}
                    placeholder={"Exact time, room, device asset tag, and what the user saw.\n\nWhat has been checked so far, and what you think is going on."} />
        </label>

        <label>
          <span>Affected devices</span>
          <DevicePicker value={devices} onChange={setDevices} />
        </label>

        <label>
          <span>Evidence</span>
          <DropZone meta={meta} onFiles={(f) => setPending((p) => [...p, ...f])} />
          {pending.length > 0 && (
            <div className="isu-pending">
              {pending.map((f, i) => (
                <span className="isu-chip" key={f.name + i}>
                  {f.name} <span className="dim">{fmtBytes(f.size)}</span>
                  <button type="button" title="Remove"
                          onClick={() => setPending((p) => p.filter((_, j) => j !== i))}>×</button>
                </span>
              ))}
            </div>
          )}
        </label>

        {error && <div className="isu-err">{error.message}</div>}

        <div className="isu-form-actions">
          <button className="btn" type="button" onClick={onCancel} disabled={busy}>Cancel</button>
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {busy ? "Opening…" : "Open issue"}
          </button>
        </div>
      </form>
    </Card>
  );
}

// ── detail ──────────────────────────────────────────────────────────────────

function Detail({ id, meta, onBack, onChanged }) {
  const [issue, setIssue] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [comment, setComment] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [uploading, setUploading] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState({ title: "", body: "" });
  // Recording a change against this issue happens here rather than on the
  // Changes page: the context — what the problem is, what was expected — is
  // all on screen, which is when a prediction gets written honestly.
  const [changeMeta, setChangeMeta] = React.useState(null);
  const [composingChange, setComposingChange] = React.useState(false);
  const [changeKey, setChangeKey] = React.useState(0);

  React.useEffect(() => {
    getJSON("/api/changes/meta").then(setChangeMeta).catch(() => { /* strip hides */ });
  }, []);

  const load = React.useCallback(() => {
    getJSON(`/api/issues/${id}`)
      .then((r) => { setIssue(r); setError(null); })
      .catch(setError);
  }, [id]);

  React.useEffect(() => { load(); }, [load]);

  async function patch(body) {
    setBusy(true);
    try { await patchJSON(`/api/issues/${id}`, body); load(); onChanged?.(); }
    catch (e) { setError(e); }
    finally { setBusy(false); }
  }

  async function upload(files, commentId) {
    setUploading(true);
    try {
      for (const f of files) {
        const path = `/api/issues/${id}/attachments/${encodeURIComponent(f.name)}`
          + (commentId ? `?comment_id=${commentId}` : "");
        await putFile(path, f);
      }
      load();
    } catch (e) { setError(e); }
    finally { setUploading(false); }
  }

  async function addComment() {
    if (!comment.trim()) return;
    setBusy(true);
    try {
      await postJSON(`/api/issues/${id}/comments`, { body: comment });
      setComment("");
      load(); onChanged?.();
    } catch (e) { setError(e); }
    finally { setBusy(false); }
  }

  if (error && !issue) return <ErrorMsg error={error} />;
  if (!issue) return <Loading what="issue" />;

  const canTriage = meta.can.triage;
  const mine = issue.reported_by === meta.me;
  const canEditText = mine || meta.can.admin;
  const triageTitle = canTriage ? undefined
    : "Triage is operator-only — add a comment and an operator will pick it up";

  return (
    <div className="page">
      <button className="back" onClick={onBack}>← All issues</button>

      <div className="isu-detail-head">
        <div className="isu-detail-title">
          <Dot severity={issue.severity} />
          {editing ? (
            <input className="isu-title-edit" value={draft.title}
                   onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))} />
          ) : (
            <h1>{issue.title}</h1>
          )}
          <span className="isu-num">#{issue.id}</span>
        </div>
        <div className="isu-detail-meta">
          <StatusPill status={issue.status} />
          <span className="dim">
            opened by {issue.reported_by} · {fmtWhen(issue.created_at)}
            {issue.site ? ` · ${issue.site}` : ""}
            {` · ${CATEGORY_LABEL[issue.category] || issue.category}`}
          </span>
        </div>
      </div>

      <div className="isu-controls">
        <label title={triageTitle}>
          <span>Status</span>
          <select value={issue.status} disabled={!canTriage || busy}
                  onChange={(e) => patch({ status: e.target.value })}>
            {meta.statuses.map((s) => (
              <option key={s} value={s}>{STATUS_LABEL[s] || s}</option>
            ))}
          </select>
        </label>
        <label title={triageTitle}>
          <span>Severity</span>
          <select value={issue.severity} disabled={!canTriage || busy}
                  onChange={(e) => patch({ severity: e.target.value })}>
            {meta.severities.map((s) => (
              <option key={s} value={s}>
                {s === "crit" ? "Critical" : s === "warn" ? "Warning" : "Info"}
              </option>
            ))}
          </select>
        </label>
        <label title={triageTitle}>
          <span>Assignee</span>
          <input type="text" defaultValue={issue.assigned_to || ""}
                 disabled={!canTriage || busy} placeholder="unassigned"
                 onBlur={(e) => {
                   if ((e.target.value || "") !== (issue.assigned_to || "")) {
                     patch({ assigned_to: e.target.value });
                   }
                 }} />
        </label>
        {canTriage && !issue.assigned_to && (
          <button className="btn" disabled={busy}
                  onClick={() => patch({ assigned_to: meta.me })}>Assign to me</button>
        )}
      </div>

      {error && <div className="isu-err">{error.message}</div>}

      <div className="isu-cols">
        <div className="isu-main">
          <Card title="Description" kicker={issue.updated_at ? `updated ${fmtAge(issue.updated_at)}` : null}>
            {editing ? (
              <div className="isu-form">
                <textarea rows={14} value={draft.body}
                          onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))} />
                <div className="isu-form-actions">
                  <button className="btn" onClick={() => setEditing(false)}>Cancel</button>
                  <button className="btn btn-primary" disabled={busy}
                          onClick={async () => {
                            await patch({ title: draft.title, body: draft.body });
                            setEditing(false);
                          }}>Save</button>
                </div>
              </div>
            ) : (
              <>
                <div className="isu-body">{issue.body || <span className="dim">No description.</span>}</div>
                {canEditText && (
                  <button className="btn isu-edit-btn"
                          onClick={() => { setDraft({ title: issue.title, body: issue.body }); setEditing(true); }}>
                    Edit
                  </button>
                )}
              </>
            )}
          </Card>

          <Card title="Timeline" kicker={`${issue.comments.length} entr${issue.comments.length === 1 ? "y" : "ies"}`}>
            {issue.comments.length === 0 ? (
              <div className="msg">Nothing yet. Add what you find as you find it.</div>
            ) : (
              <div className="isu-timeline">
                {issue.comments.map((c) => {
                  const atts = issue.attachments.filter((a) => a.comment_id === c.id);
                  if (c.kind === "status_change") {
                    return (
                      <div className="isu-tl-change" key={c.id}>
                        <span className="isu-tl-dot" />
                        <span><strong>{c.author}</strong> {c.body}</span>
                        <span className="dim">{fmtWhen(c.created_at)}</span>
                      </div>
                    );
                  }
                  return (
                    <div className="isu-tl-comment" key={c.id}>
                      <div className="isu-tl-head">
                        <strong>{c.author}</strong>
                        <span className="dim">
                          {fmtWhen(c.created_at)}
                          {c.edited_at ? " · edited" : ""}
                        </span>
                      </div>
                      <div className="isu-body">{c.body}</div>
                      {atts.length > 0 && (
                        <div className="isu-att-grid">
                          {atts.map((a) => (
                            <AttachmentTile key={a.id} a={a} canDelete={meta.can.admin}
                                            onDelete={async (x) => {
                                              await deleteJSON(`/api/issues/${id}/attachments/${x.id}`);
                                              load();
                                            }} />
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {meta.can.report && (
              <div className="isu-reply">
                <textarea rows={4} value={comment} placeholder="Add what you found…"
                          onChange={(e) => setComment(e.target.value)} />
                <div className="isu-form-actions">
                  <button className="btn btn-primary" disabled={busy || !comment.trim()}
                          onClick={addComment}>Comment</button>
                </div>
              </div>
            )}
          </Card>
        </div>

        <div className="isu-side">
          <Card title="Evidence" kicker={`${issue.attachments.length} file(s)`}>
            {meta.can.report && (
              <DropZone meta={meta} busy={uploading} onFiles={(f) => upload(f)} />
            )}
            {issue.attachments.length === 0 ? (
              <div className="msg">No files yet.</div>
            ) : (
              <div className="isu-att-grid">
                {issue.attachments.map((a) => (
                  <AttachmentTile key={a.id} a={a} canDelete={meta.can.admin}
                                  onDelete={async (x) => {
                                    await deleteJSON(`/api/issues/${id}/attachments/${x.id}`);
                                    load();
                                  }} />
                ))}
              </div>
            )}
          </Card>

          {changeMeta && (composingChange ? (
            <ComposeChange
              meta={changeMeta} issueId={issue.id} issueTitle={issue.title}
              onCancel={() => setComposingChange(false)}
              onDone={() => { setComposingChange(false); setChangeKey((k) => k + 1); load(); }} />
          ) : (
            <ChangesForIssue key={changeKey} issueId={issue.id}
                             canRecord={changeMeta.can.record}
                             onCompose={() => setComposingChange(true)} />
          ))}

          <LinkedTickets recordType="issue" recordId={issue.id} />

          <Card title="Affected devices" kicker={`${issue.devices.length} linked`}>
            {issue.devices.length === 0 ? (
              <div className="msg">None linked.</div>
            ) : (
              <ul className="isu-devlist">
                {issue.devices.map((d) => (
                  <li key={d.device_id}>
                    {d.registered ? (
                      <a href={d.device_type === "ap" ? `#/ap/${d.device_id}`
                             : d.device_type === "camera" ? `#/camera/${d.device_id}`
                             : `#/switches/${d.device_id}`}>{d.name}</a>
                    ) : (
                      <span className="dim">{d.name}</span>
                    )}
                    {d.site && <span className="dim"> · {d.site}</span>}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

// ── list ────────────────────────────────────────────────────────────────────

export function IssuesPage({ id, query }) {
  const [meta, setMeta] = React.useState(null);
  const [rows, setRows] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [composing, setComposing] = React.useState(false);
  const [filters, setFilters] = React.useState({
    status: query?.status || "open", severity: "", category: "", site: "", q: "",
  });

  React.useEffect(() => {
    getJSON("/api/issues/meta").then(setMeta).catch(setError);
  }, []);

  const load = React.useCallback(() => {
    getJSON("/api/issues" + qs(filters))
      .then((r) => { setRows(r); setError(null); })
      .catch(setError);
  }, [filters]);

  React.useEffect(() => {
    if (id) return;   // the detail view loads its own data
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, [load, id]);

  if (error && !meta) return <ErrorMsg error={error} />;
  if (!meta) return <Loading what="issues" />;

  if (id) {
    return <Detail id={id} meta={meta} onChanged={load}
                   onBack={() => { location.hash = "#/issues"; }} />;
  }

  if (composing) {
    return (
      <div className="page">
        <Compose meta={meta} onCancel={() => setComposing(false)}
                 onDone={(newId) => { setComposing(false); location.hash = `#/issues/${newId}`; }} />
      </div>
    );
  }

  const setF = (k) => (e) => setFilters((f) => ({ ...f, [k]: e.target.value }));

  return (
    <div className="page">
      <div className="isu-head">
        <div>
          <h1>Issues</h1>
          <div className="subtitle">
            Problems people are working on — findings, plans and evidence
          </div>
        </div>
        {meta.can.report ? (
          <button className="btn btn-primary" onClick={() => setComposing(true)}>
            New issue
          </button>
        ) : (
          <span className="dim" title="[issues] allow_viewer_reports is off">
            Filing is limited to operators
          </span>
        )}
      </div>

      <div className="evt-filters">
        <label className="evt-filter">
          <span>Status</span>
          <select value={filters.status} onChange={setF("status")}>
            <option value="open">Not resolved</option>
            <option value="">All</option>
            {meta.statuses.map((s) => (
              <option key={s} value={s}>{STATUS_LABEL[s] || s}</option>
            ))}
          </select>
        </label>
        <label className="evt-filter">
          <span>Severity</span>
          <select value={filters.severity} onChange={setF("severity")}>
            <option value="">All</option>
            {meta.severities.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <label className="evt-filter">
          <span>Category</span>
          <select value={filters.category} onChange={setF("category")}>
            <option value="">All</option>
            {meta.categories.map((c) => (
              <option key={c} value={c}>{CATEGORY_LABEL[c] || c}</option>
            ))}
          </select>
        </label>
        <label className="evt-filter evt-filter-grow">
          <span>Search</span>
          <input type="text" value={filters.q} onChange={setF("q")}
                 placeholder="Title or description…" />
        </label>
      </div>

      {error && <div className="isu-err">{error.message}</div>}

      {!rows ? <Loading what="issues" /> : (
        <Card kicker={`${rows.length} issue(s)`}>
          {rows.length === 0 ? (
            <div className="msg">
              {filters.status === "open" && !filters.q
                ? "Nothing open. "
                : "No issues match these filters. "}
              {meta.can.report && filters.status === "open" && !filters.q && (
                <button className="linkish" onClick={() => setComposing(true)}>
                  Open the first one.
                </button>
              )}
            </div>
          ) : (
            <table className="grid">
              <thead>
                <tr>
                  <th></th><th>#</th><th>Title</th><th>Status</th>
                  <th>Location</th><th>Category</th><th>Assignee</th>
                  <th>Activity</th><th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="isu-row"
                      onClick={() => { location.hash = `#/issues/${r.id}`; }}>
                    <td><Dot severity={r.severity} /></td>
                    <td className="mono dim">{r.id}</td>
                    <td className="isu-row-title">{r.title}</td>
                    <td><StatusPill status={r.status} /></td>
                    <td>{r.site || <span className="dim">—</span>}</td>
                    <td className="dim">{CATEGORY_LABEL[r.category] || r.category}</td>
                    <td>{r.assigned_to || <span className="dim">—</span>}</td>
                    <td className="dim" title={r.updated_at}>{fmtAge(r.updated_at)}</td>
                    <td className="dim isu-row-counts">
                      {r.comment_count > 0 && <span title="comments">💬 {r.comment_count}</span>}
                      {r.attachment_count > 0 && <span title="attachments">📎 {r.attachment_count}</span>}
                      {r.device_count > 0 && <span title="linked devices">⛓ {r.device_count}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}
    </div>
  );
}

// ── embeddable strip ────────────────────────────────────────────────────────

/** Open issues for one device, for a device detail page.
 *
 * Renders nothing at all when there are none — a device page should not carry
 * an empty card for a feature that has no rows.
 */
export function IssuesForDevice({ deviceId, deviceName }) {
  const [rows, setRows] = React.useState(null);

  React.useEffect(() => {
    if (!deviceId) return;
    let live = true;
    getJSON("/api/issues" + qs({ device_id: deviceId, status: "open", limit: 20 }))
      .then((r) => { if (live) setRows(r); })
      .catch(() => { if (live) setRows([]); });
    return () => { live = false; };
  }, [deviceId]);

  if (!rows || rows.length === 0) return null;

  return (
    <Card title="Open issues" kicker={deviceName ? `linked to ${deviceName}` : null}>
      <ul className="isu-devlist">
        {rows.map((r) => (
          <li key={r.id}>
            <Dot severity={r.severity} />{" "}
            <a href={`#/issues/${r.id}`}>#{r.id} {r.title}</a>{" "}
            <StatusPill status={r.status} />
            <span className="dim"> · {fmtAge(r.updated_at)}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
