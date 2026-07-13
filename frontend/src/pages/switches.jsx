import React from "react";
import { getJSON } from "../api.js";
import { Card, Badge, Dot, Loading, ErrorMsg } from "../primitives.jsx";

// Switches: every device_type=switch with its live ping/snmp/source state.
export function SwitchesPage() {
  const [rows, setRows] = React.useState(null);
  const [error, setError] = React.useState(null);

  React.useEffect(() => {
    getJSON("/api/status").then(setRows).catch(setError);
  }, []);

  if (error) return <ErrorMsg error={error} />;
  if (!rows) return <Loading what="switches" />;

  const switches = rows.filter((d) => d.device_type === "switch");

  return (
    <div className="page">
      <h1>Switches</h1>
      <Card kicker={`${switches.length} switch(es)`}>
        {switches.length === 0 ? (
          <div className="msg">No switches in the registry yet.</div>
        ) : (
          <table className="grid">
            <thead>
              <tr><th></th><th>Name</th><th>Site</th><th>Mgmt IP</th><th>Ping</th><th>SNMP</th><th>XIQ</th></tr>
            </thead>
            <tbody>
              {switches.map((d) => (
                <tr key={d.id}>
                  <td><Dot severity={d.source_status.severity} /></td>
                  <td><a href={`#/ap/${d.id}`}>{d.name}</a></td>
                  <td>{d.site || "—"}</td>
                  <td className="mono">{d.mgmt_ip || "—"}</td>
                  <td><Badge state={d.ping} /></td>
                  <td><Badge state={d.snmp} /></td>
                  <td><Badge state={d.source_status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
