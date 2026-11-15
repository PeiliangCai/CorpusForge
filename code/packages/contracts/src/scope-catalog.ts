import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';

const closed = { additionalProperties: false } as const;
const id = Type.String({ pattern: '^[A-Za-z][A-Za-z0-9._:-]{0,159}$' });
const name = Type.String({ minLength: 1, maxLength: 500 });
const named = { id, name, aliases: Type.Optional(Type.Array(name, { uniqueItems: true })),
  description: Type.Optional(Type.String({ maxLength: 1000 })) };

/** Operator processing choices. This schema contains no medical review or feature vocabulary. */
export const ScopeCatalogConfigSchema = Type.Object({
  schema_version: Type.Literal('scope-catalog-1'),
  cancers: Type.Array(Type.Object({ ...named, image_type_ids: Type.Array(id, { uniqueItems: true }) }, closed)),
  image_types: Type.Array(Type.Object(named, closed)),
}, closed);
export type ScopeCatalogConfig = Static<typeof ScopeCatalogConfigSchema>;
export interface ScopeCatalogIssue { code: string; path: string }
export function scopeCatalogConfigIssues(value: unknown): ScopeCatalogIssue[] {
  if (!Value.Check(ScopeCatalogConfigSchema, value)) return [{ code: 'scope_catalog_schema_invalid', path: '' }];
  const config = value as ScopeCatalogConfig, issues: ScopeCatalogIssue[] = [], ids = new Set<string>();
  for (const [group, entries] of [['cancers', config.cancers], ['image_types', config.image_types]] as const) {
    for (const [index, entry] of entries.entries()) {
      if (ids.has(entry.id)) issues.push({ code: 'duplicate_id', path: `${group}/${index}/id` });
      ids.add(entry.id);
      if (!entry.name.trim() || entry.aliases?.some(term => !term.trim())) issues.push({ code: 'blank_name_or_alias', path: `${group}/${index}` });
    }
  }
  const imageIds = new Set(config.image_types.map(entry => entry.id));
  config.cancers.forEach((entry, index) => entry.image_type_ids.forEach((imageId, imageIndex) => {
    if (!imageIds.has(imageId)) issues.push({ code: 'unknown_image_type', path: `cancers/${index}/image_type_ids/${imageIndex}` });
  }));
  return issues;
}
