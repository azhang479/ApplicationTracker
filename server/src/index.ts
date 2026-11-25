import { loadConfig } from './config.js';
import { FirestoreStore } from './store.js';
import { VertexAI } from './ai.js';
import { Tracker } from './service.js';
import { GmailService } from './gmail.js';
import { GoogleVerifier } from './auth.js';
import { createApp } from './app.js';
import { CloudReferralResume, ReferralService } from './referrals.js';

const config = loadConfig();
const store = new FirestoreStore();
const ai = new VertexAI(config.GOOGLE_CLOUD_PROJECT, config.GEMINI_LOCATION, config.GEMINI_MODEL);
const tracker = new Tracker(store, ai);
const gmail = new GmailService(config, store, ai, tracker);
const app = createApp(
  config,
  tracker,
  gmail,
  new GoogleVerifier(),
  undefined,
  config.REFERRAL_RESUME_BUCKET
    ? new ReferralService(store, new CloudReferralResume(config.REFERRAL_RESUME_BUCKET), ai, gmail)
    : undefined,
);
const server = app.listen(Number(process.env.PORT || 8080), '0.0.0.0');
process.on('SIGTERM', () => server.close());
