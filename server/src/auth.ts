import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { RequestHandler } from 'express';
import { OAuth2Client } from 'google-auth-library';
import { Config } from './config.js';

export interface TokenVerifier {
  verify(
    token: string,
    audience: string,
  ): Promise<{ email?: string; email_verified?: boolean; iss?: string }>;
}
export class GoogleVerifier implements TokenVerifier {
  private client = new OAuth2Client();
  async verify(token: string, audience: string) {
    return (await this.client.verifyIdToken({ idToken: token, audience })).getPayload() || {};
  }
}
export function sameSecret(a: string, b: string) {
  return timingSafeEqual(
    createHash('sha256').update(a).digest(),
    createHash('sha256').update(b).digest(),
  );
}
export function auth(
  config: Config,
  verifier: TokenVerifier,
  kind: 'owner' | 'extension' | 'push',
): RequestHandler {
  return async (req, res, next) => {
    try {
      if (kind === 'extension') {
        if (!sameSecret(req.get('X-API-Key') || '', config.EXTENSION_API_KEY))
          return void res.sendStatus(401);
      } else {
        const token = req.get('Authorization')?.match(/^Bearer (.+)$/)?.[1];
        if (!token) return void res.sendStatus(401);
        const payload = await verifier.verify(
          token,
          kind === 'owner' ? config.OAUTH_CLIENT_ID : config.PUBLIC_URL + req.path,
        );
        if (
          !['accounts.google.com', 'https://accounts.google.com'].includes(payload.iss || '') ||
          !payload.email_verified ||
          payload.email !== (kind === 'owner' ? config.OWNER_EMAIL : config.PUSH_SERVICE_ACCOUNT)
        )
          return void res.sendStatus(403);
      }
      next();
    } catch {
      res.sendStatus(401);
    }
  };
}
export function signState(secret: string) {
  const payload = Buffer.from(
    JSON.stringify({ expires: Date.now() + 600000, nonce: randomBytes(24).toString('hex') }),
  ).toString('base64url');
  return payload + '.' + createHmac('sha256', secret).update(payload).digest('base64url');
}
export function validState(state: string, secret: string) {
  try {
    const [payload, signature, extra] = state.split('.');
    return (
      !extra &&
      !!signature &&
      sameSecret(signature, createHmac('sha256', secret).update(payload).digest('base64url')) &&
      JSON.parse(Buffer.from(payload, 'base64url').toString()).expires > Date.now()
    );
  } catch {
    return false;
  }
}
