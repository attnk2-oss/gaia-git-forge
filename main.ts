// Entry point: the harness handshake for this forge.
// The env (env/src/wire.ts) owns port 8080 and runs the trial; this process only has to
// bind a free port, hand it over, and stay put until the env says the trial is done.
// All scored behaviour lives in app.ts — this file is just the handshake around it.
//
// The handshake, step by step:
//   1. MAKEFUN_ENV_URL names the env (http://store:8080 inside a trial container). With
//      no env to talk to, there is nothing to do, so the process leaves with code 1.
//   2. Start the forge server on port 0; the kernel picks the port. Never 8080 — the env
//      owns that one.
//   3. POST /register with the bound port. The env records where the request came from
//      plus the port and calls back from then on. The first registration wins; a 409 means
//      another entry got there first, and this process simply waits like any other.
//   4. GET /done until the body reads {"done": true}. The env answers at once either way,
//      so this is a poll, not a held-open request. A failed or slow poll is retried with a
//      short exponential backoff; the process never leaves before the env says done.
//   5. Close the server and exit 0. The harness then stops the env, which writes the
//      export the scorer reads.
//
// This file pulls in the server and nothing else: no package, no Node built-in, no model.

import { createApp } from "./app.ts";

const envOrigin = (process.env.MAKEFUN_ENV_URL ?? "").replace(/\/+$/, "");
if (envOrigin.length === 0) { process.stderr.write("[entry] MAKEFUN_ENV_URL is missing: no env to register with\n"); process.exit(1); }

// The longest one register or done round trip may run before it is dropped and retried.
const REQUEST_LIMIT_MS = 30_000;
// Backoff starts at this wait and doubles, capped at the value below.
const BACKOFF_START_MS = 250;
const BACKOFF_CAP_MS = 2_000;

const pause = (ms: number): Promise<void> =>
  new Promise((done) => setTimeout(done, ms));

// A backoff clock: every call returns the next wait, doubling from the start up to the cap.
const makeBackoff = (): (() => number) => {
  let wait = BACKOFF_START_MS;
  return (): number => {
    const current = wait;
    wait = Math.min(BACKOFF_CAP_MS, wait * 2);
    return current;
  };
};

// Tell the env which port the forge bound. 200 is the normal answer; 409 means another
// entry registered first, which is fine — this process just waits. 400 and 405 are
// contract errors and stop the program; anything else is retried, since the env may still
// be starting up.
const announce = async (port: number): Promise<void> => {
  const nextWait = makeBackoff();
  for (;;) {
    const reply = await fetch(`${envOrigin}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ port }),
      signal: AbortSignal.timeout(REQUEST_LIMIT_MS),
    }).catch(() => null);
    if (reply === null) { await pause(nextWait()); continue; }
    if (reply.status === 200 || reply.status === 409) return;
    if (reply.status === 400 || reply.status === 405) throw new Error(`registration refused: env answered HTTP ${reply.status}: ${await reply.text()}`);
    await pause(nextWait());
  } // for(;;) — retry until the env accepts the registration
};

// Ask the env whether the trial is over, over and over, until it says it is.
// A poll that fails, times out, or answers anything but done just means "not yet".
const awaitDone = async (): Promise<void> => {
  const nextWait = makeBackoff();
  for (;;) {
    const reply = await fetch(`${envOrigin}/done`, {
      signal: AbortSignal.timeout(REQUEST_LIMIT_MS),
    }).catch(() => null);
    const payload =
      reply !== null && reply.ok
        ? ((await reply.json().catch(() => null)) as { done?: unknown } | null)
        : null;
    if (payload !== null && payload.done === true) return;
    await pause(nextWait());
  } // for(;;) — retry until the env says done
};

// Bind a port, announce it, then wait for the env to end the trial. That is the process.
const run = async (): Promise<void> => {
  const app = createApp();
  const listening = new Promise<void>((resolve, reject) => {
    app.once("error", reject);
    app.listen(0, () => resolve());
  }); // listening promise
  await listening;
  const bound = app.address();
  if (bound === null || typeof bound === "string") throw new Error("forge server failed to bind an ephemeral TCP port");
  process.stdout.write(`[entry] forge is listening on port ${bound.port}\n`);
  await announce(bound.port);
  process.stdout.write("[entry] registered with the env; waiting for the trial to end\n");
  await awaitDone();
  app.close();
  process.stdout.write("[entry] trial finished\n");
};

run().then(() => process.exit(0)).catch((failure: unknown) => {
    const detail = failure instanceof Error ? failure.message : String(failure);
    process.stderr.write(`[entry] failed: ${detail}\n`);
    process.exit(1);
    });
