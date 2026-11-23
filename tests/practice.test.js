import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import worker from '../src/worker.js';
import {questionBank} from '../src/bank.js';
import {makePracticePaper, scorePractice} from '../src/practice.js';

const origin = 'https://assessment.example';
const key = 'a'.repeat(64);
const hexId = /^[a-f\d-]{36}$/i;

function fixture() {
  const limited = [];
  let rateDenied = false;
  const target = {
    PRACTICE_KEY: key,
    RATE_KEY: 'b'.repeat(64),
    RATE_LIMITER: { async limit({key: value}) { limited.push(value); return {success:!rateDenied}; } },
  };
  const env = new Proxy(target, {
    get(object, name) {
      if (['ATTEMPTS', 'RECORDS', 'OPS_TOKEN'].includes(name))
        throw new Error('Practice must not read hiring storage, operator access, or notice configuration.');
      return object[name];
    },
  });
  async function request(path, data, options = {}) {
    const headers = {...(options.headers ?? {})};
    if (options.origin !== null) headers.Origin = options.origin ?? origin;
    headers['CF-Connecting-IP'] = '192.0.2.40';
    if (data !== undefined) headers['Content-Type'] = options.contentType ?? 'application/json';
    return worker.fetch(new Request(origin + path, {
      method: options.method ?? 'POST', headers,
      body: data === undefined ? undefined : typeof data === 'string' ? data : JSON.stringify(data),
    }), env);
  }
  return {env, limited, request, setRateDenied(value) { rateDenied = value; }};
}

function amount(text) { return Number(text.replace(/[€,]/g, '')); }

test('each practice attempt draws a different set of 15 and keeps the key off the questions', () => {
  const papers = Array.from({ length: 24 }, () => makePracticePaper());
  const signatures = new Set();
  for (const paper of papers) {
    assert.equal(paper.questions.length, 15);
    assert.deepEqual(paper.questions.map(q => q.section), [
      ...Array(8).fill('Foundations'), ...Array(7).fill('Applied Reading'),
    ]);
    assert.equal(new Set(paper.bankIds).size, 15);
    signatures.add([...paper.bankIds].sort().join('|'));
    assert.equal(paper.questions.filter(q => q.usesReferenceTable).length >= 2, true);
    assert.equal(paper.questions.some(q => q.table), true);
    assert.deepEqual(paper.referenceTable.rows.map(row => row[1]), ['€120,000', '€78,000', '€42,000', '€18,000', '€24,000']);
    assert.equal(JSON.stringify(paper.questions).includes('Good answer:'), false);
    assert.equal(JSON.stringify(paper.questions).includes('bankId'), false);
    for (const question of paper.questions) {
      assert.match(question.id, hexId);
      assert.equal(question.options.length, 4);
      assert.equal(new Set(question.options.map(option => option.text)).size, 4);
      assert.ok(question.options.some(option => option.id === paper.key[question.id]));
      const allowed = ['id', 'options', 'prompt', 'section'];
      if (question.usesReferenceTable) allowed.push('usesReferenceTable');
      if (question.table) allowed.push('table');
      assert.deepEqual(Object.keys(question).sort(), allowed.sort());
      for (const option of question.options) {
        assert.deepEqual(Object.keys(option).sort(), ['id', 'text']);
        assert.match(option.id, hexId);
      }
    }
    assert.equal(scorePractice({ key: paper.key, choiceIds: paper.choiceIds }, paper.key).score, 15);
    assert.deepEqual(scorePractice({ key: paper.key, choiceIds: paper.choiceIds }, {}), { score: 0, total: 15, answered: 0 });
    const oneWrong = { ...paper.key };
    const question = paper.questions[0];
    oneWrong[question.id] = question.options.find(option => option.id !== paper.key[question.id]).id;
    assert.equal(scorePractice({ key: paper.key, choiceIds: paper.choiceIds }, oneWrong).score, 14);
  }
  assert.equal(signatures.size, papers.length, 'practice draws are not a repeated set');
});

test('canonical reference items still follow the published portfolio arithmetic', () => {
  const bench = questionBank().find(item => item.bankId === 'canonical-bench-0');
  assert.match(bench.prompt, /€6,500/);
  assert.match(bench.prompt, /€9,000/);
  assert.equal(bench.correct, '€33,000');
  const margin = questionBank().find(item => item.prompt === 'Using the monthly portfolio reference, what is the Gross Margin %?');
  assert.equal(margin.correct, '35%');
  const daily = questionBank().find(item => item.figures?.kind === 'daily-euro' && item.figures.billing === 800 && item.figures.cost === 500);
  assert.equal(daily.correct, '€300');
  assert.equal(amount('€300'), 300);
});

test('practice route is separate, stateless, same-origin, capped and uses opaque expiring challenges', async () => {
  const {request, limited, setRateDenied} = fixture();
  const started = await request('/api/practice/start', {});
  assert.equal(started.status, 200);
  assert.match(started.headers.get('Cache-Control'), /no-store/);
  assert.equal(started.headers.has('Set-Cookie'), false);
  const first = await started.json();
  assert.equal(first.questions.length, 15);
  assert.equal(first.deadline - first.serverNow, 30 * 60 * 1000);
  assert.match(first.challenge, /^p1\.[A-Za-z\d_-]+$/);
  assert.equal(first.challenge.includes(first.questions[0].id), false, 'ticket is encrypted, not readable JSON');
  assert.equal(Object.keys(first).sort().join(','), 'challenge,deadline,questions,referenceTable,serverNow');
  assert.equal(JSON.stringify(first).includes('Good answer:'), false, 'starting a paper does not reveal explanations');
  assert.equal(JSON.stringify(first).includes('bankId'), false, 'the issued paper does not name bank items');
  assert.deepEqual(first.referenceTable.rows.map(row => row[1]), ['€120,000', '€78,000', '€42,000', '€18,000', '€24,000']);
  assert.equal(limited.length, 1);

  const answers = Object.fromEntries(first.questions.map(q => [q.id, q.options[0].id]));
  const tamperAt = Math.floor(first.challenge.length / 2);
  const tampered = first.challenge.slice(0, tamperAt) + (first.challenge[tamperAt] === 'A' ? 'B' : 'A') + first.challenge.slice(tamperAt + 1);
  assert.equal((await request('/api/practice/submit', {challenge:tampered,answers})).status, 400);
  assert.equal((await request('/api/practice/submit', {challenge:first.challenge,answers:{['f'.repeat(36)]:'e'.repeat(36)}})).status, 422);
  const second = await (await request('/api/practice/start', {})).json();
  assert.equal((await request('/api/practice/submit', {challenge:first.challenge,
    answers:{[second.questions[0].id]:second.questions[0].options[0].id}})).status, 422, 'foreign question IDs are rejected');
  assert.equal((await request('/api/practice/submit', {challenge:first.challenge,
    answers:{[first.questions[0].id]:second.questions[0].options[0].id}})).status, 422, 'foreign option IDs are rejected');

  const allFirstChoices = Object.fromEntries(first.questions.map(q => [q.id, q.options[0].id]));
  const partial = await request('/api/practice/submit', {challenge:first.challenge,answers:allFirstChoices});
  assert.equal(partial.status, 200);
  const scored = await partial.json();
  assert.deepEqual(Object.keys(scored).sort(), ['answered','score','submittedAt','total']);
  assert.equal(scored.total, 15);
  assert.equal(scored.answered, 15);
  const retry = await (await request('/api/practice/submit', {challenge:first.challenge,answers:allFirstChoices})).json();
  assert.deepEqual({score:retry.score,total:retry.total,answered:retry.answered},
    {score:scored.score,total:scored.total,answered:scored.answered});

  const expired = await (await request('/api/practice/start', {})).json();
  const originalNow = Date.now;
  try {
    Date.now = () => expired.deadline;
    const response = await request('/api/practice/submit', {challenge:expired.challenge,answers:{}});
    assert.equal(response.status, 410);
  } finally { Date.now = originalNow; }

  assert.equal((await request('/api/practice/start', {}, {origin:'https://other.example'})).status, 403);
  assert.equal((await request('/api/practice/start', '{}', {contentType:'text/plain'})).status, 415);
  assert.equal((await request('/api/practice/start', 'x'.repeat(33 * 1024))).status, 413);
  const invalidSession = await request('/api/session', undefined, {method:'GET',headers:{Cookie:'__Host-assessment=' + first.challenge}});
  assert.equal((await invalidSession.json()).attempt, null, 'a practice ticket cannot authenticate the recruitment session cookie');
  const hiringEnv = {
    LIVE_ENABLED:'true', PRIVACY_COUNTRY:'FR', PRIVACY_NOTICE:{
      controller:'Test',contact:'privacy@example.invalid',basis:'Test',recipients:'Test',transfers:'Test',rights:'Test',
      purpose:'Test',supervisoryAuthority:'Test',version:'test-1',retentionMinutes:30,
    }, ACCESS_ISSUER:'https://synthetic-test.cloudflareaccess.com', ACCESS_AUD:'a'.repeat(64),
    RATE_LIMITER:{async limit(){return {success:true};}}, ATTEMPTS:{}, RECORDS:{},
  };
  const hiringResponse = await worker.fetch(new Request(origin + '/api/submit', {
    method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},
    body:JSON.stringify({challenge:first.challenge,answers:{}}),
  }), hiringEnv);
  assert.equal(hiringResponse.status, 401, 'a practice challenge cannot authenticate the hiring submission endpoint');
  setRateDenied(true);
  assert.equal((await request('/api/practice/start', {})).status, 429, 'the shared limiter status is preserved');
  assert.ok(limited.length >= 9);
});

test('practice reads the shared server bank and does not touch hiring storage', async () => {
  const source = await readFile(new URL('../src/practice.js', import.meta.url), 'utf8');
  assert.match(source, /from\s+['"]\.\/bank\.js['"]/);
  assert.doesNotMatch(source, /RECORDS|ATTEMPTS|localStorage|sessionStorage|Set-Cookie/i);
});
