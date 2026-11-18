"use client";
import { useId, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { Scope } from "../../../packages/contracts/src/index";
import type { EvidenceCatalog } from "../../../packages/contracts/src/extraction-evidence";
import { applicableChoices, scopeProblems, type ScopeCatalog } from "./scope";
import { WorkbenchNotes } from "./WorkbenchNotes";

type Props = { scope: Scope; data: ScopeCatalog; onChange: (scope: Scope) => void };
export function ScopeSummary({ scope, data, snapshot, historical = false }: { scope: Scope; data?: ScopeCatalog | null; snapshot?: EvidenceCatalog; historical?: boolean }) {
  const { t } = useI18n();
  const catalog = snapshot ?? (!historical && data?.catalog.catalog_version === scope.catalog_version ? data.catalog : undefined);
  const names = (key: "cancers" | "image_types" | "features") => {
    const part = scope[key], ids = key === "features" ? scope.features.binding_ids : scope[key].ids;
    if (part.mode === "all") return t("t1.all");
    return ids.map(id => key === "cancers" ? catalog?.cancers.find(x => x.id === id)?.name ?? id
      : key === "image_types" ? catalog?.image_types.find(x => x.id === id)?.name ?? id
      : catalog?.features.find(x => x.feature_id === catalog.bindings.find(b => b.binding_id === id)?.feature_id)?.name ?? id).join(" · ") || t("t1.emptySelection");
  };
  return <dl className="t1-scope-summary"><div><dt>{t("t1.cancer")}</dt><dd>{names("cancers")}</dd></div><div><dt>{t("t1.modality")}</dt><dd>{names("image_types")}</dd></div>{historical && scope.features.mode === "selected" && <div><dt>{t("t1.feature")}</dt><dd>{names("features")}</dd></div>}</dl>;
}
export function ScopeConfiguration({ scope, data, onChange }: Props) {
  const { t } = useI18n(), [draft, setDraft] = useState<Scope | null>(null);
  const invalid = !draft || scopeProblems(draft, data).length > 0;
  return <>
    <div className="t1-scope-compact"><ScopeSummary scope={scope} data={data} />
      <button type="button" className="t1-button" aria-haspopup="dialog" aria-expanded={draft !== null} onClick={() => setDraft(structuredClone(scope))}>{t("t1.editScope")}</button>
      <p className="t1-footnote">{t("t1.scopeImmutable")}</p>
    </div>
    <WorkbenchNotes variant="creation" open={draft !== null} title={t("t1.scopeTitle")} onClose={() => setDraft(null)} footer={<>
      <button type="button" className="t1-button" onClick={() => setDraft(null)}>{t("t1.cancelChanges")}</button>
      <button type="button" className="t1-primary" disabled={invalid} onClick={() => { if (draft && !invalid) { onChange(draft); setDraft(null); } }}>{t("t1.applyScope")}</button>
    </>}>{draft && <ScopeEditor scope={draft} data={data} onChange={setDraft} showHeading={false} />}</WorkbenchNotes>
  </>;
}
export function ScopeEditor({ scope, data, onChange, showHeading = true }: Props & { showHeading?: boolean }) {
  const { t } = useI18n(), { images } = applicableChoices(scope, data.catalog);
  const id = useId();
  const layers = [
    { key: "cancers", label: t("t1.cancer"), part: scope.cancers, choices: data.catalog.cancers.map(x => ({ id: x.id, name: x.name, description: x.description })), valid: data.catalog.cancers.map(x => x.id) },
    { key: "image_types", label: t("t1.modality"), part: scope.image_types, choices: data.catalog.image_types.map(x => ({ id: x.id, name: x.name, description: x.description })), valid: images.map(x => x.id) },
  ] as const;
  function update(key: typeof layers[number]["key"], mode: "all" | "selected", ids: string[]) {
    onChange({ ...scope, [key]: { mode, ids } });
  }
  return <section className="t1-scope-editor">{showHeading && <h2>{t("t1.scopeTitle")}</h2>}
    {!data.restricted_available && <p className="t1-notice">{t("t1.restrictedUnavailable")}{data.restricted_reason && data.restricted_reason !== "medical_catalog_not_approved" && <small>{data.restricted_reason}</small>}</p>}
    {data.development_only && data.restricted_available && <p className="t1-badge">{t("t1.fixture")}</p>}
    <div className="t1-scope-layers">{layers.map(layer => <fieldset key={layer.key}><legend className="t1-sr-only">{layer.label}</legend>
      <label className="t1-scope-field-label" htmlFor={`${id}-${layer.key}`}>{layer.label}</label>
      <select id={`${id}-${layer.key}`} aria-label={layer.label} value={layer.part.mode} onChange={e => update(layer.key, e.target.value as "all" | "selected", [])}><option value="all">{t("t1.all")}</option><option value="selected">{t("t1.selected")}</option></select>
      {layer.part.mode === "selected" && <div className="t1-scope-options">
        {!layer.part.ids.length && <p role="alert">{t("t1.emptySelection")}</p>}
        {[...layer.choices, ...layer.part.ids.filter(id => !layer.choices.some(choice => choice.id === id)).map(id => ({ id, name: id, description: undefined }))].filter(choice => layer.valid.includes(choice.id) || layer.part.ids.includes(choice.id)).map(choice => {
          const invalid = !layer.valid.includes(choice.id);
          return <label key={choice.id} title={choice.description} className={invalid ? "t1-invalid-choice" : ""}><input type="checkbox" checked={layer.part.ids.includes(choice.id)} onChange={e => update(layer.key, "selected", e.target.checked ? [...layer.part.ids, choice.id] : layer.part.ids.filter(id => id !== choice.id))} />{choice.name}{invalid && <small>{t("t1.invalidSelection")}</small>}</label>;
        })}
        {(!data.restricted_available || !layer.valid.length) && <p>{t("t1.noChoices")}</p>}
      </div>}
    </fieldset>)}</div>
    <div className="t1-scope-preview"><strong>{t("t1.scopeSummary")}</strong><ScopeSummary scope={scope} data={data} /></div>
    <p className="t1-footnote">{t("t1.scopeImmutable")}</p><output hidden>{scopeProblems(scope, data).join(",")}</output>
  </section>;
}
