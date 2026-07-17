// HistoryChart (spec 10.6): fetch one series from the bounded /api/history ring
// buffer and render it as a labeled sparkline with the latest value. Degrades
// honestly — if history is disabled or the buffer is still filling, it shows a
// "no history yet" placeholder rather than a fake flat line.

import React from "react";
import { getJSON } from "./api.js";
import { Sparkline, sevColor } from "./primitives.jsx";

const REFRESH_MS = 60000;

export function HistoryChart({ series, label, color, hours = 24, format }) {
  const [points, setPoints] = React.useState(null);

  React.useEffect(() => {
    let live = true;
    const tick = () => {
      getJSON(`/api/history?series=${encodeURIComponent(series)}&hours=${hours}`)
        .then((d) => { if (live) setPoints((d.series && d.series[series]) || []); })
        .catch(() => { if (live) setPoints([]); });
    };
    tick();
    const id = setInterval(tick, REFRESH_MS);
    return () => { live = false; clearInterval(id); };
  }, [series, hours]);

  const last = points && points.length ? points[points.length - 1].value : null;
  const fmt = format || ((v) => (v == null ? "—" : String(Math.round(v))));

  return (
    <div className="hchart">
      <div className="hchart-head">
        <span className="hchart-label">{label}</span>
        <span className="hchart-last mono">{last == null ? "—" : fmt(last)}</span>
      </div>
      {points === null ? (
        <div className="spark-empty dim">…</div>
      ) : points.length >= 2 ? (
        <Sparkline points={points} color={color || sevColor("ok")} />
      ) : (
        <div className="spark-empty dim" title="Enable [history] to record trends">no history yet</div>
      )}
    </div>
  );
}
