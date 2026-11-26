import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import worker, { Assessment } from "../src/worker.js";

// One live hiring sitting. Save an answer for a real item on this paper
// whose choice id is that item's legal choice string with a right-to-left
// embedding (U+202B) inserted in the middle. The save is refused. No answer
// is stored. The invite hash and the session secret stay unchanged. A
// left-to-right embedding (U+202A) in the middle, a right-to-left mark
// (U+200F) in the middle, and a left-to-right mark (U+200E) in the middle
// are separate checks.

const origin = "https://assessment.example";
const notice = {
  controller: "Test controller", contact: "privacy@example.invalid", basis: "Test basis",
  recipients: "Test reviewer", transfers: "Test transfer description", rights: "Test rights",
  purpose: "Test purpose", supervisoryAuthority: "Test authority", version: "test-1", retentionMinutes: 30,
};
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const random = () => crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
const rightToLeftEmbedding = "\u202B";
const leftToRightEmbedding = "\u202A";
const rightToLeftMark = "\u200F";
const leftToRightMark = "\u200E";

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

test("a legal choice with a right-to-left embedding (U+202B) inserted in the middle is refused and stores nothing", async () => {
  const source = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(source, /"LIVE_ENABLED": "false"/);
  assert.equal(rightToLeftEmbedding, "\u202B");
  assert.equal(rightToLeftEmbedding.charCodeAt(0), 0x202B);
  assert.equal(rightToLeftEmbedding.codePointAt(0), 0x202B);
  assert.equal(rightToLeftEmbedding.length, 1);
  assert.notEqual(rightToLeftEmbedding, leftToRightEmbedding);
  assert.notEqual(rightToLeftEmbedding.charCodeAt(0), 0x202A);
  assert.notEqual(rightToLeftEmbedding, rightToLeftMark);
  assert.notEqual(rightToLeftEmbedding.charCodeAt(0), 0x200F);
  assert.notEqual(rightToLeftEmbedding, leftToRightMark);
  assert.notEqual(rightToLeftEmbedding.charCodeAt(0), 0x200E);
  assert.equal(leftToRightEmbedding, "\u202A");
  assert.equal(leftToRightEmbedding.charCodeAt(0), 0x202A);
  assert.equal(leftToRightEmbedding.codePointAt(0), 0x202A);
  assert.equal(leftToRightEmbedding.length, 1);
  assert.equal(rightToLeftMark, "\u200F");
  assert.equal(rightToLeftMark.charCodeAt(0), 0x200F);
  assert.equal(rightToLeftMark.codePointAt(0), 0x200F);
  assert.equal(rightToLeftMark.length, 1);
  assert.equal(leftToRightMark, "\u200E");
  assert.equal(leftToRightMark.charCodeAt(0), 0x200E);
  assert.equal(leftToRightMark.codePointAt(0), 0x200E);
  assert.equal(leftToRightMark.length, 1);
  assert.equal(/\s/.test(rightToLeftEmbedding), false);
  assert.equal(/\s/.test(leftToRightEmbedding), false);
  assert.equal(/\s/.test(rightToLeftMark), false);
  assert.equal(/\s/.test(leftToRightMark), false);
  assert.equal(/\p{Cf}/u.test(rightToLeftEmbedding), true);
  assert.equal(/\p{Cc}/u.test(rightToLeftEmbedding), false);
  assert.equal(/\p{Zl}/u.test(rightToLeftEmbedding), false);
  assert.equal(/\p{Zp}/u.test(rightToLeftEmbedding), false);
  assert.equal(/\p{Zs}/u.test(rightToLeftEmbedding), false);
  assert.equal(/\p{White_Space}/u.test(rightToLeftEmbedding), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(rightToLeftEmbedding), false);
  assert.equal(/\p{Bidi_Control}/u.test(rightToLeftEmbedding), true);
  assert.equal(/\p{Cf}/u.test(leftToRightEmbedding), true);
  assert.equal(/\p{Cc}/u.test(leftToRightEmbedding), false);
  assert.equal(/\p{Zl}/u.test(leftToRightEmbedding), false);
  assert.equal(/\p{Zp}/u.test(leftToRightEmbedding), false);
  assert.equal(/\p{Zs}/u.test(leftToRightEmbedding), false);
  assert.equal(/\p{White_Space}/u.test(leftToRightEmbedding), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(leftToRightEmbedding), false);
  assert.equal(/\p{Bidi_Control}/u.test(leftToRightEmbedding), true);
  assert.equal(/\p{Cf}/u.test(rightToLeftMark), true);
  assert.equal(/\p{Cc}/u.test(rightToLeftMark), false);
  assert.equal(/\p{Zl}/u.test(rightToLeftMark), false);
  assert.equal(/\p{Zp}/u.test(rightToLeftMark), false);
  assert.equal(/\p{Zs}/u.test(rightToLeftMark), false);
  assert.equal(/\p{White_Space}/u.test(rightToLeftMark), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(rightToLeftMark), true);
  assert.equal(/\p{Bidi_Control}/u.test(rightToLeftMark), true);
  assert.equal(/\p{Cf}/u.test(leftToRightMark), true);
  assert.equal(/\p{Cc}/u.test(leftToRightMark), false);
  assert.equal(/\p{Zl}/u.test(leftToRightMark), false);
  assert.equal(/\p{Zp}/u.test(leftToRightMark), false);
  assert.equal(/\p{Zs}/u.test(leftToRightMark), false);
  assert.equal(/\p{White_Space}/u.test(leftToRightMark), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(leftToRightMark), true);
  assert.equal(/\p{Bidi_Control}/u.test(leftToRightMark), true);
  assert.equal(rightToLeftEmbedding.trim(), rightToLeftEmbedding);
  assert.notEqual(rightToLeftEmbedding.trim(), "");
  assert.equal(leftToRightEmbedding.trim(), leftToRightEmbedding);
  assert.notEqual(leftToRightEmbedding.trim(), "");
  assert.equal(rightToLeftMark.trim(), rightToLeftMark);
  assert.notEqual(rightToLeftMark.trim(), "");
  assert.equal(leftToRightMark.trim(), leftToRightMark);
  assert.notEqual(leftToRightMark.trim(), "");
  assert.equal(JSON.stringify(rightToLeftEmbedding), '"' + rightToLeftEmbedding + '"');
  assert.equal(JSON.stringify(rightToLeftEmbedding).includes(rightToLeftEmbedding), true);
  assert.equal(JSON.stringify(rightToLeftEmbedding).includes("\\"), false);
  assert.equal(JSON.stringify(rightToLeftEmbedding).includes("\\u202B"), false);
  assert.equal(JSON.stringify(rightToLeftEmbedding).includes("\\u202b"), false);
  assert.notEqual(JSON.stringify(rightToLeftEmbedding), "\\u202B");
  assert.equal(JSON.stringify(leftToRightEmbedding), '"' + leftToRightEmbedding + '"');
  assert.equal(JSON.stringify(leftToRightEmbedding).includes(leftToRightEmbedding), true);
  assert.equal(JSON.stringify(leftToRightEmbedding).includes("\\"), false);
  assert.equal(JSON.stringify(leftToRightEmbedding).includes("\\u202A"), false);
  assert.equal(JSON.stringify(leftToRightEmbedding).includes("\\u202a"), false);
  assert.equal(JSON.stringify(leftToRightEmbedding).includes("\\u202B"), false);
  assert.equal(JSON.stringify(leftToRightEmbedding).includes("\\u202b"), false);
  assert.notEqual(JSON.stringify(leftToRightEmbedding), "\\u202A");
  assert.notEqual(JSON.stringify(leftToRightEmbedding), "\\u202B");
  assert.notEqual(JSON.stringify(leftToRightEmbedding), JSON.stringify(rightToLeftEmbedding));
  assert.equal(JSON.stringify(rightToLeftMark), '"' + rightToLeftMark + '"');
  assert.equal(JSON.stringify(rightToLeftMark).includes(rightToLeftMark), true);
  assert.equal(JSON.stringify(rightToLeftMark).includes("\\"), false);
  assert.equal(JSON.stringify(rightToLeftMark).includes("\\u200F"), false);
  assert.equal(JSON.stringify(rightToLeftMark).includes("\\u200f"), false);
  assert.equal(JSON.stringify(rightToLeftMark).includes("\\u202B"), false);
  assert.equal(JSON.stringify(rightToLeftMark).includes("\\u202b"), false);
  assert.notEqual(JSON.stringify(rightToLeftMark), "\\u200F");
  assert.notEqual(JSON.stringify(rightToLeftMark), "\\u202B");
  assert.equal(JSON.stringify(leftToRightMark), '"' + leftToRightMark + '"');
  assert.equal(JSON.stringify(leftToRightMark).includes(leftToRightMark), true);
  assert.equal(JSON.stringify(leftToRightMark).includes("\\"), false);
  assert.equal(JSON.stringify(leftToRightMark).includes("\\u200E"), false);
  assert.equal(JSON.stringify(leftToRightMark).includes("\\u200e"), false);
  assert.equal(JSON.stringify(leftToRightMark).includes("\\u202B"), false);
  assert.equal(JSON.stringify(leftToRightMark).includes("\\u202b"), false);
  assert.notEqual(JSON.stringify(leftToRightMark), "\\u200E");
  assert.notEqual(JSON.stringify(leftToRightMark), "\\u202B");
  assert.notEqual(JSON.stringify(rightToLeftEmbedding), JSON.stringify(leftToRightEmbedding));
  assert.notEqual(JSON.stringify(rightToLeftEmbedding), JSON.stringify(rightToLeftMark));
  assert.notEqual(JSON.stringify(rightToLeftEmbedding), JSON.stringify(leftToRightMark));

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
  assert.equal(sessionSecret, await digest("assessment-session-v1/" + secret + "/" + claim));
  assert.equal(opened.sessionHash, await digest(sessionSecret));
  assert.notEqual(sessionSecret, secret);
  assert.equal(cookie, "__Host-assessment=" + reference + "." + sessionSecret);
  assert.equal(opened.notice.integrityReview, undefined);

  const questions = opened.paper.questions;
  assert.equal(questions.length, 15);
  const target = questions.find(question => typeof question.id === "string" && uuid.test(question.id) &&
    question.options.some(option => typeof option.id === "string" && uuid.test(option.id) && option.id.length >= 2));
  assert.ok(target, "a real item has a legal choice that can take an interior right-to-left embedding (U+202B)");
  const legal = target.options.find(option => uuid.test(option.id)).id;
  assert.equal(questions.some(question => question.id === target.id), true);
  assert.equal(target.options.some(option => option.id === legal), true);
  assert.equal(uuid.test(legal), true);
  assert.equal(uuid.test(target.id), true);
  assert.equal(legal.length, 36);
  assert.equal(legal.includes(rightToLeftEmbedding), false);
  assert.equal(legal.includes(leftToRightEmbedding), false);
  assert.equal(legal.includes(rightToLeftMark), false);
  assert.equal(legal.includes(leftToRightMark), false);
  assert.equal(legal.trim(), legal);
  assert.equal(/\p{Pattern_White_Space}/u.test(legal), false);

  const inserted = insertedInMiddle(legal, rightToLeftEmbedding);
  const broken = inserted.value;
  const at = inserted.at;
  const leftToRightEmbeddingMiddle = insertedInMiddle(legal, leftToRightEmbedding).value;
  const rightToLeftMarkMiddle = insertedInMiddle(legal, rightToLeftMark).value;
  const leftToRightMarkMiddle = insertedInMiddle(legal, leftToRightMark).value;
  assert.ok(at > 0 && at < legal.length);
  assert.equal(at, 18);
  assert.equal(legal.charCodeAt(at), 0x002D);
  assert.equal(broken.charCodeAt(at), 0x202B);
  assert.equal(broken.charCodeAt(at + 1), 0x002D);
  assert.notEqual(broken.charCodeAt(at), 0x202A);
  assert.notEqual(broken.charCodeAt(at), 0x200F);
  assert.notEqual(broken.charCodeAt(at), 0x200E);
  assert.equal(broken.slice(0, at), legal.slice(0, at));
  assert.equal(broken.slice(at + 1), legal.slice(at));
  assert.equal(broken.length, legal.length + 1);
  assert.notEqual(broken, legal);
  assert.equal(broken.replace(rightToLeftEmbedding, ""), legal);
  assert.equal([...broken].filter(char => char === rightToLeftEmbedding).length, 1);
  assert.equal(broken.indexOf(rightToLeftEmbedding), at);
  assert.equal(broken.startsWith(rightToLeftEmbedding), false);
  assert.equal(broken.endsWith(rightToLeftEmbedding), false);
  assert.notEqual(broken, rightToLeftEmbedding + legal);
  assert.notEqual(broken, legal + rightToLeftEmbedding);
  assert.notEqual(broken, leftToRightEmbeddingMiddle);
  assert.notEqual(broken, rightToLeftMarkMiddle);
  assert.notEqual(broken, leftToRightMarkMiddle);
  assert.equal(broken.trim(), broken);
  assert.notEqual(broken.trim(), legal);
  assert.notEqual(broken.trim(), "");
  assert.equal((rightToLeftEmbedding + legal).trim(), rightToLeftEmbedding + legal);
  assert.notEqual((rightToLeftEmbedding + legal).trim(), legal);
  assert.equal((legal + rightToLeftEmbedding).trim(), legal + rightToLeftEmbedding);
  assert.notEqual((legal + rightToLeftEmbedding).trim(), legal);
  assert.equal((leftToRightEmbedding + legal).trim(), leftToRightEmbedding + legal);
  assert.notEqual((leftToRightEmbedding + legal).trim(), legal);
  assert.equal((legal + leftToRightEmbedding).trim(), legal + leftToRightEmbedding);
  assert.notEqual((legal + leftToRightEmbedding).trim(), legal);
  assert.equal((rightToLeftMark + legal).trim(), rightToLeftMark + legal);
  assert.notEqual((rightToLeftMark + legal).trim(), legal);
  assert.equal((legal + rightToLeftMark).trim(), legal + rightToLeftMark);
  assert.notEqual((legal + rightToLeftMark).trim(), legal);
  assert.equal((leftToRightMark + legal).trim(), leftToRightMark + legal);
  assert.notEqual((leftToRightMark + legal).trim(), legal);
  assert.equal((legal + leftToRightMark).trim(), legal + leftToRightMark);
  assert.notEqual((legal + leftToRightMark).trim(), legal);
  assert.equal(leftToRightEmbeddingMiddle.trim(), leftToRightEmbeddingMiddle);
  assert.notEqual(leftToRightEmbeddingMiddle.trim(), legal);
  assert.equal(rightToLeftMarkMiddle.trim(), rightToLeftMarkMiddle);
  assert.notEqual(rightToLeftMarkMiddle.trim(), legal);
  assert.equal(leftToRightMarkMiddle.trim(), leftToRightMarkMiddle);
  assert.notEqual(leftToRightMarkMiddle.trim(), legal);
  assert.equal(/\s/.test(broken), false);
  assert.equal(/\s/.test(leftToRightEmbeddingMiddle), false);
  assert.equal(/\s/.test(rightToLeftMarkMiddle), false);
  assert.equal(/\s/.test(leftToRightMarkMiddle), false);
  assert.equal(/\p{Cf}/u.test(broken), true);
  assert.equal(/\p{Cc}/u.test(broken), false);
  assert.equal(/\p{Zl}/u.test(broken), false);
  assert.equal(/\p{Bidi_Control}/u.test(broken), true);
  assert.equal(/\p{White_Space}/u.test(broken), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(broken), false);
  assert.equal(/\p{Cf}/u.test(leftToRightEmbeddingMiddle), true);
  assert.equal(/\p{Cc}/u.test(leftToRightEmbeddingMiddle), false);
  assert.equal(/\p{Bidi_Control}/u.test(leftToRightEmbeddingMiddle), true);
  assert.equal(/\p{White_Space}/u.test(leftToRightEmbeddingMiddle), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(leftToRightEmbeddingMiddle), false);
  assert.equal(/\p{Cf}/u.test(rightToLeftMarkMiddle), true);
  assert.equal(/\p{Cc}/u.test(rightToLeftMarkMiddle), false);
  assert.equal(/\p{Bidi_Control}/u.test(rightToLeftMarkMiddle), true);
  assert.equal(/\p{White_Space}/u.test(rightToLeftMarkMiddle), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(rightToLeftMarkMiddle), true);
  assert.equal(/\p{Cf}/u.test(leftToRightMarkMiddle), true);
  assert.equal(/\p{Cc}/u.test(leftToRightMarkMiddle), false);
  assert.equal(/\p{Bidi_Control}/u.test(leftToRightMarkMiddle), true);
  assert.equal(/\p{White_Space}/u.test(leftToRightMarkMiddle), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(leftToRightMarkMiddle), true);
  assert.equal(broken.includes(leftToRightEmbedding), false);
  assert.equal(broken.includes(rightToLeftMark), false);
  assert.equal(broken.includes(leftToRightMark), false);
  assert.equal(leftToRightEmbeddingMiddle.charCodeAt(at), 0x202A);
  assert.equal(leftToRightEmbeddingMiddle.includes(rightToLeftEmbedding), false);
  assert.equal(leftToRightEmbeddingMiddle.includes(rightToLeftMark), false);
  assert.equal(leftToRightEmbeddingMiddle.includes(leftToRightMark), false);
  assert.equal(rightToLeftMarkMiddle.charCodeAt(at), 0x200F);
  assert.equal(rightToLeftMarkMiddle.includes(rightToLeftEmbedding), false);
  assert.equal(rightToLeftMarkMiddle.includes(leftToRightEmbedding), false);
  assert.equal(rightToLeftMarkMiddle.includes(leftToRightMark), false);
  assert.equal(leftToRightMarkMiddle.charCodeAt(at), 0x200E);
  assert.equal(leftToRightMarkMiddle.includes(rightToLeftEmbedding), false);
  assert.equal(leftToRightMarkMiddle.includes(leftToRightEmbedding), false);
  assert.equal(leftToRightMarkMiddle.includes(rightToLeftMark), false);
  assert.equal(uuid.test(broken), false);
  const optionIds = questions.flatMap(question => question.options.map(option => option.id));
  assert.equal(optionIds.includes(legal), true);
  assert.equal(optionIds.includes(broken), false);
  assert.equal(optionIds.includes(leftToRightEmbeddingMiddle), false);
  assert.equal(optionIds.includes(rightToLeftMarkMiddle), false);
  assert.equal(optionIds.includes(leftToRightMarkMiddle), false);
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
  const roundTrip = JSON.parse(raw);
  assert.deepEqual(Object.keys(payload).sort(), ["choices", "questionId", "reference", "revision"]);
  assert.equal(payload.questionId, target.id);
  assert.deepEqual(payload.choices, [broken]);
  assert.equal(payload.choices.length, 1);
  assert.equal(typeof payload.choices[0], "string");
  assert.equal(payload.choices[0].charCodeAt(at), 0x202B);
  assert.equal(roundTrip.choices[0], broken);
  assert.equal(roundTrip.choices[0].charCodeAt(at), 0x202B);
  assert.notEqual(roundTrip.choices[0].charCodeAt(at), 0x202A);
  assert.notEqual(roundTrip.choices[0].charCodeAt(at), 0x200F);
  assert.notEqual(roundTrip.choices[0].charCodeAt(at), 0x200E);
  assert.equal(payload.choices[0] === legal, false);
  assert.equal(payload.choices[0] === leftToRightEmbeddingMiddle, false);
  assert.equal(payload.choices[0] === rightToLeftMarkMiddle, false);
  assert.equal(payload.choices[0] === leftToRightMarkMiddle, false);
  assert.equal(raw.includes(rightToLeftEmbedding), true);
  assert.equal(raw.includes("\\u202B"), false);
  assert.equal(raw.includes("\\u202b"), false);
  assert.equal(raw.includes(leftToRightEmbedding), false);
  assert.equal(raw.includes("\\u202A"), false);
  assert.equal(raw.includes("\\u202a"), false);
  assert.equal(raw.includes(rightToLeftMark), false);
  assert.equal(raw.includes("\\u200F"), false);
  assert.equal(raw.includes("\\u200f"), false);
  assert.equal(raw.includes(leftToRightMark), false);
  assert.equal(raw.includes("\\u200E"), false);
  assert.equal(raw.includes("\\u200e"), false);
  assert.equal(raw.includes(legal), false);
  assert.equal(JSON.stringify(broken).includes(rightToLeftEmbedding), true);
  assert.equal(JSON.stringify(broken).includes("\\"), false);
  assert.equal(JSON.stringify(broken).includes("\\u202B"), false);
  assert.equal(JSON.stringify(broken).includes("\\u202b"), false);
  assert.equal(JSON.stringify(broken).includes("\\u202A"), false);
  assert.equal(JSON.stringify(broken).includes("\\u200F"), false);
  assert.equal(JSON.stringify(broken).includes("\\u200E"), false);
  assert.equal(JSON.stringify(leftToRightEmbeddingMiddle).includes(leftToRightEmbedding), true);
  assert.equal(JSON.stringify(leftToRightEmbeddingMiddle).includes("\\"), false);
  assert.equal(JSON.stringify(leftToRightEmbeddingMiddle).includes("\\u202A"), false);
  assert.equal(JSON.stringify(leftToRightEmbeddingMiddle).includes("\\u202a"), false);
  assert.equal(JSON.stringify(leftToRightEmbeddingMiddle).includes("\\u202B"), false);
  assert.equal(JSON.stringify(leftToRightEmbeddingMiddle).includes(rightToLeftEmbedding), false);
  assert.equal(JSON.stringify(rightToLeftMarkMiddle).includes(rightToLeftMark), true);
  assert.equal(JSON.stringify(rightToLeftMarkMiddle).includes("\\"), false);
  assert.equal(JSON.stringify(rightToLeftMarkMiddle).includes("\\u200F"), false);
  assert.equal(JSON.stringify(rightToLeftMarkMiddle).includes("\\u200f"), false);
  assert.equal(JSON.stringify(rightToLeftMarkMiddle).includes("\\u202B"), false);
  assert.equal(JSON.stringify(rightToLeftMarkMiddle).includes(rightToLeftEmbedding), false);
  assert.equal(JSON.stringify(leftToRightMarkMiddle).includes(leftToRightMark), true);
  assert.equal(JSON.stringify(leftToRightMarkMiddle).includes("\\"), false);
  assert.equal(JSON.stringify(leftToRightMarkMiddle).includes("\\u200E"), false);
  assert.equal(JSON.stringify(leftToRightMarkMiddle).includes("\\u200e"), false);
  assert.equal(JSON.stringify(leftToRightMarkMiddle).includes("\\u202B"), false);
  assert.equal(JSON.stringify(leftToRightMarkMiddle).includes(rightToLeftEmbedding), false);
  assert.notEqual(JSON.stringify(broken), JSON.stringify(leftToRightEmbeddingMiddle));
  assert.notEqual(JSON.stringify(broken), JSON.stringify(rightToLeftMarkMiddle));
  assert.notEqual(JSON.stringify(broken), JSON.stringify(leftToRightMarkMiddle));
  f.resetWrites();
  const refused = await read(await f.req("/api/answers", "PUT", payload, { cookie }));
  assert.equal(refused.status, 422, JSON.stringify(refused.body));
  assert.equal(refused.body.error, "Choose an available answer.");
  assert.equal(refused.headers.get("Set-Cookie"), null);
  assert.equal(refused.text.includes(secret), false);
  assert.equal(refused.text.includes(sessionSecret), false);
  assert.equal(refused.text.includes(broken), false);
  assert.equal(refused.text.includes(rightToLeftEmbedding), false);
  assert.equal(refused.text.includes("\\u202B"), false);
  assert.equal(refused.text.includes("\\u202b"), false);
  assert.equal(refused.text.includes(leftToRightEmbedding), false);
  assert.equal(refused.text.includes("\\u202A"), false);
  assert.equal(refused.text.includes("\\u202a"), false);
  assert.equal(refused.text.includes(rightToLeftMark), false);
  assert.equal(refused.text.includes("\\u200F"), false);
  assert.equal(refused.text.includes("\\u200f"), false);
  assert.equal(refused.text.includes(leftToRightMark), false);
  assert.equal(refused.text.includes("\\u200E"), false);
  assert.equal(refused.text.includes("\\u200e"), false);
  assert.equal(refused.text.includes(legal), false);
  assert.deepEqual(f.written, []);

  const after = stored(f, reference);
  assert.deepEqual(after, snapshot);
  assert.deepEqual(after.answers, {});
  assert.equal(Object.hasOwn(after.answers, target.id), false);
  assert.equal(JSON.stringify(after.answers).includes(rightToLeftEmbedding), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u202B"), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u202b"), false);
  assert.equal(JSON.stringify(after.answers).includes(leftToRightEmbedding), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u202A"), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u202a"), false);
  assert.equal(JSON.stringify(after.answers).includes(rightToLeftMark), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u200F"), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u200f"), false);
  assert.equal(JSON.stringify(after.answers).includes(leftToRightMark), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u200E"), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u200e"), false);
  assert.equal(JSON.stringify(after.answers).includes(legal), false);
  assert.equal(JSON.stringify(after).includes(rightToLeftEmbedding), false);
  assert.equal(JSON.stringify(after).includes("\\u202B"), false);
  assert.equal(JSON.stringify(after).includes("\\u202b"), false);
  assert.equal(JSON.stringify(after).includes(leftToRightEmbedding), false);
  assert.equal(JSON.stringify(after).includes("\\u202A"), false);
  assert.equal(JSON.stringify(after).includes("\\u202a"), false);
  assert.equal(JSON.stringify(after).includes(rightToLeftMark), false);
  assert.equal(JSON.stringify(after).includes("\\u200F"), false);
  assert.equal(JSON.stringify(after).includes("\\u200f"), false);
  assert.equal(JSON.stringify(after).includes(leftToRightMark), false);
  assert.equal(JSON.stringify(after).includes("\\u200E"), false);
  assert.equal(JSON.stringify(after).includes("\\u200e"), false);
  assert.equal(after.revision, 1);
  assert.equal(after.status, "active");
  assert.equal(after.submittedAt, undefined);
  assert.equal(after.score, undefined);
  assert.equal(after.integrityMasks, undefined);
  assert.deepEqual(after.paper, paper);
  assert.equal(after.inviteHash, inviteHash);
  assert.equal(after.sessionHash, sessionHash);
  assert.equal(after.inviteHash, await digest(secret));
  assert.equal(sessionSecret, await digest("assessment-session-v1/" + secret + "/" + claim));
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
  assert.equal(viewed.text.includes(rightToLeftEmbedding), false);
  assert.equal(viewed.text.includes("\\u202B"), false);
  assert.equal(viewed.text.includes("\\u202b"), false);
  assert.equal(viewed.text.includes(leftToRightEmbedding), false);
  assert.equal(viewed.text.includes("\\u202A"), false);
  assert.equal(viewed.text.includes("\\u202a"), false);
  assert.equal(viewed.text.includes(rightToLeftMark), false);
  assert.equal(viewed.text.includes("\\u200F"), false);
  assert.equal(viewed.text.includes("\\u200f"), false);
  assert.equal(viewed.text.includes(leftToRightMark), false);
  assert.equal(viewed.text.includes("\\u200E"), false);
  assert.equal(viewed.text.includes("\\u200e"), false);
  assert.equal(f.records.get(reference).etag, openedEtag);
  assert.equal(stored(f, reference).inviteHash, inviteHash);
  assert.equal(stored(f, reference).sessionHash, sessionHash);
  assert.deepEqual(stored(f, reference).answers, {});
});
