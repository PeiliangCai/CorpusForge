#!/usr/bin/env python3
"""Incrementally synchronize the existing F02 entry and preserve other content."""
import argparse
import copy
import csv
import hashlib
import html
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
ENTRY = "方案/子任务T1/开发计划.json#/future_extensions/1"
REPORT = "code/docs/acceptance/storage-management-2026-11-15/report.json"
VALIDATION = "code/docs/acceptance/storage-management-2026-11-15/documentation/validation.json"
NS = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
P_RE = re.compile(r"<w:p(?:\s[^>]*)?>.*?</w:p>", re.S)
T_RE = re.compile(r"(<w:t(?:\s[^>]*)?>)(.*?)(</w:t>)", re.S)
OLD_DELETE = "取消仍保留已有结果，本次不实现T1-F02存储占用管理或无引用源文件清理。"
NEW_DELETE = "取消仍保留已有结果；任务删除与通用存储清理分开，T1-F02现行范围独立见开发计划.json的future_extensions/1。"
OLD_REVIEW = "医学/S阶段、模型预算、T1-F02后续未实现及正式3/3保持。"
NEW_REVIEW = "医学/S阶段、模型预算及原五项正式3/3保持；T1-F02现行状态独立见开发计划.json的future_extensions/1。"


def load(name, baseline=False):
    path = (BASE if baseline else DOCS) / name
    if baseline and not path.is_file():
        with ZipFile(HERE / "before.zip") as archive:
            return json.loads(archive.read(name))
    return json.loads(path.read_text())


def save(name, data):
    (DOCS / name).write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def scoped_replace(obj):
    """Only clarify present deletion rules and copied current review summaries."""
    if isinstance(obj, dict):
        return {k: scoped_replace(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [scoped_replace(v) for v in obj]
    if isinstance(obj, str):
        return obj.replace(OLD_DELETE, NEW_DELETE).replace(OLD_REVIEW, NEW_REVIEW)
    return obj


def paragraph_text(raw):
    return "".join(html.unescape(m.group(2)) for m in T_RE.finditer(raw))


def replace_text(raw, old, new):
    text = paragraph_text(raw)
    assert old in text
    start = text.index(old)
    end = start + len(old)
    offset = 0
    inserted = False

    def update(match):
        nonlocal offset, inserted
        original = html.unescape(match.group(2))
        left, right = offset, offset + len(original)
        offset = right
        if right <= start or left >= end:
            return match.group(0)
        changed = original[:max(0, start - left)]
        if not inserted:
            changed += new
            inserted = True
        changed += original[max(0, end - left):]
        return match.group(1) + html.escape(changed, quote=False) + match.group(3)

    return T_RE.sub(update, raw)


def sync_docx(name, paragraph):
    path = DOCS / name
    with ZipFile(path) as source:
        members = [(item, source.read(item.filename)) for item in source.infolist()]
        comment = source.comment
    changed = []
    for pos, (info, data) in enumerate(members):
        if info.filename != "word/document.xml":
            continue
        xml = data.decode("utf-8")
        index = 0

        def update(match):
            nonlocal index
            current_index = index
            index += 1
            raw = match.group(0)
            before = paragraph_text(raw)
            if before.startswith("T1-F02“存储管理与安全清理”"):
                raw = replace_text(raw, before, paragraph)
            else:
                for old, new in [(OLD_DELETE, NEW_DELETE), (OLD_REVIEW, NEW_REVIEW)]:
                    if old in paragraph_text(raw):
                        raw = replace_text(raw, old, new)
                # This is the original fifth-item scope, not an F02 implementation claim.
                old = "T1-F02存储扩展仍未实现。"
                if old in paragraph_text(raw):
                    raw = replace_text(raw, old, "本项交付时点未实施T1-F02存储扩展；F02现行状态独立见future_extensions/1。")
            if raw != match.group(0):
                changed.append({"paragraph": current_index, "before": before, "after": paragraph_text(raw)})
            return raw

        xml = P_RE.sub(update, xml)
        ET.fromstring(xml)
        members[pos] = (info, xml.encode("utf-8"))
    temp = path.with_suffix(".docx.f02.tmp")
    with ZipFile(temp, "w") as target:
        target.comment = comment
        for info, data in members:
            target.writestr(info, data)
    temp.replace(path)
    return changed


def sync_csv(name, updates):
    """Rewrite selected logical rows only; keep all other row bytes intact."""
    path = DOCS / name
    content = path.read_bytes().decode("utf-8")
    lines = content.splitlines(keepends=True)
    reader = csv.reader(io.StringIO(content, newline=""))
    header = next(reader)
    keys = [v.lstrip("\ufeff") for v in header]
    result = lines[:reader.line_num]
    previous = reader.line_num
    changed = []
    for cells in reader:
        raw = "".join(lines[previous:reader.line_num])
        previous = reader.line_num
        row = dict(zip(keys, cells))
        identity = cells[0]
        if identity in updates:
            before = row.copy()
            updates[identity](row)
            output = io.StringIO(newline="")
            csv.writer(output, lineterminator="\n").writerow([row[k] for k in keys])
            result.append(output.getvalue())
            if before != row:
                changed.append({"id": identity, "fields": [k for k in row if row[k] != before[k]]})
        else:
            result.append(raw)
    path.write_bytes("".join(result).encode("utf-8"))
    return changed


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--phase", choices=["implementation", "verified", "deployed"], default="implementation")
    args = parser.parse_args()
    states = {
        "implementation": ("authorized_implementation_in_progress", "已获用户授权，按冻结设计实施中；完成、部署与用户审核状态以主报告为准。"),
        "verified": ("scoped_engineering_verified_pending_deployment_and_user_review", "限定工程验证已完成；部署与用户审核以主报告为准。"),
        "deployed": ("scoped_engineering_verified_deployed_pending_user_review", "隔离工程与同构建浏览器核验通过并上线；线上仅GET/HEAD只读核验，未执行真实清理，待用户审核。"),
    }
    status, progress = states[args.phase]
    if args.phase != "implementation":
        assert (ROOT / REPORT).is_file(), "Final claims require the implementation report."

    contract = (
        "PDF、解析文本与图片作为原文核对、历史及导出的持久资料保存。工作台展示文件占用，资料字节与真实磁盘信息分列。"
        "仅固定业务根及可识别文件进入候选：配置的workflow.directory下pdf、runs、figure-reviews、exports，以及codeRoot/runtime-data/s3-native-artifacts下已知工作台live/tombstone run的严格native产物；未知项受保护，引用数据异常或扫描不完整时不生成可清理目标。"
        "任务、结果、历史版本、原文核对、审核、导出引用及确认范围外的共享来源引用均阻止清理；最近24小时上传资料受保护，到期也不自动删除。"
        "用户先预览，再选择具体候选并二次确认，默认不勾选；预览有效10分钟。执行与新写互斥并重查引用、活动及文件身份，逐项显示删除/跳过/失败和可重试结果；不递归删除未知目录。"
        "首版F02仅手动清理，不新增定时或启动时自动扫描删除；备份、模型缓存、源码和凭证不在清理范围。"
    )
    paragraph = (
        "T1-F02“存储管理与安全清理”：2026-11-14原时点仅登记、未实现；2026-11-15用户要求开始实现，现行状态："
        + progress + contract
        + " 唯一现行方案入口：开发计划.json的future_extensions/1；实施证据见" + REPORT
        + "。本功能独立验收，不追改原五项正式3/3或其历史工程事实，不提升医学、S6/S7，不实现T1-F01断点续跑。"
    )
    changes = {"phase": args.phase, "status": status, "docx": {}, "csv": {}}
    for name in ["T1智能体开发计划.docx", "T1开发执行说明.docx"]:
        changes["docx"][name] = sync_docx(name, paragraph)

    plan = scoped_replace(load("开发计划.json"))
    current = scoped_replace(load("当前版本.json"))
    quality = load("质量与性能验收契约.json")
    entry = plan["future_extensions"][1]
    assert entry["id"] == "T1-F02"
    entry.update({
        "status": status,
        "implementation_started": True,
        "required_for_current_acceptance": False,
        "scope": [
            "可视占用统计和真实磁盘信息分别呈现",
            "固定业务根中的可识别无引用PDF、解析产物、图片审阅及导出候选",
            "预览、具体选择和二次确认后的手动安全清理",
            "所有任务/结果/历史/审核/导出共享引用、24小时上传缓冲和活动写入保护",
        ],
        "later_design_topics": ["定时自动清理、可配置保留期限和扩大清理范围留待后续需求，不默认启用。"],
        "current_boundary": "本功能独立实施验收，不追加为原五项或旧S阶段通过前置；医学、S6/S7和T1-F01保持原状态。",
        "original_registration_fact": "2026-11-14在第3项入口调整时仅登记，未实现、未删除文件；该原时点事实保留。",
        "implementation_authorization": "2026-11-15用户要求实现服务器资料占用统计与安全清理；主会话冻结首版手动策略、24小时上传保护及10分钟预览。",
        "manual_cleanup_contract": contract,
        "storage_roots": {
            "configured_workflow_root": "workflow.directory；默认runtime-data/workbench，T1_DATA_DIR设置时为DATA_DIR/workbench",
            "workflow_children": ["pdf", "runs", "figure-reviews", "exports"],
            "native_root": "codeRoot/runtime-data/s3-native-artifacts；不随T1_DATA_DIR自动迁移，仅已知工作台live/tombstone run及严格native命名可识别，其他历史开发资料保护为unknown",
        },
        "ui_entry": "工作台侧栏底部“存储管理”→占用/候选预览→选择具体候选→核对实际文件范围→“确认永久清理”；异常清空选择后重取预览。",
        "recovery_policy": "同预览同选择返回持久执行回执，改变选择拒绝；部分失败逐项显示实际删除与剩余项，重新预览确认后重试。中断计划不在启动时自动执行，用户显式重试时再核验引用和文件身份。超过保护期的未提交上传资料须明确列入候选；若当前页面仍保留的草稿资料被清理，保留本地File/标题/范围并提示需重新上传，由用户显式重传。",
        "measurement_limits": "文件大小按dev/inode去重，protected+reclaimable+unknown=total；符号链接不跟随，硬链接保护。删除回执仅报告实际unlink的文件字节/数量，不保证磁盘可用空间等量增长。",
        "api": {"statistics": "GET /api/workbench/storage", "preview": "POST /api/workbench/storage/preview {}", "cleanup": "POST /api/workbench/storage/cleanup {preview_id, version, candidate_ids}", "frontend_proxy": "/api/t1/workbench/storage"},
        "engineering_state": progress,
        "implementation_record": REPORT,
        "formal_review_scope": "本次用户新增F02按主报告单独记正式审查；原五项3/3及历史结论不重置、不追加。",
    })
    if args.phase == "deployed":
        deployment_path = HERE.parent / "reference-fix-deployment.json"
        if not deployment_path.is_file():
            deployment_path = HERE.parent / "deployment.json"
        deployment = json.loads(deployment_path.read_text())
        assert deployment["status"] == "deployed_and_current_data_preserved"
        implementation = json.loads((ROOT / REPORT).read_text())
        assert implementation["formal_review"]["used"] == 3, "Wait for the final authoritative report."
        specialized = implementation["checks"]["storage_specialized"]["passed"]
        related = implementation["checks"]["related_submission_paper_run_batch_deletion"]["passed"]
        entry["build_id"] = deployment["BUILD_ID"]
        entry["verification_boundary"] = f"{specialized}项后端专项、{related}项相关回归、9项gateway/helper及同一生产构建的5组唯一浏览器场景通过；浏览器业务API为mock。类型检查、触及lint及构建通过；线上仅GET/HEAD检查，无preview/cleanup POST、上传、导出或新增模型调用，不以工程验证提升医学或S6/S7。"
        entry["formal_review_record"] = REPORT + "#/formal_review"
    for document in [plan, current]:
        document["future_storage_management"].update({
            "status": status,
            "implementation_started": True,
            "record": ENTRY,
            "required_for_current_acceptance": False,
            "acceptance_boundary": "2026-11-15新增F02独立实施验收，原五项与S阶段结论不自动升级。",
        })
        old_boundary = document["current_reuse_entry_removal"]["engineering_validation"]["boundary"]
        if not old_boundary.startswith("本项原交付时点："):
            document["current_reuse_entry_removal"]["engineering_validation"]["boundary"] = "本项原交付时点：" + old_boundary + " F02现行状态独立见future_extensions/1。"
        boundary = document["current_run_isolation_and_model_consistency"]["acceptance_boundary"]
        document["current_run_isolation_and_model_consistency"]["acceptance_boundary"] = boundary.replace("T1-F02仍未实现。", "本项原交付时点T1-F02未实现；现行F02独立见future_extensions/1。")
    pending = plan["current_task_title_pdf_identity"]["pending_items"]
    pending["storage_management_auto_cleanup_batch_delete"] = "T1-F02现行状态独立见future_extensions/1；原第4项提交范围逻辑删除与本次无引用资料清理分别验收，不以原逻辑删除通过代替F02通过。"
    storage_boundary = plan["current_submission_task_feedback"]["unchanged_boundaries"]
    storage_boundary["storage"] = "本项提交范围删除交付时点未实现T1-F02；现行F02独立见future_extensions/1。旧任务、历史重复paper/run不迁并，仍被引用的来源受保护。"
    # These are historical fifth-item delivery boundaries, kept explicitly time-scoped.
    summary = plan["current_summary_completion"]
    summary["unchanged_boundaries"] = summary["unchanged_boundaries"].replace("T1-F02存储扩展仍未实现。", "本项交付时点未实施T1-F02存储扩展；现行独立见future_extensions/1。")
    for key, field in [
        ("followup_paragraph_glyph_tables_20261115", "unchanged_limits_and_boundaries"),
        ("followup_extraction_wait_navigation_20261115", "unchanged_boundaries"),
    ]:
        value = summary[key][field]
        summary[key][field] = value.replace("T1-F02存储扩展仍未实现。", "本项交付时点未实施T1-F02存储扩展；现行独立见future_extensions/1。").replace("T1-F02后续未实现保持。", "本项交付时点未实施T1-F02；现行F02独立见future_extensions/1。")

    decision = next(d for d in plan["decisions"] if d.get("id") == "D18")
    original_detail = load("开发计划.json", baseline=True)["decisions"][17]["detail"]
    original_options = load("开发计划.json", baseline=True)["decisions"][17]["options"]
    decision["detail"] = original_detail[:original_detail.index(" 服务器产物持续累积")] + " 2026-11-14仅登记的占用管理T1-F02于2026-11-15获用户授权实施：" + contract + " 现行状态与证据统一见future_extensions/1。"
    decision["options"] = original_options[:original_options.index(" 后续占用管理")] + " T1-F02首版采用预览/选择/确认后的手动清理；定时自动清理未启用，现行独立见future_extensions/1。"
    if "2026-11-15用户要求实现" not in decision["confirmed_basis"]:
        decision["confirmed_basis"] += " 2026-11-15用户要求实现服务器资料占用统计与安全清理，首版手动策略已确定。"
    f02_quality = next(v for v in quality["future_acceptance_items"] if v["task_id"] == "T1-F02")
    f02_quality.update({
        "status": status,
        "implementation_started": True,
        "required_for_current_acceptance": False,
        "measurement": "本次F02独立核验统计口径、选择/二次确认、24小时上传保护、10分钟预览、引用/并发/文件身份守卫及逐项失败/重试；证据见" + REPORT + "。" + progress,
    })
    fingerprints = {
        "plan_sha256": sha(DOCS / "T1智能体开发计划.docx"),
        "execution_guide_sha256": sha(DOCS / "T1开发执行说明.docx"),
        "validation": VALIDATION,
        "history": "原五项交付/审查/指纹按原时点保留；F02仅增量修改现行存储条目与时点歧义，文档基线见本次documentation/before-manifest.json。",
        "validation_status": "targeted_F02_document_structure_and_content_preservation_checked",
    }
    for document in [plan, current, quality]:
        document["current_document_fingerprints"] = copy.deepcopy(fingerprints)
    save("开发计划.json", plan)
    save("当前版本.json", current)
    save("质量与性能验收契约.json", quality)

    def task(row):
        row.update({"具体工作": "2026-11-14原时点仅登记；2026-11-15用户要求实现。" + contract,
                    "交付物": "可视占用与手动安全清理能力；限定工程证据见" + REPORT,
                    "状态": status, "工程开工例外": "用户已授权本次F02；独立验收，不追加旧阶段前置。",
                    "工程进度": progress, "现行需求修订": "storage-management-manual-2026-11-15", "本次工程交付": ENTRY})

    def acceptance(row):
        row.update({"名称": "存储管理与安全清理（首版手动）", "定义": contract,
                    "测量依据": ENTRY + "；" + REPORT + "。" + progress,
                    "已约定阈值": "最近24小时上传保护；预览10分钟；默认不勾选，二次确认；仍被引用/活动/未知项不得清理。无定时自动删除。",
                    "状态": status})

    def d18(row):
        row.update({"具体内容": decision["detail"], "已确认依据": decision["confirmed_basis"], "讨论选项": decision["options"]})

    def clarify(row):
        for key, value in row.items():
            row[key] = value.replace(OLD_DELETE, NEW_DELETE)

    def s5(row):
        row["工作"] = row["工作"].replace("后续存储任务T1-F02仅登记未实现。", "原交付时点T1-F02仅登记未实现；2026-11-15独立实施状态见开发计划.json#/future_extensions/1。")

    changes["csv"]["开发任务清单.csv"] = sync_csv("开发任务清单.csv", {"T1-F02": task, "T1-R13": clarify, "T1-R31": clarify})
    changes["csv"]["验收清单.csv"] = sync_csv("验收清单.csv", {"T1-F02": acceptance, "F09": clarify})
    changes["csv"]["待讨论实现决策.csv"] = sync_csv("待讨论实现决策.csv", {"D18": d18, "D20": clarify})
    changes["csv"]["开发阶段与验收.csv"] = sync_csv("开发阶段与验收.csv", {"S5": s5})
    (HERE / "changes.json").write_text(json.dumps(changes, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"phase": args.phase, "status": status, "updated_files": 9}, ensure_ascii=False))


if __name__ == "__main__":
    main()
