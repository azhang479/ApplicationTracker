import { gmail, gmail_v1 } from 'googleapis/build/src/apis/gmail/index.js';
import { OAuth2Client } from 'google-auth-library';
import { AI, Email, Store, passesPrefilter } from './domain.js';
import { Config } from './config.js';
import { Tracker } from './service.js';

const EMAIL_TEXT_LIMIT = 6_000;

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
  async processNotification(notification: { emailAddress: string; historyId: string }) {
    if (notification.emailAddress !== this.config.OWNER_EMAIL) return;
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
      if (await this.store.isProcessed(id)) continue;
      let message: gmail_v1.Schema$Message;
      try {
        message = (await client.users.messages.get({ userId: 'me', id, format: 'full' })).data;
      } catch (error) {
        if ((error as { code?: number }).code === 404) {
          await this.store.markProcessed(id);
          continue;
        }
        throw error;
      }
      const header = (name: string) =>
        message.payload?.headers?.find((h) => h.name?.toLowerCase() === name)?.value || '';
      const text = parseMime(message.payload || {});
      const email: Email = {
        id,
        subject: header('subject'),
        from: header('from'),
        date: header('date'),
        snippet: text.slice(0, 300),
        gmailLink: 'https://mail.google.com/mail/u/0/#all/' + id,
      };
      if (passesPrefilter(email.subject + ' ' + text)) {
        const result = await this.ai.classify(
          JSON.stringify({
            subject: email.subject,
            from: email.from,
            text: text.slice(0, EMAIL_TEXT_LIMIT),
          }),
        );
        if (result.isJobRelated) {
          await this.store.exclusive(async () => {
            const apps = await this.store.listApplications();
            const reviews = await this.store.listReview();
            if (
              apps.some((a) => a.events.some((e) => e.gmailLink === email.gmailLink)) ||
              reviews.some((r) => r.id === id)
            )
              return;
            await this.tracker.receive(email, result);
          });
        }
      }
      await this.store.markProcessed(id);
    }
    const latest = await this.store.getGmail();
    if (latest) await this.store.saveGmail({ ...latest, historyId: newest, lastSyncAt: syncedAt });
  }
}
