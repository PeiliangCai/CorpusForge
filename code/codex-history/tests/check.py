#!/usr/bin/env python3
"""Restore/name boundaries, then local app-server history recognition (no turn/start)."""

import collections
import datetime
import gzip
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import selectors
import shutil
import subprocess
import sys
import tempfile
import time

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[3]
BUNDLE = ROOT / "code/codex-history"
SCRIPT = ROOT / "code/scripts/codex-history.py"
spec = importlib.util.spec_from_file_location("codex_history", SCRIPT)
history = importlib.util.module_from_spec(spec)
spec.loader.exec_module(history)


def restore(home, project, bundle=BUNDLE, success=True):
    result = subprocess.run([sys.executable, str(SCRIPT), "restore", "--bundle", str(bundle),
                             "--codex-home", str(home), "--project-root", str(project)],
                            capture_output=True, text=True)
    assert (result.returncode == 0) == success, result.stderr
    return result


def boundary_checks(work):
    project = work / "checkout"
    project.mkdir()
    manifest, sessions = history.read_bundle(BUNDLE)
    first = sessions[0][0]
    checks = []

    home = work / "restore"
    restore(home, project)
    for entry, rows in sessions:
        restored = [json.loads(line) for line in (home / entry["restore_path"]).read_text().splitlines()]
        assert restored[0]["payload"]["cwd"] == str(project)
        assert restored[1:] == rows[1:], "text outside cwd metadata was modified"
    result = json.loads(restore(home, project).stdout)
    assert result["created"] == 0 and result["unchanged"] == len(sessions) and result["names_added"] == 0
    names = {row["id"]: row["thread_name"] for row in map(json.loads, (home / "session_index.jsonl").read_text().splitlines())}
    assert names == {entry["id"]: entry["title"] for entry, _ in sessions}
    assert not (home / "auth.json").exists() and not (home / "config.toml").exists()
    checks.append("restore/remap-only/idempotence/no-auth-config")

    conflict = work / "conflict"
    target = conflict / first["restore_path"]
    target.parent.mkdir(parents=True)
    target.write_text("existing content\n")
    restore(conflict, project, success=False)
    assert target.read_text() == "existing content\n"
    assert len(list(conflict.rglob("*.jsonl"))) == 1
    checks.append("conflict-preflight-no-overwrite")

    damaged = work / "damaged"
    shutil.copytree(BUNDLE, damaged, ignore=shutil.ignore_patterns("tests"))
    blob = damaged / first["archive_path"]
    blob.write_bytes(blob.read_bytes() + b"tampered")
    restore(work / "bad-hash", project, damaged, success=False)
    assert not (work / "bad-hash").exists()
    checks.append("sha256-tamper-rejected")

    for field in ("archive_path", "restore_path"):
        altered = json.loads(json.dumps(manifest))
        altered["sessions"][0][field] = "sessions/../../escape.jsonl.gz"
        (damaged / "manifest.json").write_text(json.dumps(altered))
        restore(work / "bad-path", project, damaged, success=False)
    assert not (work / "bad-path").exists()
    checks.append("archive-and-restore-path-traversal-rejected")

    linked = work / "linked"
    outside = work / "outside"
    linked.mkdir()
    outside.mkdir()
    (linked / "sessions").symlink_to(outside, target_is_directory=True)
    restore(linked, project, success=False)
    assert not list(outside.iterdir())
    checks.append("symlink-escape-rejected")

    malformed = work / "malformed"
    shutil.copytree(BUNDLE, malformed, ignore=shutil.ignore_patterns("tests"))
    blob = malformed / first["archive_path"]
    content = gzip.decompress(blob.read_bytes())[:-1]
    blob.write_bytes(gzip.compress(content, mtime=0))
    altered = json.loads(json.dumps(manifest))
    altered["sessions"][0]["sha256"] = hashlib.sha256(blob.read_bytes()).hexdigest()
    altered["sessions"][0]["uncompressed_bytes"] = len(content)
    (malformed / "manifest.json").write_text(json.dumps(altered))
    restore(work / "bad-jsonl", project, malformed, success=False)
    assert not (work / "bad-jsonl").exists()
    checks.append("incomplete-jsonl-rejected-even-with-valid-hash")

    restore(Path.home() / ".codex", project, success=False)
    checks.append("default-codex-home-rejected")

    indexed = work / "existing-index"
    indexed.mkdir()
    unrelated = history.encode({"id": "unrelated-session", "thread_name": "Keep my local name", "updated_at": "2026-01-01T00:00:00Z"})
    (indexed / "session_index.jsonl").write_bytes(unrelated)
    restore(indexed, project)
    assert (indexed / "session_index.jsonl").read_bytes().startswith(unrelated)
    assert len((indexed / "session_index.jsonl").read_text().splitlines()) == len(sessions) + 1
    checks.append("unrelated-session-name-preserved")

    for label, content in (("name-conflict", history.encode({"id": first["id"], "thread_name": "My new name"})),
                           ("broken-index", b"not JSON\n"), ("incomplete-index", b'{"id":"incomplete"}')):
        destination = work / label
        destination.mkdir()
        index = destination / "session_index.jsonl"
        index.write_bytes(content)
        restore(destination, project, success=False)
        assert index.read_bytes() == content and not (destination / "sessions").exists()
    checks.append("conflicting-or-damaged-name-index-preflight-rejected")

    linked_index = work / "linked-index"
    linked_index.mkdir()
    outside_index = work / "outside-index.jsonl"
    outside_index.write_bytes(unrelated)
    (linked_index / "session_index.jsonl").symlink_to(outside_index)
    restore(linked_index, project, success=False)
    assert outside_index.read_bytes() == unrelated and not (linked_index / "sessions").exists()
    checks.append("name-index-symlink-rejected")

    previous = work / "previous-import"
    restore(previous, project)
    (previous / "session_index.jsonl").unlink()
    result = json.loads(restore(previous, project).stdout)
    assert result["created"] == 0 and result["unchanged"] == len(sessions) and result["names_added"] == len(sessions)
    checks.append("unchanged-previous-import-name-backfill")

    continued = previous / first["restore_path"]
    continued.write_bytes(continued.read_bytes() + history.encode({"type": "event_msg", "payload": {"type": "continued-locally"}}))
    old_contents = {str(path.relative_to(previous)): path.read_bytes() for path in previous.rglob("*") if path.is_file()}
    restore(previous, project, success=False)
    fresh = work / "updated-import"
    restore(fresh, project)
    assert {str(path.relative_to(previous)): path.read_bytes() for path in previous.rglob("*") if path.is_file()} == old_contents
    assert len(list(fresh.rglob("rollout-*.jsonl"))) == len(sessions)
    checks.append("continued-previous-import-kept-new-home-restores-five")
    return home, project, manifest, checks


def cli_checks(home, project, manifest, work):
    env = {k: v for k, v in os.environ.items()
           if not any(word in k.upper() for word in ("TOKEN", "SECRET", "PASSWORD", "API_KEY"))}
    env.update(CODEX_HOME=str(home), HTTP_PROXY="http://127.0.0.1:9",
               HTTPS_PROXY="http://127.0.0.1:9", ALL_PROXY="http://127.0.0.1:9", NO_PROXY="")
    version = subprocess.run(["codex", "--version"], env=env, capture_output=True, text=True, check=True).stdout.strip()
    records = []
    with (work / "app-server.stderr").open("w") as error_log:
        proc = subprocess.Popen(["codex", "app-server", "--listen", "stdio://"], cwd=project,
                                env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=error_log, text=True, bufsize=1)
        select = selectors.DefaultSelector()
        select.register(proc.stdout, selectors.EVENT_READ)
        sequence = 0
        def request(method, params):
            nonlocal sequence
            sequence += 1
            proc.stdin.write(json.dumps({"id": sequence, "method": method, "params": params}) + "\n")
            proc.stdin.flush()
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                if select.select(max(0, deadline - time.monotonic())):
                    line = proc.stdout.readline()
                    assert line, "app-server closed stdout"
                    response = json.loads(line)
                    if response.get("id") == sequence:
                        assert "error" not in response, response.get("error")
                        return response["result"]
            raise AssertionError("local app-server response timeout")
        try:
            request("initialize", {"clientInfo": {"name": "visible_history_check", "version": "1.0"}})
            proc.stdin.write('{"method":"initialized"}\n')
            proc.stdin.flush()
            for entry in manifest["sessions"]:
                thread = request("thread/read", {"threadId": entry["id"], "includeTurns": True})["thread"]
                kinds = collections.Counter(item["type"] for turn in thread["turns"] for item in turn["items"])
                assert thread["id"] == entry["id"] and thread["cwd"] == str(project)
                assert thread["name"] == entry["title"]
                assert kinds["userMessage"] == entry["counts"]["user_response_messages"]
                assert kinds["agentMessage"] == entry["counts"]["assistant_response_messages"]
                records.append({"id": entry["id"], "name": thread["name"], "turns": len(thread["turns"]),
                                "user_messages": kinds["userMessage"], "assistant_messages": kinds["agentMessage"],
                                "id_and_remapped_cwd_match": True, "local_display_name_match": True})
            listed = request("thread/list", {"limit": 20, "sourceKinds": ["vscode"], "cwd": str(project)})
            listed_names = {thread["id"]: thread.get("name") for thread in listed["data"]}
            assert listed.get("nextCursor") is None
            assert listed_names == {entry["id"]: entry["title"] for entry in manifest["sessions"]}
            listing = [{"id": thread["id"], "name": thread["name"]} for thread in listed["data"]]
            latest = max(manifest["sessions"], key=lambda e: e["last_record_at"])
            thread = request("thread/resume", {"threadId": latest["id"], "excludeTurns": False})["thread"]
            kinds = collections.Counter(item["type"] for turn in thread["turns"] for item in turn["items"])
            assert kinds["userMessage"] == latest["counts"]["user_response_messages"]
            assert kinds["agentMessage"] == latest["counts"]["assistant_response_messages"]
            assert thread["name"] == latest["title"]
            resumed = {"id": thread["id"], "name": thread["name"], "user_messages": kinds["userMessage"], "assistant_messages": kinds["agentMessage"]}
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
            select.close()
    stderr = (work / "app-server.stderr").read_text()
    return {"cli_version": version, "thread_list": listing, "thread_read": records, "thread_resume": resumed,
            "app_server_stderr_bytes": len(stderr.encode()),
            "responses_websocket_connection_attempt_failed": "failed to connect to Responses WebSocket" in stderr,
            "network_test_configuration": "No auth/config restored; HTTP_PROXY, HTTPS_PROXY and ALL_PROXY point to the refused localhost endpoint 127.0.0.1:9.",
            "turn_start_sent": False, "model_generation_request_sent": False}


def main():
    runtime = ROOT / "code/runtime-data"
    runtime.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="codex-history-check-", dir=runtime) as temp:
        work = Path(temp)
        home, project, manifest, checks = boundary_checks(work)
        result = {"checked_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                  "snapshot_captured_at": manifest["snapshot_captured_at"],
                  "restore_boundary_checks": checks, "restore_boundary_checks_passed": len(checks),
                  **cli_checks(home, project, manifest, work),
                  "compatibility_note": "Initial newer item_completed events yielded empty displayed items; legacy user_message/agent_message events synthesized from the same sanitized visible messages fixed local read. thread/items/list is unsupported by this legacy store.",
                  "limits": "Same-machine file migration recognition only; no model turn, cross-server model continuation, original runtime instructions, tools, agents or authentication restored."}
    (BUNDLE / "validation.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
