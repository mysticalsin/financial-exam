import test from "node:test";
import assert from "node:assert/strict";
import worker, { Assessment } from "../src/worker.js";

// The operator suite only checks that invite calls leave 64-hex limiter keys.
// A session secret, an operator token, and the practice rate salt are also 64 hex
// characters, and a session write passes the attempt reference into the limiter.
// Those inputs must not be the key the limiter stores.

const origin = "https://assessment.example";
const notice = {
  controller: "Test controller", contact: "privacy@example.invalid", basis: "Test basis",
  recipients: "Test reviewer", transfers: "Test transfer description", rights: "Test rights",
  purpose: "Test purpose", supervisoryAuthority: "Test authority", version: "test-1", retentionMinutes: 30,
};
const random = () => crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
const digestKey = /^[0-9a-f]{64}$/;

function fixture() {
  const objects = new Map();
  const records = new Map();
  const limiterCalls = [];
  const env = {
    LIVE_ENABLED: "true", PRIVACY_COUNTRY: "FR", PRIVACY_NOTICE: { ...notice }, OPS_TOKEN: random(),
    ACCESS_ISSUER: "https://synthetic-test.cloudflareaccess.com", ACCESS_AUD: "a".repeat(64), DURATION_MINUTES: 30,
    RATE_LIMITER: { async limit(argument) { limiterCalls.push(argument); return { success: true }; } },
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
        return { objects: [...records].map(([key, entry]) => ({ key, customMetadata: entry.metadata })), truncated: false };
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
  async function issue() {
    const response = await req("/api/ops/invites", "POST", {}, { admin: true });
    assert.equal(response.status, 201);
    return response.json();
  }
  async function start(invite) {
    const response = await req("/api/start", "POST", { invite: invite.invite, claim: random(), noticeVersion: notice.version });
    assert.equal(response.status, 200);
    const cookie = response.headers.get("Set-Cookie").split(";")[0];
    const [, reference, secret] = /^__Host-assessment=([0-9a-f]{32})\.([0-9a-f]{64})$/.exec(cookie);
    return { cookie, reference, secret, ...(await response.json()) };
  }
  return { env, limiterCalls, req, issue, start };
}

function assertDigestOnly(calls, raw) {
  assert.ok(calls.length > 0);
  for (const call of calls) {
    assert.deepEqual(Object.keys(call), ["key"]);
    assert.match(call.key, digestKey);
    for (const value of raw) {
      assert.notEqual(call.key, value);
      assert.equal(call.key.includes(value), false);
    }
  }
}

test("session limiter keys are digests, not the reference, session secret, address, or operator token", async () => {
  const f = fixture();
  const ip = "192.0.2.10";
  const started = await f.start(await f.issue());
  const question = started.attempt.questions[0];
  f.limiterCalls.length = 0;
  const saved = await f.req("/api/answers", "PUT", {
    reference: started.reference, questionId: question.id, choices: [question.options[0].id], revision: started.attempt.revision,
  }, { cookie: started.cookie, headers: { "CF-Connecting-IP": ip } });
  assert.equal(saved.status, 200);
  assert.equal(f.limiterCalls.length, 2, "a session write spends a network digest and an attempt digest");
  assert.notEqual(f.limiterCalls[0].key, f.limiterCalls[1].key);
  assertDigestOnly(f.limiterCalls, [started.reference, started.secret, started.cookie, f.env.OPS_TOKEN, ip, "local"]);
});

test("practice limiter keys are digests, not the rate salt or the client address", async () => {
  const ip = "192.0.2.40";
  const rateKey = "b".repeat(64);
  const calls = [];
  const env = {
    PRACTICE_KEY: "a".repeat(64),
    RATE_KEY: rateKey,
    RATE_LIMITER: { async limit(argument) { calls.push(argument); return { success: true }; } },
  };
  const response = await worker.fetch(new Request(origin + "/api/practice/start", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json", "CF-Connecting-IP": ip },
    body: "{}",
  }), env);
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assertDigestOnly(calls, [rateKey, env.PRACTICE_KEY, ip, "local"]);
});
