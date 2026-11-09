import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AI, Application, Store } from './domain.js';
import { NotFound } from './service.js';
import {
  applyEdits,
  editStateSchema,
  filterEdits,
  replacementSchema,
  resumeFilename,
  resumeSchema,
  tailoringView,
} from './resume-domain.js';
import type { ResumeCompiler } from './resume-compiler.js';

export class ResumeError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export const generateTailoringSchema = z.object({ regenerate: z.boolean().optional() }).strict();
export const tailoringPatchSchema = z
  .object({
    edits: z
      .array(
        z
          .object({
            id: z.string().min(1).max(100),
            state: editStateSchema.optional(),
            replace: replacementSchema.optional(),
          })
          .strict()
          .refine(
            (edit) => edit.state !== undefined || edit.replace !== undefined,
            'No changes supplied',
          ),
      )
      .min(1)
      .max(100),
  })
  .strict();
const jobInfo = (app: Application) => ({
  company: app.company,
  title: app.title,
  jobSummary: app.jobSummary,
  keyRequirements: app.keyRequirements,
});
export class ResumeService {
  constructor(
    private store: Store,
    private ai: AI,
    private compiler: ResumeCompiler,
    private prefix = 'Austin_Zhang_Resume',
    private now = () => new Date().toISOString(),
  ) {}
  async list() {
    return (await this.store.listResumes()).sort(
      (a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id),
    );
  }
  async save(body: unknown, id?: string) {
    const input = resumeSchema.parse(body);
    const resume = { ...input, id: id || randomUUID(), updatedAt: this.now() };
    return this.store.exclusive(async () => {
      const existing = await this.store.listResumes();
      if (id && !existing.some((item) => item.id === id)) throw new NotFound();
      if (!id && existing.length >= 5) throw new ResumeError(400, 'At most 5 resumes are allowed');
      await this.store.saveResume(resume);
      return resume;
    });
  }
  async delete(id: string) {
    return this.store.exclusive(async () => {
      if (!(await this.store.listResumes()).some((resume) => resume.id === id))
        throw new NotFound();
      await this.store.deleteResume(id);
    });
  }
  private async application(id: string) {
    const app = (await this.store.listApplications()).find((app) => app.id === id);
    if (!app) throw new NotFound();
    return app;
  }
  async view(id: string) {
    const app = await this.application(id);
    if (!app.tailoring) throw new NotFound();
    return tailoringView(
      app.tailoring,
      (await this.list()).find((resume) => resume.id === app.tailoring!.resumeId),
    );
  }
  async generate(id: string, body: unknown) {
    const { regenerate } = generateTailoringSchema.parse(body);
    const app = await this.application(id);
    const resumes = await this.list();
    if (!resumes.length) throw new ResumeError(400, 'Upload a resume before tailoring');
    if (app.tailoring && !regenerate)
      return tailoringView(
        app.tailoring,
        resumes.find((resume) => resume.id === app.tailoring!.resumeId),
      );
    const proposal = await this.ai.tailor({ job: jobInfo(app), resumes });
    const base = resumes.find((resume) => resume.id === proposal.resumeId) || resumes[0];
    const tailoring = {
      resumeId: base.id,
      resumeLabel: base.label,
      reason: proposal.reason,
      generatedAt: this.now(),
      edits: filterEdits(base.tex, proposal.edits).map((edit) => ({
        ...edit,
        id: randomUUID(),
        state: 'pending' as const,
      })),
    };
    return this.store.exclusive(async () => {
      const current = await this.application(id);
      const available = await this.list();
      if (current.tailoring && !regenerate)
        return tailoringView(
          current.tailoring,
          available.find((resume) => resume.id === current.tailoring!.resumeId),
        );
      const resume = available.find((resume) => resume.id === base.id);
      if (
        !resume ||
        resume.tex !== base.tex ||
        resume.label !== base.label ||
        JSON.stringify(jobInfo(current)) !== JSON.stringify(jobInfo(app))
      )
        throw new ResumeError(409, 'Resume or job changed during generation; please retry');
      current.tailoring = tailoring;
      current.updatedAt = this.now();
      await this.store.saveApplication(current);
      return tailoringView(tailoring, resume);
    });
  }
  async patch(id: string, body: unknown) {
    const { edits } = tailoringPatchSchema.parse(body);
    if (new Set(edits.map((edit) => edit.id)).size !== edits.length)
      throw new ResumeError(400, 'Duplicate edit IDs');
    return this.store.exclusive(async () => {
      const app = await this.application(id);
      if (!app.tailoring) throw new NotFound();
      if (edits.some((edit) => !app.tailoring!.edits.some((existing) => existing.id === edit.id)))
        throw new ResumeError(400, 'Unknown edit ID');
      for (const change of edits) {
        const edit = app.tailoring.edits.find((edit) => edit.id === change.id)!;
        if (change.state !== undefined) edit.state = change.state;
        if (change.replace !== undefined) edit.replace = change.replace;
      }
      app.updatedAt = this.now();
      await this.store.saveApplication(app);
      return tailoringView(
        app.tailoring,
        (await this.list()).find((resume) => resume.id === app.tailoring!.resumeId),
      );
    });
  }
  async pdf(id: string) {
    const app = await this.application(id);
    if (!app.tailoring) throw new ResumeError(400, 'Generate tailoring before downloading');
    const resume = (await this.list()).find((resume) => resume.id === app.tailoring!.resumeId);
    if (!resume) throw new ResumeError(400, 'The base resume was deleted; regenerate tailoring');
    const applied = applyEdits(resume.tex, app.tailoring.edits);
    const compiled = await this.compiler.compile(applied.tex);
    return {
      ...compiled,
      staleEditIds: applied.staleEditIds,
      filename: resumeFilename(this.prefix, resume.label, app.company),
    };
  }
}
