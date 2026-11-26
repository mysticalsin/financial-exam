import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import worker, { Assessment } from "../src/worker.js";

// One live hiring sitting. Save an answer for a real item on this paper
// whose choice id is that item's legal choice string with a pop directional
// formatting character (U+202C) inserted in the middle. The save is refused.
// No answer is stored. The invite hash and the session secret stay unchanged.
// A right-to-left embedding (U+202B) in the middle, a left-to-right embedding
// (U+202A) in the middle, and a right-to-left mark (U+200F) in the middle
// are separate checks.

const origin = "https://assessment.example";
const notice = {
  controller: "Test controller", contact: "privacy@example.invalid", basis: "Test basis",
  recipients: "Test reviewer", transfers: "Test transfer description", rights: "Test rights",
  purpose: "Test purpose", supervisoryAuthority: "Test authority", version: "test-1", retentionMinutes: 30,
};
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const random = () => crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
const popDirectionalFormatting = "\u202C";
const rightToLeftEmbedding = "\u202B";
const leftToRightEmbedding = "\u202A";
const rightToLeftMark = "\u200F";

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

test("a legal choice with a pop directional formatting character (U+202C) inserted in the middle is refused and stores nothing", async () => {
  const source = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(source, /"LIVE_ENABLED": "false"/);
  assert.equal(popDirectionalFormatting, "\u202C");
  assert.equal(popDirectionalFormatting.charCodeAt(0), 0x202C);
  assert.equal(popDirectionalFormatting.codePointAt(0), 0x202C);
  assert.equal(popDirectionalFormatting.length, 1);
  assert.notEqual(popDirectionalFormatting, rightToLeftEmbedding);
  assert.notEqual(popDirectionalFormatting.charCodeAt(0), 0x202B);
  assert.notEqual(popDirectionalFormatting, leftToRightEmbedding);
  assert.notEqual(popDirectionalFormatting.charCodeAt(0), 0x202A);
  assert.notEqual(popDirectionalFormatting, rightToLeftMark);
  assert.notEqual(popDirectionalFormatting.charCodeAt(0), 0x200F);
  assert.equal(rightToLeftEmbedding, "\u202B");
  assert.equal(rightToLeftEmbedding.charCodeAt(0), 0x202B);
  assert.equal(rightToLeftEmbedding.codePointAt(0), 0x202B);
  assert.equal(rightToLeftEmbedding.length, 1);
  assert.equal(leftToRightEmbedding, "\u202A");
  assert.equal(leftToRightEmbedding.charCodeAt(0), 0x202A);
  assert.equal(leftToRightEmbedding.codePointAt(0), 0x202A);
  assert.equal(leftToRightEmbedding.length, 1);
  assert.equal(rightToLeftMark, "\u200F");
  assert.equal(rightToLeftMark.charCodeAt(0), 0x200F);
  assert.equal(rightToLeftMark.codePointAt(0), 0x200F);
  assert.equal(rightToLeftMark.length, 1);
  assert.equal(/\s/.test(popDirectionalFormatting), false);
  assert.equal(/\s/.test(rightToLeftEmbedding), false);
  assert.equal(/\s/.test(leftToRightEmbedding), false);
  assert.equal(/\s/.test(rightToLeftMark), false);
  assert.equal(/\p{Cf}/u.test(popDirectionalFormatting), true);
  assert.equal(/\p{Cc}/u.test(popDirectionalFormatting), false);
  assert.equal(/\p{Zl}/u.test(popDirectionalFormatting), false);
  assert.equal(/\p{Zp}/u.test(popDirectionalFormatting), false);
  assert.equal(/\p{Zs}/u.test(popDirectionalFormatting), false);
  assert.equal(/\p{White_Space}/u.test(popDirectionalFormatting), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(popDirectionalFormatting), false);
  assert.equal(/\p{Bidi_Control}/u.test(popDirectionalFormatting), true);
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
  assert.equal(popDirectionalFormatting.trim(), popDirectionalFormatting);
  assert.notEqual(popDirectionalFormatting.trim(), "");
  assert.equal(rightToLeftEmbedding.trim(), rightToLeftEmbedding);
  assert.notEqual(rightToLeftEmbedding.trim(), "");
  assert.equal(leftToRightEmbedding.trim(), leftToRightEmbedding);
  assert.notEqual(leftToRightEmbedding.trim(), "");
  assert.equal(rightToLeftMark.trim(), rightToLeftMark);
  assert.notEqual(rightToLeftMark.trim(), "");
  assert.equal(JSON.stringify(popDirectionalFormatting), '"' + popDirectionalFormatting + '"');
  assert.equal(JSON.stringify(popDirectionalFormatting).includes(popDirectionalFormatting), true);
  assert.equal(JSON.stringify(popDirectionalFormatting).includes("\\"), false);
  assert.equal(JSON.stringify(popDirectionalFormatting).includes("\\u202C"), false);
  assert.equal(JSON.stringify(popDirectionalFormatting).includes("\\u202c"), false);
  assert.notEqual(JSON.stringify(popDirectionalFormatting), "\\u202C");
  assert.equal(JSON.stringify(rightToLeftEmbedding), '"' + rightToLeftEmbedding + '"');
  assert.equal(JSON.stringify(rightToLeftEmbedding).includes(rightToLeftEmbedding), true);
  assert.equal(JSON.stringify(rightToLeftEmbedding).includes("\\"), false);
  assert.equal(JSON.stringify(rightToLeftEmbedding).includes("\\u202B"), false);
  assert.equal(JSON.stringify(rightToLeftEmbedding).includes("\\u202b"), false);
  assert.equal(JSON.stringify(rightToLeftEmbedding).includes("\\u202C"), false);
  assert.equal(JSON.stringify(rightToLeftEmbedding).includes("\\u202c"), false);
  assert.notEqual(JSON.stringify(rightToLeftEmbedding), "\\u202B");
  assert.notEqual(JSON.stringify(rightToLeftEmbedding), "\\u202C");
  assert.notEqual(JSON.stringify(rightToLeftEmbedding), JSON.stringify(popDirectionalFormatting));
  assert.equal(JSON.stringify(leftToRightEmbedding), '"' + leftToRightEmbedding + '"');
  assert.equal(JSON.stringify(leftToRightEmbedding).includes(leftToRightEmbedding), true);
  assert.equal(JSON.stringify(leftToRightEmbedding).includes("\\"), false);
  assert.equal(JSON.stringify(leftToRightEmbedding).includes("\\u202A"), false);
  assert.equal(JSON.stringify(leftToRightEmbedding).includes("\\u202a"), false);
  assert.equal(JSON.stringify(leftToRightEmbedding).includes("\\u202C"), false);
  assert.equal(JSON.stringify(leftToRightEmbedding).includes("\\u202c"), false);
  assert.notEqual(JSON.stringify(leftToRightEmbedding), "\\u202A");
  assert.notEqual(JSON.stringify(leftToRightEmbedding), "\\u202C");
  assert.equal(JSON.stringify(rightToLeftMark), '"' + rightToLeftMark + '"');
  assert.equal(JSON.stringify(rightToLeftMark).includes(rightToLeftMark), true);
  assert.equal(JSON.stringify(rightToLeftMark).includes("\\"), false);
  assert.equal(JSON.stringify(rightToLeftMark).includes("\\u200F"), false);
  assert.equal(JSON.stringify(rightToLeftMark).includes("\\u200f"), false);
  assert.equal(JSON.stringify(rightToLeftMark).includes("\\u202C"), false);
  assert.equal(JSON.stringify(rightToLeftMark).includes("\\u202c"), false);
  assert.notEqual(JSON.stringify(rightToLeftMark), "\\u200F");
  assert.notEqual(JSON.stringify(rightToLeftMark), "\\u202C");
  assert.notEqual(JSON.stringify(popDirectionalFormatting), JSON.stringify(rightToLeftEmbedding));
  assert.notEqual(JSON.stringify(popDirectionalFormatting), JSON.stringify(leftToRightEmbedding));
  assert.notEqual(JSON.stringify(popDirectionalFormatting), JSON.stringify(rightToLeftMark));

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
  assert.ok(target, "a real item has a legal choice that can take an interior pop directional formatting character (U+202C)");
  const legal = target.options.find(option => uuid.test(option.id)).id;
  assert.equal(questions.some(question => question.id === target.id), true);
  assert.equal(target.options.some(option => option.id === legal), true);
  assert.equal(uuid.test(legal), true);
  assert.equal(uuid.test(target.id), true);
  assert.equal(legal.length, 36);
  assert.equal(legal.includes(popDirectionalFormatting), false);
  assert.equal(legal.includes(rightToLeftEmbedding), false);
  assert.equal(legal.includes(leftToRightEmbedding), false);
  assert.equal(legal.includes(rightToLeftMark), false);
  assert.equal(legal.trim(), legal);
  assert.equal(/\p{Pattern_White_Space}/u.test(legal), false);

  const inserted = insertedInMiddle(legal, popDirectionalFormatting);
  const broken = inserted.value;
  const at = inserted.at;
  const rightToLeftEmbeddingMiddle = insertedInMiddle(legal, rightToLeftEmbedding).value;
  const leftToRightEmbeddingMiddle = insertedInMiddle(legal, leftToRightEmbedding).value;
  const rightToLeftMarkMiddle = insertedInMiddle(legal, rightToLeftMark).value;
  assert.ok(at > 0 && at < legal.length);
  assert.equal(at, 18);
  assert.equal(legal.charCodeAt(at), 0x002D);
  assert.equal(broken.charCodeAt(at), 0x202C);
  assert.equal(broken.charCodeAt(at + 1), 0x002D);
  assert.notEqual(broken.charCodeAt(at), 0x202B);
  assert.notEqual(broken.charCodeAt(at), 0x202A);
  assert.notEqual(broken.charCodeAt(at), 0x200F);
  assert.equal(broken.slice(0, at), legal.slice(0, at));
  assert.equal(broken.slice(at + 1), legal.slice(at));
  assert.equal(broken.length, legal.length + 1);
  assert.notEqual(broken, legal);
  assert.equal(broken.replace(popDirectionalFormatting, ""), legal);
  assert.equal([...broken].filter(char => char === popDirectionalFormatting).length, 1);
  assert.equal(broken.indexOf(popDirectionalFormatting), at);
  assert.equal(broken.startsWith(popDirectionalFormatting), false);
  assert.equal(broken.endsWith(popDirectionalFormatting), false);
  assert.notEqual(broken, popDirectionalFormatting + legal);
  assert.notEqual(broken, legal + popDirectionalFormatting);
  assert.notEqual(broken, rightToLeftEmbeddingMiddle);
  assert.notEqual(broken, leftToRightEmbeddingMiddle);
  assert.notEqual(broken, rightToLeftMarkMiddle);
  assert.equal(broken.trim(), broken);
  assert.notEqual(broken.trim(), legal);
  assert.notEqual(broken.trim(), "");
  assert.equal((popDirectionalFormatting + legal).trim(), popDirectionalFormatting + legal);
  assert.notEqual((popDirectionalFormatting + legal).trim(), legal);
  assert.equal((legal + popDirectionalFormatting).trim(), legal + popDirectionalFormatting);
  assert.notEqual((legal + popDirectionalFormatting).trim(), legal);
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
  assert.equal(rightToLeftEmbeddingMiddle.trim(), rightToLeftEmbeddingMiddle);
  assert.notEqual(rightToLeftEmbeddingMiddle.trim(), legal);
  assert.equal(leftToRightEmbeddingMiddle.trim(), leftToRightEmbeddingMiddle);
  assert.notEqual(leftToRightEmbeddingMiddle.trim(), legal);
  assert.equal(rightToLeftMarkMiddle.trim(), rightToLeftMarkMiddle);
  assert.notEqual(rightToLeftMarkMiddle.trim(), legal);
  assert.equal(/\s/.test(broken), false);
  assert.equal(/\s/.test(rightToLeftEmbeddingMiddle), false);
  assert.equal(/\s/.test(leftToRightEmbeddingMiddle), false);
  assert.equal(/\s/.test(rightToLeftMarkMiddle), false);
  assert.equal(/\p{Cf}/u.test(broken), true);
  assert.equal(/\p{Cc}/u.test(broken), false);
  assert.equal(/\p{Zl}/u.test(broken), false);
  assert.equal(/\p{Bidi_Control}/u.test(broken), true);
  assert.equal(/\p{White_Space}/u.test(broken), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(broken), false);
  assert.equal(/\p{Cf}/u.test(rightToLeftEmbeddingMiddle), true);
  assert.equal(/\p{Cc}/u.test(rightToLeftEmbeddingMiddle), false);
  assert.equal(/\p{Bidi_Control}/u.test(rightToLeftEmbeddingMiddle), true);
  assert.equal(/\p{White_Space}/u.test(rightToLeftEmbeddingMiddle), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(rightToLeftEmbeddingMiddle), false);
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
  assert.equal(broken.includes(rightToLeftEmbedding), false);
  assert.equal(broken.includes(leftToRightEmbedding), false);
  assert.equal(broken.includes(rightToLeftMark), false);
  assert.equal(rightToLeftEmbeddingMiddle.charCodeAt(at), 0x202B);
  assert.equal(rightToLeftEmbeddingMiddle.includes(popDirectionalFormatting), false);
  assert.equal(rightToLeftEmbeddingMiddle.includes(leftToRightEmbedding), false);
  assert.equal(rightToLeftEmbeddingMiddle.includes(rightToLeftMark), false);
  assert.equal(leftToRightEmbeddingMiddle.charCodeAt(at), 0x202A);
  assert.equal(leftToRightEmbeddingMiddle.includes(popDirectionalFormatting), false);
  assert.equal(leftToRightEmbeddingMiddle.includes(rightToLeftEmbedding), false);
  assert.equal(leftToRightEmbeddingMiddle.includes(rightToLeftMark), false);
  assert.equal(rightToLeftMarkMiddle.charCodeAt(at), 0x200F);
  assert.equal(rightToLeftMarkMiddle.includes(popDirectionalFormatting), false);
  assert.equal(rightToLeftMarkMiddle.includes(rightToLeftEmbedding), false);
  assert.equal(rightToLeftMarkMiddle.includes(leftToRightEmbedding), false);
  assert.equal(uuid.test(broken), false);
  const optionIds = questions.flatMap(question => question.options.map(option => option.id));
  assert.equal(optionIds.includes(legal), true);
  assert.equal(optionIds.includes(broken), false);
  assert.equal(optionIds.includes(rightToLeftEmbeddingMiddle), false);
  assert.equal(optionIds.includes(leftToRightEmbeddingMiddle), false);
  assert.equal(optionIds.includes(rightToLeftMarkMiddle), false);
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
  assert.equal(payload.choices[0].charCodeAt(at), 0x202C);
  assert.equal(roundTrip.choices[0], broken);
  assert.equal(roundTrip.choices[0].charCodeAt(at), 0x202C);
  assert.notEqual(roundTrip.choices[0].charCodeAt(at), 0x202B);
  assert.notEqual(roundTrip.choices[0].charCodeAt(at), 0x202A);
  assert.notEqual(roundTrip.choices[0].charCodeAt(at), 0x200F);
  assert.equal(payload.choices[0] === legal, false);
  assert.equal(payload.choices[0] === rightToLeftEmbeddingMiddle, false);
  assert.equal(payload.choices[0] === leftToRightEmbeddingMiddle, false);
  assert.equal(payload.choices[0] === rightToLeftMarkMiddle, false);
  assert.equal(raw.includes(popDirectionalFormatting), true);
  assert.equal(raw.includes("\\u202C"), false);
  assert.equal(raw.includes("\\u202c"), false);
  assert.equal(raw.includes(rightToLeftEmbedding), false);
  assert.equal(raw.includes("\\u202B"), false);
  assert.equal(raw.includes("\\u202b"), false);
  assert.equal(raw.includes(leftToRightEmbedding), false);
  assert.equal(raw.includes("\\u202A"), false);
  assert.equal(raw.includes("\\u202a"), false);
  assert.equal(raw.includes(rightToLeftMark), false);
  assert.equal(raw.includes("\\u200F"), false);
  assert.equal(raw.includes("\\u200f"), false);
  assert.equal(raw.includes(legal), false);
  assert.equal(JSON.stringify(broken).includes(popDirectionalFormatting), true);
  assert.equal(JSON.stringify(broken).includes("\\"), false);
  assert.equal(JSON.stringify(broken).includes("\\u202C"), false);
  assert.equal(JSON.stringify(broken).includes("\\u202c"), false);
  assert.equal(JSON.stringify(broken).includes("\\u202B"), false);
  assert.equal(JSON.stringify(broken).includes("\\u202A"), false);
  assert.equal(JSON.stringify(broken).includes("\\u200F"), false);
  assert.equal(JSON.stringify(rightToLeftEmbeddingMiddle).includes(rightToLeftEmbedding), true);
  assert.equal(JSON.stringify(rightToLeftEmbeddingMiddle).includes("\\"), false);
  assert.equal(JSON.stringify(rightToLeftEmbeddingMiddle).includes("\\u202B"), false);
  assert.equal(JSON.stringify(rightToLeftEmbeddingMiddle).includes("\\u202b"), false);
  assert.equal(JSON.stringify(rightToLeftEmbeddingMiddle).includes("\\u202C"), false);
  assert.equal(JSON.stringify(rightToLeftEmbeddingMiddle).includes(popDirectionalFormatting), false);
  assert.equal(JSON.stringify(leftToRightEmbeddingMiddle).includes(leftToRightEmbedding), true);
  assert.equal(JSON.stringify(leftToRightEmbeddingMiddle).includes("\\"), false);
  assert.equal(JSON.stringify(leftToRightEmbeddingMiddle).includes("\\u202A"), false);
  assert.equal(JSON.stringify(leftToRightEmbeddingMiddle).includes("\\u202a"), false);
  assert.equal(JSON.stringify(leftToRightEmbeddingMiddle).includes("\\u202C"), false);
  assert.equal(JSON.stringify(leftToRightEmbeddingMiddle).includes(popDirectionalFormatting), false);
  assert.equal(JSON.stringify(rightToLeftMarkMiddle).includes(rightToLeftMark), true);
  assert.equal(JSON.stringify(rightToLeftMarkMiddle).includes("\\"), false);
  assert.equal(JSON.stringify(rightToLeftMarkMiddle).includes("\\u200F"), false);
  assert.equal(JSON.stringify(rightToLeftMarkMiddle).includes("\\u200f"), false);
  assert.equal(JSON.stringify(rightToLeftMarkMiddle).includes("\\u202C"), false);
  assert.equal(JSON.stringify(rightToLeftMarkMiddle).includes(popDirectionalFormatting), false);
  assert.notEqual(JSON.stringify(broken), JSON.stringify(rightToLeftEmbeddingMiddle));
  assert.notEqual(JSON.stringify(broken), JSON.stringify(leftToRightEmbeddingMiddle));
  assert.notEqual(JSON.stringify(broken), JSON.stringify(rightToLeftMarkMiddle));
  f.resetWrites();
  const refused = await read(await f.req("/api/answers", "PUT", payload, { cookie }));
  assert.equal(refused.status, 422, JSON.stringify(refused.body));
  assert.equal(refused.body.error, "Choose an available answer.");
  assert.equal(refused.headers.get("Set-Cookie"), null);
  assert.equal(refused.text.includes(secret), false);
  assert.equal(refused.text.includes(sessionSecret), false);
  assert.equal(refused.text.includes(broken), false);
  assert.equal(refused.text.includes(popDirectionalFormatting), false);
  assert.equal(refused.text.includes("\\u202C"), false);
  assert.equal(refused.text.includes("\\u202c"), false);
  assert.equal(refused.text.includes(rightToLeftEmbedding), false);
  assert.equal(refused.text.includes("\\u202B"), false);
  assert.equal(refused.text.includes("\\u202b"), false);
  assert.equal(refused.text.includes(leftToRightEmbedding), false);
  assert.equal(refused.text.includes("\\u202A"), false);
  assert.equal(refused.text.includes("\\u202a"), false);
  assert.equal(refused.text.includes(rightToLeftMark), false);
  assert.equal(refused.text.includes("\\u200F"), false);
  assert.equal(refused.text.includes("\\u200f"), false);
  assert.equal(refused.text.includes(legal), false);
  assert.deepEqual(f.written, []);

  const after = stored(f, reference);
  assert.deepEqual(after, snapshot);
  assert.deepEqual(after.answers, {});
  assert.equal(Object.hasOwn(after.answers, target.id), false);
  assert.equal(JSON.stringify(after.answers).includes(popDirectionalFormatting), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u202C"), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u202c"), false);
  assert.equal(JSON.stringify(after.answers).includes(rightToLeftEmbedding), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u202B"), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u202b"), false);
  assert.equal(JSON.stringify(after.answers).includes(leftToRightEmbedding), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u202A"), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u202a"), false);
  assert.equal(JSON.stringify(after.answers).includes(rightToLeftMark), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u200F"), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u200f"), false);
  assert.equal(JSON.stringify(after.answers).includes(legal), false);
  assert.equal(JSON.stringify(after).includes(popDirectionalFormatting), false);
  assert.equal(JSON.stringify(after).includes("\\u202C"), false);
  assert.equal(JSON.stringify(after).includes("\\u202c"), false);
  assert.equal(JSON.stringify(after).includes(rightToLeftEmbedding), false);
  assert.equal(JSON.stringify(after).includes("\\u202B"), false);
  assert.equal(JSON.stringify(after).includes("\\u202b"), false);
  assert.equal(JSON.stringify(after).includes(leftToRightEmbedding), false);
  assert.equal(JSON.stringify(after).includes("\\u202A"), false);
  assert.equal(JSON.stringify(after).includes("\\u202a"), false);
  assert.equal(JSON.stringify(after).includes(rightToLeftMark), false);
  assert.equal(JSON.stringify(after).includes("\\u200F"), false);
  assert.equal(JSON.stringify(after).includes("\\u200f"), false);
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
  assert.equal(viewed.text.includes(popDirectionalFormatting), false);
  assert.equal(viewed.text.includes("\\u202C"), false);
  assert.equal(viewed.text.includes("\\u202c"), false);
  assert.equal(viewed.text.includes(rightToLeftEmbedding), false);
  assert.equal(viewed.text.includes("\\u202B"), false);
  assert.equal(viewed.text.includes("\\u202b"), false);
  assert.equal(viewed.text.includes(leftToRightEmbedding), false);
  assert.equal(viewed.text.includes("\\u202A"), false);
  assert.equal(viewed.text.includes("\\u202a"), false);
  assert.equal(viewed.text.includes(rightToLeftMark), false);
  assert.equal(viewed.text.includes("\\u200F"), false);
  assert.equal(viewed.text.includes("\\u200f"), false);
  assert.equal(f.records.get(reference).etag, openedEtag);
  assert.equal(stored(f, reference).inviteHash, inviteHash);
  assert.equal(stored(f, reference).sessionHash, sessionHash);
  assert.deepEqual(stored(f, reference).answers, {});
});
