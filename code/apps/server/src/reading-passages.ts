import type { ExtractionDocument } from '@t1/agent';
import type { WorkbenchFragment, WorkbenchReadingPassage } from '../../../packages/contracts/src/workbench.js';

type Span = Pick<WorkbenchFragment, 'block_id' | 'text_version' | 'start' | 'end'>;
const contains = (a: Span, b: Span) => a.block_id === b.block_id && a.text_version === b.text_version && a.start <= b.start && a.end >= b.end;
const identity = (text: string) => [...text.matchAll(/\b(?:case|patient|lesion)\s*(?:no\.?\s*)?(\d+)\b|(?:病例|患者|病灶)\s*(\d+)/giu)]
  .map(match => match[0].replace(/\s+/gu, '').toLowerCase());

/** These groups are layout hints, never replacement text or a claim that an omitted paragraph is complete. */
export function readingPassages(document: ExtractionDocument, fragments: readonly WorkbenchFragment[], units: readonly {
  structure_unit_ids?: string[]; source_type: string; kind: string; segments: WorkbenchFragment[];
}[]): WorkbenchReadingPassage[] {
  const blocks = new Map(document.blocks.map(block => [block.block_id, block]));
  const paragraphs = new Map<string, Span[]>();
  for (const unit of units) {
    if (!unit.structure_unit_ids?.length || !['body', 'figure_caption', 'footnote'].includes(unit.source_type) || unit.kind === 'table_cell') continue;
    const key = unit.structure_unit_ids.join('\0'), segments = paragraphs.get(key) ?? [];
    segments.push(...unit.segments); paragraphs.set(key, segments);
  }
  const groups = [...paragraphs.values()].map(segments => {
    const sorted = [...segments].sort((a, b) => blocks.get(a.block_id)!.reading_order - blocks.get(b.block_id)!.reading_order || a.start - b.start);
    const merged: Span[] = [];
    for (const segment of sorted) {
      const previous = merged.at(-1);
      if (previous?.block_id === segment.block_id && previous.text_version === segment.text_version && segment.start <= previous.end) previous.end = Math.max(previous.end, segment.end);
      else merged.push({ block_id: segment.block_id, text_version: segment.text_version, start: segment.start, end: segment.end });
    }
    return merged;
  });
  const checkedEdges: Array<{ left: Span; right: Span }> = [];
  if (document.schema_version === '3') for (const edge of document.structure.organization?.continuation_recovery?.relations ?? []) {
    if (edge.status !== 'engineering_checked') continue;
    const left = document.structure.units.find(unit => unit.unit_id === edge.from_unit_id)?.source_segments.at(-1);
    const right = document.structure.units.find(unit => unit.unit_id === edge.to_unit_id)?.source_segments[0];
    if (left && right) checkedEdges.push({ left, right });
  }
  function join(a: WorkbenchFragment, b: WorkbenchFragment): WorkbenchReadingPassage['joins'][number] | null {
    const x = blocks.get(a.block_id), y = blocks.get(b.block_id);
    if (!x || !y || a.text_version !== document.text_version || b.text_version !== document.text_version ||
      Array.from(x.text).slice(a.start, a.end).join('') !== a.exact_quote || Array.from(y.text).slice(b.start, b.end).join('') !== b.exact_quote) return null;
    const leftCases = identity(a.exact_quote), rightCases = identity(b.exact_quote);
    if (leftCases.length && rightCases.length && !leftCases.some(value => rightCases.includes(value))) return null;
    const group = groups.find(segments => segments.some(segment => contains(segment, a)) && segments.some(segment => contains(segment, b)));
    if (!group) return null;
    if (a.block_id === b.block_id) {
      if (a.end > b.start) return null;
      const whitespace = Array.from(x.text).slice(a.end, b.start).join('');
      if (!/^\s*$/u.test(whitespace)) return null;
      return { before_fragment: 0, kind: whitespace ? 'source_whitespace' : 'offset_contiguous', ...(whitespace ? { source_whitespace: whitespace } : {}) };
    }
    const i = group.findIndex(segment => contains(segment, a)), j = group.findIndex(segment => contains(segment, b));
    // Every non-whitespace source character between selected fragments must be selected.
    if (j !== i + 1 || a.end !== group[i]!.end || b.start !== group[j]!.start) return null;
    if (checkedEdges.some(edge => contains(edge.left, a) && edge.left.end === a.end && contains(edge.right, b) && edge.right.start === b.start)) {
      return { before_fragment: 0, kind: 'checked_continuation' };
    }
    if (x.page !== y.page || y.reading_order !== x.reading_order + 1) return null;
    const height = Math.max(x.bbox[3]! - x.bbox[1]!, y.bbox[3]! - y.bbox[1]!, 1);
    const overlap = Math.min(x.bbox[2]!, y.bbox[2]!) - Math.max(x.bbox[0]!, y.bbox[0]!);
    const width = Math.min(x.bbox[2]! - x.bbox[0]!, y.bbox[2]! - y.bbox[0]!);
    if (Math.abs(x.bbox[0]! - y.bbox[0]!) > Math.max(30, height * 3) || overlap < Math.min(width * .7, 20) ||
      y.bbox[1]! <= x.bbox[1]! || y.bbox[1]! - x.bbox[3]! > Math.max(14, height * 1.75)) return null;
    return { before_fragment: 0, kind: 'line_wrap' };
  }
  const passages: WorkbenchReadingPassage[] = [];
  fragments.forEach((fragment, index) => {
    const connection = index > 0 ? join(fragments[index - 1]!, fragment) : null;
    if (!connection) passages.push({ fragment_indices: [index], joins: [] });
    else { const passage = passages.at(-1)!; passage.fragment_indices.push(index); passage.joins.push({ ...connection, before_fragment: index }); }
  });
  return passages;
}
