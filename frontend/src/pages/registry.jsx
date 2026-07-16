import React from "react";
import { getJSON } from "../api.js";
import { Card, Loading, ErrorMsg, sevColor } from "../primitives.jsx";

// Registry admin (#/registry, admin only) — manage NetMon's own registry from
// the web: add/edit/delete sites, and pull switches/APs from XIQ. Writes go to
// NetMon's DB (not a source), gated by [security] allow_web_edit like Settings.

const TIERS = ["hub", "high", "middle", "elementary", "other"];
const BLANK = { name: "", display_name: "", tier: "other", lat: "", lon: "", enabled: true };

// Detail-aware request: surfaces the API's own error `detail` (e.g. "web
// editing is disabled", "N devices still assigned") instead of a bare
// "HTTP 400" — these messages are the point of the admin UX.
async function req(method, path, body) {
  const resp = await fetch(path, {
    method, credentials: "same-origin",
    headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (resp.status === 401) { window.location.assign("/login"); throw new Error("redirecting to sign in"); }
  if (!resp.ok) throw new Error((await resp.json().catch(() => ({}))).detail || `HTTP ${resp.status}`);
  return resp.status === 204 ? null : resp.json();
}

export function RegistryPage() {
  const [sites, setSites] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [edit, setEdit] = React.useState(null);      // {id?, ...fields} or null
  const [msg, setMsg] = React.useState(null);

  const load = React.useCallback(() => {
    getJSON("/api/registry/sites").then(setSites).catch(setError);
  }, []);
  React.useEffect(load, [load]);

  const save = async () => {
    setMsg(null);
    const body = {
      name: edit.name, display_name: edit.display_name || null, tier: edit.tier,
      lat: edit.lat === "" ? null : Number(edit.lat),
      lon: edit.lon === "" ? null : Number(edit.lon),
      enabled: !!edit.enabled,
    };
    try {
      if (edit.id) await req("PUT", `/api/registry/sites/${edit.id}`, body);
      else await req("POST", "/api/registry/sites", body);
      setEdit(null); setMsg({ ok: true, text: "Saved." }); load();
    } catch (e) { setMsg({ ok: false, text: String(e.message || e) }); }
  };

  const remove = async (s) => {
    setMsg(null);
    try { await req("DELETE", `/api/registry/sites/${s.id}`); setMsg({ ok: true, text: `Deleted ${s.name}.` }); load(); }
    catch (e) { setMsg({ ok: false, text: String(e.message || e) }); }
  };

  if (error) return <ErrorMsg error={error} />;
  if (!sites) return <Loading what="registry" />;

  return (
    <div className="page">
      <h1>Registry</h1>
      <div className="subtitle">Manage sites and import devices — writes to NetMon's own DB (admin, edit-gated).</div>

      {msg && <div className={"msg" + (msg.ok ? "" : " error")}>{msg.text}</div>}

      <XiqImport onDone={load} />

      <DeviceAssignments sites={sites} onDone={load} />

      <Card kicker={`${sites.length} site(s)`} title="Sites">
        <button type="button" className="btn" style={{ marginBottom: 10 }}
                onClick={() => { setEdit({ ...BLANK }); setMsg(null); }}>+ Add site</button>
        <table className="grid">
          <thead><tr><th>Name</th><th>Display</th><th>Tier</th><th>Lat/Lon</th><th>Devices</th><th>Enabled</th><th></th></tr></thead>
          <tbody>
            {sites.map((s) => (
              <tr key={s.id}>
                <td className="mono">{s.name}</td>
                <td>{s.display_name || "—"}</td>
                <td>{s.tier}</td>
                <td className="mono dim">{s.lat && s.lon ? `${s.lat}, ${s.lon}` : "—"}</td>
                <td className="mono">{s.device_count}</td>
                <td>{s.enabled ? "yes" : <span className="dim">no</span>}</td>
                <td>
                  <button type="button" className="btn" onClick={() => {
                    setEdit({ id: s.id, name: s.name, display_name: s.display_name || "",
                      tier: s.tier, lat: s.lat ?? "", lon: s.lon ?? "", enabled: !!s.enabled });
                    setMsg(null);
                  }}>Edit</button>
                  <button type="button" className="btn" style={{ marginLeft: 6 }}
                          onClick={() => remove(s)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {edit && (
        <Card title={edit.id ? `Edit site` : "Add site"}>
          <div className="reg-form">
            <label><span>Name (join key)</span>
              <input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></label>
            <label><span>Display name</span>
              <input value={edit.display_name} onChange={(e) => setEdit({ ...edit, display_name: e.target.value })} /></label>
            <label><span>Tier</span>
              <select value={edit.tier} onChange={(e) => setEdit({ ...edit, tier: e.target.value })}>
                {TIERS.map((t) => <option key={t} value={t}>{t}</option>)}
              </select></label>
            <label><span>Latitude</span>
              <input value={edit.lat} onChange={(e) => setEdit({ ...edit, lat: e.target.value })} placeholder="optional" /></label>
            <label><span>Longitude</span>
              <input value={edit.lon} onChange={(e) => setEdit({ ...edit, lon: e.target.value })} placeholder="optional" /></label>
            <label className="reg-check"><input type="checkbox" checked={edit.enabled}
              onChange={(e) => setEdit({ ...edit, enabled: e.target.checked })} /> <span>Enabled</span></label>
          </div>
          {edit.id && <div className="dim" style={{ fontSize: 11, margin: "6px 0" }}>
            Renaming re-points every device's site join key automatically.</div>}
          <button type="button" className="btn" onClick={save}>Save</button>
          <button type="button" className="btn" style={{ marginLeft: 6 }} onClick={() => setEdit(null)}>Cancel</button>
        </Card>
      )}
    </div>
  );
}

// Move switches/APs between sites — writes only devices.site. Filter the fleet
// by current site + type, select rows, then reassign the batch to a target
// site (or unassign). Re-loads the parent's site counts on success.
function DeviceAssignments({ sites, onDone }) {
  const [devices, setDevices] = React.useState(null);
  const [filterSite, setFilterSite] = React.useState("");   // "" = all
  const [filterType, setFilterType] = React.useState("");   // "" = all
  const [sel, setSel] = React.useState(() => new Set());
  const [target, setTarget] = React.useState("");
  const [msg, setMsg] = React.useState(null);
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(() => {
    setSel(new Set());
    getJSON("/api/registry/devices")
      .then(setDevices)
      .catch((e) => setMsg({ ok: false, text: String(e.message || e) }));
  }, []);
  React.useEffect(load, [load]);

  if (!devices) return <Card title="Device assignments"><Loading what="devices" /></Card>;

  const types = Array.from(new Set(devices.map((d) => d.device_type))).sort();
  const shown = devices.filter((d) =>
    (!filterSite || (filterSite === "__none__" ? !d.site : d.site === filterSite)) &&
    (!filterType || d.device_type === filterType));

  const toggle = (id) => setSel((s) => {
    const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n;
  });
  const allShownSelected = shown.length > 0 && shown.every((d) => sel.has(d.id));
  const toggleAll = () => setSel(() =>
    allShownSelected ? new Set() : new Set(shown.map((d) => d.id)));

  const move = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await req("POST", "/api/registry/devices/assign", {
        device_ids: [...sel],
        site: target === "__none__" ? null : target,
      });
      setMsg({ ok: true, text: `Moved ${r.count} device(s) to ${r.site || "no site"}.` });
      load(); onDone?.();
    } catch (e) { setMsg({ ok: false, text: String(e.message || e) }); }
    finally { setBusy(false); }
  };

  return (
    <Card kicker="Switches & APs" title="Device assignments">
      <div className="dim" style={{ marginBottom: 8 }}>
        Move devices between sites — writes only the <span className="mono">devices.site</span> join key.
      </div>
      <div className="reg-filters">
        <label><span>Site</span>
          <select value={filterSite} onChange={(e) => setFilterSite(e.target.value)}>
            <option value="">All sites</option>
            <option value="__none__">Unassigned</option>
            {sites.map((s) => <option key={s.id} value={s.name}>{s.name}</option>)}
          </select></label>
        <label><span>Type</span>
          <select value={filterType} onChange={(e) => setFilterType(e.target.value)}>
            <option value="">All types</option>
            {types.map((t) => <option key={t} value={t}>{t}</option>)}
          </select></label>
      </div>

      <table className="grid">
        <thead><tr>
          <th style={{ width: 24 }}><input type="checkbox" checked={allShownSelected} onChange={toggleAll} /></th>
          <th>Name</th><th>Type</th><th>Mgmt IP</th><th>Current site</th>
        </tr></thead>
        <tbody>
          {shown.slice(0, 500).map((d) => (
            <tr key={d.id}>
              <td><input type="checkbox" checked={sel.has(d.id)} onChange={() => toggle(d.id)} /></td>
              <td>{d.name}</td>
              <td className="dim">{d.device_type}</td>
              <td className="mono dim">{d.mgmt_ip || "—"}</td>
              <td>{d.site || <span className="dim">unassigned</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {shown.length > 500 && <div className="dim" style={{ fontSize: 11 }}>Showing first 500 of {shown.length} — narrow the filter.</div>}

      <div className="reg-move">
        <span className="dim">{sel.size} selected →</span>
        <select value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">Choose target…</option>
          <option value="__none__">Unassign</option>
          {sites.map((s) => <option key={s.id} value={s.name}>{s.name}</option>)}
        </select>
        <button type="button" className="btn" disabled={busy || !sel.size || !target} onClick={move}>Move</button>
      </div>
      {msg && <div className={"msg" + (msg.ok ? "" : " error")}>{msg.text}</div>}
    </Card>
  );
}

function XiqImport({ onDone }) {
  const [preview, setPreview] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState(null);

  const run = async (dry_run) => {
    setBusy(true); setMsg(null);
    try {
      const r = await req("POST", "/api/registry/import-xiq", { dry_run });
      if (dry_run) { setPreview(r); }
      else { setPreview(null); setMsg({ ok: true, text: `Imported: ${r.added} added, ${r.updated} updated.` }); onDone?.(); }
    } catch (e) { setMsg({ ok: false, text: String(e.message || e) }); }
    finally { setBusy(false); }
  };

  return (
    <Card kicker="ExtremeCloud IQ" title="Import switches & APs from XIQ">
      <div className="dim" style={{ marginBottom: 8 }}>
        Reads the XIQ fleet (read-only) and reconciles new switches/APs into the registry.
        Existing site assignments are preserved. Preview first.
      </div>
      <button type="button" className="btn" disabled={busy} onClick={() => run(true)}>Preview (dry run)</button>
      {preview && (
        <div style={{ marginTop: 10 }}>
          <div className="msg">
            Fetched {preview.fetched} · would add <b style={{ color: sevColor("ok") }}>{preview.would_add}</b> ·
            would update {preview.would_update}
          </div>
          {preview.new_devices?.length > 0 && (
            <table className="grid">
              <thead><tr><th>New device</th><th>Type</th><th>Site</th></tr></thead>
              <tbody>{preview.new_devices.map((d) => (
                <tr key={d.name}><td>{d.name}</td><td className="dim">{d.type}</td><td className="dim">{d.site}</td></tr>
              ))}</tbody>
            </table>
          )}
          <button type="button" className="btn" disabled={busy || !preview.would_add} style={{ marginTop: 8 }}
                  onClick={() => run(false)}>Apply import ({preview.would_add} new)</button>
        </div>
      )}
      {msg && <div className={"msg" + (msg.ok ? "" : " error")}>{msg.text}</div>}
    </Card>
  );
}
