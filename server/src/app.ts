import express, { ErrorRequestHandler, RequestHandler, Request } from 'express';
import { resolve } from 'node:path';
import { z, ZodError } from 'zod';
import { Config } from './config.js';
import { TokenVerifier, auth, sameSecret, signState, validState } from './auth.js';
import { Tracker, NotFound, EventConflict, patchSchema, resolveSchema } from './service.js';
import { GmailService } from './gmail.js';
import { logError } from './logging.js';
import { ResumeService, ResumeError } from './resume-service.js';
import { TectonicCompiler, CompilationError, type ResumeCompiler } from './resume-compiler.js';

const wrap =
  (handler: RequestHandler): RequestHandler =>
  (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
export function createApp(
  config: Config,
  tracker: Tracker,
  gmail: GmailService,
  verifier: TokenVerifier,
  compiler: ResumeCompiler = new TectonicCompiler(),
) {
  const app = express();
  const resumes = new ResumeService(
    tracker.store,
    tracker.ai,
    compiler,
    config.RESUME_FILENAME_PREFIX,
  );
  function report(error: unknown, context: string, req: Request) {
    logError(error, context, [
      config.EXTENSION_API_KEY,
      config.OAUTH_CLIENT_SECRET,
      req.get('X-API-Key') || '',
      req.get('Authorization') || '',
      typeof req.body?.text === 'string' ? req.body.text : '',
      typeof req.body?.tex === 'string' ? req.body.tex : '',
    ]);
  }
  app.disable('x-powered-by');
  app.use('/api/resumes', express.json({ limit: '2mb' }));
  app.use(express.json({ limit: '1mb' }));
  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });
  app.get('/config.json', (_req, res) => {
    res.json({ oauthClientId: config.OAUTH_CLIENT_ID });
  });
  app.post(
    '/api/capture',
    auth(config, verifier, 'extension'),
    wrap(async (req, res) => {
      const input = z
        .object({ url: z.string().url(), pageTitle: z.string().max(2000), text: z.string() })
        .parse(req.body);
      res.json(await tracker.capture(input));
    }),
  );
  app.use('/api', auth(config, verifier, 'owner'));
  app.get(
    '/api/resumes',
    wrap(async (_req, res) => {
      res.json(await resumes.list());
    }),
  );
  app.post(
    '/api/resumes',
    wrap(async (req, res) => {
      res.status(201).json(await resumes.save(req.body));
    }),
  );
  app.put(
    '/api/resumes/:id',
    wrap(async (req, res) => {
      res.json(await resumes.save(req.body, req.params.id));
    }),
  );
  app.delete(
    '/api/resumes/:id',
    wrap(async (req, res) => {
      await resumes.delete(req.params.id);
      res.sendStatus(204);
    }),
  );
  app.post(
    '/api/applications/:id/tailor',
    wrap(async (req, res) => {
      res.json(await resumes.generate(req.params.id, req.body ?? {}));
    }),
  );
  app.get(
    '/api/applications/:id/tailoring',
    wrap(async (req, res) => {
      res.json(await resumes.view(req.params.id));
    }),
  );
  app.patch(
    '/api/applications/:id/tailoring',
    wrap(async (req, res) => {
      res.json(await resumes.patch(req.params.id, req.body));
    }),
  );
  app.get(
    '/api/applications/:id/resume.pdf',
    wrap(async (req, res) => {
      const result = await resumes.pdf(req.params.id);
      res.set({
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${result.filename}"`,
        'X-Page-Count': String(result.pageCount),
        'X-Stale-Edit-Ids': JSON.stringify(result.staleEditIds),
        'Cache-Control': 'no-store',
      });
      res.send(result.pdf);
    }),
  );
  app.get(
    '/api/applications',
    wrap(async (_req, res) => {
      res.json(await tracker.store.listApplications());
    }),
  );
  app.patch(
    '/api/applications/:id',
    wrap(async (req, res) => {
      const parsed = patchSchema.parse(req.body);
      const fields = Object.fromEntries(
        Object.entries(parsed).filter(([key]) => Object.hasOwn(req.body, key)),
      );
      res.json(await tracker.patch(req.params.id, fields));
    }),
  );
  app.delete(
    '/api/applications/:id/events/:index',
    wrap(async (req, res) => {
      const index = z.coerce
        .number()
        .int()
        .min(0)
        .max(Number.MAX_SAFE_INTEGER)
        .parse(req.params.index);
      const expected = z
        .object({ at: z.string().min(1).max(200), type: z.string().min(1).max(200) })
        .strict()
        .parse(req.query);
      res.json(await tracker.deleteEvent(req.params.id, index, expected));
    }),
  );
  app.delete(
    '/api/applications/:id',
    wrap(async (req, res) => {
      await tracker.store.deleteApplication(req.params.id);
      res.sendStatus(204);
    }),
  );
  app.get(
    '/api/review',
    wrap(async (_req, res) => {
      res.json(await tracker.store.listReview());
    }),
  );
  app.post(
    '/api/review/:id/resolve',
    wrap(async (req, res) => {
      await tracker.resolve(req.params.id, resolveSchema.parse(req.body));
      res.sendStatus(204);
    }),
  );
  app.get(
    '/api/gmail/status',
    wrap(async (_req, res) => {
      const data = await tracker.store.getGmail();
      res.json({ connected: !!data?.refreshToken, watchExpiration: data?.watchExpiration || null });
    }),
  );
  app.post(
    '/api/gmail/recheck',
    wrap(async (req, res) => {
      const { days } = z
        .object({ days: z.number().int().min(1).max(90) })
        .strict()
        .parse(req.body);
      res.json(await gmail.recheck(days));
    }),
  );
  app.post('/api/gmail/connect', (_req, res) => {
    const state = signState(config.OAUTH_CLIENT_SECRET);
    res.cookie('gmail_state', state, {
      httpOnly: true,
      secure: config.PUBLIC_URL.startsWith('https:'),
      sameSite: 'lax',
      maxAge: 600000,
      path: '/auth/gmail/callback',
    });
    res.json({
      url: gmail.oauth().generateAuthUrl({
        scope: ['https://www.googleapis.com/auth/gmail.readonly'],
        access_type: 'offline',
        prompt: 'consent',
        state,
        login_hint: config.OWNER_EMAIL,
      }),
    });
  });
  app.get(
    '/auth/gmail/callback',
    wrap(async (req, res) => {
      const state = z.string().parse(req.query.state);
      const cookie = req
        .get('cookie')
        ?.split(';')
        .map((s) => s.trim())
        .find((s) => s.startsWith('gmail_state='))
        ?.slice(12);
      if (
        !cookie ||
        !sameSecret(decodeURIComponent(cookie), state) ||
        !validState(state, config.OAUTH_CLIENT_SECRET)
      ) {
        res.sendStatus(400);
        return;
      }
      res.clearCookie('gmail_state', { path: '/auth/gmail/callback' });
      await gmail.connect(z.string().parse(req.query.code));
      res.redirect('/');
    }),
  );
  app.post(
    '/pubsub/gmail',
    auth(config, verifier, 'push'),
    wrap(async (req, res) => {
      const envelope = z.object({ message: z.object({ data: z.string() }) }).safeParse(req.body);
      if (!envelope.success) {
        report(envelope.error, 'Invalid Gmail notification envelope', req);
        res.sendStatus(204);
        return;
      }
      let notification;
      try {
        notification = z
          .object({
            emailAddress: z.string(),
            historyId: z.union([z.string(), z.number()]).transform(String),
          })
          .parse(JSON.parse(Buffer.from(envelope.data.message.data, 'base64').toString()));
      } catch (error) {
        report(error, 'Invalid Gmail notification', req);
        res.sendStatus(204);
        return;
      }
      try {
        await gmail.processNotification(notification);
      } catch (error) {
        const code = Number((error as { code?: number }).code);
        if ([400, 401, 403, 404].includes(code)) {
          report(error, 'Gmail notification requires owner attention (' + code + ')', req);
          res.sendStatus(204);
          return;
        }
        throw error;
      }
      res.sendStatus(204);
    }),
  );
  app.post(
    '/tasks/daily',
    auth(config, verifier, 'push'),
    wrap(async (_req, res) => {
      await gmail.renew();
      res.json({ ghosted: await tracker.ghost(config.GHOSTED_AFTER_DAYS) });
    }),
  );
  app.use('/api', (_req, res) => {
    res.sendStatus(404);
  });
  const web = resolve(import.meta.dirname, '../../web/dist');
  app.use(express.static(web));
  app.get('*', (_req, res) => {
    res.sendFile(resolve(web, 'index.html'));
  });
  const errors: ErrorRequestHandler = (error, req, res, _next) => {
    report(error, 'Request failed', req);
    if (error instanceof CompilationError) {
      res.status(422).json({ error: 'Resume compilation failed', log: error.log });
      return;
    }
    if (error instanceof ResumeError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    if ((error as { type?: string }).type === 'entity.too.large') {
      res.status(413).json({ error: 'Request too large' });
      return;
    }
    if (error instanceof ZodError || error instanceof SyntaxError) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }
    if (error instanceof NotFound) {
      res.sendStatus(404);
      return;
    }
    if (error instanceof EventConflict) {
      res.status(409).json({ error: error.message });
      return;
    }
    res.status(503).json({ error: 'Service temporarily unavailable' });
  };
  app.use(errors);
  return app;
}
