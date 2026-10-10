import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  awaitProcessExit,
  browserChannel,
  stopServer,
} from '../tools/dev/rs-server.mjs';

test('browser channel defaults by platform and honors RS_BROWSER_CHANNEL', () => {
  assert.equal(browserChannel('win32', {}), 'msedge');
  assert.equal(browserChannel('darwin', {}), 'chrome');
  assert.equal(
    browserChannel('win32', { RS_BROWSER_CHANNEL: 'chrome-beta' }),
    'chrome-beta',
  );
});

test('awaitProcessExit recognizes normal, signal, and negative-code exits', async () => {
  const exits = { exitCode: null };
  let sleeps = 0;
  assert.equal(
    await awaitProcessExit(exits, 10, async () => {
      sleeps += 1;
      exits.exitCode = 0;
    }),
    true,
  );
  assert.equal(sleeps, 1);

  assert.equal(
    await awaitProcessExit({ exitCode: 0, signalCode: null }, 0),
    true,
  );
  assert.equal(
    await awaitProcessExit({ exitCode: null, signalCode: 'SIGKILL' }, 0),
    true,
  );
  assert.equal(
    await awaitProcessExit({ exitCode: -9, signalCode: null }, 0),
    true,
  );
  assert.equal(
    await awaitProcessExit({ exitCode: null, signalCode: null }, 0, async () => {
      throw new Error('must not sleep after deadline');
    }),
    false,
  );
});

test('stopServer deletes temporary state after a confirmed signal exit', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'rs-signal-exit-'));
  writeFileSync(path.join(dataDir, 'state.json'), '{}', 'utf8');

  await stopServer({
    dataDir,
    port: 18920,
    proc: {
      exitCode: null,
      signalCode: 'SIGTERM',
      pid: 999999,
      kill() {
        throw new Error('an exited process must not be killed again');
      },
    },
  });

  assert.equal(existsSync(dataDir), false);
});

test('stopServer preserves temporary state when exit is not confirmed', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'rs-running-'));
  writeFileSync(path.join(dataDir, 'state.json'), '{}', 'utf8');
  let forced = 0;
  const proc = {
    exitCode: null,
    signalCode: null,
    pid: 999999,
    kill() {
      forced += 1;
      return true;
    },
  };

  await assert.rejects(
    stopServer(
      { dataDir, port: 18920, proc },
      {
        waitForExit: async () => false,
      },
    ),
    /did not exit.*keeping temporary state/s,
  );

  assert.equal(forced, 1);
  assert.equal(existsSync(dataDir), true);
});
