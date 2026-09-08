import React from "react";
import { getJSON, postJSON } from "../api.js";
import { Card, Loading, ErrorMsg, Dot, SourceBadge, sevColor } from "../primitives.jsx";
import { ageOf } from "../format.js";

// Bulk camera operations (spec 20 S8 / D11) — the admin surface for a firmware
// roll, and the only page in NetMon that can write to hardware.
//
// It is built to be read before it is used. Every gate that stands between a
// click here and a camera being flashed is stated at the top, in the order they
// are checked, with the closed ones tinted — because the honest answer to "why
// is the button disabled" is worth more than a button that works.
//
// The deliberate omissions:
//   * no config-change tab — the setting catalogue is deferred, so a button
//     there could only ever be refused;
//   * no "select all" — a firmware roll is many small batches by design, and
//     max_batch refuses the shortcut anyway;
//   * no image upload from here yet: an image is placed and then *registered*
//     as two acts, and the registration is where the model allow-list is typed.

const REFRESH_MS = 5000;

const ITEM_TONE = {
  verified: "ok",
  would_run: "",
  running: "warn",
  indeterminate: "warn",
  failed: "crit",
  skipped: "",
  pending: "",
};

function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v >= 1024 ** 3) return `${(v / 1024 ** 3).toFixed(1)} GiB`;
  if (v >= 1024 ** 2) return `${(v / 1024 ** 2).toFixed(0)} MiB`;
  return `${v} B`;
}

/** The gates, in the order the code checks them. Exported for the render check. */
export function GateStrip({ status }) {
  const gates = [
    { label: "[camera_ops] enabled", open: status.enabled,
      shut: "nothing can be sent" },
    { label: "firmware_update", open: status.firmware_update,
      shut: "firmware batches are refused" },
    { label: "live (not dry-run)", open: !status.dry_run,
      shut: "batches walk every check and send nothing" },
    { label: "camera account", open: status.account_configured,
      shut: "every camera is refused at pre-flight" },
    { label: status.proving_device_id
        ? `proving camera #${status.proving_device_id}`
        : "no proving restriction",
      open: !status.proving_device_id,
      shut: "only that one camera may be written to" },
  ];
  return (
    <div className="gate-strip">
      {gates.map((g) => (
        <span key={g.label} className={"gate " + (g.open ? "open" : "shut")}
              title={g.open ? "open" : g.shut}>
          <Dot severity={g.open ? "ok" : "warn"} />
          <span className="gl">{g.label}</span>
          <span className="gv">{g.open ? "open" : "closed"}</span>
        </span>
      ))}
    </div>
  );
}

/** One firmware image in the store. */
export function ImageRow({ image, selected, onSelect }) {
  return (
    <tr className={selected ? "sel" : ""} onClick={() => onSelect(image.id)}>
      <td><input type="radio" readOnly checked={!!selected} /></td>
      <td className="mono">{image.version}</td>
      <td className="mono dim">{image.platform || <span className="warn-text">not stated</span>}</td>
      <td className="mono dim" style={{ fontSize: 11 }}>{image.filename}</td>
      <td className="mono dim">{fmtBytes(image.size_bytes)}</td>
      <td style={{ fontSize: 11 }}>{(image.models || []).join(", ")}</td>
      <td className="mono dim" style={{ fontSize: 10 }}>
        {String(image.sha256 || "").slice(0, 12)}
      </td>
    </tr>
  );
}

/** The per-camera outcome table — the thing an operator reads at 7am. */
export function BatchItems({ items }) {
  if (!items || items.length === 0) return <div className="msg">No items.</div>;
  return (
    <table className="link-tbl">
      <thead>
        <tr>
          <th style={{ width: 22 }}></th><th>Camera</th><th>Ring</th><th>State</th>
          <th>Before</th><th>After</th><th>Verified by</th><th>Message</th>
        </tr>
      </thead>
      <tbody>
        {items.map((i) => (
          <tr key={i.id}>
            <td><Dot severity={ITEM_TONE[i.status] || "unknown"} /></td>
            <td>{i.name}<div className="dim mono" style={{ fontSize: 10 }}>{i.ip}</div></td>
            <td className="mono dim">{i.ring === 0 ? "canary" : i.ring}</td>
            <td className="mono">{i.status}</td>
            <td className="mono dim">{i.before_value || "—"}</td>
            <td className="mono">{i.after_value || "—"}</td>
            {/* Which read answered changes what the row is worth: the camera's
                own answer carries a build number, Milestone's is at most one
                backfill cycle old and often cannot prove one. */}
            <td className="mono dim">{i.verified_by || "—"}</td>
            <td style={{ fontSize: 11 }}>{i.message || ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function BatchCard({ batch, onAbort, busy }) {
  const done = batch.status === "done" || batch.status === "aborted";
  const counts = (batch.items || []).reduce((acc, i) => {
    acc[i.status] = (acc[i.status] || 0) + 1;
    return acc;
  }, {});
  return (
    <Card title={`Batch #${batch.id}`} source="netmon"
          kicker={`${batch.op} · ${batch.firmware_version || "—"} · ${batch.status}`
                  + (batch.dry_run ? " · DRY RUN" : "")}
          link={!done && onAbort ? undefined : undefined}>
      <div className="stat-row" style={{ marginBottom: 10 }}>
        {["verified", "indeterminate", "failed", "skipped", "would_run", "pending"]
          .filter((k) => counts[k])
          .map((k) => (
            <span key={k} className={"state-pill " + (
              k === "verified" ? "ok" : k === "failed" ? "err"
              : k === "indeterminate" ? "warn" : "")}>
              {counts[k]} {k}
            </span>
          ))}
        {!done && onAbort && (
          <button type="button" className="btn sm btn-warn" disabled={busy}
                  onClick={() => onAbort(batch.id)}
                  title="stops the batch progressing; it cannot interrupt an upload already in flight">
            Abort
          </button>
        )}
      </div>
      {batch.message && (
        <div className="msg" style={{ marginBottom: 10, color: sevColor("warn") }}>
          {batch.message}
        </div>
      )}
      <BatchItems items={batch.items} />
      {!batch.dry_run && (
        <div className="msg" style={{ fontSize: 11, marginTop: 10 }}>
          A camera is <b>verified</b> only when a read-back shows the new version.
          {" "}<b>indeterminate</b> means it answered in a form that cannot prove the
          build — the upgrade may well have worked, and a roll does not proceed on
          "probably", so the canary halts on it exactly as it does on a failure.
        </div>
      )}
    </Card>
  );
}

export function CameraOpsTab({ deviceIds = [], deviceNames = {} }) {
  const [status, setStatus] = React.useState(null);
  const [images, setImages] = React.useState(null);
  const [batches, setBatches] = React.useState(null);
  const [open, setOpen] = React.useState(null);      // batch detail
  const [imageId, setImageId] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [preview, setPreview] = React.useState(null);

  const load = React.useCallback(() => {
    getJSON("/api/surveillance/camera-ops").then(setStatus).catch(setError);
    getJSON("/api/surveillance/firmware").then(setImages).catch(() => setImages([]));
    getJSON("/api/surveillance/batches").then(setBatches).catch(() => setBatches([]));
  }, []);

  React.useEffect(() => {
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  React.useEffect(() => {
    if (!open) return undefined;
    let live = true;
    const tick = () => getJSON(`/api/surveillance/batches/${open.id}`)
      .then((b) => live && setOpen(b)).catch(() => {});
    const t = setInterval(tick, REFRESH_MS);
    return () => { live = false; clearInterval(t); };
  }, [open?.id]);

  async function act(fn) {
    setBusy(true);
    setError(null);
    try { await fn(); load(); } catch (e) { setError(e); } finally { setBusy(false); }
  }

  const createBatch = () => act(async () => {
    const r = await postJSON("/api/surveillance/batches", {
      op: "firmware_update", device_ids: deviceIds, firmware_id: imageId,
    });
    setPreview(r.preflight);
    const detail = await getJSON(`/api/surveillance/batches/${r.batch_id}`);
    setOpen(detail);
  });

  const startBatch = (id) => act(async () => {
    await postJSON(`/api/surveillance/batches/${id}/start`, {});
    setOpen(await getJSON(`/api/surveillance/batches/${id}`));
  });

  const abortBatch = (id) => act(async () => {
    await postJSON(`/api/surveillance/batches/${id}/abort`, {});
    setOpen(await getJSON(`/api/surveillance/batches/${id}`));
  });

  if (error) return <ErrorMsg error={error} />;
  if (!status || !images || !batches) return <Loading what="camera operations" />;

  return (
    <div>
      <Card title="Bulk camera operations" source="netmon"
            kicker="admin only · every gate below must be open before anything is sent">
        <GateStrip status={status} />
        <div className="msg" style={{ fontSize: 11, marginTop: 10 }}>
          This is the only page in NetMon that writes to hardware. A wrong image
          is a site visit, so the canary runs alone and the batch stops until it
          verifies; rings after it halt at {status.abort_pct}% failures; and no
          batch may exceed {status.max_batch} cameras — a full roll is many
          batches by design.
          {status.proving_device_id > 0 && (
            <> While a proving camera is set, every other camera is refused at
              pre-flight whatever a batch asks for.</>
          )}
        </div>
      </Card>

      <Card title="Firmware store" source="netmon"
            kicker={`${images.length} image(s) · place a file, then register it`} tight>
        {images.length === 0 ? (
          <div className="msg" style={{ padding: 14 }}>
            No images registered. Put the vendor's file in the store, then
            register it with the models and platform it is built for — that
            allow-list is what decides which cameras may ever receive it.
          </div>
        ) : (
          <table className="link-tbl">
            <thead>
              <tr><th style={{ width: 22 }}></th><th>Version</th><th>Platform</th>
                  <th>File</th><th>Size</th><th>Models allowed</th><th>SHA-256</th></tr>
            </thead>
            <tbody>
              {images.map((im) => (
                <ImageRow key={im.id} image={im} selected={imageId === im.id}
                          onSelect={setImageId} />
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title="New batch" source="netmon"
            kicker={`${deviceIds.length} camera(s) selected`}>
        {deviceIds.length === 0 ? (
          <div className="msg">
            Pick cameras from the navigator first. A batch names the cameras it
            will touch; there is no "everything" button.
          </div>
        ) : (
          <div>
            <div style={{ fontSize: 11, marginBottom: 8 }}>
              {deviceIds.map((id) => deviceNames[id] || `#${id}`).join(", ")}
            </div>
            <button type="button" className="btn" disabled={!imageId || busy}
                    onClick={createBatch}
                    title={imageId ? "creates the batch and pre-flights it; sends nothing"
                                   : "choose a firmware image first"}>
              Preview batch
            </button>
            {status.dry_run && (
              <span className="dim" style={{ fontSize: 11, marginLeft: 10 }}>
                config says dry-run, so this batch will send nothing whatever it says
              </span>
            )}
          </div>
        )}
        {preview && (
          <div style={{ marginTop: 12 }}>
            <div className="state-pill ok">{preview.allowed_count} allowed</div>{" "}
            <div className="state-pill warn">{preview.refused_count} refused</div>
            {preview.refused.length > 0 && (
              <table className="link-tbl" style={{ marginTop: 8 }}>
                <thead><tr><th>Camera</th><th>Why it will not be touched</th></tr></thead>
                <tbody>
                  {preview.refused.map((r) => (
                    <tr key={r.device_id}><td>{r.name}</td>
                      <td style={{ fontSize: 11 }}>{r.reason}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </Card>

      {open && (
        <React.Fragment>
          <BatchCard batch={open} onAbort={abortBatch} busy={busy} />
          {(open.status === "previewed" || open.status === "draft") && (
            <Card tight>
              <div style={{ padding: 12 }}>
                <button type="button" className={"btn " + (open.dry_run ? "" : "btn-danger")}
                        disabled={busy}
                        onClick={() => startBatch(open.id)}>
                  {open.dry_run ? "Run dry-run" : "Start — this writes to cameras"}
                </button>
                <span className="dim" style={{ fontSize: 11, marginLeft: 10 }}>
                  {open.dry_run
                    ? "walks every check and sends nothing"
                    : "the canary goes first and the batch stops until it verifies"}
                </span>
              </div>
            </Card>
          )}
        </React.Fragment>
      )}

      <Card title="Recent batches" source="netmon" kicker={`${batches.length} shown`} tight>
        {batches.length === 0 ? (
          <div className="msg" style={{ padding: 14 }}>Nothing has been run.</div>
        ) : (
          <table className="link-tbl">
            <thead>
              <tr><th>#</th><th>Op</th><th>Firmware</th><th>Status</th><th>Items</th>
                  <th>Verified</th><th>Created</th><th></th></tr>
            </thead>
            <tbody>
              {batches.map((b) => (
                <tr key={b.id}>
                  <td className="mono">{b.id}</td>
                  <td className="mono dim">{b.op}</td>
                  <td className="mono">{b.firmware_version || "—"}</td>
                  <td>
                    <span className={"state-pill " + (
                      b.status === "done" ? "ok" : b.status === "aborted" ? "err"
                      : b.status === "running" ? "warn" : "")}>
                      {b.status}{b.dry_run ? " · dry" : ""}
                    </span>
                  </td>
                  <td className="mono">{b.items}</td>
                  <td className="mono">{b.verified}</td>
                  <td className="mono dim">{ageOf(b.created_at)} ago</td>
                  <td>
                    <button type="button" className="linkish"
                            onClick={() => act(async () =>
                              setOpen(await getJSON(`/api/surveillance/batches/${b.id}`)))}>
                      open
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
