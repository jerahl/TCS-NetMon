-- 032_automation_workflows.sql — automation workflow engine
-- (docs/spec/22-automation-workflows.md). Target: MariaDB 10.x, InnoDB, utf8mb4.
--
-- Five tables. Four of them exist to make an unattended write *reviewable*
-- after the fact; the fifth (device_port_memory) exists because the obvious
-- implementation is impossible.
--
--   * workflows            the graph, as the editor round-trips it. `enabled`
--                          defaults 0 and `shadow` defaults 1 — a workflow
--                          that appears in the UI does nothing until the owner
--                          says so twice (spec 22 W3, CLAUDE.md §4.2/§4.3).
--   * workflow_runs        one evaluation of one workflow against one device.
--   * workflow_run_steps   per-node outcome and the reason for it. This is the
--                          shadow trail: in shadow mode every action step
--                          records `would_run` plus exactly what it would have
--                          sent, which is what the owner reads before flipping
--                          shadow off. `action_audit_id` links a step that did
--                          fire to its row in the existing D4 audit table, so
--                          there is one trail, not two (spec 22 W1).
--   * action_proposals     the approval queue. Anything with
--                          ActionSpec.disruptive = 1 lands here instead of
--                          executing (spec 22 W2) — nothing cuts power or
--                          reboots hardware unattended.
--   * device_port_memory   which access port a device was last seen on *while
--                          it was healthy*.
--
-- Why device_port_memory has to exist, measured on this fleet 2026-09-11:
-- uplink_for_mac() resolves a PoE-cycle-safe port for 93% of healthy cameras
-- and 0% have no FDB entry; for the 82 cameras that are actually down, 79%
-- have no FDB entry at all and only 18% resolve safely. A camera that lost
-- power stops transmitting and the switch ages its MAC out within minutes, so
-- resolving the port at remediation time fails for precisely the devices
-- remediation exists for. The port is therefore recorded while the device is
-- healthy and read back when it dies.
--
-- rollback: DROP TABLE action_proposals; DROP TABLE workflow_run_steps;
--           DROP TABLE workflow_runs; DROP TABLE workflows;
--           DROP TABLE device_port_memory;
--           (no other table references these; nothing else reads them)

CREATE TABLE IF NOT EXISTS workflows (
    id           BIGINT       NOT NULL AUTO_INCREMENT,
    name         VARCHAR(128) NOT NULL,               -- stable key, also the audit actor suffix
    title        VARCHAR(255) NULL,
    description  TEXT         NULL,
    -- The React Flow document: {"nodes": [...], "edges": [...]}. Operator-
    -- supplied data, validated against the closed node registry on every read
    -- and write (spec 22 W5) — it can never carry a URL, host or command.
    graph        LONGTEXT     NOT NULL,
    -- Both default to the safe value. enabled=0: the runner skips it entirely.
    -- shadow=1: it evaluates fully and records would_run, sending nothing.
    enabled      TINYINT(1)   NOT NULL DEFAULT 0,
    shadow       TINYINT(1)   NOT NULL DEFAULT 1,
    version      INT          NOT NULL DEFAULT 1,     -- bumped on every graph edit
    created_by   VARCHAR(128) NULL,
    created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_workflows_name (name),
    KEY idx_workflows_enabled (enabled)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS workflow_runs (
    id               BIGINT       NOT NULL AUTO_INCREMENT,
    workflow_id      BIGINT       NOT NULL,
    -- Recorded per run: reading a six-week-old run against today's graph would
    -- otherwise misattribute what the engine actually decided.
    workflow_version INT          NOT NULL DEFAULT 1,
    device_id        BIGINT       NULL,               -- one device per run (spec 22 W9)
    trigger_reason   VARCHAR(255) NULL,               -- "source_status=down held 18m"
    status           ENUM('running','done','refused','failed','awaiting_approval')
                     NOT NULL DEFAULT 'running',
    shadow           TINYINT(1)   NOT NULL DEFAULT 1, -- what this run actually was
    message          VARCHAR(500) NULL,
    started_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    finished_at      DATETIME     NULL DEFAULT NULL,
    PRIMARY KEY (id),
    KEY idx_wf_runs_wf (workflow_id, started_at),
    -- The W9 idempotence lookup: "does this device already have a live run?"
    KEY idx_wf_runs_device (device_id, status),
    KEY idx_wf_runs_status (status, started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS workflow_run_steps (
    id              BIGINT       NOT NULL AUTO_INCREMENT,
    run_id          BIGINT       NOT NULL,
    seq             INT          NOT NULL,            -- execution order within the run
    node_id         VARCHAR(64)  NOT NULL,            -- graph node id
    node_kind       VARCHAR(32)  NOT NULL,            -- closed registry (spec 22 W5)
    label           VARCHAR(255) NULL,
    -- would_run is the shadow outcome and the whole point of the table.
    -- refused carries a guard name in `detail` (G1..G10, spec 22 §5).
    decision        ENUM('taken','skipped','would_run','refused','failed','awaiting_approval')
                    NOT NULL,
    detail          VARCHAR(1000) NULL,               -- the reason, in operator English
    -- Set only when the step actually called a source, linking into the D4
    -- audit trail rather than duplicating it (spec 22 W1).
    action_audit_id BIGINT UNSIGNED NULL,
    at              DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_wf_steps_run (run_id, seq),
    KEY idx_wf_steps_decision (decision, at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS action_proposals (
    id          BIGINT       NOT NULL AUTO_INCREMENT,
    run_id      BIGINT       NULL,
    workflow_id BIGINT       NULL,
    device_id   BIGINT       NULL,
    action      VARCHAR(64)  NOT NULL,                -- a key in netmon.actions.ACTIONS
    target      VARCHAR(128) NULL,                    -- "port 1:14", a MAC, …
    params      TEXT         NULL,                    -- JSON, credential-sanitised
    -- Everything an operator needs to decide without leaving the page: which
    -- port, why it is believed to be the access port, how old that evidence
    -- is, and what else is down at the same site.
    rationale   TEXT         NULL,
    status      ENUM('pending','approved','dismissed','expired','executed','failed')
                NOT NULL DEFAULT 'pending',
    expires_at  DATETIME     NULL DEFAULT NULL,
    created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    decided_by  VARCHAR(128) NULL,
    decided_at  DATETIME     NULL DEFAULT NULL,
    action_audit_id BIGINT UNSIGNED NULL,             -- set once executed
    PRIMARY KEY (id),
    KEY idx_proposals_status (status, created_at),
    -- W9 idempotence: one pending proposal per device+action, not one per cycle.
    KEY idx_proposals_device (device_id, action, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS device_port_memory (
    device_id        BIGINT       NOT NULL,           -- the powered device (camera, AP)
    switch_device_id BIGINT       NOT NULL,           -- devices.id of the switch
    ifindex          INT          NULL,
    port             VARCHAR(64)  NULL,               -- SNMP spelling, e.g. "1:14"
    -- Copied from uplink_for_mac() at confirmation time, not recomputed later:
    -- the question "was this a confirmed access port when we could still see
    -- it?" is the one the PoE guard (G5) actually needs to answer.
    poe_cycle_safe   TINYINT(1)   NOT NULL DEFAULT 0,
    why              VARCHAR(255) NULL,
    macs_on_port     INT          NULL,
    mac              VARCHAR(32)  NULL,               -- what was resolved, for tracing
    -- Last time this was resolved from a live FDB while the device was healthy.
    -- G5 refuses a PoE cycle when this is older than
    -- [automation] require_port_confirmed_within_s.
    confirmed_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (device_id),
    KEY idx_portmem_switch (switch_device_id, ifindex),
    KEY idx_portmem_confirmed (confirmed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
