import type { Scope } from "../../../packages/contracts/src/index";
import type { EvidenceCatalog } from "../../../packages/contracts/src/extraction-evidence";
export interface ScopeCatalog {
  catalog: EvidenceCatalog; default_scope: Scope; restricted_available: boolean;
  restricted_reason?: string | null; development_only: boolean;
}
export function applicableChoices(scope: Scope, catalog: EvidenceCatalog) {
  const images = catalog.image_types.filter(image => scope.cancers.mode === "all" || image.cancer_ids.some(id => scope.cancers.ids.includes(id)));
  return { images };
}
/** Refresh adopts the new version without dropping any draft selection, including invalid IDs. */
export function refreshDraftScope(scope: Scope | null, data: ScopeCatalog): Scope {
  return scope ? { ...scope, catalog_version: data.catalog.catalog_version, matching_policy_version: data.default_scope.matching_policy_version } : data.default_scope;
}
/** Invalid selections are retained until the user explicitly removes or changes them. */
export function scopeProblems(scope: Scope, data: ScopeCatalog): string[] {
  const { images } = applicableChoices(scope, data.catalog), issues: string[] = [];
  if (scope.catalog_version !== data.catalog.catalog_version) issues.push("catalog_version_mismatch");
  if (scope.features.mode !== "all" || scope.features.binding_ids.length) issues.push("feature_scope_removed");
  for (const [key, mode, ids, available] of [
    ["cancers", scope.cancers.mode, scope.cancers.ids, data.catalog.cancers.map(x => x.id)],
    ["image_types", scope.image_types.mode, scope.image_types.ids, images.map(x => x.id)],
  ] as const) {
    if (mode === "selected") {
      if (!data.restricted_available) issues.push("restricted_unavailable");
      if (!ids.length) issues.push(`${key}_selected_empty`);
      if (ids.some(id => !available.includes(id))) issues.push(`${key}_invalid`);
    }
    if (mode === "all" && ids.length) issues.push(`${key}_all_has_selections`);
  }
  return [...new Set(issues)];
}
