#!/usr/bin/env python3
"""Verify/read bundled Codex history, or merge selected local session files.

No authentication/configuration is copied and no Codex/model process is started.
"""


import argparse
import collections
import fcntl
import gzip
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import stat
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
        if not isinstance(entry.get("title"), str) or not entry["title"].strip():
            raise ArchiveError("missing session display name")
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


def home_path(value):
    """Resolve ancestors but reject a symlink at the requested home itself."""
    home = Path(value).expanduser().absolute()
    if home.is_symlink():
        raise ArchiveError("Codex home must not be a symlink: " + str(home))
    return home.parent.resolve() / home.name


def signature(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_size,
            info.st_mtime_ns, info.st_ctime_ns)


class HomeFiles:
    """Access only no-follow paths below an anchored directory descriptor."""

    def __init__(self, home, create=False):
        self.home = home
        self.fd = self.directory(home.parts[1:], create=create, anchor=None)

    @staticmethod
    def directory(parts, create=False, anchor=None):
        fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY) if anchor is None else os.dup(anchor)
        try:
            for part in parts:
                if create:
                    try:
                        os.mkdir(part, 0o700, dir_fd=fd)
                    except FileExistsError:
                        pass
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                os.close(fd)
                fd = child
            return fd
        except BaseException:
            os.close(fd)
            raise

    def parent(self, relative, create=False):
        rel = safe_relative(str(relative))
        return self.directory(rel.parts[:-1], create=create, anchor=self.fd), rel.name

    def open(self, relative, flags, create_dirs=False):
        parent, name = self.parent(relative, create=create_dirs)
        try:
            return os.open(name, flags | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=parent)
        finally:
            os.close(parent)

    def close(self):
        os.close(self.fd)

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


def read_index(files):
    try:
        fd = files.open("session_index.jsonl", os.O_RDONLY)
    except FileNotFoundError:
        return None, b"", {}
    with os.fdopen(fd, "rb") as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
            raise ArchiveError("session name index is not a regular file")
        content = stream.read()
        if signature(os.fstat(stream.fileno())) != signature(before):
            raise ArchiveError("session name index changed while reading; close Codex and retry")
    names = {}
    for line in io.BytesIO(content):
        if not line.endswith(b"\n"):
            raise ArchiveError("incomplete session name index")
        row = json.loads(line)
        if not isinstance(row, dict) or not isinstance(row.get("id"), str) or not isinstance(row.get("thread_name"), str):
            raise ArchiveError("invalid session name index")
        names[row["id"]] = row
    return signature(before), content, names


def session_record(directory, name, relative, selected, keep_data):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    with os.fdopen(fd, "rb") as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode):
            raise ArchiveError("session is not a regular file: " + relative)
        first = stream.readline()
        row = json.loads(first)
        if (not first.endswith(b"\n") or not isinstance(row, dict)
                or row.get("type") != "session_meta" or not isinstance(row.get("payload"), dict)):
            raise ArchiveError("invalid session metadata: " + relative)
        sid = str(uuid.UUID(row["payload"]["id"]))
        result = {"id": sid, "relative": relative, "stat": signature(before)}
        if sid in selected:
            stream.seek(0)
            digest, size, chunks = hashlib.sha256(), 0, []
            for line in stream:
                if not line.endswith(b"\n"):
                    raise ArchiveError("incomplete session JSONL for " + sid + ": " + relative)
                record = json.loads(line)
                if not isinstance(record, dict) or not isinstance(record.get("type"), str) or "payload" not in record:
                    raise ArchiveError("invalid session JSONL for " + sid + ": " + relative)
                if record["type"] == "session_meta":
                    if not isinstance(record["payload"], dict) or str(uuid.UUID(record["payload"].get("id", ""))) != sid:
                        raise ArchiveError("mixed session IDs in " + relative)
                digest.update(line)
                size += len(line)
                if keep_data:
                    chunks.append(line)
            result.update(size=size, digest=digest.hexdigest())
            if keep_data:
                result["data"] = b"".join(chunks)
        if signature(os.fstat(stream.fileno())) != signature(before):
            raise ArchiveError("session changed while reading " + sid + ": " + relative)
    return result


def scan_home(home, selected, keep_data=False):
    """Scan both session trees by metadata ID, including nonstandard filenames."""
    state = {"identity": None, "tree": {}, "records": {}, "index_stat": None,
             "index": b"", "names": {}}
    try:
        files = HomeFiles(home)
    except FileNotFoundError:
        return state
    with files:
        info = os.fstat(files.fd)
        state["identity"] = (info.st_dev, info.st_ino)

        def walk(directory, relative):
            before = signature(os.fstat(directory))
            state["tree"][relative] = before
            for entry in sorted(os.scandir(directory), key=lambda value: value.name):
                rel = relative + "/" + entry.name
                info = entry.stat(follow_symlinks=False)
                if stat.S_ISLNK(info.st_mode):
                    raise ArchiveError("symlink in session tree: " + str(home / rel))
                if stat.S_ISDIR(info.st_mode):
                    child = os.open(entry.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
                    try:
                        walk(child, rel)
                    finally:
                        os.close(child)
                elif entry.name.endswith(".jsonl"):
                    record = session_record(directory, entry.name, rel, selected, keep_data)
                    sid = record["id"]
                    if sid in state["records"]:
                        raise ArchiveError("duplicate session ID " + sid + ": "
                                           + str(home / state["records"][sid]["relative"]) + " ; " + str(home / rel))
                    state["records"][sid] = record
                    state["tree"][rel] = record["stat"]
            if signature(os.fstat(directory)) != before:
                raise ArchiveError("session directory changed while scanning: " + str(home / relative))

        for name in ("sessions", "archived_sessions"):
            try:
                fd = files.directory((name,), anchor=files.fd)
            except FileNotFoundError:
                continue
            try:
                walk(fd, name)
            finally:
                os.close(fd)
        state["index_stat"], state["index"], state["names"] = read_index(files)
    return state


def state_key(state):
    return (state["identity"], state["tree"], state["index_stat"], state["index"])


def name_for(entry):
    return {"id": entry["id"], "thread_name": entry["title"], "updated_at": entry["title_updated_at"]}


def check_new_path(home, relative):
    """Validate all existing parent components before any import writes."""
    try:
        with HomeFiles(home) as files:
            try:
                parent, name = files.parent(relative)
            except FileNotFoundError:
                return
            try:
                try:
                    os.stat(name, dir_fd=parent, follow_symlinks=False)
                except FileNotFoundError:
                    return
                raise ArchiveError("session destination already exists: " + str(home / relative))
            finally:
                os.close(parent)
    except FileNotFoundError:
        return


def merge_sessions(home, incoming, names, source_home=None, source_state=None):
    selected = set(incoming)
    initial = scan_home(home, selected)
    planned, additions = [], []
    occupied = {record["relative"]: record["id"] for record in initial["records"].values()}
    for sid, record in incoming.items():
        existing = initial["records"].get(sid)
        if existing:
            if (existing["size"], existing["digest"]) != (record["size"], record["digest"]):
                source = str(source_home / record["relative"]) if source_home else "bundle:" + record["relative"]
                raise ArchiveError("session content conflict for ID " + sid + ": " + source
                                   + " ; " + str(home / existing["relative"]) + "; no files written; keep both copies")
        else:
            relative = record["relative"]
            if relative in occupied:
                raise ArchiveError("session path conflict for ID " + sid + ": " + str(home / relative))
            # A non-session file/directory at the same path also must not be replaced.
            check_new_path(home, relative)
            planned.append(record)
        if sid not in initial["names"] and sid in names:
            additions.append(encode(names[sid]))

    # All conflicts, JSONL boundaries, names, and paths have now been checked.
    # Descriptor-relative O_NOFOLLOW/O_EXCL also protects the commit from path swaps.
    if source_home and state_key(scan_home(source_home, selected)) != state_key(source_state):
        raise ArchiveError("source changed during preflight; close Codex and retry")
    with HomeFiles(home, create=True) as files:
        try:
            fcntl.flock(files.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ArchiveError("another history merge is running for this home")
        current = scan_home(home, selected)
        anchored = os.fstat(files.fd)
        if current["identity"] != (anchored.st_dev, anchored.st_ino):
            raise ArchiveError("destination home changed during preflight")
        if initial["identity"] is None:
            expected = dict(initial, identity=current["identity"])
        else:
            expected = initial
        if state_key(current) != state_key(expected):
            raise ArchiveError("destination changed during preflight; close Codex and retry")
        for record in planned:
            fd = files.open(record["relative"], os.O_WRONLY | os.O_CREAT | os.O_EXCL, create_dirs=True)
            with os.fdopen(fd, "wb") as stream:
                stream.write(record["data"])
                stream.flush()
                os.fsync(stream.fileno())
        if additions:
            flags = os.O_RDWR | os.O_APPEND
            if initial["index_stat"] is None:
                flags |= os.O_CREAT | os.O_EXCL
            fd = files.open("session_index.jsonl", flags)
            with os.fdopen(fd, "r+b") as stream:
                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                info = os.fstat(stream.fileno())
                if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or stream.read() != initial["index"]
                        or (initial["index_stat"] is not None and signature(info) != initial["index_stat"])):
                    raise ArchiveError("session name index changed during merge; close Codex and retry")
                stream.write(b"".join(additions))
                stream.flush()
                os.fsync(stream.fileno())
    return {"created": len(planned), "unchanged": len(incoming) - len(planned), "names_added": len(additions),
            "codex_home": str(home)}


def restore_archive(args):
    if not args.merge and not args.codex_home:
        raise ArchiveError("restore requires --merge (default ~/.codex) or an explicit separate --codex-home")
    home = home_path(args.codex_home or Path.home() / ".codex")
    if not args.merge:
        defaults = {home_path(Path.home() / ".codex"),
                    home_path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex")))}
        if home in defaults:
            raise ArchiveError("restore without --merge refuses the active/default home; use restore --merge explicitly")
    manifest, sessions = read_bundle(Path(args.bundle))
    project = Path(args.project_root).expanduser().resolve(strict=True) if args.project_root else None
    old_project = Path(manifest["project_root"])
    incoming, names = {}, {}
    for entry, rows in sessions:
        if project:
            old_cwd = Path(rows[0]["payload"]["cwd"])
            if not inside(old_cwd, old_project):
                raise ArchiveError("source cwd is outside recorded project")
            rows[0]["payload"]["cwd"] = str(project / old_cwd.relative_to(old_project))
        content = b"".join(encode(row) for row in rows)
        incoming[entry["id"]] = {"id": entry["id"], "relative": str(safe_relative(entry["restore_path"])),
                                 "size": len(content), "digest": hashlib.sha256(content).hexdigest(), "data": content}
        names[entry["id"]] = name_for(entry)
    print(json.dumps(merge_sessions(home, incoming, names), ensure_ascii=False))


def merge_home(args):
    _, sessions = read_bundle(Path(args.bundle))
    entries = {entry["id"]: entry for entry, _ in sessions}
    source, home = home_path(args.source_home), home_path(args.codex_home or Path.home() / ".codex")
    if inside(source, home) or inside(home, source):
        raise ArchiveError("source and destination homes must be separate and must not contain each other")
    source_state = scan_home(source, set(entries), keep_data=True)
    incoming = {sid: record for sid, record in source_state["records"].items() if sid in entries}
    if not incoming:
        raise ArchiveError("no selected project sessions found in source home: " + str(source))
    names = {}
    for sid in incoming:
        local_name = source_state["names"].get(sid)
        names[sid] = ({key: local_name[key] for key in ("id", "thread_name", "updated_at") if key in local_name}
                      if local_name is not None else name_for(entries[sid]))
    result = merge_sessions(home, incoming, names, source, source_state)
    ignored = sorted(set(source_state["records"]) - set(entries))
    result.update(source_home=str(source), selected_sessions=len(incoming),
                  missing_project_ids=sorted(set(entries) - set(incoming)),
                  not_imported_session_count=len(ignored), not_imported_session_ids=ignored)
    print(json.dumps(result, ensure_ascii=False))


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
    for name, action in (("verify", verify_archive), ("restore", restore_archive),
                         ("merge-home", merge_home), ("transcript", transcript)):
        command = sub.add_parser(name)
        command.add_argument("--bundle", default=str(Path(__file__).resolve().parents[1] / "codex-history"))
        command.set_defaults(run=action)
        if name in ("restore", "merge-home"):
            command.add_argument("--codex-home", help="destination; merge modes default to ~/.codex, ignoring CODEX_HOME")
        if name == "restore":
            command.add_argument("--merge", action="store_true", help="explicitly merge into the default/existing Codex home")
            command.add_argument("--project-root", help="remap metadata cwd only to an existing checkout")
        if name == "merge-home":
            command.add_argument("--source-home", required=True, help="existing local home containing the latest five project sessions")
        if name == "transcript":
            command.add_argument("--session", help="one session UUID; default: all")
    args = parser.parse_args()
    try:
        args.run(args)
    except (ArchiveError, OSError, ValueError, KeyError, TypeError) as error:
        print("codex-history: " + type(error).__name__ + ": " + str(error)[:1200], file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
