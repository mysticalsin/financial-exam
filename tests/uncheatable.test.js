import test from "node:test";
import assert from "node:assert/strict";
import worker, { Assessment } from "../src/worker.js";
import { authorizeReviewer } from "../src/access.js";

const origin = "https://assessment.example";
const notice = {
  controller: "Test controller", contact: "privacy@example.invalid", basis: "Test basis",
  recipients: "Test reviewer", transfers: "Test transfer description", rights: "Test rights",
  purpose: "Test purpose", supervisoryAuthority: "Test authority", version: "test-1", retentionMinutes: 30,
};
const random = () => crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
const practiceKey = "a".repeat(64);
const candidateSecretFields = ["key", "correct", "explanation", "expected", "score", "notes", "integritySummary", "inviteHash", "sessionHash", "paper", "choiceIds"];

function fixture() {
  const objects = new Map();
  const records = new Map();
  const limiterKeys = [];
  let limited = false;
  const env = {
    LIVE_ENABLED: "true", PRIVACY_COUNTRY: "FR", PRIVACY_NOTICE: { ...notice }, OPS_TOKEN: random(),
    ACCESS_ISSUER: "https://synthetic-test.cloudflareaccess.com", ACCESS_AUD: "a".repeat(64), DURATION_MINUTES: 30,
    RATE_LIMITER: { async limit({ key }) { limiterKeys.push(key); return { success: !limited }; } },
    ASSETS: { async fetch() { return new Response("Test page"); } },
    RECORDS: {
      async get(key) {
        const entry = records.get(key);
        return entry ? { etag: entry.etag, json: async () => structuredClone(entry.record) } : null;
      },
      async put(key, value, opts) {
        const existing = records.get(key);
        if (opts.onlyIf instanceof Headers) {
          if (existing) return null;
        } else if (!existing || opts.onlyIf.etagMatches !== existing.etag) {
          return null;
        }
        const etag = crypto.randomUUID();
        records.set(key, { record: JSON.parse(value), metadata: { ...opts.customMetadata }, etag });
        return { etag };
      },
      async delete(key) { records.delete(key); },
      async list() {
        return { objects: [...records].map(([key, entry]) => ({ key, customMetadata: entry.metadata })), truncated: false };
      },
    },
    ATTEMPTS: {
      jurisdiction(name) {
        assert.equal(name, "eu");
        return {
          idFromName: ref => ref,
          idFromString: ref => ref,
          get(id) {
            if (!objects.has(id)) {
              let queue = Promise.resolve();
              const storage = { alarm: null, async deleteAll() { this.alarm = null; }, async setAlarm(time) { this.alarm = time; } };
              const ctx = { id, storage, blockConcurrencyWhile(fn) {
                const next = queue.then(fn);
                queue = next.catch(() => {});
                return next;
              } };
              objects.set(id, new Assessment(ctx, env));
            }
            return objects.get(id);
          },
        };
      },
    },
  };
  async function req(path, method = "GET", data, { cookie, admin, reference, headers = {} } = {}) {
    const init = { method, headers: { ...headers } };
    if (reference) init.headers["X-Assessment-Reference"] = reference;
    if (!admin && method !== "GET" && !("Origin" in init.headers)) init.headers.Origin = origin;
    if (admin) init.headers.Authorization = "Bearer " + env.OPS_TOKEN;
    if (cookie) init.headers.Cookie = cookie;
    if (data !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(data);
    }
    return worker.fetch(new Request(origin + path, init), env);
  }
  const admin = { admin: true };
  async function issue(durationMinutes = 30) {
    const response = await req("/api/ops/invites", "POST", { durationMinutes }, admin);
    assert.equal(response.status, 201);
    return response.json();
  }
  async function start(inviteData, claim = random(), extra = {}) {
    const response = await req("/api/start", "POST", {
      invite: inviteData.invite, claim, noticeVersion: notice.version, ...extra,
    });
    assert.equal(response.status, 200);
    const setCookie = response.headers.get("Set-Cookie");
    return { cookie: setCookie.split(";")[0], claim, ...(await response.json()) };
  }
  return { env, objects, records, limiterKeys, req, issue, start, admin, setLimited(value) { limited = value; } };
}

function assertNoCandidateSecrets(value, path = "$") {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoCandidateSecrets(item, path + "[" + index + "]"));
    return;
  }
  for (const field of candidateSecretFields) {
    assert.equal(Object.hasOwn(value, field), false, path + " leaks " + field);
  }
  for (const [key, child] of Object.entries(value)) assertNoCandidateSecrets(child, path + "." + key);
}

async function answerAll(f, started) {
  let revision = started.attempt.revision;
  for (const question of started.attempt.questions) {
    const response = await f.req("/api/answers", "PUT", {
      reference: started.attempt.reference, questionId: question.id, choices: [question.options[0].id], revision,
    }, { cookie: started.cookie });
    assert.equal(response.status, 200);
    revision = (await response.json()).attempt.revision;
  }
  return revision;
}

test("cookieless candidate calls spend the limiter before any record is opened", async () => {
  const f = fixture();
  const reference = "ab".repeat(16);
  const answer = { reference, questionId: "x", choices: [], revision: 1 };
  f.limiterKeys.length = 0;
  const allowed = await f.req("/api/answers", "PUT", answer);
  assert.equal(allowed.status, 401);
  assert.equal(f.limiterKeys.length, 1, "a missing cookie still consumes the network bucket");
  assert.equal(f.objects.size, 0);
  assert.equal(f.records.size, 0);

  f.setLimited(true);
  f.limiterKeys.length = 0;
  assert.equal((await f.req("/api/answers", "PUT", answer)).status, 429);
  assert.equal((await f.req("/api/submit", "POST", { reference, revision: 1 })).status, 429);
  assert.equal((await f.req("/api/integrity", "PUT", { reference, questionId: "x" })).status, 429);
  assert.equal((await f.req("/api/session")).status, 429);
  assert.equal((await f.req("/api/start", "POST", {
    invite: reference + "." + "cd".repeat(32), claim: "ef".repeat(32), noticeVersion: notice.version,
  })).status, 429);
  assert.equal(f.objects.size, 0);
  assert.equal(f.records.size, 0);
  assert.equal(f.limiterKeys.every(key => /^[0-9a-f]{64}$/.test(key)), true);

  f.env.LIVE_ENABLED = "false";
  const closed = await f.req("/api/session");
  assert.equal(closed.status, 200);
  assert.equal((await closed.json()).attempt, null, "closed mode without a cookie stays an empty session");
});

test("junk connecting-ip values share a bucket and the attempt key includes the deployment salt", async () => {
  const addresses = fixture();
  async function onlyKey(ip) {
    addresses.limiterKeys.length = 0;
    const response = await addresses.req("/api/answers", "PUT", {
      reference: "ab".repeat(16), questionId: "x", choices: [], revision: 1,
    }, { headers: { "CF-Connecting-IP": ip } });
    assert.equal(response.status, 401);
    assert.equal(addresses.limiterKeys.length, 1);
    return addresses.limiterKeys[0];
  }
  const plain = await onlyKey("192.0.2.10");
  assert.equal(await onlyKey("192.0.2.10, 203.0.113.9"), plain, "a comma-joined header does not mint a second bucket");
  assert.equal(await onlyKey("192.0.2.10 "), plain);
  assert.equal(await onlyKey("not an address"), await onlyKey("@@@"));
  assert.notEqual(await onlyKey("192.0.2.11"), plain);
  assert.notEqual(await onlyKey("2001:db8::10"), plain);

  const f = fixture();
  const started = await f.start(await f.issue());
  f.limiterKeys.length = 0;
  const question = started.attempt.questions[0];
  const save = (token) => {
    f.env.OPS_TOKEN = token;
    f.limiterKeys.length = 0;
    return f.req("/api/answers", "PUT", {
      reference: started.attempt.reference, questionId: question.id, choices: [question.options[0].id], revision: started.attempt.revision,
    }, { cookie: started.cookie }).then(async response => {
      assert.equal(response.status, 200);
      return [...f.limiterKeys];
    });
  };
  const first = await save(f.env.OPS_TOKEN);
  const second = await save(random());
  assert.equal(first.length, 2);
  assert.equal(second.length, 2);
  assert.equal(second.filter(key => first.includes(key)).length, 0, "network and per-attempt keys both change with the salt");
});

test("the server deadline rejects late edits, injected clocks, and a second paper", async () => {
  const f = fixture();
  const invite = await f.issue();
  const started = await f.start(invite);
  const question = started.attempt.questions[0];
  const choice = question.options[0].id;
  const other = question.options[1].id;
  const save = (body, cookie = started.cookie) => f.req("/api/answers", "PUT", body, { cookie });
  const stored = () => f.records.get(invite.reference).record;
  const saved = await (await save({
    reference: invite.reference, questionId: question.id, choices: [choice], revision: started.attempt.revision,
  })).json();
  assertNoCandidateSecrets(saved);
  const deadline = stored().deadline;
  const injected = await save({
    reference: invite.reference, questionId: question.id, choices: [other], revision: saved.attempt.revision,
    deadline: Date.now() + 86_400_000, score: 15, key: { stolen: true }, serverNow: 0,
  });
  assert.equal(injected.status, 400);
  assert.equal(stored().deadline, deadline);
  assert.deepEqual(stored().answers[question.id], [choice]);

  stored().deadline = Date.now() - 1;
  const revisionAtClose = stored().revision;
  const replay = await save({
    reference: invite.reference, questionId: question.id, choices: [choice], revision: saved.attempt.revision,
  });
  assert.equal(replay.status, 409);
  assert.equal((await replay.json()).attempt, undefined);
  assert.equal(stored().status, "expired");
  assert.deepEqual(stored().answers[question.id], [choice], "an identical post-deadline write does not mutate answers");
  assert.equal(stored().revision, revisionAtClose + 1);
  const mutated = await save({
    reference: invite.reference, questionId: question.id, choices: [other], revision: stored().revision,
  });
  assert.equal(mutated.status, 409);
  assert.equal(stored().revision, revisionAtClose + 1);
  assert.equal(stored().score, undefined);
  const lateSubmit = await f.req("/api/submit", "POST", { reference: invite.reference, revision: stored().revision }, { cookie: started.cookie });
  assert.equal(lateSubmit.status, 409);
  assert.match((await lateSubmit.json()).error, /closed/);
  assert.equal(stored().status, "expired");
  assert.equal(stored().score, undefined);

  const resumed = await f.req("/api/start", "POST", {
    invite: invite.invite, claim: started.claim, noticeVersion: notice.version,
  });
  assert.equal(resumed.status, 200);
  const resumedBody = await resumed.json();
  assert.equal(resumedBody.attempt.status, "expired");
  assert.deepEqual(resumedBody.attempt.questions, []);
  assertNoCandidateSecrets(resumedBody);
  assert.deepEqual(stored().paper.questions.map(item => item.id), started.attempt.questions.map(item => item.id));
  const replacement = await f.req("/api/start", "POST", {
    invite: invite.invite, claim: random(), noticeVersion: notice.version,
  });
  assert.equal(replacement.status, 403);
  assert.equal(stored().status, "expired");
});

test("concurrent starts cannot both open a paper, and a second submit cannot change the score", async () => {
  const f = fixture();
  const invite = await f.issue();
  const claimA = random();
  const claimB = random();
  const startBody = claim => ({ invite: invite.invite, claim, noticeVersion: notice.version });
  const [first, second] = await Promise.all([
    f.req("/api/start", "POST", startBody(claimA)),
    f.req("/api/start", "POST", startBody(claimB)),
  ]);
  assert.deepEqual([first.status, second.status].sort(), [200, 403]);
  const winner = first.status === 200 ? first : second;
  const opened = await winner.json();
  assert.equal(f.records.size, 1);
  assert.equal(f.records.get(invite.reference).record.status, "active");
  assert.deepEqual(f.records.get(invite.reference).record.paper.questions.map(item => item.id), opened.attempt.questions.map(item => item.id));
  const cookie = winner.headers.get("Set-Cookie").split(";")[0];
  const started = { cookie, attempt: opened.attempt };

  const [refresh, write] = await Promise.all([
    f.req("/api/session", "GET", undefined, { cookie, reference: invite.reference }),
    f.req("/api/answers", "PUT", {
      reference: invite.reference, questionId: opened.attempt.questions[0].id,
      choices: [opened.attempt.questions[0].options[0].id], revision: opened.attempt.revision,
    }, { cookie }),
  ]);
  assert.equal(refresh.status, 200);
  assert.equal(write.status, 200);
  assertNoCandidateSecrets(await refresh.json());
  assertNoCandidateSecrets(await write.json());
  const settled = await (await f.req("/api/session", "GET", undefined, { cookie, reference: invite.reference })).json();
  assert.equal(settled.attempt.revision, f.records.get(invite.reference).record.revision);
  assert.deepEqual(settled.attempt.answers, f.records.get(invite.reference).record.answers);

  const revision = await answerAll(f, { ...started, attempt: settled.attempt });
  const submit = () => f.req("/api/submit", "POST", { reference: invite.reference, revision }, { cookie });
  const [left, right] = await Promise.all([submit(), submit()]);
  assert.equal(left.status, 200);
  assert.equal(right.status, 200);
  const leftBody = await left.json();
  const rightBody = await right.json();
  assert.equal(leftBody.attempt.status, "submitted");
  assert.deepEqual(leftBody.attempt, rightBody.attempt);
  assert.deepEqual(leftBody.attempt.questions, []);
  assert.equal(leftBody.attempt.score, undefined);
  assertNoCandidateSecrets(leftBody);
  const exported = await (await f.req("/api/ops/attempts/" + invite.reference, "GET", undefined, f.admin)).json();
  assert.equal(exported.responses.length, 15);
  assert.equal(Number.isInteger(exported.score) && exported.score >= 0 && exported.score <= 15, true);
  const purgeAt = f.records.get(invite.reference).record.purgeAt;
  const score = exported.score;
  f.records.get(invite.reference).record.deadline = Date.now() - 1;
  const duplicate = await submit();
  assert.equal(duplicate.status, 200, "a duplicate submit after the deadline still returns the receipt");
  assert.equal((await duplicate.json()).attempt.revision, leftBody.attempt.revision);
  assert.equal(f.records.get(invite.reference).record.purgeAt, purgeAt);
  const after = await (await f.req("/api/ops/attempts/" + invite.reference, "GET", undefined, f.admin)).json();
  assert.equal(after.score, score);
  const rewritten = await f.req("/api/answers", "PUT", {
    reference: invite.reference, questionId: opened.attempt.questions[0].id, choices: [], revision: after.revision ?? leftBody.attempt.revision,
  }, { cookie });
  assert.equal(rewritten.status, 409);
  assert.equal((await (await f.req("/api/ops/attempts/" + invite.reference, "GET", undefined, f.admin)).json()).score, score);
});

test("active reviewer and candidate payloads omit the grading key, and a candidate cannot open the reviewer route", async () => {
  const f = fixture();
  f.env.PRIVACY_NOTICE.integrityReview = true;
  const invite = await f.issue();
  const started = await f.start(invite, random(), { integrityReview: true });
  const question = started.attempt.questions[0];
  assertNoCandidateSecrets(started);
  const active = await (await f.req("/api/ops/attempts/" + invite.reference, "GET", undefined, f.admin)).json();
  assert.equal(active.status, "active");
  assert.equal(active.responses, undefined);
  assert.equal(active.paper, undefined);
  assert.equal(active.score, null);
  assert.equal(JSON.stringify(active).includes("Good answer:"), false);
  const forgedReview = await f.req("/api/ops/attempts/" + invite.reference, "GET", undefined, {
    cookie: started.cookie,
    headers: { Origin: origin, "Cf-Access-Jwt-Assertion": "not-a-jwt" },
  });
  assert.equal(forgedReview.status, 403);
  assert.equal((await forgedReview.json()).responses, undefined);

  const signal = await f.req("/api/integrity", "PUT", {
    reference: invite.reference, questionId: question.id, kind: "copy",
  }, { cookie: started.cookie });
  assert.equal(signal.status, 200);
  f.records.get(invite.reference).record.deadline = Date.now() - 1;
  const lateSignal = await f.req("/api/integrity", "PUT", {
    reference: invite.reference, questionId: started.attempt.questions[1].id, kind: "pageHidden",
  }, { cookie: started.cookie });
  assert.equal(lateSignal.status, 409);
  const closed = await (await f.req("/api/session", "GET", undefined, { cookie: started.cookie, reference: invite.reference })).json();
  assert.equal(closed.attempt.status, "expired");
  assertNoCandidateSecrets(closed);
  const review = await (await f.req("/api/ops/attempts/" + invite.reference, "GET", undefined, f.admin)).json();
  assert.equal(review.integritySummary.copy, 1);
  assert.equal(review.integritySummary.pageHidden, 0, "a signal after the deadline is not counted");
  assert.equal(review.responses.length, 15);
  assert.equal(Object.hasOwn(closed.attempt, "integritySummary"), false);
});

test("a practice ticket cannot be extended, swapped, or accepted as a hiring session", async () => {
  const env = {
    PRACTICE_KEY: practiceKey,
    RATE_KEY: "b".repeat(64),
    RATE_LIMITER: { async limit() { return { success: true }; } },
  };
  const request = (path, data, headers = {}) => worker.fetch(new Request(origin + path, {
    method: data === undefined ? "GET" : "POST",
    headers: { Origin: origin, "Content-Type": "application/json", ...headers },
    body: data === undefined ? undefined : JSON.stringify(data),
  }), env);
  const started = await (await request("/api/practice/start", {})).json();
  assertNoCandidateSecrets({ ...started, challenge: undefined });
  assert.equal(Object.hasOwn(started, "key"), false);
  assert.equal(Object.hasOwn(started, "explanation"), false);
  const answers = Object.fromEntries(started.questions.map(question => [question.id, question.options[0].id]));
  const flippedAt = Math.floor(started.challenge.length / 2);
  const flipped = started.challenge.slice(0, flippedAt) + (started.challenge[flippedAt] === "A" ? "B" : "A") + started.challenge.slice(flippedAt + 1);
  assert.equal((await request("/api/practice/submit", { challenge: flipped, answers })).status, 400);
  assert.equal((await request("/api/practice/submit", { challenge: "p1.eyJ2IjoxfQ", answers })).status, 400);
  assert.equal((await request("/api/practice/submit", { challenge: started.challenge, answers, deadline: Date.now() + 86_400_000 })).status, 400);

  const encoder = new TextEncoder();
  const context = encoder.encode("mantu-financial-assessment-practice-v1");
  async function seal(payload, secret) {
    const raw = new Uint8Array(32);
    for (let i = 0; i < raw.length; i++) raw[i] = Number.parseInt(secret.slice(i * 2, i * 2 + 2), 16);
    const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: context }, key, encoder.encode(JSON.stringify(payload)),
    ));
    const combined = new Uint8Array(iv.length + ciphertext.length);
    combined.set(iv);
    combined.set(ciphertext, iv.length);
    let binary = "";
    for (const byte of combined) binary += String.fromCharCode(byte);
    return "p1." + btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  }
  const issuedAt = Date.now();
  const ids = Object.fromEntries(Array.from({ length: 15 }, (_, index) => ["q" + index, ["a", "b", "c", "d"]]));
  const key = Object.fromEntries(Object.keys(ids).map(id => [id, "a"]));
  const extended = await seal({ v: 1, issuedAt, deadline: issuedAt + 16 * 60 * 1000, key, choiceIds: ids }, practiceKey);
  assert.equal((await request("/api/practice/submit", { challenge: extended, answers: {} })).status, 400, "a MAC-valid ticket cannot lengthen its lifetime");
  const otherKey = await seal({
    v: 1, issuedAt, deadline: issuedAt + 15 * 60 * 1000, key, choiceIds: ids,
  }, "c".repeat(64));
  assert.equal((await request("/api/practice/submit", { challenge: otherKey, answers: {} })).status, 400);

  const hiring = fixture();
  const confused = await hiring.req("/api/submit", "POST", { challenge: started.challenge, answers });
  assert.equal(confused.status, 401, "a practice challenge is not a hiring session");
  assert.equal(hiring.records.size, 0);
  const asCookie = await hiring.req("/api/session", "GET", undefined, {
    headers: { Cookie: "__Host-assessment=" + started.challenge },
  });
  assert.equal((await asCookie.json()).attempt, null);
});

test("an unsigned reviewer assertion cannot export an attempt", async () => {
  const env = { ACCESS_ISSUER: "https://test-team.cloudflareaccess.com", ACCESS_AUD: "c".repeat(64) };
  const now = Math.floor(Date.now() / 1000);
  const payload = { type: "app", email: "reviewer@example.invalid", sub: "synthetic", exp: now + 300, iat: now, iss: env.ACCESS_ISSUER, aud: env.ACCESS_AUD };
  const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  const token = encode({ alg: "none", typ: "JWT" }) + "." + encode(payload) + ".";
  const request = new Request("https://assessment.example/api/ops/attempts/" + "ab".repeat(16), {
    headers: { "cf-access-jwt-assertion": token, Origin: origin },
  });
  assert.equal(await authorizeReviewer(request, env), false);
});
