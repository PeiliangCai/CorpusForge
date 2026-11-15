"""Source-region regressions with actual PDFs; no parser model or external API."""
from copy import deepcopy
from hashlib import sha256
from pathlib import Path
import json
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from adapter import CODE, DoclingParseTextAdapter, ParseInput, ParserError
from figure_assets import discover_figures, extract_catalog, original_image_objects, original_caption_frames, supplemental_framed_captions, complete_bitmap_render_bounds, mechanically_check
from structured import build_ir
from pypdf import PdfWriter
from pypdf.generic import ArrayObject, DictionaryObject, FloatObject, NameObject, NumberObject, DecodedStreamObject
import pypdfium2 as pdfium
from PIL import Image


def constructed_pdf(path, rotation=0, user_unit=1, second_image=False, note_before=False, split_caption=False, framed_caption=False, framed_multi=False):
    writer = PdfWriter(); page = writer.add_blank_page(width=300, height=420 if framed_multi else 220)
    page.cropbox.lower_left = (20, 10); page.cropbox.upper_right = (280, 410 if framed_multi else 210)
    page[NameObject('/Rotate')] = NumberObject(rotation)
    page[NameObject('/UserUnit')] = NumberObject(user_unit)
    font = DictionaryObject({NameObject('/Type'): NameObject('/Font'), NameObject('/Subtype'): NameObject('/Type1'), NameObject('/BaseFont'): NameObject('/Helvetica')})
    image = DecodedStreamObject()
    image.update({NameObject('/Type'): NameObject('/XObject'), NameObject('/Subtype'): NameObject('/Image'), NameObject('/Width'): NumberObject(2),
                  NameObject('/Height'): NumberObject(2), NameObject('/ColorSpace'): NameObject('/DeviceRGB'), NameObject('/BitsPerComponent'): NumberObject(8)})
    image.set_data(bytes([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0]))
    page[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'): DictionaryObject({NameObject('/F1'): writer._add_object(font)}),
             NameObject('/XObject'): DictionaryObject({NameObject('/Im0'): writer._add_object(image)})})
    stream = DecodedStreamObject(); stream.set_data((b'q 120 0 0 80 70 110 cm /Im0 Do Q\n' if framed_multi else b'q 120 0 0 80 70 70 cm /Im0 Do Q\n') +
      (b'q 20 0 0 80 190 70 cm /Im0 Do Q\n' if second_image else b'') +
      (b'BT /F1 8 Tf 65 58 Td (Note: (a) no pleural invasion;) Tj 0 -10 Td (no metastasis is observed.) Tj ET\n' if note_before else b'') +
      (b'q .92 g .5 0 0 -.5 50 200 cm 40 190 240 162 re f Q\nBT /F1 10 Tf 75 94 Td (Fig. 1 Original title.) Tj 0 -12 Td (continued title) Tj ET\n'
       b'BT /F1 7 Tf 75 68 Td (A: first literal note.) Tj 0 -19 Td (B: second literal note.) Tj 0 -19 Td (CT, literal abbreviation.) Tj ET\n'
       b'BT /F1 9 Tf 75 13 Td (Following body paragraph.) Tj ET' if framed_multi else
       b'q .92 g .5 0 0 -.5 50 200 cm 40 268 240 88 re f Q\nBT /F1 10 Tf 75 54 Td (Fig. 1 Original title.) Tj ET\n'
       b'BT /F1 7 Tf 75 40 Td (A: first literal note.) Tj 0 -9 Td (B: second literal note.) Tj ET\n'
       b'BT /F1 9 Tf 75 13 Td (Following body paragraph.) Tj ET' if framed_caption else
       b'BT /F1 9 Tf 75 33 Td (Fig. 1 CT source fixture.) Tj ET' if note_before else
       b'BT /F1 8 Tf 65 55 Td (Fig. 1) Tj 0 -10 Td (First literal caption line.) Tj 0 -10 Td (Second literal caption line.) Tj ET' if split_caption else
       b'BT /F1 9 Tf 75 45 Td (Fig. 1 CT source fixture.) Tj ET'))
    page[NameObject('/Contents')] = writer._add_object(stream)
    writer.write(path)


def source_ir(path, run_id):
    source = DoclingParseTextAdapter().parse(ParseInput(run_id, run_id, str(path), sha256(path.read_bytes()).hexdigest(), True))
    pdf = pdfium.PdfDocument(path); page = pdf[0]
    try:
        image_box = original_image_objects(page, source['pages'][0])[0]['bbox']
    finally:
        page.close(); pdf.close()
    block = next(b for b in source['blocks'] if b['text'].startswith('Fig. 1'))
    box = lambda b: dict(zip(['l', 't', 'r', 'b'], b), coord_origin='TOPLEFT')
    native = {'texts': [{'self_ref': '#/texts/0', 'label': 'caption', 'text': block['text'], 'orig': block['text'],
               'prov': [{'page_no': 1, 'bbox': box(block['bbox']), 'charspan': [0, len(block['text'])]}]}],
              'tables': [], 'pictures': [{'self_ref': '#/pictures/0', 'prov': [{'page_no': 1, 'bbox': box(image_box)}],
                 'captions': [{'$ref': '#/texts/0'}]}], 'groups': [],
              'pages': {'1': {'size': {'width': source['pages'][0]['width'], 'height': source['pages'][0]['height']}}},
              'body': {'self_ref': '#/body', 'children': [{'$ref': '#/pictures/0'}, {'$ref': '#/texts/0'}]}}
    note_blocks = [b for b in source['blocks'] if b['text'].startswith(('Note:', 'no metastasis'))]
    if note_blocks:
        note_box = [min(b['bbox'][0] for b in note_blocks), min(b['bbox'][1] for b in note_blocks),
                    max(b['bbox'][2] for b in note_blocks), max(b['bbox'][3] for b in note_blocks)]
        text = ' '.join(b['text'] for b in note_blocks)
        native['texts'].append({'self_ref': '#/texts/1', 'label': 'caption', 'text': text, 'orig': text,
                               'prov': [{'page_no': 1, 'bbox': box(note_box), 'charspan': [0, len(text)]}]})
        native['pictures'][0]['captions'] = [{'$ref': '#/texts/1'}]
        native['body']['children'].append({'$ref': '#/texts/1'})
    document = build_ir(source, native, 'docling-standard-cpu', {'parser_version': 'constructed-no-native-model', 'configuration': {}}, [],
                        {'path': 'synthetic-native-not-written', 'sha256': '0'*64, 'format': 'candidate_native_json'})
    return document, image_box


class FigureAssetTests(unittest.TestCase):
    def setUp(self):
        parent = CODE/'runtime-data/user-feedback-2026-11-05/pdf/tests'; parent.mkdir(parents=True, exist_ok=True)
        self.tmp = tempfile.TemporaryDirectory(dir=parent); self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_original_filled_caption_frame_retains_smaller_literal_notes_without_next_body_or_auto_approval(self):
        path = self.root/'framed-caption.pdf'; constructed_pdf(path, framed_caption=True)
        document, image_box = source_ir(path, 'framed-caption-fixture')
        # A numbered Figure title may be classified as a section heading by the
        # native layout model; only that literal title gets this exception.
        next(u for u in document['structure']['units'] if u['kind'] == 'caption')['kind'] = 'section_header'
        before = deepcopy(document); pdf_before = path.read_bytes()
        catalog = extract_catalog(document, self.root/'framed-output')
        figure = next(f for f in catalog['figures'] if f['figure_number'] == '1')
        self.assertEqual([s['exact_quote'] for s in figure['caption_segments']],
                         ['Fig. 1 Original title.', 'A: first literal note.', 'B: second literal note.'])
        self.assertNotIn('Following body paragraph.', '\n'.join(s['exact_quote'] for s in figure['caption_segments']))
        self.assertEqual(figure['verification']['status'], 'needs_review'); self.assertFalse(figure['verification']['human_approved'])
        self.assertEqual(document, before); self.assertEqual(path.read_bytes(), pdf_before)
        for actual, expected in zip(figure['regions'][0]['bbox'], image_box): self.assertAlmostEqual(actual, expected, delta=.01)

    def test_framed_continuation_rejects_ambiguous_boxes_columns_labels_style_order_and_paragraph_boundaries(self):
        path = self.root/'framed-boundaries.pdf'; constructed_pdf(path, framed_caption=True)
        original, image_box = source_ir(path, 'framed-boundary-fixture')
        pdf = pdfium.PdfDocument(path); page = pdf[0]
        try: frames = original_caption_frames(page, original['pages'][0])
        finally: page.close(); pdf.close()
        self.assertEqual(len(frames), 1)
        for kind in ['no-frame', 'ambiguous-frame', 'two-pictures', 'column', 'same-band', 'new-figure', 'new-table', 'font', 'order', 'paragraph', 'section']:
            with self.subTest(kind=kind):
                document = deepcopy(original); local_frames = deepcopy(frames)
                label = next(b for b in document['blocks'] if b['text'].startswith('Fig. 1'))
                first = next(b for b in document['blocks'] if b['text'].startswith('A:'))
                second = next(b for b in document['blocks'] if b['text'].startswith('B:'))
                caption = {'segments': [{'block_id': label['block_id'], 'physical_page': 1, 'start': 0,
                           'end': len(label['text']), 'bbox': label['bbox']}]}  # Literal full source line.
                components = [{'page': 1, 'bbox': image_box}]
                if kind == 'no-frame': local_frames = []
                elif kind == 'ambiguous-frame': local_frames += deepcopy(local_frames)
                elif kind == 'two-pictures': components += deepcopy(components)
                elif kind == 'column': first['bbox'][0] += 12
                elif kind == 'same-band': second['bbox'][1:] = [first['bbox'][1], second['bbox'][2], first['bbox'][3]]
                elif kind == 'new-figure': first['text'] = 'Fig. 2 competing title.'
                elif kind == 'new-table': first['text'] = 'Table 2 competing title.'
                elif kind == 'font': first['bbox'][3] += 8
                elif kind == 'order': first['reading_order'] = label['reading_order'] - 1
                elif kind == 'paragraph': first['bbox'][1] += 12; first['bbox'][3] += 12
                elif kind == 'section':
                    document['structure']['units'].append({'kind': 'section_header', 'source_segments': [{'block_id': first['block_id']}]})
                before = deepcopy(document)
                extra = supplemental_framed_captions(document, [caption], components, local_frames)[id(caption)]
                self.assertEqual(extra, []); self.assertEqual(document, before)

    def test_same_frame_multiple_paragraphs_and_wrapped_title_keep_literal_notes_and_abbreviations_only(self):
        path = self.root/'framed-multiple.pdf'; constructed_pdf(path, framed_multi=True)
        document, _ = source_ir(path, 'framed-multiple-fixture'); before = deepcopy(document)
        catalog = extract_catalog(document, self.root/'framed-multiple-output')
        figure = next(f for f in catalog['figures'] if f['figure_number'] == '1')
        self.assertEqual([s['exact_quote'] for s in figure['caption_segments']],
                         ['Fig. 1 Original title.', 'continued title', 'A: first literal note.', 'B: second literal note.', 'CT, literal abbreviation.'])
        self.assertNotIn('Following body paragraph.', '\n'.join(s['exact_quote'] for s in figure['caption_segments']))
        self.assertEqual(figure['verification']['status'], 'needs_review'); self.assertEqual(document, before)

    def test_split_caption_and_detector_panel_use_complete_original_bitmap_without_auto_confirmation(self):
        path = self.root/'split-caption.pdf'; constructed_pdf(path, split_caption=True)
        document, image_box = source_ir(path, 'split-caption-fixture')
        picture = document['structure']['pictures'][0]
        unit = next(u for u in document['structure']['units'] if u['unit_id'] == picture['picture_id'])
        unit['provenance'][0]['bbox'] = [(image_box[0]+image_box[2])/2, image_box[1], image_box[2], image_box[3]]
        catalog = extract_catalog(document, self.root/'split-caption-output')
        figure = next(f for f in catalog['figures'] if f['figure_number'] == '1')
        self.assertEqual([s['exact_quote'] for s in figure['caption_segments']],
                         ['Fig. 1', 'First literal caption line.', 'Second literal caption line.'])
        self.assertEqual(figure['verification']['status'], 'needs_review')
        self.assertEqual(len(figure['regions']), 1)
        for actual, expected in zip(figure['regions'][0]['bbox'], image_box):
            self.assertAlmostEqual(actual, expected, delta=.01)

    def test_rotated_cropped_userunit_object_coordinates_preserve_all_image_quadrants(self):
        for rotation in [0, 90, 180, 270]:
            for user_unit in [1, 2]:
                with self.subTest(rotation=rotation, user_unit=user_unit):
                    path = self.root/f'r{rotation}-u{user_unit}.pdf'; constructed_pdf(path, rotation, user_unit)
                    document, image_box = source_ir(path, f'fixture-r{rotation}-u{user_unit}')
                    before = path.read_bytes()
                    catalog = extract_catalog(document, self.root/f'output-{rotation}-{user_unit}')
                    assets = [r for f in catalog['figures'] for r in f['regions']]
                    self.assertGreater(len(assets), 0)
                    asset = assets[0]
                    # Independently expected cropped-page dimensions for the 120x80 pt original object.
                    expected = [120*user_unit, 80*user_unit] if rotation in [0, 180] else [80*user_unit, 120*user_unit]
                    self.assertAlmostEqual(image_box[2]-image_box[0], expected[0], delta=0.15)
                    self.assertAlmostEqual(image_box[3]-image_box[1], expected[1], delta=0.15)
                    self.assertAlmostEqual(asset['width_px'], expected[0]*2, delta=2)
                    self.assertAlmostEqual(asset['height_px'], expected[1]*2, delta=2)
                    image = Image.open(CODE/asset['path']).convert('RGB')
                    colors = {color for count, color in image.getcolors(image.width*image.height) if count > image.width*image.height*0.1}
                    self.assertTrue({(255, 0, 0), (0, 255, 0), (0, 0, 255), (255, 255, 0)} <= colors)
                    self.assertEqual(path.read_bytes(), before)
                    self.assertEqual(sha256((CODE/asset['path']).read_bytes()).hexdigest(), asset['sha256'])

    def test_hash_mismatch_and_existing_output_cannot_overwrite_artifacts(self):
        path = self.root/'source.pdf'; constructed_pdf(path)
        document, _ = source_ir(path, 'immutable-fixture'); document['file_sha256'] = '0'*64
        with self.assertRaises(ParserError): extract_catalog(document, self.root/'bad')
        document, _ = source_ir(path, 'immutable-fixture'); out = self.root/'existing'
        extract_catalog(document, out)
        original = (out/'catalog.json').read_bytes()
        with self.assertRaises(FileExistsError): extract_catalog(document, out)
        self.assertEqual((out/'catalog.json').read_bytes(), original)

    def test_caption_identity_and_uncontained_multiple_objects_are_not_mechanically_paired(self):
        path = self.root/'source.pdf'; constructed_pdf(path)
        document, _ = source_ir(path, 'caption-fixture')
        catalog = extract_catalog(document, self.root/'normal')
        figure = next(f for f in catalog['figures'] if f['figure_number'] == '1')
        self.assertEqual(figure['verification']['status'], 'mechanically_checked')
        # A mismatched native parent does not alter independent caption discovery.
        document['structure']['pictures'][0]['caption_unit_ids'] = []
        self.assertEqual(discover_figures(document)[0]['figure_number'], '1')
        # Duplicate source captions cannot become a unique Figure identity.
        duplicate = deepcopy(document['structure']['units'][0]); duplicate['unit_id'] += '-duplicate'
        duplicate['source_segments'] = []
        document['structure']['units'].append(duplicate)
        self.assertEqual(len([f for f in discover_figures(document) if f['figure_number'] == '1']), 1)
        multi = self.root/'multiple.pdf'; constructed_pdf(multi, second_image=True)
        document, _ = source_ir(multi, 'multiple-image-fixture')
        catalog = extract_catalog(document, self.root/'multiple-regions')
        self.assertTrue(all(f['verification']['status'] == 'needs_review' for f in catalog['figures']))

    def test_separate_note_keeps_literal_negation_source_order_and_original_region(self):
        path = self.root/'note.pdf'; constructed_pdf(path, note_before=True)
        document, image_box = source_ir(path, 'note-fixture')
        original = deepcopy(document)
        title = next(u for u in document['structure']['units'] if u['native_text'].startswith('Fig. 1'))
        note = next(u for u in document['structure']['units'] if u['native_text'].startswith('Note:'))
        without_note = deepcopy(document)
        without_note['structure']['units'] = [u for u in without_note['structure']['units'] if u['unit_id'] != note['unit_id']]
        identity = next(f['figure_id'] for f in discover_figures(without_note) if f['figure_number'] == '1')
        catalog = extract_catalog(document, self.root/'note-output')
        self.assertEqual(document, original)
        figure = next(f for f in catalog['figures'] if f['figure_number'] == '1')
        self.assertEqual(figure['figure_id'], identity)
        self.assertEqual([s['block_id'] for s in figure['caption_segments']],
                         [s['block_id'] for s in note['source_segments'] + title['source_segments']])
        self.assertEqual([s['exact_quote'] for s in figure['caption_segments']],
                         ['Note: (a) no pleural invasion;', 'no metastasis is observed.', 'Fig. 1 CT source fixture.'])
        self.assertEqual(figure['regions'][0]['bbox'], image_box)
        self.assertEqual(figure['verification']['status'], 'needs_review')
        self.assertEqual(figure['panel_labels'], ['(a)'])

    def test_note_requires_unique_caption_picture_and_no_column_or_paragraph_ambiguity(self):
        path = self.root/'note-guards.pdf'; constructed_pdf(path, note_before=True)
        baseline, _ = source_ir(path, 'note-guard-fixture')
        note_id = next(u['unit_id'] for u in baseline['structure']['units'] if u['native_text'].startswith('Note:'))
        title_id = next(u['unit_id'] for u in baseline['structure']['units'] if u['native_text'].startswith('Fig. 1'))
        for reason in ['body_text', 'unlinked_footnote', 'table_note', 'conflicting_native_parent', 'two_pictures',
                       'two_figures', 'other_column', 'multi_column_note', 'intervening_prose', 'remote_note']:
            with self.subTest(reason=reason):
                document = deepcopy(baseline)
                note = next(u for u in document['structure']['units'] if u['unit_id'] == note_id)
                title = next(u for u in document['structure']['units'] if u['unit_id'] == title_id)
                picture = document['structure']['pictures'][0]
                blocks = {b['block_id']: b for b in document['blocks']}
                if reason == 'body_text':
                    note['kind'] = 'text'
                elif reason == 'unlinked_footnote':
                    note['kind'] = 'footnote'; picture['caption_unit_ids'] = []
                elif reason == 'table_note':
                    document['structure']['tables'].append({'caption_unit_ids': [], 'footnote_unit_ids': [note_id]})
                elif reason == 'conflicting_native_parent':
                    picture['association_status'] = 'conflict'
                elif reason == 'two_pictures':
                    duplicate = deepcopy(picture); duplicate['picture_id'] += '-duplicate'
                    document['structure']['pictures'].append(duplicate)
                    unit = deepcopy(next(u for u in document['structure']['units'] if u['unit_id'] == picture['picture_id']))
                    unit['unit_id'] = duplicate['picture_id']; document['structure']['units'].append(unit)
                elif reason == 'two_figures':
                    duplicate = deepcopy(title); duplicate['unit_id'] += '-figure2'; duplicate['native_text'] = 'Fig. 2 CT source fixture.'
                    block = deepcopy(blocks[title['source_segments'][0]['block_id']]); block['block_id'] += '-figure2'; block['text'] = duplicate['native_text']
                    block['reading_order'] += 1; document['blocks'].append(block)
                    duplicate['source_segments'] = [{**duplicate['source_segments'][0], 'block_id': block['block_id'], 'end': len(block['text'])}]
                    document['structure']['units'].append(duplicate)
                elif reason in ['other_column', 'multi_column_note', 'remote_note']:
                    selected = note['source_segments'] if reason != 'multi_column_note' else note['source_segments'][1:]
                    for s in selected:
                        b = blocks[s['block_id']]; dx, dy = (150, 0) if reason != 'remote_note' else (0, -100)
                        b['bbox'] = [b['bbox'][0] + dx, b['bbox'][1] + dy, b['bbox'][2] + dx, b['bbox'][3] + dy]
                elif reason == 'intervening_prose':
                    block = deepcopy(blocks[title['source_segments'][0]['block_id']]); block['block_id'] += '-body'
                    note_bottom = max(blocks[s['block_id']]['bbox'][3] for s in note['source_segments'])
                    title_top = block['bbox'][1]; block['text'] = 'Unrelated body paragraph must block the association.'
                    block['bbox'][1:4:2] = [note_bottom + 0.5, title_top - 0.5]; document['blocks'].append(block)
                figure = next(f for f in discover_figures(document) if f['figure_number'] == '1')
                self.assertEqual([s['block_id'] for s in figure['caption_segments']],
                                 [s['block_id'] for s in title['source_segments']])

    def test_l01_note_regression_uses_existing_ir_without_reparsing_or_mutation(self):
        path = CODE/'runtime-data/s0-s4-current-2026-11-04/L01-cpu-current/parser-result.json'
        if not path.exists():
            self.skipTest('Existing development IR is unavailable')
        document = json.loads(path.read_text())['document']; before = deepcopy(document)
        old = json.loads((path.parent/'figure-assets/catalog.json').read_text())
        figure = next(f for f in discover_figures(document) if f['figure_number'] == '1')
        old_figure = next(f for f in old['figures'] if f['figure_number'] == '1')
        old_region = next(f for f in old['figures'] if f['figure_number'] is None)['regions'][0]
        self.assertEqual(figure['figure_id'], old_figure['figure_id'])
        self.assertEqual([s['block_id'].rsplit('-', 1)[-1] for s in figure['caption_segments']], ['l000087', 'l000088', 'l000089'])
        self.assertEqual(figure['region_specs'], [{'physical_page': old_region['physical_page'], 'bbox': old_region['bbox']}])
        self.assertEqual(figure['verification']['status'], 'needs_review')
        self.assertEqual(document, before)

    def test_small_bitmap_completion_is_geometry_only_and_keeps_wider_caption_area(self):
        candidate = {'figure_number': '6', 'caption_segments': [], 'region_specs': [{'physical_page': 1, 'bbox': [0, 10, 109, 110]}],
                     'verification': {'status': 'needs_review', 'human_approved': False}}
        before = deepcopy(candidate['verification'])
        reason = complete_bitmap_render_bounds(candidate, [{'bbox': [10, 10, 110, 110], 'top_level': True}], {'width': 300, 'height': 300})
        self.assertEqual(reason, 'completed_original_bitmap_render_bounds')
        self.assertEqual(candidate['region_specs'][0]['bbox'], [0, 10, 110, 110])
        self.assertEqual(candidate['verification'], before)

    def test_bitmap_completion_refuses_ambiguous_distant_or_unrelated_content(self):
        original = {'bbox': [10, 10, 110, 110], 'top_level': True}
        for reason in ['multiple_intersecting', 'nearby_other_image', 'nested_form', 'low_coverage', 'large_margin', 'outside_page', 'body_in_new_margin']:
            with self.subTest(reason=reason):
                figure = {'figure_number': '2', 'caption_segments': [], 'region_specs': [{'physical_page': 1, 'bbox': [10, 10, 109, 110]}],
                          'verification': {'status': 'needs_review', 'human_approved': False}}
                objects = [deepcopy(original)]; page = {'width': 2000, 'height': 1000}; document = {'blocks': []}
                if reason == 'multiple_intersecting': objects.append({'bbox': [100, 10, 130, 50], 'top_level': True})
                if reason == 'nearby_other_image': objects.append({'bbox': [112, 12, 130, 50], 'top_level': True})
                if reason == 'nested_form': objects[0]['top_level'] = False
                if reason == 'low_coverage': figure['region_specs'][0]['bbox'][0] = 12.1
                if reason == 'large_margin':
                    objects[0]['bbox'] = [10, 10, 1010, 110]; figure['region_specs'][0]['bbox'] = [18.1, 10, 1010, 110]
                if reason == 'outside_page': page['width'] = 109
                if reason == 'body_in_new_margin': document['blocks'] = [{'page': 1, 'block_id': 'unrelated-body',
                    'bbox': [109, 30, 111, 60], 'text': 'Unrelated body prose must not be included.'}]
                before = deepcopy(figure)
                result = complete_bitmap_render_bounds(figure, objects, page, document)
                self.assertNotEqual(result, 'completed_original_bitmap_render_bounds')
                self.assertEqual(figure, before)

    def test_note_and_cross_column_review_do_not_skip_complete_bitmap_render_bounds(self):
        for early_return in ['note', 'cross_column']:
            with self.subTest(early_return=early_return):
                candidate = {'figure_number': '1', 'caption_segments': [{'exact_quote': 'Note: original literal note.', 'block_id': 'note'}],
                             'region_specs': [{'physical_page': 1, 'bbox': [10, 10, 109, 110]}],
                             'caption_continuation_unverified': early_return == 'cross_column',
                             'verification': {'status': 'needs_review', 'all_panels_included': False, 'human_approved': False}}
                if early_return == 'cross_column': candidate['caption_segments'] = [{'exact_quote': 'Fig. 1 Original caption.', 'block_id': 'caption'}]
                figure = deepcopy(candidate); objects = [{'bbox': [10, 10, 110, 110], 'top_level': True}]
                complete_bitmap_render_bounds(figure, objects, {'width': 300, 'height': 300})
                mechanically_check(figure, candidate, [candidate], objects, {'width': 300, 'height': 300})
                self.assertEqual(figure['region_specs'][0]['bbox'], [10, 10, 110, 110])
                self.assertEqual(figure['verification']['status'], 'needs_review')
                self.assertFalse(figure['verification']['all_panels_included'])
                self.assertFalse(figure['verification']['human_approved'])

    def test_real_l07_clipped_bitmaps_are_completed_and_existing_l01_l05_regions_are_unchanged(self):
        for source_id in ['L07', 'L01', 'L05']:
            with self.subTest(source_id=source_id):
                root = CODE/'docs/acceptance/pdf-input-quality-2026-11-07/derived'/source_id
                document = json.loads((root/'parser-result.json').read_text())['document']; before = deepcopy(document)
                old = json.loads((root/'figure-assets/catalog.json').read_text())
                fresh = extract_catalog(document, self.root/source_id)
                self.assertEqual(document, before)
                pdf = pdfium.PdfDocument(CODE/document['source']['file_reference'])
                try:
                    selected = ['2', '3', '6'] if source_id == 'L07' else ['1'] if source_id == 'L01' else ['4']
                    for number in selected:
                        figure = next(f for f in fresh['figures'] if f['figure_number'] == number)
                        previous = next(f for f in old['figures'] if f['figure_number'] == number)
                        region = figure['regions'][0]; page = pdf[region['physical_page']-1]
                        try: bitmap = original_image_objects(page, document['pages'][region['physical_page']-1])[0]['bbox']
                        finally: page.close()
                        box = region['bbox']
                        self.assertTrue(box[0] <= bitmap[0] and box[1] <= bitmap[1] and box[2] >= bitmap[2] and box[3] >= bitmap[3])
                        self.assertEqual(figure['caption_segments'], previous['caption_segments'])
                        self.assertFalse(figure['verification']['human_approved'])
                        if source_id == 'L07':
                            self.assertGreater(box[3], previous['regions'][0]['bbox'][3])
                            self.assertNotEqual(region['sha256'], previous['regions'][0]['sha256'])
                        else: self.assertEqual(region['sha256'], previous['regions'][0]['sha256'])
                finally: pdf.close()

    def test_real_in04_complete_captions_and_whole_figures_do_not_gain_neighboring_prose(self):
        root = CODE/'docs/acceptance/resume-2026-11-11'
        if not (root/'source-document-ir.json').exists():
            self.skipTest('Current IN04 source-bound regression artifacts are unavailable')
        saved = json.loads((root/'source-document-ir.json').read_text()); document = deepcopy(saved)
        # Relocate the frozen container's same-SHA uploaded PDF to its host copy.
        document['source']['file_reference'] = 'evaluation/corpus/independent-sealed/IN04.pdf'
        before = deepcopy(document); old = json.loads((root/'source-figure-catalog.json').read_text())
        fresh = extract_catalog(document, self.root/'IN04-complete-caption')
        self.assertEqual(document, before)
        self.assertEqual(len(fresh['figures']), len(old['figures']))
        for figure, previous in zip(fresh['figures'], old['figures']):
            self.assertEqual(figure['figure_id'], previous['figure_id'])
            self.assertEqual(figure['caption_segments'], previous['caption_segments'])
            self.assertEqual([a['sha256'] for a in figure['regions']], [a['sha256'] for a in previous['regions']])
            self.assertFalse(figure['verification']['human_approved'])
        self.assertEqual(json.loads((root/'source-document-ir.json').read_text()), saved)

    def test_real_in06_caption_frames_include_all_literal_notes_and_stop_before_following_paragraphs(self):
        root = CODE/'docs/acceptance/resume-2026-11-11/in06/baseline'
        if not (root/'parser-result.json').exists():
            self.skipTest('Frozen IN06 pre-repair regression artifacts are unavailable')
        document = json.loads((root/'parser-result.json').read_text())['document']; before = deepcopy(document)
        old = json.loads((root/'figure-catalog.json').read_text()); fresh = extract_catalog(document, self.root/'IN06-framed-caption')
        self.assertEqual(document, before); self.assertEqual(len(fresh['figures']), 3)
        expected = {'1': (2, [9, 10, 11, 12]), '2': (2, [18, 19, 20, 21]), '3': (3, [0, 1, 2, 3])}
        blocks = {b['block_id']: b for b in document['blocks']}
        for figure, previous in zip(fresh['figures'], old['figures']):
            page, lines = expected[figure['figure_number']]
            wanted = [b for b in document['blocks'] if b['page'] == page and int(b['block_id'].rsplit('-l', 1)[-1]) in lines]
            self.assertEqual([s['block_id'] for s in figure['caption_segments']], [b['block_id'] for b in wanted])
            for segment in figure['caption_segments']:
                self.assertEqual(segment['exact_quote'], blocks[segment['block_id']]['text'])
                self.assertEqual(segment['bbox'], blocks[segment['block_id']]['bbox'])
            text = '\n'.join(s['exact_quote'] for s in figure['caption_segments'])
            for body_start in ['A thoraco-abdomino-pelvic', 'Additionally,', 'Following a multidisciplinary']:
                self.assertNotIn(body_start, text)
            self.assertEqual(figure['figure_id'], previous['figure_id'])
            self.assertEqual([a['sha256'] for a in figure['regions']], [a['sha256'] for a in previous['regions']])
            self.assertEqual(figure['verification']['status'], 'needs_review')
            self.assertFalse(figure['verification']['human_approved'])

    def test_real_in07_first_failed_multi_paragraph_captions_are_complete_without_changing_the_failed_baseline(self):
        root = CODE/'docs/acceptance/resume-2026-11-11/in07/baseline'
        if not (root/'parser-result.json').exists():
            self.skipTest('Frozen failed IN07 independent first parser check is unavailable')
        document = json.loads((root/'parser-result.json').read_text())['document']; before = deepcopy(document)
        old = json.loads((root/'figure-catalog.json').read_text()); fresh = extract_catalog(document, self.root/'IN07-multiple-caption')
        self.assertEqual(document, before); self.assertEqual(len(fresh['figures']), 3)
        expected = {'1': (2, list(range(6))), '2': (2, list(range(6, 14))), '3': (3, list(range(4)))}
        for figure, previous in zip(fresh['figures'], old['figures']):
            page, lines = expected[figure['figure_number']]
            wanted = [b for b in document['blocks'] if b['page'] == page and int(b['block_id'].rsplit('-l', 1)[-1]) in lines]
            self.assertEqual([s['block_id'] for s in figure['caption_segments']], [b['block_id'] for b in wanted])
            self.assertEqual([s['exact_quote'] for s in figure['caption_segments']], [b['text'] for b in wanted])
            self.assertEqual(figure['figure_id'], previous['figure_id'])
            self.assertEqual([a['sha256'] for a in figure['regions']], [a['sha256'] for a in previous['regions']])
            self.assertEqual(figure['verification']['status'], 'needs_review')
        self.assertEqual([len(f['caption_segments']) for f in old['figures']], [3, 2, 2])


if __name__ == '__main__':
    unittest.main()
