/** Versioned new-run policy. The decoded source stays literal; the agent may
 * assess its usefulness, never repair a glyph or claim PDF fidelity. */
export const SOURCE_GLYPH_INPUT_POLICY_VERSION = 'agent-assesses-parsed-glyphs-1' as const;
export const agentAssessesSourceGlyphs = (version: unknown) => version === SOURCE_GLYPH_INPUT_POLICY_VERSION;
export const SOURCE_GLYPH_INPUT_RULE = 'Some parsed characters may be uncertain. Read the supplied original strings and their context; decide whether they support an eligible statement. Do not skip a whole source paragraph merely because a font diagnostic exists. Never guess, repair, normalize or replace a character or numeric sign. If a value or meaning cannot be established from the parsed source, do not invent it. This is not human or PDF-fidelity approval.';
