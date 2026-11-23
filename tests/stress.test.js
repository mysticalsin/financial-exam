import assert from 'node:assert/strict';
import test from 'node:test';
import worker, { Assessment } from '../src/worker.js';
import { grade, makePaper, makePortfolioCase, reviewPaper, HIRING_BANK } from '../src/bank.js';
import { makePracticePaper } from '../src/practice.js';

const MINUTE = 60 * 1000;
const PRACTICE_WINDOW = 15 * MINUTE;
const origin = 'https://assessment.example';
const practiceKey = 'a'.repeat(64);
const secretMarkers = ['"key":', '"correct":', '"explanations":'];

function markerLeak(value, markers = secretMarkers) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return markers.find(marker => text.includes(marker)) ?? null;
}

function percentile(samples, p) {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];
}

function overheadBounds(revenue, marginRate) {
  const gross = revenue * marginRate / 100;
  const minimumOverhead = Math.ceil(revenue * 0.08 / 10) * 10;
  const maximumOverhead = Math.floor(Math.min(revenue * 0.24, gross - 1000) / 10) * 10;
  if (!Number.isInteger(gross) || minimumOverhead > maximumOverhead) return null;
  return { gross, minimumOverhead, maximumOverhead };
}

const notice = {
  controller: 'Test controller', contact: 'privacy@example.invalid', basis: 'Test basis',
  recipients: 'Test reviewer', transfers: 'Test transfer description', rights: 'Test rights',
  purpose: 'Test purpose', supervisoryAuthority: 'Test authority', version: 'test-1', retentionMinutes: 30,
};

function hiringFixture() {
  const records = new Map();
  const objects = new Map();
  const env = {
    LIVE_ENABLED: 'true', PRIVACY_COUNTRY: 'FR', PRIVACY_NOTICE: { ...notice }, OPS_TOKEN: 'c'.repeat(64),
    ACCESS_ISSUER: 'https://synthetic-test.cloudflareaccess.com', ACCESS_AUD: 'b'.repeat(64), DURATION_MINUTES: '15',
    RATE_LIMITER: { async limit() { return { success: true }; } },
    ASSETS: { async fetch() { return new Response('Test page'); } },
    RECORDS: {
      async get(key) {
        const entry = records.get(key);
        return entry ? { etag: entry.etag, json: async () => structuredClone(entry.record) } : null;
      },
      async put(key, value, opts) {
        const existing = records.get(key);
        if (opts.onlyIf instanceof Headers) {
          if (existing) return null;
        } else if (!existing || opts.onlyIf.etagMatches !== existing.etag) return null;
        const etag = crypto.randomUUID();
        records.set(key, { record: JSON.parse(value), etag });
        return { etag };
      },
      async delete(key) { records.delete(key); },
      async list() { return { objects: [], truncated: false }; },
    },
    ATTEMPTS: {
      jurisdiction(name) {
        assert.equal(name, 'eu');
        return {
          idFromName: ref => ref,
          idFromString: ref => ref,
          get(id) {
            if (!objects.has(id)) {
              let queue = Promise.resolve();
              const storage = { alarm: null, async deleteAll() { this.alarm = null; }, async setAlarm(time) { this.alarm = time; } };
              const ctx = { id, storage, blockConcurrencyWhile(fn) { const next = queue.then(fn); queue = next.catch(() => {}); return next; } };
              objects.set(id, new Assessment(ctx, env));
            }
            return objects.get(id);
          },
        };
      },
    },
  };
  async function req(path, method, data, { cookie, admin, reference } = {}) {
    const headers = {};
    if (reference) headers['X-Assessment-Reference'] = reference;
    if (!admin && method !== 'GET') headers.Origin = origin;
    if (admin) headers.Authorization = 'Bearer ' + env.OPS_TOKEN;
    if (cookie) headers.Cookie = cookie;
    if (data !== undefined) headers['Content-Type'] = 'application/json';
    return worker.fetch(new Request(origin + path, {
      method, headers, body: data === undefined ? undefined : JSON.stringify(data),
    }), env);
  }
  async function issue() {
    const response = await req('/api/ops/invites', 'POST', { durationMinutes: 15 }, { admin: true });
    assert.equal(response.status, 201);
    return response.json();
  }
  async function start(inviteData) {
    const claim = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
    const response = await req('/api/start', 'POST', { invite: inviteData.invite, claim, noticeVersion: notice.version });
    assert.equal(response.status, 200, await response.clone().text());
    const cookie = response.headers.get('Set-Cookie').split(';')[0];
    return { cookie, ...(await response.json()) };
  }
  return { env, records, objects, req, issue, start };
}

function practiceFixture() {
  const env = {
    PRACTICE_KEY: practiceKey,
    RATE_KEY: 'b'.repeat(64),
    RATE_LIMITER: { async limit() { return { success: true }; } },
  };
  return async function request(path, data) {
    return worker.fetch(new Request(origin + path, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.40' },
      body: JSON.stringify(data),
    }), env);
  };
}

test('hiring attempts rotate the whole bank without leaking keys or slowing down', () => {
  const byPrompt = new Map(HIRING_BANK.map(item => [item.prompt, item]));
  const seen = new Set();
  const sets = new Set();
  const placements = new Set();
  const foundationOrders = new Set();
  const samples = [];
  const papers = [];
  for (let attempt = 0; attempt < 200; attempt++) {
    const started = performance.now();
    const paper = makePaper();
    samples.push(performance.now() - started);
    papers.push(paper);
    assert.equal(paper.questions.length, 15);
    assert.deepEqual(paper.questions.map(question => question.section), [
      ...Array(8).fill('Foundations'), ...Array(7).fill('Applied Reading'),
    ]);
    const prompts = paper.questions.map(question => question.prompt);
    assert.equal(new Set(prompts).size, 15);
    sets.add(prompts.slice().sort().join('\n'));
    foundationOrders.add(prompts.slice(0, 8).join('\n'));
    const issued = JSON.stringify(paper.questions);
    assert.equal(markerLeak(issued, [...secretMarkers, '"explanation":']), null);
    for (const question of paper.questions) {
      const item = byPrompt.get(question.prompt);
      assert.ok(item, question.prompt);
      seen.add(question.prompt);
      const correct = question.options.find(option => option.id === paper.key[question.id][0]);
      assert.equal(correct.text, item.correct);
      assert.equal(question.options.filter(option => option.text === item.correct).length, 1);
      placements.add(question.options.indexOf(correct));
      for (const option of question.options) assert.deepEqual(Object.keys(option).sort(), ['id', 'text']);
      assert.equal(issued.includes(item.explanations.good), false, question.prompt);
      assert.equal(issued.includes(item.explanations.bad), false, question.prompt);
      if (question.table) {
        assert.deepEqual(question.table, item.table);
        assert.notEqual(question.table.rows[0], item.table.rows[0]);
        const preserved = item.table.rows[0][1];
        question.table.rows[0][1] = 'tampered';
        assert.equal(item.table.rows[0][1], preserved);
      }
    }
    assert.equal(grade(paper, paper.key), 15);
    assert.equal(grade(paper, {}), 0);
    const reviewed = reviewPaper(paper, paper.key);
    assert.ok(reviewed.every(item => item.outcome === 'good' && item.explanation === paper.explanations[item.id].good));
    assert.equal(JSON.stringify(reviewed).includes('"key":'), false);
  }
  assert.equal(sets.size, papers.length, 'rotation repeated a 15-question set');
  assert.ok(foundationOrders.size > 1, 'foundation order did not rotate');
  assert.equal(placements.size, 4);
  assert.equal(seen.size, HIRING_BANK.length, 'a bank question never appeared across 200 attempts');
  for (let index = 0; index < papers.length; index += 2) {
    assert.equal(grade(papers[index + 1], papers[index].key), 0);
  }
  const first = samples.slice(0, samples.length / 2);
  const second = samples.slice(samples.length / 2);
  const firstMedian = percentile(first, 0.5);
  const secondMedian = percentile(second, 0.5);
  assert.ok(secondMedian < firstMedian * 4 + 1, `paper assembly slowed from ${firstMedian}ms to ${secondMedian}ms`);
  assert.ok(percentile(samples, 0.95) < 25, `paper assembly p95 was ${percentile(samples, 0.95)}ms`);
  console.log(`hiring assembly n=200 median=${firstMedian.toFixed(3)}ms then ${secondMedian.toFixed(3)}ms`);
});

test('repeated hiring starts keep the 15-minute server deadline and hide the key until the deadline', async () => {
  const byPrompt = new Map(HIRING_BANK.map(item => [item.prompt, item]));
  const signatures = new Set();
  for (let attempt = 0; attempt < 12; attempt++) {
    const fixture = hiringFixture();
    const invite = await fixture.issue();
    const started = await fixture.start(invite);
    const { attempt: session } = started;
    assert.equal(session.deadline - session.startedAt, 15 * MINUTE);
    assert.equal(session.purgeAt - session.deadline, 30 * MINUTE);
    assert.equal(session.status, 'active');
    assert.equal(session.score, undefined);
    assert.equal(session.review, undefined);
    assert.equal(session.questions.length, 15);
    assert.equal(markerLeak(session, [...secretMarkers, '"explanation":']), null);
    const prompts = session.questions.map(question => question.prompt);
    signatures.add(prompts.slice().sort().join('\n'));
    for (const question of session.questions) {
      const item = byPrompt.get(question.prompt);
      const payload = JSON.stringify(session);
      assert.equal(payload.includes(item.explanations.good), false);
      assert.equal(payload.includes(item.explanations.bad), false);
    }
    const stored = fixture.records.get(invite.reference).record;
    assert.equal(Object.keys(stored.paper.key).length, 15);
    assert.equal(markerLeak(session), null);
    const again = await (await fixture.req('/api/session', 'GET', undefined, {
      cookie: started.cookie, reference: invite.reference,
    })).json();
    assert.equal(again.attempt.deadline, session.deadline);
    assert.equal(again.attempt.startedAt, session.startedAt);
    assert.equal(again.attempt.score, undefined);
    const extended = await fixture.req('/api/answers', 'PUT', {
      questionId: session.questions[0].id,
      choices: [session.questions[0].options[0].id],
      revision: session.revision,
      reference: invite.reference,
      deadline: session.deadline + 60 * MINUTE,
    }, { cookie: started.cookie });
    assert.equal(extended.status, 400);
    const saved = await (await fixture.req('/api/answers', 'PUT', {
      questionId: session.questions[0].id,
      choices: [session.questions[0].options[0].id],
      revision: session.revision,
      reference: invite.reference,
    }, { cookie: started.cookie })).json();
    assert.equal(saved.attempt.score, undefined);
    assert.equal(saved.attempt.review, undefined);
    assert.equal(saved.attempt.deadline, session.deadline);
    const live = fixture.records.get(invite.reference).record;
    live.deadline = Date.now() - 1;
    const closed = await (await fixture.req('/api/session', 'GET', undefined, {
      cookie: started.cookie, reference: invite.reference,
    })).json();
    assert.equal(closed.attempt.status, 'expired');
    assert.equal(closed.attempt.questions.length, 0);
    assert.equal(typeof closed.attempt.score, 'number');
    assert.equal(closed.attempt.review.length, 15);
    assert.equal(markerLeak(closed.attempt), null);
    assert.equal(closed.attempt.review.filter(item => item.outcome !== 'unanswered').length, 1);
    assert.ok(closed.attempt.review.every(item => item.explanation && ['good', 'bad', 'unanswered'].includes(item.outcome)));
    const late = await fixture.req('/api/answers', 'PUT', {
      questionId: session.questions[1].id,
      choices: [session.questions[1].options[0].id],
      revision: saved.attempt.revision,
      reference: invite.reference,
    }, { cookie: started.cookie });
    assert.equal(late.status, 409);
  }
  assert.equal(signatures.size, 12);
});

test('practice retakes keep one pack, a fixed 15-minute deadline, and keys inside the ticket', async () => {
  const request = practiceFixture();
  const modulePaper = makePracticePaper();
  const correctText = new Map(modulePaper.questions.map(question => [
    question.prompt, question.options.find(option => option.id === modulePaper.key[question.id]).text,
  ]));
  const explanationByPrompt = new Map(modulePaper.questions.map(question => [question.prompt, modulePaper.explanations[question.id]]));
  const foundationOrders = new Set();
  const optionSlots = new Set();
  const optionIdentities = new Set();
  let previousAnswers = null;
  for (let attempt = 0; attempt < 40; attempt++) {
    const response = await request('/api/practice/start', attempt === 0 ? { deadline: Date.now() + 60 * MINUTE } : {});
    if (attempt === 0) {
      assert.equal(response.status, 400);
      continue;
    }
    assert.equal(response.status, 200);
    assert.equal(response.headers.has('Set-Cookie'), false);
    const bodyText = await response.text();
    const body = JSON.parse(bodyText);
    assert.equal(body.deadline - body.serverNow, PRACTICE_WINDOW);
    assert.deepEqual(Object.keys(body).sort(), ['challenge', 'deadline', 'questions', 'referenceTable', 'serverNow']);
    assert.equal(markerLeak(bodyText, [...secretMarkers, '"explanation":']), null);
    for (const pair of explanationByPrompt.values()) {
      assert.equal(bodyText.includes(pair.good), false);
      assert.equal(bodyText.includes(pair.bad), false);
    }
    assert.equal(body.questions.length, 15);
    assert.deepEqual(body.questions.map(question => question.section), [
      ...Array(8).fill('Foundations'), ...Array(7).fill('Applied Reading'),
    ]);
    foundationOrders.add(body.questions.slice(0, 8).map(question => question.prompt).join('\n'));
    const answers = {};
    for (const question of body.questions) {
      assert.equal(correctText.has(question.prompt), true, question.prompt);
      const correct = question.options.find(option => option.text === correctText.get(question.prompt));
      assert.ok(correct);
      answers[question.id] = correct.id;
      if (question.id === 'practice-q1') {
        optionSlots.add(question.options.indexOf(correct));
        optionIdentities.add(question.options.map(option => option.id).join(','));
      }
    }
    if (previousAnswers) {
      const foreign = await request('/api/practice/submit', { challenge: body.challenge, answers: previousAnswers });
      assert.equal(foreign.status, 422);
    }
    const submitted = await request('/api/practice/submit', {
      challenge: body.challenge, answers, deadline: body.deadline + MINUTE,
    });
    assert.equal(submitted.status, 400);
    const scoredResponse = await request('/api/practice/submit', { challenge: body.challenge, answers });
    assert.equal(scoredResponse.status, 200);
    const scored = await scoredResponse.json();
    assert.equal(scored.score, 15);
    assert.equal(scored.total, 15);
    assert.equal(markerLeak(scored), null);
    for (const item of scored.review) {
      const prompt = body.questions.find(question => question.id === item.id).prompt;
      assert.equal(item.outcome, 'good');
      assert.equal(item.explanation, explanationByPrompt.get(prompt).good);
    }
    const retry = await (await request('/api/practice/submit', { challenge: body.challenge, answers })).json();
    assert.equal(retry.score, 15);
    previousAnswers = answers;
  }
  assert.ok(foundationOrders.size > 1);
  assert.equal(optionSlots.size, 4);
  assert.ok(optionIdentities.size > 1);

  const originalNow = Date.now;
  try {
    for (let boundary = 0; boundary < 6; boundary++) {
      Date.now = originalNow;
      const open = await (await request('/api/practice/start', {})).json();
      assert.equal(open.deadline - open.serverNow, PRACTICE_WINDOW);
      Date.now = () => open.deadline;
      const expired = await request('/api/practice/submit', { challenge: open.challenge, answers: {} });
      assert.equal(expired.status, 410);
      const expiredBody = await expired.json();
      assert.equal(expiredBody.score, undefined);
      assert.equal(expiredBody.review, undefined);
      Date.now = () => open.deadline - 1;
      const allowed = await request('/api/practice/submit', { challenge: open.challenge, answers: {} });
      assert.equal(allowed.status, 200);
      const allowedBody = await allowed.json();
      assert.equal(allowedBody.score, 0);
      assert.equal(allowedBody.review.length, 15);
      assert.ok(allowedBody.review.every(item => item.outcome === 'unanswered'));
      assert.equal(markerLeak(allowedBody), null);
    }
  } finally {
    Date.now = originalNow;
  }
});

test('integer portfolio cases stay on the supported grid, including both edges', () => {
  const formatter = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });
  const money = value => '€' + formatter.format(value);
  let checked = 0;
  for (let revenue = 90000; revenue <= 300000; revenue += 1000) {
    for (let marginRate = 28; marginRate <= 46; marginRate++) {
      const bounds = overheadBounds(revenue, marginRate);
      assert.ok(bounds, `${revenue}/${marginRate}`);
      const middle = bounds.minimumOverhead + Math.floor((bounds.maximumOverhead - bounds.minimumOverhead) / 20) * 10;
      for (const overhead of [bounds.minimumOverhead, middle, bounds.maximumOverhead]) {
        const sample = makePortfolioCase(revenue, marginRate, overhead);
        assert.equal(sample.gross, bounds.gross);
        assert.equal(sample.directCosts + sample.gross, revenue);
        assert.equal(sample.contribution, sample.gross - overhead);
        assert.ok(Number.isInteger(sample.contribution) && sample.contribution > 0);
        assert.deepEqual(sample.table.rows.map(row => row[1]), [
          money(revenue), money(sample.directCosts), money(sample.gross), money(overhead), money(sample.contribution),
        ]);
        checked++;
      }
    }
  }
  assert.ok(checked >= 10000, `only ${checked} integer cases were checked`);
  for (const [revenue, marginRate, overhead] of [[89900, 35, 8000], [300100, 35, 20000], [120050, 35, 18000], [120000, 27, 18000], [120000, 47, 18000]]) {
    assert.throws(() => makePortfolioCase(revenue, marginRate, overhead), /outside the supported range/);
  }
  const edge = overheadBounds(120000, 35);
  assert.throws(() => makePortfolioCase(120000, 35, edge.minimumOverhead - 10), /outside the supported range/);
  assert.throws(() => makePortfolioCase(120000, 35, edge.minimumOverhead + 5), /outside the supported range/);
  console.log(`integer portfolio grid checked ${checked} cases`);
});
