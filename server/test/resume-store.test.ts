import { describe, expect, it, vi } from 'vitest';
import type { Firestore } from '@google-cloud/firestore';
import { FirestoreStore } from '../src/store.js';
import { resume } from './resume-fixtures.js';

function setup() {
  const data = new Map([['swe', resume()]]);
  const snapshot = () => ({ docs: [...data].map(([id, value]) => ({ id, data: () => value })) });
  const get = vi.fn(async () => snapshot());
  const set = vi.fn();
  const remove = vi.fn();
  const collection = vi.fn((name: string) => ({
    name,
    get,
    doc: (id: string) => ({ id, set, delete: remove }),
  }));
  const transaction = {
    get: vi.fn(async (collection: { name: string }) =>
      collection.name === 'resumes' ? snapshot() : { docs: [] },
    ),
    set: vi.fn(),
    delete: vi.fn(),
  };
  const store = new FirestoreStore({
    collection,
    runTransaction: async (work: (transaction: unknown) => unknown) => work(transaction),
  } as unknown as Firestore);
  return { store, collection, transaction, get, set, remove };
}
describe('Firestore resumes', () => {
  it('supports direct resume reads and writes', async () => {
    const ctx = setup();
    expect(await ctx.store.listResumes()).toEqual([resume()]);
    await ctx.store.saveResume(resume());
    await ctx.store.deleteResume('swe');
    expect(ctx.collection).toHaveBeenCalledWith('resumes');
    expect(ctx.set).toHaveBeenCalledWith(resume());
    expect(ctx.remove).toHaveBeenCalledOnce();
  });
  it('reads the collection lazily and buffers mutations in the transaction', async () => {
    const ctx = setup();
    await ctx.store.exclusive(async () => {
      expect(ctx.transaction.get.mock.calls.map((call) => call[0].name)).toEqual([
        'applications',
        'reviewItems',
      ]);
      expect(await ctx.store.listResumes()).toEqual([resume()]);
      await ctx.store.saveResume(resume('ml', 'ML'));
      await ctx.store.deleteResume('swe');
      expect(await ctx.store.listResumes()).toEqual([resume('ml', 'ML')]);
      expect(ctx.transaction.set).not.toHaveBeenCalled();
    });
    expect(ctx.transaction.get.mock.calls.map((call) => call[0].name)).toEqual([
      'applications',
      'reviewItems',
      'resumes',
    ]);
    expect(ctx.transaction.set).toHaveBeenCalledOnce();
    expect(ctx.transaction.delete).toHaveBeenCalledOnce();
    expect(ctx.set).not.toHaveBeenCalled();
  });
});
