#!/usr/bin/env python3
"""Verify, read, or restore the bundled lossy Codex conversation snapshot.

No authentication/configuration is copied and no Codex/model process is started.
"""


import argparse
import collections
import gzip
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import sys
import uuid


SCHEMA = "codex-visible-history-1"


OMITTED = "[omitted from shareable archive: tool payload]"


VISIBLE_CHANNELS = (None, "commentary", "final", "final_answer")


PRIVATE_FIELDS = {"base_instructions", "developer_instructions", "encrypted_content",
                  "internal_chat_message_metadata_passthrough", "raw_content"}


class ArchiveError(ValueError):
    pass


def encode(value):
    return (json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")


def sha256(path):
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def inside(path, root):
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def safe_relative(value):
    p = PurePosixPath(value)
    if p.is_absolute() or not p.parts or any(x in (".", "..") for x in p.parts) or "\\" in value:
        raise ArchiveError("unsafe relative path")
    return p


def check_private_fields(value):
    if isinstance(value, dict):
        if PRIVATE_FIELDS.intersection(value):
            raise ArchiveError("private instruction/reasoning field in archive")
        for child in value.values():
            check_private_fields(child)
    elif isinstance(value, list):
        for child in value:
            check_private_fields(child)


def read_bundle(bundle):
    bundle = bundle.resolve(strict=True)
    manifest = json.loads((bundle / "manifest.json").read_text())
    if manifest.get("schema") != SCHEMA:
        raise ArchiveError("unsupported archive schema")
    sessions, seen_ids, seen_paths = [], set(), set()
    for entry in manifest["sessions"]:
        sid = str(uuid.UUID(entry["id"]))
        rel = safe_relative(entry["archive_path"])
        restore = safe_relative(entry["restore_path"])
        if rel.parts[0] != "sessions" or not str(rel).endswith(".jsonl.gz") or restore.parts[0] != "sessions" or not str(restore).endswith(".jsonl"):
            raise ArchiveError("invalid session archive/restore location")
        if sid in seen_ids or str(restore) in seen_paths:
            raise ArchiveError("duplicate archive session")
        seen_ids.add(sid)
        seen_paths.add(str(restore))
        path = (bundle / str(rel)).resolve(strict=True)
        if not inside(path, bundle) or sha256(path) != entry["sha256"]:
            raise ArchiveError("archive path or SHA-256 mismatch")
        rows, total = [], 0
        with gzip.open(path, "rb") as stream:
            for line in stream:
                total += len(line)
                if total > entry["uncompressed_bytes"] or not line.endswith(b"\n"):
                    raise ArchiveError("invalid JSONL length or incomplete line")
                row = json.loads(line)
                check_private_fields(row)
                if row.get("type") not in ("session_meta", "response_item", "event_msg"):
                    raise ArchiveError("unapproved record type")
                item = row["payload"]
                if row["type"] == "response_item":
                    if item.get("type") == "message":
                        if item.get("role") not in ("user", "assistant") or item.get("channel") not in VISIBLE_CHANNELS or item.get("phase") not in VISIBLE_CHANNELS:
                            raise ArchiveError("non-visible message")
                    elif item.get("type") not in ("function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output"):
                        raise ArchiveError("unapproved response type")
                rows.append(row)
        if total != entry["uncompressed_bytes"] or len(rows) != entry["exported_records"]:
            raise ArchiveError("archive record/byte count mismatch")
        if not rows or rows[0]["type"] != "session_meta" or rows[0]["payload"].get("id") != sid or rows[0]["payload"].get("cwd") != entry["cwd"]:
            raise ArchiveError("session metadata mismatch")
        calls, outputs = [], []
        for row in rows:
            item = row["payload"]
            if row["type"] == "response_item":
                if item["type"] in ("function_call", "custom_tool_call"):
                    calls.append(item["call_id"])
                elif item["type"] in ("function_call_output", "custom_tool_call_output"):
                    outputs.append(item["call_id"])
        if len(set(calls)) != len(calls) or collections.Counter(calls) != collections.Counter(outputs):
            raise ArchiveError("tool call/result binding mismatch")
        sessions.append((entry, rows))
    return manifest, sessions


def verify_archive(args):
    manifest, sessions = read_bundle(Path(args.bundle))
    print(json.dumps({"verified_sessions": len(sessions), "compressed_bytes": sum(e["compressed_bytes"] for e, _ in sessions),
                      "snapshot_captured_at": manifest["snapshot_captured_at"]}, ensure_ascii=False))


def restore_archive(args):
    manifest, sessions = read_bundle(Path(args.bundle))
    home = Path(args.codex_home).expanduser().absolute()
    default_home = Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))).expanduser().resolve()
    if home.resolve() in (default_home, (Path.home() / ".codex").resolve()):
        raise ArchiveError("choose a separate CODEX_HOME, not the active/default home")
    if home.is_symlink():
        raise ArchiveError("CODEX_HOME must not be a symlink")
    project = Path(args.project_root).expanduser().resolve(strict=True) if args.project_root else None
    old_project = Path(manifest["project_root"])
    planned = []
    # Validate every destination before creating any session files.
    for entry, rows in sessions:
        target = home / str(safe_relative(entry["restore_path"]))
        if not inside(target.resolve(), home.resolve()):
            raise ArchiveError("restore target escapes CODEX_HOME")
        for parent in (target, *target.parents):
            if parent == home.parent:
                break
            if parent.is_symlink():
                raise ArchiveError("symlink in restore path")
        if project:
            old_cwd = Path(rows[0]["payload"]["cwd"])
            if not inside(old_cwd, old_project):
                raise ArchiveError("source cwd is outside recorded project")
            rows[0]["payload"]["cwd"] = str(project / old_cwd.relative_to(old_project))
        content = b"".join(encode(row) for row in rows)
        if target.exists() and target.read_bytes() != content:
            raise ArchiveError("different session already exists; no files overwritten")
        planned.append((target, content))
    created = unchanged = 0
    for target, content in planned:
        if target.exists():
            unchanged += 1
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("xb") as stream:
            stream.write(content)
        target.chmod(0o600)
        created += 1
    print(json.dumps({"created": created, "unchanged": unchanged, "codex_home": str(home)}, ensure_ascii=False))


def transcript(args):
    _, sessions = read_bundle(Path(args.bundle))
    for entry, rows in sessions:
        if args.session and entry["id"] != args.session:
            continue
        print("\n# Session " + entry["id"] + "\n")
        for row in rows:
            item = row["payload"]
            if row["type"] == "response_item" and item.get("type") == "message":
                print("[" + row["timestamp"] + "] " + item["role"] + "\n")
                print("\n".join(part["text"] for part in item["content"]) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    for name, action in (("verify", verify_archive), ("restore", restore_archive), ("transcript", transcript)):
        command = sub.add_parser(name)
        command.add_argument("--bundle", default=str(Path(__file__).resolve().parents[1] / "codex-history"))
        command.set_defaults(run=action)
        if name == "restore":
            command.add_argument("--codex-home", required=True, help="separate destination; no auth/config copied")
            command.add_argument("--project-root", help="remap metadata cwd only to an existing checkout")
        if name == "transcript":
            command.add_argument("--session", help="one session UUID; default: all")
    args = parser.parse_args()
    try:
        args.run(args)
    except (ArchiveError, OSError, ValueError, KeyError, TypeError) as error:
        print("codex-history: " + type(error).__name__ + ": " + str(error)[:160], file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
