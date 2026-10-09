import React from "react";

// Small dependency-free charts for the Helpdesk dashboard and triage board
// (spec 25 §12). SVG for the line chart, CSS bars for the rest — the bundle
// gains no chart library.

export function shortDate(iso) {
  if (!iso) return "";
  const [y, m, d] = String(iso).slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString([], { month: "short", day: "numeric" });
}

/** Multi-series line chart. series: [{name, color, values}] aligned to labels. */
export function LineChart({ labels, series, height = 220 }) {
  const W = 640, H = height, L = 34, R = 10, T = 12, B = 26;
  const max = Math.max(1, ...series.flatMap((s) => s.values));
  const step = Math.pow(10, Math.floor(Math.log10(max)));
  const top = Math.ceil(max / step) * step;
  const x = (i) => L + (labels.length < 2 ? 0 : (i * (W - L - R)) / (labels.length - 1));
  const y = (v) => T + (H - T - B) * (1 - v / top);
  const ticks = [0, top / 2, top];
  const every = Math.max(1, Math.ceil(labels.length / 10));
  return (
    <div className="hdc-line">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={series.map((s) => s.name).join(" vs ")}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} className="hdc-grid" />
            <text x={L - 6} y={y(t) + 3} className="hdc-axis" textAnchor="end">{Math.round(t)}</text>
          </g>
        ))}
        {labels.map((l, i) => (i % every === 0 || i === labels.length - 1) && (
          <text key={i} x={x(i)} y={H - 8} className="hdc-axis" textAnchor="middle">{l}</text>
        ))}
        {series.map((s) => (
          <g key={s.name}>
            <polyline fill="none" stroke={s.color} strokeWidth="2"
                      points={s.values.map((v, i) => `${x(i)},${y(v)}`).join(" ")} />
            {s.values.map((v, i) => (
              <circle key={i} cx={x(i)} cy={y(v)} r="2.6" fill={s.color}>
                <title>{`${labels[i]} · ${s.name}: ${v}`}</title>
              </circle>
            ))}
          </g>
        ))}
      </svg>
      <div className="hdc-legend">
        {series.map((s) => (
          <span key={s.name}><i style={{ background: s.color }} />{s.name}</span>
        ))}
      </div>
    </div>
  );
}

/** Horizontal bars: rows [{label, value, hi, href}]. */
export function HBars({ rows, empty = "Nothing to show." }) {
  if (!rows.length) return <div className="msg">{empty}</div>;
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="hdc-hbars">
      {rows.map((r) => (
        <div className="hdc-hrow" key={r.label}>
          <div className="hdc-htop"><span className="hdc-hl" title={r.label}>{r.label}</span>
            <span className="hdc-hv">{r.value}</span></div>
          <div className="hdc-track"><div className={"hdc-fill" + (r.hi ? " hi" : "")}
                                          style={{ width: `${(r.value / max) * 100}%` }} /></div>
        </div>
      ))}
    </div>
  );
}

/** Vertical bars: rows [{label, value, dim}]. */
export function ColBars({ rows, height = 140 }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="hdc-cols" style={{ height }}>
      {rows.map((r, i) => (
        <div className="hdc-col" key={i} title={`${r.label}: ${r.value}`}>
          <div className="hdc-cv">{r.value}</div>
          <div className="hdc-barwrap">
            <div className={"hdc-bar" + (r.dim ? " dim" : "")}
                 style={{ height: `${Math.max(2, (r.value / max) * 100)}%` }} />
          </div>
          <div className="hdc-cl">{r.label}</div>
        </div>
      ))}
    </div>
  );
}
