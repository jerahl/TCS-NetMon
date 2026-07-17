# Runbook — SAML SSO (ClassLink) attribute mapping

NetMon is a SAML 2.0 Service Provider; ClassLink is the IdP. NetMon never
handles a password — it consumes the signed assertion, maps the role/group
claims to a NetMon role (`viewer` < `operator` < `admin`), and issues its own
session cookie. Config lives in `[auth]` of `/etc/netmon/netmon.conf`; the code
is `netmon/auth/saml.py` + `netmon/api/auth_routes.py`.

## The chicken-and-egg problem

You can't write the `saml_role_*` / `saml_group_*` maps until you know what
attribute **names** and **values** ClassLink actually releases — and those vary
by tenant and by how the app is configured in the ClassLink console. The
`saml_debug` switch breaks the deadlock: it shows you the real assertion.

## Discovering what ClassLink sends

1. In `/etc/netmon/netmon.conf`, under `[auth]`, set:

   ```ini
   saml_debug = true
   ```

   Restart NetMon. The log prints a warning while debug is on.

2. Sign in via **ClassLink** (`/login` → "Sign in with ClassLink"). After the
   IdP round-trip the ACS (`POST /auth/saml/acs`) renders a **SAML attribute
   debug page** instead of logging you in. It lists:
   - the NameID, NameID format, and SessionIndex;
   - **every attribute** the IdP released — name → value(s);
   - which attributes NetMon reads for roles/groups (`saml_role_attr` /
     `saml_group_attr`, default `role` / `group_ids`);
   - the role the current maps would grant this user (or "no NetMon role").

   No session is minted in this mode, so it is not a login backdoor.

3. Read off the real names and values. If the role/group claim comes over under
   a different attribute name than the defaults, point NetMon at it:

   ```ini
   saml_role_attr  = <the attribute carrying the role>
   saml_group_attr = <the attribute carrying group ids>
   ```

4. Map the values you saw to NetMon roles (comma-separated; highest granted
   role wins). By value:

   ```ini
   saml_role_admin    = Administrator, District Admin
   saml_role_operator = Network Operator
   saml_role_viewer   = Staff, Teacher
   ```

   or by group id:

   ```ini
   saml_group_admin    = 1001
   saml_group_operator = 1002
   ```

5. Set `saml_debug = false` and restart. Sign in via ClassLink again — you
   should now land in `/ui/` with the expected role. Confirm with
   `GET /auth/me`.

## "SAML authentication failed" (401 at the ACS)

This is a **validation** failure — the assertion was rejected *before* role
mapping (signature, audience, destination, clock skew, or an unassigned user),
so the attribute page above is never reached. With `saml_debug = false` the
browser only sees a generic 401 and the reason goes to the server log:

```
SAML ACS rejected: [<codes>] / <reason>
```

Set `saml_debug = true` and retry the login: the ACS then renders a **SAML
error page** with the human-readable reason, the OneLogin error codes, a
targeted hint for the common codes, a **side-by-side comparison** of what the
IdP sent (Audience, Destination, signature algorithm) against the `saml_sp_*`
config — mismatches are flagged inline — and the **decoded SAML response XML**.
No shell access to the logs needed. Common codes and fixes:

| Error code | Fix |
|---|---|
| `invalid_response_signature` | `saml_idp_x509cert` is wrong/stale, or the IdP isn't signing as expected. |
| `invalid_audience` | Assertion Audience ≠ `saml_sp_entity_id` — must match the ClassLink app's Entity ID exactly. |
| `invalid_destination` | Response Destination ≠ `saml_sp_acs_url` — check http vs https or a proxy rewriting host/path (set `x-forwarded-proto`). |
| `response_not_success` | IdP returned non-Success — the user may not be assigned to this app in ClassLink. |
| `assertion_expired` | Clock skew — check NTP on the NetMon host. |

## Debug is off (normal operation) but a user is denied

A validated ClassLink user who maps to no role gets a 403 ("maps to no NetMon
role"). NetMon logs the attribute **names** that were present (values are
withheld — they may be PII) with a pointer to enable `saml_debug`. Turn debug
on briefly to see the values, fix the map, turn it back off.

## ClassLink specifics (observed)

- The `Audience` ClassLink asserts is the **SP metadata URL** (`.../auth/saml/
  metadata`), so `saml_sp_entity_id` must be that exact URL — not the ACS URL,
  not the bare hostname. An `invalid_response` "…is not a valid audience"
  rejection is almost always this.
- ClassLink releases these attributes (NameFormat `basic`): `role`,
  `group_names` (comma-joined names, **not** `group_ids`), `email`, `name`,
  `login_id`. The NameID is a numeric ClassLink user id. So:
  - `saml_role_attr = role` (default) works; map the value with
    `saml_role_admin = admin`, etc.
  - For group-based mapping set `saml_group_attr = group_names` and map names,
    e.g. `saml_group_admin = ClassLink Admins, IT Staff`.
- ClassLink signs responses with **RSA-SHA1** (a response-level enveloped
  signature; the assertion itself is not separately signed). python3-saml 1.16
  accepts SHA-1 by default (`rejectDeprecatedAlgorithm` defaults off) and
  accepts a response-level signature, so no extra settings are needed — but do
  not enable `rejectDeprecatedAlgorithm`, or logins break until ClassLink moves
  to SHA-256.

## Break-glass

If ClassLink or the network is down, the local account still works
(`[auth] local_user` + `local_password_hash`, generated with
`python -m netmon.auth.local`). It is independent of SAML and of `saml_debug`.

## Safety notes

- `saml_debug` defaults to **off** and issues no session — it only ever reveals
  the requesting user's own assertion. Still, leave it off in normal operation:
  the page shows raw claim values (which may include names/emails/group ids).
- The debug page HTML-escapes every IdP-supplied value.
- Unlike the dev bypass, `saml_debug` is **not** refused when
  `secure_cookies=true`, because attribute mapping normally has to be done on
  the deployed HTTPS host where ClassLink actually posts. The startup warning is
  your reminder to turn it back off.
