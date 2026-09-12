"""Stage 4: turn findings into a decision.

Deliberately dumb. If a judge or a CISO cannot read policy.yaml and predict the
outcome, the product is not auditable and nobody will deploy it.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import yaml

from . import config

DECISIONS = ("allow", "warn", "sanitize", "block")


@dataclass
class Decision:
    action: str
    rule: str
    message: str


class PolicyEngine:
    def __init__(self, path=config.POLICY_PATH):
        self.path = path
        self.reload()

    def reload(self) -> None:
        data: dict[str, Any] = yaml.safe_load(self.path.read_text(encoding="utf-8"))
        self.destinations = data.get("destinations", {})
        self.roles = data.get("roles", {})
        self.rules = data.get("rules", [])
        self._host_to_class = {
            host.lower(): klass
            for klass, hosts in self.destinations.items()
            for host in hosts
        }

    def classify_destination(self, destination: str) -> str:
        host = (destination or "").lower().strip()
        host = host.split("//")[-1].split("/")[0].split(":")[0]
        if host in self._host_to_class:
            return self._host_to_class[host]
        for known, klass in self._host_to_class.items():
            if host.endswith("." + known):
                return klass
        return "unknown"

    def clearance(self, role: str) -> int:
        return self.roles.get(role, self.roles.get("default", {"clearance": 2}))["clearance"]

    def evaluate(self, *, sensitivity: int, destination_class: str, role: str,
                 has_critical_secret: bool) -> Decision:
        for rule in self.rules:
            when = rule.get("when") or {}
            if when.get("has_critical_secret") and not has_critical_secret:
                continue
            if "min_sensitivity" in when and sensitivity < when["min_sensitivity"]:
                continue
            if "destinations" in when and destination_class not in when["destinations"]:
                continue
            if "roles" in when and role not in when["roles"]:
                continue
            return Decision(rule["then"], rule.get("name", "unnamed"), rule.get("message", ""))
        return Decision("allow", "fallthrough", "")


_engine: PolicyEngine | None = None


def get_engine() -> PolicyEngine:
    global _engine
    if _engine is None:
        _engine = PolicyEngine()
    return _engine
