import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cp, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));
const fixture = await mkdtemp(path.join(os.tmpdir(), 'mantu-assessment-test-'));
const opsToken = randomBytes(32).toString('hex');
const notice = {
  controller: 'Synthetic controller for local integration tests',
  contact: 'test-privacy@example.invalid',
  basis: 'Synthetic test basis',
  recipients: 'Synthetic test operators',
  transfers: 'Synthetic transfer statement',
  rights: 'Synthetic access and erasure procedure',
  purpose: 'Local integration testing with generated records',
  supervisoryAuthority: 'Synthetic supervisory authority',
  version: 'test-v1', retentionMinutes: 30
};
const secondNotice = { ...notice, version: 'test-it-v1' };
let runtime;
let origin;

async function openPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  return server;
}

async function start(advanceMinutes = 0) {
  // workerd lacks the EU jurisdiction implementation. The local namespace adapter requires the
  // production call to explicitly select 'eu'. Its count endpoint sees only this temporary R2.
  // Date advances only in this disposable runtime and lets a restart exercise the actual cutoff.
  await writeFile(path.join(fixture, 'src', 'test-entry.js'), `
    import worker, { Assessment } from './worker.js';
    export { Assessment };
    const realNow = Date.now.bind(Date);
    Date.now = () => realNow() + ${advanceMinutes} * 60000;
    function environment(env) {
      const local = Object.create(env);
      Object.defineProperty(local, 'ATTEMPTS', {value: {
        jurisdiction(region) {
          if (region !== 'eu') throw new Error('Test requires the EU jurisdiction.');
          return env.ATTEMPTS;
        }
      }});
      return local;
    }
    export default {
      async fetch(request, env, ctx) {
        if (new URL(request.url).pathname === '/fixture/object-count') {
          const {objects} = await env.RECORDS.list();
          return Response.json({count: objects.length}, {headers:{'Cache-Control':'no-store'}});
        }
        return worker.fetch(request, environment(env), ctx);
      },
      scheduled(event, env, ctx) {
        return worker.scheduled(event, environment(env), ctx);
      }
    };
  `);
  // Reserve both addresses together so the inspector and application cannot receive the same port.
  const app = await openPort();
  let inspector;
  let port, inspectorPort;
  try {
    inspector = await openPort();
    port = app.address().port;
    inspectorPort = inspector.address().port;
  } finally {
    await Promise.all([app, inspector].filter(Boolean).map(server =>
      new Promise(resolve => server.close(resolve))));
  }
  origin = 'http://127.0.0.1:' + port;
  const script = path.join(project, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  runtime = spawn(process.execPath, [
    script, 'dev', 'src/test-entry.js', '--local', '--ip', '127.0.0.1', '--port', String(port),
    '--test-scheduled', '--inspector-ip', '127.0.0.1', '--inspector-port', String(inspectorPort),
    '--persist-to', path.join(fixture, 'state'), '--log-level', 'error'
  ], {
    cwd: fixture, stdio: 'ignore', detached: process.platform !== 'win32',
    env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot || '',
      WRANGLER_LOG_PATH: path.join(fixture, 'wrangler.log'), WRANGLER_SEND_METRICS: 'false',
      CLOUDFLARE_INCLUDE_PROCESS_ENV: 'true', LIVE_ENABLED: 'true', OPS_TOKEN: opsToken,
      ACCESS_ISSUER: 'https://synthetic-test.cloudflareaccess.com', ACCESS_AUD: 'a'.repeat(64),
      NOTICE_PROFILES: JSON.stringify({ FR: notice, IT: secondNotice }), CI: 'true'
    }
  });
  for (let i = 0; i < 120; i++) {
    if (runtime.exitCode !== null || runtime.signalCode) throw new Error('Local Wrangler exited before readiness.');
    try {
      const res = await fetch(origin + '/api/config', { signal: AbortSignal.timeout(400) });
      if (res.ok) {
        const config = await res.json();
        assert.ok(config.enabled,
          'local runtime must enable only the explicit synthetic notice');
        return;
      }
    } catch (error) {
      if (error instanceof assert.AssertionError) throw error;
    }
    await delay(125);
  }
  throw new Error('Timed out waiting for local Wrangler.');
}

async function stop() {
  const child = runtime;
  if (!child) return;
  runtime = null;
  if (process.platform === 'win32') {
    await new Promise(resolve => {
      const kill = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
      kill.once('error', resolve);
      kill.once('exit', resolve);
    });
    return;
  }
  const signalGroup = signal => {
    try { process.kill(-child.pid, signal); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  signalGroup('SIGTERM');
  for (let i = 0; i < 30; i++) {
    if (child.exitCode !== null || child.signalCode) break;
    await delay(50);
  }
  signalGroup('SIGKILL');
  if (child.exitCode === null && !child.signalCode) await new Promise(resolve => child.once('exit', resolve));
}

async function clean() {
  await stop();
  await rm(fixture, { recursive: true, force: true, maxRetries: 4 });
}
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.once(signal, async () => { try { await clean(); } finally { process.exit(code); } });
}

async function api(route, { method = 'GET', json, cookie, operator, browser = true, reference } = {}) {
  const headers = {};
  if (reference) headers['X-Assessment-Reference'] = reference;
  if (browser && method !== 'GET' && !operator) headers.Origin = origin;
  if (operator) headers.Authorization = 'Bearer ' + opsToken;
  if (cookie) headers.Cookie = cookie;
  if (json !== undefined) headers['Content-Type'] = 'application/json';
  const reply = await fetch(origin + route, {
    method, headers, body: json === undefined ? undefined : JSON.stringify(json),
    redirect: 'error', signal: AbortSignal.timeout(6000)
  });
  assert.match(reply.headers.get('Cache-Control') || '', /no-store/);
  return { status: reply.status, headers: reply.headers, body: await reply.json() };
}

function status(reply, expected, step) {
  assert.equal(reply.status, expected, step + ' (HTTP status)');
  return reply.body;
}

function sessionCookie(reply) {
  const raw = reply.headers.get('Set-Cookie') || '';
  const fields = raw.split(';').map(v => v.trim());
  assert.ok(fields[0].startsWith('__Host-assessment='), 'host-bound session cookie');
  for (const attribute of ['Path=/', 'Secure', 'HttpOnly', 'SameSite=Strict']) {
    assert.ok(fields.includes(attribute), 'session cookie attribute ' + attribute);
  }
  return fields[0];
}

const objectCount = async () => status(await api('/fixture/object-count'), 200, 'local primary store').count;
const issue = async country => status(await api('/api/ops/invites', {
  method: 'POST', operator: true, json: { durationMinutes: 17, country }
}), 201, 'issue invitation');
const claim = (invite, secret, version = notice.version) => api('/api/start', {
  method: 'POST', json: { invite, claim: secret, noticeVersion: version }
});
const view = (cookie, reference) => api('/api/session', { cookie, reference });
const answer = (cookie, reference, revision, questionId, choice) => api('/api/answers', {
  method: 'PUT', cookie, json: { reference, revision, questionId, choices: [choice] }
});
const submit = (cookie, reference, revision, extras = {}) => api('/api/submit', {
  method: 'POST', cookie, json: { reference, revision, ...extras }
});
const review = (reference, options) => api('/api/ops/attempts/' + reference, { operator: true, ...options });

async function exercise() {
  status(await api('/api/ops/invites', { method: 'POST', json: {} }), 403, 'operator authentication');
  assert.equal(status(await view(), 200, 'unclaimed browser').attempt, null);
  assert.equal(await objectCount(), 0);
  const badCountry = await api('/api/ops/invites', {
    method: 'POST', operator: true, json: { durationMinutes: 17, country: 'XX' }
  });
  assert.ok([400, 422].includes(badCountry.status), 'unconfigured country cannot receive a scored invitation');
  const [a, b] = await Promise.all([issue('FR'), issue('IT')]);
  assert.equal(await objectCount(), 2, 'both invitation records exist in the local primary store');
  assert.ok(a.reference !== b.reference && a.invite !== b.invite, 'independent invitations');
  const preflight = status(await api('/api/invitation', { method: 'POST', json: { invite: a.invite } }), 200, 'preflight');
  assert.equal(preflight.durationMinutes, 17);
  assert.equal(preflight.notice.version, notice.version);
  assert.equal(preflight.notice.retentionMinutes, 30);
  assert.ok(!Object.hasOwn(preflight, 'questions'), 'preflight is question-free');
  const claims = [randomBytes(32).toString('hex'), randomBytes(32).toString('hex')];
  status(await claim(a.invite, claims[0], 'previous-test-version'), 409, 'stale notice version');
  const starts = await Promise.all(claims.map(secret => claim(a.invite, secret)));
  assert.deepEqual(starts.map(r => r.status).sort(), [200, 403], 'only one independent browser claims an invitation');
  const winner = starts.findIndex(r => r.status === 200);
  const cookieA = sessionCookie(starts[winner]);
  const initial = starts[winner].body.attempt;
  const retry = await claim(a.invite, claims[winner]);
  assert.ok(sessionCookie(retry) === cookieA, 'lost successful start response can be retried by the original claimant');
  assert.ok(JSON.stringify(retry.body.attempt) === JSON.stringify(initial), 'retry preserves the same paper and deadline');
  assert.equal(initial.questions.length, 15);
  assert.equal(initial.deadline - initial.startedAt, 17 * 60000);
  const privateFields = new Set(['key', 'correct', 'score', 'expected', 'inviteHash', 'sessionHash', 'paper', 'review', 'explanation', 'explanations']);
  JSON.stringify(initial, (name, value) => {
    assert.ok(!privateFields.has(name), 'candidate payload omits private field ' + name);
    return value;
  });
  status(await api('/api/invitation', { method: 'POST', json: { invite: a.invite } }), 403, 'claimed invitation preflight');
  status(await submit(cookieA, a.reference, initial.revision), 409, 'incomplete submission');
  const secondPreflight = status(await api('/api/invitation', { method: 'POST', json: { invite: b.invite } }), 200, 'second-country preflight');
  assert.equal(secondPreflight.notice.retentionMinutes, 30);
  assert.equal(secondPreflight.notice.version, secondNotice.version);
  const second = await claim(b.invite, randomBytes(32).toString('hex'), secondNotice.version);
  status(second, 200, 'second invitation');
  const cookieB = sessionCookie(second);
  const secondPaper = second.body.attempt;
  assert.notDeepEqual(
    initial.questions.map(question => question.prompt).sort(),
    secondPaper.questions.map(question => question.prompt).sort(),
    'two attempts receive different question sets'
  );
  const [firstQ] = initial.questions;
  const [otherQ] = secondPaper.questions;
  status(await answer(cookieA, a.reference, initial.revision, otherQ.id, otherQ.options[0].id), 422, 'question scoped to issued paper');
  status(await answer(cookieA, a.reference, initial.revision, firstQ.id, otherQ.options[0].id), 422, 'option scoped to issued question');
  const mixedCookie = cookieA.replace(a.reference, b.reference);
  assert.equal((await view(mixedCookie, a.reference)).status, 409, 'cross-attempt session credential is rejected before storage');
  status(await api('/api/ops/attempts/' + a.reference, { cookie: cookieA }), 403, 'candidate cannot export scores');
  status(await api('/api/answers', { method: 'PUT', cookie: cookieA, browser: false, json: {
    reference: a.reference, questionId: firstQ.id, choices: [firstQ.options[0].id], revision: initial.revision
  } }), 403, 'same-origin write guard');

  const exportA = status(await review(a.reference), 200, 'operator export before grading');
  assert.equal(exportA.notice.version, notice.version);
  assert.equal(preflight.hardEnd - exportA.issuedAt, 60 * 60000);
  assert.ok(initial.purgeAt <= preflight.hardEnd);
  assert.equal(exportA.score, null);
  JSON.stringify(exportA, (name, value) => {
    assert.ok(!['expected', 'correct', 'key', 'paper'].includes(name), 'active reviewer record withholds ' + name);
    return value;
  });
  // Pick candidate answers without access to the grade or the correct option.
  const choices = initial.questions.map((q, index) => q.options[index % q.options.length].id);
  const twoSaves = await Promise.all(initial.questions.slice(0, 2).map((q, i) =>
    answer(cookieA, a.reference, initial.revision, q.id, choices[i])));
  assert.deepEqual(twoSaves.map(r => r.status).sort(), [200, 409], 'concurrent saves serialize by revision');
  const missed = twoSaves.findIndex(r => r.status === 409);
  let revision = twoSaves[1 - missed].body.attempt.revision;
  let saved = status(await answer(cookieA, a.reference, revision, initial.questions[missed].id, choices[missed]), 200, 'retry save after conflict').attempt;
  revision = saved.revision;
  saved = status(await answer(cookieA, a.reference, initial.revision, firstQ.id, choices[0]), 200, 'idempotent delivery of an accepted answer').attempt;
  assert.equal(saved.revision, revision);
  const beforeRestart = saved;
  await stop();
  await start();
  saved = status(await view(cookieA, a.reference), 200, 'refresh after runtime process restart').attempt;
  assert.deepEqual(saved, beforeRestart);
  assert.deepEqual(status(await view(cookieB, b.reference), 200, 'second attempt remains isolated').attempt.answers, {});

  for (let i = 2; i < initial.questions.length; i++) {
    const save = await answer(cookieA, a.reference, revision, initial.questions[i].id, choices[i]);
    revision = status(save, 200, 'persist an issued choice').attempt.revision;
  }
  status(await submit(cookieA, a.reference, revision, { score: 15 }), 400, 'client cannot dictate score');
  const last = initial.questions.at(-1);
  const replacement = last.options.find(o => o.id !== choices.at(-1)).id;
  const [edit, final] = await Promise.all([
    answer(cookieA, a.reference, revision, last.id, replacement), submit(cookieA, a.reference, revision)
  ]);
  assert.deepEqual([edit.status, final.status].sort(), [200, 409], 'concurrent final edit and submit serialize');
  const editWon = edit.status === 200;
  const receipt = editWon
    ? status(await submit(cookieA, a.reference, edit.body.attempt.revision), 200, 'submit after reviewing latest revision').attempt
    : final.body.attempt;
  assert.equal(receipt.status, 'submitted');
  assert.equal(receipt.purgeAt, Math.min(preflight.hardEnd, receipt.submittedAt + 30 * 60000));
  assert.equal(receipt.answered, 15);
  assert.equal(receipt.questions.length, 0);
  assert.equal(typeof receipt.score, 'number');
  assert.equal(receipt.review.length, 15);
  assert.ok(!Object.hasOwn(receipt, 'key'));
  assert.equal(JSON.stringify(receipt).includes('"key":'), false);
  assert.equal(JSON.stringify(receipt).includes('"correct":'), false);
  assert.equal(JSON.stringify(receipt).includes('"expected":'), false);
  assert.deepEqual(status(await submit(cookieA, a.reference, revision), 200, 'idempotent final submit').attempt, receipt);
  status(await answer(cookieA, a.reference, receipt.revision, firstQ.id, choices[0]), 409, 'completed paper is immutable');
  const result = status(await review(a.reference), 200, 'recruiter result');
  assert.equal(result.responses.length, initial.questions.length);
  if (editWon) choices[choices.length - 1] = replacement;
  let expectedScore = 0;
  for (const [index, question] of initial.questions.entries()) {
    const row = result.responses.find(record => record.question === question.prompt);
    assert.ok(row, 'each issued question appears in the closed review');
    const chosenText = question.options.find(o => o.id === choices[index]).text;
    assert.deepEqual(row.selected, [chosenText], 'record matches the choice actually sent');
    assert.equal(row.expected.length, 1);
    assert.ok(question.options.some(o => o.text === row.expected[0]), 'post-submit key names an issued answer');
    if (chosenText === row.expected[0]) expectedScore++;
  }
  assert.equal(result.score, expectedScore, 'grade matches an independent count from original selections and closed review');
  assert.equal(receipt.score, expectedScore);
  assert.equal(receipt.review.filter(item => item.outcome === 'good').length, expectedScore);
  const startPayload = JSON.stringify(initial);
  const midExamPayload = JSON.stringify(beforeRestart);
  for (const item of receipt.review) {
    assert.equal(startPayload.includes(item.explanation), false, 'start payload leaked an explanation');
    assert.equal(midExamPayload.includes(item.explanation), false, 'mid-exam payload leaked an explanation');
    assert.equal(startPayload.includes('"key":'), false);
    assert.equal(midExamPayload.includes('"correct":'), false);
  }
  status(await review(a.reference, { method: 'DELETE' }), 200, 'erase request');
  status(await review(a.reference), 404, 'deleted operator export');
  assert.equal(status(await view(cookieA, a.reference), 200, 'deleted candidate session').attempt, null);
  status(await claim(a.invite, claims[winner]), 403, 'erased invitation cannot restart');
  assert.equal(status(await view(cookieB, b.reference), 200, 'erasure isolation').attempt.status, 'active');
  assert.equal(await objectCount(), 1, 'explicit erasure removes the primary R2 object');
  await stop();
  await start(18);
  await issue('FR');
  const closed = status(await view(cookieB, b.reference), 200, 'server deadline').attempt;
  assert.equal(closed.status, 'expired');
  const pastDeadline = await answer(cookieB, b.reference, secondPaper.revision, otherQ.id, otherQ.options[0].id);
  assert.ok([401, 403, 409].includes(pastDeadline.status), 'a late answer is refused');
  await stop();
  await start(61);
  status(await review(b.reference), 404, 'past cutoff records are unavailable');
  assert.equal(await objectCount(), 1, 'past cutoff access purges the active attempt, leaving the untouched invitation');
  const sweep = await fetch(origin + '/__scheduled?cron=' + encodeURIComponent('*/5 * * * *'), {
    signal: AbortSignal.timeout(6000)
  });
  assert.equal(sweep.status, 200, 'wrangler local scheduled event dispatched');
  assert.equal(await objectCount(), 0, 'scheduled sweep purges an untouched expired invitation');
}

try {
  // Snapshot only the application inputs. This prevents an operator's .dev.vars, local state
  // or development process from supplying credentials or being touched by this run.
  await Promise.all(['src', 'public', 'wrangler.jsonc', 'package.json'].map(name =>
    cp(path.join(project, name), path.join(fixture, name), { recursive: true })));
  await symlink(path.join(project, 'node_modules'), path.join(fixture, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir');
  await start();
  await exercise();
  console.log('PASS: local Worker claim races, retries, scope, persisted restart, concurrent edits, authoritative grading, export, R2 erasure, simulated time cutoffs and scheduled cleanup.');
} finally {
  await clean();
}
