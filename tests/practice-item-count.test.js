import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import {makePracticePaper, scorePractice} from '../src/practice.js';

// The sealed practice sitting in this repository is 15 items. The lifetime below
// only makes a forged ticket structurally current, so a rejection is the item
// count and not the clock. This file does not describe a deployed Worker.
const sitting = 15;
const lifetime = 15 * 60 * 1000;
const origin = 'https://assessment.example';
const secret = 'c'.repeat(64);
const encoder = new TextEncoder();
const ticketContext = encoder.encode('mantu-financial-assessment-practice-v1');

function env() {
  return {
    PRACTICE_KEY: secret,
    RATE_KEY: 'd'.repeat(64),
    RATE_LIMITER: {async limit() { return {success: true}; }},
  };
}

async function post(path, data) {
  const response = await worker.fetch(new Request(origin + path, {
    method: 'POST',
    headers: {
      Origin: origin,
      'Content-Type': 'application/json',
      'CF-Connecting-IP': '192.0.2.15',
    },
    body: JSON.stringify(data),
  }), env());
  const body = await response.json();
  return {status: response.status, body};
}

function keyBytes(value) {
  const raw = new Uint8Array(32);
  for (let i = 0; i < raw.length; i++) raw[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return raw;
}

function base64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

async function seal(payload) {
  const key = await crypto.subtle.importKey('raw', keyBytes(secret), 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    {name: 'AES-GCM', iv, additionalData: ticketContext}, key, encoder.encode(JSON.stringify(payload)));
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return 'p1.' + base64url(combined);
}

function project(paper, count) {
  const key = {};
  const choiceIds = {};
  const ids = paper.questions.map(question => question.id);
  for (let i = 0; i < Math.min(count, ids.length); i++) {
    key[ids[i]] = paper.key[ids[i]];
    choiceIds[ids[i]] = paper.choiceIds[ids[i]];
  }
  for (let i = ids.length; i < count; i++) {
    const id = crypto.randomUUID();
    const correct = crypto.randomUUID();
    key[id] = correct;
    choiceIds[id] = [correct, crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  }
  return {key, choiceIds};
}

async function forged(paper, count, alter) {
  const ticket = project(paper, count);
  if (alter) alter(ticket);
  const issuedAt = Date.now();
  return seal({v: 1, issuedAt, deadline: issuedAt + lifetime, key: ticket.key, choiceIds: ticket.choiceIds});
}

function answersFor(paper, count) {
  const answers = {};
  for (const question of paper.questions.slice(0, count)) answers[question.id] = paper.key[question.id];
  return answers;
}

test('a sealed practice ticket is accepted only at exactly 15 items', async () => {
  const paper = makePracticePaper();
  assert.equal(paper.questions.length, sitting);
  assert.equal(Object.keys(paper.key).length, sitting);
  assert.equal(Object.keys(paper.choiceIds).length, sitting);

  const accepted = await post('/api/practice/submit', {
    challenge: await forged(paper, sitting),
    answers: answersFor(paper, sitting),
  });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.deepEqual(
    {score: accepted.body.score, total: accepted.body.total, answered: accepted.body.answered},
    {score: sitting, total: sitting, answered: sitting},
  );

  const partial = await post('/api/practice/submit', {
    challenge: await forged(paper, sitting),
    answers: answersFor(paper, sitting - 1),
  });
  assert.equal(partial.status, 200, JSON.stringify(partial.body));
  assert.equal(partial.body.total, sitting, 'the sitting total stays 15 when one item is unanswered');
  assert.equal(partial.body.answered, sitting - 1);
  assert.equal(partial.body.score, sitting - 1);

  const rejected = [
    ['empty', await forged(paper, 0)],
    ['14 items', await forged(paper, sitting - 1)],
    ['16 items', await forged(paper, sitting + 1)],
    ['15 keys and 14 choice sets', await forged(paper, sitting, ticket => {
      delete ticket.choiceIds[Object.keys(ticket.choiceIds)[0]];
    })],
    ['14 keys and 15 choice sets', await forged(paper, sitting, ticket => {
      delete ticket.key[Object.keys(ticket.key)[0]];
    })],
    ['15 ids that do not line up', await forged(paper, sitting, ticket => {
      const drop = Object.keys(ticket.key)[0];
      delete ticket.choiceIds[drop];
      ticket.choiceIds[crypto.randomUUID()] = [crypto.randomUUID()];
    })],
  ];
  for (const [label, challenge] of rejected) {
    const response = await post('/api/practice/submit', {challenge, answers: {}});
    assert.equal(response.status, 400, label);
    assert.equal(response.body.score, undefined, label);
    assert.equal(response.body.total, undefined, label);
    assert.match(response.body.error, /practice session is invalid/i, label);
  }
});

test('a practice submit cannot carry more than 15 answers, and 14 answers still total 15', async () => {
  const paper = makePracticePaper();
  const fourteen = answersFor(paper, sitting - 1);
  const fifteen = answersFor(paper, sitting);
  const sixteen = {...fifteen, [crypto.randomUUID()]: crypto.randomUUID()};
  assert.equal(scorePractice({key: paper.key, choiceIds: paper.choiceIds}, fourteen).total, sitting);
  assert.equal(scorePractice({key: paper.key, choiceIds: paper.choiceIds}, fourteen).answered, sitting - 1);
  assert.throws(
    () => scorePractice({key: paper.key, choiceIds: paper.choiceIds}, sixteen),
    error => error.status === 400 && /selected answers/i.test(error.message),
  );

  const started = await post('/api/practice/start', {});
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.equal(started.body.questions.length, sitting);
  assert.equal(new Set(started.body.questions.map(question => question.id)).size, sitting);

  const issued = Object.fromEntries(started.body.questions.map(question => [question.id, question.options[0].id]));
  const issuedFourteen = Object.fromEntries(Object.entries(issued).slice(0, sitting - 1));
  const partial = await post('/api/practice/submit', {challenge: started.body.challenge, answers: issuedFourteen});
  assert.equal(partial.status, 200, JSON.stringify(partial.body));
  assert.equal(partial.body.total, sitting);
  assert.equal(partial.body.answered, sitting - 1);
  assert.ok(partial.body.score <= sitting - 1);

  const complete = await post('/api/practice/submit', {challenge: started.body.challenge, answers: issued});
  assert.equal(complete.status, 200, JSON.stringify(complete.body));
  assert.equal(complete.body.total, sitting);
  assert.equal(complete.body.answered, sitting);

  const overflow = {...issued, [crypto.randomUUID()]: crypto.randomUUID()};
  const tooMany = await post('/api/practice/submit', {challenge: started.body.challenge, answers: overflow});
  assert.equal(tooMany.status, 400, JSON.stringify(tooMany.body));
  assert.equal(tooMany.body.score, undefined);
  assert.equal(tooMany.body.total, undefined);
  assert.match(tooMany.body.error, /selected answers/i);
});
