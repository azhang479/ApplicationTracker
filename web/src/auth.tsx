import { useEffect, useRef, useState } from 'react';

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize(options: {
            client_id: string;
            callback: (response: { credential: string }) => void;
          }): void;
          renderButton(
            element: HTMLElement,
            options: { theme: string; size: string; width: number },
          ): void;
          disableAutoSelect(): void;
        };
      };
    };
  }
}
export function SignIn({ onToken }: { onToken: (token: string) => void }) {
  const button = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const response = await fetch('/config.json');
        if (!response.ok) throw new Error('Sign-in configuration could not be loaded.');
        const config = await response.json();
        if (!window.google) {
          await new Promise<void>((resolve, reject) => {
            const script = document.createElement('script');
            script.src = 'https://accounts.google.com/gsi/client';
            script.async = true;
            script.onload = () => resolve();
            script.onerror = () =>
              reject(new Error('Google sign-in could not load. Check your connection and reload.'));
            document.head.append(script);
          });
        }
        if (!active || !button.current || !window.google) return;
        window.google.accounts.id.initialize({
          client_id: config.oauthClientId,
          callback: ({ credential }) => onToken(credential),
        });
        window.google.accounts.id.renderButton(button.current, {
          theme: 'outline',
          size: 'large',
          width: 280,
        });
      } catch (error) {
        if (active) setError(error instanceof Error ? error.message : 'Sign-in is unavailable.');
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [onToken]);
  return (
    <div className="min-h-screen grid place-items-center p-6">
      <section className="card max-w-md w-full p-10">
        <div className="brand-icon mb-8">
          a<span>↗</span>
        </div>
        <p className="eyebrow">YOUR NEXT CHAPTER</p>
        <h1 className="text-3xl font-semibold tracking-tight mt-3 mb-3">
          A little more clarity.
          <br />A lot less juggling.
        </h1>
        <p className="text-slate-500 mb-8 leading-relaxed">
          Your applications, conversations, and next steps. All in one place.
        </p>
        <div ref={button} />
        {error && (
          <p role="alert" className="text-rose-700 mt-4 text-sm">
            {error}
          </p>
        )}
        <p className="text-xs text-slate-400 mt-8">Sign in with your connected Google account.</p>
      </section>
    </div>
  );
}
