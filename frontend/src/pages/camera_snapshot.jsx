import React from "react";
import { sevColor } from "../primitives.jsx";

// Camera stills, proxied (spec 20 S4 / D7).
//
// One component for the wall tile and one for the detail frame, sharing the
// load/failure handling — because the failure handling is the interesting part.
// A blank tile that might mean "camera down", might mean "proxy disabled" and
// might mean "NetMon does not know how to ask this model" is exactly what this
// page exists not to produce, so a failed still shows the server's reason.
//
// The reason arrives in an `X-NetMon-Reason` header, which an `<img>` cannot
// read — so these fetch the image themselves and turn it into a blob URL. That
// costs a little more than `<img src>` and buys the difference between "no
// picture" and "no picture *because*".

const snapshotUrl = (deviceId, size) =>
  `/api/surveillance/cameras/${encodeURIComponent(deviceId)}/snapshot?size=${size}`;

/**
 * Fetch one still. Returns {url, reason, loading}: `url` is an object URL to
 * revoke on unmount, `reason` is the server's explanation when there is none.
 */
export function useSnapshot(deviceId, size = "M", { skip = false } = {}) {
  const [state, setState] = React.useState({ url: null, reason: null, loading: !skip });

  React.useEffect(() => {
    if (skip || deviceId === undefined || deviceId === null) {
      setState({ url: null, reason: null, loading: false });
      return undefined;
    }
    let live = true;
    let objectUrl = null;
    setState({ url: null, reason: null, loading: true });

    fetch(snapshotUrl(deviceId, size), { credentials: "same-origin" })
      .then(async (resp) => {
        if (!live) return;
        if (!resp.ok) {
          setState({ url: null, loading: false,
                     reason: resp.headers.get("X-NetMon-Reason")
                       || `HTTP ${resp.status}` });
          return;
        }
        const blob = await resp.blob();
        if (!live) return;
        objectUrl = URL.createObjectURL(blob);
        setState({ url: objectUrl, reason: null, loading: false });
      })
      .catch((e) => {
        if (live) setState({ url: null, loading: false,
                             reason: String(e?.message || e) });
      });

    return () => {
      live = false;
      // Object URLs are a document-lifetime leak otherwise, and a camera wall
      // creates 48 of them per render.
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [deviceId, size, skip]);

  return state;
}

function tierTone(cam) {
  if (cam.source_status === "blind") return "warn";
  if (cam.reachability === "down_confirmed" || cam.reachability === "down_source_only") return "crit";
  if (cam.reachability === "down_network_only") return "warn";
  if (cam.reachability === "up") return "ok";
  return "unknown";
}

/** One tile on the camera wall. ZCD's `.cam-tile`. */
export function CamThumb({ cam, size = "M" }) {
  const tone = tierTone(cam);
  // Don't ask a camera both probes agree is gone: the fetch would sit for the
  // full timeout and 48 of those would stall the wall. Milestone-down cameras
  // ARE asked, because the network can still reach them and a still is the
  // quickest way to tell a platform problem from a dead camera.
  const hopeless = cam.reachability === "down_confirmed";
  const { url, reason, loading } = useSnapshot(cam.device_id, size, { skip: hopeless });

  return (
    <a className={"cam-tile " + (tone === "crit" ? "err" : tone === "warn" ? "warn" : "")}
       href={`#/cameras/${cam.device_id}`}
       title={`${cam.name}${cam.ip ? ` · ${cam.ip}` : ""}${cam.model ? ` · ${cam.model}` : ""}`}>
      {url ? (
        <img src={url} alt={`Still from ${cam.name}`} loading="lazy"
             style={{ position: "absolute", inset: 0, width: "100%", height: "100%",
                      objectFit: "cover" }} />
      ) : (
        <div className="cam-tile-note">
          {loading ? "…" : (hopeless ? "NO SIGNAL" : (reason || "no still"))}
        </div>
      )}
      <div className="scan" />
      <div className="id">{cam.name}</div>
      <div className="ts" style={{ color: sevColor(tone) }}>●</div>
    </a>
  );
}

/**
 * The 16:9 frame on the camera detail page. ZCD's `.live-large`, with the
 * overlays it puts in the corners — but the overlays carry facts NetMon has
 * (the camera's own name, its configured stream) rather than a fabricated
 * timestamp over a decorative gradient.
 */
export function CameraPreview({ cam, url: liveHref, size = "L" }) {
  const hopeless = cam.state?.reachability?.value === "down_confirmed";
  const { url, reason, loading } = useSnapshot(cam.device_id, size, { skip: hopeless });
  const stream = [cam.resolution, cam.fps_target ? `${cam.fps_target} fps` : null, cam.codec]
    .filter(Boolean).join(" · ");

  return (
    <div className="live-large" style={{ width: "100%", marginTop: 12 }}>
      {url ? (
        <img src={url} alt={`Still from ${cam.name}`}
             style={{ position: "absolute", inset: 0, width: "100%", height: "100%",
                      objectFit: "cover" }} />
      ) : (
        <div className="cam-preview-empty">
          <div className="cpe-title">{loading ? "Loading" : (hopeless ? "No signal" : "No preview")}</div>
          <div className="cpe-sub">
            {loading ? "fetching a still through NetMon"
              : hopeless ? "Both probes agree this camera is unreachable, so no still was requested."
              : (reason || "No still available.")}
            {liveHref && !loading ? " Use Open live view for the camera's own player." : ""}
          </div>
        </div>
      )}
      <div className="cam-preview-overlay tl">{cam.name}</div>
      {stream && <div className="cam-preview-overlay bl">{stream}</div>}
      {cam.recording_state === "up" && (
        <div className="cam-preview-overlay br">
          <span className="rec-dot" /> REC
        </div>
      )}
    </div>
  );
}
