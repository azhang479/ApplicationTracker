import { describe, expect, it } from 'vitest';
import {
  MAX_RESUME_BYTES,
  applyEdits,
  escapeLatex,
  filterEdits,
  findEditRange,
  replacementSchema,
  resumeFilename,
  resumeSchema,
  tailoringView,
  validEdit,
  type ResumeEdit,
} from '../src/resume-domain.js';
import { draft, resume, sampleTex } from './resume-fixtures.js';

const tex = (body: string) =>
  '\\documentclass{article}\n\\begin{document}\n' + body + '\n\\end{document}';
const edit = (fields: Partial<ResumeEdit> = {}): ResumeEdit => ({
  ...draft,
  id: 'a',
  state: 'accepted',
  ...fields,
});
describe('resume and edit validation', () => {
  it.each(['SWE', 'ML', 'LL', 'SWE-2027', 'a'.repeat(20)])('accepts label %s', (label) => {
    expect(resumeSchema.safeParse({ label, tex: sampleTex }).success).toBe(true);
  });
  it.each(['', 'a'.repeat(21), 'SWE ML', 'SWE_ML', '../x', 'é'])('rejects label %s', (label) => {
    expect(resumeSchema.safeParse({ label, tex: sampleTex }).success).toBe(false);
  });
  it('requires a document and measures the 200 KB limit in UTF-8 bytes', () => {
    const prefix = '\\begin{document}';
    expect(resumeSchema.safeParse({ label: 'SWE', tex: '' }).success).toBe(false);
    expect(
      resumeSchema.safeParse({
        label: 'SWE',
        tex: prefix + 'x'.repeat(MAX_RESUME_BYTES - prefix.length),
      }).success,
    ).toBe(true);
    expect(
      resumeSchema.safeParse({ label: 'SWE', tex: prefix + 'x'.repeat(MAX_RESUME_BYTES) }).success,
    ).toBe(false);
    expect(
      resumeSchema.safeParse({ label: 'SWE', tex: prefix + 'é'.repeat(MAX_RESUME_BYTES / 2) })
        .success,
    ).toBe(false);
  });
  it.each(['\\', '{', '}', '%', '$', '&', '#', '_', '^', '~'])(
    'rejects find containing %s',
    (character) => {
      expect(validEdit(tex('Word' + character), { ...draft, find: 'Word' + character })).toBe(
        false,
      );
    },
  );
  it('enforces find and replacement length boundaries', () => {
    expect(
      validEdit(tex('x'.repeat(200)), {
        ...draft,
        find: 'x'.repeat(200),
        replace: 'y'.repeat(300),
      }),
    ).toBe(true);
    expect(validEdit(tex('x'.repeat(201)), { ...draft, find: 'x'.repeat(201) })).toBe(false);
    expect(validEdit(tex('Word'), { ...draft, find: '' })).toBe(false);
    expect(validEdit(tex('Word'), { ...draft, find: 'Word', replace: 'y'.repeat(301) })).toBe(
      false,
    );
    expect(validEdit(tex('Word'), { ...draft, find: 'Word', replace: '' })).toBe(true);
  });
  it('requires exactly one occurrence in the document body, excluding full and inline comments', () => {
    expect(findEditRange(tex('Word Word'), 'Word')).toBeUndefined();
    expect(findEditRange(tex('aaa'), 'aa')).toBeUndefined();
    expect(findEditRange('Word\n' + tex('Other'), 'Word')).toBeUndefined();
    expect(findEditRange(tex('% Word\nWord % Word\nOther'), 'Word')).toBeDefined();
    expect(findEditRange(tex('% Word\nOther'), 'Word')).toBeUndefined();
    expect(findEditRange(tex('Other') + '\nWord', 'Word')).toBeUndefined();
    expect(findEditRange('Word', 'Word')).toBeUndefined();
    expect(findEditRange('\\begin{document} Word', 'Word')).toBeUndefined();
    expect(findEditRange(tex('% hidden words'), '\u0000')).toBeUndefined();
  });
  it('handles escaped percent signs, escaped backslashes and commented delimiters', () => {
    expect(findEditRange(tex('\\% Word'), 'Word')).toBeDefined();
    expect(findEditRange(tex('\\\\% Word'), 'Word')).toBeUndefined();
    expect(
      findEditRange('% \\begin{document}\n' + tex('Word\n% \\end{document}'), 'Word'),
    ).toBeDefined();
  });
  it('filters invalid or overlapping AI edits deterministically, retaining adjacent edits', () => {
    const proposals = [
      null,
      {},
      { ...draft, find: 'Built', replace: '\\input{x}' },
      draft,
      { ...draft, find: 'reliable services' },
      { ...draft, find: ' using Python', replace: ' using Python' },
      { ...draft, find: 'Missing' },
    ];
    expect(filterEdits(sampleTex, proposals).map((edit) => edit.find)).toEqual([
      'Built reliable services',
      ' using Python',
    ]);
  });
});
describe('applying edits', () => {
  it('escapes plain-text ampersands, percent, dollar, hash and underscore exactly once', () => {
    expect(escapeLatex('R&D 20% $5 #1 snake_case')).toBe('R\\&D 20\\% \\$5 \\#1 snake\\_case');
  });
  it.each(['\\', '{', '}', '^', '~'])('rejects replacement containing %s', (character) => {
    expect(replacementSchema.safeParse('Text' + character).success).toBe(false);
    expect(() => escapeLatex(character)).toThrow();
  });
  it('applies only accepted edits at original offsets without touching formatting or comments', () => {
    const source = tex('\\textbf{Alpha beta}\n% Alpha beta\nGamma delta');
    const edits = [
      edit({ find: 'Alpha beta', replace: 'R&D' }),
      edit({ id: 'b', find: 'Gamma delta', replace: 'Next', state: 'pending' }),
    ];
    expect(applyEdits(source, edits)).toEqual({
      tex: tex('\\textbf{R\\&D}\n% Alpha beta\nGamma delta'),
      staleEditIds: [],
    });
    edits[1].state = 'rejected';
    expect(applyEdits(source, edits).tex).toContain('Gamma delta');
    edits[1].state = 'accepted';
    expect(applyEdits(source, edits).tex).toBe(tex('\\textbf{R\\&D}\n% Alpha beta\nNext'));
    expect(source).toContain('Alpha beta');
  });
  it('allows deletion and leaves empty edit sets untouched', () => {
    expect(applyEdits(tex('Word'), [edit({ find: 'Word', replace: '' })]).tex).toBe(tex(''));
    expect(applyEdits(sampleTex, [])).toEqual({ tex: sampleTex, staleEditIds: [] });
  });
  it('skips and flags missing, repeated and newly overlapping spans after base changes', () => {
    expect(applyEdits(tex('Other'), [edit({ find: 'Word' })]).staleEditIds).toEqual(['a']);
    expect(applyEdits(tex('Word Word'), [edit({ find: 'Word' })])).toEqual({
      tex: tex('Word Word'),
      staleEditIds: ['a'],
    });
    const overlapping = [edit({ find: 'Alpha beta' }), edit({ id: 'b', find: 'beta' })];
    expect(applyEdits(tex('Alpha beta'), overlapping).staleEditIds).toEqual(['b']);
  });
  it('flags stale edits in views without changing stored decisions', () => {
    const tailoring = {
      resumeId: 'swe',
      resumeLabel: 'SWE',
      reason: 'Fit',
      generatedAt: '2026-01-01',
      edits: [edit()],
    };
    expect(tailoringView(tailoring, resume()).edits[0].stale).toBe(false);
    expect(tailoringView(tailoring, { ...resume(), tex: tex('Other') }).edits[0].stale).toBe(true);
    expect(tailoringView(tailoring).baseMissing).toBe(true);
    expect(tailoring.edits[0]).not.toHaveProperty('stale');
  });
  it('sanitizes company names, labels and configurable download prefixes', () => {
    expect(resumeFilename('Austin_Zhang_Resume', 'SWE', 'JPMorgan Chase & Co.')).toBe(
      'Austin_Zhang_Resume_SWE_JPMorganChaseCo.pdf',
    );
    expect(resumeFilename('Custom_Resume', 'ML', 'Acme Inc.')).toBe('Custom_Resume_ML_AcmeInc.pdf');
    expect(resumeFilename('\r\n"/', '../SWE', '\r\n"/')).toBe(
      'Austin_Zhang_Resume_SWE_Company.pdf',
    );
  });
});
