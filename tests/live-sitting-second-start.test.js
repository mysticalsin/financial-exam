import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import worker, { Assessment } from "../src/worker.js";

// A second start of an invitation that already has a live sitting.
// The refusal must not mint another paper, rotate the stored invite hash,
// or replace the session secret. A missed deadline, a submitted paper,
// a withdrawn country, a stale notice, and an overdue release are different
// refusals and are not what this file checks.

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

test("a second start of a live sitting is refused and leaves the paper and secrets in place", async () => {
  const source = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(source, /"LIVE_ENABLED": "false"/);

  const f = fixture();
  const issued = await read(await f.req("/api/ops/invites", "POST", { durationMinutes: 25 }, f.admin));
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
  assert.equal(record.submittedAt, undefined);
  assert.ok(record.deadline > Date.now());
  assert.equal(record.country, "FR");
  assert.equal(record.notice.version, notice.version);
  assert.equal(record.revision, 1);
  assert.equal(record.inviteHash, await digest(secret));
  assert.equal(record.sessionHash, await digest(sessionSecret));
  assert.notEqual(sessionSecret, secret);
  assert.equal(record.paper.questions.length, 15);
  assert.deepEqual(record.paper.questions.map(question => question.id), sitting.body.attempt.questions.map(question => question.id));
  const before = structuredClone(record);
  const etag = f.records.get(reference).etag;
  const alarm = f.objects.get(reference).ctx.storage.alarm;
  const prompt = sitting.body.attempt.questions[0].prompt;

  f.resetWrites();
  const otherClaim = random();
  assert.notEqual(otherClaim, claim);
  const refused = await read(await f.req("/api/start", "POST", {
    invite: issued.body.invite, claim: otherClaim, noticeVersion: notice.version,
  }));
  const refusedWithCookie = await read(await f.req("/api/start", "POST", {
    invite: issued.body.invite, claim: otherClaim, noticeVersion: notice.version,
  }, { cookie }));

  for (const response of [refused, refusedWithCookie]) {
    assert.equal(response.status, 403);
    assert.deepEqual(response.body, {
      error: "This invitation has already been used. Continue in the browser where you started.",
    });
    assert.equal(response.headers.get("Set-Cookie"), null);
    assert.equal(response.body.attempt, undefined);
    assert.equal(response.text.includes(secret), false);
    assert.equal(response.text.includes(sessionSecret), false);
    assert.equal(response.text.includes(prompt), false);
    assert.doesNotMatch(response.body.error, /privacy notice changed|currently closed|full time allowance|assessment has closed|Another assessment is active/);
  }

  assert.equal(f.writes(), 0);
  assert.equal(f.records.get(reference).etag, etag);
  assert.equal(f.objects.get(reference).ctx.storage.alarm, alarm);
  assert.equal(f.records.size, 1);
  const after = stored(f, reference);
  assert.deepEqual(after, before);
  assert.equal(after.inviteHash, await digest(secret));
  assert.equal(after.sessionHash, await digest(sessionSecret));
  assert.notEqual(after.sessionHash, await digest("assessment-session-v1/" + secret + "/" + otherClaim));
  assert.deepEqual(after.paper, before.paper);
  assert.equal(after.status, "active");
  assert.equal(after.revision, 1);
  assert.equal(after.submittedAt, undefined);
  assert.ok(after.deadline > Date.now());

  const resumed = await read(await f.req("/api/session", "GET", undefined, { cookie, reference }));
  assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
  assert.equal(resumed.body.attempt.status, "active");
  assert.deepEqual(resumed.body.attempt.questions.map(question => question.id), before.paper.questions.map(question => question.id));
  assert.equal(resumed.headers.get("Set-Cookie"), null);
  assert.equal(f.records.get(reference).etag, etag);
  assert.equal(stored(f, reference).sessionHash, await digest(sessionSecret));
  assert.equal(stored(f, reference).inviteHash, before.inviteHash);
});
