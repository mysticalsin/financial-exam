import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import worker, { Assessment } from "../src/worker.js";

// An outstanding hiring invitation must survive a practice start and a practice
// score from the same browser. The invitation stays unclaimed, its hash does
// not change, and a later hiring start still mints one paper for the original
// duration.
// The repository practice timer, the practice item count, a second start of a
// live sitting, and a bad hiring body are separate checks. This file does not
// lock those.

const origin = "https://assessment.example";
const browserIp = "192.0.2.44";
const originalDuration = 22;
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
    DURATION_MINUTES: 30, INVITE_TTL_MINUTES: 30, PRACTICE_KEY: "a".repeat(64),
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
      async delete(key) {
        writes += 1;
        records.delete(key);
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

test("practice start and score leave an outstanding hiring invitation unclaimed", async () => {
  const source = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(source, /"LIVE_ENABLED": "false"/);

  const f = fixture();
  const issued = await read(await f.req("/api/ops/invites", "POST", { durationMinutes: originalDuration }, f.admin));
  assert.equal(issued.status, 201, JSON.stringify(issued.body));
  const reference = issued.body.reference;
  const secret = issued.body.invite.split(".")[1];
  const inviteHash = await digest(secret);
  assert.equal(issued.body.durationMinutes, originalDuration);
  assert.notEqual(originalDuration, f.env.DURATION_MINUTES);

  const browser = { headers: { "CF-Connecting-IP": browserIp } };
  const preview = await read(await f.req("/api/invitation", "POST", { invite: issued.body.invite }, browser));
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.resume, false);
  assert.equal(preview.body.durationMinutes, originalDuration);
  assert.equal(preview.body.attempt, undefined);
  assert.equal(preview.headers.get("Set-Cookie"), null);

  const before = structuredClone(stored(f, reference));
  assert.equal(before.status, "invited");
  assert.equal(before.inviteHash, inviteHash);
  assert.equal(before.durationMinutes, originalDuration);
  assert.equal(before.sessionHash, undefined);
  assert.equal(before.paper, undefined);
  assert.equal(before.revision, 0);
  const etag = f.records.get(reference).etag;
  const alarm = f.objects.get(reference).ctx.storage.alarm;
  assert.equal(f.records.size, 1);

  f.resetWrites();
  const started = await read(await f.req("/api/practice/start", "POST", {}, browser));
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.match(started.body.challenge, /^p1\.[A-Za-z\d_-]+$/);
  assert.equal(started.headers.get("Set-Cookie"), null);
  assert.equal(started.text.includes(secret), false);
  assert.equal(started.text.includes(reference), false);

  const answers = Object.fromEntries(started.body.questions.map(question => [question.id, question.options[0].id]));
  const scored = await read(await f.req("/api/practice/submit", "POST", {
    challenge: started.body.challenge, answers,
  }, browser));
  assert.equal(scored.status, 200, JSON.stringify(scored.body));
  assert.equal(typeof scored.body.score, "number");
  assert.equal(scored.headers.get("Set-Cookie"), null);
  assert.equal(scored.body.invite, undefined);
  assert.equal(scored.body.reference, undefined);
  assert.equal(scored.text.includes(secret), false);

  assert.equal(f.writes(), 0);
  assert.equal(f.records.size, 1);
  assert.equal(f.records.get(reference).etag, etag);
  assert.equal(f.objects.get(reference).ctx.storage.alarm, alarm);
  const afterPractice = stored(f, reference);
  assert.deepEqual(afterPractice, before);
  assert.equal(afterPractice.status, "invited");
  assert.equal(afterPractice.inviteHash, inviteHash);
  assert.equal(afterPractice.sessionHash, undefined);
  assert.equal(afterPractice.paper, undefined);
  assert.equal(afterPractice.durationMinutes, originalDuration);

  const stillOpen = await read(await f.req("/api/invitation", "POST", { invite: issued.body.invite }, browser));
  assert.equal(stillOpen.status, 200, JSON.stringify(stillOpen.body));
  assert.equal(stillOpen.body.resume, false);
  assert.equal(stillOpen.body.durationMinutes, originalDuration);
  assert.equal(stillOpen.headers.get("Set-Cookie"), null);
  assert.deepEqual(stored(f, reference), before);

  const claim = random();
  const sitting = await read(await f.req("/api/start", "POST", {
    invite: issued.body.invite, claim, noticeVersion: notice.version,
  }, browser));
  assert.equal(sitting.status, 200, JSON.stringify(sitting.body));
  assert.match(sitting.headers.get("Set-Cookie") ?? "", /^__Host-assessment=/);
  assert.equal(f.records.size, 1);
  const minted = stored(f, reference);
  assert.equal(minted.status, "active");
  assert.equal(minted.revision, 1);
  assert.equal(minted.inviteHash, inviteHash);
  assert.equal(minted.durationMinutes, originalDuration);
  assert.equal(minted.deadline - minted.startedAt, originalDuration * 60 * 1000);
  assert.equal(minted.paper.questions.length, 15);
  assert.deepEqual(
    minted.paper.questions.map(question => question.id),
    sitting.body.attempt.questions.map(question => question.id),
  );
  assert.equal(sitting.body.attempt.total, minted.paper.questions.length);
  assert.equal(Object.keys(minted.answers).length, 0);

  const cookie = sitting.headers.get("Set-Cookie").split(";")[0];
  const resumed = await read(await f.req("/api/session", "GET", undefined, { ...browser, cookie, reference }));
  assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
  assert.equal(resumed.body.attempt.status, "active");
  assert.deepEqual(
    resumed.body.attempt.questions.map(question => question.id),
    minted.paper.questions.map(question => question.id),
  );
  assert.equal(stored(f, reference).inviteHash, inviteHash);
  assert.equal(stored(f, reference).durationMinutes, originalDuration);
  assert.equal(f.records.size, 1);
});
