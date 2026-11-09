import {
  applyEdits,
  findEditRange,
  type Resume,
  type Tailoring,
} from '../../server/src/resume-domain';

export type { Resume };
export type Api = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
export type TailoringView = Omit<Tailoring, 'edits'> & {
  baseMissing: boolean;
  staleEditIds: string[];
  edits: (Tailoring['edits'][number] & { stale: boolean })[];
};
export function plainText(tex: string) {
  return tex
    .replace(/(?<!\\)%[^\r\n]*/g, '')
    .replace(/\\(?:begin|end)\{[^}]*\}(?:\[[^\]]*\])?/g, ' ')
    .replace(/\\[a-zA-Z]+\*?(?:\[[^\]]*\])?/g, ' ')
    .replace(/[{}$]/g, ' ')
    .replace(/\\([&%$#_])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}
export function editContext(tex: string, find: string) {
  const range = findEditRange(tex, find);
  if (!range) return { before: '', after: '' };
  return {
    before: plainText(tex.slice(0, range[0])).slice(-60),
    after: plainText(tex.slice(range[1])).slice(0, 60),
  };
}
export function keywordCoverage(tex: string, requirements: string[], tailoring?: Tailoring) {
  const terms = [
    ...new Set(
      requirements
        .flatMap((term) => term.split(/[,;\n]/))
        .map((term) => term.trim())
        .filter(Boolean),
    ),
  ];
  const before = plainText(tex).toLowerCase();
  const after = plainText(tailoring ? applyEdits(tex, tailoring.edits).tex : tex).toLowerCase();
  return terms.map((term) => {
    const escaped = term.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp('(^|[^a-z0-9])' + escaped + '(?=$|[^a-z0-9])', 'i');
    return { term, before: pattern.test(before), after: pattern.test(after) };
  });
}
