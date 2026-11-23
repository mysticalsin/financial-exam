import test from "node:test";
import assert from "node:assert/strict";
import worker, { Assessment } from "../src/worker.js";

// Keep the fixture synthetic. Each environment has its own fresh storage, random credentials, and clock-independent state.
const origin = "https://assessment.example";
const notice = {
  controller: "Test controller", contact: "privacy@example.invalid", basis: "Test basis",
  recipients: "Test reviewer", transfers: "Test transfer description", rights: "Test rights",
  purpose: "Test purpose", supervisoryAuthority: "Test authority", version: "test-1", retentionMinutes: 30,
};
const random = () => crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");

function fixture() {
  const objects = new Map();
  const records = new Map();
  const limiterKeys = [];
  const env = {
    LIVE_ENABLED: "true", PRIVACY_COUNTRY: "FR", PRIVACY_NOTICE: { ...notice }, OPS_TOKEN: random(),
    ACCESS_ISSUER: "https://synthetic-test.cloudflareaccess.com", ACCESS_AUD: "a".repeat(64), DURATION_MINUTES: 30,
    RATE_LIMITER: { async limit({ key }) { limiterKeys.push(key); return { success: true }; } },
    ASSETS: { async fetch() { return new Response("Test page"); } },
    RECORDS: {
      async get(key) {
        const entry = records.get(key);
        return entry ? { etag: entry.etag, json: async () => structuredClone(entry.record) } : null;
      },
      async put(key, value, opts) {
        const existing = records.get(key);
        if (opts.onlyIf instanceof Headers) {
          assert.equal(opts.onlyIf.get("If-None-Match"), "*");
          if (existing) return null;
        } else if (!existing || opts.onlyIf.etagMatches !== existing.etag) {
          return null;
        }
        const etag = crypto.randomUUID();
        records.set(key, { record: JSON.parse(value), metadata: { ...opts.customMetadata }, etag });
        return { etag };
      },
      async delete(key) { records.delete(key); },
      async list(opts) {
        assert.deepEqual(opts.include, ["customMetadata"]);
        return { objects: [...records].map(([key, r]) => ({ key, customMetadata: r.metadata })), truncated: false };
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
              const storage = {
                alarm: null,
                async deleteAll() { this.alarm = null; },
                async setAlarm(time) { this.alarm = time; },
              };
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
    const r = await req("/api/ops/invites", "POST", { durationMinutes }, admin);
    assert.equal(r.status, 201);
    return r.json();
  }
  async function start(inviteData, claim = random()) {
    const { invite } = inviteData;
    const response = await req("/api/start", "POST", { invite, claim, noticeVersion: notice.version });
    assert.equal(response.status, 200);
    const setCookie = response.headers.get("Set-Cookie");
    assert.match(setCookie, /; Secure; HttpOnly; SameSite=Strict;/);
    return { cookie: setCookie.split(";")[0], claim, ...(await response.json()) };
  }
  return { env, objects, records, limiterKeys, req, issue, start, admin };
}

test("preview has a public config and static assets with security headers; incomplete privacy settings close recruitment", async () => {
  const { req, env, admin } = fixture();
  delete env.PRIVACY_NOTICE.contact;
  const response = await req("/api/config");
  assert.equal((await response.json()).enabled, false);
  assert.equal((await req("/api/ops/invites", "POST", {}, admin)).status, 503);
  assert.equal((await req("/api/session").then(r => r.json())).attempt, null);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  for (const path of ["/", "/review/"]) {
    const { headers } = await req(path);
    assert.match(headers.get("Content-Security-Policy"), /frame-ancestors 'none'/);
    const policy = headers.get("Permissions-Policy");
    assert.match(policy, /camera=\(\)/);
    assert.match(policy, /clipboard-read=\(\)/);
    assert.doesNotMatch(policy, /clipboard-write=\(\)/);
    assert.equal(headers.get("Cross-Origin-Opener-Policy"), "same-origin");
    assert.equal(headers.get("Cross-Origin-Resource-Policy"), "same-origin");
  }
});

test("live hiring stays closed without valid reviewer SSO configuration even when an operator token exists", async () => {
  const { req, env, admin } = fixture();
  delete env.ACCESS_AUD;
  assert.equal((await (await req("/api/config")).json()).enabled, false);
  assert.equal((await req("/api/ops/whoami", "GET", undefined, admin)).status, 200,
    "the CLI operator credential remains available while public recruitment is closed");
  assert.equal((await req("/api/ops/invites", "POST", { durationMinutes: 30 }, admin)).status, 503);
});

test("operator API accepts server credentials, refuses browser bearer fallback, and keeps data operations available during closure", async () => {
  const { env, admin, req, issue } = fixture();
  assert.equal((await req("/api/ops/whoami", "GET", undefined, admin)).status, 200);
  assert.equal((await req("/api/ops/whoami")).status, 403);
  assert.equal((await req("/api/ops/whoami", "GET", undefined, { admin: true, headers: { Origin: origin } })).status, 403);
  const { reference } = await issue();
  env.LIVE_ENABLED = "false";
  const path = "/api/ops/attempts/" + reference;
  assert.equal((await req(path, "GET", undefined, admin)).status, 200);
  assert.equal((await req(path, "DELETE", undefined, admin)).status, 200);
  assert.equal((await req(path, "GET", undefined, admin)).status, 404);
});

test("invitation is single-use, retriable with the same claim, preserves variant and contains no scoring key", async () => {
  const f = fixture();
  const invite = await f.issue(45);
  const inspected = await f.req("/api/invitation", "POST", { invite: invite.invite });
  assert.equal((await inspected.json()).durationMinutes, 45);
  const otherOrigin = { headers: { Origin: "https://other.example" } };
  const params = { invite: invite.invite, claim: random(), noticeVersion: notice.version };
  assert.equal((await f.req("/api/start", "POST", params, otherOrigin)).status, 403);
  assert.equal((await f.req("/api/start", "POST", { ...params, noticeVersion: "old" })).status, 409);
  const [a, b] = await Promise.all([f.start(invite, params.claim), f.start(invite, params.claim)]);
  assert.deepEqual(a.attempt, b.attempt);
  assert.equal(a.cookie, b.cookie);
  assert.equal(a.attempt.deadline - a.attempt.startedAt, 45 * 60000);
  assert.equal(a.attempt.questions.length, 15);
  assert.equal(JSON.stringify(a.attempt).includes('"key":'), false);
  assert.equal(JSON.stringify(a.attempt).includes('"correct":'), false);
  assert.equal(JSON.stringify(a.attempt).includes('"notes"'), false);
  assert.equal(JSON.stringify(a.attempt).includes('"bankIds"'), false);
  assert.equal(JSON.stringify(a.attempt).includes("Good answer:"), false);
  assert.equal((await f.req("/api/start", "POST", { ...params, claim: random() })).status, 403);
  assert.equal((await f.req("/api/session", "GET", undefined, { cookie: a.cookie })).status, 400,
    "a cookie alone cannot select a candidate record");
  assert.equal((await f.req("/api/session", "GET", undefined, { cookie: a.cookie, reference: "f".repeat(32) })).status, 409,
    "a mismatched tab reference cannot inspect the cookie owner’s record");
  assert.deepEqual((await (await f.req("/api/session", "GET", undefined,
    { cookie: a.cookie, reference: invite.reference })).json()).attempt, a.attempt);
  const obj = f.objects.get(invite.reference);
  const stored = f.records.get(invite.reference).record;
  const record = JSON.stringify(stored);
  assert.equal(record.includes(a.cookie.split(".")[1]), false);
  assert.equal(record.includes(params.claim), false);
  assert.equal(record.includes(invite.invite.split(".")[1]), false);
  assert.equal(obj.ctx.storage.alarm, stored.issuedAt + 60 * 60000);
  assert.equal(stored.purgeAt, a.attempt.purgeAt);
});

test("only the owner can save, with revision checks, bounded choices, clearing and safe retries", async () => {
  const f = fixture();
  const a = await f.start(await f.issue());
  const b = await f.start(await f.issue());
  const question = a.attempt.questions[0];
  const mutation = { questionId: question.id, choices: [question.options[0].id], revision: a.attempt.revision };
  const save = (data, cookie = a.cookie) => f.req("/api/answers", "PUT", data, { cookie });
  assert.equal((await save({ ...mutation, reference: a.attempt.reference }, b.cookie)).status, 409);
  assert.equal((await save(mutation)).status, 409, "answer writes require an explicit matching reference");
  assert.equal((await save({ ...mutation, reference: a.attempt.reference, choices: ["unassigned"] })).status, 422);
  assert.equal((await save({ ...mutation, reference: a.attempt.reference, choices: [mutation.choices[0], mutation.choices[0]] })).status, 422);
  assert.equal((await save({ ...mutation, reference: b.attempt.reference })).status, 409);
  assert.equal((await f.req("/api/submit", "POST", { revision: a.attempt.revision }, { cookie: a.cookie })).status, 409);
  const scopedMutation = { ...mutation, reference: a.attempt.reference };
  const saved = await (await save(scopedMutation)).json();
  assert.equal(saved.attempt.revision, a.attempt.revision + 1);
  const repeat = await (await save(scopedMutation)).json();
  assert.deepEqual(repeat.attempt, saved.attempt);
  assert.equal((await save({ ...scopedMutation, choices: [question.options[1].id] })).status, 409);
  const cleared = await (await save({ ...scopedMutation, choices: [], revision: saved.attempt.revision })).json();
  assert.equal(cleared.attempt.answers[question.id], undefined);
  assert.equal(cleared.attempt.answered, 0);
});

test("server computes score once and exports human-readable results, with no score in candidate receipt", async () => {
  const f = fixture();
  const invite = await f.issue();
  const a = await f.start(invite);
  let revision = a.attempt.revision;
  const key = f.records.get(invite.reference).record.paper.key;
  for (const question of a.attempt.questions) {
    const reply = await f.req("/api/answers", "PUT",
      { reference: invite.reference, questionId: question.id, choices: key[question.id], revision }, { cookie: a.cookie });
    assert.equal(reply.status, 200);
    revision = (await reply.json()).attempt.revision;
  }
  const submit = () => f.req("/api/submit", "POST", { reference: invite.reference, revision }, { cookie: a.cookie });
  const final = (await (await submit()).json()).attempt;
  assert.equal(final.status, "submitted");
  assert.equal(final.answered, 15);
  assert.equal(final.purgeAt, final.submittedAt + 30 * 60000);
  assert.equal(final.score, undefined);
  assert.deepEqual(final.questions, []);
  assert.deepEqual((await (await submit()).json()).attempt, final);
  const question = a.attempt.questions[0];
  const closed = await f.req("/api/answers", "PUT", { reference: invite.reference, questionId: question.id, choices: [], revision: final.revision }, { cookie: a.cookie });
  assert.equal(closed.status, 409);
  const exportPath = "/api/ops/attempts/" + invite.reference;
  const result = await (await f.req(exportPath, "GET", undefined, f.admin)).json();
  assert.equal(result.score, 15);
  assert.equal(Object.hasOwn(result, "copiedQuestionCount"), false);
  assert.equal(result.responses.length, 15);
  assert.equal(result.responses.every(r => r.selected[0] === r.expected[0]), true);
  assert.equal(result.notice.version, notice.version);
  assert.equal(result.inviteHash, undefined);
  await f.req(exportPath, "DELETE", undefined, f.admin);
  assert.equal((await (await f.req("/api/session", "GET", undefined, { cookie: a.cookie, reference: invite.reference })).json()).attempt, null);
});

test("absolute deadline closes edits and retains saved work; read-time expiry and alarm independently erase", async () => {
  const f = fixture();
  const inv = await f.issue();
  const a = await f.start(inv);
  f.records.get(inv.reference).record.deadline = Date.now() - 1;
  const q = a.attempt.questions[0];
  const data = { reference: inv.reference, questionId: q.id, choices: [q.options[0].id], revision: a.attempt.revision };
  assert.equal((await f.req("/api/answers", "PUT", data, { cookie: a.cookie })).status, 409);
  const closed = await (await f.req("/api/session", "GET", undefined, { cookie: a.cookie, reference: inv.reference })).json();
  assert.equal(closed.attempt.status, "expired");
  assert.deepEqual(closed.attempt.questions, []);
  f.records.get(inv.reference).record.purgeAt = Date.now() - 1;
  const purged = await (await f.req("/api/session", "GET", undefined,
    { cookie: a.cookie, reference: inv.reference })).json();
  assert.equal(purged.attempt, null);
  assert.equal(f.records.has(inv.reference), false);
  const unused = await f.issue();
  const second = f.objects.get(unused.reference);
  f.records.get(unused.reference).record.purgeAt = Date.now() - 1;
  await second.alarm();
  assert.equal(f.records.has(unused.reference), false);
  assert.equal(second.ctx.storage.alarm, null);
});

test("limiter rejects and handles only digests; unknown fields and oversized bodies stop before storage", async () => {
  const f = fixture();
  const context = { admin: true, headers: { "CF-Connecting-IP": "192.0.2.10" } };
  assert.equal((await f.req("/api/ops/invites", "POST", { fullName: "test" }, context)).status, 400);
  assert.equal((await f.req("/api/ops/invites", "POST", { unknown: "x".repeat(3000) }, context)).status, 413);
  assert.equal(f.limiterKeys.every(k => /^[0-9a-f]{64}$/.test(k)), true);
  f.env.RATE_LIMITER.limit = async () => ({ success: false });
  assert.equal((await f.req("/api/ops/invites", "POST", {}, context)).status, 429);
  assert.equal(f.objects.size, 0);
});

test("country profiles require explicit selection with multiple countries; selected notice travels with the attempt", async () => {
  const f = fixture();
  f.env.NOTICE_PROFILES = { FR: notice, IT: { ...notice, version: "italy-v2", basis: "Local basis" } };
  const cfg = await (await f.req("/api/config")).json();
  assert.deepEqual(cfg.countries, ["FR", "IT"]);
  assert.equal(cfg.notice, null);
  const issue = data => f.req("/api/ops/invites", "POST", data, f.admin);
  assert.equal((await issue({ durationMinutes: 15 })).status, 422);
  assert.equal((await issue({ country: "XX" })).status, 422);
  assert.equal((await issue({ country: "FR", durationMinutes: 56 })).status, 422);
  const it = await (await issue({ country: "IT", durationMinutes: 55 })).json();
  assert.equal(it.hardEnd - it.expiresAt, 55 * 60000);
  const inspect = await (await f.req("/api/invitation", "POST", { invite: it.invite })).json();
  assert.equal(inspect.notice.version, "italy-v2");
  assert.equal(inspect.country, "IT");
  const request = { invite: it.invite, claim: random(), noticeVersion: notice.version };
  assert.equal((await f.req("/api/start", "POST", request)).status, 409);
  const result = await (await f.req("/api/start", "POST", { ...request, noticeVersion: inspect.notice.version })).json();
  assert.equal(result.attempt.notice.basis, "Local basis");
  assert.equal(result.attempt.purgeAt, it.hardEnd);
  assert.equal(result.attempt.country, "IT");
});

test("a late alarm or a stale list cannot revive or prematurely erase a live attempt; sweep reads every page", async () => {
  const f = fixture();
  const live = await f.issue();
  const overdue = await f.issue();
  const active = await f.start(live);
  const tracked = f.records.get(active.attempt.reference);
  // An earlier list may race a successful claim and retain the stale invitation expiry.
  const listed = [live.reference, overdue.reference];
  tracked.metadata.purgeAt = "1";
  const expired = f.records.get(overdue.reference);
  expired.record.purgeAt = 1;
  expired.metadata.purgeAt = "1";
  const cursors = [];
  f.env.RECORDS.list = async ({ cursor }) => {
    cursors.push(cursor);
    const i = cursor ? 1 : 0;
    return { objects: [{ key: listed[i], customMetadata: { purgeAt: "1" } }],
      truncated: !cursor, cursor: cursor ? undefined : "next" };
  };
  await worker.scheduled({}, f.env);
  assert.deepEqual(cursors, [undefined, "next"]);
  assert.equal(f.records.has(live.reference), true);
  assert.equal(f.records.has(overdue.reference), false);
  assert.equal(f.objects.get(overdue.reference).ctx.storage.alarm, null);
});

test("an R2 write starts only after cleanup scheduling succeeds and storage faults do not issue invitations", async () => {
  const f = fixture();
  const original = f.env.ATTEMPTS.jurisdiction.bind(f.env.ATTEMPTS);
  f.env.ATTEMPTS.jurisdiction = name => {
    const namespace = original(name);
    return { ...namespace, get(id) {
      const object = namespace.get(id);
      object.ctx.storage.setAlarm = async () => { throw new Error("simulated storage fault"); };
      return object;
    } };
  };
  const failed = await f.req("/api/ops/invites", "POST", {}, f.admin);
  assert.equal(failed.status, 503);
  assert.equal(f.records.size, 0);
  assert.equal((await failed.json()).error.includes("simulated"), false);
});

test("an inconclusive R2 save cannot resurrect an erased attempt when its write eventually completes", async () => {
  const f = fixture();
  const invite = await f.issue();
  const { attempt, cookie } = await f.start(invite);
  const put = f.env.RECORDS.put.bind(f.env.RECORDS);
  let delayed;
  f.env.RECORDS.put = async (...args) => {
    delayed = args;
    throw new Error("simulated ambiguous upstream result");
  };
  const q = attempt.questions[0];
  const save = await f.req("/api/answers", "PUT",
    { reference: invite.reference, questionId: q.id, choices: [q.options[0].id], revision: attempt.revision }, { cookie });
  assert.equal(save.status, 503);
  assert.equal((await f.req("/api/ops/attempts/" + invite.reference, "DELETE", undefined, f.admin)).status, 200);
  assert.equal(await put(...delayed), null);
  assert.equal(f.records.has(invite.reference), false);
});

test("an explicit invitation reveals an existing attempt only with both matching proofs on a shared browser", async () => {
  const f = fixture();
  const first = await f.issue();
  const second = await f.issue();
  const a = await f.start(first);
  const inspect = (invite, cookie) => f.req("/api/invitation", "POST", { invite }, { cookie });
  const own = await (await inspect(first.invite, a.cookie)).json();
  assert.equal(own.resume, true);
  assert.deepEqual(own.attempt, a.attempt);
  const newInvite = await (await inspect(second.invite, a.cookie)).json();
  assert.equal(newInvite.resume, false);
  assert.equal(newInvite.anotherActiveSession, true);
  assert.equal(newInvite.attempt, undefined);
  assert.equal((await inspect(first.invite, "")).status, 403);
  const invalid = first.reference + "." + random();
  assert.equal((await inspect(invalid, a.cookie)).status, 403);
  const start = await f.req("/api/start", "POST", { invite: second.invite, noticeVersion: notice.version, claim: random() }, { cookie: a.cookie });
  assert.equal(start.status, 409);
  assert.equal((await f.req("/api/session", "GET", undefined,
    { cookie: a.cookie, reference: first.reference }).then(r => r.json())).attempt.reference, first.reference);
});

test("an operator receives progress but no options, prompts, or grading key during an active assessment", async () => {
  const f = fixture();
  const issued = await f.issue();
  await f.start(issued);
  const result = await (await f.req("/api/ops/attempts/" + issued.reference, "GET", undefined, f.admin)).json();
  assert.equal(result.status, "active");
  assert.equal(result.answered, 0);
  assert.equal(result.total, 15);
  assert.equal(result.responses, undefined);
  assert.equal(result.paper, undefined);
  assert.equal(result.score, null);
});

test("copy shortcut review defaults off, requires matching country acknowledgment, and cannot be added to an existing attempt", async () => {
  const f = fixture();
  const first = await f.issue();
  const disabled = await f.start(first);
  const signal = { reference: first.reference, questionId: disabled.attempt.questions[0].id };
  assert.equal(disabled.attempt.notice.copyShortcutReview, undefined);
  const inspection = async invite => (await f.req("/api/invitation", "POST", { invite })).json();
  const other = await f.issue();
  const start = { invite: other.invite, claim: random(), noticeVersion: notice.version };
  const sendStart = data => f.req("/api/start", "POST", data);
  assert.equal((await sendStart({ ...start, copyShortcutReview: true })).status, 409);
  assert.equal(f.records.get(other.reference).record.status, "invited");
  f.env.PRIVACY_NOTICE.copyShortcutReview = true;
  assert.equal((await inspection(other.invite)).notice.copyShortcutReview, true);
  assert.equal((await f.req("/api/integrity", "PUT", signal, { cookie: disabled.cookie })).status, 403);
  for (const value of [undefined, false, "true"]) {
    assert.equal((await sendStart({ ...start, copyShortcutReview: value })).status, 409);
    assert.equal(f.records.get(other.reference).record.status, "invited");
  }
  const accepted = await sendStart({ ...start, copyShortcutReview: true });
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).attempt.notice.copyShortcutReview, true);
});

async function startWithShortcutReview(f) {
  f.env.PRIVACY_NOTICE.copyShortcutReview = true;
  const issued = await f.issue();
  const start = await f.req("/api/start", "POST", {
    invite: issued.invite, claim: random(), noticeVersion: notice.version, copyShortcutReview: true,
  });
  assert.equal(start.status, 200);
  const { attempt } = await start.json();
  const cookie = start.headers.get("Set-Cookie").split(";")[0];
  const report = (fields, opts = { cookie }) => f.req("/api/integrity", "PUT", fields, opts);
  return { ...issued, cookie, attempt, report };
}

test("an active user can report each assigned question once without changing answers, revision, or retention", async () => {
  const f = fixture();
  const { reference, cookie, attempt, report } = await startWithShortcutReview(f);
  const q = attempt.questions[0];
  const signal = { reference, questionId: q.id };
  const stored = () => f.records.get(reference);
  const before = stored();
  assert.equal((await report(signal, {})).status, 401);
  const unknownCookie = cookie.split(".")[0] + "." + random();
  assert.equal((await report(signal, { cookie: unknownCookie })).status, 401);
  assert.equal((await report(signal, { cookie, headers: { Origin: "https://other.example" } })).status, 403);
  assert.equal((await report({ ...signal, reference: "f".repeat(32) })).status, 409);
  assert.equal((await report({ ...signal, questionId: "unassigned" })).status, 422);
  for (const extra of ["text", "timestamp", "key", "choices"]) {
    assert.equal((await report({ ...signal, [extra]: "unused" })).status, 400);
  }
  assert.deepEqual(stored(), before);
  f.limiterKeys.length = 0;
  assert.equal((await report(signal)).status, 200);
  const integrityKeys = [...f.limiterKeys];
  const first = stored();
  assert.equal(first.record.revision, before.record.revision);
  assert.equal(first.record.purgeAt, before.record.purgeAt);
  assert.deepEqual(first.record.answers, before.record.answers);
  assert.deepEqual(first.record.copiedQuestionIds, [q.id]);
  assert.equal((await report(signal)).status, 200);
  assert.equal(stored().etag, first.etag, "duplicate reports perform no write");
  f.limiterKeys.length = 0;
  const keys = new Set(integrityKeys);
  f.env.RATE_LIMITER.limit = async ({ key }) => ({ success: !keys.has(key) });
  assert.equal((await report(signal)).status, 429);
  const save = await f.req("/api/answers", "PUT", { ...signal, choices: [q.options[0].id], revision: attempt.revision }, { cookie });
  assert.equal(save.status, 200);
  assert.equal((await save.json()).attempt.copiedQuestionIds, undefined);
  const review = await (await f.req("/api/ops/attempts/" + reference, "GET", undefined, f.admin)).json();
  assert.equal(review.copiedQuestionCount, undefined);
  assert.equal(review.copiedQuestionIds, undefined);
});

test("submission compacts question IDs to a reviewer-only count and leaves grading unchanged", async () => {
  const f = fixture();
  const { reference, cookie, attempt, report } = await startWithShortcutReview(f);
  let revision = attempt.revision;
  for (const q of attempt.questions) {
    const result = await f.req("/api/answers", "PUT", {
      reference, questionId: q.id, choices: f.records.get(reference).record.paper.key[q.id], revision,
    }, { cookie });
    revision = (await result.json()).attempt.revision;
  }
  const signal = { reference, questionId: attempt.questions[0].id };
  for (const q of attempt.questions.slice(0, 2)) assert.equal((await report({ reference, questionId: q.id })).status, 200);
  const submitted = await f.req("/api/submit", "POST", { reference, revision }, { cookie });
  assert.equal(submitted.status, 200);
  assert.equal((await submitted.json()).attempt.copiedQuestionCount, undefined);
  assert.equal((await report(signal)).status, 409);
  const persisted = f.records.get(reference).record;
  assert.equal(persisted.copiedQuestionCount, 2);
  assert.equal(persisted.copiedQuestionIds, undefined);
  const review = await (await f.req("/api/ops/attempts/" + reference, "GET", undefined, f.admin)).json();
  assert.equal(review.copiedQuestionCount, 2);
  assert.equal(review.copiedQuestionIds, undefined);
  assert.equal(review.score, 15);
});

test("the deadline alarm compacts approved IDs with no user request and discards late signals", async () => {
  const f = fixture();
  const { reference, attempt, report } = await startWithShortcutReview(f);
  const obj = f.objects.get(reference);
  assert.equal(obj.ctx.storage.alarm, attempt.deadline);
  assert.equal((await report({ reference, questionId: attempt.questions[0].id })).status, 200);
  f.records.get(reference).record.deadline = Date.now() - 1;
  await obj.alarm();
  const expired = f.records.get(reference).record;
  assert.equal(expired.status, "expired");
  assert.equal(expired.copiedQuestionIds, undefined);
  assert.equal(expired.copiedQuestionCount, 1);
  assert.equal(obj.ctx.storage.alarm, attempt.purgeAt);
  assert.equal((await report({ reference, questionId: attempt.questions[1].id })).status, 409);
  const review = await (await f.req("/api/ops/attempts/" + reference, "GET", undefined, f.admin)).json();
  assert.equal(review.copiedQuestionCount, 1);
});

test("the cleanup sweep recovers a missed deadline alarm and reports zero for an approved assessment with no signals", async () => {
  const f = fixture();
  const { reference } = await startWithShortcutReview(f);
  const active = f.records.get(reference);
  active.record.deadline = Date.now() - 1;
  active.metadata.compactAt = String(active.record.deadline);
  await worker.scheduled({}, f.env);
  const record = f.records.get(reference);
  assert.equal(record.record.status, "expired");
  assert.equal(record.record.copiedQuestionCount, 0);
  assert.equal(record.metadata.compactAt, undefined);
  assert.equal(f.objects.get(reference).ctx.storage.alarm, record.record.purgeAt);
});

test("expanded integrity notice supersedes the legacy flag and start/retry acknowledgment uses the attempt snapshot", async () => {
  const f = fixture();
  const legacy = await startWithShortcutReview(f);
  f.env.PRIVACY_NOTICE.integrityReview = true;
  const issued = await f.issue();
  const details = await (await f.req("/api/invitation", "POST", { invite: issued.invite })).json();
  assert.equal(details.notice.integrityReview, true);
  assert.equal(Object.hasOwn(details.notice, "copyShortcutReview"), false);
  const args = { invite: issued.invite, claim: random(), noticeVersion: notice.version };
  const start = flags => f.req("/api/start", "POST", { ...args, ...flags });
  for (const flags of [{}, { copyShortcutReview: true }, { integrityReview: false },
    { integrityReview: "true" }, { integrityReview: true, copyShortcutReview: true }]) {
    assert.equal((await start(flags)).status, 409);
  }
  const accepted = await start({ integrityReview: true });
  assert.equal(accepted.status, 200);
  const { attempt } = await accepted.json();
  assert.equal(attempt.notice.integrityReview, true);
  delete f.env.PRIVACY_NOTICE.integrityReview;
  assert.equal((await start({ copyShortcutReview: true })).status, 409);
  assert.equal((await start({ integrityReview: true })).status, 200);
  assert.equal(f.records.get(legacy.reference).record.notice.integrityReview, undefined);
  const legacySignal = { reference: legacy.reference, questionId: legacy.attempt.questions[0].id };
  assert.equal((await legacy.report(legacySignal)).status, 200);
});

async function startWithExpandedReview(f) {
  f.env.PRIVACY_NOTICE.integrityReview = true;
  const { reference, invite } = await f.issue();
  const started = await f.req("/api/start", "POST", { invite, claim: random(), noticeVersion: notice.version, integrityReview: true });
  assert.equal(started.status, 200);
  const cookie = started.headers.get("Set-Cookie").split(";")[0];
  const { attempt } = await started.json();
  const signal = (data, opts = { cookie }) => f.req("/api/integrity", "PUT", { reference, ...data }, opts);
  const answer = (questionId, choices, revision = attempt.revision, opts = { cookie }) =>
    f.req("/api/answers", "PUT", { reference, questionId, choices, revision }, opts);
  const review = () => f.req("/api/ops/attempts/" + reference, "GET", undefined, f.admin).then(r => r.json());
  const stored = () => f.records.get(reference);
  return { reference, cookie, attempt, signal, answer, review, stored };
}

test("four expanded integrity categories have separate deduplication, strict scope and a closed-only summary", async () => {
  const f = fixture();
  const { reference, cookie, attempt, signal, answer, stored, review } = await startWithExpandedReview(f);
  const q = attempt.questions[0];
  const q2 = attempt.questions[1];
  const initial = stored();
  const event = { questionId: q.id, kind: "copy" };
  for (const kind of [undefined, "rejectedAnswer", "unknown", "toString"]) assert.equal((await signal({ ...event, kind })).status, 422);
  for (const key of ["timestamp", "url", "text", "choices", "key"]) assert.equal((await signal({ ...event, [key]: "unused" })).status, 400);
  assert.equal((await signal({ ...event, questionId: "unassigned" })).status, 422);
  assert.equal((await signal({ ...event, reference: "f".repeat(32) })).status, 409);
  assert.equal((await signal(event, { cookie, headers: { Origin: "https://other.example" } })).status, 403);
  assert.equal((await signal(event, {})).status, 401);
  assert.deepEqual(stored(), initial);
  for (const question of attempt.questions) {
    assert.equal((await signal({ questionId: question.id, kind: "copy" })).status, 200);
    const wrote = stored().etag;
    assert.equal((await signal({ questionId: question.id, kind: "copy" })).status, 200);
    assert.equal(stored().etag, wrote);
  }
  for (const question of [q, q2]) assert.equal((await signal({ questionId: question.id, kind: "contextMenu" })).status, 200);
  assert.equal((await signal({ questionId: q2.id, kind: "pageHidden" })).status, 200);
  const unassigned = crypto.randomUUID();
  const untouched = stored().etag;
  assert.equal((await answer(q.id, [unassigned], attempt.revision + 1)).status, 422);
  assert.equal((await answer(q.id, ["invalid-choice"])).status, 422);
  assert.equal((await answer(q.id, [unassigned, unassigned])).status, 422);
  assert.equal((await answer("another-question", [unassigned])).status, 422);
  assert.equal((await answer(q.id, [unassigned], attempt.revision, {})).status, 401);
  assert.equal(stored().etag, untouched);
  assert.equal((await answer(q.id, [unassigned])).status, 422);
  const observed = stored();
  assert.equal((await answer(q.id, [unassigned])).status, 422);
  assert.equal(stored().etag, observed.etag);
  assert.equal(JSON.stringify(observed).includes(unassigned), false);
  assert.equal(observed.record.revision, initial.record.revision);
  assert.deepEqual(observed.record.answers, initial.record.answers);
  assert.equal(observed.record.purgeAt, initial.record.purgeAt);
  assert.equal((await review()).integritySummary, undefined);
  const current = await (await f.req("/api/session", "GET", undefined, { reference, cookie })).json();
  assert.equal(current.attempt.integritySummary, undefined);
  assert.equal(current.attempt.integrityMasks, undefined);
  let revision = attempt.revision;
  for (const question of attempt.questions) {
    const saved = await answer(question.id, initial.record.paper.key[question.id], revision);
    assert.equal(saved.status, 200);
    revision = (await saved.json()).attempt.revision;
  }
  const submit = () => f.req("/api/submit", "POST", { reference, revision }, { cookie });
  const final = (await (await submit()).json()).attempt;
  assert.equal(final.integritySummary, undefined);
  assert.equal((await submit()).status, 200);
  assert.equal((await signal(event)).status, 409);
  const result = await review();
  assert.deepEqual(result.integritySummary, { copy: 15, contextMenu: 2, pageHidden: 1, rejectedAnswer: 1 });
  assert.equal(result.score, 15);
  assert.equal(stored().record.integrityMasks, undefined);
  assert.equal(result.integrityMasks, undefined);
  assert.equal(result.copiedQuestionCount, undefined);
  assert.equal((await f.req("/api/ops/attempts/" + reference, "DELETE", undefined, f.admin)).status, 200);
  assert.equal(stored(), undefined);
});

test("new-mode expiry compacts to four counters and retains the existing final purge", async () => {
  const f = fixture();
  const { attempt, reference, signal, stored, review } = await startWithExpandedReview(f);
  const object = f.objects.get(reference);
  const event = { questionId: attempt.questions[0].id, kind: "pageHidden" };
  assert.equal(object.ctx.storage.alarm, attempt.deadline);
  assert.equal((await signal(event)).status, 200);
  stored().record.deadline = Date.now() - 1;
  await object.alarm();
  assert.deepEqual((await review()).integritySummary, { copy: 0, contextMenu: 0, pageHidden: 1, rejectedAnswer: 0 });
  assert.equal((await signal(event)).status, 409);
  assert.equal(stored().record.integrityMasks, undefined);
  assert.equal(object.ctx.storage.alarm, attempt.purgeAt);
  stored().record.purgeAt = Date.now() - 1;
  await object.alarm();
  assert.equal(stored(), undefined);
});

test("legacy and disabled attempts never collect expanded observations, including after operator enables them", async () => {
  const f = fixture();
  const disabled = await f.start(await f.issue());
  const legacy = await startWithShortcutReview(f);
  f.env.PRIVACY_NOTICE.integrityReview = true;
  for (const [session, expectedCode] of [[disabled, 403], [legacy, 400]]) {
    const { attempt, cookie } = session;
    const { reference, revision } = attempt;
    const questionId = attempt.questions[0].id;
    const before = f.records.get(reference).etag;
    assert.equal((await f.req("/api/integrity", "PUT", { reference, questionId, kind: "pageHidden" }, { cookie })).status, expectedCode);
    assert.equal((await f.req("/api/answers", "PUT", { reference, revision, questionId, choices: [crypto.randomUUID()] }, { cookie })).status, 422);
    assert.equal(f.records.get(reference).etag, before);
    assert.equal(f.records.get(reference).record.integrityMasks, undefined);
  }
});
