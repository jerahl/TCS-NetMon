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
