import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import worker, { Assessment } from "../src/worker.js";

// A JSON array and a JSON null on hiring start and on answer save.
// Both parse as JSON, so they are distinct from a non-JSON or empty body
// and from an object that carries an extra field. The Worker refuses them
// before it mints a paper or writes an answer. The invite hash stays put.
// The refused start mints no session. The answer case keeps the session
// from its own successful start.

const origin = "https://assessment.example";
const notice = {
  controller: "Test controller", contact: "privacy@example.invalid", basis: "Test basis",
  recipients: "Test reviewer", transfers: "Test transfer description", rights: "Test rights",
  purpose: "Test purpose", supervisoryAuthority: "Test authority", version: "test-1", retentionMinutes: 30,
};
const random = () => crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");

// Valid JSON that is not an object. An empty array is still an array, not an empty body.
const shapes = [
  ["empty array", "[]"],
  ["array", "[{\"invite\":\"not-used\"}]"],
  ["null", "null"],
];

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

function raw(f, path, method, body, cookie) {
  const parsed = JSON.parse(body);
  assert.ok(Array.isArray(parsed) || parsed === null, body);
  const headers = { Origin: origin, "Content-Type": "application/json" };
  if (cookie) headers.Cookie = cookie;
  return worker.fetch(new Request(origin + path, { method, headers, body }), f.env);
}

async function issue(f) {
  const issued = await read(await f.req("/api/ops/invites", "POST", { durationMinutes: 20 }, f.admin));
  assert.equal(issued.status, 201, JSON.stringify(issued.body));
  const secret = issued.body.invite.split(".")[1];
  const record = stored(f, issued.body.reference);
  assert.equal(record.inviteHash, await digest(secret));
  assert.equal(record.status, "invited");
  assert.equal(record.paper, undefined);
  assert.equal(record.answers, undefined);
  assert.equal(record.sessionHash, undefined);
  assert.equal(record.revision, 0);
  return { ...issued.body, secret, inviteHash: record.inviteHash };
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
  assert.equal(record.paper.questions.length, 15);
  assert.equal(record.inviteHash, invite.inviteHash);
  assert.equal(record.sessionHash, await digest(sessionSecret));
  assert.notEqual(sessionSecret, invite.secret);
  assert.equal(cookie, "__Host-assessment=" + invite.reference + "." + sessionSecret);
  return { cookie, sessionSecret, sitting, claim };
}

test("a JSON array or null start body is refused and does not mint a paper", async () => {
  const source = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(source, /"LIVE_ENABLED": "false"/);

  const f = fixture();
  const invite = await issue(f);
  const before = structuredClone(stored(f, invite.reference));
  const etag = f.records.get(invite.reference).etag;
  const alarm = f.objects.get(invite.reference).ctx.storage.alarm;
  const metadata = structuredClone(f.records.get(invite.reference).metadata);

  f.resetWrites();
  for (const [label, body] of shapes) {
    const response = await read(await raw(f, "/api/start", "POST", body));
    assert.equal(response.status, 400, label);
    assert.deepEqual(response.body, { error: "Please check the request." }, label);
    assert.equal(response.headers.get("Set-Cookie"), null, label);
    assert.equal(response.body.attempt, undefined, label);
    assert.equal(response.text.includes(invite.secret), false, label);
    assert.doesNotMatch(response.body.error, /already been used|privacy notice changed|currently closed|full time allowance|assessment has closed|Another assessment is active|Route not found|JSON request is required|Answer every question/, label);
    assert.equal(f.writes(), 0, label);
    assert.equal(f.records.size, 1, label);
    assert.equal(f.records.get(invite.reference).etag, etag, label);
    assert.equal(f.objects.get(invite.reference).ctx.storage.alarm, alarm, label);
    assert.deepEqual(f.records.get(invite.reference).metadata, metadata, label);
    assert.deepEqual(stored(f, invite.reference), before, label);
  }

  const after = stored(f, invite.reference);
  assert.equal(after.status, "invited");
  assert.equal(after.paper, undefined);
  assert.equal(after.answers, undefined);
  assert.equal(after.sessionHash, undefined);
  assert.equal(after.revision, 0);
  assert.equal(after.inviteHash, invite.inviteHash);
  assert.equal(after.inviteHash, await digest(invite.secret));

  const started = await begin(f, invite);
  assert.match(started.sitting.headers.get("Set-Cookie"), /^__Host-assessment=/);
  const minted = stored(f, invite.reference);
  assert.equal(minted.status, "active");
  assert.equal(minted.paper.questions.length, 15);
  assert.equal(minted.inviteHash, invite.inviteHash);
  assert.equal(minted.sessionHash, await digest(started.sessionSecret));
  assert.notEqual(started.sessionSecret, invite.secret);
});

test("a JSON array or null answer body is refused and does not write an answer", async () => {
  const f = fixture();
  const invite = await issue(f);
  const { cookie, sessionSecret, sitting } = await begin(f, invite);
  const question = sitting.body.attempt.questions[0];
  const choice = question.options[0].id;
  const before = structuredClone(stored(f, invite.reference));
  const etag = f.records.get(invite.reference).etag;
  const alarm = f.objects.get(invite.reference).ctx.storage.alarm;
  const metadata = structuredClone(f.records.get(invite.reference).metadata);
  assert.equal(before.inviteHash, invite.inviteHash);
  assert.equal(before.sessionHash, await digest(sessionSecret));
  assert.deepEqual(before.answers, {});

  f.resetWrites();
  for (const [label, body] of shapes) {
    const response = await read(await raw(f, "/api/answers", "PUT", body, cookie));
    assert.equal(response.status, 400, label);
    assert.deepEqual(response.body, { error: "Please check the request." }, label);
    assert.equal(response.headers.get("Set-Cookie"), null, label);
    assert.equal(response.body.attempt, undefined, label);
    assert.equal(response.text.includes(invite.secret), false, label);
    assert.equal(response.text.includes(sessionSecret), false, label);
    assert.equal(response.text.includes(question.prompt), false, label);
    assert.doesNotMatch(response.body.error, /another tab|record changed|available answer|Choose a question|assessment has closed|privacy notice changed|currently closed|Route not found|JSON request is required|Answer every question/, label);
    assert.equal(f.writes(), 0, label);
    assert.equal(f.records.size, 1, label);
    assert.equal(f.records.get(invite.reference).etag, etag, label);
    assert.equal(f.objects.get(invite.reference).ctx.storage.alarm, alarm, label);
    assert.deepEqual(f.records.get(invite.reference).metadata, metadata, label);
    assert.deepEqual(stored(f, invite.reference), before, label);
  }

  const after = stored(f, invite.reference);
  assert.equal(after.status, "active");
  assert.deepEqual(after.answers, {});
  assert.equal(after.revision, 1);
  assert.deepEqual(after.paper, before.paper);
  assert.equal(after.inviteHash, invite.inviteHash);
  assert.equal(after.sessionHash, before.sessionHash);
  assert.equal(after.sessionHash, await digest(sessionSecret));

  const saved = await read(await f.req("/api/answers", "PUT", {
    reference: invite.reference,
    questionId: question.id,
    choices: [choice],
    revision: sitting.body.attempt.revision,
  }, { cookie }));
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.headers.get("Set-Cookie"), null);
  assert.deepEqual(saved.body.attempt.answers, { [question.id]: [choice] });
  assert.equal(saved.text.includes(invite.secret), false);
  assert.equal(saved.text.includes(sessionSecret), false);
  const written = stored(f, invite.reference);
  assert.deepEqual(written.answers, { [question.id]: [choice] });
  assert.equal(written.revision, 2);
  assert.deepEqual(written.paper, before.paper);
  assert.equal(written.inviteHash, invite.inviteHash);
  assert.equal(written.sessionHash, before.sessionHash);
  assert.equal(written.status, "active");
  assert.equal(f.records.size, 1);
});
