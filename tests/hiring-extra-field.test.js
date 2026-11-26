import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import worker, { Assessment } from "../src/worker.js";

// A JSON object that is otherwise a hiring start or an answer save, plus one
// unexpected field. The Worker refuses that body before it mints a paper or
// writes an answer, so the field is not stored on the invitation, paper,
// answer, or record. The invite hash stays put. The refused start mints no
// session; the answer case keeps the session from its own successful start.
// A non-JSON body, a wrong method, an unanswered submit, and two live sittings
// are different requests and are not what this file checks.

const origin = "https://assessment.example";
const notice = {
  controller: "Test controller", contact: "privacy@example.invalid", basis: "Test basis",
  recipients: "Test reviewer", transfers: "Test transfer description", rights: "Test rights",
  purpose: "Test purpose", supervisoryAuthority: "Test authority", version: "test-1", retentionMinutes: 30,
};
const random = () => crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
const EXTRA_KEY = "unexpected";
const EXTRA_VALUE = "extra-field-not-stored";

async function digest(value) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

function hasKey(value, key) {
  if (!value || typeof value !== "object") return false;
  if (Object.hasOwn(value, key)) return true;
  return Object.values(value).some(item => hasKey(item, key));
}

function mentions(value, needle) {
  if (typeof value === "string") return value.includes(needle);
  if (!value || typeof value !== "object") return false;
  return Object.values(value).some(item => mentions(item, needle));
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

function assertFieldAbsent(record, label) {
  assert.equal(hasKey(record, EXTRA_KEY), false, label);
  assert.equal(mentions(record, EXTRA_VALUE), false, label);
  if (record.paper) {
    assert.equal(hasKey(record.paper, EXTRA_KEY), false, label + " paper");
    assert.equal(mentions(record.paper, EXTRA_VALUE), false, label + " paper");
  }
  if (record.answers) {
    assert.equal(hasKey(record.answers, EXTRA_KEY), false, label + " answers");
    assert.equal(mentions(record.answers, EXTRA_VALUE), false, label + " answers");
  }
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
  assertFieldAbsent(record, "issued invitation");
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
  assertFieldAbsent(record, "started sitting");
  assert.equal(mentions(sitting.body, EXTRA_VALUE), false);
  return { cookie, sessionSecret, sitting, claim };
}

test("an extra JSON field on hiring start is refused and stores nothing", async () => {
  const source = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(source, /"LIVE_ENABLED": "false"/);

  const f = fixture();
  const invite = await issue(f);
  const claim = random();
  const valid = { invite: invite.invite, claim, noticeVersion: notice.version };
  const before = structuredClone(stored(f, invite.reference));
  const etag = f.records.get(invite.reference).etag;
  const alarm = f.objects.get(invite.reference).ctx.storage.alarm;
  const metadata = structuredClone(f.records.get(invite.reference).metadata);

  f.resetWrites();
  const refused = await read(await f.req("/api/start", "POST", { ...valid, [EXTRA_KEY]: EXTRA_VALUE }));

  assert.equal(refused.status, 400);
  assert.deepEqual(refused.body, { error: "Please check the request." });
  assert.equal(refused.headers.get("Set-Cookie"), null);
  assert.equal(refused.body.attempt, undefined);
  assert.equal(refused.text.includes(invite.secret), false);
  assert.equal(refused.text.includes(EXTRA_VALUE), false);
  assert.doesNotMatch(refused.body.error, /already been used|privacy notice changed|currently closed|full time allowance|assessment has closed|Another assessment is active|Route not found|JSON request is required|Answer every question/);
  assert.equal(f.writes(), 0);
  assert.equal(f.records.size, 1);
  assert.equal(f.records.get(invite.reference).etag, etag);
  assert.equal(f.objects.get(invite.reference).ctx.storage.alarm, alarm);
  assert.deepEqual(f.records.get(invite.reference).metadata, metadata);
  assert.deepEqual(stored(f, invite.reference), before);
  const after = stored(f, invite.reference);
  assert.equal(after.status, "invited");
  assert.equal(after.paper, undefined);
  assert.equal(after.answers, undefined);
  assert.equal(after.sessionHash, undefined);
  assert.equal(after.revision, 0);
  assert.equal(after.inviteHash, invite.inviteHash);
  assert.equal(after.inviteHash, await digest(invite.secret));
  assertFieldAbsent(after, "refused start");

  const started = await f.req("/api/start", "POST", valid);
  const sitting = await read(started);
  assert.equal(sitting.status, 200, JSON.stringify(sitting.body));
  const cookie = started.headers.get("Set-Cookie").split(";")[0];
  const sessionSecret = cookie.slice(cookie.indexOf(".") + 1);
  const minted = stored(f, invite.reference);
  assert.equal(minted.status, "active");
  assert.equal(minted.revision, 1);
  assert.deepEqual(minted.answers, {});
  assert.equal(minted.paper.questions.length, 15);
  assert.equal(minted.inviteHash, invite.inviteHash);
  assert.equal(minted.sessionHash, await digest(sessionSecret));
  assert.notEqual(sessionSecret, invite.secret);
  assert.equal(sitting.text.includes(EXTRA_VALUE), false);
  assert.equal(sitting.text.includes(invite.secret), false);
  assertFieldAbsent(minted, "start after refused extra field");
});

test("an extra JSON field on answer save is refused and stores nothing", async () => {
  const f = fixture();
  const invite = await issue(f);
  const { cookie, sessionSecret, sitting } = await begin(f, invite);
  const question = sitting.body.attempt.questions[0];
  const choice = question.options[0].id;
  const valid = {
    reference: invite.reference,
    questionId: question.id,
    choices: [choice],
    revision: sitting.body.attempt.revision,
  };
  const before = structuredClone(stored(f, invite.reference));
  const etag = f.records.get(invite.reference).etag;
  const alarm = f.objects.get(invite.reference).ctx.storage.alarm;
  const metadata = structuredClone(f.records.get(invite.reference).metadata);
  assert.equal(before.inviteHash, invite.inviteHash);
  assert.equal(before.sessionHash, await digest(sessionSecret));

  f.resetWrites();
  const refused = await read(await f.req("/api/answers", "PUT", { ...valid, [EXTRA_KEY]: EXTRA_VALUE }, { cookie }));

  assert.equal(refused.status, 400);
  assert.deepEqual(refused.body, { error: "Please check the request." });
  assert.equal(refused.headers.get("Set-Cookie"), null);
  assert.equal(refused.body.attempt, undefined);
  assert.equal(refused.text.includes(invite.secret), false);
  assert.equal(refused.text.includes(sessionSecret), false);
  assert.equal(refused.text.includes(EXTRA_VALUE), false);
  assert.equal(refused.text.includes(question.prompt), false);
  assert.doesNotMatch(refused.body.error, /another tab|record changed|available answer|Choose a question|assessment has closed|privacy notice changed|currently closed|Route not found|JSON request is required|Answer every question/);
  assert.equal(f.writes(), 0);
  assert.equal(f.records.size, 1);
  assert.equal(f.records.get(invite.reference).etag, etag);
  assert.equal(f.objects.get(invite.reference).ctx.storage.alarm, alarm);
  assert.deepEqual(f.records.get(invite.reference).metadata, metadata);
  assert.deepEqual(stored(f, invite.reference), before);
  const after = stored(f, invite.reference);
  assert.equal(after.status, "active");
  assert.deepEqual(after.answers, {});
  assert.equal(after.revision, 1);
  assert.deepEqual(after.paper, before.paper);
  assert.equal(after.inviteHash, invite.inviteHash);
  assert.equal(after.sessionHash, before.sessionHash);
  assert.equal(after.sessionHash, await digest(sessionSecret));
  assertFieldAbsent(after, "refused answer");

  const saved = await read(await f.req("/api/answers", "PUT", valid, { cookie }));
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.headers.get("Set-Cookie"), null);
  assert.deepEqual(saved.body.attempt.answers, { [question.id]: [choice] });
  assert.equal(saved.text.includes(EXTRA_VALUE), false);
  assert.equal(saved.text.includes(invite.secret), false);
  assert.equal(saved.text.includes(sessionSecret), false);
  const written = stored(f, invite.reference);
  assert.deepEqual(written.answers, { [question.id]: [choice] });
  assert.equal(written.revision, 2);
  assert.deepEqual(written.paper, before.paper);
  assert.equal(written.inviteHash, invite.inviteHash);
  assert.equal(written.sessionHash, before.sessionHash);
  assert.equal(written.status, "active");
  assertFieldAbsent(written, "save after refused extra field");
  assert.equal(f.records.size, 1);
});
