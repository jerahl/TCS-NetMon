import React from "react";
import { getJSON, postJSON, patchJSON, deleteJSON, qs } from "../api.js";
import { Card, Loading, ErrorMsg } from "../primitives.jsx";

// Change tracking — what was changed, why, what was expected, what happened
// (docs/spec/24 §10).
//
// The page leads with one number: changes that are on the network and whose
// result nobody wrote down. That is what a change log is for. Everything else
// here is in service of making that number go down honestly.

const REFRESH_MS = 60000;

const STATUS_LABEL = {
  proposed: "Proposed", approved: "Approved", applied: "Applied",
  verified: "Verified", reverted: "Reverted", abandoned: "Abandoned",
};

const STATUS_TONE = {
  proposed: "dim", approved: "info", applied: "warn",
  verified: "ok", reverted: "err", abandoned: "dim",
};

// The verdict is the comparison, so it gets the louder treatment of the two.
const VERDICT_LABEL = {
  pending: "Not yet checked",
  as_expected: "As expected",
  partial: "Partly",
  no_effect: "No effect",
  worse: "Made it worse",
};

const VERDICT_TONE = {
  pending: "warn", as_expected: "ok", partial: "info",
  no_effect: "dim", worse: "err",
};

const RISK_TONE = { low: "dim", medium: "warn", high: "err" };

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
  if (mins < 60) return `${Math.max(mins, 0)}m`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h`;
  return `${Math.floor(mins / 1440)}d`;
}

function Pill({ tone, children, title }) {
  return <span className={"chg-pill chg-pill-" + (tone || "dim")} title={title}>{children}</span>;
}

const StatusPill = ({ status }) =>
  <Pill tone={STATUS_TONE[status]}>{STATUS_LABEL[status] || status}</Pill>;

const VerdictPill = ({ verdict }) =>
  <Pill tone={VERDICT_TONE[verdict]}>{VERDICT_LABEL[verdict] || verdict}</Pill>;

// ── device picker (targets vs baselines) ────────────────────────────────────

function DevicePicker({ value, onChange, label, hint }) {
  const [q, setQ] = React.useState("");
  const [hits, setHits] = React.useState([]);

  React.useEffect(() => {
    if (q.trim().length < 2) { setHits([]); return; }
    let live = true;
    const id = setTimeout(() => {
      getJSON("/api/search" + qs({ q: q.trim(), limit: 8 }))
        .then((r) => {
          if (!live) return;
          const rows = (r?.hits || r?.results || r || []).filter((h) => h.device_id || h.id);
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
    setQ(""); setHits([]);
  };

  return (
    <div className="chg-pick">
      <span className="chg-pick-label">{label}</span>
      {hint && <span className="chg-pick-hint">{hint}</span>}
      <div className="isu-chips">
        {value.map((d) => (
          <span className="isu-chip" key={d.device_id}>
            {d.name}
            <button type="button" title="Remove"
                    onClick={() => onChange(value.filter((v) => v.device_id !== d.device_id))}>×</button>
          </span>
        ))}
      </div>
      <div className="chg-pick-input">
        <input type="text" value={q} placeholder="Search devices…"
               onChange={(e) => setQ(e.target.value)} />
        {hits.length > 0 && (
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
    </div>
  );
}

// ── compose ─────────────────────────────────────────────────────────────────

export function ComposeChange({ meta, issueId, issueTitle, onDone, onCancel }) {
  const [form, setForm] = React.useState({
    title: "", what: "", why: "", expected: "", rollback: "", risk: "low", site: "",
  });
  const [targets, setTargets] = React.useState([]);
  const [baselines, setBaselines] = React.useState([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const created = await postJSON("/api/changes", {
        ...form,
        site: form.site || null,
        rollback: form.rollback || null,
        issue_id: issueId || null,
        target_device_ids: targets.map((d) => d.device_id),
        baseline_device_ids: baselines.map((d) => d.device_id),
      });
      onDone(created.id);
    } catch (err) {
      setError(err); setBusy(false);
    }
  }

  return (
    <Card title="Record a change"
          kicker={issueId ? `against #${issueId} ${issueTitle || ""}` : "not linked to an issue"}>
      <form className="isu-form" onSubmit={submit}>
        <label>
          <span>Title</span>
          <input type="text" value={form.title} onChange={set("title")} autoFocus
                 placeholder="The change in one line" maxLength={200} />
        </label>

        <label>
          <span>What — the change itself</span>
          <textarea rows={4} value={form.what} onChange={set("what")}
                    placeholder={"The setting, the old and new values, the scope.\nConcrete enough to repeat or reverse."} />
        </label>

        <label>
          <span>Why — the reasoning</span>
          <textarea rows={3} value={form.why} onChange={set("why")}
                    placeholder="What makes this the right change. This is the part that decays first and that a later reader most needs." />
        </label>

        <label>
          {/* The one field the whole record turns on. It locks when the change
              is applied, and the form says so before anyone types into it. */}
          <span>Expected result — locks once applied</span>
          <textarea rows={3} value={form.expected} onChange={set("expected")}
                    placeholder={"What you predict, with a number somebody can check.\n\"DNS entries 4,620 → ~1,087, about −76%. No client-visible effect.\""} />
          <span className="chg-lock-note">
            Written before, compared against the actual result afterwards. It cannot
            be edited once the change is applied.
          </span>
        </label>

        <div className="isu-form-row">
          <label>
            <span>Risk</span>
            <select value={form.risk} onChange={set("risk")}>
              {meta.risks.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </label>
          <label>
            <span>Site</span>
            <input type="text" value={form.site} onChange={set("site")}
                   placeholder="School or location" />
          </label>
        </div>

        <label>
          <span>Rollback — how to undo it</span>
          <textarea rows={2} value={form.rollback} onChange={set("rollback")}
                    placeholder="A change nobody wrote a way back from is one somebody reconstructs under pressure." />
        </label>

        <div className="chg-pickers">
          <DevicePicker label="Changed" value={targets} onChange={setTargets}
                        hint="devices this was applied to" />
          <DevicePicker label="Baseline" value={baselines} onChange={setBaselines}
                        hint="left alone, for comparison" />
        </div>

        {error && <div className="isu-err">{error.message}</div>}

        <div className="isu-form-actions">
          <button className="btn" type="button" onClick={onCancel} disabled={busy}>Cancel</button>
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {busy ? "Saving…" : "Record it"}
          </button>
        </div>
      </form>
    </Card>
  );
}

// ── verify dialog ───────────────────────────────────────────────────────────

function VerifyForm({ change, meta, onDone, onCancel }) {
  const [actual, setActual] = React.useState("");
  const [verdict, setVerdict] = React.useState("as_expected");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await postJSON(`/api/changes/${change.id}/verify`, { actual, verdict });
      onDone();
    } catch (err) { setError(err); setBusy(false); }
  }

  return (
    <form className="isu-form chg-verify" onSubmit={submit}>
      <div className="chg-compare">
        <div>
          <span className="chg-compare-h">Expected, written {fmtWhen(change.proposed_at)}</span>
          <div className="isu-body dim">{change.expected}</div>
        </div>
        <div>
          <label>
            <span className="chg-compare-h">Actual — what happened</span>
            <textarea rows={6} value={actual} autoFocus
                      onChange={(e) => setActual(e.target.value)}
                      placeholder="The measurement. Same units as the prediction, so the two can be compared." />
          </label>
        </div>
      </div>

      <label>
        <span>Verdict</span>
        <select value={verdict} onChange={(e) => setVerdict(e.target.value)}>
          {meta.verdicts.filter((v) => v !== "pending").map((v) => (
            <option key={v} value={v}>{VERDICT_LABEL[v] || v}</option>
          ))}
        </select>
        <span className="chg-lock-note">
          "No effect" and "Made it worse" are proper answers. A change log where
          everything succeeded is one nobody learns from.
        </span>
      </label>

      {error && <div className="isu-err">{error.message}</div>}
      <div className="isu-form-actions">
        <button className="btn" type="button" onClick={onCancel} disabled={busy}>Cancel</button>
        <button className="btn btn-primary" type="submit" disabled={busy || !actual.trim()}>
          Record the result
        </button>
      </div>
    </form>
  );
}

// ── detail ──────────────────────────────────────────────────────────────────

function Detail({ id, meta, onBack, onChanged }) {
  const [change, setChange] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [verifying, setVerifying] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(() => {
    getJSON(`/api/changes/${id}`).then((r) => { setChange(r); setError(null); })
      .catch(setError);
  }, [id]);
  React.useEffect(() => { load(); }, [load]);

  async function act(fn) {
    setBusy(true);
    try { await fn(); load(); onChanged?.(); }
    catch (e) { setError(e); }
    finally { setBusy(false); }
  }

  if (error && !change) return <ErrorMsg error={error} />;
  if (!change) return <Loading what="change" />;

  const can = meta.can.record;
  const targets = change.devices.filter((d) => d.role === "target");
  const baselines = change.devices.filter((d) => d.role === "baseline");

  return (
    <div className="page">
      <button className="back" onClick={onBack}>← All changes</button>

      <div className="chg-head">
        <div>
          <h1>{change.title}</h1>
          <div className="chg-head-pills">
            <StatusPill status={change.status} />
            <VerdictPill verdict={change.verdict} />
            <Pill tone={RISK_TONE[change.risk]}>{change.risk} risk</Pill>
            <span className="dim">#{change.id}</span>
            {change.site && <span className="dim">· {change.site}</span>}
          </div>
        </div>
        {can && (
          <div className="chg-actions">
            {change.status === "proposed" && (
              <button className="btn" disabled={busy}
                      onClick={() => act(() => patchJSON(`/api/changes/${id}`, { status: "approved" }))}>
                Mark approved
              </button>
            )}
            {!["applied", "verified", "reverted"].includes(change.status) && (
              <button className="btn btn-primary" disabled={busy}
                      onClick={() => act(() => postJSON(`/api/changes/${id}/apply`, {}))}>
                Mark applied
              </button>
            )}
            {change.status === "applied" && !verifying && (
              <button className="btn btn-primary" onClick={() => setVerifying(true)}>
                Record the result
              </button>
            )}
            {["applied", "verified"].includes(change.status) && (
              <button className="btn btn-warn" disabled={busy}
                      onClick={() => {
                        const note = window.prompt("Why was it reverted?", "");
                        if (note === null) return;
                        act(() => postJSON(`/api/changes/${id}/revert`, { note }));
                      }}>
                Reverted
              </button>
            )}
          </div>
        )}
      </div>

      {change.issue && (
        <div className="chg-issue-link">
          Against <a href={`#/issues/${change.issue.id}`}>#{change.issue.id} {change.issue.title}</a>
        </div>
      )}

      {error && <div className="isu-err">{error.message}</div>}

      {/* Expected and actual sit side by side, always. That comparison is the
          reason the record exists, so it is not something you scroll to find. */}
      <Card title="Expected vs actual"
            kicker={change.verified_at
              ? `verified ${fmtWhen(change.verified_at)} by ${change.verified_by}`
              : change.applied_at ? "applied, result not yet recorded" : "not yet applied"}>
        {verifying ? (
          <VerifyForm change={change} meta={meta}
                      onDone={() => { setVerifying(false); load(); onChanged?.(); }}
                      onCancel={() => setVerifying(false)} />
        ) : (
          <div className="chg-compare">
            <div>
              <span className="chg-compare-h">Expected</span>
              <div className="isu-body">{change.expected}</div>
            </div>
            <div>
              <span className="chg-compare-h">Actual</span>
              {change.actual ? (
                <div className="isu-body">{change.actual}</div>
              ) : (
                <div className={"chg-empty-actual" + (change.applied_at ? " overdue" : "")}>
                  {change.applied_at
                    ? `Applied ${fmtAge(change.applied_at)} ago and nobody has recorded what happened.`
                    : "Nothing to record until this is applied."}
                </div>
              )}
            </div>
          </div>
        )}
        {!verifying && change.verdict !== "pending" && (
          <div className="chg-verdict-row">
            Verdict: <VerdictPill verdict={change.verdict} />
          </div>
        )}
      </Card>

      <div className="isu-cols">
        <div className="isu-main">
          <Card title="What changed"><div className="isu-body">{change.what}</div></Card>
          <Card title="Why"><div className="isu-body">{change.why}</div></Card>
          {change.rollback && (
            <Card title="Rollback"><div className="isu-body">{change.rollback}</div></Card>
          )}
        </div>

        <div className="isu-side">
          <Card title="Devices">
            <div className="chg-dev-group">
              <span className="chg-dev-h">Changed</span>
              {targets.length === 0 ? <div className="dim">None recorded.</div> : (
                <ul className="isu-devlist">
                  {targets.map((d) => <li key={d.device_id}>{d.name}</li>)}
                </ul>
              )}
            </div>
            <div className="chg-dev-group">
              <span className="chg-dev-h">Baseline — left alone</span>
              {baselines.length === 0 ? <div className="dim">None held back.</div> : (
                <ul className="isu-devlist">
                  {baselines.map((d) => <li key={d.device_id}>{d.name}</li>)}
                </ul>
              )}
            </div>
          </Card>

          <Card title="Record">
            <table className="grid kv">
              <tbody>
                <tr><td>Proposed</td><td>{fmtWhen(change.proposed_at)} · {change.proposed_by}</td></tr>
                <tr><td>Applied</td><td>{change.applied_at
                  ? `${fmtWhen(change.applied_at)} · ${change.applied_by}` : "—"}</td></tr>
                <tr><td>Verified</td><td>{change.verified_at
                  ? `${fmtWhen(change.verified_at)} · ${change.verified_by}` : "—"}</td></tr>
                {change.reverted_at && (
                  <tr><td>Reverted</td><td>{fmtWhen(change.reverted_at)}</td></tr>
                )}
              </tbody>
            </table>
          </Card>
        </div>
      </div>
    </div>
  );
}

// ── list ────────────────────────────────────────────────────────────────────

export function ChangesPage({ id, query }) {
  const [meta, setMeta] = React.useState(null);
  const [rows, setRows] = React.useState(null);
  const [out, setOut] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [composing, setComposing] = React.useState(false);
  const [filters, setFilters] = React.useState({
    status: query?.status || "", verdict: "", q: "",
  });

  React.useEffect(() => {
    getJSON("/api/changes/meta").then(setMeta).catch(setError);
  }, []);

  const load = React.useCallback(() => {
    getJSON("/api/changes" + qs(filters))
      .then((r) => { setRows(r); setError(null); }).catch(setError);
    getJSON("/api/changes/outstanding").then(setOut).catch(() => {});
  }, [filters]);

  React.useEffect(() => {
    if (id) return;
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, [load, id]);

  if (error && !meta) return <ErrorMsg error={error} />;
  if (!meta) return <Loading what="changes" />;

  if (id) {
    return <Detail id={id} meta={meta} onChanged={load}
                   onBack={() => { location.hash = "#/changes"; }} />;
  }

  if (composing) {
    return (
      <div className="page">
        <ComposeChange meta={meta} onCancel={() => setComposing(false)}
                       onDone={(nid) => { setComposing(false); location.hash = `#/changes/${nid}`; }} />
      </div>
    );
  }

  const setF = (k) => (e) => setFilters((f) => ({ ...f, [k]: e.target.value }));

  return (
    <div className="page">
      <div className="isu-head">
        <div>
          <h1>Changes</h1>
          <div className="subtitle">
            What was changed, why, and whether it did what we expected
          </div>
        </div>
        {meta.can.record && (
          <button className="btn btn-primary" onClick={() => setComposing(true)}>
            Record a change
          </button>
        )}
      </div>

      {/* The headline. A change log's value is almost entirely in showing which
          predictions nobody went back and checked. */}
      {out && out.count > 0 && (
        <button className="chg-banner"
                onClick={() => setFilters((f) => ({ ...f, status: "unverified" }))}>
          <span className="chg-banner-n">{out.count}</span>
          <span>
            change{out.count === 1 ? " is" : "s are"} on the network with no result
            recorded
            {out.changes[0]?.applied_at &&
              ` — oldest applied ${fmtAge(out.changes[0].applied_at)} ago`}
          </span>
          <span className="chg-banner-go">Show →</span>
        </button>
      )}

      <div className="evt-filters">
        <label className="evt-filter">
          <span>Status</span>
          <select value={filters.status} onChange={setF("status")}>
            <option value="">All</option>
            <option value="live">On the network now</option>
            <option value="unverified">Applied, unverified</option>
            {meta.statuses.map((s) => (
              <option key={s} value={s}>{STATUS_LABEL[s] || s}</option>
            ))}
          </select>
        </label>
        <label className="evt-filter">
          <span>Verdict</span>
          <select value={filters.verdict} onChange={setF("verdict")}>
            <option value="">All</option>
            {meta.verdicts.map((v) => (
              <option key={v} value={v}>{VERDICT_LABEL[v] || v}</option>
            ))}
          </select>
        </label>
        <label className="evt-filter evt-filter-grow">
          <span>Search</span>
          <input type="text" value={filters.q} onChange={setF("q")}
                 placeholder="Title, what or why…" />
        </label>
      </div>

      {error && <div className="isu-err">{error.message}</div>}

      {!rows ? <Loading what="changes" /> : (
        <Card kicker={`${rows.length} change(s)`}>
          {rows.length === 0 ? (
            <div className="msg">
              No changes recorded{filters.status || filters.q ? " for these filters" : " yet"}.
            </div>
          ) : (
            <table className="grid">
              <thead>
                <tr>
                  <th>#</th><th>Change</th><th>Status</th><th>Result</th>
                  <th>Risk</th><th>Scope</th><th>Issue</th><th>Applied</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="isu-row"
                      onClick={() => { location.hash = `#/changes/${r.id}`; }}>
                    <td className="mono dim">{r.id}</td>
                    <td className="isu-row-title">{r.title}</td>
                    <td><StatusPill status={r.status} /></td>
                    <td><VerdictPill verdict={r.verdict} /></td>
                    <td><Pill tone={RISK_TONE[r.risk]}>{r.risk}</Pill></td>
                    <td className="dim">
                      {r.target_count} changed
                      {r.baseline_count > 0 && ` · ${r.baseline_count} baseline`}
                    </td>
                    <td className="dim">{r.issue_id ? `#${r.issue_id}` : "—"}</td>
                    <td className="dim">{r.applied_at ? fmtAge(r.applied_at) + " ago" : "—"}</td>
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

/** Changes recorded against one issue, for the issue detail page. */
export function ChangesForIssue({ issueId, canRecord, onCompose }) {
  const [rows, setRows] = React.useState(null);

  const load = React.useCallback(() => {
    getJSON("/api/changes" + qs({ issue_id: issueId, limit: 50 }))
      .then(setRows).catch(() => setRows([]));
  }, [issueId]);
  React.useEffect(() => { load(); }, [load]);

  if (!rows) return null;
  const unverified = rows.filter((r) => r.status === "applied" && r.verdict === "pending");

  return (
    <Card title="Changes"
          kicker={rows.length
            ? `${rows.length} recorded${unverified.length ? ` · ${unverified.length} unverified` : ""}`
            : null}>
      {rows.length === 0 ? (
        <div className="msg">Nothing changed for this yet.</div>
      ) : (
        <ul className="chg-mini">
          {rows.map((r) => (
            <li key={r.id}>
              <a href={`#/changes/${r.id}`}>#{r.id} {r.title}</a>
              <span className="chg-mini-pills">
                <StatusPill status={r.status} />
                <VerdictPill verdict={r.verdict} />
              </span>
            </li>
          ))}
        </ul>
      )}
      {canRecord && (
        <button className="btn chg-mini-add" onClick={onCompose}>Record a change</button>
      )}
    </Card>
  );
}
