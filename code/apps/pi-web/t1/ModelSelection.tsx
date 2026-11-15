"use client";

import { useId, useState, type FormEvent } from "react";
import { ModelSelector } from "@/components/ModelSelector";
import { useI18n } from "@/hooks/useI18n";
import { api, jsonBody } from "./api";
import { WorkbenchNotes } from "./WorkbenchNotes";
import type { WorkbenchModelProfile, WorkbenchModels } from "../../../packages/contracts/src/workbench";

export function ModelSelection({ models, value, onChange, onModelsChange, errorText }: {
  models: WorkbenchModels; value: string | null; onChange: (id: string) => void;
  onModelsChange: (models: WorkbenchModels) => void; errorText: (error: unknown) => string;
}) {
  const { t } = useI18n();
  const [modelId, setModelId] = useState(""), [protocol, setProtocol] = useState<WorkbenchModelProfile["api"]>("openai-completions");
  const [reasoning, setReasoning] = useState<WorkbenchModelProfile["reasoning_effort"]>("none"), [contextWindow, setContextWindow] = useState(32768), [maxOutput, setMaxOutput] = useState(4096);
  const [saving, setSaving] = useState(false), [error, setError] = useState("");
  const [adding, setAdding] = useState(false), formId = useId();
  const selected = models.profiles.find(profile => profile.profile_id === value);
  const description = (profile: WorkbenchModelProfile) => `${profile.api === "openai-responses" ? "Responses" : "Chat Completions"} · ${profile.reasoning_effort === "none" ? t("t1.noReasoningParameter") : "medium"}`;
  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (saving) return; setSaving(true); setError("");
    try {
      const saved = await api<WorkbenchModels & { profile: WorkbenchModelProfile }>("workbench/models", jsonBody("POST", {
        model_id: modelId.trim(), api: protocol, reasoning_effort: reasoning, context_window: contextWindow, max_output_tokens: maxOutput,
      }));
      onModelsChange(saved); onChange(saved.profile.profile_id); setModelId(""); setAdding(false);
    } catch (cause) { setError(errorText(cause)); } finally { setSaving(false); }
  }
  return <div className="t1-model-selection">
    <div className="t1-model-choice"><ModelSelector
      options={models.profiles.map(profile => ({ provider: profile.provider, providerName: profile.provider, modelId: profile.profile_id, name: `${profile.model_id} · ${description(profile)}` }))}
      value={selected ? { provider: selected.provider, modelId: selected.profile_id } : null} selectedLabel={selected?.model_id}
      onChange={(_provider, id) => onChange(id)} ariaLabel={t("t1.extractionModel")} emptyLabel={t("t1.chooseModel")} variant="field" placement="auto" />
    </div>
    {!selected && <p className="t1-batch-error" role="alert">{t("t1.missingSavedModel")}</p>}
    {selected && <p className="t1-footnote t1-model-description">{selected.provider} · {description(selected)}{selected.configuration_source === "user" && ` · ${t("t1.modelCompatibilityUntested")}`}</p>}
    <p className="t1-footnote t1-model-next-tasks">{t("t1.modelNextTasks")}</p>
    <div className="t1-model-add"><button type="button" className="t1-button" aria-haspopup="dialog" aria-expanded={adding} onClick={() => setAdding(true)}>{t("t1.addModel")}</button></div>
    <WorkbenchNotes variant="creation" open={adding} title={t("t1.addModel")} busy={saving} onClose={() => { if (!saving) setAdding(false); }} footer={<>
      <button type="button" className="t1-button" disabled={saving} onClick={() => setAdding(false)}>{t("t1.cancelChanges")}</button>
      <button className="t1-primary" type="submit" form={formId} disabled={saving || !modelId.trim()}>{t(saving ? "t1.modelSaving" : "t1.saveModel")}</button>
    </>}>
      <form id={formId} className="t1-model-add-form" onSubmit={event => void add(event)}>
        <p className="t1-footnote">{t("t1.modelSameProvider", { provider: models.provider })}</p>
        <label className="t1-field">{t("t1.modelId")}<input required value={modelId} onChange={event => setModelId(event.target.value)} maxLength={160} placeholder="model-id" disabled={saving} /></label>
        <details><summary>{t("t1.modelAdvanced")}</summary><div className="t1-model-advanced">
          <label className="t1-field">{t("t1.modelProtocol")}<select value={protocol} onChange={event => setProtocol(event.target.value as typeof protocol)} disabled={saving}><option value="openai-completions">Chat Completions</option><option value="openai-responses">Responses</option></select></label>
          <label className="t1-field">{t("t1.modelReasoning")}<select value={reasoning} onChange={event => setReasoning(event.target.value as typeof reasoning)} disabled={saving}><option value="none">{t("t1.noReasoningParameter")}</option><option value="medium">medium</option></select></label>
          <label className="t1-field">{t("t1.modelContextLimit")}<input type="number" required min={4096} max={2000000} step={1} value={contextWindow} onChange={event => setContextWindow(Number(event.target.value))} disabled={saving} /></label>
          <label className="t1-field">{t("t1.modelOutputLimit")}<input type="number" required min={256} max={Math.min(8192, contextWindow - 1)} step={1} value={maxOutput} onChange={event => setMaxOutput(Number(event.target.value))} disabled={saving} /></label>
        </div><p className="t1-footnote">{t("t1.modelAdvancedHelp")}</p></details>
        <p className="t1-footnote">{t("t1.modelAddUntested")}</p>
        {error && <p className="t1-batch-error" role="alert">{error}</p>}
      </form>
    </WorkbenchNotes>
  </div>;
}
