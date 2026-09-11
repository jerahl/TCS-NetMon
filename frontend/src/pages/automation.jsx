// Automation — workflow editor, run trail, and the approval queue (spec 22,
// phase 22.3).
//
// The canvas is React Flow (@xyflow/react, owner-approved 2026-09-11 as the
// fourth frontend dependency — bundled locally by esbuild, no CDN).
//
// Two things this editor deliberately does NOT let you do, because they are
// invariants the engine keeps rather than choices an author makes:
//
//   * there is no guard node and no way to weaken one. The ten guards run on
//     every action step regardless of what the canvas says (spec 22 W4). The
//     palette shows them as a read-only panel so an author can see what will
//     be applied, not edit it;
//   * there is no free-text target. A node picks an action key from the closed
//     registry served by /api/automation/meta; it can never carry a URL, host,
//     command or snippet body (W5).
//
// The palette itself is served from the backend's registries rather than
// duplicated here, so a node kind the engine cannot run can never appear in it.

import React from "react";
import {
  ReactFlow, Background, Controls, MiniMap, Handle, Position,
  useNodesState, useEdgesState, addEdge,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { getJSON, postJSON, putJSON } from "../api.js";
import { Card, ErrorMsg, Loading, PageHeader, Tabs } from "../primitives.jsx";

const KIND_STYLE = {
  trigger: { accent: "var(--info)", glyph: "▶", name: "Trigger" },
  branch: { accent: "var(--accent)", glyph: "◆", name: "Branch" },
  action: { accent: "var(--warn)", glyph: "⚡", name: "Action" },
  wait: { accent: "var(--muted)", glyph: "⏱", name: "Wait" },
  alert: { accent: "var(--err)", glyph: "✉", name: "Alert" },
  stop: { accent: "var(--muted-2)", glyph: "■", name: "Stop" },
};

// ───────────────────────── node renderers ─────────────────────────

function NodeShell({ kind, children, selected, warn }) {
  const s = KIND_STYLE[kind] || KIND_STYLE.stop;
  return (
    <div style={{
      minWidth: 190, maxWidth: 260, borderRadius: "var(--r-2)",
      background: "var(--bg-2)",
      border: `1px solid ${selected ? s.accent : "var(--line-2)"}`,
      borderLeft: `3px solid ${s.accent}`,
      boxShadow: selected ? `0 0 0 1px ${s.accent}` : "none",
      padding: "8px 10px", fontSize: 12, color: "var(--fg)",
    }}>
      <div style={{
        fontSize: 9, letterSpacing: 0.8, textTransform: "uppercase",
        color: s.accent, marginBottom: 3,
      }}>
        {s.glyph} {s.name}
      </div>
      {children}
      {warn && (
        <div style={{
          marginTop: 6, fontSize: 10, color: "var(--warn)",
          borderTop: "1px solid var(--line)", paddingTop: 5,
        }}>
          {warn}
        </div>
      )}
    </div>
  );
}

function makeNodeType(kind) {
  return function Node({ data, selected }) {
    return (
      <>
        {kind !== "trigger" && <Handle type="target" position={Position.Left} />}
        <NodeShell kind={kind} selected={selected} warn={data.warn}>
          <div style={{ fontWeight: 600, lineHeight: 1.3 }}>{data.label}</div>
          {data.sub && (
            <div style={{ color: "var(--muted)", fontSize: 11, marginTop: 3,
                          fontFamily: "var(--mono)" }}>
              {data.sub}
            </div>
          )}
        </NodeShell>
        {kind !== "stop" && <Handle type="source" position={Position.Right} />}
      </>
    );
  };
}

const NODE_TYPES = Object.fromEntries(
  Object.keys(KIND_STYLE).map((k) => [k, makeNodeType(k)]),
);

// ───────────────────────── graph <-> React Flow ─────────────────────────

// The stored document and the canvas document are close but not identical:
// React Flow wants `type`/`position`/`data`, the engine wants
// `kind`/`config`. Keeping the mapping in one pair of functions is what stops
// the two drifting.

function describe(node, meta) {
  const c = node.config || {};
  if (node.kind === "trigger") {
    const held = Number(c.min_duration_s || 0);
    return `${c.dimension} = ${c.value}` +
      (c.device_type ? ` · ${c.device_type}` : "") +
      (held ? ` · held ${Math.round(held / 60)}m` : "");
  }
  if (node.kind === "branch") {
    const p = (meta?.predicates || []).find((x) => x.key === c.predicate);
    return p ? p.question : c.predicate;
  }
  if (node.kind === "action") {
    const a = (meta?.actions || []).find((x) => x.key === c.action);
    return a ? a.label : c.action;
  }
  if (node.kind === "wait") return `${Math.round(Number(c.seconds || 0) / 60)} minutes`;
  if (node.kind === "alert") return c.summary;
  return null;
}

function actionWarning(node, meta) {
  if (node.kind !== "action") return null;
  const a = (meta?.actions || []).find((x) => x.key === (node.config || {}).action);
  if (!a) return null;
  // The single most important thing an author can misunderstand: a disruptive
  // step does not run when the workflow runs. Say so on the node itself.
  return a.disruptive
    ? "Disruptive — queues for approval, never fires unattended"
    : null;
}

function toFlow(doc, meta) {
  const nodes = (doc?.nodes || []).map((n) => ({
    id: n.id,
    type: n.kind,
    position: n.position || { x: 0, y: 0 },
    data: {
      label: n.label || n.id,
      sub: describe(n, meta),
      warn: actionWarning(n, meta),
      kind: n.kind,
      config: n.config || {},
    },
  }));
  const edges = (doc?.edges || []).map((e, i) => ({
    id: e.id || `e${i}-${e.source}-${e.target}`,
    source: e.source,
    target: e.target,
    label: e.when === "true" ? "yes" : e.when === "false" ? "no" : undefined,
    data: { when: e.when || null },
    style: { stroke: e.when === "false" ? "var(--muted-2)" : "var(--line-2)" },
  }));
  return { nodes, edges };
}

function fromFlow(nodes, edges) {
  return {
    nodes: nodes.map((n) => ({
      id: n.id,
      kind: n.data.kind,
      label: n.data.label,
      position: { x: Math.round(n.position.x), y: Math.round(n.position.y) },
      config: n.data.config || {},
    })),
    edges: edges.map((e) => ({
      source: e.source,
      target: e.target,
      ...(e.data?.when ? { when: e.data.when } : {}),
    })),
  };
}

// ───────────────────────── inspector ─────────────────────────

function Field({ label, hint, children }) {
  return (
    <label style={{ display: "block", marginBottom: 10 }}>
      <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 0.7,
                    color: "var(--muted)", marginBottom: 4 }}>{label}</div>
      {children}
      {hint && <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4,
                             lineHeight: 1.4 }}>{hint}</div>}
    </label>
  );
}

const INPUT = {
  width: "100%", background: "var(--bg-1)", color: "var(--fg)",
  border: "1px solid var(--line-2)", borderRadius: "var(--r-1)",
  padding: "5px 7px", fontSize: 12, fontFamily: "inherit",
};

function Inspector({ node, meta, onChange, onDelete, readOnly }) {
  if (!node) {
    return (
      <div style={{ color: "var(--muted)", fontSize: 12, lineHeight: 1.6 }}>
        Select a node to edit it.
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--line)" }}>
          Drag from a node's right handle to its next step. A branch has two
          arms — label them <b>yes</b> and <b>no</b> in the edge list below.
        </div>
      </div>
    );
  }
  const kind = node.data.kind;
  const cfg = node.data.config || {};
  const set = (patch) => onChange({ ...cfg, ...patch });

  return (
    <div>
      <Field label="Label">
        <input style={INPUT} value={node.data.label} disabled={readOnly}
               onChange={(e) => onChange(cfg, e.target.value)} />
      </Field>

      {kind === "trigger" && (
        <>
          <Field label="Dimension"
                 hint="`recording` is absent on purpose — it reads 'up' for every
                       device on this fleet, so a trigger on it would never
                       discriminate.">
            <select style={INPUT} value={cfg.dimension || ""} disabled={readOnly}
                    onChange={(e) => set({ dimension: e.target.value })}>
              {(meta?.trigger_dimensions || []).map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
          </Field>
          <Field label="Value">
            <input style={INPUT} value={cfg.value || ""} disabled={readOnly}
                   onChange={(e) => set({ value: e.target.value })} />
          </Field>
          <Field label="Device type" hint="Blank matches every device type.">
            <input style={INPUT} value={cfg.device_type || ""} disabled={readOnly}
                   onChange={(e) => set({ device_type: e.target.value })} />
          </Field>
          <Field label="Held for (minutes)"
                 hint="Measured from the transition log, not from the last
                       collector write — so a collector rewriting the same value
                       does not restart the clock.">
            <input style={INPUT} type="number" min="0" disabled={readOnly}
                   value={Math.round(Number(cfg.min_duration_s || 0) / 60)}
                   onChange={(e) => set({ min_duration_s: Number(e.target.value) * 60 })} />
          </Field>
        </>
      )}

      {kind === "branch" && (
        <Field label="Question"
               hint="Answered from NetMon's own tables — a branch never calls a
                     source. An unanswerable question takes the 'no' arm and
                     says so in the run trail.">
          <select style={INPUT} value={cfg.predicate || ""} disabled={readOnly}
                  onChange={(e) => set({ predicate: e.target.value })}>
            {(meta?.predicates || []).map((p) => (
              <option key={p.key} value={p.key}>{p.question}</option>
            ))}
          </select>
        </Field>
      )}

      {kind === "action" && (
        <ActionFields cfg={cfg} meta={meta} set={set} readOnly={readOnly} />
      )}

      {kind === "wait" && (
        <Field label="Wait (minutes)"
               hint="The run is parked with a cursor and resumes on a later
                     cycle. Nothing blocks while it waits.">
          <input style={INPUT} type="number" min="1" disabled={readOnly}
                 value={Math.round(Number(cfg.seconds || 300) / 60)}
                 onChange={(e) => set({ seconds: Math.max(1, Number(e.target.value)) * 60 })} />
        </Field>
      )}

      {kind === "alert" && (
        <Field label="Summary"
               hint="{device} and {site} are filled in when the alert is raised.">
          <textarea style={{ ...INPUT, minHeight: 70, resize: "vertical" }}
                    value={cfg.summary || ""} disabled={readOnly}
                    onChange={(e) => set({ summary: e.target.value })} />
        </Field>
      )}

      {!readOnly && kind !== "trigger" && (
        <button type="button" onClick={onDelete}
                style={{ ...INPUT, width: "auto", cursor: "pointer",
                         color: "var(--err)", borderColor: "var(--line-2)",
                         background: "transparent", marginTop: 4 }}>
          Delete node
        </button>
      )}
    </div>
  );
}

function ActionFields({ cfg, meta, set, readOnly }) {
  const chosen = (meta?.actions || []).find((a) => a.key === cfg.action);
  return (
    <>
      <Field label="Action">
        <select style={INPUT} value={cfg.action || ""} disabled={readOnly}
                onChange={(e) => set({ action: e.target.value })}>
          <option value="">—</option>
          {(meta?.actions || []).map((a) => (
            <option key={a.key} value={a.key}>{a.label} · {a.source}</option>
          ))}
        </select>
      </Field>
      {chosen && (
        <div style={{
          fontSize: 11, lineHeight: 1.5, color: "var(--fg-2)",
          background: "var(--bg-1)", border: "1px solid var(--line)",
          borderLeft: `3px solid ${chosen.disruptive ? "var(--warn)" : "var(--ok)"}`,
          borderRadius: "var(--r-1)", padding: "8px 10px", marginBottom: 10,
        }}>
          <div>{chosen.effect}</div>
          <div style={{ marginTop: 6, color: chosen.disruptive ? "var(--warn)" : "var(--ok)" }}>
            {chosen.disruptive
              ? "Disruptive: this queues for a human to approve. It never fires unattended, live or in shadow."
              : "Runs automatically once this workflow is live."}
          </div>
          <div style={{ marginTop: 6, color: "var(--muted)" }}>
            The target is resolved by the engine from the device the run is
            about — there is nothing to type here.
          </div>
        </div>
      )}
    </>
  );
}

// ───────────────────────── the guard panel (read-only) ─────────────────────────

const GUARD_TEXT = [
  ["G1", "Source not blind", "A blind source is a fact about the source, not the device."],
  ["G2", "State is fresh", "Never act on a reading older than the limit — a dead collector leaves a stale verdict looking fresh."],
  ["G3", "Native poller agrees", "Refuses on a contested management IP always; refuses a power cut when the device still answers."],
  ["G4", "Blast radius", "More peers down at one site or behind one switch than the limit means the fault is upstream."],
  ["G5", "Port confidence", "A PoE cycle needs a port confirmed safe while the device was healthy, and recently."],
  ["G6", "Upstream alive", "Not the camera's fault if its switch is down."],
  ["G7", "Cooldown", "One attempt per device per cooldown."],
  ["G8", "Rate limit", "A fleet-wide ceiling per hour."],
  ["G9", "Maintenance", "Respects the same windows the alert engine does."],
  ["G10", "Action enabled", "Delegated to the same config flags the operator buttons use."],
];

function GuardPanel({ guards }) {
  const fmt = (s) => (s >= 3600 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 60)}m`);
  const values = {
    G2: guards ? fmt(guards.max_state_age_s) : null,
    G4: guards ? `${guards.site_cluster_max} / site, ${guards.switch_cluster_max} / switch` : null,
    G5: guards ? fmt(guards.require_port_confirmed_within_s) : null,
    G7: guards ? fmt(guards.per_device_cooldown_s) : null,
    G8: guards ? `${guards.fleet_rate_limit}/h` : null,
  };
  return (
    <div>
      <div style={{ fontSize: 11, color: "var(--muted)", lineHeight: 1.5,
                    marginBottom: 10 }}>
        Applied to every action step, whatever the canvas says. These are not
        editable here — a workflow editor that could switch off its own safety
        checks would be a footgun with a GUI. Change them in
        <span style={{ fontFamily: "var(--mono)" }}> [automation]</span>.
      </div>
      {GUARD_TEXT.map(([code, name, why]) => (
        <div key={code} style={{ display: "flex", gap: 8, padding: "5px 0",
                                 borderTop: "1px solid var(--line)" }}>
          <div style={{ fontFamily: "var(--mono)", fontSize: 11,
                        color: "var(--accent)", minWidth: 26 }}>{code}</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 12 }}>
              {name}
              {values[code] && (
                <span style={{ fontFamily: "var(--mono)", color: "var(--warn)",
                               marginLeft: 6 }}>{values[code]}</span>
              )}
            </div>
            <div style={{ fontSize: 11, color: "var(--muted)", lineHeight: 1.4 }}>{why}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

export { GuardPanel, toFlow, fromFlow, describe, actionWarning };

// ───────────────────────── the editor ─────────────────────────

function Editor({ workflow, meta, role, onSaved }) {
  const readOnly = role !== "admin";
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [selected, setSelected] = React.useState(null);
  const [dirty, setDirty] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [note, setNote] = React.useState(null);

  React.useEffect(() => {
    const flow = toFlow(workflow.graph, meta);
    setNodes(flow.nodes);
    setEdges(flow.edges);
    setSelected(null);
    setDirty(false);
  }, [workflow.id, workflow.version, meta]);   // eslint-disable-line

  const selectedNode = nodes.find((n) => n.id === selected) || null;

  const patchNode = (config, label) => {
    setNodes((ns) => ns.map((n) => {
      if (n.id !== selected) return n;
      const next = {
        ...n,
        data: { ...n.data, config, ...(label !== undefined ? { label } : {}) },
      };
      const asDoc = { kind: next.data.kind, config, label: next.data.label };
      next.data.sub = describe(asDoc, meta);
      next.data.warn = actionWarning(asDoc, meta);
      return next;
    }));
    setDirty(true);
  };

  const addNode = (kind) => {
    const id = `${kind}_${Math.random().toString(36).slice(2, 7)}`;
    const defaults = {
      trigger: { dimension: "source_status", value: "down", min_duration_s: 900 },
      branch: { predicate: (meta?.predicates || [])[0]?.key || "ping_up" },
      action: { action: "" },
      wait: { seconds: 300 },
      alert: { summary: "{device} at {site} needs a human" },
      stop: {},
    }[kind] || {};
    setNodes((ns) => ns.concat({
      id, type: kind,
      position: { x: 80 + ns.length * 30, y: 60 + ns.length * 40 },
      data: { label: KIND_STYLE[kind].name, kind, config: defaults,
              sub: describe({ kind, config: defaults }, meta), warn: null },
    }));
    setSelected(id);
    setDirty(true);
  };

  const deleteNode = () => {
    setNodes((ns) => ns.filter((n) => n.id !== selected));
    setEdges((es) => es.filter((e) => e.source !== selected && e.target !== selected));
    setSelected(null);
    setDirty(true);
  };

  const onConnect = React.useCallback((params) => {
    setEdges((es) => addEdge({ ...params, data: { when: null } }, es));
    setDirty(true);
  }, [setEdges]);

  // A branch needs its two arms labelled, and the label is what the engine
  // routes on — so it is an explicit control, not a guess from geometry.
  const setEdgeWhen = (edgeId, when) => {
    setEdges((es) => es.map((e) => (e.id === edgeId
      ? { ...e, data: { ...e.data, when },
          label: when === "true" ? "yes" : when === "false" ? "no" : undefined,
          style: { stroke: when === "false" ? "var(--muted-2)" : "var(--line-2)" } }
      : e)));
    setDirty(true);
  };

  const save = async () => {
    setSaving(true); setError(null); setNote(null);
    try {
      await putJSON(`/api/automation/workflows/${workflow.id}`, {
        name: workflow.name, title: workflow.title,
        description: workflow.description, graph: fromFlow(nodes, edges),
      });
      setDirty(false);
      setNote("Saved.");
      onSaved();
    } catch (e) {
      // A 422 here is the graph validator talking. Show it verbatim: it names
      // the node and says what is wrong with it.
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const branchEdges = edges.filter((e) => {
    const src = nodes.find((n) => n.id === e.source);
    return src && src.data.kind === "branch";
  });

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 320px", gap: 12 }}>
      <div>
        <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 8,
                      flexWrap: "wrap" }}>
          {!readOnly && Object.keys(KIND_STYLE).filter((k) => k !== "trigger").map((k) => (
            <button key={k} type="button" onClick={() => addNode(k)}
                    style={{ ...INPUT, width: "auto", cursor: "pointer",
                             background: "var(--bg-2)" }}>
              + {KIND_STYLE[k].name}
            </button>
          ))}
          <div style={{ flex: 1 }} />
          {dirty && <span style={{ color: "var(--warn)", fontSize: 11 }}>unsaved changes</span>}
          {note && <span style={{ color: "var(--ok)", fontSize: 11 }}>{note}</span>}
          {!readOnly && (
            <button type="button" onClick={save} disabled={saving || !dirty}
                    style={{ ...INPUT, width: "auto", cursor: "pointer",
                             background: dirty ? "var(--accent)" : "var(--bg-2)",
                             color: dirty ? "#fff" : "var(--muted)",
                             borderColor: "transparent" }}>
              {saving ? "Saving…" : "Save"}
            </button>
          )}
        </div>

        {error && <div style={{ marginBottom: 8 }}><ErrorMsg error={error} /></div>}

        <div style={{ height: 520, border: "1px solid var(--line)",
                      borderRadius: "var(--r-2)", background: "var(--bg-1)" }}>
          <ReactFlow
            nodes={nodes} edges={edges} nodeTypes={NODE_TYPES}
            onNodesChange={readOnly ? undefined : onNodesChange}
            onEdgesChange={readOnly ? undefined : onEdgesChange}
            onConnect={readOnly ? undefined : onConnect}
            onNodeClick={(_, n) => setSelected(n.id)}
            onPaneClick={() => setSelected(null)}
            nodesDraggable={!readOnly} nodesConnectable={!readOnly}
            fitView proOptions={{ hideAttribution: false }}
            colorMode="dark"
          >
            <Background color="var(--grid)" gap={16} />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable
                     style={{ background: "var(--bg-2)" }}
                     nodeColor={(n) => (KIND_STYLE[n.type] || KIND_STYLE.stop).accent} />
          </ReactFlow>
        </div>

        {branchEdges.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 0.7,
                          color: "var(--muted)", marginBottom: 6 }}>
              Branch arms
            </div>
            {branchEdges.map((e) => (
              <div key={e.id} style={{ display: "flex", gap: 8, alignItems: "center",
                                       padding: "4px 0", fontSize: 12 }}>
                <span style={{ fontFamily: "var(--mono)", color: "var(--muted)" }}>
                  {e.source} → {e.target}
                </span>
                <div style={{ flex: 1 }} />
                <select style={{ ...INPUT, width: 110 }} disabled={readOnly}
                        value={e.data?.when || ""}
                        onChange={(ev) => setEdgeWhen(e.id, ev.target.value || null)}>
                  <option value="">unlabelled</option>
                  <option value="true">yes</option>
                  <option value="false">no</option>
                </select>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Card title="Node" tight>
          <Inspector node={selectedNode} meta={meta} readOnly={readOnly}
                     onChange={patchNode} onDelete={deleteNode} />
        </Card>
        <Card title="Guards — always on" tight>
          <GuardPanel guards={meta?.guards} />
        </Card>
      </div>
    </div>
  );
}

// ───────────────────────── runs & proposals ─────────────────────────

const DECISION_COLOR = {
  taken: "var(--ok)", would_run: "var(--info)", refused: "var(--warn)",
  failed: "var(--err)", skipped: "var(--muted)", awaiting_approval: "var(--accent)",
};

function RunTrail({ runId }) {
  const [run, setRun] = React.useState(null);
  React.useEffect(() => {
    if (!runId) return;
    getJSON(`/api/automation/runs/${runId}`).then(setRun).catch(() => setRun(null));
  }, [runId]);
  if (!run) return <Loading what="run" />;
  return (
    <div>
      {(run.steps || []).map((s) => (
        <div key={s.seq} style={{ display: "flex", gap: 10, padding: "6px 0",
                                  borderTop: "1px solid var(--line)" }}>
          <div style={{ fontFamily: "var(--mono)", fontSize: 11,
                        color: "var(--muted)", minWidth: 18 }}>{s.seq}</div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 10, minWidth: 120,
                        color: DECISION_COLOR[s.decision] || "var(--muted)",
                        textTransform: "uppercase", letterSpacing: 0.5 }}>
            {s.decision.replace("_", " ")}
          </div>
          <div style={{ flex: 1, fontSize: 12, lineHeight: 1.45 }}>
            <span style={{ color: "var(--fg-2)" }}>{s.label || s.node_id}</span>
            <div style={{ color: "var(--muted)" }}>{s.detail}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function Runs() {
  const [runs, setRuns] = React.useState(null);
  const [open, setOpen] = React.useState(null);
  const [report, setReport] = React.useState(null);
  const [error, setError] = React.useState(null);

  React.useEffect(() => {
    getJSON("/api/automation/runs?limit=100").then(setRuns).catch((e) => setError(e.message));
    getJSON("/api/automation/shadow-report").then(setReport).catch(() => {});
  }, []);

  if (error) return <ErrorMsg error={error} />;
  if (!runs) return <Loading what="runs" />;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 320px", gap: 12 }}>
      <Card title="Runs" kicker={`${runs.length} most recent`} tight>
        {runs.length === 0 && (
          <div style={{ color: "var(--muted)", fontSize: 12 }}>
            Nothing has run yet. A workflow must be enabled before the engine
            evaluates it, and <span style={{ fontFamily: "var(--mono)" }}>[automation]
            enabled</span> must be true for the task to run at all.
          </div>
        )}
        {runs.map((r) => (
          <div key={r.id}>
            <div onClick={() => setOpen(open === r.id ? null : r.id)}
                 style={{ display: "flex", gap: 10, alignItems: "baseline",
                          padding: "6px 0", borderTop: "1px solid var(--line)",
                          cursor: "pointer" }}>
              <span style={{ fontFamily: "var(--mono)", fontSize: 11,
                             color: "var(--muted)" }}>#{r.id}</span>
              <span style={{ fontSize: 12 }}>{r.device || `device ${r.device_id}`}</span>
              <span style={{ fontSize: 11, color: "var(--muted)" }}>{r.site}</span>
              <div style={{ flex: 1 }} />
              {r.shadow ? (
                <span style={{ fontSize: 10, color: "var(--info)",
                               textTransform: "uppercase", letterSpacing: 0.6 }}>shadow</span>
              ) : null}
              <span style={{ fontSize: 11, color: DECISION_COLOR[r.status] || "var(--fg-2)" }}>
                {r.status}
              </span>
            </div>
            {open === r.id && (
              <div style={{ padding: "4px 0 10px 20px" }}>
                <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 4 }}>
                  {r.trigger_reason}{r.message ? ` — ${r.message}` : ""}
                </div>
                <RunTrail runId={r.id} />
              </div>
            )}
          </div>
        ))}
      </Card>

      <Card title="Shadow report" kicker={report ? `last ${report.hours}h` : ""} tight>
        {!report ? <Loading what="report" /> : (
          <>
            <div style={{ fontSize: 11, color: "var(--muted)", lineHeight: 1.5,
                          marginBottom: 10 }}>
              {report.runs} run(s). If one guard dominates for a week, that is
              the fleet telling you the threshold is wrong — not that the engine
              is working.
            </div>
            <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 0.7,
                          color: "var(--muted)", marginTop: 8 }}>Refused by guard</div>
            {report.refused_by_guard.length === 0 && (
              <div style={{ fontSize: 12, color: "var(--muted)" }}>none</div>
            )}
            {report.refused_by_guard.map((g) => (
              <div key={g.guard} style={{ display: "flex", padding: "4px 0",
                                          borderTop: "1px solid var(--line)", fontSize: 12 }}>
                <span style={{ fontFamily: "var(--mono)", color: "var(--warn)" }}>{g.guard}</span>
                <div style={{ flex: 1 }} />
                <span style={{ fontFamily: "var(--mono)" }}>{g.count}</span>
              </div>
            ))}
            <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 0.7,
                          color: "var(--muted)", marginTop: 14 }}>Would have run</div>
            {report.would_run.length === 0 && (
              <div style={{ fontSize: 12, color: "var(--muted)" }}>none</div>
            )}
            {report.would_run.map((w) => (
              <div key={w.node_id} style={{ display: "flex", padding: "4px 0",
                                            borderTop: "1px solid var(--line)", fontSize: 12 }}>
                <span style={{ fontFamily: "var(--mono)", color: "var(--info)" }}>{w.node_id}</span>
                <div style={{ flex: 1 }} />
                <span style={{ fontFamily: "var(--mono)" }}>{w.count}</span>
              </div>
            ))}
          </>
        )}
      </Card>
    </div>
  );
}

function Proposals({ role }) {
  const [rows, setRows] = React.useState(null);
  const [busy, setBusy] = React.useState(null);
  const [error, setError] = React.useState(null);
  const canDecide = role === "admin" || role === "operator";

  const load = React.useCallback(() => {
    getJSON("/api/automation/proposals?status=pending")
      .then(setRows).catch((e) => setError(e.message));
  }, []);
  React.useEffect(load, [load]);

  const decide = async (id, verb) => {
    setBusy(id); setError(null);
    try {
      await postJSON(`/api/automation/proposals/${id}/${verb}`, {});
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  };

  if (error && !rows) return <ErrorMsg error={error} />;
  if (!rows) return <Loading what="proposals" />;

  return (
    <Card title="Awaiting approval"
          kicker={rows.length ? `${rows.length} pending` : "nothing pending"} tight>
      {error && <div style={{ marginBottom: 8 }}><ErrorMsg error={error} /></div>}
      {rows.length === 0 && (
        <div style={{ color: "var(--muted)", fontSize: 12, lineHeight: 1.5 }}>
          Nothing is waiting. Disruptive actions — anything that cuts power or
          reboots hardware — land here rather than firing on their own.
        </div>
      )}
      {rows.map((p) => (
        <div key={p.id} style={{ padding: "10px 0", borderTop: "1px solid var(--line)" }}>
          <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{p.label}</span>
            <span style={{ fontSize: 12, color: "var(--fg-2)" }}>
              {p.device || `device ${p.device_id}`}
            </span>
            <span style={{ fontSize: 11, color: "var(--muted)" }}>{p.site}</span>
            <div style={{ flex: 1 }} />
            <span style={{ fontFamily: "var(--mono)", fontSize: 11,
                           color: "var(--warn)" }}>{p.target}</span>
          </div>
          <div style={{ fontSize: 11, color: "var(--muted)", lineHeight: 1.5,
                        marginTop: 5 }}>
            {p.rationale}
          </div>
          <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>
            proposed by <span style={{ fontFamily: "var(--mono)" }}>{p.workflow}</span>
            {p.expires_at ? ` · expires ${p.expires_at}` : ""}
          </div>
          {canDecide && (
            <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
              <button type="button" disabled={busy === p.id}
                      onClick={() => decide(p.id, "approve")}
                      style={{ ...INPUT, width: "auto", cursor: "pointer",
                               background: "var(--warn)", color: "#1a1200",
                               borderColor: "transparent", fontWeight: 600 }}>
                Approve and run
              </button>
              <button type="button" disabled={busy === p.id}
                      onClick={() => decide(p.id, "dismiss")}
                      style={{ ...INPUT, width: "auto", cursor: "pointer",
                               background: "var(--bg-2)" }}>
                Dismiss
              </button>
            </div>
          )}
        </div>
      ))}
    </Card>
  );
}

// ───────────────────────── page ─────────────────────────

function WorkflowSwitch({ wf, role, onChanged }) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);
  if (role !== "admin") return null;

  const set = async (patch, confirmText) => {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true); setError(null);
    try {
      await postJSON(`/api/automation/workflows/${wf.id}/state`, patch);
      onChanged();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      <button type="button" disabled={busy}
              onClick={() => set({ enabled: !wf.enabled })}
              style={{ ...INPUT, width: "auto", cursor: "pointer",
                       background: wf.enabled ? "var(--bg-3)" : "var(--bg-2)" }}>
        {wf.enabled ? "Disable" : "Enable"}
      </button>
      <button type="button" disabled={busy}
              onClick={() => set(
                { shadow: !wf.shadow },
                wf.shadow
                  ? "Take this workflow out of shadow?\n\nIt will start acting on the "
                    + "fleet. Non-disruptive steps run on their own; anything that cuts "
                    + "power or reboots hardware still queues for approval."
                  : null,
              )}
              style={{ ...INPUT, width: "auto", cursor: "pointer",
                       background: wf.shadow ? "var(--bg-2)" : "var(--warn)",
                       color: wf.shadow ? "var(--fg)" : "#1a1200",
                       borderColor: "transparent" }}>
        {wf.shadow ? "Go live (leave shadow)" : "Back to shadow"}
      </button>
      {error && <span style={{ color: "var(--err)", fontSize: 11 }}>{error}</span>}
    </div>
  );
}

export default function EmptyState({ role, onSeeded }) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);
  const seed = async () => {
    setBusy(true); setError(null);
    try {
      await postJSON("/api/automation/seed", {});
      onSeeded();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="No workflows yet" tight>
      <div style={{ fontSize: 12, lineHeight: 1.6, color: "var(--fg-2)", maxWidth: 640 }}>
        NetMon ships one workflow: <b>camera down — remediation</b>. It triggers on
        Milestone reporting a camera down for 15 minutes, then asks whether the camera
        still answers ping. If it does, the VMS connection is the likely fault. If it
        answers nothing, it proposes a PoE cycle — but only on a port that was confirmed
        safe while the camera was healthy, and only when that port's switch is up.
        <div style={{ marginTop: 10, color: "var(--muted)" }}>
          It installs disabled and in shadow. Nothing happens until you enable it, and
          even then anything that cuts power or reboots hardware queues for your approval.
        </div>
      </div>
      {error && <div style={{ marginTop: 10 }}><ErrorMsg error={error} /></div>}
      {role === "admin" ? (
        <button type="button" onClick={seed} disabled={busy}
                style={{ ...INPUT, width: "auto", cursor: "pointer", marginTop: 12,
                         background: "var(--accent)", color: "#fff",
                         borderColor: "transparent" }}>
          {busy ? "Installing…" : "Install the camera workflow"}
        </button>
      ) : (
        <div style={{ marginTop: 12, fontSize: 11, color: "var(--muted)" }}>
          An admin can install it from here.
        </div>
      )}
    </Card>
  );
}

function AutomationPage() {
  const [meta, setMeta] = React.useState(null);
  const [list, setList] = React.useState(null);
  const [current, setCurrent] = React.useState(null);
  const [tab, setTab] = React.useState("editor");
  const [role, setRole] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [reload, setReload] = React.useState(0);

  React.useEffect(() => {
    getJSON("/auth/me").then((m) => setRole(m?.role || null)).catch(() => {});
  }, []);

  React.useEffect(() => {
    Promise.all([
      getJSON("/api/automation/meta"),
      getJSON("/api/automation/workflows"),
    ]).then(([m, ws]) => { setMeta(m); setList(ws); })
      .catch((e) => setError(e.message));
  }, [reload]);

  const selectedId = current ?? (list && list[0] ? list[0].id : null);
  const [detail, setDetail] = React.useState(null);
  React.useEffect(() => {
    if (!selectedId) { setDetail(null); return; }
    getJSON(`/api/automation/workflows/${selectedId}`)
      .then(setDetail).catch((e) => setError(e.message));
  }, [selectedId, reload]);

  if (error) return <ErrorMsg error={error} />;
  if (!meta || !list) return <Loading what="automation" />;

  const wf = list.find((w) => w.id === selectedId);
  const bump = () => setReload((n) => n + 1);

  const pills = [];
  if (!meta.enabled) {
    pills.push({ label: "engine", value: "off", severity: "warn" });
  }
  if (wf) {
    pills.push({ label: "workflow", value: wf.enabled ? "enabled" : "disabled",
                 severity: wf.enabled ? "ok" : "unknown" });
    pills.push({ label: "mode", value: wf.shadow ? "shadow" : "live",
                 severity: wf.shadow ? "info" : "warn" });
  }

  return (
    <div>
      <PageHeader title="Automation" pills={pills}>
        {wf && <WorkflowSwitch wf={wf} role={role} onChanged={bump} />}
      </PageHeader>

      {!meta.enabled && (
        <div style={{ margin: "0 0 12px", padding: "8px 12px", fontSize: 12,
                      lineHeight: 1.5, color: "var(--fg-2)",
                      background: "var(--bg-2)", borderRadius: "var(--r-2)",
                      borderLeft: "3px solid var(--warn)" }}>
          The automation task is not running: <span style={{ fontFamily: "var(--mono)" }}>
          [automation] enabled</span> is false, so nothing here is evaluated.
          Workflows can still be authored and reviewed.
        </div>
      )}

      {list.length > 1 && (
        <div style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap" }}>
          {list.map((w) => (
            <button key={w.id} type="button" onClick={() => setCurrent(w.id)}
                    style={{ ...INPUT, width: "auto", cursor: "pointer",
                             background: w.id === selectedId ? "var(--bg-3)" : "var(--bg-2)" }}>
              {w.title || w.name}
            </button>
          ))}
        </div>
      )}

      {wf && !wf.valid && (
        <div style={{ margin: "0 0 12px", padding: "8px 12px", fontSize: 12,
                      color: "var(--fg-2)", background: "var(--bg-2)",
                      borderRadius: "var(--r-2)", borderLeft: "3px solid var(--err)" }}>
          This graph does not validate, so the engine skips it:
          <span style={{ color: "var(--err)" }}> {wf.invalid_reason}</span>
        </div>
      )}

      <Tabs tabs={[
        { key: "editor", label: "Workflow" },
        { key: "proposals", label: "Approvals" },
        { key: "runs", label: "Runs" },
      ]} active={tab} onChange={setTab} />

      <div style={{ marginTop: 12 }}>
        {/* An empty list is a real state on a fresh install, not a load in
            progress — sitting on a spinner forever is how it used to read. */}
        {tab === "editor" && (list.length === 0
          ? <EmptyState role={role} onSeeded={bump} />
          : detail
            ? <Editor workflow={detail} meta={meta} role={role} onSaved={bump} />
            : <Loading what="workflow" />)}
        {tab === "proposals" && <Proposals role={role} />}
        {tab === "runs" && <Runs />}
      </div>
    </div>
  );
}
