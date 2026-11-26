import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import worker, { Assessment } from "../src/worker.js";

// One live hiring sitting. Save an answer for a real item on this paper
// whose choice id is that item's legal choice string with one leading space,
// then a second save whose choice id is that same legal choice string with
// one trailing space. Both are refused. No answer is stored. The invite hash
// and the session secret stay unchanged.
// An empty or whitespace-only choice, a JSON null choice, and a later exact
// legal choice are separate checks.

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

test("a legal choice with one leading space and one trailing space is refused and stores nothing", async () => {
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
  assert.equal(opened.notice.integrityReview, undefined);

  const questions = opened.paper.questions;
  assert.equal(questions.length, 15);
  const target = questions[0];
  assert.equal(typeof target.id, "string");
  assert.equal(Number.isInteger(target.id), false);
  assert.equal(questions.some(question => question.id === target.id), true);
  const legal = target.options[0].id;
  assert.equal(typeof legal, "string");
  assert.equal(legal.length > 0, true);
  assert.equal(legal === null, false);
  assert.equal(legal.startsWith(" "), false);
  assert.equal(legal.endsWith(" "), false);
  assert.equal(legal.trim(), legal);
  assert.equal(target.options.some(option => option.id === legal), true);
  const optionIds = questions.flatMap(question => question.options.map(option => option.id));
  assert.ok(optionIds.length >= 1);
  assert.equal(optionIds.includes(legal), true);
  const leading = " " + legal;
  const trailing = legal + " ";
  assert.equal(leading.length, legal.length + 1);
  assert.equal(trailing.length, legal.length + 1);
  assert.equal(leading[0], " ");
  assert.equal(leading.slice(1), legal);
  assert.equal(trailing[trailing.length - 1], " ");
  assert.equal(trailing.slice(0, -1), legal);
  assert.notEqual(leading, trailing);
  assert.notEqual(leading, legal);
  assert.notEqual(trailing, legal);
  assert.equal(leading.trim(), legal);
  assert.equal(trailing.trim(), legal);
  assert.notEqual(leading.trim(), "");
  assert.notEqual(trailing.trim(), "");
  assert.equal(/^\s+$/.test(leading), false);
  assert.equal(/^\s+$/.test(trailing), false);
  assert.equal(leading === "", false);
  assert.equal(trailing === "", false);
  assert.equal(leading === null, false);
  assert.equal(trailing === null, false);
  assert.equal(typeof leading, "string");
  assert.equal(typeof trailing, "string");
  assert.equal(optionIds.includes(leading), false);
  assert.equal(optionIds.includes(trailing), false);
  assert.equal(target.options.some(option => option.id === leading), false);
  assert.equal(target.options.some(option => option.id === trailing), false);
  const paper = structuredClone(opened.paper);
  const inviteHash = opened.inviteHash;
  const sessionHash = opened.sessionHash;
  const alarm = f.objects.get(reference).ctx.storage.alarm;
  const openedEtag = f.records.get(reference).etag;
  const snapshot = structuredClone(opened);
  const metadata = structuredClone(f.records.get(reference).metadata);

  async function refuse(choice) {
    const payload = { reference, questionId: target.id, choices: [choice], revision: 1 };
    const raw = JSON.stringify(payload);
    assert.deepEqual(Object.keys(payload).sort(), ["choices", "questionId", "reference", "revision"]);
    assert.equal(payload.questionId, target.id);
    assert.equal(typeof payload.questionId, "string");
    assert.equal(Number.isInteger(payload.questionId), false);
    assert.deepEqual(payload.choices, [choice]);
    assert.equal(payload.choices.length, 1);
    assert.equal(typeof payload.choices[0], "string");
    assert.equal(payload.choices[0] === legal, false);
    assert.equal(payload.choices[0] === "", false);
    assert.equal(payload.choices[0] === null, false);
    assert.equal(payload.choices[0].trim(), legal);
    assert.equal(raw.includes(JSON.stringify(choice)), true);
    assert.equal(raw.includes(JSON.stringify(legal)), false);
    assert.equal(raw.includes('"choices":[null]'), false);
    assert.equal(raw.includes('"choices":[""]'), false);
    f.resetWrites();
    const refused = await read(await f.req("/api/answers", "PUT", payload, { cookie }));
    assert.equal(refused.status, 422, JSON.stringify(refused.body));
    assert.equal(refused.body.error, "Choose an available answer.");
    assert.equal(refused.headers.get("Set-Cookie"), null);
    assert.equal(refused.text.includes(secret), false);
    assert.equal(refused.text.includes(sessionSecret), false);
    assert.equal(refused.text.includes(choice), false);
    assert.equal(refused.text.includes(legal), false);
    assert.deepEqual(f.written, []);

    const after = stored(f, reference);
    assert.deepEqual(after, snapshot);
    assert.deepEqual(after.answers, {});
    assert.equal(Object.hasOwn(after.answers, target.id), false);
    assert.equal(JSON.stringify(after.answers).includes(choice), false);
    assert.equal(JSON.stringify(after.answers).includes(legal), false);
    assert.equal(after.revision, 1);
    assert.equal(after.status, "active");
    assert.equal(after.submittedAt, undefined);
    assert.equal(after.score, undefined);
    assert.equal(after.integrityMasks, undefined);
    assert.deepEqual(after.paper, paper);
    assert.equal(after.inviteHash, inviteHash);
    assert.equal(after.sessionHash, sessionHash);
    assert.equal(after.inviteHash, await digest(secret));
    assert.equal(after.sessionHash, await digest(sessionSecret));
    assert.equal(JSON.stringify(after).includes(secret), false);
    assert.equal(JSON.stringify(after).includes(sessionSecret), false);
    assert.equal(JSON.stringify(after).includes(choice), false);
    assert.equal(f.records.get(reference).etag, openedEtag);
    assert.deepEqual(f.records.get(reference).metadata, metadata);
    assert.equal(f.objects.get(reference).ctx.storage.alarm, alarm);
    assert.equal(f.records.size, 1);
  }

  await refuse(leading);
  await refuse(trailing);

  const viewed = await read(await f.req("/api/session", "GET", undefined, { cookie, reference }));
  assert.equal(viewed.status, 200, JSON.stringify(viewed.body));
  assert.equal(viewed.headers.get("Set-Cookie"), null);
  assert.equal(viewed.body.attempt.answered, 0);
  assert.equal(viewed.body.attempt.revision, 1);
  assert.deepEqual(viewed.body.attempt.answers, {});
  assert.equal(viewed.text.includes(secret), false);
  assert.equal(viewed.text.includes(sessionSecret), false);
  assert.equal(viewed.text.includes(leading), false);
  assert.equal(viewed.text.includes(trailing), false);
  assert.equal(f.records.get(reference).etag, openedEtag);
  assert.equal(stored(f, reference).inviteHash, inviteHash);
  assert.equal(stored(f, reference).sessionHash, sessionHash);
  assert.deepEqual(stored(f, reference).answers, {});
});
