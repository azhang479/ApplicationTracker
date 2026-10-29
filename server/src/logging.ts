import { ZodError } from 'zod';

export function logError(error: unknown, context: string, sensitive: string[] = []) {
  function redact(value: string) {
    for (const secret of sensitive) {
      if (secret) {
        value = value.split(secret).join('[redacted]');
        value = value.split(JSON.stringify(secret).slice(1, -1)).join('[redacted]');
      }
    }
    return value;
  }
  let message = 'Unknown error';
  if (error instanceof ZodError) message = 'Validation failed';
  else if (error instanceof SyntaxError) message = 'Invalid JSON';
  else if (error instanceof Error) message = error.message;
  const frames =
    error instanceof Error
      ? redact(error.stack || '')
          .split('\n')
          .filter((line) => line.trimStart().startsWith('at '))
          .join('\n')
      : undefined;
  console.error(
    JSON.stringify({
      severity: 'ERROR',
      message: redact(context + ': ' + message),
      status:
        error instanceof Error && 'status' in error && typeof error.status === 'number'
          ? error.status
          : undefined,
      stack: frames && redact(frames),
      issues:
        error instanceof ZodError
          ? error.issues.map((issue) => ({
              path: issue.path.map((part) => redact(String(part))),
              message: redact(issue.message),
            }))
          : undefined,
    }),
  );
}
