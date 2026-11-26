import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import worker, { Assessment } from "../src/worker.js";

// A non-JSON or empty body on hiring start and on answer save.
// The refusal is 4xx and must not mint a paper, write an answer, or change
// the invite hash or session secret. A second start of a live sitting, a stale
// notice, a withdrawn country, an answer etag conflict, and an out-of-range
// answer index are different refusals and are not what this file checks.

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
  let writes = 0;
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
    env, objects, records, req, admin: { admin: true },
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

// Empty means no bytes, or a JSON content type with nothing to parse.
// Non-JSON means the bytes are not a JSON value, or the content type is not JSON.
const bodies = [
  ["empty json", "", "application/json", 400, "Please check the request."],
  ["absent json", undefined, "application/json", 400, "Please check the request."],
  ["non-json", "not-json", "application/json", 400, "Please check the request."],
  ["plain text", "not-json", "text/plain", 415, "A JSON request is required."],
  ["empty plain", "", "text/plain", 415, "A JSON request is required."],
];

function raw(f, path, method, body, contentType, cookie) {
  const headers = { Origin: origin };
  if (contentType !== undefined) headers["Content-Type"] = contentType;
  if (cookie) headers.Cookie = cookie;
  const init = { method, headers };
  if (body !== undefined) init.body = body;
  return worker.fetch(new Request(origin + path, init), f.env);
}

test("a non-JSON or empty start body is refused and does not mint a paper", async () => {
  const source = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(source, /"LIVE_ENABLED": "false"/);

  const f = fixture();
  const issued = await read(await f.req("/api/ops/invites", "POST", { durationMinutes: 20 }, f.admin));
  assert.equal(issued.status, 201, JSON.stringify(issued.body));
  const secret = issued.body.invite.split(".")[1];
  const reference = issued.body.reference;
  const inviteHash = await digest(secret);
  assert.equal(stored(f, reference).inviteHash, inviteHash);
  assert.equal(stored(f, reference).status, "invited");
  assert.equal(stored(f, reference).paper, undefined);
  assert.equal(stored(f, reference).sessionHash, undefined);
  const before = structuredClone(stored(f, reference));
  const etag = f.records.get(reference).etag;
  const alarm = f.objects.get(reference).ctx.storage.alarm;

  f.resetWrites();
  for (const [label, body, contentType, status, message] of bodies) {
    const response = await read(await raw(f, "/api/start", "POST", body, contentType));
    assert.equal(response.status, status, label);
    assert.ok(response.status >= 400 && response.status < 500, label);
    assert.deepEqual(response.body, { error: message }, label);
    assert.equal(response.headers.get("Set-Cookie"), null, label);
    assert.equal(response.text.includes(secret), false, label);
    assert.equal(response.body.attempt, undefined, label);
    assert.doesNotMatch(response.body.error, /already been used|privacy notice changed|currently closed|full time allowance|assessment has closed|Another assessment is active|available answer|Choose a question/, label);
    assert.equal(f.writes(), 0, label);
    assert.equal(f.records.get(reference).etag, etag, label);
    assert.equal(f.objects.get(reference).ctx.storage.alarm, alarm, label);
    assert.deepEqual(stored(f, reference), before, label);
  }

  assert.equal(f.records.size, 1);
  const after = stored(f, reference);
  assert.equal(after.status, "invited");
  assert.equal(after.paper, undefined);
  assert.equal(after.sessionHash, undefined);
  assert.equal(after.revision, 0);
  assert.equal(after.inviteHash, inviteHash);
  assert.equal(after.answers, undefined);
});

test("a non-JSON or empty answer body is refused and does not write an answer", async () => {
  const f = fixture();
  const issued = await read(await f.req("/api/ops/invites", "POST", { durationMinutes: 20 }, f.admin));
  assert.equal(issued.status, 201, JSON.stringify(issued.body));
  const secret = issued.body.invite.split(".")[1];
  const claim = random();
  const started = await f.req("/api/start", "POST", {
    invite: issued.body.invite, claim, noticeVersion: notice.version,
  });
  const sitting = await read(started);
  assert.equal(sitting.status, 200, JSON.stringify(sitting.body));
  const cookie = started.headers.get("Set-Cookie").split(";")[0];
  const sessionSecret = cookie.split(".")[1];
  const reference = issued.body.reference;
  const record = stored(f, reference);
  assert.equal(record.status, "active");
  assert.equal(record.inviteHash, await digest(secret));
  assert.equal(record.sessionHash, await digest(sessionSecret));
  assert.notEqual(sessionSecret, secret);
  assert.deepEqual(record.answers, {});
  assert.equal(record.revision, 1);
  assert.equal(record.paper.questions.length, 15);
  const prompt = sitting.body.attempt.questions[0].prompt;
  const before = structuredClone(record);
  const etag = f.records.get(reference).etag;
  const alarm = f.objects.get(reference).ctx.storage.alarm;

  f.resetWrites();
  for (const [label, body, contentType, status, message] of bodies) {
    const response = await read(await raw(f, "/api/answers", "PUT", body, contentType, cookie));
    assert.equal(response.status, status, label);
    assert.ok(response.status >= 400 && response.status < 500, label);
    assert.deepEqual(response.body, { error: message }, label);
    assert.equal(response.headers.get("Set-Cookie"), null, label);
    assert.equal(response.text.includes(secret), false, label);
    assert.equal(response.text.includes(sessionSecret), false, label);
    assert.equal(response.text.includes(prompt), false, label);
    assert.equal(response.body.attempt, undefined, label);
    assert.doesNotMatch(response.body.error, /another tab|record changed|available answer|Choose a question|assessment has closed|privacy notice changed|currently closed/, label);
    assert.equal(f.writes(), 0, label);
    assert.equal(f.records.get(reference).etag, etag, label);
    assert.equal(f.objects.get(reference).ctx.storage.alarm, alarm, label);
    assert.deepEqual(stored(f, reference), before, label);
  }

  const after = stored(f, reference);
  assert.deepEqual(after.answers, {});
  assert.equal(after.revision, 1);
  assert.equal(after.inviteHash, await digest(secret));
  assert.equal(after.sessionHash, await digest(sessionSecret));
  assert.deepEqual(after.paper, before.paper);
  assert.equal(after.status, "active");
  assert.equal(f.records.size, 1);
});
