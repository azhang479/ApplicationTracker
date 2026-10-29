import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';

beforeEach(() => {
  const values = {
    GOOGLE_CLOUD_PROJECT: 'project',
    OWNER_EMAIL: 'owner@gmail.com',
    OAUTH_CLIENT_ID: 'client',
    OAUTH_CLIENT_SECRET: 'secret',
    EXTENSION_API_KEY: 'test-extension-key-long-enough',
    PUBLIC_URL: 'https://tracker.test',
    PUBSUB_TOPIC: 'projects/project/topics/gmail',
    PUSH_SERVICE_ACCOUNT: 'push@project.iam.gserviceaccount.com',
    GCP_LOCATION: undefined,
    GEMINI_LOCATION: undefined,
    GEMINI_MODEL: undefined,
  };
  for (const [key, value] of Object.entries(values)) vi.stubEnv(key, value);
});
afterEach(() => vi.unstubAllEnvs());
describe('Gemini configuration', () => {
  it('defaults to the working global Flash model independently of the resource region', () => {
    const config = loadConfig();
    expect(config.GCP_LOCATION).toBe('us-central1');
    expect(config.GEMINI_LOCATION).toBe('global');
    expect(config.GEMINI_MODEL).toBe('gemini-3-flash-preview');
  });
  it('allows independent model and location overrides', () => {
    vi.stubEnv('GCP_LOCATION', 'us-east1');
    vi.stubEnv('GEMINI_LOCATION', 'europe-west4');
    vi.stubEnv('GEMINI_MODEL', 'custom-flash');
    const config = loadConfig();
    expect(config.GCP_LOCATION).toBe('us-east1');
    expect(config.GEMINI_LOCATION).toBe('europe-west4');
    expect(config.GEMINI_MODEL).toBe('custom-flash');
  });
});
