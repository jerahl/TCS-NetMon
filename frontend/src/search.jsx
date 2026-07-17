// ⌘K command palette (spec 10 §6 / phase 10.5). A global overlay bound to
// Cmd/Ctrl-K (and "/") that queries /api/search — devices by name/IP,
// PacketFence endpoints by MAC/user/hostname, and FDB MACs by address — then
// hash-navigates to the chosen hit. Read-only, same-origin, no external calls.

import React from "react";
import { getJSON } from "./api.js";
import { SourceBadge } from "./primitives.jsx";

export function CommandPalette() {
  const [open, setOpen] = React.useState(false);
  const [q, setQ] = React.useState("");
  const [results, setResults] = React.useState(null);
  const [cursor, setCursor] = React.useState(0);
  const [busy, setBusy] = React.useState(false);
  const inputRef = React.useRef(null);

  // Global open/close hotkeys. ⌘K / Ctrl-K toggles; "/" opens when not already
  // typing in a field; Esc closes.
  React.useEffect(() => {
    const onKey = (ev) => {
      const k = ev.key;
      if ((ev.metaKey || ev.ctrlKey) && (k === "k" || k === "K")) {
        ev.preventDefault();
        setOpen((o) => !o);
      } else if (k === "Escape") {
        setOpen(false);
      } else if (k === "/" && !open) {
        const el = document.activeElement;
        const typing = el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
        if (!typing) { ev.preventDefault(); setOpen(true); }
      }
    };
    // A clickable entry point (nav button) dispatches this so the palette is
    // discoverable without knowing the hotkey.
    const onOpenEvent = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("netmon:open-search", onOpenEvent);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("netmon:open-search", onOpenEvent);
    };
  }, [open]);

  React.useEffect(() => {
    if (open) {
      setCursor(0);
      // Focus after the overlay mounts.
      setTimeout(() => inputRef.current && inputRef.current.focus(), 0);
    } else {
      setQ(""); setResults(null); setBusy(false);
    }
  }, [open]);

  // Debounced search as the query changes.
  React.useEffect(() => {
    if (!open) return;
    const query = q.trim();
    if (query.length < 2) { setResults(null); setBusy(false); return; }
    setBusy(true);
    let live = true;
    const id = setTimeout(() => {
      getJSON(`/api/search?q=${encodeURIComponent(query)}`)
        .then((r) => { if (live) { setResults(r); setCursor(0); setBusy(false); } })
        .catch(() => { if (live) { setResults(null); setBusy(false); } });
    }, 180);
    return () => { live = false; clearTimeout(id); };
  }, [q, open]);

  // Flatten the grouped hits into a single ordered list for arrow navigation.
  const flat = React.useMemo(() => {
    if (!results) return [];
    return [...results.devices, ...results.endpoints, ...results.macs];
  }, [results]);

  const go = (hit) => {
    if (hit && hit.href) window.location.hash = hit.href;
    setOpen(false);
  };

  const onInputKey = (ev) => {
    if (ev.key === "ArrowDown") { ev.preventDefault(); setCursor((c) => Math.min(c + 1, flat.length - 1)); }
    else if (ev.key === "ArrowUp") { ev.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); }
    else if (ev.key === "Enter") { ev.preventDefault(); go(flat[cursor]); }
  };

  if (!open) return null;

  return (
    <div className="cmdk-scrim" onMouseDown={() => setOpen(false)}>
      <div className="cmdk" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="cmdk-input"
          placeholder="Search devices, endpoints, MACs…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onInputKey}
        />
        <div className="cmdk-body">
          {q.trim().length < 2 ? (
            <div className="cmdk-hint">Type at least 2 characters. ↑↓ to move · ↵ to open · esc to close.</div>
          ) : busy && !results ? (
            <div className="cmdk-hint">Searching…</div>
          ) : !results || results.total === 0 ? (
            <div className="cmdk-hint">No matches for “{q.trim()}”.</div>
          ) : (
            <>
              <Group title="Devices" hits={results.devices} flat={flat} cursor={cursor} setCursor={setCursor} go={go} />
              <Group title="Endpoints (NAC)" hits={results.endpoints} flat={flat} cursor={cursor} setCursor={setCursor} go={go} />
              <Group title="MAC / FDB" hits={results.macs} flat={flat} cursor={cursor} setCursor={setCursor} go={go} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Group({ title, hits, flat, cursor, setCursor, go }) {
  if (!hits || hits.length === 0) return null;
  return (
    <div className="cmdk-group">
      <div className="cmdk-group-title">{title}</div>
      {hits.map((h) => {
        const idx = flat.indexOf(h);
        return (
          <div
            key={`${h.kind}:${h.title}:${idx}`}
            className={"cmdk-row" + (idx === cursor ? " active" : "")}
            onMouseEnter={() => setCursor(idx)}
            onClick={() => go(h)}
          >
            <SourceBadge source={h.badge} />
            <span className="cmdk-row-title">{h.title}</span>
            {h.subtitle && <span className="cmdk-row-sub mono dim">{h.subtitle}</span>}
          </div>
        );
      })}
    </div>
  );
}
