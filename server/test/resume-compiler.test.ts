import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompilationError, TectonicCompiler } from '../src/resume-compiler.js';
import { sampleTex } from './resume-fixtures.js';

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('node:child_process', () => {
  const execFile = Object.assign(() => {}, {
    [Symbol.for('nodejs.util.promisify.custom')]: execute,
  });
  return { execFile };
});
beforeEach(() => {
  execute.mockReset();
});
afterEach(() => vi.unstubAllEnvs());
describe('Tectonic compilation', () => {
  it('uses fresh directories, untrusted mode, no shell escape, a 60s timeout and cleans output', async () => {
    const directories: string[] = [];
    vi.stubEnv('OAUTH_CLIENT_SECRET', 'must-not-inherit');
    execute.mockImplementation(async (binary, args, options) => {
      expect(binary).toBe('tectonic-test');
      expect(args).toContain('--untrusted');
      expect(args).not.toContain('shell-escape');
      expect(options.timeout).toBe(60_000);
      expect(options.env).not.toHaveProperty('OAUTH_CLIENT_SECRET');
      directories.push(options.cwd);
      expect(await readFile(join(options.cwd, 'resume.tex'), 'utf8')).toBe(sampleTex);
      await writeFile(join(options.cwd, 'resume.pdf'), '%PDF-1.5\n');
      await writeFile(
        join(options.cwd, 'resume.log'),
        'Output written on resume.xdv (2 pages, 100 bytes).',
      );
      return { stdout: '', stderr: '' };
    });
    const compiler = new TectonicCompiler('tectonic-test');
    expect((await compiler.compile(sampleTex)).pageCount).toBe(2);
    await compiler.compile(sampleTex);
    expect(new Set(directories).size).toBe(2);
    for (const directory of directories) await expect(access(directory)).rejects.toThrow();
  });
  it('falls back to PDF page objects when engine output has no page count', async () => {
    execute.mockImplementation(async (_binary, _args, options) => {
      await writeFile(
        join(options.cwd, 'resume.pdf'),
        '%PDF-1.5\n/Type /Pages\n/Type /Page\n/Type/Page',
      );
      return { stdout: '', stderr: '' };
    });
    expect((await new TectonicCompiler().compile(sampleTex)).pageCount).toBe(2);
  });
  it('cleans up on timeout or compile errors and exposes only the last twenty bounded log lines', async () => {
    let directory = '';
    execute.mockImplementation(async (_binary, _args, options) => {
      directory = options.cwd;
      const error = Object.assign(new Error('Compiler timed out'), {
        stdout: Array.from({ length: 50 }, (_, i) => 'Line ' + i).join('\n'),
        stderr: 'x'.repeat(1000),
      });
      throw error;
    });
    try {
      await new TectonicCompiler().compile(sampleTex);
      expect.fail('Expected compilation failure');
    } catch (error) {
      expect(error).toBeInstanceOf(CompilationError);
      const log = (error as CompilationError).log;
      expect(log.split('\n')).toHaveLength(20);
      expect(log).not.toContain('Line 0\n');
      expect(log.split('\n').every((line) => line.length <= 500)).toBe(true);
    }
    await expect(access(directory)).rejects.toThrow();
  });
});
