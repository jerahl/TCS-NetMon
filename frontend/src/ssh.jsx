import React from "react";
import { getJSON } from "./api.js";

// SSHEASY launch affordance (jerahl/ssheasy) — an "SSH to this device" button
// that opens the web SSH client in an iframe, pre-targeting the device's
// management IP. Gated two ways:
//   * config: hidden unless [web] ssheasy_url is set (surfaced via /api/meta);
//   * role:   only operator/admin see it (viewers get read-only dashboards).
// NetMon never handles credentials — ssheasy prompts for the username/password
// in-terminal (connect=true auto-connects to the host, then asks). We only
// build a target URL with host+port, so read-only-first (§4.1) still holds.

// Cache the two static facts (meta URL, current role) across every button on a
// page so mounting a detail view costs one pair of GETs, not one per device.
let _factsPromise = null;
function loadFacts() {
  if (!_factsPromise) {
    _factsPromise = Promise.all([
      getJSON("/api/meta").catch(() => ({})),
      getJSON("/auth/me").catch(() => ({})),
    ]).then(([meta, me]) => ({
      ssheasyUrl: meta?.ssheasy_url || "",
      role: me?.role || null,
    }));
  }
  return _factsPromise;
}

const CAN_SSH = new Set(["operator", "admin"]);

// Build the embed URL. /terminal is ssheasy's chrome-free, iframe-first page
// (xterm.js + WASM client only). connect=true auto-connects to the host and
// then prompts for credentials in the terminal — we deliberately pass no user
// or password in the URL.
function embedUrl(base, host, port) {
  const q = new URLSearchParams({ host, port: String(port || 22), connect: "true" });
  return `${base}/terminal?${q.toString()}`;
}

export function SshButton({ host, name, port = 22 }) {
  const [facts, setFacts] = React.useState(null);
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    let live = true;
    loadFacts().then((f) => { if (live) setFacts(f); });
    return () => { live = false; };
  }, []);

  // Hidden when unconfigured, when the device has no address to target, or
  // when the viewer lacks the operator role.
  if (!facts || !facts.ssheasyUrl || !host || !CAN_SSH.has(facts.role)) return null;

  return (
    <React.Fragment>
      <button type="button" className="btn" title={`SSH to ${host} (opens SSHEASY)`}
              onClick={() => setOpen(true)}>⌘ SSH</button>
      {open && (
        <SshModal base={facts.ssheasyUrl} host={host} port={port} name={name}
                  onClose={() => setOpen(false)} />
      )}
    </React.Fragment>
  );
}

function SshModal({ base, host, port, name, onClose }) {
  const src = embedUrl(base, host, port);
  // Esc closes the console.
  React.useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="ssh-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="ssh-modal">
        <div className="ssh-modal-head">
          <span className="ssh-modal-title">SSH · {name || host} <span className="mono dim">{host}:{port}</span></span>
          <a className="ssh-modal-pop" href={src} target="_blank" rel="noopener noreferrer"
             title="Open in a new tab">↗</a>
          <button type="button" className="ssh-modal-close" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <iframe className="ssh-modal-frame" src={src} title={`SSH to ${host}`}
                allow="clipboard-read; clipboard-write" />
        <div className="ssh-modal-foot dim">
          Credentials are entered in the terminal — NetMon never stores or forwards them.
        </div>
      </div>
    </div>
  );
}
