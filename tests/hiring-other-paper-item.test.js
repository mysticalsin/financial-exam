import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import worker, { Assessment } from "../src/worker.js";

// Two live hiring sittings. With sitting A's session, save an answer whose
// item id is on sitting B's paper and not on A's. The save is refused. A's
// answers stay unchanged. B's answers, paper, invite hash, and session secret
// stay unchanged. The reverse is the same refusal.
// Each sitting saving on its own paper, a numeric out-of-range index, a
// different legal choice on the same item, and a wrong Content-Type are
// separate checks.

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
  const written = [];
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
        written.push(key);
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
  return {
    env, objects, records, req, admin: { admin: true }, written,
    resetWrites() { written.length = 0; },
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

async function openSitting(f, durationMinutes) {
  const issued = await read(await f.req("/api/ops/invites", "POST", { durationMinutes }, f.admin));
  assert.equal(issued.status, 201, JSON.stringify(issued.body));
  const secret = issued.body.invite.split(".")[1];
  const claim = random();
  const started = await f.req("/api/start", "POST", {
    invite: issued.body.invite, claim, noticeVersion: notice.version,
  });
  const sitting = await read(started);
  assert.equal(sitting.status, 200, JSON.stringify(sitting.body));
  const cookie = started.headers.get("Set-Cookie").split(";")[0];
  const sessionSecret = cookie.slice(cookie.indexOf(".") + 1);
  const reference = issued.body.reference;
  const record = stored(f, reference);
  assert.equal(record.status, "active");
  assert.equal(record.revision, 1);
  assert.deepEqual(record.answers, {});
  assert.equal(record.inviteHash, await digest(secret));
  assert.equal(record.sessionHash, await digest(sessionSecret));
  assert.notEqual(sessionSecret, secret);
  assert.equal(cookie, "__Host-assessment=" + reference + "." + sessionSecret);
  assert.equal(record.paper.questions.length, 15);
  const question = record.paper.questions[0];
  assert.equal(typeof question.id, "string");
  assert.equal(Number.isInteger(question.id), false);
  assert.ok(question.options.length >= 1);
  return {
    reference, secret, cookie, sessionSecret, question,
    choice: question.options[0].id,
    paper: structuredClone(record.paper),
    inviteHash: record.inviteHash,
    sessionHash: record.sessionHash,
  };
}

function snapshot(f, sitting) {
  return {
    record: structuredClone(stored(f, sitting.reference)),
    etag: f.records.get(sitting.reference).etag,
    alarm: f.objects.get(sitting.reference).ctx.storage.alarm,
  };
}

function assertUntouched(f, sitting, before) {
  const entry = f.records.get(sitting.reference);
  assert.equal(entry.etag, before.etag);
  assert.equal(f.objects.get(sitting.reference).ctx.storage.alarm, before.alarm);
  const record = entry.record;
  assert.deepEqual(record, before.record);
  assert.deepEqual(record.answers, before.record.answers);
  assert.deepEqual(record.paper, before.record.paper);
  assert.equal(record.inviteHash, sitting.inviteHash);
  assert.equal(record.sessionHash, sitting.sessionHash);
  assert.equal(record.inviteHash, before.record.inviteHash);
  assert.equal(record.sessionHash, before.record.sessionHash);
  assert.equal(JSON.stringify(record).includes(sitting.secret), false);
  assert.equal(JSON.stringify(record).includes(sitting.sessionSecret), false);
}

test("a save of the other sitting's item with this sitting's session is refused and stores nothing", async () => {
  const source = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(source, /"LIVE_ENABLED": "false"/);

  const f = fixture();
  const first = await openSitting(f, 21);
  const second = await openSitting(f, 34);
  assert.equal(f.records.size, 2);
  assert.notEqual(first.reference, second.reference);
  assert.notEqual(first.sessionSecret, second.sessionSecret);
  assert.notEqual(first.inviteHash, second.inviteHash);
  assert.notEqual(first.sessionHash, second.sessionHash);
  const firstIds = new Set(first.paper.questions.map(question => question.id));
  const secondIds = new Set(second.paper.questions.map(question => question.id));
  assert.equal(secondIds.has(first.question.id), false);
  assert.equal(firstIds.has(second.question.id), false);
  assert.equal(second.question.options.some(option => option.id === second.choice), true);
  assert.equal(first.question.options.some(option => option.id === first.choice), true);
  assert.deepEqual(stored(f, first.reference).answers, {});
  assert.deepEqual(stored(f, second.reference).answers, {});

  const before = { first: snapshot(f, first), second: snapshot(f, second) };

  f.resetWrites();
  const refused = await read(await f.req("/api/answers", "PUT", {
    reference: first.reference, questionId: second.question.id, choices: [second.choice], revision: 1,
  }, { cookie: first.cookie }));
  assert.equal(refused.status, 422, JSON.stringify(refused.body));
  assert.equal(refused.body.error, "Choose a question from this assessment.");
  assert.equal(refused.headers.get("Set-Cookie"), null);
  assert.equal(refused.text.includes(first.secret), false);
  assert.equal(refused.text.includes(first.sessionSecret), false);
  assert.equal(refused.text.includes(second.secret), false);
  assert.equal(refused.text.includes(second.sessionSecret), false);
  assert.deepEqual(f.written, []);
  assert.deepEqual(stored(f, first.reference).answers, {});
  assert.equal(Object.hasOwn(stored(f, first.reference).answers, second.question.id), false);
  assert.deepEqual(stored(f, second.reference).answers, {});
  assert.deepEqual(stored(f, second.reference).paper, second.paper);
  assert.equal(stored(f, second.reference).inviteHash, second.inviteHash);
  assert.equal(stored(f, second.reference).sessionHash, second.sessionHash);
  assert.equal(stored(f, second.reference).inviteHash, await digest(second.secret));
  assert.equal(stored(f, second.reference).sessionHash, await digest(second.sessionSecret));
  assertUntouched(f, first, before.first);
  assertUntouched(f, second, before.second);

  f.resetWrites();
  const reverse = await read(await f.req("/api/answers", "PUT", {
    reference: second.reference, questionId: first.question.id, choices: [first.choice], revision: 1,
  }, { cookie: second.cookie }));
  assert.equal(reverse.status, 422, JSON.stringify(reverse.body));
  assert.equal(reverse.body.error, "Choose a question from this assessment.");
  assert.equal(reverse.headers.get("Set-Cookie"), null);
  assert.equal(reverse.text.includes(first.secret), false);
  assert.equal(reverse.text.includes(second.secret), false);
  assert.equal(reverse.text.includes(first.sessionSecret), false);
  assert.equal(reverse.text.includes(second.sessionSecret), false);
  assert.deepEqual(f.written, []);
  assert.deepEqual(stored(f, second.reference).answers, {});
  assert.equal(Object.hasOwn(stored(f, second.reference).answers, first.question.id), false);
  assert.deepEqual(stored(f, first.reference).answers, {});
  assert.deepEqual(stored(f, first.reference).paper, first.paper);
  assert.equal(stored(f, first.reference).inviteHash, first.inviteHash);
  assert.equal(stored(f, first.reference).sessionHash, first.sessionHash);
  assert.equal(stored(f, first.reference).inviteHash, await digest(first.secret));
  assert.equal(stored(f, first.reference).sessionHash, await digest(first.sessionSecret));
  assertUntouched(f, first, before.first);
  assertUntouched(f, second, before.second);
  assert.equal(f.records.size, 2);
});
