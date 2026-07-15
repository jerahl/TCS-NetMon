// Same-origin JSON fetch helpers. The session cookie rides along automatically;
// no tokens in the client, no external hosts.

export class AuthError extends Error {}

export async function getJSON(path) {
  let resp;
  try {
    resp = await fetch(path, {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
  } catch (e) {
    throw new Error("network error contacting NetMon API");
  }
  if (resp.status === 401) {
    // Prompt for auth — send the browser to the login page (SSO + local).
    window.location.assign("/login");
    throw new AuthError("redirecting to sign in");
  }
  if (!resp.ok) throw new Error(`API HTTP ${resp.status}`);
  return resp.json();
}

// Build a query string from a filter object, dropping empty/null values so an
// unset filter is simply absent (the API treats absent = no filter).
export function qs(params) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== null && v !== undefined && v !== "") p.set(k, v);
  }
  const s = p.toString();
  return s ? `?${s}` : "";
}

// POST JSON (or no body) with the session cookie. Mirrors getJSON's 401 →
// /login handling so a write attempted after session expiry lands on sign-in
// rather than a silent failure.
export async function postJSON(path, body) {
  let resp;
  try {
    resp = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    throw new Error("network error contacting NetMon API");
  }
  if (resp.status === 401) {
    window.location.assign("/login");
    throw new AuthError("redirecting to sign in");
  }
  if (!resp.ok) throw new Error(`API HTTP ${resp.status}`);
  return resp.status === 204 ? null : resp.json();
}
