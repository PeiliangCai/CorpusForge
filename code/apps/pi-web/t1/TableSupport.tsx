"use client";

import type { WorkbenchRecord } from "../../../packages/contracts/src/workbench";
import { useI18n } from "@/hooks/useI18n";
import { Fragments } from "./EvidenceSource";
import { DetailDisclosure } from "./DetailDisclosure";

/** Values remain subordinate to this record's original visual description. */
export function TableSupport({ support, onPage }: { support: NonNullable<WorkbenchRecord["supporting_table_evidence"]>; onPage(page: number): void }) {
  const { t } = useI18n();
  const content = (expanded: boolean, close?: () => void) => <div className={expanded ? "" : "t1-table-support-preview"}>{support.map((item, index) => {
    const marker = item.reference_evidence.map(f => f.exact_quote).join(" ").match(/\bTable\s*(\d+)\b|表\s*([0-9０-９]+)/iu);
    const page = (value: number) => { close?.(); onPage(value); };
    const links = item.value_contexts;
    const owned = (links ?? []).flatMap(value => [...value.fragments, ...value.context_fragments]);
    const shared = item.context_fragments?.filter(fragment => !owned.some(value => value.block_id === fragment.block_id && value.text_version === fragment.text_version && value.start <= fragment.start && value.end >= fragment.end));
    return <section key={index} data-table-supplement={index}><h4>{marker ? t("t1.tableNumber", { number: marker[1] ?? marker[2] }) : t("t1.tableSupport")}</h4>
      {links?.length ? <div className="t1-table-values">{links.map((value, i) => <section className="t1-table-value" data-table-value-index={i} key={value.cell_id}>
        <div className="t1-table-value-conditions"><Fragments fragments={value.context_fragments} onPage={page} /></div>
        <div className="t1-table-value-original"><Fragments fragments={value.fragments} onPage={page} /></div>
      </section>)}</div> : <Fragments fragments={item.fragments} onPage={page} />}
      {Boolean(shared?.length) && <div className="t1-table-support-context"><p>{t(links?.length ? "t1.tableSupportSharedContext" : "t1.tableSupportContext")}</p><Fragments fragments={shared!} onPage={page} /></div>}
    </section>;
  })}</div>;
  return <section className="t1-table-support" aria-label={t("t1.tableSupport")}><div className="t1-table-support-heading"><h3>{t("t1.tableSupport")}</h3>
    <DetailDisclosure title={t("t1.tableSupportDetails")}>{close => content(true, close)}</DetailDisclosure></div>{content(false)}</section>;
}
