import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import worker, { Assessment } from "../src/worker.js";

// One live hiring sitting. Save an answer for a real item on this paper
// whose choice id is that item's legal choice string with a left-to-right
// isolate (U+2066) inserted in the middle. The save is refused.
// No answer is stored. The invite hash and the session secret stay unchanged.
// A right-to-left override (U+202E) in the middle, a left-to-right
// override (U+202D) in the middle, and a pop directional formatting
// character (U+202C) in the middle are separate checks.

const origin = "https://assessment.example";
const notice = {
  controller: "Test controller", contact: "privacy@example.invalid", basis: "Test basis",
  recipients: "Test reviewer", transfers: "Test transfer description", rights: "Test rights",
  purpose: "Test purpose", supervisoryAuthority: "Test authority", version: "test-1", retentionMinutes: 30,
};
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const random = () => crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
const leftToRightIsolate = "\u2066";
const rightToLeftOverride = "\u202E";
const leftToRightOverride = "\u202D";
const popDirectionalFormatting = "\u202C";

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

test("a legal choice with a left-to-right isolate (U+2066) inserted in the middle is refused and stores nothing", async () => {
  const source = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(source, /"LIVE_ENABLED": "false"/);
  assert.equal(leftToRightIsolate, "\u2066");
  assert.equal(leftToRightIsolate.charCodeAt(0), 0x2066);
  assert.equal(leftToRightIsolate.codePointAt(0), 0x2066);
  assert.equal(leftToRightIsolate.length, 1);
  assert.notEqual(leftToRightIsolate, rightToLeftOverride);
  assert.notEqual(leftToRightIsolate.charCodeAt(0), 0x202E);
  assert.notEqual(leftToRightIsolate, leftToRightOverride);
  assert.notEqual(leftToRightIsolate.charCodeAt(0), 0x202D);
  assert.notEqual(leftToRightIsolate, popDirectionalFormatting);
  assert.notEqual(leftToRightIsolate.charCodeAt(0), 0x202C);
  assert.equal(rightToLeftOverride, "\u202E");
  assert.equal(rightToLeftOverride.charCodeAt(0), 0x202E);
  assert.equal(rightToLeftOverride.codePointAt(0), 0x202E);
  assert.equal(rightToLeftOverride.length, 1);
  assert.equal(leftToRightOverride, "\u202D");
  assert.equal(leftToRightOverride.charCodeAt(0), 0x202D);
  assert.equal(leftToRightOverride.codePointAt(0), 0x202D);
  assert.equal(leftToRightOverride.length, 1);
  assert.equal(popDirectionalFormatting, "\u202C");
  assert.equal(popDirectionalFormatting.charCodeAt(0), 0x202C);
  assert.equal(popDirectionalFormatting.codePointAt(0), 0x202C);
  assert.equal(popDirectionalFormatting.length, 1);
  assert.equal(/\s/.test(leftToRightIsolate), false);
  assert.equal(/\p{Cf}/u.test(leftToRightIsolate), true);
  assert.equal(/\p{Cc}/u.test(leftToRightIsolate), false);
  assert.equal(/\p{Zl}/u.test(leftToRightIsolate), false);
  assert.equal(/\p{Zp}/u.test(leftToRightIsolate), false);
  assert.equal(/\p{Zs}/u.test(leftToRightIsolate), false);
  assert.equal(/\p{White_Space}/u.test(leftToRightIsolate), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(leftToRightIsolate), false);
  assert.equal(/\p{Bidi_Control}/u.test(leftToRightIsolate), true);
  assert.equal(/\s/.test(rightToLeftOverride), false);
  assert.equal(/\p{Cf}/u.test(rightToLeftOverride), true);
  assert.equal(/\p{Cc}/u.test(rightToLeftOverride), false);
  assert.equal(/\p{Zl}/u.test(rightToLeftOverride), false);
  assert.equal(/\p{Zp}/u.test(rightToLeftOverride), false);
  assert.equal(/\p{Zs}/u.test(rightToLeftOverride), false);
  assert.equal(/\p{White_Space}/u.test(rightToLeftOverride), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(rightToLeftOverride), false);
  assert.equal(/\p{Bidi_Control}/u.test(rightToLeftOverride), true);
  assert.equal(/\s/.test(leftToRightOverride), false);
  assert.equal(/\p{Cf}/u.test(leftToRightOverride), true);
  assert.equal(/\p{Cc}/u.test(leftToRightOverride), false);
  assert.equal(/\p{Zl}/u.test(leftToRightOverride), false);
  assert.equal(/\p{Zp}/u.test(leftToRightOverride), false);
  assert.equal(/\p{Zs}/u.test(leftToRightOverride), false);
  assert.equal(/\p{White_Space}/u.test(leftToRightOverride), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(leftToRightOverride), false);
  assert.equal(/\p{Bidi_Control}/u.test(leftToRightOverride), true);
  assert.equal(/\s/.test(popDirectionalFormatting), false);
  assert.equal(/\p{Cf}/u.test(popDirectionalFormatting), true);
  assert.equal(/\p{Cc}/u.test(popDirectionalFormatting), false);
  assert.equal(/\p{Zl}/u.test(popDirectionalFormatting), false);
  assert.equal(/\p{Zp}/u.test(popDirectionalFormatting), false);
  assert.equal(/\p{Zs}/u.test(popDirectionalFormatting), false);
  assert.equal(/\p{White_Space}/u.test(popDirectionalFormatting), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(popDirectionalFormatting), false);
  assert.equal(/\p{Bidi_Control}/u.test(popDirectionalFormatting), true);
  assert.equal(leftToRightIsolate.trim(), leftToRightIsolate);
  assert.notEqual(leftToRightIsolate.trim(), "");
  assert.equal(rightToLeftOverride.trim(), rightToLeftOverride);
  assert.notEqual(rightToLeftOverride.trim(), "");
  assert.equal(leftToRightOverride.trim(), leftToRightOverride);
  assert.notEqual(leftToRightOverride.trim(), "");
  assert.equal(popDirectionalFormatting.trim(), popDirectionalFormatting);
  assert.notEqual(popDirectionalFormatting.trim(), "");
  assert.equal(JSON.stringify(leftToRightIsolate), '"' + leftToRightIsolate + '"');
  assert.equal(JSON.stringify(leftToRightIsolate).includes(leftToRightIsolate), true);
  assert.equal(JSON.stringify(leftToRightIsolate).includes("\\"), false);
  assert.equal(JSON.stringify(leftToRightIsolate).includes("\\u2066"), false);
  assert.equal(JSON.stringify(leftToRightIsolate).includes("\\u2066"), false);
  assert.equal(JSON.stringify(leftToRightIsolate).includes("\\u202E"), false);
  assert.equal(JSON.stringify(leftToRightIsolate).includes("\\u202e"), false);
  assert.equal(JSON.stringify(leftToRightIsolate).includes("\\u202D"), false);
  assert.equal(JSON.stringify(leftToRightIsolate).includes("\\u202d"), false);
  assert.equal(JSON.stringify(leftToRightIsolate).includes("\\u202C"), false);
  assert.equal(JSON.stringify(leftToRightIsolate).includes("\\u202c"), false);
  assert.notEqual(JSON.stringify(leftToRightIsolate), "\\u2066");
  assert.equal(JSON.stringify(rightToLeftOverride), '"' + rightToLeftOverride + '"');
  assert.equal(JSON.stringify(rightToLeftOverride).includes(rightToLeftOverride), true);
  assert.equal(JSON.stringify(rightToLeftOverride).includes("\\"), false);
  assert.equal(JSON.stringify(rightToLeftOverride).includes("\\u202E"), false);
  assert.equal(JSON.stringify(rightToLeftOverride).includes("\\u202e"), false);
  assert.equal(JSON.stringify(rightToLeftOverride).includes("\\u2066"), false);
  assert.equal(JSON.stringify(rightToLeftOverride).includes("\\u2066"), false);
  assert.notEqual(JSON.stringify(rightToLeftOverride), "\\u202E");
  assert.notEqual(JSON.stringify(rightToLeftOverride), "\\u2066");
  assert.notEqual(JSON.stringify(rightToLeftOverride), JSON.stringify(leftToRightIsolate));
  assert.equal(JSON.stringify(leftToRightOverride), '"' + leftToRightOverride + '"');
  assert.equal(JSON.stringify(leftToRightOverride).includes(leftToRightOverride), true);
  assert.equal(JSON.stringify(leftToRightOverride).includes("\\"), false);
  assert.equal(JSON.stringify(leftToRightOverride).includes("\\u202D"), false);
  assert.equal(JSON.stringify(leftToRightOverride).includes("\\u202d"), false);
  assert.equal(JSON.stringify(leftToRightOverride).includes("\\u2066"), false);
  assert.equal(JSON.stringify(leftToRightOverride).includes("\\u2066"), false);
  assert.notEqual(JSON.stringify(leftToRightOverride), "\\u202D");
  assert.notEqual(JSON.stringify(leftToRightOverride), "\\u2066");
  assert.notEqual(JSON.stringify(leftToRightOverride), JSON.stringify(leftToRightIsolate));
  assert.equal(JSON.stringify(popDirectionalFormatting), '"' + popDirectionalFormatting + '"');
  assert.equal(JSON.stringify(popDirectionalFormatting).includes(popDirectionalFormatting), true);
  assert.equal(JSON.stringify(popDirectionalFormatting).includes("\\"), false);
  assert.equal(JSON.stringify(popDirectionalFormatting).includes("\\u202C"), false);
  assert.equal(JSON.stringify(popDirectionalFormatting).includes("\\u202c"), false);
  assert.equal(JSON.stringify(popDirectionalFormatting).includes("\\u2066"), false);
  assert.equal(JSON.stringify(popDirectionalFormatting).includes("\\u2066"), false);
  assert.notEqual(JSON.stringify(popDirectionalFormatting), "\\u202C");
  assert.notEqual(JSON.stringify(popDirectionalFormatting), "\\u2066");
  assert.notEqual(JSON.stringify(popDirectionalFormatting), JSON.stringify(leftToRightIsolate));
  assert.notEqual(JSON.stringify(leftToRightIsolate), JSON.stringify(rightToLeftOverride));
  assert.notEqual(JSON.stringify(leftToRightIsolate), JSON.stringify(leftToRightOverride));
  assert.notEqual(JSON.stringify(leftToRightIsolate), JSON.stringify(popDirectionalFormatting));

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
  assert.ok(target, "a real item has a legal choice that can take an interior left-to-right isolate (U+2066)");
  const legal = target.options.find(option => uuid.test(option.id)).id;
  assert.equal(questions.some(question => question.id === target.id), true);
  assert.equal(target.options.some(option => option.id === legal), true);
  assert.equal(uuid.test(legal), true);
  assert.equal(uuid.test(target.id), true);
  assert.equal(legal.length, 36);
  assert.equal(legal.includes(leftToRightIsolate), false);
  assert.equal(legal.includes(rightToLeftOverride), false);
  assert.equal(legal.includes(leftToRightOverride), false);
  assert.equal(legal.includes(popDirectionalFormatting), false);
  assert.equal(legal.trim(), legal);
  assert.equal(/\p{Pattern_White_Space}/u.test(legal), false);

  const inserted = insertedInMiddle(legal, leftToRightIsolate);
  const broken = inserted.value;
  const at = inserted.at;
  const rightToLeftOverrideMiddle = insertedInMiddle(legal, rightToLeftOverride).value;
  const leftToRightOverrideMiddle = insertedInMiddle(legal, leftToRightOverride).value;
  const popDirectionalFormattingMiddle = insertedInMiddle(legal, popDirectionalFormatting).value;
  assert.ok(at > 0 && at < legal.length);
  assert.equal(at, 18);
  assert.equal(legal.charCodeAt(at), 0x002D);
  assert.equal(broken.charCodeAt(at), 0x2066);
  assert.equal(broken.charCodeAt(at + 1), 0x002D);
  assert.notEqual(broken.charCodeAt(at), 0x202E);
  assert.notEqual(broken.charCodeAt(at), 0x202D);
  assert.notEqual(broken.charCodeAt(at), 0x202C);
  assert.equal(broken.slice(0, at), legal.slice(0, at));
  assert.equal(broken.slice(at + 1), legal.slice(at));
  assert.equal(broken.length, legal.length + 1);
  assert.notEqual(broken, legal);
  assert.equal(broken.replace(leftToRightIsolate, ""), legal);
  assert.equal([...broken].filter(char => char === leftToRightIsolate).length, 1);
  assert.equal(broken.indexOf(leftToRightIsolate), at);
  assert.equal(broken.startsWith(leftToRightIsolate), false);
  assert.equal(broken.endsWith(leftToRightIsolate), false);
  assert.notEqual(broken, leftToRightIsolate + legal);
  assert.notEqual(broken, legal + leftToRightIsolate);
  assert.notEqual(broken, rightToLeftOverrideMiddle);
  assert.notEqual(broken, leftToRightOverrideMiddle);
  assert.notEqual(broken, popDirectionalFormattingMiddle);
  assert.equal(broken.trim(), broken);
  assert.notEqual(broken.trim(), legal);
  assert.notEqual(broken.trim(), "");
  assert.equal((leftToRightIsolate + legal).trim(), leftToRightIsolate + legal);
  assert.notEqual((leftToRightIsolate + legal).trim(), legal);
  assert.equal((legal + leftToRightIsolate).trim(), legal + leftToRightIsolate);
  assert.notEqual((legal + leftToRightIsolate).trim(), legal);
  assert.equal((rightToLeftOverride + legal).trim(), rightToLeftOverride + legal);
  assert.notEqual((rightToLeftOverride + legal).trim(), legal);
  assert.equal((legal + rightToLeftOverride).trim(), legal + rightToLeftOverride);
  assert.notEqual((legal + rightToLeftOverride).trim(), legal);
  assert.equal((leftToRightOverride + legal).trim(), leftToRightOverride + legal);
  assert.notEqual((leftToRightOverride + legal).trim(), legal);
  assert.equal((legal + leftToRightOverride).trim(), legal + leftToRightOverride);
  assert.notEqual((legal + leftToRightOverride).trim(), legal);
  assert.equal((popDirectionalFormatting + legal).trim(), popDirectionalFormatting + legal);
  assert.notEqual((popDirectionalFormatting + legal).trim(), legal);
  assert.equal((legal + popDirectionalFormatting).trim(), legal + popDirectionalFormatting);
  assert.notEqual((legal + popDirectionalFormatting).trim(), legal);
  assert.equal(rightToLeftOverrideMiddle.trim(), rightToLeftOverrideMiddle);
  assert.notEqual(rightToLeftOverrideMiddle.trim(), legal);
  assert.equal(leftToRightOverrideMiddle.trim(), leftToRightOverrideMiddle);
  assert.notEqual(leftToRightOverrideMiddle.trim(), legal);
  assert.equal(popDirectionalFormattingMiddle.trim(), popDirectionalFormattingMiddle);
  assert.notEqual(popDirectionalFormattingMiddle.trim(), legal);
  assert.equal(/\s/.test(broken), false);
  assert.equal(/\s/.test(rightToLeftOverrideMiddle), false);
  assert.equal(/\s/.test(leftToRightOverrideMiddle), false);
  assert.equal(/\s/.test(popDirectionalFormattingMiddle), false);
  assert.equal(/\p{Cf}/u.test(broken), true);
  assert.equal(/\p{Cc}/u.test(broken), false);
  assert.equal(/\p{Zl}/u.test(broken), false);
  assert.equal(/\p{Bidi_Control}/u.test(broken), true);
  assert.equal(/\p{White_Space}/u.test(broken), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(broken), false);
  assert.equal(/\p{Cf}/u.test(rightToLeftOverrideMiddle), true);
  assert.equal(/\p{Cc}/u.test(rightToLeftOverrideMiddle), false);
  assert.equal(/\p{Zl}/u.test(rightToLeftOverrideMiddle), false);
  assert.equal(/\p{Bidi_Control}/u.test(rightToLeftOverrideMiddle), true);
  assert.equal(/\p{White_Space}/u.test(rightToLeftOverrideMiddle), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(rightToLeftOverrideMiddle), false);
  assert.equal(/\p{Cf}/u.test(leftToRightOverrideMiddle), true);
  assert.equal(/\p{Cc}/u.test(leftToRightOverrideMiddle), false);
  assert.equal(/\p{Zl}/u.test(leftToRightOverrideMiddle), false);
  assert.equal(/\p{Bidi_Control}/u.test(leftToRightOverrideMiddle), true);
  assert.equal(/\p{White_Space}/u.test(leftToRightOverrideMiddle), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(leftToRightOverrideMiddle), false);
  assert.equal(/\p{Cf}/u.test(popDirectionalFormattingMiddle), true);
  assert.equal(/\p{Cc}/u.test(popDirectionalFormattingMiddle), false);
  assert.equal(/\p{Zl}/u.test(popDirectionalFormattingMiddle), false);
  assert.equal(/\p{Bidi_Control}/u.test(popDirectionalFormattingMiddle), true);
  assert.equal(/\p{White_Space}/u.test(popDirectionalFormattingMiddle), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(popDirectionalFormattingMiddle), false);
  assert.equal(broken.includes(rightToLeftOverride), false);
  assert.equal(broken.includes(leftToRightOverride), false);
  assert.equal(broken.includes(popDirectionalFormatting), false);
  assert.equal(rightToLeftOverrideMiddle.charCodeAt(at), 0x202E);
  assert.equal(rightToLeftOverrideMiddle.includes(leftToRightIsolate), false);
  assert.equal(rightToLeftOverrideMiddle.includes(leftToRightOverride), false);
  assert.equal(rightToLeftOverrideMiddle.includes(popDirectionalFormatting), false);
  assert.equal(leftToRightOverrideMiddle.charCodeAt(at), 0x202D);
  assert.equal(leftToRightOverrideMiddle.includes(leftToRightIsolate), false);
  assert.equal(leftToRightOverrideMiddle.includes(rightToLeftOverride), false);
  assert.equal(leftToRightOverrideMiddle.includes(popDirectionalFormatting), false);
  assert.equal(popDirectionalFormattingMiddle.charCodeAt(at), 0x202C);
  assert.equal(popDirectionalFormattingMiddle.includes(leftToRightIsolate), false);
  assert.equal(popDirectionalFormattingMiddle.includes(rightToLeftOverride), false);
  assert.equal(popDirectionalFormattingMiddle.includes(leftToRightOverride), false);
  assert.equal(uuid.test(broken), false);
  const optionIds = questions.flatMap(question => question.options.map(option => option.id));
  assert.equal(optionIds.includes(legal), true);
  assert.equal(optionIds.includes(broken), false);
  assert.equal(optionIds.includes(rightToLeftOverrideMiddle), false);
  assert.equal(optionIds.includes(leftToRightOverrideMiddle), false);
  assert.equal(optionIds.includes(popDirectionalFormattingMiddle), false);
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
  assert.equal(payload.choices[0].charCodeAt(at), 0x2066);
  assert.equal(roundTrip.choices[0], broken);
  assert.equal(roundTrip.choices[0].charCodeAt(at), 0x2066);
  assert.notEqual(roundTrip.choices[0].charCodeAt(at), 0x202E);
  assert.notEqual(roundTrip.choices[0].charCodeAt(at), 0x202D);
  assert.notEqual(roundTrip.choices[0].charCodeAt(at), 0x202C);
  assert.equal(payload.choices[0] === legal, false);
  assert.equal(payload.choices[0] === rightToLeftOverrideMiddle, false);
  assert.equal(payload.choices[0] === leftToRightOverrideMiddle, false);
  assert.equal(payload.choices[0] === popDirectionalFormattingMiddle, false);
  assert.equal(raw.includes(leftToRightIsolate), true);
  assert.equal(raw.includes("\\u2066"), false);
  assert.equal(raw.includes("\\u2066"), false);
  assert.equal(raw.includes(rightToLeftOverride), false);
  assert.equal(raw.includes("\\u202E"), false);
  assert.equal(raw.includes("\\u202e"), false);
  assert.equal(raw.includes(leftToRightOverride), false);
  assert.equal(raw.includes("\\u202D"), false);
  assert.equal(raw.includes("\\u202d"), false);
  assert.equal(raw.includes(popDirectionalFormatting), false);
  assert.equal(raw.includes("\\u202C"), false);
  assert.equal(raw.includes("\\u202c"), false);
  assert.equal(raw.includes(legal), false);
  assert.equal(JSON.stringify(broken).includes(leftToRightIsolate), true);
  assert.equal(JSON.stringify(broken).includes("\\"), false);
  assert.equal(JSON.stringify(broken).includes("\\u2066"), false);
  assert.equal(JSON.stringify(broken).includes("\\u2066"), false);
  assert.equal(JSON.stringify(broken).includes("\\u202E"), false);
  assert.equal(JSON.stringify(broken).includes(rightToLeftOverride), false);
  assert.equal(JSON.stringify(broken).includes("\\u202D"), false);
  assert.equal(JSON.stringify(broken).includes(leftToRightOverride), false);
  assert.equal(JSON.stringify(broken).includes("\\u202C"), false);
  assert.equal(JSON.stringify(broken).includes(popDirectionalFormatting), false);
  assert.equal(JSON.stringify(rightToLeftOverrideMiddle).includes(rightToLeftOverride), true);
  assert.equal(JSON.stringify(rightToLeftOverrideMiddle).includes("\\"), false);
  assert.equal(JSON.stringify(rightToLeftOverrideMiddle).includes("\\u202E"), false);
  assert.equal(JSON.stringify(rightToLeftOverrideMiddle).includes("\\u202e"), false);
  assert.equal(JSON.stringify(rightToLeftOverrideMiddle).includes("\\u2066"), false);
  assert.equal(JSON.stringify(rightToLeftOverrideMiddle).includes(leftToRightIsolate), false);
  assert.equal(JSON.stringify(rightToLeftOverrideMiddle).includes("\\u202D"), false);
  assert.equal(JSON.stringify(rightToLeftOverrideMiddle).includes(leftToRightOverride), false);
  assert.equal(JSON.stringify(rightToLeftOverrideMiddle).includes("\\u202C"), false);
  assert.equal(JSON.stringify(rightToLeftOverrideMiddle).includes(popDirectionalFormatting), false);
  assert.equal(JSON.stringify(rightToLeftOverrideMiddle).includes(leftToRightIsolate), false);
  assert.equal(JSON.stringify(leftToRightOverrideMiddle).includes(leftToRightOverride), true);
  assert.equal(JSON.stringify(leftToRightOverrideMiddle).includes("\\"), false);
  assert.equal(JSON.stringify(leftToRightOverrideMiddle).includes("\\u202D"), false);
  assert.equal(JSON.stringify(leftToRightOverrideMiddle).includes("\\u202d"), false);
  assert.equal(JSON.stringify(leftToRightOverrideMiddle).includes("\\u2066"), false);
  assert.equal(JSON.stringify(leftToRightOverrideMiddle).includes(leftToRightIsolate), false);
  assert.equal(JSON.stringify(leftToRightOverrideMiddle).includes("\\u202E"), false);
  assert.equal(JSON.stringify(leftToRightOverrideMiddle).includes(rightToLeftOverride), false);
  assert.equal(JSON.stringify(leftToRightOverrideMiddle).includes("\\u202C"), false);
  assert.equal(JSON.stringify(leftToRightOverrideMiddle).includes(popDirectionalFormatting), false);
  assert.equal(JSON.stringify(leftToRightOverrideMiddle).includes(leftToRightIsolate), false);
  assert.equal(JSON.stringify(popDirectionalFormattingMiddle).includes(popDirectionalFormatting), true);
  assert.equal(JSON.stringify(popDirectionalFormattingMiddle).includes("\\"), false);
  assert.equal(JSON.stringify(popDirectionalFormattingMiddle).includes("\\u202C"), false);
  assert.equal(JSON.stringify(popDirectionalFormattingMiddle).includes("\\u202c"), false);
  assert.equal(JSON.stringify(popDirectionalFormattingMiddle).includes("\\u2066"), false);
  assert.equal(JSON.stringify(popDirectionalFormattingMiddle).includes(leftToRightIsolate), false);
  assert.equal(JSON.stringify(popDirectionalFormattingMiddle).includes("\\u202E"), false);
  assert.equal(JSON.stringify(popDirectionalFormattingMiddle).includes(rightToLeftOverride), false);
  assert.equal(JSON.stringify(popDirectionalFormattingMiddle).includes("\\u202D"), false);
  assert.equal(JSON.stringify(popDirectionalFormattingMiddle).includes(leftToRightOverride), false);
  assert.equal(JSON.stringify(popDirectionalFormattingMiddle).includes(leftToRightIsolate), false);
  assert.notEqual(JSON.stringify(broken), JSON.stringify(rightToLeftOverrideMiddle));
  assert.notEqual(JSON.stringify(broken), JSON.stringify(leftToRightOverrideMiddle));
  assert.notEqual(JSON.stringify(broken), JSON.stringify(popDirectionalFormattingMiddle));
  f.resetWrites();
  const refused = await read(await f.req("/api/answers", "PUT", payload, { cookie }));
  assert.equal(refused.status, 422, JSON.stringify(refused.body));
  assert.equal(refused.body.error, "Choose an available answer.");
  assert.equal(refused.headers.get("Set-Cookie"), null);
  assert.equal(refused.text.includes(secret), false);
  assert.equal(refused.text.includes(sessionSecret), false);
  assert.equal(refused.text.includes(broken), false);
  assert.equal(refused.text.includes(leftToRightIsolate), false);
  assert.equal(refused.text.includes("\\u2066"), false);
  assert.equal(refused.text.includes("\\u2066"), false);
  assert.equal(refused.text.includes(rightToLeftOverride), false);
  assert.equal(refused.text.includes("\\u202E"), false);
  assert.equal(refused.text.includes("\\u202e"), false);
  assert.equal(refused.text.includes(leftToRightOverride), false);
  assert.equal(refused.text.includes("\\u202D"), false);
  assert.equal(refused.text.includes("\\u202d"), false);
  assert.equal(refused.text.includes(popDirectionalFormatting), false);
  assert.equal(refused.text.includes("\\u202C"), false);
  assert.equal(refused.text.includes("\\u202c"), false);
  assert.equal(refused.text.includes(legal), false);
  assert.deepEqual(f.written, []);

  const after = stored(f, reference);
  assert.deepEqual(after, snapshot);
  assert.deepEqual(after.answers, {});
  assert.equal(Object.hasOwn(after.answers, target.id), false);
  assert.equal(JSON.stringify(after.answers).includes(leftToRightIsolate), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u2066"), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u2066"), false);
  assert.equal(JSON.stringify(after.answers).includes(rightToLeftOverride), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u202E"), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u202e"), false);
  assert.equal(JSON.stringify(after.answers).includes(leftToRightOverride), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u202D"), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u202d"), false);
  assert.equal(JSON.stringify(after.answers).includes(popDirectionalFormatting), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u202C"), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u202c"), false);
  assert.equal(JSON.stringify(after.answers).includes(legal), false);
  assert.equal(JSON.stringify(after).includes(leftToRightIsolate), false);
  assert.equal(JSON.stringify(after).includes("\\u2066"), false);
  assert.equal(JSON.stringify(after).includes("\\u2066"), false);
  assert.equal(JSON.stringify(after).includes(rightToLeftOverride), false);
  assert.equal(JSON.stringify(after).includes("\\u202E"), false);
  assert.equal(JSON.stringify(after).includes("\\u202e"), false);
  assert.equal(JSON.stringify(after).includes(leftToRightOverride), false);
  assert.equal(JSON.stringify(after).includes("\\u202D"), false);
  assert.equal(JSON.stringify(after).includes("\\u202d"), false);
  assert.equal(JSON.stringify(after).includes(popDirectionalFormatting), false);
  assert.equal(JSON.stringify(after).includes("\\u202C"), false);
  assert.equal(JSON.stringify(after).includes("\\u202c"), false);
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
  assert.equal(viewed.text.includes(leftToRightIsolate), false);
  assert.equal(viewed.text.includes("\\u2066"), false);
  assert.equal(viewed.text.includes("\\u2066"), false);
  assert.equal(viewed.text.includes(rightToLeftOverride), false);
  assert.equal(viewed.text.includes("\\u202E"), false);
  assert.equal(viewed.text.includes("\\u202e"), false);
  assert.equal(viewed.text.includes(leftToRightOverride), false);
  assert.equal(viewed.text.includes("\\u202D"), false);
  assert.equal(viewed.text.includes("\\u202d"), false);
  assert.equal(viewed.text.includes(popDirectionalFormatting), false);
  assert.equal(viewed.text.includes("\\u202C"), false);
  assert.equal(viewed.text.includes("\\u202c"), false);
  assert.equal(f.records.get(reference).etag, openedEtag);
  assert.equal(stored(f, reference).inviteHash, inviteHash);
  assert.equal(stored(f, reference).sessionHash, sessionHash);
  assert.deepEqual(stored(f, reference).answers, {});
  assert.deepEqual(f.written, []);
});
