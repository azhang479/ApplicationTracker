import { describe, expect, it } from 'vitest';
import { editContext, keywordCoverage, plainText } from '../../web/src/tailoring';
import type { Tailoring } from '../src/resume-domain';
const tex = '\\begin{document}\n% hidden\n\\textbf{Built Python tools} using SQL.\n\\end{document}';
const tailoring: Tailoring = {
  resumeId: 'swe',
  resumeLabel: 'SWE',
  reason: 'Fit',
  generatedAt: '',
  edits: [
    {
      id: 'one',
      find: 'Built Python tools',
      replace: 'Developed Python tools',
      reason: 'Wording',
      state: 'accepted',
    },
  ],
};
describe('tailoring presentation helpers', () => {
  it('extracts bounded plain-text context without partial LaTeX commands', () => {
    const context = editContext(tex, 'Built Python tools');
    expect(context.before).not.toContain('textbf');
    expect(context.after).toContain('using SQL.');
    expect(context.before.length).toBeLessThanOrEqual(60);
    expect(context.after.length).toBeLessThanOrEqual(60);
    expect(plainText('\\textbf{R\\&D} % hidden')).toBe('R&D');
    expect(
      plainText('\\begin{itemize}[leftmargin=0.15in]\\resumeItem{Python}{SQL}\\end{itemize}'),
    ).toBe('Python SQL');
  });
  it('handles missing and ambiguous spans and empty source', () => {
    expect(editContext('', 'Missing')).toEqual({ before: '', after: '' });
    expect(
      editContext(tex.replace('using SQL', 'Built Python tools'), 'Built Python tools'),
    ).toEqual({ before: '', after: '' });
  });
  it('measures before/after accepted edits with case-insensitive word boundaries', () => {
    expect(keywordCoverage(tex, ['python, SQL', 'Developed', 'Java', 'Py'], tailoring)).toEqual([
      { term: 'python', before: true, after: true },
      { term: 'SQL', before: true, after: true },
      { term: 'Developed', before: false, after: true },
      { term: 'Java', before: false, after: false },
      { term: 'Py', before: false, after: false },
    ]);
  });
  it('ignores pending, rejected and stale changes; handles empty and regex-containing terms', () => {
    for (const state of ['pending', 'rejected'] as const) {
      expect(
        keywordCoverage(tex, ['Developed'], {
          ...tailoring,
          edits: [{ ...tailoring.edits[0], state }],
        })[0].after,
      ).toBe(false);
    }
    expect(keywordCoverage('', ['Developed'], tailoring)[0].after).toBe(false);
    expect(keywordCoverage(tex, [])).toEqual([]);
    expect(keywordCoverage('C++ and C#', ['C++', 'C#', 'C++', ''])).toHaveLength(2);
    expect(keywordCoverage('C++ and C#', ['C++', 'C#']).every((term) => term.after)).toBe(true);
    expect(keywordCoverage(tex, ['hidden'])[0].before).toBe(false);
  });
});
