import type { Application } from './types';
import { assessmentEmailLink } from './assessment';

export function AssessmentEmailLink({ app }: { app: Application }) {
  const link = assessmentEmailLink(app);
  if (!link) return null;
  return (
    <a
      className="link text-xs block mt-2"
      href={link}
      target="_blank"
      rel="noreferrer"
      onClick={(event) => event.stopPropagation()}
    >
      Open OA email ↗
    </a>
  );
}
