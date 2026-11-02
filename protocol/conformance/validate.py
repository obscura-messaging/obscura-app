#!/usr/bin/env python3
"""Self-contained well-formedness validator for client conformance vectors.

This repository guarantees that vector artifacts are coherent (valid JSON,
expected structure, no orphan files, contract cross-referenced). Each platform
suite verifies that its codec satisfies the vectors.

Runs with only the Python stdlib. Collects every violation, then exits non-zero
so an author sees all problems at once.

    python3 protocol/conformance/validate.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

CONFORMANCE_DIR = Path(__file__).resolve().parent
CONTRACT = CONFORMANCE_DIR.parents[1] / "docs" / "KIT_API.md"

# The vector files this validator knows how to check. Adding a new behavior
# class is a deliberate act: register its file + a checker here (fail-loud).
KNOWN_FILES = {"wire", "link"}


class Report:
    """Accumulates violations with a file/context path prefix."""

    def __init__(self) -> None:
        self.errors: list[str] = []

    def err(self, where: str, msg: str) -> None:
        self.errors.append(f"{where}: {msg}")

    def is_str(self, where: str, obj: dict, key: str, *, allow_none: bool = False) -> bool:
        if key not in obj:
            self.err(where, f"missing required key '{key}'")
            return False
        v = obj[key]
        if v is None and allow_none:
            return True
        if not isinstance(v, str) or (v == "" and not allow_none):
            self.err(where, f"'{key}' must be a non-empty string, got {v!r}")
            return False
        return True

    def is_dict(self, where: str, obj: dict, key: str) -> bool:
        if key not in obj:
            self.err(where, f"missing required key '{key}'")
            return False
        if not isinstance(obj[key], dict):
            self.err(where, f"'{key}' must be an object, got {type(obj[key]).__name__}")
            return False
        return True

    def is_nonempty_list(self, where: str, obj: dict, key: str) -> bool:
        if key not in obj:
            self.err(where, f"missing required key '{key}'")
            return False
        if not isinstance(obj[key], list) or not obj[key]:
            self.err(where, f"'{key}' must be a non-empty array")
            return False
        return True

    def only_keys(self, where: str, obj: dict, allowed: set[str]) -> None:
        extra = set(obj) - allowed
        if extra:
            self.err(where, f"unexpected key(s) {sorted(extra)}; allowed: {sorted(allowed)}")


def _check_common(rep: Report, where: str, doc: dict, expected_kind: str) -> None:
    if doc.get("version") != 1:
        rep.err(where, f"'version' must be the integer 1, got {doc.get('version')!r}")
    if doc.get("kind") != expected_kind:
        rep.err(where, f"'kind' must be '{expected_kind}', got {doc.get('kind')!r}")
    if "description" in doc and not isinstance(doc["description"], str):
        rep.err(where, "'description' must be a string when present")


def _unique_names(rep: Report, where: str, cases: list) -> None:
    seen: set[str] = set()
    for i, case in enumerate(cases):
        name = case.get("name") if isinstance(case, dict) else None
        if isinstance(name, str) and name in seen:
            rep.err(where, f"duplicate case name {name!r} (index {i}); names must be unique")
        if isinstance(name, str):
            seen.add(name)


def check_wire(rep: Report, doc: dict) -> None:
    f = "wire.json"
    _check_common(rep, f, doc, "wire")
    rep.only_keys(f, doc, {"version", "kind", "description", "messageTypes", "typingStates", "roundTrip"})
    for mapping in ("messageTypes", "typingStates"):
        if rep.is_nonempty_list(f, doc, mapping):
            for i, m in enumerate(doc[mapping]):
                w = f"{f} {mapping}[{i}]"
                if not isinstance(m, dict):
                    rep.err(w, "must be an object")
                    continue
                rep.only_keys(w, m, {"wire", "app"})
                rep.is_str(w, m, "wire")
                rep.is_str(w, m, "app")
    if rep.is_nonempty_list(f, doc, "roundTrip"):
        _unique_names(rep, f + " roundTrip", doc["roundTrip"])
        for i, rt in enumerate(doc["roundTrip"]):
            w = f"{f} roundTrip[{i}] ({rt.get('name', '?')})"
            if not isinstance(rt, dict):
                rep.err(w, "must be an object")
                continue
            rep.only_keys(w, rt, {"name", "appEntry"})
            rep.is_str(w, rt, "name")
            if rep.is_dict(w, rt, "appEntry"):
                ms = rt["appEntry"]
                rep.only_keys(w + " appEntry", ms, {"model", "id", "timestamp", "data"})
                rep.is_str(w + " appEntry", ms, "model")
                rep.is_str(w + " appEntry", ms, "id")
                rep.is_dict(w + " appEntry", ms, "data")
                if not isinstance(ms.get("timestamp"), (int, float)) or isinstance(ms.get("timestamp"), bool):
                    rep.err(w + " appEntry", f"'timestamp' must be a number, got {ms.get('timestamp')!r}")


def _is_hex(rep: Report, where: str, obj: dict, key: str, length: int | None = None) -> None:
    v = obj.get(key)
    if not isinstance(v, str) or len(v) % 2 or any(c not in "0123456789abcdef" for c in v):
        rep.err(where, f"'{key}' must be lowercase hex, got {v!r}")
    elif length is not None and len(v) != 2 * length:
        rep.err(where, f"'{key}' must be {length} bytes, got {len(v) // 2}")


def _is_uint(rep: Report, where: str, obj: dict, key: str) -> None:
    v = obj.get(key)
    if not isinstance(v, int) or isinstance(v, bool) or not 0 <= v < 2**53:
        rep.err(where, f"'{key}' must be an integer in [0, 2^53), got {v!r}")


FRIEND_STATUSES = {"FRIEND_STATUS_PENDING_SENT", "FRIEND_STATUS_PENDING_RECEIVED", "FRIEND_STATUS_ACCEPTED"}


def check_link(rep: Report, doc: dict) -> None:
    f = "link.json"
    _check_common(rep, f, doc, "link")
    rep.only_keys(f, doc, {"version", "kind", "description", "envelopes", "linkCodes"})
    if rep.is_nonempty_list(f, doc, "envelopes"):
        _unique_names(rep, f + " envelopes", doc["envelopes"])
        for i, e in enumerate(doc["envelopes"]):
            w = f"{f} envelopes[{i}]"
            if not isinstance(e, dict):
                rep.err(w, "must be an object")
                continue
            rep.only_keys(w, e, {"name", "newDevicePrivateKey", "newDevicePublicKey", "primaryPrivateKey",
                                 "primaryPublicKey", "sharedSecret", "key", "nonce", "linkBundle", "plaintext",
                                 "ciphertext", "linkEnvelope"})
            rep.is_str(w, e, "name")
            for k in ("newDevicePrivateKey", "primaryPrivateKey", "sharedSecret", "key"):
                _is_hex(rep, w, e, k, 32)
            for k in ("newDevicePublicKey", "primaryPublicKey"):
                _is_hex(rep, w, e, k, 33)
            _is_hex(rep, w, e, "nonce", 12)
            for k in ("plaintext", "ciphertext", "linkEnvelope"):
                _is_hex(rep, w, e, k)
            if not rep.is_dict(w, e, "linkBundle"):
                continue
            b, wb = e["linkBundle"], w + " linkBundle"
            rep.only_keys(wb, b, {"identityPrivateKey", "identityPublicKey", "identityKeyPair", "userId", "username",
                                  "primaryDeviceId", "friendListVersion", "friends", "history"})
            _is_hex(rep, wb, b, "identityPrivateKey", 32)
            _is_hex(rep, wb, b, "identityPublicKey", 33)
            _is_hex(rep, wb, b, "identityKeyPair")
            rep.is_str(wb, b, "userId")
            rep.is_str(wb, b, "username")
            rep.is_str(wb, b, "primaryDeviceId")
            _is_uint(rep, wb, b, "friendListVersion")
            if not isinstance(b.get("friends"), list):
                rep.err(wb, "'friends' must be an array")
            else:
                for j, fr in enumerate(b["friends"]):
                    wf = f"{wb} friends[{j}]"
                    if not isinstance(fr, dict):
                        rep.err(wf, "must be an object")
                        continue
                    rep.only_keys(wf, fr, {"userId", "username", "status"})
                    rep.is_str(wf, fr, "userId")
                    rep.is_str(wf, fr, "username")
                    if fr.get("status") not in FRIEND_STATUSES:
                        rep.err(wf, f"'status' must be one of {sorted(FRIEND_STATUSES)}")
            if "history" in b and rep.is_dict(wb, b, "history"):
                h = b["history"]
                rep.only_keys(wb + " history", h, {"attachmentId", "contentKey", "nonce"})
                rep.is_str(wb + " history", h, "attachmentId")
                _is_hex(rep, wb + " history", h, "contentKey", 32)
                _is_hex(rep, wb + " history", h, "nonce", 12)
    if rep.is_nonempty_list(f, doc, "linkCodes"):
        _unique_names(rep, f + " linkCodes", doc["linkCodes"])
        for i, c in enumerate(doc["linkCodes"]):
            w = f"{f} linkCodes[{i}]"
            if not isinstance(c, dict):
                rep.err(w, "must be an object")
                continue
            rep.only_keys(w, c, {"name", "sessionId", "ephemeralPublicKey", "deviceName", "code"})
            for k in ("name", "sessionId", "deviceName", "code"):
                rep.is_str(w, c, k)
            _is_hex(rep, w, c, "ephemeralPublicKey", 33)
            code = c.get("code")
            if isinstance(code, str) and (set(code) - set(BASE64URL) or "=" in code):
                rep.err(w, "'code' must be base64url without padding")


BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"


CHECKERS = {
    "wire": check_wire,
    "link": check_link,
}


def main() -> int:
    rep = Report()

    present = {p.stem for p in CONFORMANCE_DIR.glob("*.json")}
    orphans = present - KNOWN_FILES
    for stem in sorted(orphans):
        rep.err(f"{stem}.json", "unknown vector file — register it in validate.py and KIT_API.md")
    missing = KNOWN_FILES - present
    for stem in sorted(missing):
        rep.err(f"{stem}.json", "expected vector file is missing")

    contract_text = CONTRACT.read_text() if CONTRACT.exists() else ""
    if not CONTRACT.exists():
        rep.err("KIT_API.md", "kit contract not found under docs/")

    for stem in sorted(KNOWN_FILES & present):
        path = CONFORMANCE_DIR / f"{stem}.json"
        try:
            doc = json.loads(path.read_text())
        except json.JSONDecodeError as e:
            rep.err(f"{stem}.json", f"invalid JSON: {e}")
            continue
        if not isinstance(doc, dict):
            rep.err(f"{stem}.json", "top level must be a JSON object")
            continue
        CHECKERS[stem](rep, doc)
        if f"{stem}.json" not in contract_text:
            rep.err(f"{stem}.json", "not referenced anywhere in KIT_API.md")

    if rep.errors:
        print(f"conformance vectors INVALID — {len(rep.errors)} problem(s):\n", file=sys.stderr)
        for e in rep.errors:
            print(f"  ✗ {e}", file=sys.stderr)
        return 1

    print(f"conformance vectors OK — {len(KNOWN_FILES & present)} files well-formed and spec-referenced")
    return 0


if __name__ == "__main__":
    sys.exit(main())
