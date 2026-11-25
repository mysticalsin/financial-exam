import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import worker, { Assessment } from "../src/worker.js";

// Preview of an invitation that was already claimed, while that country stays approved.
// Withdrawing the country is a different refusal and is not what this file checks.

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
  return { env, records, req, admin: { admin: true } };
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

async function issue(f, durationMinutes) {
  const issued = await read(await f.req("/api/ops/invites", "POST", { durationMinutes }, f.admin));
  assert.equal(issued.status, 201, JSON.stringify(issued.body));
  return issued.body;
}

async function start(f, issued) {
  const response = await f.req("/api/start", "POST", {
    invite: issued.invite, claim: random(), noticeVersion: notice.version,
  });
  const sitting = await read(response);
  assert.equal(sitting.status, 200, JSON.stringify(sitting.body));
  return { cookie: response.headers.get("Set-Cookie").split(";")[0], ...sitting.body };
}

function assertUsed(parsed, secret, prompt) {
  assert.equal(parsed.status, 403);
  assert.deepEqual(parsed.body, { error: "This invitation has already been used." });
  assert.equal(parsed.headers.get("Set-Cookie"), null);
  assert.equal(parsed.text.includes(secret), false);
  assert.equal(parsed.text.includes(prompt), false);
}

test("preview of a claimed invitation stays closed without that sitting's session", async () => {
  const source = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(source, /"LIVE_ENABLED": "false"/);

  const f = fixture();
  const issued = await issue(f, 27);
  const other = await issue(f, 18);
  const secret = issued.invite.split(".")[1];
  const open = await read(await f.req("/api/invitation", "POST", { invite: issued.invite }));
  assert.equal(open.status, 200, JSON.stringify(open.body));
  assert.equal(open.body.resume, false);
  assert.equal(open.body.attempt, undefined);
  assert.equal(open.text.includes(secret), false);

  const before = f.records.get(issued.reference).etag;
  const malformed = await read(await f.req("/api/invitation", "POST", { invite: secret }));
  assert.equal(malformed.status, 403);
  assert.equal(malformed.body.error, "This invitation is unavailable. Please contact your recruiter.");
  assert.doesNotMatch(malformed.body.error, /already been used|currently closed/);
  assert.equal(malformed.text.includes(secret), false);
  assert.equal(f.records.get(issued.reference).etag, before);
  const unknown = "ab".repeat(16) + "." + "cd".repeat(32);
  assert.equal(unknown.startsWith(issued.reference), false);
  assert.equal(unknown.startsWith(other.reference), false);
  const missing = await read(await f.req("/api/invitation", "POST", { invite: unknown }));
  assert.equal(missing.status, 403);
  assert.equal(missing.body.error, "This invitation is unavailable. Please contact your recruiter.");
  assert.equal(f.records.size, 2);
  assert.equal(stored(f, issued.reference).status, "invited");
  assert.equal(stored(f, issued.reference).paper, undefined);

  const sitting = await start(f, issued);
  const elsewhere = await start(f, other);
  const prompt = sitting.attempt.questions[0].prompt;
  const etag = f.records.get(issued.reference).etag;
  const otherEtag = f.records.get(other.reference).etag;
  const preview = cookie => f.req("/api/invitation", "POST", { invite: issued.invite }, { cookie });

  const absent = await read(await preview());
  assertUsed(absent, secret, prompt);
  const foreign = await read(await preview(elsewhere.cookie));
  assertUsed(foreign, secret, prompt);
  assert.doesNotMatch(foreign.body.error, /Another assessment is active/);
  const inviteAsCookie = "__Host-assessment=" + issued.invite;
  const reusedSecret = await read(await preview(inviteAsCookie));
  assertUsed(reusedSecret, secret, prompt);
  assert.equal(f.records.get(issued.reference).etag, etag);
  assert.equal(f.records.get(other.reference).etag, otherEtag);
  assert.equal(stored(f, issued.reference).status, "active");
  assert.equal(stored(f, other.reference).status, "active");

  const owner = await read(await preview(sitting.cookie));
  assert.equal(owner.status, 200, JSON.stringify(owner.body));
  assert.equal(owner.body.resume, true);
  assert.equal(owner.body.attempt.status, "active");
  assert.equal(owner.body.attempt.questions[0].prompt, prompt);
  assert.equal(Object.hasOwn(owner.body, "score"), false);
  assert.equal(Object.hasOwn(owner.body.attempt, "score"), false);
  assert.equal(f.records.get(issued.reference).etag, etag);
});

test("preview of a submitted paper stays closed and does not reveal the score", async () => {
  const f = fixture();
  const issued = await issue(f, 22);
  const other = await issue(f, 16);
  const sitting = await start(f, issued);
  const elsewhere = await start(f, other);
  const prompt = sitting.attempt.questions[0].prompt;
  const secret = issued.invite.split(".")[1];
  let revision = sitting.attempt.revision;
  const key = stored(f, issued.reference).paper.key;
  for (const question of sitting.attempt.questions) {
    const saved = await read(await f.req("/api/answers", "PUT", {
      reference: issued.reference, questionId: question.id, choices: key[question.id], revision,
    }, { cookie: sitting.cookie }));
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    revision = saved.body.attempt.revision;
  }
  const submitted = await read(await f.req("/api/submit", "POST", {
    reference: issued.reference, revision,
  }, { cookie: sitting.cookie }));
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  assert.equal(submitted.body.attempt.status, "submitted");
  assert.equal(Object.hasOwn(submitted.body.attempt, "score"), false);
  const score = stored(f, issued.reference).score;
  assert.equal(typeof score, "number");
  const etag = f.records.get(issued.reference).etag;
  const preview = cookie => f.req("/api/invitation", "POST", { invite: issued.invite }, { cookie });

  for (const cookie of [undefined, elsewhere.cookie, "__Host-assessment=" + issued.invite]) {
    const denied = await read(await preview(cookie));
    assertUsed(denied, secret, prompt);
    assert.equal(f.records.get(issued.reference).etag, etag);
  }
  assert.equal(stored(f, issued.reference).status, "submitted");
  assert.equal(stored(f, issued.reference).score, score);

  const owner = await read(await preview(sitting.cookie));
  assert.equal(owner.status, 200, JSON.stringify(owner.body));
  assert.equal(owner.body.resume, true);
  assert.equal(owner.body.attempt.status, "submitted");
  assert.deepEqual(owner.body.attempt.questions, []);
  assert.equal(Object.hasOwn(owner.body.attempt, "score"), false);
  assert.equal(owner.text.includes(prompt), false);
  assert.equal(owner.text.includes(secret), false);
  assert.equal(f.records.get(issued.reference).etag, etag);
});
