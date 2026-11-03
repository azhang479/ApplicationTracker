import { gmail, gmail_v1 } from 'googleapis/build/src/apis/gmail/index.js';
import { OAuth2Client } from 'google-auth-library';
import { AI, Email, Store, passesPrefilter, matchesEmail } from './domain.js';
import { Config } from './config.js';
import { Tracker, type EmailOutcome } from './service.js';

const EMAIL_TEXT_LIMIT = 6_000;
const RECHECK_CONCURRENCY = 4;
export type RecheckCounts = {
  scanned: number;
  classified: number;
  updated: number;
  review: number;
  skipped: number;
};

export function parseMime(part: gmail_v1.Schema$MessagePart): string {
  const plain: string[] = [];
  const html: string[] = [];
  function walk(p: gmail_v1.Schema$MessagePart) {
    if (
      p.filename ||
      p.headers?.some(
        (h) => h.name?.toLowerCase() === 'content-disposition' && h.value?.startsWith('attachment'),
      )
    )
      return;
    if (p.body?.data) {
      const text = Buffer.from(p.body.data, 'base64url').toString('utf8');
      if (p.mimeType === 'text/plain') plain.push(text);
      if (p.mimeType === 'text/html') html.push(text);
    }
    p.parts?.forEach(walk);
  }
  walk(part);
  if (plain.length) {
    return plain.join('\n');
  }
  return html
    .join('\n')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Math.min(Number(n), 0x10ffff)))
    .replace(/\s+/g, ' ')
    .trim();
}
export class GmailService {
  constructor(
    private config: Config,
    private store: Store,
    private ai: AI,
    private tracker: Tracker,
  ) {}
  oauth() {
    return new OAuth2Client(
      this.config.OAUTH_CLIENT_ID,
      this.config.OAUTH_CLIENT_SECRET,
      this.config.PUBLIC_URL + '/auth/gmail/callback',
    );
  }
  private async client() {
    const config = await this.store.getGmail();
    if (!config?.refreshToken) throw new Error('Gmail is not connected');
    const auth = this.oauth();
    auth.setCredentials({ refresh_token: config.refreshToken });
    return gmail({ version: 'v1', auth });
  }
  async renew() {
    const config = await this.store.getGmail();
    if (!config?.refreshToken) return;
    const client = await this.client();
    const { data } = await client.users.watch({
      userId: 'me',
      requestBody: {
        topicName: this.config.PUBSUB_TOPIC,
        labelIds: ['INBOX'],
        labelFilterBehavior: 'include',
      },
    });
    await this.store.saveGmail({
      ...config,
      historyId: config.historyId || data.historyId!,
      watchExpiration: data.expiration!,
    });
  }
  async connect(code: string) {
    const oauth = this.oauth();
    const { tokens } = await oauth.getToken(code);
    oauth.setCredentials(tokens);
    const client = gmail({ version: 'v1', auth: oauth });
    const profile = await client.users.getProfile({ userId: 'me' });
    if (profile.data.emailAddress !== this.config.OWNER_EMAIL)
      throw new Error('Wrong Gmail account');
    const previous = await this.store.getGmail();
    const refreshToken = tokens.refresh_token || previous?.refreshToken;
    if (!refreshToken) throw new Error('No refresh token returned; reconnect with consent');
    await this.store.saveGmail({ refreshToken });
    await this.renew();
  }
  private async processMessage(
    client: gmail_v1.Gmail,
    id: string,
    recheck = false,
  ): Promise<{ classified: number; outcome: EmailOutcome }> {
    const skipped = { classified: 0, outcome: 'skipped' as const };
    if (!recheck && (await this.store.isProcessed(id))) return skipped;
    const identity = { id, gmailLink: 'https://mail.google.com/mail/u/0/#all/' + id };
    let onTimeline = false;
    if (recheck) {
      const known = await this.store.exclusive(async () => ({
        inReview: (await this.store.listReview()).some((review) => review.id === id),
        onTimeline: (await this.store.listApplications()).some((app) =>
          app.events.some((event) => matchesEmail(event, identity)),
        ),
      }));
      if (known.inReview) {
        await this.store.markProcessed(id);
        return skipped;
      }
      onTimeline = known.onTimeline;
    }
    let message: gmail_v1.Schema$Message;
    try {
      message = (await client.users.messages.get({ userId: 'me', id, format: 'full' })).data;
    } catch (error) {
      if ((error as { code?: number }).code !== 404) throw error;
      await this.store.markProcessed(id);
      return skipped;
    }
    const header = (name: string) =>
      message.payload?.headers?.find((h) => h.name?.toLowerCase() === name)?.value || '';
    const text = parseMime(message.payload || {});
    const email: Email = {
      ...identity,
      subject: header('subject'),
      from: header('from'),
      date: header('date'),
      snippet: text.slice(0, 300),
    };
    let classified = 0;
    let outcome: EmailOutcome = 'skipped';
    if (onTimeline || passesPrefilter(email.subject + ' ' + text)) {
      const body = text.slice(0, EMAIL_TEXT_LIMIT);
      const result = await this.ai.classify(
        JSON.stringify({ subject: email.subject, from: email.from, text: body }),
      );
      classified = 1;
      if (result.isJobRelated) {
        outcome = await this.store.exclusive(async () => {
          if (recheck) return this.tracker.recheckEmail(email, result, body);
          const apps = await this.store.listApplications();
          const reviews = await this.store.listReview();
          if (
            apps.some((app) => app.events.some((event) => matchesEmail(event, email))) ||
            reviews.some((review) => review.id === id)
          )
            return 'skipped';
          return this.tracker.receive(email, result, body);
        });
      }
    }
    await this.store.markProcessed(id);
    return { classified, outcome };
  }
  async recheck(days: number): Promise<RecheckCounts> {
    const client = await this.client();
    const after = Math.floor(Date.now() / 1000) - days * 86400;
    const ids = new Set<string>();
    let pageToken: string | undefined;
    do {
      const { data }: { data: gmail_v1.Schema$ListMessagesResponse } =
        await client.users.messages.list({
          userId: 'me',
          q: 'in:inbox after:' + after,
          maxResults: 500,
          pageToken,
        });
      for (const message of data.messages || []) if (message.id) ids.add(message.id);
      pageToken = data.nextPageToken || undefined;
    } while (pageToken);
    const counts: RecheckCounts = {
      scanned: ids.size,
      classified: 0,
      updated: 0,
      review: 0,
      skipped: 0,
    };
    const messages = [...ids];
    for (let start = 0; start < messages.length; start += RECHECK_CONCURRENCY) {
      const results = await Promise.allSettled(
        messages
          .slice(start, start + RECHECK_CONCURRENCY)
          .map((id) => this.processMessage(client, id, true)),
      );
      for (const result of results) {
        if (result.status === 'rejected') throw result.reason;
        counts.classified += result.value.classified;
        counts[result.value.outcome]++;
      }
    }
    return counts;
  }
  async processNotification(notification: { emailAddress: string; historyId: string }) {
    if (notification.emailAddress.toLowerCase() !== this.config.OWNER_EMAIL.toLowerCase()) return;
    const config = await this.store.getGmail();
    if (!config) return;
    const syncedAt = new Date().toISOString();
    if (!config.historyId) {
      await this.store.saveGmail({
        ...config,
        historyId: notification.historyId,
        lastSyncAt: syncedAt,
      });
      return;
    }
    const client = await this.client();
    const ids = new Set<string>();
    let pageToken: string | undefined;
    let newest = config.historyId;
    try {
      do {
        const { data } = await client.users.history.list({
          userId: 'me',
          startHistoryId: config.historyId,
          historyTypes: ['messageAdded'],
          pageToken,
        });
        for (const history of data.history || []) {
          for (const added of history.messagesAdded || []) {
            if (added.message?.id) ids.add(added.message.id);
          }
        }
        newest = data.historyId || newest;
        pageToken = data.nextPageToken || undefined;
      } while (pageToken);
    } catch (error) {
      if ((error as { code?: number }).code !== 404) throw error;
      ids.clear();
      pageToken = undefined;
      if (config.lastSyncAt) {
        const after = Math.floor(Date.parse(config.lastSyncAt) / 1000);
        do {
          const { data }: { data: gmail_v1.Schema$ListMessagesResponse } =
            await client.users.messages.list({
              userId: 'me',
              q: 'after:' + after,
              pageToken,
            });
          for (const message of data.messages || []) if (message.id) ids.add(message.id);
          pageToken = data.nextPageToken || undefined;
        } while (pageToken);
      }
      newest = notification.historyId;
    }
    for (const id of ids) {
      await this.processMessage(client, id);
    }
    const latest = await this.store.getGmail();
    if (latest) await this.store.saveGmail({ ...latest, historyId: newest, lastSyncAt: syncedAt });
  }
}
