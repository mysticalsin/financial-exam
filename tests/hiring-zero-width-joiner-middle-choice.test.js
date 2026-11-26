import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import worker, { Assessment } from "../src/worker.js";

// One live hiring sitting. Save an answer for a real item on this paper
// whose choice id is that item's legal choice string with a zero-width
// joiner (U+200D) inserted in the middle. The save is refused. No answer
// is stored. The invite hash and the session secret stay unchanged.
// A zero-width non-joiner in the middle, a word joiner in the middle, and a
// zero-width space in the middle are separate checks.

const origin = "https://assessment.example";
const notice = {
  controller: "Test controller", contact: "privacy@example.invalid", basis: "Test basis",
  recipients: "Test reviewer", transfers: "Test transfer description", rights: "Test rights",
  purpose: "Test purpose", supervisoryAuthority: "Test authority", version: "test-1", retentionMinutes: 30,
};
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const random = () => crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
const zeroWidthJoiner = "\u200D";
const zeroWidthNonJoiner = "\u200C";
const wordJoiner = "\u2060";
const zeroWidthSpace = "\u200B";

function insertedInMiddle(value, mark) {
  const at = Math.floor(value.length / 2);
  return { at, value: value.slice(0, at) + mark + value.slice(at) };
}

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

test("a legal choice with a zero-width joiner inserted in the middle is refused and stores nothing", async () => {
  const source = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(source, /"LIVE_ENABLED": "false"/);
  assert.equal(zeroWidthJoiner, "\u200D");
  assert.equal(zeroWidthJoiner.charCodeAt(0), 0x200D);
  assert.equal(zeroWidthJoiner.length, 1);
  assert.notEqual(zeroWidthJoiner, zeroWidthNonJoiner);
  assert.notEqual(zeroWidthJoiner.charCodeAt(0), 0x200C);
  assert.notEqual(zeroWidthJoiner, wordJoiner);
  assert.notEqual(zeroWidthJoiner.charCodeAt(0), 0x2060);
  assert.notEqual(zeroWidthJoiner, zeroWidthSpace);
  assert.notEqual(zeroWidthJoiner.charCodeAt(0), 0x200B);
  assert.equal(/\s/.test(zeroWidthJoiner), false);
  assert.equal(/\s/.test(zeroWidthNonJoiner), false);
  assert.equal(/\s/.test(wordJoiner), false);
  assert.equal(/\s/.test(zeroWidthSpace), false);
  assert.equal(/\p{Cf}/u.test(zeroWidthJoiner), true);
  assert.equal(/\p{Zs}/u.test(zeroWidthJoiner), false);
  assert.equal(/\p{Cc}/u.test(zeroWidthJoiner), false);
  assert.equal(/\p{Cf}/u.test(zeroWidthNonJoiner), true);
  assert.equal(/\p{Cf}/u.test(wordJoiner), true);
  assert.equal(/\p{Cf}/u.test(zeroWidthSpace), true);
  assert.equal(/\p{Zs}/u.test(zeroWidthNonJoiner), false);
  assert.equal(/\p{Zs}/u.test(wordJoiner), false);
  assert.equal(/\p{Zs}/u.test(zeroWidthSpace), false);
  assert.equal(zeroWidthJoiner.trim(), zeroWidthJoiner);
  assert.equal(zeroWidthNonJoiner.trim(), zeroWidthNonJoiner);
  assert.equal(wordJoiner.trim(), wordJoiner);
  assert.equal(zeroWidthSpace.trim(), zeroWidthSpace);
  assert.equal(JSON.stringify(zeroWidthJoiner), '"' + zeroWidthJoiner + '"');
  assert.equal(JSON.stringify(zeroWidthJoiner).includes("\\"), false);
  assert.notEqual(JSON.stringify(zeroWidthJoiner), '"\\u200d"');
  assert.notEqual(JSON.stringify(zeroWidthJoiner), '"\\u200D"');
  assert.notEqual(JSON.stringify(zeroWidthJoiner), JSON.stringify(zeroWidthNonJoiner));
  assert.notEqual(JSON.stringify(zeroWidthJoiner), JSON.stringify(wordJoiner));
  assert.notEqual(JSON.stringify(zeroWidthJoiner), JSON.stringify(zeroWidthSpace));

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
  const target = questions.find(question => typeof question.id === "string" && uuid.test(question.id) &&
    question.options.some(option => typeof option.id === "string" && uuid.test(option.id) && option.id.length >= 2));
  assert.ok(target, "a real item has a legal choice that can take an interior zero-width joiner");
  const legal = target.options.find(option => uuid.test(option.id)).id;
  assert.equal(questions.some(question => question.id === target.id), true);
  assert.equal(target.options.some(option => option.id === legal), true);
  assert.equal(uuid.test(legal), true);
  assert.equal(uuid.test(target.id), true);
  assert.equal(legal.length, 36);
  assert.equal(legal.includes(zeroWidthJoiner), false);
  assert.equal(legal.includes(zeroWidthNonJoiner), false);
  assert.equal(legal.includes(wordJoiner), false);
  assert.equal(legal.includes(zeroWidthSpace), false);
  assert.equal(legal.trim(), legal);

  const inserted = insertedInMiddle(legal, zeroWidthJoiner);
  const broken = inserted.value;
  const at = inserted.at;
  const nonJoinerMiddle = insertedInMiddle(legal, zeroWidthNonJoiner).value;
  const wordJoinerMiddle = insertedInMiddle(legal, wordJoiner).value;
  const zeroWidthMiddle = insertedInMiddle(legal, zeroWidthSpace).value;
  assert.ok(at > 0 && at < legal.length);
  assert.equal(at, 18);
  assert.equal(legal.charCodeAt(at), 0x002D);
  assert.equal(broken.charCodeAt(at), 0x200D);
  assert.equal(broken.charCodeAt(at + 1), 0x002D);
  assert.notEqual(broken.charCodeAt(at), 0x200C);
  assert.notEqual(broken.charCodeAt(at), 0x2060);
  assert.notEqual(broken.charCodeAt(at), 0x200B);
  assert.equal(broken[at], zeroWidthJoiner);
  assert.equal(broken.slice(0, at), legal.slice(0, at));
  assert.equal(broken.slice(at + 1), legal.slice(at));
  assert.equal(broken.slice(0, at).length > 0, true);
  assert.equal(broken.slice(at + 1).length > 0, true);
  assert.equal(broken.length, legal.length + 1);
  assert.notEqual(broken, legal);
  assert.equal(broken.replace(zeroWidthJoiner, ""), legal);
  assert.equal([...broken].filter(char => char === zeroWidthJoiner).length, 1);
  assert.equal(broken.indexOf(zeroWidthJoiner), at);
  assert.equal(broken.startsWith(zeroWidthJoiner), false);
  assert.equal(broken.endsWith(zeroWidthJoiner), false);
  assert.notEqual(broken, zeroWidthJoiner + legal);
  assert.notEqual(broken, legal + zeroWidthJoiner);
  assert.equal((zeroWidthJoiner + legal).trim(), zeroWidthJoiner + legal);
  assert.equal((legal + zeroWidthJoiner).trim(), legal + zeroWidthJoiner);
  assert.notEqual((zeroWidthJoiner + legal).trim(), legal);
  assert.equal(broken.trim(), broken);
  assert.notEqual(broken.trim(), legal);
  assert.notEqual(broken.trim(), "");
  assert.equal(/^\s+$/.test(broken), false);
  assert.equal(/\s/.test(broken), false);
  assert.equal(/\p{Cf}/u.test(broken), true);
  assert.equal(/\p{Zs}/u.test(broken), false);
  assert.equal(broken.includes(zeroWidthNonJoiner), false);
  assert.equal(broken.includes(wordJoiner), false);
  assert.equal(broken.includes(zeroWidthSpace), false);
  assert.notEqual(broken, nonJoinerMiddle);
  assert.notEqual(broken, wordJoinerMiddle);
  assert.notEqual(broken, zeroWidthMiddle);
  assert.equal(nonJoinerMiddle.charCodeAt(at), 0x200C);
  assert.equal(nonJoinerMiddle.includes(zeroWidthJoiner), false);
  assert.equal(wordJoinerMiddle.charCodeAt(at), 0x2060);
  assert.equal(wordJoinerMiddle.includes(zeroWidthJoiner), false);
  assert.equal(wordJoinerMiddle.includes(zeroWidthNonJoiner), false);
  assert.equal(zeroWidthMiddle.charCodeAt(at), 0x200B);
  assert.equal(zeroWidthMiddle.includes(zeroWidthJoiner), false);
  assert.equal(zeroWidthMiddle.includes(zeroWidthNonJoiner), false);
  assert.equal(zeroWidthMiddle.includes(wordJoiner), false);
  assert.equal(uuid.test(broken), false);
  assert.equal(uuid.test(nonJoinerMiddle), false);
  assert.equal(uuid.test(wordJoinerMiddle), false);
  assert.equal(uuid.test(zeroWidthMiddle), false);
  const optionIds = questions.flatMap(question => question.options.map(option => option.id));
  assert.equal(optionIds.includes(legal), true);
  assert.equal(optionIds.includes(broken), false);
  assert.equal(target.options.some(option => option.id === broken), false);
  const paper = structuredClone(opened.paper);
  const inviteHash = opened.inviteHash;
  const sessionHash = opened.sessionHash;
  const alarm = f.objects.get(reference).ctx.storage.alarm;
  const openedEtag = f.records.get(reference).etag;
  const snapshot = structuredClone(opened);
  const metadata = structuredClone(f.records.get(reference).metadata);

  const payload = { reference, questionId: target.id, choices: [broken], revision: 1 };
  const raw = JSON.stringify(payload);
  assert.deepEqual(Object.keys(payload).sort(), ["choices", "questionId", "reference", "revision"]);
  assert.equal(payload.questionId, target.id);
  assert.equal(typeof payload.questionId, "string");
  assert.deepEqual(payload.choices, [broken]);
  assert.equal(payload.choices.length, 1);
  assert.equal(typeof payload.choices[0], "string");
  assert.equal(payload.choices[0].includes(zeroWidthJoiner), true);
  assert.equal(payload.choices[0].charCodeAt(at), 0x200D);
  assert.equal(payload.choices[0].includes(zeroWidthNonJoiner), false);
  assert.equal(payload.choices[0].includes(wordJoiner), false);
  assert.equal(payload.choices[0].includes(zeroWidthSpace), false);
  assert.equal(payload.choices[0] === legal, false);
  assert.equal(payload.choices[0] === nonJoinerMiddle, false);
  assert.equal(payload.choices[0] === wordJoinerMiddle, false);
  assert.equal(payload.choices[0] === zeroWidthMiddle, false);
  assert.equal(payload.choices[0] === zeroWidthJoiner + legal, false);
  assert.equal(payload.choices[0] === legal + zeroWidthJoiner, false);
  assert.equal(raw.includes(JSON.stringify(broken)), true);
  assert.equal(raw.includes(zeroWidthJoiner), true);
  assert.equal(raw.includes("\\u200d"), false);
  assert.equal(raw.includes("\\u200D"), false);
  assert.equal(raw.includes(zeroWidthNonJoiner), false);
  assert.equal(raw.includes("\\u200c"), false);
  assert.equal(raw.includes("\\u200C"), false);
  assert.equal(raw.includes(wordJoiner), false);
  assert.equal(raw.includes("\\u2060"), false);
  assert.equal(raw.includes(zeroWidthSpace), false);
  assert.equal(raw.includes("\\u200b"), false);
  assert.equal(raw.includes("\\u200B"), false);
  assert.equal(raw.includes(legal), false);
  f.resetWrites();
  const refused = await read(await f.req("/api/answers", "PUT", payload, { cookie }));
  assert.equal(refused.status, 422, JSON.stringify(refused.body));
  assert.equal(refused.body.error, "Choose an available answer.");
  assert.equal(refused.headers.get("Set-Cookie"), null);
  assert.equal(refused.text.includes(secret), false);
  assert.equal(refused.text.includes(sessionSecret), false);
  assert.equal(refused.text.includes(broken), false);
  assert.equal(refused.text.includes(zeroWidthJoiner), false);
  assert.equal(refused.text.includes("\\u200d"), false);
  assert.equal(refused.text.includes("\\u200D"), false);
  assert.equal(refused.text.includes(zeroWidthNonJoiner), false);
  assert.equal(refused.text.includes("\\u200c"), false);
  assert.equal(refused.text.includes("\\u200C"), false);
  assert.equal(refused.text.includes(wordJoiner), false);
  assert.equal(refused.text.includes("\\u2060"), false);
  assert.equal(refused.text.includes(zeroWidthSpace), false);
  assert.equal(refused.text.includes("\\u200b"), false);
  assert.equal(refused.text.includes("\\u200B"), false);
  assert.equal(refused.text.includes(legal), false);
  assert.deepEqual(f.written, []);

  const after = stored(f, reference);
  assert.deepEqual(after, snapshot);
  assert.deepEqual(after.answers, {});
  assert.equal(Object.hasOwn(after.answers, target.id), false);
  assert.equal(JSON.stringify(after.answers).includes(legal), false);
  assert.equal(JSON.stringify(after.answers).includes(zeroWidthJoiner), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u200d"), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u200D"), false);
  assert.equal(JSON.stringify(after.answers).includes(zeroWidthNonJoiner), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u200c"), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u200C"), false);
  assert.equal(JSON.stringify(after.answers).includes(wordJoiner), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u2060"), false);
  assert.equal(JSON.stringify(after.answers).includes(zeroWidthSpace), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u200b"), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u200B"), false);
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
  assert.equal(f.records.get(reference).etag, openedEtag);
  assert.deepEqual(f.records.get(reference).metadata, metadata);
  assert.equal(f.objects.get(reference).ctx.storage.alarm, alarm);
  assert.equal(f.records.size, 1);

  const viewed = await read(await f.req("/api/session", "GET", undefined, { cookie, reference }));
  assert.equal(viewed.status, 200, JSON.stringify(viewed.body));
  assert.equal(viewed.headers.get("Set-Cookie"), null);
  assert.equal(viewed.body.attempt.answered, 0);
  assert.equal(viewed.body.attempt.revision, 1);
  assert.deepEqual(viewed.body.attempt.answers, {});
  assert.equal(viewed.text.includes(secret), false);
  assert.equal(viewed.text.includes(sessionSecret), false);
  assert.equal(viewed.text.includes(broken), false);
  assert.equal(viewed.text.includes(zeroWidthJoiner), false);
  assert.equal(viewed.text.includes("\\u200d"), false);
  assert.equal(viewed.text.includes("\\u200D"), false);
  assert.equal(viewed.text.includes(zeroWidthNonJoiner), false);
  assert.equal(viewed.text.includes("\\u200c"), false);
  assert.equal(viewed.text.includes("\\u200C"), false);
  assert.equal(viewed.text.includes(wordJoiner), false);
  assert.equal(viewed.text.includes("\\u2060"), false);
  assert.equal(viewed.text.includes(zeroWidthSpace), false);
  assert.equal(viewed.text.includes("\\u200b"), false);
  assert.equal(viewed.text.includes("\\u200B"), false);
  assert.equal(f.records.get(reference).etag, openedEtag);
  assert.equal(stored(f, reference).inviteHash, inviteHash);
  assert.equal(stored(f, reference).sessionHash, sessionHash);
  assert.deepEqual(stored(f, reference).answers, {});
});
