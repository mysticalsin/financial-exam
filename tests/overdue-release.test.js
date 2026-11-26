import test from "node:test";
import assert from "node:assert/strict";
import worker, { Assessment } from "../src/worker.js";

// The invitation page treats anotherActiveSession as the browser lock, and that
// preview does not replace the session cookie. A later start is a separate request.
// Nothing here describes a deployed Worker. The checked-in recruitment flag stays closed.

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
  async function req(path, method = "GET", data, { cookie, admin, headers = {} } = {}) {
    const init = { method, headers: { ...headers } };
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
  async function issue(durationMinutes) {
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
    return { cookie: setCookie.split(";")[0], ...(await response.json()) };
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

test("an overdue preview frees the browser, keeps the saved answer, and does not mint or rotate the cookie", async () => {
  const f = fixture();
  const first = await f.issue(18);
  const active = await f.start(first);
  const question = active.attempt.questions[0];
  const choice = question.options[0].id;
  const saved = await read(await f.req("/api/answers", "PUT", {
    reference: first.reference, questionId: question.id, choices: [choice], revision: active.attempt.revision,
  }, { cookie: active.cookie }));
  assert.equal(saved.status, 200);
  const revisionAfterSave = stored(f, first.reference).revision;
  const purgeAt = stored(f, first.reference).purgeAt;
  const alarm = f.objects.get(first.reference).ctx.storage.alarm;
  assert.equal(alarm, purgeAt);

  const next = await f.issue(27);
  const occupied = await read(await f.req("/api/invitation", "POST", { invite: next.invite }, { cookie: active.cookie }));
  assert.equal(occupied.status, 200);
  assert.equal(occupied.body.anotherActiveSession, true);
  assert.equal(occupied.body.resume, false);
  assert.equal(occupied.headers.get("Set-Cookie"), null);
  assert.equal(stored(f, first.reference).status, "active");
  assert.equal(stored(f, next.reference).status, "invited");
  assert.equal(stored(f, next.reference).paper, undefined);

  stored(f, first.reference).deadline = Date.now() - 1;
  const released = await read(await f.req("/api/invitation", "POST", { invite: next.invite }, { cookie: active.cookie }));
  assert.equal(released.status, 200, JSON.stringify(released.body));
  assert.equal(released.body.anotherActiveSession, false);
  assert.equal(released.body.resume, false);
  assert.equal(released.body.attempt, undefined);
  assert.equal(released.body.reference, next.reference);
  assert.equal(released.body.durationMinutes, 27);
  assert.equal(released.headers.get("Set-Cookie"), null);
  assert.equal(released.text.includes(question.prompt), false);
  assert.equal(released.text.includes(choice), false);
  assert.equal(stored(f, next.reference).status, "invited");
  assert.equal(stored(f, next.reference).paper, undefined);
  assert.equal(stored(f, next.reference).revision, 0);

  const closed = stored(f, first.reference);
  assert.equal(closed.status, "expired");
  assert.equal(closed.score, undefined);
  assert.deepEqual(closed.answers[question.id], [choice]);
  assert.equal(closed.revision, revisionAfterSave + 1);
  assert.equal(closed.purgeAt, purgeAt);
  assert.equal(closed.durationMinutes, 18);
  assert.equal(f.records.get(first.reference).metadata.purgeAt, String(purgeAt));
  assert.equal(f.records.get(first.reference).metadata.compactAt, undefined);
  assert.equal(f.objects.get(first.reference).ctx.storage.alarm, alarm);

  const reloaded = await read(await f.req("/api/invitation", "POST", { invite: next.invite }, { cookie: active.cookie }));
  assert.equal(reloaded.status, 200);
  assert.equal(reloaded.body.anotherActiveSession, false);
  assert.equal(reloaded.headers.get("Set-Cookie"), null);
  assert.equal(stored(f, first.reference).revision, revisionAfterSave + 1);
  assert.equal(stored(f, first.reference).status, "expired");
  assert.deepEqual(stored(f, first.reference).answers[question.id], [choice]);
  assert.equal(stored(f, next.reference).paper, undefined);

  const session = await read(await f.req("/api/session", "GET", undefined, {
    cookie: active.cookie, headers: { "X-Assessment-Reference": first.reference },
  }));
  assert.equal(session.status, 200);
  assert.equal(session.body.attempt.status, "expired");
  assert.deepEqual(session.body.attempt.questions, []);
  assert.deepEqual(session.body.attempt.answers, {});
  assert.equal(session.body.attempt.score, undefined);
  assert.equal(session.text.includes(question.prompt), false);
  assert.equal(stored(f, first.reference).revision, revisionAfterSave + 1);
});

test("a lost overdue close leaves the browser occupied and mints nothing", async () => {
  const f = fixture();
  const first = await f.issue(16);
  const active = await f.start(first);
  const question = active.attempt.questions[0];
  const next = await f.issue(16);
  const before = structuredClone(stored(f, first.reference));
  const etag = f.records.get(first.reference).etag;
  stored(f, first.reference).deadline = Date.now() - 1;
  f.env.RECORDS.put = async () => null;
  const blocked = await read(await f.req("/api/invitation", "POST", { invite: next.invite }, { cookie: active.cookie }));
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error, /record changed/i);
  assert.equal(blocked.body.anotherActiveSession, undefined);
  assert.equal(blocked.headers.get("Set-Cookie"), null);
  assert.equal(blocked.text.includes(question.prompt), false);
  assert.equal(stored(f, first.reference).status, "active");
  assert.equal(stored(f, first.reference).revision, before.revision);
  assert.deepEqual(stored(f, first.reference).answers, before.answers);
  assert.equal(stored(f, first.reference).score, undefined);
  assert.equal(f.records.get(first.reference).etag, etag);
  assert.equal(stored(f, next.reference).status, "invited");
  assert.equal(stored(f, next.reference).paper, undefined);
  assert.equal(f.objects.get(first.reference).ctx.storage.alarm, before.purgeAt);
});
