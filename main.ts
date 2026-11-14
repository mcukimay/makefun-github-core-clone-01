// main.ts — the entrypoint of the forge.
//
// Lifecycle (the suite's contract, from the kit's wire spec):
//   1. Build the HTTP server and bind an ephemeral port (listen(0)); never 8080.
//   2. POST {"port": N} to $MAKEFUN_ENV_URL/register so the suite can dial us.
//   3. Poll GET $MAKEFUN_ENV_URL/done until it answers {"done": true}, then exit 0.
//
// The server itself lives in app.ts; this file only owns the bind/register/poll
// loop. Nothing here touches a clock for state, and nothing here calls a model.

import { createApp } from './app.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (ENV_URL === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

// One register or done request may take this long before it is abandoned.
const REQUEST_TIMEOUT_MS = 30_000;
// Backoff between retries: starts short, doubles, caps here.
const RETRY_FIRST_MS = 250;
const RETRY_MAX_MS = 2_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function retryDelay(attempt: number): number {
  const doubled = RETRY_FIRST_MS * 2 ** Math.min(attempt, 8);
  return doubled > RETRY_MAX_MS ? RETRY_MAX_MS : doubled;
}

// POST the bound port until the env accepts it. 200 is normal; 409 means some
// other process registered first, which is equally final for us. 400/405 are
// contract errors and end the run; anything else is retried, since the env
// may still be starting up when we first knock.
async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await sleep(retryDelay(attempt));
  }
}

// GET /done until the env says the trial is over. The env answers at once
// ({"done": false} while the suite runs), so this is a poll: a failed or slow
// poll just means "not done yet" and is retried the same way.
async function waitForDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/done`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // Not answering yet, or the poll timed out: not done, poll again.
    }
    await sleep(retryDelay(attempt));
  }
}

async function main(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${address.port}\n`);

  await register(address.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await waitForDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
