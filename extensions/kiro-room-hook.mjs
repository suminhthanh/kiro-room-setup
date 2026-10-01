#!/usr/bin/env node
/**
 * Hook entry point wired into every generated role runtime.
 *
 * Reads a kiro-cli hook payload as JSON on stdin and exits 0 to permit or 2 to
 * block. Exits 0 immediately when KIRO_ROOM_ROLE is unset so that a plain
 * `kiro-cli` session is never affected, even if this file is somehow reachable
 * from a global configuration.
 *
 * Fails closed on its own errors only for preToolUse: if the policy itself
 * cannot run, a mutating tool must not proceed. Every other event fails open,
 * because blocking a prompt submission on an internal error would strand the
 * session with no way to recover.
 */

import { handleHook, envFromProcess, BLOCK_EXIT_CODE } from './kiro-policy.mts';

function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      buf += chunk;
    });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', () => resolve(buf));
  });
}

const env = envFromProcess();

// Cheapest possible exit for a non-Room session: no stdin read, no policy load.
if (!env.role) process.exit(0);

const raw = await readStdin();

let payload;
try {
  payload = raw.trim() ? JSON.parse(raw) : {};
} catch (error) {
  process.stderr.write(
    `kiro-room: could not parse hook payload as JSON (${error.message}).\n`,
  );
  process.exit(BLOCK_EXIT_CODE);
}

const isPreTool = payload?.hook_event_name === 'preToolUse';

try {
  const outcome = handleHook(payload, env);
  if (outcome.message) process.stdout.write(`${outcome.message}\n`);
  process.exit(outcome.exitCode);
} catch (error) {
  process.stderr.write(`kiro-room: policy evaluation failed: ${error.message}\n`);
  process.exit(isPreTool ? BLOCK_EXIT_CODE : 0);
}
