import { z } from 'zod';

const schema = z.object({
  GOOGLE_CLOUD_PROJECT: z.string().min(1), GCP_LOCATION: z.string().default('us-central1'),
  GEMINI_MODEL: z.string().default('gemini-2.5-flash'), OWNER_EMAIL: z.string().email(),
  OAUTH_CLIENT_ID: z.string().min(1), OAUTH_CLIENT_SECRET: z.string().min(1),
  EXTENSION_API_KEY: z.string().min(24), PUBLIC_URL: z.string().url().transform(s => s.replace(/\/$/, '')),
  PUBSUB_TOPIC: z.string().min(1), PUSH_SERVICE_ACCOUNT: z.string().email(),
  GHOSTED_AFTER_DAYS: z.coerce.number().positive().default(45)
});
export type Config = z.infer<typeof schema>;
export const loadConfig = () => schema.parse(process.env);
