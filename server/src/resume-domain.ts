import { z } from 'zod';

export const MAX_RESUME_BYTES = 200 * 1024;
export const resumeSchema = z
  .object({
    label: z
      .string()
      .min(1)
      .max(20)
      .regex(/^[A-Za-z0-9-]+$/),
    tex: z
      .string()
      .max(MAX_RESUME_BYTES)
      .refine(
        (value) => new TextEncoder().encode(value).length <= MAX_RESUME_BYTES,
        'Resume exceeds 200 KB',
      )
      .refine((value) => value.includes('\\begin{document}'), 'Missing document'),
  })
  .strict();
export type Resume = z.infer<typeof resumeSchema> & { id: string; updatedAt: string };
export const replacementSchema = z
  .string()
  .max(300)
  .regex(/^[^\\{}^~]*$/);
export const editDraftSchema = z.object({
  find: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[^\\{}%$&#_^~]+$/),
  replace: replacementSchema,
  reason: z.string().max(2000),
});
export const editStateSchema = z.enum(['pending', 'accepted', 'rejected']);
export type EditDraft = z.infer<typeof editDraftSchema>;
export type ResumeEdit = EditDraft & { id: string; state: z.infer<typeof editStateSchema> };
export type Tailoring = {
  resumeId: string;
  resumeLabel: string;
  reason: string;
  generatedAt: string;
  edits: ResumeEdit[];
};
export const tailorOutputSchema = z.object({
  resumeId: z.string(),
  reason: z.string().max(2000),
  edits: z.array(z.unknown()).max(100),
});
export type TailorOutput = z.infer<typeof tailorOutputSchema>;

function withoutComments(tex: string) {
  return tex.replace(/[^\r\n]+/g, (line) => {
    for (let i = 0; i < line.length; i++) {
      if (line[i] !== '%') continue;
      let slashes = 0;
      for (let j = i - 1; j >= 0 && line[j] === '\\'; j--) slashes++;
      if (slashes % 2 === 0) return line.slice(0, i) + '%'.repeat(line.length - i);
    }
    return line;
  });
}
export function findEditRange(tex: string, find: string): [number, number] | undefined {
  if (!editDraftSchema.shape.find.safeParse(find).success) return;
  const visible = withoutComments(tex);
  const begin = '\\begin{document}';
  const start = visible.indexOf(begin);
  const end = visible.indexOf('\\end{document}', start + begin.length);
  if (start < 0 || end < 0) return;
  const bodyStart = start + begin.length;
  const body = visible.slice(bodyStart, end);
  const index = body.indexOf(find);
  if (index < 0 || body.indexOf(find, index + 1) >= 0) return;
  return [bodyStart + index, bodyStart + index + find.length];
}
export function validEdit(tex: string, edit: EditDraft, others: EditDraft[] = []) {
  if (!editDraftSchema.safeParse(edit).success) return false;
  const range = findEditRange(tex, edit.find);
  return (
    !!range &&
    !others.some((other) => {
      const used = findEditRange(tex, other.find);
      return used && range[0] < used[1] && used[0] < range[1];
    })
  );
}
export function filterEdits(tex: string, proposals: unknown[]): EditDraft[] {
  const edits: EditDraft[] = [];
  for (const proposal of proposals) {
    const parsed = editDraftSchema.safeParse(proposal);
    if (parsed.success && validEdit(tex, parsed.data, edits)) edits.push(parsed.data);
  }
  return edits;
}
export function escapeLatex(text: string) {
  return replacementSchema.parse(text).replace(/[&%$#_]/g, (character) => '\\' + character);
}
export function applyEdits(tex: string, edits: ResumeEdit[]) {
  const usable: ResumeEdit[] = [];
  const staleEditIds: string[] = [];
  for (const edit of edits) {
    if (validEdit(tex, edit, usable)) usable.push(edit);
    else staleEditIds.push(edit.id);
  }
  const accepted = usable
    .filter((edit) => edit.state === 'accepted')
    .map((edit) => ({ edit, range: findEditRange(tex, edit.find)! }))
    .sort((a, b) => b.range[0] - a.range[0]);
  let result = tex;
  for (const { edit, range } of accepted)
    result = result.slice(0, range[0]) + escapeLatex(edit.replace) + result.slice(range[1]);
  return { tex: result, staleEditIds };
}
export function tailoringView(tailoring: Tailoring, resume?: Resume) {
  const staleEditIds = resume
    ? applyEdits(resume.tex, tailoring.edits).staleEditIds
    : tailoring.edits.map((edit) => edit.id);
  return {
    ...tailoring,
    baseMissing: !resume,
    staleEditIds,
    edits: tailoring.edits.map((edit) => ({ ...edit, stale: staleEditIds.includes(edit.id) })),
  };
}
export function resumeFilename(prefix: string, label: string, company: string) {
  const safeCompany = company.replace(/[^A-Za-z0-9]/g, '').slice(0, 100) || 'Company';
  const safeLabel = label.replace(/[^A-Za-z0-9-]/g, '').slice(0, 20) || 'Resume';
  const safePrefix = prefix.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 100) || 'Austin_Zhang_Resume';
  return `${safePrefix}_${safeLabel}_${safeCompany}.pdf`;
}
