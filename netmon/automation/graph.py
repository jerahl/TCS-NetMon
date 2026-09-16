"""Workflow graph: a closed node registry and the validator that enforces it.

Spec 22 W5. A workflow is operator-supplied JSON that the engine will act on
unattended, so it gets the same treatment `netmon.actions` gives an action key:
**the graph names things from a closed registry and can never carry a payload.**
There is no node kind that takes a URL, a host, a credential, a CLI command, or
an rConfig snippet body. A node says "run the action `poe_cycle`"; what that
means is decided entirely by `netmon/actions.py` and the code behind it.

The practical consequence is that a compromised or fat-fingered graph row can
misroute a decision — which the guards in `netmon.automation.guards` then refuse
— but it cannot invent a new thing for NetMon to send.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from netmon.actions import ACTIONS

#: Every node kind. Adding one is a deliberate edit here plus a runner branch
#: plus a spec update — never a caller-supplied string.
NODE_KINDS = ("trigger", "branch", "action", "wait", "alert", "stop")

#: Predicates a `branch` may test. Each maps to a function in `runner._PREDICATES`
#: evaluated against facts NetMon already holds; none of them reach a source.
#: The label is what the editor and the shadow report show.
#: Phrased as questions, not statements. A run step records the question and
#: the answer together ("does it answer ping? - no"); a statement would read as
#: a claim the step then contradicts.
PREDICATES: dict[str, str] = {
    "ping_up": "does native ICMP say the device answers?",
    "ping_down": "does native ICMP say the device is silent?",
    "device_down": "does the down verdict survive the native-poller tiebreaker?",
    "source_blind": "was the federated source unreachable?",
    "port_memory_confirmed": "is a confirmed, PoE-safe access port remembered for this device?",
    "switch_up": "is the switch holding the remembered port itself up?",
    "still_down": "is the device still down on re-check?",
}

#: Dimensions a trigger may watch. `recording` is deliberately absent: it reads
#: `up` for all 2659 devices on this fleet (spec 22 §2a), so a trigger on it
#: would either never fire or fire on everything.
TRIGGER_DIMENSIONS = ("source_status", "ping", "snmp", "config_backup", "trunk")


class GraphError(ValueError):
    """The graph is not something the engine will run. Message is operator-facing."""


@dataclass(frozen=True)
class Node:
    id: str
    kind: str
    label: str
    config: dict[str, Any]


@dataclass(frozen=True)
class Edge:
    source: str
    target: str
    #: "true"/"false" out of a `branch`; None for an unconditional edge.
    when: str | None = None


@dataclass(frozen=True)
class Graph:
    nodes: dict[str, Node]
    edges: list[Edge]
    trigger_id: str

    @property
    def trigger(self) -> Node:
        return self.nodes[self.trigger_id]

    def next_ids(self, node_id: str, when: str | None = None) -> list[str]:
        """Targets of `node_id`, filtered to the branch arm taken.

        A non-branch node's edges carry no `when`, so the filter is a no-op for
        them; a branch with both arms wired returns exactly one.
        """
        out = []
        for e in self.edges:
            if e.source != node_id:
                continue
            if when is not None and e.when is not None and e.when != when:
                continue
            out.append(e.target)
        return out


def _str(value: Any) -> str:
    return str(value or "").strip()


def parse(doc: Any) -> Graph:
    """Validate a graph document and return it, or raise `GraphError`.

    Called on every write *and* on every read before a run — a row edited
    directly in the database gets the same scrutiny as one from the editor.
    """
    if isinstance(doc, (str, bytes)):
        try:
            doc = json.loads(doc)
        except ValueError as exc:
            raise GraphError(f"graph is not valid JSON: {exc}") from exc
    if not isinstance(doc, dict):
        raise GraphError("graph must be an object with 'nodes' and 'edges'")

    raw_nodes = doc.get("nodes")
    raw_edges = doc.get("edges", [])
    if not isinstance(raw_nodes, list) or not raw_nodes:
        raise GraphError("graph needs a non-empty 'nodes' list")
    if not isinstance(raw_edges, list):
        raise GraphError("graph 'edges' must be a list")

    nodes: dict[str, Node] = {}
    for raw in raw_nodes:
        if not isinstance(raw, dict):
            raise GraphError("every node must be an object")
        nid = _str(raw.get("id"))
        kind = _str(raw.get("kind"))
        if not nid:
            raise GraphError("every node needs an id")
        if nid in nodes:
            raise GraphError(f"duplicate node id {nid!r}")
        if kind not in NODE_KINDS:
            raise GraphError(f"node {nid!r}: unknown kind {kind!r} "
                             f"(known: {', '.join(NODE_KINDS)})")
        config = raw.get("config") or {}
        if not isinstance(config, dict):
            raise GraphError(f"node {nid!r}: 'config' must be an object")
        nodes[nid] = Node(id=nid, kind=kind, label=_str(raw.get("label")) or nid,
                          config=config)
        _validate_config(nodes[nid])

    triggers = [n.id for n in nodes.values() if n.kind == "trigger"]
    if len(triggers) != 1:
        raise GraphError(f"a workflow needs exactly one trigger node, found {len(triggers)}")

    edges: list[Edge] = []
    for raw in raw_edges:
        if not isinstance(raw, dict):
            raise GraphError("every edge must be an object")
        src, dst = _str(raw.get("source")), _str(raw.get("target"))
        when = _str(raw.get("when")) or None
        if src not in nodes:
            raise GraphError(f"edge from unknown node {src!r}")
        if dst not in nodes:
            raise GraphError(f"edge to unknown node {dst!r}")
        if src == dst:
            raise GraphError(f"node {src!r} cannot be wired to itself")
        if when is not None and when not in ("true", "false"):
            raise GraphError(f"edge {src}->{dst}: 'when' must be 'true' or 'false'")
        if when is not None and nodes[src].kind != "branch":
            raise GraphError(f"edge {src}->{dst}: only a branch node has true/false arms")
        edges.append(Edge(source=src, target=dst, when=when))

    graph = Graph(nodes=nodes, edges=edges, trigger_id=triggers[0])
    _reject_cycles(graph)
    return graph


def _validate_config(node: Node) -> None:
    cfg = node.config
    if node.kind == "trigger":
        dim = _str(cfg.get("dimension"))
        if dim not in TRIGGER_DIMENSIONS:
            raise GraphError(
                f"node {node.id!r}: trigger dimension {dim!r} is not one NetMon will "
                f"watch ({', '.join(TRIGGER_DIMENSIONS)}). Note `recording` is excluded "
                "on purpose — it reads 'up' for every device on this fleet.")
        if not _str(cfg.get("value")):
            raise GraphError(f"node {node.id!r}: trigger needs a 'value' to match")
        _positive_int(node, "min_duration_s", default=0)
    elif node.kind == "branch":
        pred = _str(cfg.get("predicate"))
        if pred not in PREDICATES:
            raise GraphError(f"node {node.id!r}: unknown predicate {pred!r} "
                             f"(known: {', '.join(sorted(PREDICATES))})")
    elif node.kind == "action":
        key = _str(cfg.get("action"))
        if key not in ACTIONS:
            # The closed registry is the point (W1/W5): a graph cannot name an
            # action that `netmon.actions` has not been taught, flagged and
            # audited.
            raise GraphError(f"node {node.id!r}: {key!r} is not a registered action "
                             f"(known: {', '.join(sorted(ACTIONS))})")
    elif node.kind == "wait":
        _positive_int(node, "seconds", default=300, required=True)
    elif node.kind == "alert":
        if not _str(cfg.get("summary")):
            raise GraphError(f"node {node.id!r}: alert needs a 'summary'")


def _positive_int(node: Node, key: str, *, default: int, required: bool = False) -> int:
    raw = node.config.get(key, default)
    try:
        value = int(raw)
    except (TypeError, ValueError) as exc:
        raise GraphError(f"node {node.id!r}: {key} must be a whole number") from exc
    if value < 0 or (required and value <= 0):
        raise GraphError(f"node {node.id!r}: {key} must be positive")
    return value


def _reject_cycles(graph: Graph) -> None:
    """A workflow must be a DAG.

    A cycle would let a graph loop an action forever — the per-device cooldown
    and fleet rate limit would eventually stop it, but "eventually stopped by a
    rate limit" is not a design. Refuse it at the door instead.
    """
    colour: dict[str, int] = {}  # 0 = visiting, 1 = done

    def visit(nid: str, trail: list[str]) -> None:
        state = colour.get(nid)
        if state == 1:
            return
        if state == 0:
            loop = " -> ".join(trail[trail.index(nid):] + [nid])
            raise GraphError(f"graph has a loop ({loop}); a workflow must not cycle")
        colour[nid] = 0
        for nxt in graph.next_ids(nid):
            visit(nxt, trail + [nid])
        colour[nid] = 1

    for node_id in graph.nodes:
        visit(node_id, [])
