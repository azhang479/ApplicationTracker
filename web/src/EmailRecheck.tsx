import { useState } from 'react';

export type RecheckCounts = {
  scanned: number;
  classified: number;
  updated: number;
  review: number;
  skipped: number;
};

export function EmailRecheck({
  connected,
  run,
}: {
  connected: boolean;
  run: (days: number) => Promise<RecheckCounts>;
}) {
  const [days, setDays] = useState('7');
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<RecheckCounts | null>(null);
  const [error, setError] = useState('');
  return (
    <form
      className="email-recheck mt-6 border-t pt-5"
      title="Uses Gemini on job-looking emails (about $0.001 each)."
      onSubmit={async (event) => {
        event.preventDefault();
        if (checking || !connected) return;
        setChecking(true);
        setResult(null);
        setError('');
        try {
          setResult(await run(Number(days)));
        } catch (error) {
          setError(
            error instanceof Error ? error.message : 'Could not re-check emails. Please try again.',
          );
        } finally {
          setChecking(false);
        }
      }}
    >
      <h3 className="text-sm font-semibold">Re-check recent emails</h3>
      <p className="text-xs text-slate-500 mt-1">
        Revisit inbox emails from the last 1–90 days, including ones already checked.
      </p>
      <div className="flex flex-wrap items-end gap-3 mt-3">
        <label className="recheck-days" htmlFor="recheck-days">
          Days
          <input
            id="recheck-days"
            type="number"
            min={1}
            max={90}
            step={1}
            required
            value={days}
            disabled={checking}
            onChange={(event) => setDays(event.target.value)}
          />
        </label>
        <button
          className="primary-button inline-flex items-center gap-2"
          disabled={checking || !connected}
        >
          {checking && (
            <span
              className="inline-block h-3 w-3 rounded-full border-2 border-current border-r-transparent animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
          )}
          {checking ? 'Checking…' : 'Re-check emails'}
        </button>
      </div>
      {!connected && (
        <p className="text-xs text-slate-500 mt-3">Connect Gmail before re-checking emails.</p>
      )}
      <div role="status" className="text-xs text-slate-600 mt-3">
        {result &&
          `Checked ${result.scanned} emails · ${result.updated} updated · ${result.review} to review`}
      </div>
      {error && (
        <p role="alert" className="text-xs text-rose-700 mt-3">
          {error}
        </p>
      )}
    </form>
  );
}
