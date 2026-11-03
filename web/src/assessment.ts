import type { Application } from './types';

export function assessmentEmailLink(app: Pick<Application, 'events'>): string | undefined {
  let link: string | undefined;
  let latest = -Infinity;
  for (const event of app.events) {
    if (event.type !== 'online_assessment' || !event.gmailLink) continue;
    const emailDate = Date.parse(event.emailDate || '');
    const at = Number.isFinite(emailDate) ? emailDate : Date.parse(event.at);
    if (Number.isFinite(at) && at >= latest) {
      latest = at;
      link = event.gmailLink;
    }
  }
  return link;
}
