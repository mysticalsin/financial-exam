import test from "node:test";
import assert from "node:assert/strict";
import worker, { Assessment } from "../src/worker.js";
import { grade } from "../src/bank.js";

// Invariants of this repository's Worker. A hiring sitting uses the duration stored
// on that invitation. Nothing here describes a deployed Worker.

const origin = "https://assessment.example";
const notice = {
  controller: "Test controller", contact: "privacy@example.invalid", basis: "Test basis",
  recipients: "Test reviewer", transfers: "Test transfer description", rights: "Test rights",
  purpose: "Test purpose", supervisoryAuthority: "Test authority", version: "test-1", retentionMinutes: 30,
};
const MINUTE = 60_000;
const random = () => crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");

function fixture() {
  const objects = new Map();
  const records = new Map();
  const env = {
    LIVE_ENABLED: "true", PRIVACY_COUNTRY: "FR", PRIVACY_NOTICE: { ...notice }, OPS_TOKEN: random(),
    ACCESS_ISSUER: "https://synthetic-test.cloudflareaccess.com", ACCESS_AUD: "a".repeat(64),
    DURATION_MINUTES: 30, INVITE_TTL_MINUTES: 30,
    RATE_LIMITER: { async limit() { return { success: true }; } },
    ASSETS: { async fetch() { return new Response("Test page", { status: 200 }); } },
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
        return {
          objects: [...records].map(([key, entry]) => ({ key, customMetadata: entry.metadata })),
          truncated: false,
        };
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
    if (!admin && method !== "GET" && method !== "HEAD" && !("Origin" in init.headers)) init.headers.Origin = origin;
    if (admin) init.headers.Authorization = "Bearer " + env.OPS_TOKEN;
    if (cookie) init.headers.Cookie = cookie;
    if (data !== undefined) {
      init.headers["Content-Type"] ??= "application/json";
      init.body = typeof data === "string" ? data : JSON.stringify(data);
    }
    return worker.fetch(new Request(origin + path, init), env);
  }
  const admin = { admin: true };
  async function issue(durationMinutes = 30, extra = {}) {
    const response = await req("/api/ops/invites", "POST", { durationMinutes, ...extra }, admin);
    assert.equal(response.status, 201, await response.clone().text());
    return response.json();
  }
  async function start(invite, extra = {}) {
    const response = await req("/api/start", "POST", {
      invite: invite.invite, claim: random(), noticeVersion: notice.version, ...extra,
    });
    assert.equal(response.status, 200, await response.clone().text());
    const setCookie = response.headers.get("Set-Cookie");
    return { cookie: setCookie.split(";")[0], setCookie, ...(await response.json()) };
  }
  return { env, objects, records, req, issue, start, admin };
}

async function read(response) {
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: response.status, body, headers: response.headers, text };
}

function stored(f, reference) {
  return f.records.get(reference).record;
}

test("recruitment opens only for a string true flag, complete bindings, and approved 30-minute notices", async () => {
  const closedFlags = [true, "TRUE", "1", "yes", ""];
  for (const flag of closedFlags) {
    const f = fixture();
    f.env.LIVE_ENABLED = flag;
    const cfg = await read(await f.req("/api/config"));
    assert.equal(cfg.body.enabled, false, `LIVE_ENABLED ${JSON.stringify(flag)} stays closed`);
    assert.equal((await f.req("/api/ops/invites", "POST", {}, f.admin)).status, 503);
    assert.equal(f.records.size, 0);
  }

  for (const binding of ["RATE_LIMITER", "ATTEMPTS", "RECORDS"]) {
    const f = fixture();
    delete f.env[binding];
    assert.equal((await read(await f.req("/api/config"))).body.enabled, false, binding);
    assert.equal((await f.req("/api/ops/invites", "POST", {}, f.admin)).status, 503, binding);
    assert.equal(f.records.size, 0, binding);
  }
  const limiterDown = fixture();
  delete limiterDown.env.RATE_LIMITER;
  assert.equal((await limiterDown.req("/api/ops/whoami", "GET", undefined, limiterDown.admin)).status, 503);
  const attemptsDown = fixture();
  delete attemptsDown.env.ATTEMPTS;
  assert.equal((await attemptsDown.req("/api/ops/whoami", "GET", undefined, attemptsDown.admin)).status, 200);

  for (const duration of [4, 56, 0, 15.5, "30m", -3]) {
    const f = fixture();
    f.env.DURATION_MINUTES = duration;
    const cfg = await read(await f.req("/api/config"));
    assert.equal(cfg.body.enabled, false, `duration setting ${JSON.stringify(duration)} closes recruitment`);
    assert.equal((await f.req("/api/ops/invites", "POST", {}, f.admin)).status, 503);
    assert.equal(f.records.size, 0);
  }

  const dropped = [
    ["retention 29", { retentionMinutes: 29 }],
    ["retention string", { retentionMinutes: "30" }],
    ["lowercase country", { country: "fr" }],
    ["three-letter country", { country: "FRA" }],
    ["blank purpose", { purpose: " \n " }],
    ["numeric purpose", { purpose: 12 }],
  ];
  for (const [label, patch] of dropped) {
    const f = fixture();
    if (patch.country) f.env.PRIVACY_COUNTRY = patch.country;
    f.env.PRIVACY_NOTICE = { ...notice, ...patch };
    delete f.env.PRIVACY_NOTICE.country;
    assert.equal((await read(await f.req("/api/config"))).body.enabled, false, label);
    assert.equal(f.records.size, 0, label);
  }

  const profiles = fixture();
  delete profiles.env.PRIVACY_NOTICE;
  delete profiles.env.PRIVACY_COUNTRY;
  profiles.env.NOTICE_PROFILES = JSON.stringify({
    IT: { ...notice, version: "it-1", purpose: "  Italian purpose  " },
    FR: { ...notice, purpose: "  Test purpose  ", leak: "notice-secret", integrityReview: true, copyShortcutReview: true },
    fr: { ...notice },
    ES: { ...notice, retentionMinutes: 29 },
    DE: { ...notice, purpose: " " },
  });
  const cfg = await read(await profiles.req("/api/config"));
  assert.equal(cfg.body.enabled, true);
  assert.deepEqual(cfg.body.countries, ["FR", "IT"]);
  assert.equal(cfg.body.notice, null);
  assert.equal(cfg.text.includes("notice-secret"), false);
  assert.equal(cfg.body.durationMinutes, 30);
  const french = await profiles.issue(40, { country: "FR" });
  assert.equal(french.durationMinutes, 40);
  assert.equal(french.country, "FR");
  const inspected = await read(await profiles.req("/api/invitation", "POST", { invite: french.invite }));
  assert.equal(inspected.body.notice.purpose, "Test purpose");
  assert.equal(inspected.body.notice.integrityReview, true);
  assert.equal(Object.hasOwn(inspected.body.notice, "copyShortcutReview"), false);
  assert.equal(Object.hasOwn(inspected.body.notice, "leak"), false);
  assert.equal(inspected.body.notice.retentionMinutes, 30);
  assert.equal(inspected.body.durationMinutes, 40);
});

test("the operator bearer is exact, at least 32 characters, and is not accepted from a browser signal", async () => {
  const f = fixture();
  f.env.LIVE_ENABLED = "false";
  f.env.OPS_TOKEN = "a".repeat(31);
  const shortToken = await read(await f.req("/api/ops/whoami", "GET", undefined, f.admin));
  assert.equal(shortToken.status, 403);
  assert.match(shortToken.body.error, /Operator access required/);
  assert.equal(shortToken.text.includes("a".repeat(31)), false);

  f.env.OPS_TOKEN = "b".repeat(32);
  assert.equal((await f.req("/api/ops/whoami", "GET", undefined, f.admin)).status, 200);
  for (const authorization of [
    "Bearer " + "b".repeat(31) + "c",
    "bearer " + "b".repeat(32),
    "b".repeat(32),
    "",
  ]) {
    const rejected = await read(await f.req("/api/ops/whoami", "GET", undefined, {
      headers: { Authorization: authorization },
    }));
    assert.equal(rejected.status, 403, JSON.stringify(authorization));
    assert.equal(rejected.text.includes(f.env.OPS_TOKEN), false);
  }
  f.env.OPS_TOKEN = 10 ** 20;
  assert.equal((await f.req("/api/ops/whoami", "GET", undefined, { headers: { Authorization: "Bearer 100000000000000000000" } })).status, 403);

  f.env.OPS_TOKEN = "c".repeat(32);
  f.env.LIVE_ENABLED = "true";
  const bearer = { headers: { Authorization: "Bearer " + f.env.OPS_TOKEN } };
  assert.equal((await f.req("/api/ops/whoami", "GET", undefined, bearer)).status, 200);
  assert.equal((await f.req("/api/ops/whoami", "GET", undefined, {
    headers: { ...bearer.headers, "Sec-Fetch-Site": "same-origin" },
  })).status, 403);
  assert.equal((await f.req("/api/ops/whoami", "GET", undefined, {
    headers: { ...bearer.headers, "Cf-Access-Jwt-Assertion": "not-a-reviewer" },
  })).status, 403);
  const who = await read(await f.req("/api/ops/whoami", "GET", undefined, bearer));
  assert.deepEqual(who.body, { authorized: true });
  assert.equal(who.text.includes(f.env.OPS_TOKEN), false);
});

test("a start that cannot finish before the hard end mints nothing and leaves the invitation usable", async () => {
  const f = fixture();
  const invite = await f.issue(30);
  const record = stored(f, invite.reference);
  const hardEnd = record.hardEnd;
  record.hardEnd = 0;
  const refused = await read(await f.req("/api/start", "POST", {
    invite: invite.invite, claim: random(), noticeVersion: notice.version,
  }));
  assert.equal(refused.status, 403);
  assert.match(refused.body.error, /full time allowance/);
  assert.equal(refused.headers.get("Set-Cookie"), null);
  assert.equal(record.status, "invited");
  assert.equal(record.paper, undefined);
  assert.equal(record.revision, 0);
  assert.equal(record.durationMinutes, 30);
  const preview = await read(await f.req("/api/invitation", "POST", { invite: invite.invite }));
  assert.equal(preview.status, 200);
  assert.equal(preview.body.resume, false);
  assert.equal(preview.body.attempt, undefined);

  record.hardEnd = hardEnd;
  const started = await f.start(invite);
  assert.equal(started.attempt.deadline - started.attempt.startedAt, 30 * MINUTE);
  assert.equal(stored(f, invite.reference).status, "active");
  assert.equal(stored(f, invite.reference).paper.questions.length, 15);
  assert.ok(stored(f, invite.reference).deadline <= stored(f, invite.reference).hardEnd);
});

test("single-choice questions reject a second issued option unless that question allows more than one", async () => {
  const f = fixture();
  const invite = await f.issue(17);
  const started = await f.start(invite);
  const question = started.attempt.questions[0];
  const [first, second] = question.options;
  const save = choices => f.req("/api/answers", "PUT", {
    reference: invite.reference, questionId: question.id, choices, revision: stored(f, invite.reference).revision,
  }, { cookie: started.cookie });
  const before = f.records.get(invite.reference).etag;
  const rejected = await read(await save([first.id, second.id]));
  assert.equal(rejected.status, 422);
  assert.match(rejected.body.error, /available answer/);
  assert.equal(stored(f, invite.reference).answers[question.id], undefined);
  assert.equal(f.records.get(invite.reference).etag, before);
  assert.equal((await save([first.id, first.id])).status, 422);

  question.multiple = false;
  stored(f, invite.reference).paper.questions[0].multiple = false;
  assert.equal((await save([first.id, second.id])).status, 422);

  stored(f, invite.reference).paper.questions[0].multiple = true;
  const accepted = await read(await save([second.id, first.id]));
  assert.equal(accepted.status, 200);
  assert.deepEqual(stored(f, invite.reference).answers[question.id], [second.id, first.id]);
  assert.equal((await save([first.id, first.id])).status, 422);
  assert.deepEqual(stored(f, invite.reference).answers[question.id], [second.id, first.id]);
});

test("an incomplete or stale submission does not score, and the stored score is the server grade", async () => {
  const f = fixture();
  const invite = await f.issue(22);
  const started = await f.start(invite);
  const record = () => stored(f, invite.reference);
  const submit = revision => f.req("/api/submit", "POST", { reference: invite.reference, revision }, { cookie: started.cookie });
  const early = await read(await submit(record().revision));
  assert.equal(early.status, 409);
  assert.match(early.body.error, /Answer every question/);
  assert.equal(record().status, "active");
  assert.equal(record().score, undefined);
  assert.equal(record().revision, started.attempt.revision);
  const purgeAt = record().purgeAt;

  let revision = started.attempt.revision;
  const key = record().paper.key;
  const questions = started.attempt.questions;
  for (const question of questions.slice(0, 14)) {
    const saved = await read(await f.req("/api/answers", "PUT", {
      reference: invite.reference, questionId: question.id, choices: key[question.id], revision,
    }, { cookie: started.cookie }));
    assert.equal(saved.status, 200);
    revision = saved.body.attempt.revision;
    assert.equal(saved.headers.get("Set-Cookie"), null);
  }
  const partial = await read(await submit(revision));
  assert.equal(partial.status, 409);
  assert.match(partial.body.error, /Answer every question/);
  assert.equal(record().status, "active");
  assert.equal(record().score, undefined);
  assert.equal(record().purgeAt, purgeAt);
  const stale = await read(await submit(started.attempt.revision));
  assert.equal(stale.status, 409);
  assert.match(stale.body.error, /another tab/);
  assert.equal(record().revision, revision);

  for (const bad of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1"]) {
    const response = await read(await submit(bad));
    assert.equal(response.status, 422, JSON.stringify(bad));
    assert.match(response.body.error, /valid revision/);
    assert.equal(record().status, "active");
  }

  const last = questions[14];
  const wrong = last.options.find(option => option.id !== key[last.id][0]);
  const finished = await read(await f.req("/api/answers", "PUT", {
    reference: invite.reference, questionId: last.id, choices: [wrong.id], revision,
  }, { cookie: started.cookie }));
  assert.equal(finished.status, 200);
  revision = finished.body.attempt.revision;
  const cleared = await read(await f.req("/api/answers", "PUT", {
    reference: invite.reference, questionId: questions[0].id, choices: [], revision,
  }, { cookie: started.cookie }));
  assert.equal(cleared.status, 200);
  revision = cleared.body.attempt.revision;
  const missing = await read(await submit(revision));
  assert.equal(missing.status, 409);
  assert.match(missing.body.error, /Answer every question/);
  assert.equal(record().score, undefined);
  const restored = await read(await f.req("/api/answers", "PUT", {
    reference: invite.reference, questionId: questions[0].id, choices: key[questions[0].id], revision,
  }, { cookie: started.cookie }));
  revision = restored.body.attempt.revision;
  const final = await read(await submit(revision));
  assert.equal(final.status, 200);
  assert.equal(final.body.attempt.status, "submitted");
  assert.equal(final.body.attempt.score, undefined);
  assert.equal(record().score, grade(record().paper, record().answers));
  assert.equal(record().score, 14);
  const exported = await read(await f.req("/api/ops/attempts/" + invite.reference, "GET", undefined, f.admin));
  assert.equal(exported.body.score, 14);
  assert.equal(exported.body.durationMinutes, 22);
  const again = await read(await submit(record().revision));
  assert.equal(again.status, 200);
  assert.equal(record().score, 14);
  assert.equal(again.body.attempt.revision, final.body.attempt.revision);
});

test("submission retention is the earlier of thirty minutes and the hard end, without rotating the session", async () => {
  const f = fixture();
  const long = await f.issue(50);
  const started = await f.start(long);
  const record = () => stored(f, long.reference);
  assert.equal(record().durationMinutes, 50);
  assert.equal(record().purgeAt, record().hardEnd);
  let revision = started.attempt.revision;
  for (const question of started.attempt.questions) {
    const saved = await f.req("/api/answers", "PUT", {
      reference: long.reference, questionId: question.id, choices: [question.options[0].id], revision,
    }, { cookie: started.cookie });
    assert.equal(saved.status, 200);
    assert.equal(saved.headers.get("Set-Cookie"), null);
    revision = (await saved.json()).attempt.revision;
  }
  const submitted = await f.req("/api/submit", "POST", { reference: long.reference, revision }, { cookie: started.cookie });
  assert.equal(submitted.status, 200);
  const receipt = await submitted.json();
  assert.equal(record().purgeAt, record().submittedAt + 30 * MINUTE);
  assert.ok(record().purgeAt < record().hardEnd);
  assert.equal(receipt.attempt.purgeAt, record().purgeAt);
  assert.equal(receipt.attempt.score, undefined);
  const refreshed = submitted.headers.get("Set-Cookie");
  assert.equal(refreshed.split(";")[0], started.cookie);
  assert.match(refreshed, /Secure; HttpOnly; SameSite=Strict/);
  assert.doesNotMatch(refreshed, /Domain=/i);
  const maxAge = Number(/Max-Age=(\d+)/.exec(refreshed)[1]);
  assert.ok(Math.abs(maxAge - Math.floor((record().purgeAt - Date.now()) / 1000)) <= 2);

  const capped = await f.issue(20);
  const second = await f.start(capped);
  let next = second.attempt.revision;
  for (const question of second.attempt.questions) {
    const saved = await read(await f.req("/api/answers", "PUT", {
      reference: capped.reference, questionId: question.id, choices: [question.options[0].id], revision: next,
    }, { cookie: second.cookie }));
    assert.equal(saved.status, 200);
    next = saved.body.attempt.revision;
  }
  stored(f, capped.reference).hardEnd = Date.now() + 5 * MINUTE;
  const closed = await read(await f.req("/api/submit", "POST", {
    reference: capped.reference, revision: next,
  }, { cookie: second.cookie }));
  assert.equal(closed.status, 200);
  const cappedRecord = stored(f, capped.reference);
  assert.equal(cappedRecord.purgeAt, cappedRecord.hardEnd);
  assert.ok(cappedRecord.purgeAt < cappedRecord.submittedAt + 30 * MINUTE);
  assert.equal(closed.body.attempt.purgeAt, cappedRecord.hardEnd);
  const cappedAge = Number(/Max-Age=(\d+)/.exec(closed.headers.get("Set-Cookie"))[1]);
  assert.ok(cappedAge < 30 * 60);
  assert.ok(cappedAge > 60);
});

test("a finished or overdue sitting releases the browser, and an active one still blocks the next invitation", async () => {
  const f = fixture();
  const first = await f.issue(18);
  const active = await f.start(first);
  const blockedInvite = await f.issue(18);
  const blocked = await read(await f.req("/api/start", "POST", {
    invite: blockedInvite.invite, claim: random(), noticeVersion: notice.version,
  }, { cookie: active.cookie }));
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error, /Another assessment is active/);
  assert.equal(blocked.headers.get("Set-Cookie"), null);
  assert.equal(blocked.text.includes(active.attempt.questions[0].prompt), false);
  assert.equal(stored(f, blockedInvite.reference).status, "invited");
  assert.equal(stored(f, blockedInvite.reference).paper, undefined);
  assert.equal(stored(f, first.reference).status, "active");

  stored(f, first.reference).deadline = Date.now() - 1;
  const released = await f.issue(18);
  const next = await read(await f.req("/api/start", "POST", {
    invite: released.invite, claim: random(), noticeVersion: notice.version,
  }, { cookie: active.cookie }));
  assert.equal(next.status, 200, JSON.stringify(next.body));
  assert.equal(stored(f, first.reference).status, "expired");
  assert.equal(stored(f, first.reference).score, undefined);
  assert.equal(stored(f, released.reference).status, "active");
  assert.equal(next.body.attempt.deadline - next.body.attempt.startedAt, 18 * MINUTE);
  assert.match(next.headers.get("Set-Cookie"), /^__Host-assessment=/);
  assert.notEqual(next.headers.get("Set-Cookie").split(";")[0], active.cookie);

  let revision = next.body.attempt.revision;
  const cookie = next.headers.get("Set-Cookie").split(";")[0];
  for (const question of next.body.attempt.questions) {
    const saved = await read(await f.req("/api/answers", "PUT", {
      reference: released.reference, questionId: question.id, choices: [question.options[0].id], revision,
    }, { cookie }));
    assert.equal(saved.status, 200);
    revision = saved.body.attempt.revision;
  }
  const done = await read(await f.req("/api/submit", "POST", { reference: released.reference, revision }, { cookie }));
  assert.equal(done.status, 200);
  assert.equal(stored(f, released.reference).status, "submitted");
  const third = await f.issue(18);
  const afterSubmit = await read(await f.req("/api/start", "POST", {
    invite: third.invite, claim: random(), noticeVersion: notice.version,
  }, { cookie }));
  assert.equal(afterSubmit.status, 200, JSON.stringify(afterSubmit.body));
  assert.equal(stored(f, third.reference).status, "active");
  assert.equal(stored(f, released.reference).status, "submitted");
  assert.notEqual(afterSubmit.headers.get("Set-Cookie").split(";")[0], cookie);
  assert.equal(afterSubmit.body.attempt.deadline - afterSubmit.body.attempt.startedAt, 18 * MINUTE);
});

test("a forged session secret and an unknown reference return the same empty session", async () => {
  const f = fixture();
  const invite = await f.issue(19);
  const started = await f.start(invite);
  const secret = started.cookie.split(".")[1];
  const forged = "__Host-assessment=" + invite.reference + "." + "ab".repeat(32);
  const unknownRef = "cd".repeat(16);
  const unknown = "__Host-assessment=" + unknownRef + "." + "ef".repeat(32);
  const view = async cookie => read(await f.req("/api/session", "GET", undefined, {
    cookie, reference: cookie.split("=")[1].split(".")[0],
  }));
  const hidden = await view(forged);
  const missing = await view(unknown);
  assert.equal(hidden.status, 200);
  assert.equal(missing.status, 200);
  assert.equal(hidden.body.attempt, null);
  assert.equal(missing.body.attempt, null);
  assert.deepEqual(Object.keys(hidden.body).sort(), ["attempt", "serverNow"]);
  assert.deepEqual(Object.keys(missing.body).sort(), Object.keys(hidden.body).sort());
  assert.equal(hidden.text.includes(started.attempt.questions[0].prompt), false);
  assert.equal(hidden.text.includes(secret), false);
  assert.equal(stored(f, invite.reference).status, "active");
  const etag = f.records.get(invite.reference).etag;
  const write = await read(await f.req("/api/answers", "PUT", {
    reference: invite.reference, questionId: started.attempt.questions[0].id,
    choices: [started.attempt.questions[0].options[0].id], revision: started.attempt.revision,
  }, { cookie: forged }));
  assert.equal(write.status, 401);
  assert.equal(f.records.get(invite.reference).etag, etag);
  assert.deepEqual(stored(f, invite.reference).answers, {});
  assert.equal(f.records.has(unknownRef), false);

  const exported = await read(await f.req("/api/ops/attempts/" + invite.reference, "GET", undefined, f.admin));
  assert.equal(exported.status, 200);
  assert.equal(exported.body.score, null);
  assert.equal(exported.body.responses, undefined);
  const unused = await f.issue(19);
  const pending = await read(await f.req("/api/ops/attempts/" + unused.reference, "GET", undefined, f.admin));
  assert.deepEqual(Object.keys(pending.body).sort(), [
    "country", "durationMinutes", "inviteExpiresAt", "issuedAt", "purgeAt", "reference", "score", "status", "timeUnit",
  ]);
  assert.equal(pending.body.status, "invited");
  assert.equal(pending.body.score, null);
  assert.equal(pending.body.durationMinutes, 19);
  assert.equal(pending.text.includes(unused.invite.split(".")[1]), false);
  assert.equal(pending.body.inviteHash, undefined);
});

test("changing the case of an issued choice does not store it or count an integrity observation", async () => {
  const f = fixture();
  f.env.PRIVACY_NOTICE = { ...notice, integrityReview: true };
  const invite = await f.issue(21);
  const started = await f.start(invite, { integrityReview: true });
  const question = started.attempt.questions.find(item => item.options.some(option => option.id !== option.id.toUpperCase()));
  assert.ok(question, "an issued choice contains a letter whose case can change");
  const option = question.options.find(item => item.id !== item.id.toUpperCase());
  const before = f.records.get(invite.reference).etag;
  const response = await read(await f.req("/api/answers", "PUT", {
    reference: invite.reference, questionId: question.id, choices: [option.id.toUpperCase()], revision: started.attempt.revision,
  }, { cookie: started.cookie }));
  assert.equal(response.status, 422);
  assert.match(response.body.error, /available answer/);
  const record = stored(f, invite.reference);
  assert.equal(record.integrityMasks, undefined);
  assert.equal(record.answers[question.id], undefined);
  assert.equal(record.revision, started.attempt.revision);
  assert.equal(f.records.get(invite.reference).etag, before);
  assert.equal(JSON.stringify(record).includes(option.id.toUpperCase()), false);
  const review = await read(await f.req("/api/ops/attempts/" + invite.reference, "GET", undefined, f.admin));
  assert.equal(review.body.integritySummary, undefined);
  assert.equal(review.body.responses, undefined);
});

test("a conditional write that loses the etag does not apply the answer", async () => {
  const f = fixture();
  const invite = await f.issue(16);
  const started = await f.start(invite);
  const question = started.attempt.questions[0];
  const put = f.env.RECORDS.put.bind(f.env.RECORDS);
  f.env.RECORDS.put = async () => null;
  const response = await read(await f.req("/api/answers", "PUT", {
    reference: invite.reference, questionId: question.id, choices: [question.options[0].id], revision: started.attempt.revision,
  }, { cookie: started.cookie }));
  assert.equal(response.status, 409);
  assert.match(response.body.error, /record changed/i);
  assert.deepEqual(stored(f, invite.reference).answers, {});
  assert.equal(stored(f, invite.reference).revision, started.attempt.revision);
  f.env.RECORDS.put = put;
  const saved = await read(await f.req("/api/answers", "PUT", {
    reference: invite.reference, questionId: question.id, choices: [question.options[1].id], revision: started.attempt.revision,
  }, { cookie: started.cookie }));
  assert.equal(saved.status, 200);
  assert.deepEqual(stored(f, invite.reference).answers[question.id], [question.options[1].id]);
});

test("a second issue cannot replace the stored invitation secret or duration", async () => {
  const f = fixture();
  const invite = await f.issue(24);
  const before = structuredClone(stored(f, invite.reference));
  const object = f.objects.get(invite.reference);
  const again = await read(await object.fetch(new Request("https://assessment.internal/issue", {
    method: "POST",
    body: JSON.stringify({
      reference: invite.reference, inviteHash: "f".repeat(64), country: "IT", durationMinutes: 5, inviteTtlMinutes: 1,
    }),
  })));
  assert.equal(again.status, 409);
  assert.match(again.body.error, /could not be created/);
  const record = stored(f, invite.reference);
  assert.equal(record.inviteHash, before.inviteHash);
  assert.equal(record.durationMinutes, 24);
  assert.equal(record.country, "FR");
  assert.equal(record.status, "invited");
  const started = await f.start(invite);
  assert.equal(started.attempt.deadline - started.attempt.startedAt, 24 * MINUTE);
  assert.equal(started.attempt.country, "FR");
});

test("a failed cleanup sweep retries and still removes the records it already reconciled", async () => {
  const f = fixture();
  const httpFail = await f.issue(12);
  const thrown = await f.issue(12);
  const overdue = await f.issue(12);
  const live = await f.issue(12);
  for (const invite of [httpFail, thrown, overdue]) {
    stored(f, invite.reference).purgeAt = 1;
    f.records.get(invite.reference).metadata.purgeAt = "1";
  }
  const original = f.env.ATTEMPTS.jurisdiction.bind(f.env.ATTEMPTS);
  f.env.ATTEMPTS.jurisdiction = name => {
    const namespace = original(name);
    return { ...namespace, get(id) {
      if (id === httpFail.reference) return { async fetch() { return new Response(null, { status: 503 }); } };
      if (id === thrown.reference) return { async fetch() { throw new Error("simulated reconcile fault"); } };
      return namespace.get(id);
    } };
  };
  await assert.rejects(() => worker.scheduled({}, f.env), /Scheduled cleanup requires a retry/);
  assert.equal(f.records.has(httpFail.reference), true);
  assert.equal(f.records.has(thrown.reference), true);
  assert.equal(f.records.has(overdue.reference), false);
  assert.equal(stored(f, live.reference).status, "invited");
  f.env.ATTEMPTS.jurisdiction = original;
  await worker.scheduled({}, f.env);
  assert.equal(f.records.has(httpFail.reference), false);
  assert.equal(f.records.has(thrown.reference), false);
  assert.equal(stored(f, live.reference).status, "invited");
  assert.equal(stored(f, live.reference).paper, undefined);
});

test("only the three loopback hosts may use HTTP, and other asset methods never open an attempt", async () => {
  const f = fixture();
  let assets = 0;
  f.env.ASSETS.fetch = async () => {
    assets += 1;
    return new Response("Test page", { status: 200 });
  };
  for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
    const response = await read(await worker.fetch(new Request(`http://${host}/api/config`), f.env));
    assert.equal(response.status, 200, host);
    assert.equal(response.body.enabled, true, host);
    assert.equal(assets, 0, host);
  }
  for (const url of ["http://assessment.example/api/config", "http://localhost.example/api/config", "http://127.0.0.1.example/api/config", "http://0.0.0.0/api/config"]) {
    const response = await read(await worker.fetch(new Request(url), f.env));
    assert.equal(response.status, 400, url);
    assert.match(response.body.error, /HTTPS/);
    assert.equal(response.text.includes("invite"), false, url);
  }
  const posted = await read(await f.req("/", "POST", { invite: "ab".repeat(16) + "." + "cd".repeat(32) }));
  assert.equal(posted.status, 405);
  assert.equal(assets, 0);
  assert.equal(f.records.size, 0);
  assert.equal(f.objects.size, 0);
  const head = await f.req("/", "HEAD");
  assert.equal(head.status, 200);
  assert.equal(assets, 1);
  assert.match(head.headers.get("Content-Security-Policy"), /frame-ancestors 'none'/);
  assert.equal(head.headers.get("X-Content-Type-Options"), "nosniff");
  assert.doesNotMatch(head.headers.get("Content-Security-Policy"), /unsafe-inline|unsafe-eval/);
});

test("malformed hiring bodies and unknown routes do not create invitations", async () => {
  const f = fixture();
  const invite = await f.issue(23);
  const before = f.records.size;
  const cases = [
    ["/api/ops/invites", "POST", "[]", "application/json", 400],
    ["/api/ops/invites", "POST", "null", "application/json", 400],
    ["/api/ops/invites", "POST", "\"text\"", "application/json", 400],
    ["/api/invitation", "POST", JSON.stringify({ invite: invite.invite }), "text/json", 415],
    ["/api/invitation", "POST", JSON.stringify({ invite: invite.invite }), "text/plain", 415],
  ];
  for (const [path, method, body, contentType, status] of cases) {
    const response = await read(await f.req(path, method, body, {
      admin: path.startsWith("/api/ops/"),
      headers: { "Content-Type": contentType },
    }));
    assert.equal(response.status, status, contentType + " " + body);
    assert.equal(f.records.size, before);
  }
  const typed = await read(await f.req("/api/invitation", "POST", { invite: invite.invite }, {
    headers: { "Content-Type": "APPLICATION/JSON; charset=utf-8" },
  }));
  assert.equal(typed.status, 200);
  assert.equal(typed.body.durationMinutes, 23);
  assert.equal(typed.body.questions, undefined);

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("{" + "\"x\":" + "1".repeat(3000) + "}"));
      controller.close();
    },
  });
  const oversized = await read(await worker.fetch(new Request(origin + "/api/ops/invites", {
    method: "POST",
    duplex: "half",
    headers: { Authorization: "Bearer " + f.env.OPS_TOKEN, "Content-Type": "application/json" },
    body: stream,
  }), f.env));
  assert.equal(oversized.status, 413);
  assert.equal(f.records.size, before);
  assert.equal(f.objects.size, 1);

  const missing = await read(await f.req("/api/no-such-route"));
  assert.equal(missing.status, 404);
  assert.equal((await f.req("/api/answers", "POST", {})).status, 404);
  assert.equal((await f.req("/api/ops/whoami", "POST", {}, f.admin)).status, 404);
  assert.equal(f.records.size, before);
  assert.equal(f.objects.size, 1);
});
