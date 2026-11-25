import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const token = 'test-token-value-32chars-minimum';

function listen() {
  const server = createServer();
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function handle(server, listener) {
  server.removeAllListeners('request');
  server.on('request', listener);
}

function run(server, args) {
  const { port } = server.address();
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['scripts/ops.mjs', ...args], {
      cwd: root,
      env: { ...process.env, ASSESSMENT_URL: `http://127.0.0.1:${port}`, ASSESSMENT_OPS_TOKEN: token },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

test('ops output keeps the exam clock apart from the invitation start-by time and rejects an Access page', async () => {
  const server = await listen();
  try {
    handle(server, (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end('<html>Sign in to Access</html>');
    });
    const html = await run(server, ['invite', 'FR', '40']);
    assert.equal(html.code, 1);
    assert.match(html.stderr, /did not return JSON/);
    assert.equal(html.stdout, '');

    handle(server, (request, response) => {
      assert.equal(request.headers.authorization, 'Bearer ' + token);
      let body = '';
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        assert.deepEqual(JSON.parse(body), { country: 'FR', durationMinutes: 40 });
        response.writeHead(201, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({
          reference: 'ab'.repeat(16),
          invite: 'ab'.repeat(16) + '.' + 'cd'.repeat(32),
          expiresAt: 1_700_000_000_000,
          hardEnd: 1_700_003_600_000,
          durationMinutes: 40,
          country: 'FR',
        }));
      });
    });
    const created = await run(server, ['invite', 'FR', '40']);
    assert.equal(created.code, 0, created.stderr);
    const printed = JSON.parse(created.stdout);
    assert.equal(printed.examMinutes, 40);
    assert.equal(printed.startBy, 1_700_000_000_000);
    assert.equal(printed.expiresAt, printed.startBy);
    assert.notEqual(printed.examMinutes, printed.startBy);
    assert.equal(printed.hardEnd, 1_700_003_600_000);
    assert.match(printed.clocks, /unused link stops opening/);
    assert.match(printed.clocks, /not the exam clock/);
    assert.match(printed.url, /#invite=/);

    handle(server, (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        reference: 'ab'.repeat(16),
        status: 'active',
        durationMinutes: 40,
        inviteExpiresAt: 10,
        deadline: 20,
        purgeAt: 30,
      }));
    });
    const detail = await run(server, ['get', 'ab'.repeat(16)]);
    assert.equal(detail.code, 0, detail.stderr);
    assert.match(detail.stderr, /inviteExpiresAt/);
    assert.match(detail.stderr, /exam clock ends/);
    assert.match(detail.stderr, /purgeAt/);
    assert.equal(JSON.parse(detail.stdout).deadline, 20);
    assert.equal(JSON.parse(detail.stdout).inviteExpiresAt, 10);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
