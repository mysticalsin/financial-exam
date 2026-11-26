import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import worker, { Assessment } from "../src/worker.js";

// GET or DELETE where hiring start is POST, answer save is PUT, and submit is POST.
// The hiring table has no such entry, so the Worker answers 404 Route not found
// before it reads a body or calls the attempt. That refusal mints no paper, writes
// no answer, and seals no score. The invite hash and session secret stay put.
// A non-JSON body, a second start of a live sitting, a missing session cookie,
// and an out-of-range answer index are different refusals and are not what this file checks.

const origin = "https://assessment.example";
const notice = {
  controller: "Test controller", contact: "privacy@example.invalid", basis: "Test basis",
  recipients: "Test reviewer", transfers: "Test transfer description", rights: "Test rights",
  purpose: "Test purpose", supervisoryAuthority: "Test authority", version: "test-1", retentionMinutes: 30,
};
const random = () => crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");

async function digest(value) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

function fixture() {
  const objects = new Map();
  const records = new Map();
  const limiterKeys = [];
  let writes = 0;
  const env = {
    LIVE_ENABLED: "true", PRIVACY_COUNTRY: "FR", PRIVACY_NOTICE: { ...notice }, OPS_TOKEN: random(),
    ACCESS_ISSUER: "https://synthetic-test.cloudflareaccess.com", ACCESS_AUD: "a".repeat(64),
    DURATION_MINUTES: 30, INVITE_TTL_MINUTES: 30,
    RATE_LIMITER: { async limit({ key }) { limiterKeys.push(key); return { success: true }; } },
    ASSETS: { async fetch() { return new Response("Test page", { status: 200 }); } },
    RECORDS: {
      async get(key) {
        const entry = records.get(key);
        return entry ? { etag: entry.etag, json: async () => structuredClone(entry.record) } : null;
      },
      async put(key, value, opts) {
        writes += 1;
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
    if (!admin && method !== "GET" && !("Origin" in init.headers)) init.headers.Origin = origin;
    if (admin) init.headers.Authorization = "Bearer " + env.OPS_TOKEN;
    if (cookie) init.headers.Cookie = cookie;
    if (data !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(data);
    }
    return worker.fetch(new Request(origin + path, init), env);
  }
  return {
    env, objects, records, limiterKeys, req, admin: { admin: true },
    writes: () => writes,
    resetWrites() { writes = 0; },
  };
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

function raw(f, path, method, data, cookie) {
  const headers = { Origin: origin };
  if (cookie) headers.Cookie = cookie;
  const init = { method, headers };
  if (data !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(data);
  }
  return worker.fetch(new Request(origin + path, init), f.env);
}

async function issue(f) {
  const issued = await read(await f.req("/api/ops/invites", "POST", { durationMinutes: 20 }, f.admin));
  assert.equal(issued.status, 201, JSON.stringify(issued.body));
  const secret = issued.body.invite.split(".")[1];
  const record = stored(f, issued.body.reference);
  assert.equal(record.inviteHash, await digest(secret));
  assert.equal(record.status, "invited");
  assert.equal(record.paper, undefined);
  assert.equal(record.sessionHash, undefined);
  assert.equal(record.revision, 0);
  return { ...issued.body, secret };
}

async function begin(f, invite) {
  const claim = random();
  const started = await f.req("/api/start", "POST", {
    invite: invite.invite, claim, noticeVersion: notice.version,
  });
  const sitting = await read(started);
  assert.equal(sitting.status, 200, JSON.stringify(sitting.body));
  const cookie = started.headers.get("Set-Cookie").split(";")[0];
  const sessionSecret = cookie.slice(cookie.indexOf(".") + 1);
  const record = stored(f, invite.reference);
  assert.equal(record.status, "active");
  assert.equal(record.revision, 1);
  assert.deepEqual(record.answers, {});
  assert.equal(record.score, undefined);
  assert.equal(record.paper.questions.length, 15);
  assert.equal(record.inviteHash, await digest(invite.secret));
  assert.equal(record.sessionHash, await digest(sessionSecret));
  assert.notEqual(sessionSecret, invite.secret);
  return { cookie, sessionSecret, sitting };
}

// A valid JSON body is attached to DELETE. GET cannot carry one. Either method
// would mint, save, or seal if the Worker treated it as the route's method.
async function wrongMethod(f, reference, path, data, cookie, secret, sessionSecret) {
  const before = structuredClone(stored(f, reference));
  const etag = f.records.get(reference).etag;
  const alarm = f.objects.get(reference).ctx.storage.alarm;
  const limiter = f.limiterKeys.length;
  f.resetWrites();
  for (const method of ["GET", "DELETE"]) {
    const response = await read(await raw(f, path, method, method === "GET" ? undefined : data, cookie));
    assert.equal(response.status, 404, method + " " + path);
    assert.deepEqual(response.body, { error: "Route not found." }, method + " " + path);
    assert.equal(response.headers.get("Set-Cookie"), null, method);
    assert.equal(response.text.includes(secret), false, method);
    if (sessionSecret) assert.equal(response.text.includes(sessionSecret), false, method);
    assert.equal(response.body.attempt, undefined, method);
    assert.equal(f.writes(), 0, method);
    assert.equal(f.limiterKeys.length, limiter, method);
    assert.equal(f.records.get(reference).etag, etag, method);
    assert.equal(f.objects.get(reference).ctx.storage.alarm, alarm, method);
    assert.deepEqual(stored(f, reference), before, method);
  }
  const after = stored(f, reference);
  assert.equal(after.inviteHash, await digest(secret));
  assert.equal(after.sessionHash, sessionSecret ? await digest(sessionSecret) : undefined);
  assert.equal(after.score, undefined);
  assert.equal(f.records.size, 1);
  assert.equal(f.objects.size, 1);
  return after;
}

test("GET or DELETE on hiring start is refused and does not mint a paper", async () => {
  const source = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(source, /"LIVE_ENABLED": "false"/);

  const f = fixture();
  const invite = await issue(f);
  const claim = random();
  const after = await wrongMethod(f, invite.reference, "/api/start", {
    invite: invite.invite, claim, noticeVersion: notice.version,
  }, undefined, invite.secret);
  assert.equal(after.status, "invited");
  assert.equal(after.paper, undefined);
  assert.equal(after.sessionHash, undefined);
  assert.equal(after.answers, undefined);
  assert.equal(after.revision, 0);
});

test("GET or DELETE on answer save is refused and does not write an answer", async () => {
  const f = fixture();
  const invite = await issue(f);
  const { cookie, sessionSecret, sitting } = await begin(f, invite);
  const question = sitting.body.attempt.questions[0];
  const after = await wrongMethod(f, invite.reference, "/api/answers", {
    reference: invite.reference,
    questionId: question.id,
    choices: [question.options[0].id],
    revision: sitting.body.attempt.revision,
  }, cookie, invite.secret, sessionSecret);
  assert.equal(after.status, "active");
  assert.deepEqual(after.answers, {});
  assert.equal(after.revision, 1);
  assert.equal(after.paper.questions.length, 15);
});

test("GET or DELETE on submit is refused and does not seal a score", async () => {
  const f = fixture();
  const invite = await issue(f);
  const { cookie, sessionSecret, sitting } = await begin(f, invite);
  let revision = sitting.body.attempt.revision;
  for (const question of sitting.body.attempt.questions) {
    const saved = await read(await f.req("/api/answers", "PUT", {
      reference: invite.reference,
      questionId: question.id,
      choices: [question.options[0].id],
      revision,
    }, { cookie }));
    assert.equal(saved.status, 200);
    revision = saved.body.attempt.revision;
  }
  const ready = stored(f, invite.reference);
  assert.equal(Object.keys(ready.answers).length, ready.paper.questions.length);
  assert.equal(ready.status, "active");
  assert.equal(ready.score, undefined);
  const after = await wrongMethod(f, invite.reference, "/api/submit", {
    reference: invite.reference, revision,
  }, cookie, invite.secret, sessionSecret);
  assert.equal(after.status, "active");
  assert.equal(after.score, undefined);
  assert.equal(after.submittedAt, undefined);
  assert.equal(after.revision, revision);
  assert.equal(Object.keys(after.answers).length, 15);
});
