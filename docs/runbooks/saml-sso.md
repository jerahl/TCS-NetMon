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

## Debug is off (normal operation) but a user is denied

A validated ClassLink user who maps to no role gets a 403 ("maps to no NetMon
role"). NetMon logs the attribute **names** that were present (values are
withheld — they may be PII) with a pointer to enable `saml_debug`. Turn debug
on briefly to see the values, fix the map, turn it back off.

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
