import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import worker, { Assessment } from "../src/worker.js";

// One live hiring sitting. Save a legal choice, then save that same choice
// again for the same item using the revision the first save just returned.
// The stored answer stays a single copy of that choice. The invite hash and
// session secret stay unchanged. Main returns before writing, so the etag stays.
// Replacing the choice, a stale revision 409, and an extra JSON field are
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

test("saving the same legal choice again on one live sitting keeps a single stored answer", async () => {
  const source = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(source, /"LIVE_ENABLED": "false"/);

  const f = fixture();
  const issued = await read(await f.req("/api/ops/invites", "POST", { durationMinutes: 30 }, f.admin));
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
  assert.equal(f.records.size, 1);
  const opened = stored(f, reference);
  assert.equal(opened.status, "active");
  assert.equal(opened.revision, 1);
  assert.deepEqual(opened.answers, {});
  assert.equal(opened.inviteHash, await digest(secret));
  assert.equal(opened.sessionHash, await digest(sessionSecret));
  assert.notEqual(sessionSecret, secret);
  assert.equal(cookie, "__Host-assessment=" + reference + "." + sessionSecret);
  const question = sitting.body.attempt.questions[0];
  const choice = question.options[0].id;
  const paper = structuredClone(opened.paper);
  const inviteHash = opened.inviteHash;
  const sessionHash = opened.sessionHash;
  const alarm = f.objects.get(reference).ctx.storage.alarm;
  const openedEtag = f.records.get(reference).etag;

  f.resetWrites();
  const first = await read(await f.req("/api/answers", "PUT", {
    reference, questionId: question.id, choices: [choice], revision: 1,
  }, { cookie }));
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.headers.get("Set-Cookie"), null);
  assert.equal(first.body.attempt.revision, 2);
  assert.equal(first.body.attempt.answered, 1);
  assert.deepEqual(first.body.attempt.answers, { [question.id]: [choice] });
  assert.equal(first.text.includes(secret), false);
  assert.equal(first.text.includes(sessionSecret), false);
  assert.deepEqual(f.written, [reference]);
  const afterFirst = stored(f, reference);
  assert.deepEqual(afterFirst.answers, { [question.id]: [choice] });
  assert.equal(Object.keys(afterFirst.answers).length, 1);
  assert.equal(afterFirst.answers[question.id].length, 1);
  assert.equal(afterFirst.revision, 2);
  assert.equal(afterFirst.status, "active");
  assert.equal(afterFirst.submittedAt, undefined);
  assert.equal(afterFirst.score, undefined);
  assert.deepEqual(afterFirst.paper, paper);
  assert.equal(afterFirst.inviteHash, inviteHash);
  assert.equal(afterFirst.sessionHash, sessionHash);
  assert.equal(afterFirst.inviteHash, await digest(secret));
  assert.equal(afterFirst.sessionHash, await digest(sessionSecret));
  assert.equal(JSON.stringify(afterFirst).includes(secret), false);
  assert.equal(JSON.stringify(afterFirst).includes(sessionSecret), false);
  const freshEtag = f.records.get(reference).etag;
  assert.notEqual(freshEtag, openedEtag);
  const freshRevision = first.body.attempt.revision;
  const snapshot = structuredClone(afterFirst);
  const metadata = structuredClone(f.records.get(reference).metadata);
  assert.equal(f.objects.get(reference).ctx.storage.alarm, alarm);
  assert.equal(f.records.size, 1);

  f.resetWrites();
  const second = await read(await f.req("/api/answers", "PUT", {
    reference, questionId: question.id, choices: [choice], revision: freshRevision,
  }, { cookie }));
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.headers.get("Set-Cookie"), null);
  assert.equal(second.body.attempt.reference, reference);
  assert.equal(second.body.attempt.revision, freshRevision);
  assert.equal(second.body.attempt.answered, 1);
  assert.deepEqual(second.body.attempt.answers, { [question.id]: [choice] });
  assert.equal(second.body.attempt.answers[question.id].length, 1);
  assert.deepEqual(second.body.attempt, first.body.attempt);
  assert.equal(second.text.includes(secret), false);
  assert.equal(second.text.includes(sessionSecret), false);
  assert.deepEqual(f.written, []);

  const afterSecond = stored(f, reference);
  assert.deepEqual(afterSecond, snapshot);
  assert.deepEqual(afterSecond.answers, { [question.id]: [choice] });
  assert.equal(Object.keys(afterSecond.answers).length, 1);
  assert.equal(afterSecond.answers[question.id].length, 1);
  assert.equal(afterSecond.answers[question.id][0], choice);
  assert.equal(afterSecond.revision, 2);
  assert.equal(afterSecond.status, "active");
  assert.equal(afterSecond.submittedAt, undefined);
  assert.equal(afterSecond.score, undefined);
  assert.deepEqual(afterSecond.paper, paper);
  assert.equal(afterSecond.inviteHash, inviteHash);
  assert.equal(afterSecond.sessionHash, sessionHash);
  assert.equal(afterSecond.inviteHash, await digest(secret));
  assert.equal(afterSecond.sessionHash, await digest(sessionSecret));
  assert.equal(JSON.stringify(afterSecond).includes(secret), false);
  assert.equal(JSON.stringify(afterSecond).includes(sessionSecret), false);
  assert.equal(f.records.get(reference).etag, freshEtag);
  assert.deepEqual(f.records.get(reference).metadata, metadata);
  assert.equal(f.objects.get(reference).ctx.storage.alarm, alarm);
  assert.equal(f.records.size, 1);

  const viewed = await read(await f.req("/api/session", "GET", undefined, { cookie, reference }));
  assert.equal(viewed.status, 200, JSON.stringify(viewed.body));
  assert.equal(viewed.headers.get("Set-Cookie"), null);
  assert.equal(viewed.body.attempt.answered, 1);
  assert.equal(viewed.body.attempt.revision, freshRevision);
  assert.deepEqual(viewed.body.attempt.answers, { [question.id]: [choice] });
  assert.equal(viewed.body.attempt.answers[question.id].length, 1);
  assert.equal(viewed.text.includes(secret), false);
  assert.equal(viewed.text.includes(sessionSecret), false);
  assert.equal(f.records.get(reference).etag, freshEtag);
  assert.equal(stored(f, reference).inviteHash, inviteHash);
  assert.equal(stored(f, reference).sessionHash, sessionHash);
  assert.deepEqual(stored(f, reference).answers, { [question.id]: [choice] });
});
