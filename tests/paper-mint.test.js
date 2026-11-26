import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import worker, { Assessment } from "../src/worker.js";

// A country that stays approved can still refuse to start. A stale notice version
// and a missing integrity acknowledgment both return before a paper is issued.
// Withdrawing the country is a different refusal and is not what this file checks.

const MINUTE = 60_000;
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
  return { env, objects, records, req, admin: { admin: true } };
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

test("a stale notice version or a missing acknowledgment does not mint a paper", async () => {
  const source = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(source, /"LIVE_ENABLED": "false"/);

  const f = fixture();
  const issued = await read(await f.req("/api/ops/invites", "POST", { country: "FR", durationMinutes: 27 }, f.admin));
  assert.equal(issued.status, 201, JSON.stringify(issued.body));
  const secret = issued.body.invite.split(".")[1];
  const before = structuredClone(stored(f, issued.body.reference));
  const etag = f.records.get(issued.body.reference).etag;
  const alarm = f.objects.get(issued.body.reference).ctx.storage.alarm;
  assert.equal(before.status, "invited");
  assert.equal(before.paper, undefined);
  assert.equal(before.notice, undefined);
  assert.equal(before.revision, 0);

  const preview = await read(await f.req("/api/invitation", "POST", { invite: issued.body.invite }));
  assert.equal(preview.status, 200);
  assert.equal(preview.body.notice.version, "test-1");
  assert.equal(preview.body.questions, undefined);
  assert.equal(preview.body.attempt, undefined);
  assert.deepEqual(stored(f, issued.body.reference), before);

  f.env.PRIVACY_NOTICE = { ...notice, version: "test-2", integrityReview: true };
  const revised = await read(await f.req("/api/invitation", "POST", { invite: issued.body.invite }));
  assert.equal(revised.status, 200);
  assert.equal(revised.body.notice.version, "test-2");
  assert.equal(revised.body.notice.integrityReview, true);
  assert.equal(revised.body.questions, undefined);
  assert.equal(revised.text.includes(secret), false);
  assert.deepEqual(stored(f, issued.body.reference), before);
  assert.equal(f.records.get(issued.body.reference).etag, etag);
  assert.equal(f.objects.get(issued.body.reference).ctx.storage.alarm, alarm);

  const staleClaim = random();
  const stale = await read(await f.req("/api/start", "POST", {
    invite: issued.body.invite, claim: staleClaim, noticeVersion: "test-1",
  }));
  assert.equal(stale.status, 409);
  assert.match(stale.body.error, /privacy notice changed/);
  assert.doesNotMatch(stale.body.error, /currently closed|integrity notice/);
  assert.equal(stale.headers.get("Set-Cookie"), null);
  assert.equal(stale.body.attempt, undefined);
  assert.equal(stale.text.includes(secret), false);
  assert.deepEqual(stored(f, issued.body.reference), before);
  assert.equal(f.records.get(issued.body.reference).etag, etag);
  assert.equal(f.objects.get(issued.body.reference).ctx.storage.alarm, alarm);

  const unackedClaim = random();
  const unacked = await read(await f.req("/api/start", "POST", {
    invite: issued.body.invite, claim: unackedClaim, noticeVersion: "test-2",
  }));
  assert.equal(unacked.status, 409);
  assert.match(unacked.body.error, /integrity notice/);
  assert.doesNotMatch(unacked.body.error, /privacy notice changed|currently closed/);
  assert.equal(unacked.headers.get("Set-Cookie"), null);
  assert.equal(unacked.body.attempt, undefined);
  assert.equal(unacked.text.includes(secret), false);
  assert.deepEqual(stored(f, issued.body.reference), before);
  assert.equal(stored(f, issued.body.reference).paper, undefined);
  assert.equal(f.records.get(issued.body.reference).etag, etag);
  assert.equal(f.objects.get(issued.body.reference).ctx.storage.alarm, alarm);

  const started = await f.req("/api/start", "POST", {
    invite: issued.body.invite, claim: random(), noticeVersion: "test-2", integrityReview: true,
  });
  const sitting = await read(started);
  assert.equal(sitting.status, 200, JSON.stringify(sitting.body));
  assert.match(started.headers.get("Set-Cookie"), /^__Host-assessment=/);
  assert.equal(sitting.body.attempt.notice.version, "test-2");
  assert.equal(sitting.body.attempt.notice.integrityReview, true);
  assert.equal(sitting.body.attempt.questions.length, 15);
  assert.equal(sitting.body.attempt.deadline - sitting.body.attempt.startedAt, 27 * MINUTE);
  assert.equal(JSON.stringify(sitting.body).includes('"key":'), false);
  const minted = stored(f, issued.body.reference);
  assert.equal(minted.status, "active");
  assert.equal(minted.revision, 1);
  assert.equal(minted.inviteHash, before.inviteHash);
  assert.equal(minted.paper.questions.length, 15);
  assert.deepEqual(minted.paper.questions.map(question => question.id), sitting.body.attempt.questions.map(question => question.id));
  const mintedEtag = f.records.get(issued.body.reference).etag;
  assert.notEqual(mintedEtag, etag);

  const replacement = await read(await f.req("/api/start", "POST", {
    invite: issued.body.invite, claim: random(), noticeVersion: "test-2", integrityReview: true,
  }));
  assert.equal(replacement.status, 403);
  assert.match(replacement.body.error, /already been used/);
  assert.equal(replacement.headers.get("Set-Cookie"), null);
  assert.equal(replacement.body.attempt, undefined);
  assert.equal(f.records.get(issued.body.reference).etag, mintedEtag);
  assert.deepEqual(stored(f, issued.body.reference).paper.questions.map(question => question.id), sitting.body.attempt.questions.map(question => question.id));
  assert.equal(stored(f, issued.body.reference).revision, 1);
});
