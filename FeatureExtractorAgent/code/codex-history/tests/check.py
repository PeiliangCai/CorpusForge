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
from unittest import mock

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[3]
BUNDLE = ROOT / "code/codex-history"
SCRIPT = ROOT / "code/scripts/codex-history.py"
spec = importlib.util.spec_from_file_location("codex_history", SCRIPT)
history = importlib.util.module_from_spec(spec)
spec.loader.exec_module(history)
TEST_ENV = None


def run_history(command, *arguments, success=True):
    result = subprocess.run([sys.executable, "-B", str(SCRIPT), command, *map(str, arguments)],
                            env=TEST_ENV, capture_output=True, text=True)
    assert (result.returncode == 0) == success, result.stderr
    return result


def restore(home, project, bundle=BUNDLE, success=True, merge=False):
    arguments = ["--bundle", bundle, "--project-root", project]
    if home is not None:
        arguments += ["--codex-home", home]
    if merge:
        arguments += ["--merge"]
    return run_history("restore", *arguments, success=success)


def merge_home(source, home=None, success=True):
    arguments = ["--source-home", source]
    if home is not None:
        arguments += ["--codex-home", home]
    return run_history("merge-home", *arguments, success=success)


def snapshot(home):
    return {str(path.relative_to(home)): ("link", os.readlink(path)) if path.is_symlink()
            else ("file", path.read_bytes()) if path.is_file() else ("directory",)
            for path in home.rglob("*")}


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

    default_home = Path(TEST_ENV["HOME"]) / ".codex"
    restore(default_home, project, success=False)
    restore(None, project, success=False)
    assert not default_home.exists()
    checks.append("default-codex-home-requires-explicit-merge")

    indexed = work / "existing-index"
    indexed.mkdir()
    unrelated = history.encode({"id": "unrelated-session", "thread_name": "Keep my local name", "updated_at": "2026-01-01T00:00:00Z"})
    (indexed / "session_index.jsonl").write_bytes(unrelated)
    restore(indexed, project)
    assert (indexed / "session_index.jsonl").read_bytes().startswith(unrelated)
    assert len((indexed / "session_index.jsonl").read_text().splitlines()) == len(sessions) + 1
    checks.append("unrelated-session-name-preserved")

    renamed = work / "local-name"
    renamed.mkdir()
    local_title = history.encode({"id": first["id"], "thread_name": "My new name"})
    (renamed / "session_index.jsonl").write_bytes(local_title)
    restore(renamed, project)
    assert (renamed / "session_index.jsonl").read_bytes().startswith(local_title)
    assert len((renamed / "session_index.jsonl").read_text().splitlines()) == len(sessions)
    checks.append("existing-local-title-preserved-and-other-names-added")

    for label, content in (("broken-index", b"not JSON\n"), ("incomplete-index", b'{"id":"incomplete"}')):
        destination = work / label
        destination.mkdir()
        index = destination / "session_index.jsonl"
        index.write_bytes(content)
        restore(destination, project, success=False)
        assert index.read_bytes() == content and not (destination / "sessions").exists()
    checks.append("damaged-name-index-preflight-rejected")

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
    assert {str(path.relative_to(previous)): path.read_bytes() for path in previous.rglob("*") if path.is_file()} == old_contents
    checks.append("continued-previous-import-rejects-stale-bundle-without-overwrite")

    # The documented one-command import always selects $HOME/.codex, even when
    # the caller still has the previous suffix home in CODEX_HOME.
    default_home.mkdir(parents=True)
    protected = {"auth.json": b'{"test":"local auth sentinel"}\n', "config.toml": b'local = "configuration"\n',
                 "state_5.sqlite": b"test database bytes", "history.jsonl": b"global history sentinel\n",
                 "logs/keep.log": b"log sentinel", "plugins/keep": b"plugin sentinel", "skills/keep": b"skill sentinel"}
    for relative, content in protected.items():
        path = default_home / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
    unrelated_id = "22222222-2222-4222-8222-222222222222"
    other_content = history.encode({"type": "session_meta", "payload": {"id": unrelated_id, "cwd": str(project)}})
    other_path = default_home / "archived_sessions/nonstandard-name.jsonl"
    other_path.parent.mkdir()
    other_path.write_bytes(other_content)
    (default_home / "session_index.jsonl").write_bytes(unrelated + local_title)
    result = json.loads(restore(None, project, merge=True).stdout)
    assert result["created"] == 5 and result["codex_home"] == str(default_home)
    assert not Path(TEST_ENV["CODEX_HOME"]).exists()
    for relative, content in protected.items():
        assert (default_home / relative).read_bytes() == content
    assert other_path.read_bytes() == other_content
    assert (default_home / "session_index.jsonl").read_bytes().startswith(unrelated + local_title)
    before = snapshot(default_home)
    assert json.loads(restore(None, project, merge=True).stdout)["created"] == 0
    assert snapshot(default_home) == before
    checks.append("explicit-merge-default-home-ignores-legacy-env-preserves-account-unrelated-session-and-local-title")

    # Existing imports are migrated from their real local files, with actual
    # continuation rows and latest local titles, rather than the old bundle.
    source = work / "codex-t1-agent-20261115"
    restore(source, project)
    continuation = history.encode({"type": "event_msg", "payload": {"type": "user_message", "message": "local fixture continuation"}})
    first_path = source / first["restore_path"]
    first_path.write_bytes(first_path.read_bytes() + continuation)
    archived_entry = sessions[1][0]
    archived = source / "archived_sessions/renamed-rollout.jsonl"
    archived.parent.mkdir()
    (source / archived_entry["restore_path"]).rename(archived)
    latest_title = history.encode({"id": first["id"], "thread_name": "Latest local title", "updated_at": "2026-11-17T00:00:00Z"})
    with (source / "session_index.jsonl").open("ab") as stream:
        stream.write(latest_title + history.encode({"id": unrelated_id, "thread_name": "Do not copy this name"}))
    extra = source / "sessions/unselected-service.jsonl"
    extra.write_bytes(other_content)
    for relative, content in protected.items():
        path = source / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
    source_before = snapshot(source)
    previous_shell_home = TEST_ENV["HOME"]
    TEST_ENV["HOME"] = str(work / "migration-shell-home")
    migrated = Path(TEST_ENV["HOME"]) / ".codex"
    result = json.loads(merge_home(source).stdout)
    TEST_ENV["HOME"] = previous_shell_home
    assert result["created"] == 5 and result["selected_sessions"] == 5 and not result["missing_project_ids"]
    assert result["codex_home"] == str(migrated) and not Path(TEST_ENV["CODEX_HOME"]).exists()
    assert result["not_imported_session_count"] == 1 and result["not_imported_session_ids"] == [unrelated_id]
    assert (migrated / first["restore_path"]).read_bytes() == first_path.read_bytes()
    assert (migrated / first["restore_path"]).read_bytes().endswith(continuation)
    assert (migrated / archived.relative_to(source)).read_bytes() == archived.read_bytes()
    migrated_names = {row["id"]: row["thread_name"] for row in map(json.loads, (migrated / "session_index.jsonl").read_text().splitlines())}
    assert migrated_names[first["id"]] == "Latest local title" and len(migrated_names) == 5
    assert not (migrated / extra.relative_to(source)).exists()
    assert all(not (migrated / relative).exists() for relative in protected)
    assert snapshot(source) == source_before
    assert json.loads(merge_home(source, migrated).stdout)["unchanged"] == 5
    checks.append("merge-home-preserves-latest-jsonl-bytes-archived-path-source-title-source-files-and-five-id-scope")

    # The target's own title wins over the source title for identical sessions.
    (migrated / "session_index.jsonl").write_bytes(local_title + b"".join(
        history.encode(row) for row in map(json.loads, (migrated / "session_index.jsonl").read_text().splitlines()) if row["id"] != first["id"]))
    migrated_before = snapshot(migrated)
    merge_home(source, migrated)
    assert snapshot(migrated) == migrated_before and snapshot(source) == source_before
    checks.append("merge-home-preserves-existing-target-title")

    # A different filename/archived path is still the same metadata ID.
    divergent = work / "divergent-target"
    different_path = divergent / "archived_sessions/arbitrary-file-name.jsonl"
    different_path.parent.mkdir(parents=True)
    different_path.write_bytes(first_path.read_bytes() + history.encode({"type": "event_msg", "payload": {"type": "agent_message", "message": "other branch fixture"}}))
    divergent_before = snapshot(divergent)
    error = merge_home(source, divergent, success=False).stderr
    assert first["id"] in error and str(different_path) in error and "conflict" in error
    assert snapshot(divergent) == divergent_before and snapshot(source) == source_before
    checks.append("different-content-same-id-cross-tree-preflight-aborts-entire-merge")

    for side in ("source", "target"):
        duplicate = work / ("duplicate-" + side)
        shutil.copytree(source if side == "source" else migrated, duplicate)
        path = duplicate / "archived_sessions/duplicate-other-name.jsonl"
        path.write_bytes(first_path.read_bytes())
        before = snapshot(duplicate)
        absent = work / ("duplicate-destination-" + side)
        merge_home(duplicate, absent, success=False) if side == "source" else merge_home(source, duplicate, success=False)
        assert snapshot(duplicate) == before and not absent.exists()
    checks.append("duplicate-metadata-id-in-source-or-target-rejected-across-paths")

    # Same ID/content already under an archived filename is skipped, not cloned.
    same_elsewhere = work / "same-elsewhere"
    elsewhere = same_elsewhere / "archived_sessions/same-id-different-filename.jsonl"
    elsewhere.parent.mkdir(parents=True)
    elsewhere.write_bytes((home / first["restore_path"]).read_bytes())
    result = json.loads(restore(same_elsewhere, project, merge=True).stdout)
    assert result["created"] == 4 and result["unchanged"] == 1
    assert not (same_elsewhere / first["restore_path"]).exists()
    checks.append("identical-id-content-at-different-path-skips-without-duplicate")

    for label, mutate in (("truncated-source", lambda p: p.write_bytes(p.read_bytes()[:-1])),
                          ("malformed-source", lambda p: p.write_bytes(p.read_bytes() + b"bad json\n"))):
        broken = work / label
        shutil.copytree(source, broken)
        mutate(broken / first["restore_path"])
        destination = work / (label + "-destination")
        merge_home(broken, destination, success=False)
        assert not destination.exists()
    checks.append("local-source-full-jsonl-and-complete-last-line-required")

    no_selected = work / "no-selected-source"
    (no_selected / "sessions").mkdir(parents=True)
    (no_selected / "sessions/unrelated.jsonl").write_bytes(other_content)
    merge_home(no_selected, work / "no-selected-target", success=False)
    assert not (work / "no-selected-target").exists()
    merge_home(source, source, success=False)
    merge_home(source, source / "nested", success=False)
    checks.append("no-selected-id-and-overlapping-homes-rejected")

    # Missing project IDs are reported; missing source titles use bundle names.
    partial = work / "partial-source"
    (partial / "sessions").mkdir(parents=True)
    (partial / "sessions/one.jsonl").write_bytes(first_path.read_bytes())
    result = json.loads(merge_home(partial, work / "partial-target").stdout)
    assert result["created"] == 1 and len(result["missing_project_ids"]) == 4
    checks.append("partial-source-selected-ids-reported-and-missing-title-backfilled")

    for side, component in (("source", "sessions"), ("source", "session_index.jsonl"),
                            ("target", "archived_sessions"), ("target", "session_index.jsonl")):
        linked_home = work / ("symlink-" + side + "-" + component)
        shutil.copytree(source if side == "source" else migrated, linked_home)
        item = linked_home / component
        outside = work / ("outside-" + side + "-" + component)
        item.rename(outside)
        item.symlink_to(outside, target_is_directory=outside.is_dir())
        before_outside = snapshot(outside) if outside.is_dir() else outside.read_bytes()
        if side == "source":
            destination = work / ("linked-source-target-" + component)
            merge_home(linked_home, destination, success=False)
            assert not destination.exists()
        else:
            merge_home(source, linked_home, success=False)
        assert (snapshot(outside) if outside.is_dir() else outside.read_bytes()) == before_outside
    checks.append("source-and-target-session-tree-and-index-symlink-escapes-rejected")

    for side in ("source", "target"):
        linked_home = work / ("linked-" + side + "-home")
        linked_home.symlink_to(source if side == "source" else migrated, target_is_directory=True)
        before = snapshot(source if side == "source" else migrated)
        if side == "source":
            merge_home(linked_home, work / "linked-home-target", success=False)
            assert not (work / "linked-home-target").exists()
        else:
            merge_home(source, linked_home, success=False)
        assert snapshot(source if side == "source" else migrated) == before
    checks.append("source-or-target-home-symlink-rejected")

    # Inject a rename/append between first scan and the final precommit scan.
    source_state = history.scan_home(source, {entry["id"] for entry, _ in sessions}, keep_data=True)
    incoming = {sid: row for sid, row in source_state["records"].items() if "data" in row}
    names = {sid: history.name_for(entry) for sid, entry in ((entry["id"], entry) for entry, _ in sessions)}
    real_scan = history.scan_home
    race_target = work / "changed-source-target"
    changed = False
    def change_source(path, selected, keep_data=False):
        nonlocal changed
        if path == source and not changed:
            changed = True
            first_path.write_bytes(first_path.read_bytes() + continuation)
        return real_scan(path, selected, keep_data)
    with mock.patch.object(history, "scan_home", side_effect=change_source):
        try:
            history.merge_sessions(race_target, incoming, names, source, source_state)
            raise AssertionError("concurrent source change accepted")
        except history.ArchiveError as error:
            assert "source changed" in str(error)
    assert not race_target.exists()
    checks.append("source-change-during-preflight-rejected-before-target-creation")

    race_target = work / "changed-target"
    race_target.mkdir()
    old_name = history.encode({"id": first["id"], "thread_name": "First local name"})
    (race_target / "session_index.jsonl").write_bytes(old_name)
    calls = 0
    def change_target(path, selected, keep_data=False):
        nonlocal calls
        if path == race_target:
            calls += 1
            if calls == 2:
                (race_target / "session_index.jsonl").write_bytes(local_title)
        return real_scan(path, selected, keep_data)
    with mock.patch.object(history, "scan_home", side_effect=change_target):
        try:
            history.merge_sessions(race_target, incoming, names)
            raise AssertionError("concurrent target rename accepted")
        except history.ArchiveError as error:
            assert "destination changed" in str(error)
    assert (race_target / "session_index.jsonl").read_bytes() == local_title
    assert not (race_target / "sessions").exists()
    checks.append("target-index-change-during-preflight-preserved-and-rejected")

    blocked = work / "blocked-parent"
    (blocked / "sessions").mkdir(parents=True)
    (blocked / "sessions/2026").write_bytes(b"existing non-directory")
    before = snapshot(blocked)
    restore(blocked, project, merge=True, success=False)
    assert snapshot(blocked) == before
    checks.append("non-directory-parent-preflight-rejected-without-any-write")

    # Run actual CLI recognition against a home produced by the primary command.
    TEST_ENV["HOME"] = str(work / "cli-shell-home")
    home = Path(TEST_ENV["HOME"]) / ".codex"
    restore(None, project, merge=True)
    return home, project, manifest, checks


def cli_checks(home, project, manifest, work):
    env = dict(TEST_ENV)
    env.update(CODEX_HOME=str(home), HTTP_PROXY="http://127.0.0.1:9",
               HTTPS_PROXY="http://127.0.0.1:9", ALL_PROXY="http://127.0.0.1:9", NO_PROXY="")
    version = subprocess.run(["codex", "--version"], env=env, capture_output=True, text=True, check=True).stdout.strip()
    records = []
    with (work / "app-server.stderr").open("w") as error_log:
        proc = subprocess.Popen(["codex", "-c", 'cli_auth_credentials_store="file"', "app-server", "--listen", "stdio://"], cwd=project,
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
            "history_import_mode": "restore --merge --project-root <isolated-checkout>; destination is isolated $HOME/.codex, ignoring the legacy CODEX_HOME",
            "account_preservation_checked_before_cli_start": True,
            "network_test_configuration": "Isolated HOME/XDG directories and file-only credential store; no auth/config restored; HTTP_PROXY, HTTPS_PROXY and ALL_PROXY point to the refused localhost endpoint 127.0.0.1:9.",
            "turn_start_sent": False, "model_generation_request_sent": False}


def main():
    global TEST_ENV
    runtime = ROOT / "code/runtime-data"
    runtime.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="codex-history-check-", dir=runtime) as temp:
        work = Path(temp)
        TEST_ENV = {key: value for key, value in os.environ.items() if key in ("PATH", "LANG", "LC_ALL", "TERM")}
        TEST_ENV.update(HOME=str(work / "shell-home"), CODEX_HOME=str(work / "ignored-legacy-home"),
                        XDG_CONFIG_HOME=str(work / "xdg-config"), XDG_CACHE_HOME=str(work / "xdg-cache"),
                        XDG_DATA_HOME=str(work / "xdg-data"), XDG_STATE_HOME=str(work / "xdg-state"))
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
