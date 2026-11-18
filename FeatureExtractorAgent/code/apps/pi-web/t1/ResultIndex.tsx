"use client";

import { useI18n } from "@/hooks/useI18n";
import type { WorkbenchRecord } from "../../../packages/contracts/src/workbench";
import { resultRecordKey } from "./submission-groups";

export function ResultIndex({ records, visibleRecords, selectedId, sourceLabel, onSelect }: {
  records: WorkbenchRecord[];
  visibleRecords: WorkbenchRecord[];
  selectedId?: string;
  sourceLabel?: (record: WorkbenchRecord) => string;
  onSelect: (id: string) => void;
}) {
  const { t } = useI18n();
  return <nav className="t1-candidate-index" aria-label={t("t1.candidateIndex")}>
    <div className="t1-index-heading"><strong>{t("t1.candidateIndex")}</strong></div>
    <div className="t1-index-list">{visibleRecords.map(record => <button
      key={resultRecordKey(record)}
      data-index-record-id={record.id}
      data-index-run-id={record.run_id}
      aria-current={selectedId === resultRecordKey(record) ? "true" : undefined}
      onClick={() => onSelect(resultRecordKey(record))}
    >
      <span className="t1-index-item-top"><b>{String(records.indexOf(record) + 1).padStart(2, "0")}</b><span>{t(record.evidence_role === "background_suggestion" ? "t1.backgroundSuggestions" : "t1.primaryDescriptions")}</span></span>
      {sourceLabel && <span className="t1-index-source" title={sourceLabel(record)}>{sourceLabel(record)}</span>}
      <span className="t1-index-preview">{record.fragments.slice(0, 3).map((fragment, i) => <span key={i}>{i > 0 && <span className="t1-preview-gap" aria-hidden="true"> ⋯ </span>}<span aria-label={t("t1.fragmentNumber", { number: i + 1 })}>{fragment.exact_quote}</span></span>)}</span>
      <span className="t1-index-item-bottom"><span>{record.fragments[0] && t("t1.physicalPage", { page: record.fragments[0].physical_page })}</span>{record.association === "paired" && <span>{t("t1.linkedFigures", { count: record.figure_ids.length })}</span>}</span>
    </button>)}</div>
  </nav>;
}
