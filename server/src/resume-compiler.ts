import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

export interface ResumeCompiler {
  compile(tex: string): Promise<{ pdf: Buffer; pageCount: number }>;
}
export class CompilationError extends Error {
  public log: string;
  constructor(log: string) {
    super('Resume compilation failed');
    this.log = log
      .trim()
      .split(/\r?\n/)
      .slice(-20)
      .map((line) => line.slice(0, 500))
      .join('\n');
  }
}
const execute = promisify(execFile);
export class TectonicCompiler implements ResumeCompiler {
  constructor(private binary = 'tectonic') {}
  async compile(tex: string) {
    const directory = await mkdtemp(join(tmpdir(), 'resume-'));
    let output = '';
    try {
      await writeFile(join(directory, 'resume.tex'), tex);
      const result = await execute(
        this.binary,
        ['--untrusted', '--keep-logs', '--print', '--outdir', directory, 'resume.tex'],
        {
          cwd: directory,
          timeout: 60_000,
          maxBuffer: 4 * 1024 * 1024,
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
            LANG: 'C.UTF-8',
            TECTONIC_UNTRUSTED_MODE: '1',
          },
        },
      );
      output = result.stdout + '\n' + result.stderr;
      const pdf = await readFile(join(directory, 'resume.pdf'));
      const log = await readFile(join(directory, 'resume.log'), 'utf8').catch(() => '');
      const match = (output + '\n' + log).match(/Output written on .*?\((\d+) pages?[,)]/);
      const pageCount = match
        ? Number(match[1])
        : (pdf.toString('latin1').match(/\/Type\s*\/Page\b/g) || []).length;
      if (!pdf.subarray(0, 5).equals(Buffer.from('%PDF-')) || pageCount < 1)
        throw new Error('Compiler did not produce a readable PDF page count');
      return { pdf, pageCount };
    } catch (error) {
      const failure = error as Error & { stdout?: string; stderr?: string };
      const log = await readFile(join(directory, 'resume.log'), 'utf8').catch(() => '');
      const details = [output, log, failure.stdout, failure.stderr, failure.message]
        .filter(Boolean)
        .join('\n');
      throw new CompilationError(details);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
