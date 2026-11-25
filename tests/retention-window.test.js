import test from "node:test";
import assert from "node:assert/strict";
import worker, { Assessment } from "../src/worker.js";

// Incomplete-sitting retention for a duration whose deadline plus 30 minutes
// falls before the hard end. The fixture is in memory. The checked-in flag stays false.

const origin = "https://assessment.example";
const MINUTE = 60_000;
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
    ASSETS: { async fetch() { return new Response("Test page"); } },
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
  const admin = { admin: true };
  return { env, objects, records, req, admin };
}

test("a 15-minute sitting is retained until 30 minutes after its deadline when that is earlier than the hard end", async () => {
  const f = fixture();
  const issued = await f.req("/api/ops/invites", "POST", { durationMinutes: 15 }, f.admin);
  assert.equal(issued.status, 201);
  const invite = await issued.json();
  const started = await f.req("/api/start", "POST", {
    invite: invite.invite, claim: random(), noticeVersion: notice.version,
  });
  assert.equal(started.status, 200);
  const body = await started.json();
  const record = f.records.get(invite.reference).record;
  const cutoff = record.deadline + 30 * MINUTE;

  assert.equal(record.durationMinutes, 15);
  assert.equal(record.deadline - record.startedAt, 15 * MINUTE);
  assert.equal(record.hardEnd - record.issuedAt, 60 * MINUTE);
  assert.equal(record.purgeAt, cutoff);
  assert.ok(cutoff < record.hardEnd);
  assert.ok(record.hardEnd - cutoff > 10 * MINUTE);
  assert.equal(body.attempt.purgeAt, cutoff);
  assert.equal(body.attempt.status, "active");

  const maxAge = Number(/Max-Age=(\d+)/.exec(started.headers.get("Set-Cookie"))[1]);
  assert.ok(Math.abs(maxAge - Math.floor((cutoff - Date.now()) / 1000)) <= 2);
  assert.ok(maxAge < Math.floor((record.hardEnd - Date.now()) / 1000) - 60);

  assert.equal(f.objects.get(invite.reference).ctx.storage.alarm, cutoff);
  assert.equal(f.records.get(invite.reference).metadata.purgeAt, String(cutoff));
  assert.equal(f.records.get(invite.reference).metadata.compactAt, undefined);

  const exported = await f.req("/api/ops/attempts/" + invite.reference, "GET", undefined, f.admin);
  assert.equal(exported.status, 200);
  assert.equal((await exported.json()).purgeAt, cutoff);

  f.records.get(invite.reference).record.deadline = Date.now() - 1;
  const cookie = started.headers.get("Set-Cookie").split(";")[0];
  const closed = await f.req("/api/session", "GET", undefined, { cookie, reference: invite.reference });
  assert.equal(closed.status, 200);
  const expired = await closed.json();
  assert.equal(expired.attempt.status, "expired");
  assert.equal(expired.attempt.purgeAt, cutoff);
  assert.equal(f.records.has(invite.reference), true);
  assert.equal(f.records.get(invite.reference).record.purgeAt, cutoff);
  assert.equal(f.records.get(invite.reference).metadata.purgeAt, String(cutoff));
  assert.equal(f.objects.get(invite.reference).ctx.storage.alarm, cutoff);

  const afterDeadline = await f.req("/api/ops/attempts/" + invite.reference, "GET", undefined, f.admin);
  assert.equal(afterDeadline.status, 200);
  const staff = await afterDeadline.json();
  assert.equal(staff.status, "expired");
  assert.equal(staff.purgeAt, cutoff);
});
