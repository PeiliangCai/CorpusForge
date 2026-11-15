import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSourceEvidenceUnits, type ExtractionDocument } from '@t1/agent';
import type { WorkbenchFragment } from '../../../packages/contracts/src/workbench.js';
import { WorkbenchSources } from '../src/workbench.js';
import { readingPassages } from '../src/reading-passages.js';

const span = (block_id: string, text: string, start = 0, end = Array.from(text).length): WorkbenchFragment => ({ block_id, text_version: 'v1', start, end,
  exact_quote: Array.from(text).slice(start, end).join(''), occurrence: 0, physical_page: 1, bbox: [10, 10, 90, 20], location_precision: 'whole_textline_not_exact_glyph' });
function fixture(texts = ['A partly annular lesion', 'involves the lumen.', 'Other source content.']) {
  const fragments = texts.map((text, index) => span(`b${index}`, text));
  const document = { schema_version: '3', text_version: 'v1', blocks: texts.map((text, index) => ({ block_id: `b${index}`, text, page: 1,
    reading_order: index, bbox: [10, 10 + index * 12, 110, 20 + index * 12] })), structure: { units: [], organization: { continuation_recovery: { relations: [] } } } } as unknown as ExtractionDocument;
  const units = [{ structure_unit_ids: ['paragraph-1'], source_type: 'body', kind: 'sentence', segments: fragments }];
  return { document, fragments, units };
}

test('continuous source layout flows without changing source fragments, spelling or hard hyphens', () => {
  const { document, fragments, units } = fixture(['Partly annular/semi-', 'circumferential tumors involve the circum-', 'ference.']);
  const original = structuredClone(fragments), groups = readingPassages(document, fragments, units);
  assert.deepEqual(groups.map(group => group.fragment_indices), [[0, 1, 2]]);
  assert.deepEqual(groups[0]!.joins.map(join => join.kind), ['line_wrap', 'line_wrap']);
  assert.deepEqual(fragments, original);
});

test('source gaps, paragraphs, unknown mappings, table cells and different cases remain separate', () => {
  const { document, fragments, units } = fixture();
  assert.equal(readingPassages(document, [fragments[0]!, fragments[2]!], units).length, 2);
  const differentParagraphs = fragments.map((fragment, index) => ({ structure_unit_ids: [`p${index}`], source_type: 'body', kind: 'sentence', segments: [fragment] }));
  assert.equal(readingPassages(document, fragments, differentParagraphs).length, 3);
  assert.equal(readingPassages(document, fragments, [{ ...units[0]!, structure_unit_ids: [] }]).length, 3);
  assert.equal(readingPassages(document, fragments, [{ ...units[0]!, kind: 'table_cell', source_type: 'table' }]).length, 3);
  const cases = fixture(['Patient 1 has an annular lesion.', 'Patient 2 has an irregular lesion.']);
  assert.equal(readingPassages(cases.document, cases.fragments, cases.units).length, 2);
});

test('columns, vertical paragraph boundaries and unchecked page continuations are not guessed', () => {
  for (const change of ['column', 'vertical', 'page']) {
    const { document, fragments, units } = fixture();
    if (change === 'column') document.blocks[1]!.bbox = [220, 22, 320, 32];
    if (change === 'vertical') document.blocks[1]!.bbox = [10, 120, 110, 130];
    if (change === 'page') document.blocks[1]!.page = 2;
    assert.equal(readingPassages(document, fragments.slice(0, 2), units).length, 2, change);
  }
});

test('same-block joins retain only the exact original whitespace; skipped source characters block the join', () => {
  const { document, units } = fixture(['A lesion.  Another lesion.']);
  const a = span('b0', document.blocks[0]!.text, 0, 9), b = span('b0', document.blocks[0]!.text, 11);
  const group = readingPassages(document, [a, b], units)[0]!;
  assert.equal(group.joins[0]!.kind, 'source_whitespace'); assert.equal(group.joins[0]!.source_whitespace, '  ');
  assert.equal(readingPassages(document, [span('b0', document.blocks[0]!.text, 0, 1), b], units).length, 2);
  assert.equal(readingPassages(document, [a, { ...b, exact_quote: 'rewritten' }], units).length, 2);
  assert.equal(readingPassages(document, [a, { ...b, text_version: 'other-version' }], units).length, 2);
});

test('only an exact engineering-checked continuation edge can cross a page', () => {
  const { document, fragments, units } = fixture(['An annular lesion', 'involves the lumen.']);
  document.blocks[1]!.page = 2;
  const value = document as Extract<ExtractionDocument, { schema_version: '3' }>;
  value.structure.units = [{ unit_id: 'from', source_segments: [fragments[0]!] }, { unit_id: 'to', source_segments: [fragments[1]!] }] as unknown as typeof value.structure.units;
  const recovery = value.structure.organization!.continuation_recovery!;
  recovery.relations = [{ status: 'engineering_checked', from_unit_id: 'from', to_unit_id: 'to' }] as unknown as typeof recovery.relations;
  const groups = readingPassages(document, fragments, units);
  assert.equal(groups.length, 1); assert.equal(groups[0]!.joins[0]!.kind, 'checked_continuation');
});

test('saved L07 real-paper line fragments have traceable continuous paragraph layout without altering frozen evidence', async () => {
  const paper = (await new WorkbenchSources().retained(true)).findLast(value => value.row.id === 'L07' && value.outputs.length > 0)!;
  const units = buildSourceEvidenceUnits(paper.document), versions = paper.outputs.at(-1)!.result.records;
  let edges = 0, joined = 0;
  for (const version of versions) {
    const fragments = version.record.quote_span.segments, original = structuredClone(fragments), groups = readingPassages(paper.document, fragments, units);
    edges += Math.max(0, fragments.length - 1); joined += groups.reduce((sum, group) => sum + group.joins.length, 0);
    assert.deepEqual(fragments, original);
  }
  assert.equal(edges, 74); assert.equal(joined, 74);
});
