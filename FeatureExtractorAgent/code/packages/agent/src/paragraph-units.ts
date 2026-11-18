import { createHash } from 'node:crypto';
import { ContractError } from '@t1/contracts';
import type { ExtractionBatch, ExtractionDocument, ArticleScopeManifest } from './article-scope.js';
import { buildSourceEvidenceUnits, classifySourceSpan, type SourceSpan } from './source-evidence-units.js';

export const PARAGRAPH_ORGANIZATION_VERSION = 'source-paragraph-units-1';
export const CONTENT_ORGANIZATION_VERSION = 'source-content-units-2';
export interface SourceParagraph {
  paragraph_id: string; kind: 'paragraph' | 'caption' | 'heading' | 'table_row' | 'figure_text' | 'list_item' | 'footnote' | 'text_item' | 'source_fragment';
  basis: 'native_paragraph' | 'checked_continuation' | 'native_boundary_fragment' | 'source_line_fallback' | 'checked_native_column_continuation' | 'mapped_figure_labels';
  native_unit_ids: string[]; source_spans: SourceSpan[]; block_ids: string[];
  region_id?: string; member_units?: Array<{ member_id: string; source_spans: SourceSpan[] }>;
  boundary_evidence?: string[];
}
export interface ParagraphProcessingUnit {
  unit_id: string; paragraph_id: string; kind: SourceParagraph['kind'];
  fragment_index: number; fragment_count: number; source_spans: SourceSpan[]; block_ids: string[];
  member_units?: SourceParagraph['member_units']; region_id?: string; boundary_evidence?: string[];
}
export type ParagraphBatch = ExtractionBatch & { processing_units: ParagraphProcessingUnit[] };
const unique = (ids: string[]) => [...new Set(ids)];
const contains = (a: SourceSpan, b: SourceSpan) => a.block_id === b.block_id && a.text_version === b.text_version && a.start <= b.start && a.end >= b.end;
const caseIds = (text: string) => [...text.matchAll(/\b(?:case|patient|lesion)\s*(?:no\.?\s*)?(\d+)\b|(?:病例|患者|病灶)\s*(\d+)/giu)].map(m => m[0].replace(/\s+/g, '').toLowerCase());

/** Conservative grouping over unchanged raw lines. A native text unit is a
 * paragraph hint only when every whole line maps uniquely; unknown boundaries
 * remain separate fragments, never a geometry-only reconstructed paragraph. */
export function buildSourceParagraphs(document: ExtractionDocument): SourceParagraph[] {
  const blocks = new Map(document.blocks.map(b => [b.block_id, b]));
  const candidates = document.schema_version === '3' ? document.structure.units.filter(u => ['exact', 'normalized_alignment'].includes(u.mapping.status) &&
    ['text', 'list_item', 'caption', 'footnote', 'section_header'].includes(u.kind) && u.source_segments.length) : [];
  const claims = new Map<string, Set<string>>();
  for (const u of candidates) for (const s of u.source_segments) { const ids = claims.get(s.block_id) ?? new Set<string>(); ids.add(u.unit_id); claims.set(s.block_id, ids); }
  const result: SourceParagraph[] = [], used = new Set<string>();
  const whole = (ids: string[], nativeIds: string[], kind: SourceParagraph['kind'], basis: SourceParagraph['basis']) => {
    if (!ids.length) return;
    const spans = ids.map(id => ({ block_id: id, text_version: document.text_version, start: 0, end: Array.from(blocks.get(id)!.text).length }));
    result.push({ paragraph_id: 'para-' + createHash('sha256').update(JSON.stringify([document.text_version, spans])).digest('hex').slice(0, 20),
      kind, basis, native_unit_ids: nativeIds, source_spans: spans, block_ids: ids });
    ids.forEach(id => used.add(id));
  };
  const boundary = (leftId: string, rightId: string) => {
    const a = blocks.get(leftId)!, b = blocks.get(rightId)!;
    if (a.page !== b.page || b.reading_order !== a.reading_order + 1) return true;
    const overlap = Math.min(a.bbox[2]!, b.bbox[2]!) - Math.max(a.bbox[0]!, b.bbox[0]!);
    if (overlap < 0 || b.bbox[1]! <= a.bbox[1]!) return true;
    const x = caseIds(a.text), y = caseIds(b.text);
    return x.length > 0 && y.length > 0 && !x.some(id => y.includes(id));
  };
  for (const u of candidates) {
    const ids = unique(u.source_segments.map(s => s.block_id)).filter(id => blocks.has(id)).sort((a, b) => blocks.get(a)!.reading_order - blocks.get(b)!.reading_order);
    if (!ids.length || ids.some(id => claims.get(id)!.size !== 1 || used.has(id))) continue;
    const mapped = ids.every(id => {
      const text = Array.from(blocks.get(id)!.text), spans = u.source_segments.filter(s => s.block_id === id).sort((a, b) => a.start - b.start); let end = 0;
      for (const s of spans) {
        if (s.text_version !== document.text_version || s.start < 0 || s.end > text.length || s.start > end && text.slice(end, s.start).join('').trim()) return false;
        end = Math.max(end, s.end);
      }
      return !text.slice(end).join('').trim();
    });
    if (!mapped) continue;
    const kind: SourceParagraph['kind'] = u.kind === 'section_header' ? 'heading' : u.kind === 'caption' || u.kind === 'footnote' ? 'caption'
      : ids.some(id => classifySourceSpan(document, { block_id: id, text_version: document.text_version, start: 0, end: Array.from(blocks.get(id)!.text).length }) === 'table') ? 'table_row' : 'paragraph';
    let run: string[] = [], parts = 0;
    for (const id of ids) {
      if (run.length && boundary(run.at(-1)!, id)) { whole(run, [u.unit_id], kind === 'paragraph' ? 'source_fragment' : kind, 'native_boundary_fragment'); parts++; run = []; }
      run.push(id);
    }
    whole(run, [u.unit_id], parts && kind === 'paragraph' ? 'source_fragment' : kind, parts ? 'native_boundary_fragment' : 'native_paragraph');
  }
  // Only explicit checked continuation edges may connect native paragraphs
  // across columns/pages; candidate_unverified relations never grant a join.
  if (document.schema_version === '3') for (const edge of document.structure.organization?.continuation_recovery?.relations ?? []) {
    const a = result.find(p => p.basis !== 'native_boundary_fragment' && p.native_unit_ids.includes(edge.from_unit_id));
    const b = result.find(p => p.basis !== 'native_boundary_fragment' && p.native_unit_ids.includes(edge.to_unit_id));
    if (!a || !b || a === b || a.kind !== b.kind || !['paragraph', 'caption'].includes(a.kind)) continue;
    const x = caseIds(a.block_ids.map(id => blocks.get(id)!.text).join('\n')), y = caseIds(b.block_ids.map(id => blocks.get(id)!.text).join('\n'));
    if (x.length && y.length && !x.some(id => y.includes(id))) continue;
    a.block_ids.push(...b.block_ids); a.source_spans.push(...b.source_spans); a.native_unit_ids.push(...b.native_unit_ids); a.basis = 'checked_continuation';
    result.splice(result.indexOf(b), 1);
  }
  for (const b of document.blocks) if (!used.has(b.block_id)) whole([b.block_id], [], classifySourceSpan(document, { block_id: b.block_id,
    text_version: document.text_version, start: 0, end: Array.from(b.text).length }) === 'table' ? 'table_row' : 'source_fragment', 'source_line_fallback');
  return result.sort((a, b) => blocks.get(a.block_ids[0]!)!.reading_order - blocks.get(b.block_ids[0]!)!.reading_order);
}

/** Same-paragraph table references may be necessary context rather than part
 * of the target visual sentence. This never joins unrelated paragraphs. */
export function sameSourceParagraph(document: ExtractionDocument, primary: readonly SourceSpan[], references: readonly SourceSpan[], inputOrganizationVersion?: string) {
  const parents = inputOrganizationVersion === CONTENT_ORGANIZATION_VERSION ? buildSourceContentUnits(document) : buildSourceParagraphs(document);
  return primary.length > 0 && references.length > 0 && parents.some(p => ['native_paragraph', 'checked_continuation', 'checked_native_column_continuation'].includes(p.basis) &&
    ['paragraph', 'caption'].includes(p.kind) && primary.some(s => p.source_spans.some(t => contains(t, s))) &&
    references.every(s => p.source_spans.some(t => contains(t, s))));
}

const terminal = (text: string) => /[.!?。！？][\s\p{Pe}\p{Pf}'"]*$/u.test(text.trimEnd());
const median = (values: number[]) => values.length ? [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]! : 0;

/** Versioned input organization only. It never rewrites the IR, citations or
 * historical plans. A native text label alone is not a natural paragraph. */
export function buildSourceContentUnits(document: ExtractionDocument, sourceGlyphPolicyVersion?: string): SourceParagraph[] {
  const result = buildSourceParagraphs(document).map(p => ({ ...p, block_ids: [...p.block_ids], source_spans: [...p.source_spans] }));
  if (document.schema_version !== '3') return result;
  const blocks = new Map(document.blocks.map(b => [b.block_id, b])), native = new Map(document.structure.units.map(u => [u.unit_id, u]));
  const stableId = (kind: string, spans: SourceSpan[], region = '') => 'content-' + createHash('sha256').update(JSON.stringify([CONTENT_ORGANIZATION_VERSION, document.text_version, kind, region, spans])).digest('hex').slice(0, 20);
  // Glyph fidelity does not change a mechanically known sentence boundary.
  const knownSentences = buildSourceEvidenceUnits(document, sourceGlyphPolicyVersion).filter(u => u.kind === 'sentence' && u.source_type === 'body');
  const isCompleteProse = (p: SourceParagraph) => p.source_spans.some(span => knownSentences.some(u => u.segments.every(s => contains(span, s))));
  const pictures = document.structure.units.filter(u => u.kind === 'picture').flatMap(u => u.provenance.filter(p => p.bbox && p.coordinate_system === 'crop_rotated_top_left_pt').map(p => ({ id: u.unit_id, page: p.physical_page, box: p.bbox! })));
  const pictureOf = (p: SourceParagraph) => {
    // Reliable multiline prose, captions, headings, lists and tables win over
    // an oversized native picture rectangle. Only clearly independent mapped
    // single-line labels without a complete prose sentence enter a picture group.
    if (p.block_ids.length !== 1 || p.native_unit_ids.length !== 1 || !['paragraph', 'source_fragment'].includes(p.kind) || isCompleteProse(p)) return undefined;
    const unit = native.get(p.native_unit_ids[0]!);
    if (!unit || unit.kind !== 'text' || !['exact', 'normalized_alignment'].includes(unit.mapping.status)) return undefined;
    const b = blocks.get(p.block_ids[0]!)!, box = b.bbox;
    const matches = pictures.filter(q => q.page === b.page && box[0]! >= q.box[0]! - 1 && box[1]! >= q.box[1]! - 1 && box[2]! <= q.box[2]! + 1 && box[3]! <= q.box[3]! + 1);
    return matches.length === 1 ? matches[0] : undefined;
  };
  const figureMembers = new Map<string, { picture: typeof pictures[number]; members: SourceParagraph[] }>();
  for (const p of [...result]) {
    const picture = pictureOf(p); if (!picture) continue;
    const key = `${picture.id}:${picture.page}`, group = figureMembers.get(key) ?? { picture, members: [] };
    group.members.push(p); figureMembers.set(key, group); result.splice(result.indexOf(p), 1);
  }
  for (const { picture, members } of figureMembers.values()) {
    members.sort((a, b) => blocks.get(a.block_ids[0]!)!.reading_order - blocks.get(b.block_ids[0]!)!.reading_order);
    const spans = members.flatMap(p => p.source_spans);
    result.push({ paragraph_id: stableId('figure_text', spans, picture.id), kind: 'figure_text', basis: 'mapped_figure_labels',
      native_unit_ids: unique(members.flatMap(p => p.native_unit_ids)), block_ids: unique(members.flatMap(p => p.block_ids)), source_spans: spans,
      region_id: picture.id, member_units: members.map(p => ({ member_id: p.paragraph_id, source_spans: p.source_spans })),
      boundary_evidence: ['single_mapped_labels_inside_one_picture', 'not_body_caption_heading_list_or_table', 'members_remain_independent_not_continuous_prose'] });
  }
  // A vendor node can accidentally join body text and a caption across pages.
  // Recover only same-page column continuations with independent source-flow
  // witnesses. Other page/region/identity boundaries remain intact.
  for (const u of document.structure.units.filter(u => u.kind === 'text' && u.source_regions && u.provenance.length > 1)) {
    for (let i = 1; i < u.source_regions!.length; i++) {
      const leftRegion = u.source_regions![i - 1]!, rightRegion = u.source_regions![i]!;
      const leftLocation = u.provenance[leftRegion.provenance_index], rightLocation = u.provenance[rightRegion.provenance_index];
      if (!leftLocation?.bbox || !rightLocation?.bbox || leftLocation.physical_page !== rightLocation.physical_page || !['exact', 'normalized_alignment'].includes(leftRegion.mapping_status) || !['exact', 'normalized_alignment'].includes(rightRegion.mapping_status)) continue;
      const aIds = unique(leftRegion.source_segments.map(s => s.block_id)), bIds = unique(rightRegion.source_segments.map(s => s.block_id));
      const a = result.find(p => p.native_unit_ids.includes(u.unit_id) && p.kind !== 'figure_text' && aIds.every(id => p.block_ids.includes(id)));
      const b = result.find(p => p.native_unit_ids.includes(u.unit_id) && p.kind !== 'figure_text' && bIds.every(id => p.block_ids.includes(id)));
      if (!a || !b || a === b || !['paragraph', 'source_fragment'].includes(a.kind) || !['paragraph', 'source_fragment'].includes(b.kind) || aIds.length < 2 || bIds.length < 2) continue;
      const left = aIds.map(id => blocks.get(id)!), right = bIds.map(id => blocks.get(id)!);
      if ([...left, ...right].some(v => !v) || [...left, ...right].some(v => v.page !== leftLocation.physical_page)) continue;
      const first = right[0]!, last = left.at(-1)!, lb = leftLocation.bbox, rb = rightLocation.bbox;
      const height = (values: typeof left) => median(values.map(v => v.bbox[3]! - v.bbox[1]!));
      const pitch = (values: typeof left) => median(values.slice(1).map((v, index) => v.bbox[1]! - values[index]!.bbox[1]!).filter(v => v > 0));
      const ah = height(left), bh = height(right), ap = pitch(left), bp = pitch(right), tolerance = Math.max(2, ah * .5);
      const ac = leftLocation.native_charspan, bc = rightLocation.native_charspan;
      if (!ac || !bc || ac.length < 2 || bc.length < 2 || ac[1]! > bc[0]! || u.native_text.slice(ac[1]!, bc[0]!).trim() ||
        rb[0]! <= lb[2]! || first.bbox[1]! >= last.bbox[1]! || ah <= 0 || bh <= 0 || Math.max(ah, bh) / Math.min(ah, bh) > 1.12 ||
        ap <= 0 || bp <= 0 || Math.max(ap, bp) / Math.min(ap, bp) > 1.15 || terminal(last.text) ||
        last.bbox[2]! < lb[2]! - tolerance || first.bbox[0]! > rb[0]! + tolerance) continue;
      const x = caseIds(left.map(v => v.text).join('\n')), y = caseIds(right.map(v => v.text).join('\n'));
      if (x.length && y.length && !x.some(id => y.includes(id))) continue;
      // Never bridge an explicitly mapped heading/caption/table region.
      if ([...left, ...right].some(v => document.structure.units.some(other => other.unit_id !== u.unit_id && ['section_header', 'caption', 'table', 'table_cell', 'footnote'].includes(other.kind) && other.source_segments.some(s => s.block_id === v.block_id)))) continue;
      a.block_ids.push(...b.block_ids); a.source_spans.push(...b.source_spans); a.kind = 'paragraph'; a.basis = 'checked_native_column_continuation';
      a.boundary_evidence = ['same_native_paragraph_contiguous_charspans', 'same_page_different_columns', 'similar_source_line_height_and_pitch', 'nonterminal_full_column_end', 'unindented_next_column_start', 'no_heading_caption_table_or_explicit_case_conflict'];
      a.paragraph_id = stableId(a.kind, a.source_spans); result.splice(result.indexOf(b), 1);
    }
  }
  for (const p of result) {
    if (p.kind !== 'paragraph' && p.kind !== 'caption') continue;
    const kinds = p.native_unit_ids.map(id => native.get(id)?.kind);
    if (kinds.length && kinds.every(kind => kind === 'list_item')) p.kind = 'list_item';
    else if (kinds.length && kinds.every(kind => kind === 'footnote')) p.kind = 'footnote';
    else if (p.kind === 'paragraph' && p.block_ids.length === 1 && !isCompleteProse(p)) p.kind = 'text_item';
  }
  return result.sort((a, b) => blocks.get(a.block_ids[0]!)!.reading_order - blocks.get(b.block_ids[0]!)!.reading_order);
}

export function planParagraphBatches(document: ExtractionDocument, scope: ArticleScopeManifest,
  options: { maxCodePoints?: number; maxBlocks?: number; contextBlocks?: number; sourceGlyphPolicyVersion?: string; organizationVersion?: typeof CONTENT_ORGANIZATION_VERSION } = {}) {
  const maxChars = options.maxCodePoints ?? 8500, maxBlocks = options.maxBlocks ?? 128, context = options.contextBlocks ?? 6;
  if (maxChars < 100 || maxBlocks < 1 || maxBlocks > 128 || context < 0) throw new ContractError('invalid_paragraph_batch_limits');
  const allowed = new Set(scope.included_block_ids), blocks = new Map(document.blocks.map(b => [b.block_id, b]));
  const size = (ids: string[]) => unique(ids).reduce((n, id) => n + Array.from(blocks.get(id)!.text).length, 0);
  const fits = (ids: string[]) => unique(ids).length <= maxBlocks && size(ids) <= maxChars;
  const parents = (options.organizationVersion === CONTENT_ORGANIZATION_VERSION ? buildSourceContentUnits(document, options.sourceGlyphPolicyVersion) : buildSourceParagraphs(document)).flatMap(p => {
    const kept = p.block_ids.filter(id => allowed.has(id));
    if (!kept.length) return [];
    // Task scope boundaries cannot be closed by omitting an intervening source.
    if (kept.length !== p.block_ids.length) return kept.map(id => ({ ...p, paragraph_id: p.paragraph_id + '-' + blocks.get(id)!.reading_order,
      kind: 'source_fragment' as const, basis: 'source_line_fallback' as const, block_ids: [id], source_spans: p.source_spans.filter(s => s.block_id === id) }));
    return [p];
  });
  const statements = buildSourceEvidenceUnits(document, options.sourceGlyphPolicyVersion), units: ParagraphProcessingUnit[] = [];
  for (const p of parents) {
    let pieces: SourceSpan[][] = [p.source_spans];
    if (!fits(p.block_ids) && p.kind === 'figure_text') {
      pieces = []; let spans: SourceSpan[] = [];
      for (const member of p.member_units ?? []) {
        if (!fits(member.source_spans.map(s => s.block_id))) throw new ContractError('source_figure_label_exceeds_batch_limits');
        if (spans.length && !fits([...spans, ...member.source_spans].map(s => s.block_id))) { pieces.push(spans); spans = []; }
        spans.push(...member.source_spans);
      }
      if (spans.length) pieces.push(spans);
    } else if (!fits(p.block_ids)) {
      const sentences = statements.filter(u => u.segments.every(s => p.source_spans.some(t => contains(t, s))));
      const covered = new Set(sentences.flatMap(u => u.segments.map(s => s.block_id)));
      if (p.block_ids.some(id => !covered.has(id))) throw new ContractError('paragraph_statement_boundaries_exceed_batch_limits');
      pieces = []; let spans: SourceSpan[] = [];
      for (const s of sentences) {
        const ids = unique(s.segments.map(x => x.block_id));
        if (!fits(ids)) throw new ContractError('source_statement_exceeds_batch_limits');
        if (spans.length && !fits([...spans.map(x => x.block_id), ...ids])) { pieces.push(spans); spans = []; }
        spans.push(...s.segments.map(({ block_id, text_version, start, end }) => ({ block_id, text_version, start, end })));
      }
      if (spans.length) pieces.push(spans);
    }
    pieces.forEach((spans, i) => units.push({ unit_id: p.paragraph_id + '-part-' + (i + 1), paragraph_id: p.paragraph_id, kind: p.kind,
      fragment_index: i + 1, fragment_count: pieces.length, source_spans: spans, block_ids: unique(spans.map(s => s.block_id)),
      ...(p.region_id ? { region_id: p.region_id } : {}), ...(p.boundary_evidence ? { boundary_evidence: p.boundary_evidence } : {}),
      ...(p.member_units ? { member_units: p.member_units.filter(member => member.source_spans.every(s => spans.some(t => contains(t, s)))) } : {}) }));
  }
  const batches: ParagraphBatch[] = []; let group: ParagraphProcessingUnit[] = [];
  const flush = () => {
    if (!group.length) return;
    const ids = unique(group.flatMap(u => u.block_ids)), positions = ids.map(id => blocks.get(id)!.reading_order), first = Math.min(...positions), last = Math.max(...positions);
    const neighbor = document.blocks.filter(b => allowed.has(b.block_id) && !ids.includes(b.block_id) &&
      (b.reading_order >= first - context && b.reading_order < first || b.reading_order > last && b.reading_order <= last + context)).slice(0, context * 2).map(b => b.block_id);
    batches.push({ batch_id: 'batch-' + String(batches.length + 1).padStart(4, '0'), assigned_block_ids: ids, context_block_ids: neighbor,
      processing_units: group, physical_pages: unique(ids.map(id => String(blocks.get(id)!.page))).map(Number), source_code_points: size(ids),
      order_basis: 'native_mapped_then_source_fallback', warnings: ['paragraphs_are_input_units_not_required_output_quotes'] }); group = [];
  };
  for (const u of units) { if (group.length && !fits([...group.flatMap(v => v.block_ids), ...u.block_ids])) flush(); group.push(u); }
  flush();
  const assigned = new Set(batches.flatMap(b => b.assigned_block_ids));
  if (assigned.size !== allowed.size || [...allowed].some(id => !assigned.has(id)) || units.some(u => !u.block_ids.length)) throw new ContractError('paragraph_inventory_incomplete');
  return { version: options.organizationVersion ?? PARAGRAPH_ORGANIZATION_VERSION, paragraphs: parents, processing_units: units, batches };
}
