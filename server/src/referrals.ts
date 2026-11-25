import { createHash, randomUUID } from 'node:crypto';
import { GoogleAuth } from 'google-auth-library';
import { z } from 'zod';
import { isPreApplication, type AI, type Application, type Store } from './domain.js';
import { EventConflict, NotFound } from './service.js';

export const REFERRAL_PDF_LIMIT = 5 * 1024 * 1024;
export const gmailSendScope = 'https://www.googleapis.com/auth/gmail.send';
export const referralProfileSchema = z
  .object({
    senderName: z.string().trim().min(1).max(100),
    aboutMe: z.string().trim().min(1).max(500),
  })
  .strict();
export type ReferralProfile = z.infer<typeof referralProfileSchema>;
export interface ReferralProfileStore {
  getReferralProfile(): Promise<ReferralProfile | undefined>;
  saveReferralProfile(profile: ReferralProfile): Promise<void>;
}
export type ReferralResume = { filename: string; revision: string };
export interface ReferralResumeStore {
  info(): Promise<ReferralResume | undefined>;
  save(filename: string, pdf: Buffer): Promise<void>;
  read(revision: string): Promise<Buffer>;
}
export class ReferralError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export class CloudReferralResume implements ReferralResumeStore {
  private auth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/devstorage.read_write'],
  });
  private objectName = 'referral-resume.pdf';
  constructor(private bucket: string) {}
  private get objectUrl() {
    return `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(this.bucket)}/o/${this.objectName}`;
  }
  async info() {
    try {
      const { data } = await this.auth.request<{
        generation: string;
        metadata?: { filename?: string };
      }>({
        url: this.objectUrl,
      });
      return { filename: data.metadata?.filename ?? this.objectName, revision: data.generation };
    } catch (error) {
      if (httpStatus(error) === 404) return;
      throw new ReferralError(503, 'Could not read the referral résumé from storage.');
    }
  }
  async save(filename: string, pdf: Buffer) {
    const boundary = randomUUID();
    const metadata = JSON.stringify({
      name: this.objectName,
      contentType: 'application/pdf',
      metadata: { filename },
    });
    try {
      await this.auth.request({
        method: 'POST',
        url: `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(this.bucket)}/o?uploadType=multipart`,
        headers: { 'Content-Type': 'multipart/related; boundary=' + boundary },
        data: Buffer.concat([
          Buffer.from(
            `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`,
          ),
          pdf,
          Buffer.from(`\r\n--${boundary}--\r\n`),
        ]),
      });
    } catch {
      throw new ReferralError(503, 'Could not save the referral résumé to storage.');
    }
  }
  async read(revision: string) {
    try {
      const response = await this.auth.request<ArrayBuffer>({
        url: this.objectUrl + '?alt=media&generation=' + encodeURIComponent(revision),
        responseType: 'arraybuffer',
      });
      return Buffer.from(response.data);
    } catch (error) {
      if (httpStatus(error) === 404)
        throw new EventConflict('The résumé changed. Refresh the send preview.');
      throw new ReferralError(503, 'Could not load the referral résumé.');
    }
  }
}

function httpStatus(error: unknown) {
  const failure = error as { response?: { status?: number }; code?: number } | undefined;
  return failure?.response?.status ?? failure?.code;
}
const line = (value: string) => value.replace(/[\r\n]+/g, ' ').trim();
export function renderReferral(profile: ReferralProfile, app: Application, name: string) {
  const firstName = line(name).split(/\s+/)[0];
  return {
    subject: `Referral request for ${line(app.title)} at ${line(app.company)}`,
    body: `Hi ${firstName},\n\nI came across your profile while looking into the ${line(app.title)} opening at ${line(app.company)}. ${profile.aboutMe}\n\nWould you be open to referring me for this role? I’ve attached my résumé for context and included the posting below.\n\n${app.url}\n\nThanks for your time,\n${profile.senderName}`,
  };
}
export type ReferralMail = {
  to: string;
  subject: string;
  body: string;
  filename: string;
  pdf: Buffer;
};
export interface ReferralMailer {
  sendReferral(message: ReferralMail): Promise<string>;
}
export function referralMime(from: string, mail: ReferralMail) {
  const boundary = randomUUID();
  const encode = (data: string | Buffer) =>
    Buffer.from(typeof data === 'string' ? data : new Uint8Array(data))
      .toString('base64')
      .match(/.{1,76}/g)
      ?.join('\r\n') ?? '';
  const subjectWords = [];
  let word = '';
  for (const character of mail.subject) {
    if (Buffer.byteLength(word + character) > 42) {
      subjectWords.push(word);
      word = '';
    }
    word += character;
  }
  if (word) subjectWords.push(word);
  const subject = subjectWords
    .map((part) => '=?UTF-8?B?' + Buffer.from(part).toString('base64') + '?=')
    .join('\r\n ');
  return Buffer.from(
    [
      'From: ' + from,
      'To: ' + mail.to,
      'Subject: ' + subject,
      'MIME-Version: 1.0',
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      '',
      '--' + boundary,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      encode(mail.body),
      '--' + boundary,
      'Content-Type: application/pdf',
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${mail.filename}"`,
      '',
      encode(mail.pdf),
      '--' + boundary + '--',
      '',
    ].join('\r\n'),
  ).toString('base64url');
}

export const referralSendSchema = z
  .object({
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    recipients: z
      .array(z.email().transform((email) => email.toLowerCase()))
      .min(1)
      .max(5),
  })
  .strict();

export class ReferralService {
  constructor(
    private store: Store & ReferralProfileStore,
    private pdf: ReferralResumeStore,
    private ai: AI,
    private mailer: ReferralMailer,
    private now = () => new Date().toISOString(),
  ) {}
  async settings() {
    const [profile, resume, gmail] = await Promise.all([
      this.store.getReferralProfile(),
      this.pdf.info(),
      this.store.getGmail(),
    ]);
    return { profile, resume, canSend: !!gmail?.refreshToken && !!gmail.canSend };
  }
  async saveProfile(body: unknown) {
    await this.store.saveReferralProfile(referralProfileSchema.parse(body));
  }
  async upload(filename: string, pdf: Buffer) {
    if (
      !Buffer.isBuffer(pdf) ||
      pdf.length > REFERRAL_PDF_LIMIT ||
      !/\.pdf$/i.test(filename) ||
      pdf.subarray(0, 5).toString('ascii') !== '%PDF-'
    )
      throw new ReferralError(400, 'Upload a PDF résumé up to 5 MB.');
    const safeName =
      filename
        .slice(0, -4)
        .replace(/[^A-Za-z0-9._ -]/g, '_')
        .slice(0, 100) || 'Resume';
    await this.pdf.save(safeName + '.pdf', pdf);
    return this.pdf.info();
  }
  private async application(id: string) {
    const app = (await this.store.listApplications()).find((item) => item.id === id);
    if (!app) throw new NotFound();
    return app;
  }
  async search(id: string, refresh: boolean) {
    const app = await this.application(id);
    if (!isPreApplication(app.status))
      throw new EventConflict('This job is already past referral outreach.');
    if (app.referralContacts && !refresh) return this.preview(id);
    if (!this.ai.findReferrers) throw new ReferralError(503, 'Referral research is unavailable.');
    const { company, title, location, url } = app;
    const contacts = await this.ai.findReferrers({ company, title, location, url });
    await this.store.exclusive(async () => {
      const current = await this.application(id);
      if (
        !isPreApplication(current.status) ||
        current.company !== company ||
        current.title !== title ||
        current.location !== location ||
        current.url !== url
      )
        throw new EventConflict('The job changed. Refresh and search again.');
      if (!current.referralContacts || refresh) {
        current.referralContacts = contacts;
        await this.store.saveApplication(current);
      }
    });
    return this.preview(id);
  }
  async preview(id: string) {
    const [app, settings] = await Promise.all([this.application(id), this.settings()]);
    const contacts = (app.referralContacts ?? []).map((contact) => ({
      ...contact,
      message: settings.profile ? renderReferral(settings.profile, app, contact.name) : undefined,
      state: app.referralSends?.find((send) => send.email === contact.email)?.state,
    }));
    return {
      app,
      contacts,
      resume: settings.resume,
      canSend: settings.canSend,
      hasProfile: !!settings.profile,
      revision: this.revision(app, settings),
    };
  }
  private revision(app: Application, settings: Awaited<ReturnType<ReferralService['settings']>>) {
    return createHash('sha256')
      .update(
        JSON.stringify([
          app.id,
          app.company,
          app.title,
          app.url,
          app.referralContacts ?? [],
          settings.profile,
          settings.resume,
        ]),
      )
      .digest('hex');
  }
  async send(id: string, body: unknown) {
    const { revision, recipients } = referralSendSchema.parse(body);
    const settings = await this.settings();
    const { profile, resume, canSend } = settings;
    if (!profile || !resume || !canSend)
      throw new ReferralError(
        409,
        'Save your referral sender details and résumé and enable Gmail sending in Settings.',
      );
    const current = await this.application(id);
    if (!isPreApplication(current.status) || this.revision(current, settings) !== revision)
      throw new EventConflict('The job or send preview changed. Refresh before sending.');
    const selected = new Set(recipients);
    if (
      [...selected].some(
        (email) =>
          !current.referralContacts?.some(
            (contact) => contact.email === email && contact.emailSource,
          ),
      )
    )
      throw new ReferralError(400, 'Select recipients with a sourced professional email.');
    const pdf = await this.pdf.read(resume.revision);
    for (const to of selected) {
      const message = await this.store.exclusive(async () => {
        const app = await this.application(id);
        if (!isPreApplication(app.status) || this.revision(app, settings) !== revision)
          throw new EventConflict('The job or send preview changed. Refresh before sending.');
        const contact = app.referralContacts?.find((item) => item.email === to && item.emailSource);
        if (!contact)
          throw new ReferralError(400, 'Select recipients with a sourced professional email.');
        const sends = app.referralSends ?? [];
        if (sends.some((item) => item.email === to && item.state !== 'failed')) return;
        if (sends.filter((item) => item.state !== 'failed').length >= 5)
          throw new ReferralError(
            409,
            'This job already has five sent or pending referral emails.',
          );
        app.referralSends = [
          ...sends.filter((item) => item.email !== to),
          { email: to, state: 'sending' },
        ];
        await this.store.saveApplication(app);
        return {
          ...renderReferral(profile, app, contact.name),
          to,
          filename: resume.filename,
          pdf,
        };
      });
      if (!message) continue;
      let threadId: string | undefined;
      let failed = false;
      try {
        threadId = await this.mailer.sendReferral(message);
      } catch (error) {
        const status = httpStatus(error);
        failed = typeof status === 'number' && status >= 400 && status < 500 && status !== 408;
      }
      await this.store.exclusive(async () => {
        const app = await this.application(id);
        const send = app.referralSends?.find((item) => item.email === to);
        if (!send || send.state !== 'sending') return;
        send.state = threadId ? 'sent' : failed ? 'failed' : 'unknown';
        if (threadId) {
          send.threadId = threadId;
          app.referralThreadIds = [...new Set([...(app.referralThreadIds ?? []), threadId])];
          if (app.status === 'Looking for referral') app.status = 'Sent referral emails';
          const at = this.now();
          app.events.push({
            at,
            type: 'referral_sent',
            status: app.status,
            emailSubject: message.subject,
            snippet: 'Sent to ' + to,
            gmailLink: 'https://mail.google.com/mail/u/0/#all/' + threadId,
          });
          app.lastActivityAt = app.updatedAt = at;
        }
        await this.store.saveApplication(app);
      });
    }
    return this.preview(id);
  }
}
