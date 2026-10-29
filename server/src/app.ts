import express, { ErrorRequestHandler, RequestHandler } from 'express';
import { resolve } from 'node:path';
import { z, ZodError } from 'zod';
import { Config } from './config.js';
import { TokenVerifier, auth, sameSecret, signState, validState } from './auth.js';
import { Tracker, NotFound, patchSchema, resolveSchema } from './service.js';
import { GmailService } from './gmail.js';

const wrap = (handler: RequestHandler): RequestHandler => (req, res, next) => { Promise.resolve(handler(req, res, next)).catch(next); };
export function createApp(config: Config, tracker: Tracker, gmail: GmailService, verifier: TokenVerifier) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.get('/health', (_req, res) => { res.json({ ok: true }); });
  app.post('/api/capture', auth(config, verifier, 'extension'), wrap(async (req, res) => {
    const input = z.object({ url: z.string().url(), pageTitle: z.string().max(2000), text: z.string() }).parse(req.body);
    res.json(await tracker.capture(input));
  }));
  app.use('/api', auth(config, verifier, 'owner'));
  app.get('/api/applications', wrap(async (_req, res) => { res.json(await tracker.store.listApplications()); }));
  app.patch('/api/applications/:id', wrap(async (req, res) => { res.json(await tracker.patch(req.params.id, patchSchema.parse(req.body))); }));
  app.delete('/api/applications/:id', wrap(async (req, res) => { await tracker.store.deleteApplication(req.params.id); res.sendStatus(204); }));
  app.get('/api/review', wrap(async (_req, res) => { res.json(await tracker.store.listReview()); }));
  app.post('/api/review/:id/resolve', wrap(async (req, res) => { await tracker.resolve(req.params.id, resolveSchema.parse(req.body)); res.sendStatus(204); }));
  app.get('/api/gmail/status', wrap(async (_req, res) => {
    const data = await tracker.store.getGmail();
    res.json({ connected: !!data?.refreshToken, watchExpiration: data?.watchExpiration || null });
  }));
  app.post('/api/gmail/connect', (_req, res) => {
    const state = signState(config.OAUTH_CLIENT_SECRET);
    res.cookie('gmail_state', state, { httpOnly: true, secure: config.PUBLIC_URL.startsWith('https:'), sameSite: 'lax', maxAge: 600000, path: '/auth/gmail/callback' });
    res.json({ url: gmail.oauth().generateAuthUrl({ scope: ['https://www.googleapis.com/auth/gmail.readonly'], access_type: 'offline', prompt: 'consent', state, login_hint: config.OWNER_EMAIL }) });
  });
  app.get('/auth/gmail/callback', wrap(async (req, res) => {
    const state = z.string().parse(req.query.state);
    const cookie = req.get('cookie')?.split(';').map(s => s.trim()).find(s => s.startsWith('gmail_state='))?.slice(12);
    if (!cookie || !sameSecret(decodeURIComponent(cookie), state) || !validState(state, config.OAUTH_CLIENT_SECRET)) { res.sendStatus(400); return; }
    res.clearCookie('gmail_state', { path: '/auth/gmail/callback' });
    await gmail.connect(z.string().parse(req.query.code));
    res.redirect('/');
  }));
  app.post('/pubsub/gmail', auth(config, verifier, 'push'), wrap(async (req, res) => {
    const envelope = z.object({ message: z.object({ data: z.string() }) }).safeParse(req.body);
    if (!envelope.success) { res.sendStatus(204); return; }
    let notification;
    try { notification = z.object({ emailAddress: z.string(), historyId: z.string() }).parse(JSON.parse(Buffer.from(envelope.data.message.data, 'base64').toString())); }
    catch { res.sendStatus(204); return; }
    try { await gmail.processNotification(notification); }
    catch (error) {
      const code = Number((error as { code?: number }).code);
      if ([400, 401, 403, 404].includes(code)) { console.error('Gmail notification requires owner attention:', code); res.sendStatus(204); return; }
      throw error;
    }
    res.sendStatus(204);
  }));
  app.post('/tasks/daily', auth(config, verifier, 'push'), wrap(async (_req, res) => {
    await gmail.renew();
    res.json({ ghosted: await tracker.ghost(config.GHOSTED_AFTER_DAYS) });
  }));
  app.use('/api', (_req, res) => { res.sendStatus(404); });
  const web = resolve(import.meta.dirname, '../../web/dist');
  app.use(express.static(web));
  app.get('*', (_req, res) => { res.sendFile(resolve(web, 'index.html')); });
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    if (error instanceof ZodError || error instanceof SyntaxError) { res.status(400).json({ error: 'Invalid request' }); return; }
    if (error instanceof NotFound) { res.sendStatus(404); return; }
    console.error('Request failed:', error instanceof Error ? error.name : 'unknown');
    res.status(503).json({ error: 'Service temporarily unavailable' });
  };
  app.use(errors);
  return app;
}
