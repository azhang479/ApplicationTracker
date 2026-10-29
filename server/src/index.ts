import { loadConfig } from './config.js';
import { FirestoreStore } from './store.js';
import { VertexAI } from './ai.js';
import { Tracker } from './service.js';
import { GmailService } from './gmail.js';
import { GoogleVerifier } from './auth.js';
import { createApp } from './app.js';

const config = loadConfig();
const store = new FirestoreStore();
const ai = new VertexAI(config.GOOGLE_CLOUD_PROJECT, config.GCP_LOCATION, config.GEMINI_MODEL);
const tracker = new Tracker(store, ai);
const app = createApp(config, tracker, new GmailService(config, store, ai, tracker), new GoogleVerifier());
const server = app.listen(Number(process.env.PORT || 8080), '0.0.0.0');
process.on('SIGTERM', () => server.close());
