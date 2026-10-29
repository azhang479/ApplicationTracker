import { Firestore, Transaction } from '@google-cloud/firestore';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Application, GmailConfig, Review, Store } from './domain.js';

type Context = { apps: Map<string, Application>; reviews: Map<string, Review>; writes: (() => void)[]; transaction: Transaction };
export class FirestoreStore implements Store {
  private context = new AsyncLocalStorage<Context>();
  constructor(private db = new Firestore()) {}
  async exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (this.context.getStore()) return work();
    return this.db.runTransaction(async transaction => {
      const apps = await transaction.get(this.db.collection('applications'));
      const reviews = await transaction.get(this.db.collection('reviewItems'));
      const ctx: Context = {
        apps: new Map(apps.docs.map(d => [d.id, { ...d.data(), id: d.id } as Application])),
        reviews: new Map(reviews.docs.map(d => [d.id, { ...d.data(), id: d.id } as Review])),
        writes: [], transaction
      };
      const result = await this.context.run(ctx, work);
      for (const write of ctx.writes) write();
      return result;
    });
  }
  async listApplications() {
    const ctx = this.context.getStore();
    if (ctx) return [...ctx.apps.values()];
    return (await this.db.collection('applications').get()).docs.map(d => ({ ...d.data(), id: d.id } as Application));
  }
  async saveApplication(app: Application) {
    const ref = this.db.collection('applications').doc(app.id);
    const ctx = this.context.getStore();
    if (ctx) { ctx.apps.set(app.id, app); ctx.writes.push(() => ctx.transaction.set(ref, app)); }
    else await ref.set(app);
  }
  async deleteApplication(id: string) {
    const ref = this.db.collection('applications').doc(id);
    const ctx = this.context.getStore();
    if (ctx) { ctx.apps.delete(id); ctx.writes.push(() => ctx.transaction.delete(ref)); }
    else await ref.delete();
  }
  async listReview() {
    const ctx = this.context.getStore();
    if (ctx) return [...ctx.reviews.values()];
    return (await this.db.collection('reviewItems').where('resolved', '==', false).get()).docs.map(d => ({ ...d.data(), id: d.id } as Review));
  }
  async saveReview(review: Review) {
    const ref = this.db.collection('reviewItems').doc(review.id);
    const ctx = this.context.getStore();
    if (ctx) { ctx.reviews.set(review.id, review); ctx.writes.push(() => ctx.transaction.set(ref, review)); }
    else await ref.set(review);
  }
  async isProcessed(id: string) { return (await this.db.collection('processedEmails').doc(id).get()).exists; }
  async markProcessed(id: string) { await this.db.collection('processedEmails').doc(id).set({ processedAt: new Date().toISOString() }); }
  async getGmail() { return (await this.db.doc('config/gmail').get()).data() as GmailConfig | undefined; }
  async saveGmail(config: GmailConfig) {
    const ref = this.db.doc('config/gmail');
    await this.db.runTransaction(async transaction => {
      const previous = (await transaction.get(ref)).data() as GmailConfig | undefined;
      const next = { ...config };
      if (previous?.historyId && next.historyId && BigInt(previous.historyId) > BigInt(next.historyId)) next.historyId = previous.historyId;
      transaction.set(ref, next, { merge: true });
    });
  }
}
