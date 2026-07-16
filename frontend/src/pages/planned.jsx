import React from "react";
import { Card } from "../primitives.jsx";

// Honest placeholder for routes whose pages are planned but not built yet
// (spec 11 §8 debt: #/xiq and #/wireless used to fall through to Global,
// which silently rendered the wrong page). Says what it is and when it lands —
// never fabricates data (§4.5).
export function PlannedPage({ title, phase, note }) {
  return (
    <div className="page">
      <h1>{title}</h1>
      <div className="subtitle">Planned — phase {phase}</div>
      <Card>
        <div className="msg">
          This page is part of the ZCD parity plan (spec 11) and lands in
          phase {phase}. {note}
        </div>
      </Card>
    </div>
  );
}
