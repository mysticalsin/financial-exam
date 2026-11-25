import test from "node:test";
import assert from "node:assert/strict";
import worker, { Assessment } from "../src/worker.js";

// The same-browser lock after a finished or overdue sitting is covered elsewhere.
// These cases are the remaining branches: the record is already gone, the cookie
// is not that sitting, or the overdue write does not commit.

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
  async function issue(durationMinutes = 30) {
    const response = await req("/api/ops/invites", "POST", { durationMinutes }, admin);
    assert.equal(response.status, 201, await response.clone().text());
    return response.json();
  }
  async function start(invite) {
    const response = await req("/api/start", "POST", {
      invite: invite.invite, claim: random(), noticeVersion: notice.version,
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

test("a sitting past its retention cutoff is erased and releases the browser for the next invitation", async () => {
  const f = fixture();
  const first = await f.issue(30);
  const active = await f.start(first);
  const question = active.attempt.questions[0];
  const choice = question.options[0].id;
  const saved = await read(await f.req("/api/answers", "PUT", {
    reference: first.reference, questionId: question.id, choices: [choice], revision: active.attempt.revision,
  }, { cookie: active.cookie }));
  assert.equal(saved.status, 200);
  const open = f.records.get(first.reference);
  open.record.deadline = Date.now() - 1;
  open.record.purgeAt = Date.now() - 1;

  const second = await f.issue(17);
  const inspected = await read(await f.req("/api/invitation", "POST", { invite: second.invite }, { cookie: active.cookie }));
  assert.equal(inspected.status, 200);
  assert.equal(inspected.body.anotherActiveSession, false);
  assert.equal(inspected.body.resume, false);
  assert.equal(inspected.body.attempt, undefined);
  assert.equal(inspected.headers.get("Set-Cookie"), null);
  assert.equal(inspected.text.includes(choice), false);
  assert.equal(f.records.has(first.reference), false);
  assert.equal(f.objects.get(first.reference).ctx.storage.alarm, null);
  assert.equal(stored(f, second.reference).status, "invited");
  assert.equal(stored(f, second.reference).paper, undefined);

  const started = await read(await f.req("/api/start", "POST", {
    invite: second.invite, claim: random(), noticeVersion: notice.version,
  }, { cookie: active.cookie }));
  assert.equal(started.status, 200, started.text);
  assert.equal(started.body.attempt.reference, second.reference);
  assert.equal(started.body.attempt.status, "active");
  assert.equal(started.body.attempt.deadline - started.body.attempt.startedAt, 17 * MINUTE);
  const replacement = started.headers.get("Set-Cookie");
  assert.match(replacement, /^__Host-assessment=/);
  assert.notEqual(replacement.split(";")[0], active.cookie);
  assert.equal(replacement.split(";")[0].slice("__Host-assessment=".length).split(".")[0], second.reference);
  assert.equal(f.records.has(first.reference), false);
  assert.equal(stored(f, second.reference).status, "active");
  assert.equal(started.text.includes(choice), false);

  const stale = await read(await f.req("/api/session", "GET", undefined, {
    cookie: active.cookie, reference: first.reference,
  }));
  assert.equal(stale.status, 200);
  assert.equal(stale.body.attempt, null);
  assert.equal(f.records.has(first.reference), false);
  const current = await read(await f.req("/api/session", "GET", undefined, {
    cookie: replacement.split(";")[0], reference: second.reference,
  }));
  assert.equal(current.body.attempt.reference, second.reference);
  assert.equal(current.body.attempt.status, "active");
});

test("a cookie that does not match the active session does not block or change that sitting", async () => {
  const f = fixture();
  const first = await f.issue(21);
  const active = await f.start(first);
  const question = active.attempt.questions[0];
  const choice = question.options[0].id;
  const other = question.options[1].id;
  const saved = await read(await f.req("/api/answers", "PUT", {
    reference: first.reference, questionId: question.id, choices: [choice], revision: active.attempt.revision,
  }, { cookie: active.cookie }));
  assert.equal(saved.status, 200);
  const before = f.records.get(first.reference);
  const forged = "__Host-assessment=" + first.reference + "." + "ab".repeat(32);
  assert.notEqual(forged, active.cookie);

  const second = await f.issue(19);
  const started = await read(await f.req("/api/start", "POST", {
    invite: second.invite, claim: random(), noticeVersion: notice.version,
  }, { cookie: forged }));
  assert.equal(started.status, 200, started.text);
  assert.equal(started.body.attempt.reference, second.reference);
  assert.equal(started.body.attempt.status, "active");
  assert.equal(started.body.attempt.deadline - started.body.attempt.startedAt, 19 * MINUTE);
  const replacement = started.headers.get("Set-Cookie").split(";")[0];
  assert.notEqual(replacement, forged);
  assert.notEqual(replacement, active.cookie);
  assert.equal(f.records.get(first.reference).etag, before.etag);
  assert.equal(stored(f, first.reference).status, "active");
  assert.equal(stored(f, first.reference).revision, before.record.revision);
  assert.deepEqual(stored(f, first.reference).answers[question.id], [choice]);
  assert.equal(stored(f, first.reference).score, undefined);
  assert.equal(started.text.includes(choice), false);

  const follow = await read(await f.req("/api/answers", "PUT", {
    reference: first.reference, questionId: question.id, choices: [other], revision: before.record.revision,
  }, { cookie: active.cookie }));
  assert.equal(follow.status, 200);
  assert.deepEqual(stored(f, first.reference).answers[question.id], [other]);
  const crossed = await read(await f.req("/api/answers", "PUT", {
    reference: first.reference, questionId: question.id, choices: [choice], revision: stored(f, first.reference).revision,
  }, { cookie: replacement }));
  assert.equal(crossed.status, 409);
  assert.deepEqual(stored(f, first.reference).answers[question.id], [other]);
  assert.equal(stored(f, second.reference).status, "active");
});

test("an overdue sitting whose expiry write does not commit keeps the next invitation unclaimed", async () => {
  const f = fixture();
  const first = await f.issue(16);
  const active = await f.start(first);
  const open = f.records.get(first.reference);
  const etag = open.etag;
  const revision = open.record.revision;
  open.record.deadline = Date.now() - 1;
  assert.ok(open.record.purgeAt > Date.now());
  const second = await f.issue(16);
  const prompt = active.attempt.questions[0].prompt;
  f.env.RECORDS.put = async () => null;

  const blocked = await read(await f.req("/api/start", "POST", {
    invite: second.invite, claim: random(), noticeVersion: notice.version,
  }, { cookie: active.cookie }));
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error, /record changed/i);
  assert.equal(blocked.headers.get("Set-Cookie"), null);
  assert.equal(blocked.text.includes(prompt), false);
  assert.equal(blocked.text.includes(second.invite.split(".")[1]), false);
  assert.equal(stored(f, second.reference).status, "invited");
  assert.equal(stored(f, second.reference).paper, undefined);
  assert.equal(f.records.get(first.reference).etag, etag);
  assert.equal(stored(f, first.reference).status, "active");
  assert.equal(stored(f, first.reference).revision, revision);
  assert.equal(stored(f, first.reference).score, undefined);
  assert.equal(stored(f, first.reference).deadline, open.record.deadline);
});
