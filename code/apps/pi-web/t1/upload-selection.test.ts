import test from 'node:test';
import assert from 'node:assert/strict';
import { File } from 'node:buffer';
import { setTimeout as delay } from 'node:timers/promises';
import { preparePdfSelection, SelectionLimitError, MAX_PDF_FILE_BYTES } from './upload-selection';

const pdf = (body: string, name = 'paper.pdf') => new File([`%PDF-1.4\n% ${body}\n%%EOF\n`], name);
test('complete bytes deduplicate aliases before the 20-paper quota while same-name same-size different content remains', async () => {
  const first = pdf('AAA'), other = pdf('BBB'); assert.equal(first.size, other.size);
  const values = [...Array.from({ length: 25 }, (_, i) => pdf('AAA', `alias-${i}.pdf`)), other];
  const result = await preparePdfSelection(values, new Set(), 20);
  assert.equal(result.selected.length, 2); assert.equal(result.duplicates, 24); assert.notEqual(result.selected[0]!.sha256, result.selected[1]!.sha256);
  const again = await preparePdfSelection([pdf('AAA', 'renamed.pdf')], new Set([result.selected[0]!.sha256!]), 0);
  assert.equal(again.selected.length, 0); assert.equal(again.duplicates, 1);
});
test('quota counts distinct content and refuses a genuinely oversized unique selection', async () => {
  await assert.rejects(preparePdfSelection(Array.from({ length: 21 }, (_, i) => pdf(String(i))), new Set(), 20), error => error instanceof SelectionLimitError && error.count === 21);
});
test('hashing reads only one file at a time and never reads an oversized invalid file', async () => {
  let active = 0, maximum = 0;
  const files = Array.from({ length: 4 }, (_, i) => ({ name: `${i}.pdf`, size: 10, arrayBuffer: async () => { active++; maximum = Math.max(maximum, active); await delay(2); active--; return new Uint8Array([i]).buffer; } }));
  const result = await preparePdfSelection(files, new Set(), 20); assert.equal(result.selected.length, 4); assert.equal(maximum, 1);
  const invalid = await preparePdfSelection([{ name: 'too-large.pdf', size: MAX_PDF_FILE_BYTES + 1, arrayBuffer: async () => { throw new Error('oversized file must not be read'); } }], new Set(), 20);
  assert.equal(invalid.selected[0]!.invalid, true); assert.equal(invalid.selected[0]!.sha256, undefined);
});
