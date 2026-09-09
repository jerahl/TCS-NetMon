# #108 — live `/hardware` payload evidence

**Captured:** 2026-09-02 · **Source:** `co-milestone.tcs.tusc.k12.al.us` Config API
**Method:** read-only `GET /hardware` via NetMon's existing Milestone credentials
(the `svczabbix` Basic user already configured for the NetMon collector — no new
credentials were needed, which matches what #108 predicted).
**Sanitised:** field names, types and counts only. No addresses, no usernames.

This is the thing the handoff said the fixtures do not have: a real `/hardware`
response rather than a shape inferred from NetMon's payload harness.

## The response

**2,489 records.** Twelve fields, all present on 100% of records:

| field | non-empty | type |
|---|---|---|
| `address` | 100% | str |
| `description` | **0%** | str |
| `displayName` | 100% | str |
| `enabled` | 100% | bool |
| `hardwareDriverPath` | 100% | dict (`{type, id}`) |
| `id` | 100% | str |
| `lastModified` | 100% | str |
| `model` | 100% | str (39 distinct) |
| `name` | 100% | str |
| `passwordLastModified` | 100% | str |
| `relations` | 100% | dict (`{parent, self}`, both dict) |
| `userName` | 100% | str |

`enabled` is `true` on all 2,489 — there is no disabled hardware to test against
on this estate today.

**There is no `mac` field.** Not absent-sometimes; absent from the schema. Any
addressing or correlation path that wants a MAC has to get it elsewhere. (NetMon
hit the same wall from the other side: `/cameras` has no `mac` either, so its
camera ⋈ FDB switch-port join has no key at all.)

## What `address` actually looks like — and the trap in it

Every one of the 2,489 is `http://<ipv4>/`:

- scheme: `http` on **100%**. Never `https`, never scheme-less, never a hostname.
- trailing slash: present on **100%**.
- explicit port: **6 records**, the rest default.

The six are the finding:

| port | count |
|---|---|
| `443` | 5 |
| `8080` | 1 |

**Five cameras are `http://<ipv4>:443/`.** That is an `http` scheme on the port
conventionally reserved for TLS. Two plausible parser shortcuts both get these
wrong:

- inferring the scheme from the port (`443 → https`) contradicts what the field
  actually says;
- taking the host by splitting on `:` and discarding the remainder silently
  drops a non-default port for 6 devices.

Whatever `addressing.py` currently does with these is the thing to check first —
this is precisely the fixtures-disagree-with-live case #108 exists to surface, and
it is a small enough set (6 of 2,489) to be invisible in any hand-built fixture.

## Also worth having

- `relations` carries `parent` **and** `self`, both dicts, on every record
  sampled. `parent` is the link NetMon uses to resolve camera → hardware
  (`relations.parent = {type: "hardware", id}`) after `hardwareId` turned out
  not to exist on `/cameras`.
- `hardwareDriverPath` is `{type, id}` — a reference, not a path string, despite
  the name.
- `userName` is populated on all 2,489; `description` on none.

## Caveats

- One point in time, one estate. Re-run before relying on the percentages.
- `/hardware` needed a **180 s** timeout at this size; ~2,500 records reliably
  hit `httpx.ReadTimeout` at a 30 s default against this gateway.
- This says nothing about `addressing.py` itself — that code is on the Windows
  workstation and was not reachable from the host this ran on. This is the
  *ground truth to check it against*, not the check.
