import { expect, it } from 'vitest';
import type { Firestore } from '@google-cloud/firestore';
import { FirestoreStore } from '../src/store.js';

it('returns old applications as full-time without changing status or stored internship types', async () => {
  const documents = [
    { id: 'legacy', data: () => ({ status: 'Offer' }) },
    { id: 'intern', data: () => ({ status: 'Applied', roleType: 'internship' }) },
  ];
  const collection = (name: string) => ({
    get: async () => ({ docs: name === 'applications' ? documents : [] }),
  });
  const transaction = { get: (query: ReturnType<typeof collection>) => query.get() };
  const store = new FirestoreStore({
    collection,
    runTransaction: async (work: (tx: typeof transaction) => Promise<unknown>) => work(transaction),
  } as unknown as Firestore);
  const expected = [
    { id: 'legacy', status: 'Offer', roleType: 'full-time' },
    { id: 'intern', status: 'Applied', roleType: 'internship' },
  ];

  expect(await store.listApplications()).toEqual(expected);
  expect(await store.exclusive(() => store.listApplications())).toEqual(expected);
});
