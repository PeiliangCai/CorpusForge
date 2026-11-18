#!/usr/bin/env python3
"""Check the scoped document delta against the task's captured baseline."""
import csv
import hashlib
import io
import json
from pathlib import Path
import re
import xml.etree.ElementTree as ET
from zipfile import ZipFile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[4]
DOCS = ROOT / "方案/子任务T1"
BASE = HERE / "before"
P_RE = re.compile(rb"<w:p(?:\s[^>]*)?>.*?</w:p>", re.S)
T_RE = re.compile(rb"(<w:t(?:\s[^>]*)?>).*?(</w:t>)", re.S)
NS = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}


def textless(xml):
    return T_RE.sub(lambda m: m.group(1) + m.group(2), xml)


def load(name, baseline=False):
    return json.loads(read_bytes((BASE if baseline else DOCS) / name))


def read_bytes(path):
    if path.parent == BASE and not path.is_file():
        with ZipFile(HERE / "before.zip") as archive:
            return archive.read(path.name)
    return path.read_bytes()


def diff(a, b, path=""):
    if type(a) is not type(b):
        return [path]
    if isinstance(a, dict):
        changes = [path + "/" + k for k in a.keys() ^ b.keys()]
        for key in a.keys() & b.keys():
            changes += diff(a[key], b[key], path + "/" + key)
        return changes
    if isinstance(a, list):
        if len(a) != len(b):
            return [path]
        changes = []
        for index, (left, right) in enumerate(zip(a, b)):
            changes += diff(left, right, path + "/" + str(index))
        return changes
    return [] if a == b else [path]


def csv_rows(path):
    source = read_bytes(path).decode("utf-8")
    lines = source.splitlines(keepends=True)
    reader = csv.reader(io.StringIO(source, newline=""))
    result = {}
    previous = 0
    for row in reader:
        result[row[0]] = (row, "".join(lines[previous:reader.line_num]))
        previous = reader.line_num
    return result


def main():
    result = {"status": "passed", "docx": {}, "json": {}, "csv": {}, "application_tests": "not_run_by_documentation_owner"}
    for name in ["T1智能体开发计划.docx", "T1开发执行说明.docx"]:
        with ZipFile(io.BytesIO(read_bytes(BASE / name))) as before, ZipFile(DOCS / name) as after:
            assert before.namelist() == after.namelist(), name
            changed_parts = [n for n in before.namelist() if before.read(n) != after.read(n)]
            assert changed_parts == ["word/document.xml"], (name, changed_parts)
            left, right = before.read("word/document.xml"), after.read("word/document.xml")
            assert textless(left) == textless(right), name + " non-text document structure changed"
            a, b = P_RE.findall(left), P_RE.findall(right)
            assert len(a) == len(b)
            changed = [i for i, (x, y) in enumerate(zip(a, b)) if x != y]
            for index in changed:
                assert b"T1-F02" in a[index], (name, index)
            doc = ET.fromstring(right)
            paragraphs = ["".join(t.text or "" for t in p.findall(".//w:t", NS)) for p in doc.findall(".//w:p", NS)]
            primary = [p for p in paragraphs if p.startswith("T1-F02“存储管理与安全清理”")]
            assert len(primary) == 1
            for phrase in ["2026-11-14原时点仅登记", "24小时", "10分钟", "默认不勾选", "s3-native-artifacts", "不提升医学、S6/S7"]:
                assert phrase in primary[0], (name, phrase)
            result["docx"][name] = {"changed_parts": changed_parts, "changed_paragraphs": changed, "paragraph_count": len(a), "all_other_xml_and_zip_members_preserved": True}

    allowed_common = [
        "/future_storage_management", "/current_document_fingerprints", "/current_task_records/run_actions/delete",
        "/current_task_title_pdf_identity/item_review_state", "/current_reuse_entry_removal/item_review_state",
        "/current_reuse_entry_removal/engineering_validation/boundary",
        "/current_run_isolation_and_model_consistency/item_review_state",
        "/current_run_isolation_and_model_consistency/acceptance_boundary", "/current_submission_task_feedback/scope",
    ]
    allowed_plan = allowed_common + [
        "/future_extensions/1", "/scope/single_run_deletion", "/tasks/17/work", "/tasks/29/work", "/decisions/17",
        "/decisions/19/detail", "/current_task_title_pdf_identity/pending_items/storage_management_auto_cleanup_batch_delete",
        "/current_submission_task_feedback/requirements/3_submission_scoped_deletion",
        "/current_submission_task_feedback/unchanged_boundaries/storage", "/current_summary_completion/unchanged_boundaries",
        "/current_summary_completion/followup_paragraph_glyph_tables_20261115/unchanged_limits_and_boundaries",
        "/current_summary_completion/followup_extraction_wait_navigation_20261115/unchanged_boundaries",
    ]
    configs = {
        "开发计划.json": allowed_plan,
        "当前版本.json": allowed_common + ["/execution_guide/confirmed_decisions/E08/rule"],
        "质量与性能验收契约.json": ["/future_acceptance_items/0", "/current_document_fingerprints"],
    }
    for name, allowed in configs.items():
        before, after = load(name, True), load(name)
        changed = sorted(diff(before, after))
        unexpected = [p for p in changed if not any(p == prefix or p.startswith(prefix + "/") for prefix in allowed)]
        assert not unexpected, (name, unexpected)
        for key in ["stage_acceptances", "stages", "formal_reviews", "formal_review_state", "current_requirement_formal_reviews", "status"]:
            assert before.get(key) == after.get(key), (name, key)
        fingerprint = after["current_document_fingerprints"]
        assert fingerprint["plan_sha256"] == hashlib.sha256((DOCS / "T1智能体开发计划.docx").read_bytes()).hexdigest()
        assert fingerprint["execution_guide_sha256"] == hashlib.sha256((DOCS / "T1开发执行说明.docx").read_bytes()).hexdigest()
        result["json"][name] = {"changed_paths": changed, "unrelated_fields_and_stage_review_states_preserved": True}
    assert load("开发计划.json", True)["future_extensions"][0] == load("开发计划.json")["future_extensions"][0], "F01 changed"
    statuses = [load("开发计划.json")["future_extensions"][1]["status"],
                load("开发计划.json")["future_storage_management"]["status"],
                load("当前版本.json")["future_storage_management"]["status"],
                load("质量与性能验收契约.json")["future_acceptance_items"][0]["status"]]
    assert len(set(statuses)) == 1
    result["current_F02_status"] = statuses[0]
    allowed_rows = {"开发任务清单.csv": {"T1-F02", "T1-R13", "T1-R31"},
                    "验收清单.csv": {"T1-F02", "F09"},
                    "待讨论实现决策.csv": {"D18", "D20"},
                    "开发阶段与验收.csv": {"S5"}}
    for name, allowed in allowed_rows.items():
        before, after = csv_rows(BASE / name), csv_rows(DOCS / name)
        assert before.keys() == after.keys(), name
        changed = [k for k in before if before[k][1] != after[k][1]]
        assert set(changed) <= allowed, (name, changed)
        header = next(iter(after.values()))[0]
        for key in after:
            assert len(after[key][0]) == len(header), (name, key)
        if name == "开发阶段与验收.csv":
            index = header.index("状态")
            assert before["S5"][0][index] == after["S5"][0][index]
        result["csv"][name] = {"changed_rows": changed, "other_row_bytes_and_columns_preserved": True}
    (HERE / "validation.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"status": "passed", "current_F02_status": statuses[0], "docx_preservation": True, "F01_quality_stages_and_old_formal_reviews_preserved": True}, ensure_ascii=False))


if __name__ == "__main__":
    main()
