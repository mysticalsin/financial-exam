import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import worker, { Assessment } from "../src/worker.js";

// Two live hiring sittings at once, each in its own browser.
// An answer save with one sitting's session must leave the other sitting's
// answers, paper, invite hash, and session secret in place, and the reverse.
// A foreign or missing cookie (409/401), a second start of the same invitation,
// practice isolation, and an unanswered submit are separate checks.

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
  assert.ok(record.deadline > Date.now());
  const question = sitting.body.attempt.questions[0];
  assert.ok(question.options.length >= 1);
  return {
    reference, secret, claim, cookie, sessionSecret, question,
    choice: question.options[0].id,
    paper: structuredClone(record.paper),
    inviteHash: record.inviteHash,
    sessionHash: record.sessionHash,
  };
}

function assertUntouched(f, sitting, snapshot) {
  const entry = f.records.get(sitting.reference);
  assert.equal(entry.etag, snapshot.etag);
  assert.equal(f.objects.get(sitting.reference).ctx.storage.alarm, snapshot.alarm);
  const record = entry.record;
  assert.deepEqual(record, snapshot.record);
  assert.deepEqual(record.answers, snapshot.record.answers);
  assert.deepEqual(record.paper, snapshot.record.paper);
  assert.equal(record.inviteHash, sitting.inviteHash);
  assert.equal(record.sessionHash, sitting.sessionHash);
  assert.equal(record.inviteHash, snapshot.record.inviteHash);
  assert.equal(record.sessionHash, snapshot.record.sessionHash);
  assert.equal(JSON.stringify(record).includes(sitting.secret), false);
  assert.equal(JSON.stringify(record).includes(sitting.sessionSecret), false);
}

test("an answer save on one of two live sittings leaves the other sitting's answers, paper, and secrets in place", async () => {
  const source = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(source, /"LIVE_ENABLED": "false"/);

  const f = fixture();
  const first = await openSitting(f, 21);
  const second = await openSitting(f, 34);
  assert.equal(f.records.size, 2);
  assert.notEqual(first.reference, second.reference);
  assert.notEqual(first.secret, second.secret);
  assert.notEqual(first.sessionSecret, second.sessionSecret);
  assert.notEqual(first.inviteHash, second.inviteHash);
  assert.notEqual(first.sessionHash, second.sessionHash);
  assert.notEqual(first.choice, second.choice);
  const firstIds = new Set(first.paper.questions.map(question => question.id));
  assert.equal(second.paper.questions.every(question => !firstIds.has(question.id)), true);
  assert.equal(stored(f, first.reference).durationMinutes, 21);
  assert.equal(stored(f, second.reference).durationMinutes, 34);

  const before = {
    first: {
      record: structuredClone(stored(f, first.reference)),
      etag: f.records.get(first.reference).etag,
      alarm: f.objects.get(first.reference).ctx.storage.alarm,
    },
    second: {
      record: structuredClone(stored(f, second.reference)),
      etag: f.records.get(second.reference).etag,
      alarm: f.objects.get(second.reference).ctx.storage.alarm,
    },
  };

  f.resetWrites();
  const savedFirst = await read(await f.req("/api/answers", "PUT", {
    reference: first.reference, questionId: first.question.id, choices: [first.choice], revision: 1,
  }, { cookie: first.cookie }));
  assert.equal(savedFirst.status, 200, JSON.stringify(savedFirst.body));
  assert.equal(savedFirst.headers.get("Set-Cookie"), null);
  assert.equal(savedFirst.body.attempt.reference, first.reference);
  assert.deepEqual(savedFirst.body.attempt.answers, { [first.question.id]: [first.choice] });
  assert.equal(savedFirst.body.attempt.revision, 2);
  assert.equal(savedFirst.text.includes(second.secret), false);
  assert.equal(savedFirst.text.includes(second.sessionSecret), false);
  assert.equal(savedFirst.text.includes(second.question.id), false);
  assert.deepEqual(f.written, [first.reference]);
  assertUntouched(f, second, before.second);

  const afterFirst = stored(f, first.reference);
  assert.deepEqual(afterFirst.answers, { [first.question.id]: [first.choice] });
  assert.deepEqual(afterFirst.paper, before.first.record.paper);
  assert.equal(afterFirst.inviteHash, first.inviteHash);
  assert.equal(afterFirst.sessionHash, first.sessionHash);
  assert.equal(afterFirst.inviteHash, await digest(first.secret));
  assert.equal(afterFirst.sessionHash, await digest(first.sessionSecret));
  assert.equal(afterFirst.status, "active");
  assert.equal(afterFirst.revision, 2);
  assert.equal(afterFirst.durationMinutes, 21);
  const firstAfterSave = {
    record: structuredClone(afterFirst),
    etag: f.records.get(first.reference).etag,
    alarm: f.objects.get(first.reference).ctx.storage.alarm,
  };
  assert.notEqual(firstAfterSave.etag, before.first.etag);

  const viewedSecond = await read(await f.req("/api/session", "GET", undefined, {
    cookie: second.cookie, reference: second.reference,
  }));
  assert.equal(viewedSecond.status, 200, JSON.stringify(viewedSecond.body));
  assert.equal(viewedSecond.headers.get("Set-Cookie"), null);
  assert.deepEqual(viewedSecond.body.attempt.answers, {});
  assert.deepEqual(
    viewedSecond.body.attempt.questions.map(question => question.id),
    second.paper.questions.map(question => question.id),
  );
  assertUntouched(f, second, before.second);

  f.resetWrites();
  const savedSecond = await read(await f.req("/api/answers", "PUT", {
    reference: second.reference, questionId: second.question.id, choices: [second.choice], revision: 1,
  }, { cookie: second.cookie }));
  assert.equal(savedSecond.status, 200, JSON.stringify(savedSecond.body));
  assert.equal(savedSecond.headers.get("Set-Cookie"), null);
  assert.equal(savedSecond.body.attempt.reference, second.reference);
  assert.deepEqual(savedSecond.body.attempt.answers, { [second.question.id]: [second.choice] });
  assert.equal(savedSecond.body.attempt.revision, 2);
  assert.equal(savedSecond.text.includes(first.secret), false);
  assert.equal(savedSecond.text.includes(first.sessionSecret), false);
  assert.equal(savedSecond.text.includes(first.question.id), false);
  assert.equal(savedSecond.text.includes(first.choice), false);
  assert.deepEqual(f.written, [second.reference]);
  assertUntouched(f, first, firstAfterSave);

  const afterSecond = stored(f, second.reference);
  assert.deepEqual(afterSecond.answers, { [second.question.id]: [second.choice] });
  assert.deepEqual(afterSecond.paper, before.second.record.paper);
  assert.equal(afterSecond.inviteHash, second.inviteHash);
  assert.equal(afterSecond.sessionHash, second.sessionHash);
  assert.equal(afterSecond.inviteHash, await digest(second.secret));
  assert.equal(afterSecond.sessionHash, await digest(second.sessionSecret));
  assert.equal(afterSecond.status, "active");
  assert.equal(afterSecond.revision, 2);
  assert.equal(afterSecond.durationMinutes, 34);
  assert.equal(f.records.size, 2);
  assert.equal(JSON.stringify(stored(f, first.reference)).includes(second.choice), false);
  assert.equal(JSON.stringify(stored(f, second.reference)).includes(first.choice), false);

  const viewedFirst = await read(await f.req("/api/session", "GET", undefined, {
    cookie: first.cookie, reference: first.reference,
  }));
  assert.equal(viewedFirst.status, 200, JSON.stringify(viewedFirst.body));
  assert.equal(viewedFirst.headers.get("Set-Cookie"), null);
  assert.deepEqual(viewedFirst.body.attempt.answers, { [first.question.id]: [first.choice] });
  assert.deepEqual(
    viewedFirst.body.attempt.questions.map(question => question.id),
    first.paper.questions.map(question => question.id),
  );
  assert.equal(stored(f, first.reference).inviteHash, first.inviteHash);
  assert.equal(stored(f, first.reference).sessionHash, first.sessionHash);
  assert.equal(stored(f, second.reference).inviteHash, second.inviteHash);
  assert.equal(stored(f, second.reference).sessionHash, second.sessionHash);
  assert.deepEqual(stored(f, first.reference).paper, first.paper);
  assert.deepEqual(stored(f, second.reference).paper, second.paper);
});
