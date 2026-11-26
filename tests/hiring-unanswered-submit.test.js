import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import worker, { Assessment } from "../src/worker.js";

// POST /api/submit while one or more issued hiring items are still unanswered.
// The refusal leaves the sitting active: no sealed score, no finish time, and
// the saved answers stay. The invite hash and the session secret stay put.
// Practice item count, the post-attempt finish instant, a second start, a bad
// body, practice isolation, and a wrong method (404) are separate refusals.

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

async function issue(f) {
  const issued = await read(await f.req("/api/ops/invites", "POST", { durationMinutes: 20 }, f.admin));
  assert.equal(issued.status, 201, JSON.stringify(issued.body));
  const secret = issued.body.invite.split(".")[1];
  const record = stored(f, issued.body.reference);
  assert.equal(record.inviteHash, await digest(secret));
  assert.equal(record.status, "invited");
  assert.equal(record.paper, undefined);
  assert.equal(record.sessionHash, undefined);
  assert.equal(record.score, undefined);
  assert.equal(record.submittedAt, undefined);
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
  assert.equal(record.submittedAt, undefined);
  assert.ok(record.paper.questions.length >= 2);
  assert.equal(record.inviteHash, await digest(invite.secret));
  assert.equal(record.sessionHash, await digest(sessionSecret));
  assert.notEqual(sessionSecret, invite.secret);
  return { cookie, sessionSecret, sitting };
}

async function saveSome(f, invite, cookie, questions, savedCount, revision) {
  const saved = {};
  for (const question of questions.slice(0, savedCount)) {
    const choices = [question.options[0].id];
    const response = await read(await f.req("/api/answers", "PUT", {
      reference: invite.reference, questionId: question.id, choices, revision,
    }, { cookie }));
    assert.equal(response.status, 200, "save " + savedCount);
    revision = response.body.attempt.revision;
    saved[question.id] = choices;
  }
  return { saved, revision };
}

async function refuseUnanswered(savedCount) {
  const f = fixture();
  const invite = await issue(f);
  const { cookie, sessionSecret, sitting } = await begin(f, invite);
  const questions = sitting.body.attempt.questions;
  assert.ok(savedCount >= 1 && savedCount < questions.length, "partial paper " + savedCount);
  const savedState = await saveSome(f, invite, cookie, questions, savedCount, sitting.body.attempt.revision);
  const record = stored(f, invite.reference);
  assert.equal(record.status, "active");
  assert.equal(record.score, undefined);
  assert.equal(record.submittedAt, undefined);
  assert.equal(record.revision, savedState.revision);
  assert.deepEqual(record.answers, savedState.saved);
  assert.equal(Object.keys(record.answers).length, savedCount);
  assert.equal(record.inviteHash, await digest(invite.secret));
  assert.equal(record.sessionHash, await digest(sessionSecret));
  assert.ok(record.deadline > Date.now());
  const before = structuredClone(record);
  const etag = f.records.get(invite.reference).etag;
  const alarm = f.objects.get(invite.reference).ctx.storage.alarm;
  assert.equal(alarm, record.purgeAt);
  const prompt = questions[savedCount].prompt;

  f.resetWrites();
  const refused = await read(await f.req("/api/submit", "POST", {
    reference: invite.reference, revision: savedState.revision,
  }, { cookie }));

  assert.equal(refused.status, 409, "saved " + savedCount);
  assert.deepEqual(refused.body, { error: "Answer every question before submitting." });
  assert.equal(refused.headers.get("Set-Cookie"), null);
  assert.equal(refused.body.attempt, undefined);
  assert.equal(refused.body.score, undefined);
  assert.equal(refused.text.includes(invite.secret), false);
  assert.equal(refused.text.includes(sessionSecret), false);
  assert.equal(refused.text.includes(prompt), false);
  assert.equal(f.writes(), 0);
  assert.equal(f.records.size, 1);
  assert.equal(f.records.get(invite.reference).etag, etag);
  assert.equal(f.objects.get(invite.reference).ctx.storage.alarm, alarm);
  const after = stored(f, invite.reference);
  assert.deepEqual(after, before);
  assert.equal(after.status, "active");
  assert.equal(after.score, undefined);
  assert.equal(after.submittedAt, undefined);
  assert.equal(after.purgeAt, before.purgeAt);
  assert.equal(after.revision, savedState.revision);
  assert.deepEqual(after.answers, savedState.saved);
  assert.deepEqual(after.paper, before.paper);
  assert.equal(after.inviteHash, await digest(invite.secret));
  assert.equal(after.sessionHash, await digest(sessionSecret));

  const viewed = await read(await f.req("/api/session", "GET", undefined, {
    cookie, reference: invite.reference,
  }));
  assert.equal(viewed.status, 200, JSON.stringify(viewed.body));
  assert.equal(viewed.headers.get("Set-Cookie"), null);
  assert.equal(viewed.body.attempt.status, "active");
  assert.equal(viewed.body.attempt.submittedAt, null);
  assert.equal(viewed.body.attempt.answered, savedCount);
  assert.deepEqual(viewed.body.attempt.answers, savedState.saved);
  assert.equal(viewed.body.attempt.questions.length, questions.length);
  assert.equal(Object.hasOwn(viewed.body.attempt, "score"), false);
  assert.equal(viewed.body.attempt.purgeAt, before.purgeAt);

  const exported = await read(await f.req("/api/ops/attempts/" + invite.reference, "GET", undefined, f.admin));
  assert.equal(exported.status, 200, JSON.stringify(exported.body));
  assert.equal(exported.body.status, "active");
  assert.equal(exported.body.score, null);
  assert.equal(exported.body.submittedAt, null);
  assert.equal(exported.body.answered, savedCount);
  assert.equal(exported.body.responses, undefined);
  assert.equal(exported.body.purgeAt, before.purgeAt);
  assert.equal(exported.text.includes(invite.secret), false);
  assert.equal(exported.text.includes(sessionSecret), false);
  assert.equal(f.records.get(invite.reference).etag, etag);
  assert.equal(stored(f, invite.reference).inviteHash, before.inviteHash);
  assert.equal(stored(f, invite.reference).sessionHash, before.sessionHash);
  return questions.length;
}

test("a hiring submit with unanswered items is refused and leaves the sitting unsealed", async () => {
  const source = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(source, /"LIVE_ENABLED": "false"/);

  const total = await refuseUnanswered(1);
  await refuseUnanswered(total - 1);
});
