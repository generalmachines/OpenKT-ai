/**
 * The one-shot listener Google redirects the system browser to
 * (`http://127.0.0.1:<random port>`). It binds to the loopback address only,
 * accepts exactly one callback carrying the expected `state`, answers with a
 * plain page, and closes. Nothing is logged: the query string holds the code.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export type AuthFailure = 'cancelled' | 'timeout' | 'failed';

export class AuthFlowError extends Error {
  constructor(
    readonly kind: AuthFailure,
    message: string = kind,
  ) {
    super(message);
    this.name = 'AuthFlowError';
  }
}

export interface Loopback {
  port: number;
  /** Exactly what is sent to Google as `redirect_uri` and again in the code exchange. */
  redirectUri: string;
  /** Resolves with the authorization code; rejects with an AuthFlowError. */
  code: Promise<string>;
  close(): void;
}

const page = (title: string, line: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font:16px/1.5 system-ui,-apple-system,sans-serif;color:#1a1a18;background:#fff}` +
  `main{max-width:420px;padding:32px;text-align:center}h1{font-size:20px;font-weight:600;margin:0 0 8px}p{margin:0;color:#55544f}</style></head>` +
  `<body><main><h1>${title}</h1><p>${line}</p></main></body></html>`;

export const SIGNED_IN_PAGE = page('You’re signed in', 'You’re signed in — you can close this tab and return to OpenKT.');
const FAILED_PAGE = page('Sign-in didn’t finish', 'Return to OpenKT and try again.');

export async function startLoopback(opts: { state: string; timeoutMs: number; signal?: AbortSignal }): Promise<Loopback> {
  let settle: { resolve(code: string): void; reject(e: AuthFlowError): void } | null = null;
  const code = new Promise<string>((resolve, reject) => (settle = { resolve, reject }));
  // A rejection nobody awaits yet must not crash main as an unhandled rejection.
  code.catch(() => undefined);

  let open = true;
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const html = (status: number, body: string) => res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'close' }).end(body);
    // Browsers also ask for /favicon.ico; only the redirect itself counts.
    if (req.method !== 'GET' || url.pathname !== '/') return void html(404, FAILED_PAGE);
    if (url.searchParams.get('state') !== opts.state) {
      html(400, FAILED_PAGE);
      return finish(new AuthFlowError('failed', 'state mismatch'));
    }
    const denied = url.searchParams.get('error');
    const got = url.searchParams.get('code');
    if (denied || !got) {
      html(400, FAILED_PAGE);
      return finish(new AuthFlowError(denied === 'access_denied' ? 'cancelled' : 'failed', denied ?? 'no code'));
    }
    html(200, SIGNED_IN_PAGE);
    finish(got);
  });

  const timer = setTimeout(() => finish(new AuthFlowError('timeout')), opts.timeoutMs);
  const onAbort = () => finish(new AuthFlowError('cancelled'));
  opts.signal?.addEventListener('abort', onAbort, { once: true });

  function finish(result: string | AuthFlowError): void {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
    if (open) {
      open = false;
      // Let the response flush, then drop every socket so the port is free at once.
      setImmediate(() => {
        server.close();
        server.closeAllConnections?.();
      });
    }
    if (typeof result === 'string') settle?.resolve(result);
    else settle?.reject(result);
    settle = null;
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // Port 0: the OS picks a free one. 127.0.0.1 only — never reachable from the network.
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;
  if (opts.signal?.aborted) onAbort();

  return { port, redirectUri: `http://127.0.0.1:${port}`, code, close: () => finish(new AuthFlowError('cancelled')) };
}
