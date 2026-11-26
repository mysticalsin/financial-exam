import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import worker, { Assessment } from "../src/worker.js";

// One live hiring sitting. Save an answer for a real item on this paper
// whose choice id is that item's legal choice string with a left-to-right
// mark (U+200E) inserted in the middle. The save is refused. No answer is
// stored. The invite hash and the session secret stay unchanged. An Arabic
// letter mark (U+061C) in the middle, a Mongolian vowel separator (U+180E)
// in the middle, and an application-program-command character (U+009F) in
// the middle are separate checks.

const origin = "https://assessment.example";
const notice = {
  controller: "Test controller", contact: "privacy@example.invalid", basis: "Test basis",
  recipients: "Test reviewer", transfers: "Test transfer description", rights: "Test rights",
  purpose: "Test purpose", supervisoryAuthority: "Test authority", version: "test-1", retentionMinutes: 30,
};
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const random = () => crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
const leftToRightMark = "\u200E";
const arabicLetterMark = "\u061C";
const mongolianVowelSeparator = "\u180E";
const applicationProgramCommand = "\u009F";

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

test("a legal choice with a left-to-right mark (U+200E) inserted in the middle is refused and stores nothing", async () => {
  const source = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(source, /"LIVE_ENABLED": "false"/);
  assert.equal(leftToRightMark, "\u200E");
  assert.equal(leftToRightMark.charCodeAt(0), 0x200E);
  assert.equal(leftToRightMark.codePointAt(0), 0x200E);
  assert.equal(leftToRightMark.length, 1);
  assert.notEqual(leftToRightMark, arabicLetterMark);
  assert.notEqual(leftToRightMark.charCodeAt(0), 0x061C);
  assert.notEqual(leftToRightMark, mongolianVowelSeparator);
  assert.notEqual(leftToRightMark.charCodeAt(0), 0x180E);
  assert.notEqual(leftToRightMark, applicationProgramCommand);
  assert.notEqual(leftToRightMark.charCodeAt(0), 0x009F);
  assert.equal(arabicLetterMark, "\u061C");
  assert.equal(arabicLetterMark.charCodeAt(0), 0x061C);
  assert.equal(arabicLetterMark.codePointAt(0), 0x061C);
  assert.equal(arabicLetterMark.length, 1);
  assert.equal(mongolianVowelSeparator, "\u180E");
  assert.equal(mongolianVowelSeparator.charCodeAt(0), 0x180E);
  assert.equal(mongolianVowelSeparator.codePointAt(0), 0x180E);
  assert.equal(mongolianVowelSeparator.length, 1);
  assert.equal(applicationProgramCommand, "\u009F");
  assert.equal(applicationProgramCommand.charCodeAt(0), 0x009F);
  assert.equal(applicationProgramCommand.codePointAt(0), 0x009F);
  assert.equal(applicationProgramCommand.length, 1);
  assert.equal(/\s/.test(leftToRightMark), false);
  assert.equal(/\s/.test(arabicLetterMark), false);
  assert.equal(/\s/.test(mongolianVowelSeparator), false);
  assert.equal(/\s/.test(applicationProgramCommand), false);
  assert.equal(/\p{Cf}/u.test(leftToRightMark), true);
  assert.equal(/\p{Cc}/u.test(leftToRightMark), false);
  assert.equal(/\p{Zl}/u.test(leftToRightMark), false);
  assert.equal(/\p{Zp}/u.test(leftToRightMark), false);
  assert.equal(/\p{Zs}/u.test(leftToRightMark), false);
  assert.equal(/\p{White_Space}/u.test(leftToRightMark), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(leftToRightMark), true);
  assert.equal(/\p{Bidi_Control}/u.test(leftToRightMark), true);
  assert.equal(/\p{Cf}/u.test(arabicLetterMark), true);
  assert.equal(/\p{Cc}/u.test(arabicLetterMark), false);
  assert.equal(/\p{Zl}/u.test(arabicLetterMark), false);
  assert.equal(/\p{White_Space}/u.test(arabicLetterMark), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(arabicLetterMark), false);
  assert.equal(/\p{Bidi_Control}/u.test(arabicLetterMark), true);
  assert.equal(/\p{Cf}/u.test(mongolianVowelSeparator), true);
  assert.equal(/\p{Cc}/u.test(mongolianVowelSeparator), false);
  assert.equal(/\p{Zl}/u.test(mongolianVowelSeparator), false);
  assert.equal(/\p{White_Space}/u.test(mongolianVowelSeparator), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(mongolianVowelSeparator), false);
  assert.equal(/\p{Bidi_Control}/u.test(mongolianVowelSeparator), false);
  assert.equal(/\p{Cc}/u.test(applicationProgramCommand), true);
  assert.equal(/\p{Cf}/u.test(applicationProgramCommand), false);
  assert.equal(/\p{Zl}/u.test(applicationProgramCommand), false);
  assert.equal(/\p{White_Space}/u.test(applicationProgramCommand), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(applicationProgramCommand), false);
  assert.equal(/\p{Bidi_Control}/u.test(applicationProgramCommand), false);
  assert.equal(leftToRightMark.trim(), leftToRightMark);
  assert.notEqual(leftToRightMark.trim(), "");
  assert.equal(arabicLetterMark.trim(), arabicLetterMark);
  assert.notEqual(arabicLetterMark.trim(), "");
  assert.equal(mongolianVowelSeparator.trim(), mongolianVowelSeparator);
  assert.notEqual(mongolianVowelSeparator.trim(), "");
  assert.equal(applicationProgramCommand.trim(), applicationProgramCommand);
  assert.notEqual(applicationProgramCommand.trim(), "");
  assert.equal(JSON.stringify(leftToRightMark), '"' + leftToRightMark + '"');
  assert.equal(JSON.stringify(leftToRightMark).includes(leftToRightMark), true);
  assert.equal(JSON.stringify(leftToRightMark).includes("\\"), false);
  assert.equal(JSON.stringify(leftToRightMark).includes("\\u200E"), false);
  assert.equal(JSON.stringify(leftToRightMark).includes("\\u200e"), false);
  assert.notEqual(JSON.stringify(leftToRightMark), '"\\u200E"');
  assert.equal(JSON.stringify(arabicLetterMark), '"' + arabicLetterMark + '"');
  assert.equal(JSON.stringify(arabicLetterMark).includes(arabicLetterMark), true);
  assert.equal(JSON.stringify(arabicLetterMark).includes("\\"), false);
  assert.equal(JSON.stringify(arabicLetterMark).includes("\\u061C"), false);
  assert.equal(JSON.stringify(arabicLetterMark).includes("\\u061c"), false);
  assert.notEqual(JSON.stringify(arabicLetterMark), '"\\u061C"');
  assert.notEqual(JSON.stringify(arabicLetterMark), '"\\u200E"');
  assert.equal(JSON.stringify(mongolianVowelSeparator), '"' + mongolianVowelSeparator + '"');
  assert.equal(JSON.stringify(mongolianVowelSeparator).includes(mongolianVowelSeparator), true);
  assert.equal(JSON.stringify(mongolianVowelSeparator).includes("\\"), false);
  assert.equal(JSON.stringify(mongolianVowelSeparator).includes("\\u180E"), false);
  assert.equal(JSON.stringify(mongolianVowelSeparator).includes("\\u180e"), false);
  assert.notEqual(JSON.stringify(mongolianVowelSeparator), '"\\u180E"');
  assert.notEqual(JSON.stringify(mongolianVowelSeparator), '"\\u200E"');
  assert.equal(JSON.stringify(applicationProgramCommand), '"' + applicationProgramCommand + '"');
  assert.equal(JSON.stringify(applicationProgramCommand).includes(applicationProgramCommand), true);
  assert.equal(JSON.stringify(applicationProgramCommand).includes("\\"), false);
  assert.equal(JSON.stringify(applicationProgramCommand).includes("\\u009F"), false);
  assert.notEqual(JSON.stringify(applicationProgramCommand), '"\\u009F"');
  assert.notEqual(JSON.stringify(applicationProgramCommand), '"\\u200E"');
  assert.notEqual(JSON.stringify(leftToRightMark), JSON.stringify(arabicLetterMark));
  assert.notEqual(JSON.stringify(leftToRightMark), JSON.stringify(mongolianVowelSeparator));
  assert.notEqual(JSON.stringify(leftToRightMark), JSON.stringify(applicationProgramCommand));

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
  assert.ok(target, "a real item has a legal choice that can take an interior left-to-right mark (U+200E)");
  const legal = target.options.find(option => uuid.test(option.id)).id;
  assert.equal(questions.some(question => question.id === target.id), true);
  assert.equal(target.options.some(option => option.id === legal), true);
  assert.equal(uuid.test(legal), true);
  assert.equal(uuid.test(target.id), true);
  assert.equal(legal.length, 36);
  assert.equal(legal.includes(leftToRightMark), false);
  assert.equal(legal.includes(arabicLetterMark), false);
  assert.equal(legal.includes(mongolianVowelSeparator), false);
  assert.equal(legal.includes(applicationProgramCommand), false);
  assert.equal(legal.trim(), legal);
  assert.equal(/\p{Pattern_White_Space}/u.test(legal), false);

  const inserted = insertedInMiddle(legal, leftToRightMark);
  const broken = inserted.value;
  const at = inserted.at;
  const arabicLetterMarkMiddle = insertedInMiddle(legal, arabicLetterMark).value;
  const mongolianVowelSeparatorMiddle = insertedInMiddle(legal, mongolianVowelSeparator).value;
  const applicationProgramCommandMiddle = insertedInMiddle(legal, applicationProgramCommand).value;
  assert.ok(at > 0 && at < legal.length);
  assert.equal(at, 18);
  assert.equal(legal.charCodeAt(at), 0x002D);
  assert.equal(broken.charCodeAt(at), 0x200E);
  assert.equal(broken.charCodeAt(at + 1), 0x002D);
  assert.notEqual(broken.charCodeAt(at), 0x061C);
  assert.notEqual(broken.charCodeAt(at), 0x180E);
  assert.notEqual(broken.charCodeAt(at), 0x009F);
  assert.equal(broken.slice(0, at), legal.slice(0, at));
  assert.equal(broken.slice(at + 1), legal.slice(at));
  assert.equal(broken.length, legal.length + 1);
  assert.notEqual(broken, legal);
  assert.equal(broken.replace(leftToRightMark, ""), legal);
  assert.equal([...broken].filter(char => char === leftToRightMark).length, 1);
  assert.equal(broken.indexOf(leftToRightMark), at);
  assert.equal(broken.startsWith(leftToRightMark), false);
  assert.equal(broken.endsWith(leftToRightMark), false);
  assert.notEqual(broken, leftToRightMark + legal);
  assert.notEqual(broken, legal + leftToRightMark);
  assert.notEqual(broken, arabicLetterMarkMiddle);
  assert.notEqual(broken, mongolianVowelSeparatorMiddle);
  assert.notEqual(broken, applicationProgramCommandMiddle);
  assert.equal(broken.trim(), broken);
  assert.notEqual(broken.trim(), legal);
  assert.notEqual(broken.trim(), "");
  assert.equal((leftToRightMark + legal).trim(), leftToRightMark + legal);
  assert.notEqual((leftToRightMark + legal).trim(), legal);
  assert.equal((legal + leftToRightMark).trim(), legal + leftToRightMark);
  assert.notEqual((legal + leftToRightMark).trim(), legal);
  assert.equal((arabicLetterMark + legal).trim(), arabicLetterMark + legal);
  assert.notEqual((arabicLetterMark + legal).trim(), legal);
  assert.equal((legal + arabicLetterMark).trim(), legal + arabicLetterMark);
  assert.notEqual((legal + arabicLetterMark).trim(), legal);
  assert.equal((mongolianVowelSeparator + legal).trim(), mongolianVowelSeparator + legal);
  assert.notEqual((mongolianVowelSeparator + legal).trim(), legal);
  assert.equal((legal + mongolianVowelSeparator).trim(), legal + mongolianVowelSeparator);
  assert.notEqual((legal + mongolianVowelSeparator).trim(), legal);
  assert.equal((applicationProgramCommand + legal).trim(), applicationProgramCommand + legal);
  assert.notEqual((applicationProgramCommand + legal).trim(), legal);
  assert.equal((legal + applicationProgramCommand).trim(), legal + applicationProgramCommand);
  assert.notEqual((legal + applicationProgramCommand).trim(), legal);
  assert.equal(arabicLetterMarkMiddle.trim(), arabicLetterMarkMiddle);
  assert.notEqual(arabicLetterMarkMiddle.trim(), legal);
  assert.equal(mongolianVowelSeparatorMiddle.trim(), mongolianVowelSeparatorMiddle);
  assert.notEqual(mongolianVowelSeparatorMiddle.trim(), legal);
  assert.equal(applicationProgramCommandMiddle.trim(), applicationProgramCommandMiddle);
  assert.notEqual(applicationProgramCommandMiddle.trim(), legal);
  assert.equal(/\s/.test(broken), false);
  assert.equal(/\s/.test(arabicLetterMarkMiddle), false);
  assert.equal(/\s/.test(mongolianVowelSeparatorMiddle), false);
  assert.equal(/\s/.test(applicationProgramCommandMiddle), false);
  assert.equal(/\p{Cf}/u.test(broken), true);
  assert.equal(/\p{Cc}/u.test(broken), false);
  assert.equal(/\p{Zl}/u.test(broken), false);
  assert.equal(/\p{Bidi_Control}/u.test(broken), true);
  assert.equal(/\p{White_Space}/u.test(broken), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(broken), true);
  assert.equal(/\p{Cf}/u.test(arabicLetterMarkMiddle), true);
  assert.equal(/\p{Bidi_Control}/u.test(arabicLetterMarkMiddle), true);
  assert.equal(/\p{White_Space}/u.test(arabicLetterMarkMiddle), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(arabicLetterMarkMiddle), false);
  assert.equal(/\p{Cf}/u.test(mongolianVowelSeparatorMiddle), true);
  assert.equal(/\p{Bidi_Control}/u.test(mongolianVowelSeparatorMiddle), false);
  assert.equal(/\p{White_Space}/u.test(mongolianVowelSeparatorMiddle), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(mongolianVowelSeparatorMiddle), false);
  assert.equal(/\p{Cc}/u.test(applicationProgramCommandMiddle), true);
  assert.equal(/\p{Cf}/u.test(applicationProgramCommandMiddle), false);
  assert.equal(/\p{Bidi_Control}/u.test(applicationProgramCommandMiddle), false);
  assert.equal(/\p{White_Space}/u.test(applicationProgramCommandMiddle), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(applicationProgramCommandMiddle), false);
  assert.equal(broken.includes(arabicLetterMark), false);
  assert.equal(broken.includes(mongolianVowelSeparator), false);
  assert.equal(broken.includes(applicationProgramCommand), false);
  assert.equal(arabicLetterMarkMiddle.charCodeAt(at), 0x061C);
  assert.equal(arabicLetterMarkMiddle.includes(leftToRightMark), false);
  assert.equal(arabicLetterMarkMiddle.includes(mongolianVowelSeparator), false);
  assert.equal(arabicLetterMarkMiddle.includes(applicationProgramCommand), false);
  assert.equal(mongolianVowelSeparatorMiddle.charCodeAt(at), 0x180E);
  assert.equal(mongolianVowelSeparatorMiddle.includes(leftToRightMark), false);
  assert.equal(mongolianVowelSeparatorMiddle.includes(arabicLetterMark), false);
  assert.equal(mongolianVowelSeparatorMiddle.includes(applicationProgramCommand), false);
  assert.equal(applicationProgramCommandMiddle.charCodeAt(at), 0x009F);
  assert.equal(applicationProgramCommandMiddle.includes(leftToRightMark), false);
  assert.equal(applicationProgramCommandMiddle.includes(arabicLetterMark), false);
  assert.equal(applicationProgramCommandMiddle.includes(mongolianVowelSeparator), false);
  assert.equal(uuid.test(broken), false);
  const optionIds = questions.flatMap(question => question.options.map(option => option.id));
  assert.equal(optionIds.includes(legal), true);
  assert.equal(optionIds.includes(broken), false);
  assert.equal(optionIds.includes(arabicLetterMarkMiddle), false);
  assert.equal(optionIds.includes(mongolianVowelSeparatorMiddle), false);
  assert.equal(optionIds.includes(applicationProgramCommandMiddle), false);
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
  assert.equal(payload.choices[0].charCodeAt(at), 0x200E);
  assert.equal(roundTrip.choices[0], broken);
  assert.equal(roundTrip.choices[0].charCodeAt(at), 0x200E);
  assert.notEqual(roundTrip.choices[0].charCodeAt(at), 0x061C);
  assert.notEqual(roundTrip.choices[0].charCodeAt(at), 0x180E);
  assert.notEqual(roundTrip.choices[0].charCodeAt(at), 0x009F);
  assert.equal(payload.choices[0] === legal, false);
  assert.equal(payload.choices[0] === arabicLetterMarkMiddle, false);
  assert.equal(payload.choices[0] === mongolianVowelSeparatorMiddle, false);
  assert.equal(payload.choices[0] === applicationProgramCommandMiddle, false);
  assert.equal(raw.includes(leftToRightMark), true);
  assert.equal(raw.includes("\\u200E"), false);
  assert.equal(raw.includes("\\u200e"), false);
  assert.equal(raw.includes(arabicLetterMark), false);
  assert.equal(raw.includes("\\u061C"), false);
  assert.equal(raw.includes("\\u061c"), false);
  assert.equal(raw.includes(mongolianVowelSeparator), false);
  assert.equal(raw.includes("\\u180E"), false);
  assert.equal(raw.includes("\\u180e"), false);
  assert.equal(raw.includes(applicationProgramCommand), false);
  assert.equal(raw.includes("\\u009F"), false);
  assert.equal(raw.includes(legal), false);
  assert.equal(JSON.stringify(broken).includes(leftToRightMark), true);
  assert.equal(JSON.stringify(broken).includes("\\"), false);
  assert.equal(JSON.stringify(broken).includes("\\u200E"), false);
  assert.equal(JSON.stringify(broken).includes("\\u200e"), false);
  assert.equal(JSON.stringify(broken).includes("\\u061C"), false);
  assert.equal(JSON.stringify(broken).includes("\\u180E"), false);
  assert.equal(JSON.stringify(broken).includes("\\u009F"), false);
  assert.equal(JSON.stringify(arabicLetterMarkMiddle).includes(arabicLetterMark), true);
  assert.equal(JSON.stringify(arabicLetterMarkMiddle).includes("\\"), false);
  assert.equal(JSON.stringify(arabicLetterMarkMiddle).includes("\\u061C"), false);
  assert.equal(JSON.stringify(arabicLetterMarkMiddle).includes("\\u061c"), false);
  assert.equal(JSON.stringify(arabicLetterMarkMiddle).includes("\\u200E"), false);
  assert.equal(JSON.stringify(arabicLetterMarkMiddle).includes(leftToRightMark), false);
  assert.equal(JSON.stringify(mongolianVowelSeparatorMiddle).includes(mongolianVowelSeparator), true);
  assert.equal(JSON.stringify(mongolianVowelSeparatorMiddle).includes("\\"), false);
  assert.equal(JSON.stringify(mongolianVowelSeparatorMiddle).includes("\\u180E"), false);
  assert.equal(JSON.stringify(mongolianVowelSeparatorMiddle).includes("\\u180e"), false);
  assert.equal(JSON.stringify(mongolianVowelSeparatorMiddle).includes("\\u200E"), false);
  assert.equal(JSON.stringify(mongolianVowelSeparatorMiddle).includes(leftToRightMark), false);
  assert.equal(JSON.stringify(applicationProgramCommandMiddle).includes(applicationProgramCommand), true);
  assert.equal(JSON.stringify(applicationProgramCommandMiddle).includes("\\"), false);
  assert.equal(JSON.stringify(applicationProgramCommandMiddle).includes("\\u009F"), false);
  assert.equal(JSON.stringify(applicationProgramCommandMiddle).includes("\\u200E"), false);
  assert.equal(JSON.stringify(applicationProgramCommandMiddle).includes(leftToRightMark), false);
  assert.notEqual(JSON.stringify(broken), JSON.stringify(arabicLetterMarkMiddle));
  assert.notEqual(JSON.stringify(broken), JSON.stringify(mongolianVowelSeparatorMiddle));
  assert.notEqual(JSON.stringify(broken), JSON.stringify(applicationProgramCommandMiddle));
  f.resetWrites();
  const refused = await read(await f.req("/api/answers", "PUT", payload, { cookie }));
  assert.equal(refused.status, 422, JSON.stringify(refused.body));
  assert.equal(refused.body.error, "Choose an available answer.");
  assert.equal(refused.headers.get("Set-Cookie"), null);
  assert.equal(refused.text.includes(secret), false);
  assert.equal(refused.text.includes(sessionSecret), false);
  assert.equal(refused.text.includes(broken), false);
  assert.equal(refused.text.includes(leftToRightMark), false);
  assert.equal(refused.text.includes("\\u200E"), false);
  assert.equal(refused.text.includes("\\u200e"), false);
  assert.equal(refused.text.includes(arabicLetterMark), false);
  assert.equal(refused.text.includes("\\u061C"), false);
  assert.equal(refused.text.includes("\\u061c"), false);
  assert.equal(refused.text.includes(mongolianVowelSeparator), false);
  assert.equal(refused.text.includes("\\u180E"), false);
  assert.equal(refused.text.includes("\\u180e"), false);
  assert.equal(refused.text.includes(applicationProgramCommand), false);
  assert.equal(refused.text.includes("\\u009F"), false);
  assert.equal(refused.text.includes(legal), false);
  assert.deepEqual(f.written, []);

  const after = stored(f, reference);
  assert.deepEqual(after, snapshot);
  assert.deepEqual(after.answers, {});
  assert.equal(Object.hasOwn(after.answers, target.id), false);
  assert.equal(JSON.stringify(after.answers).includes(leftToRightMark), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u200E"), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u200e"), false);
  assert.equal(JSON.stringify(after.answers).includes(arabicLetterMark), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u061C"), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u061c"), false);
  assert.equal(JSON.stringify(after.answers).includes(mongolianVowelSeparator), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u180E"), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u180e"), false);
  assert.equal(JSON.stringify(after.answers).includes(applicationProgramCommand), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u009F"), false);
  assert.equal(JSON.stringify(after.answers).includes(legal), false);
  assert.equal(JSON.stringify(after).includes(leftToRightMark), false);
  assert.equal(JSON.stringify(after).includes("\\u200E"), false);
  assert.equal(JSON.stringify(after).includes("\\u200e"), false);
  assert.equal(JSON.stringify(after).includes(arabicLetterMark), false);
  assert.equal(JSON.stringify(after).includes("\\u061C"), false);
  assert.equal(JSON.stringify(after).includes("\\u061c"), false);
  assert.equal(JSON.stringify(after).includes(mongolianVowelSeparator), false);
  assert.equal(JSON.stringify(after).includes("\\u180E"), false);
  assert.equal(JSON.stringify(after).includes("\\u180e"), false);
  assert.equal(JSON.stringify(after).includes(applicationProgramCommand), false);
  assert.equal(JSON.stringify(after).includes("\\u009F"), false);
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
  assert.equal(viewed.text.includes(leftToRightMark), false);
  assert.equal(viewed.text.includes("\\u200E"), false);
  assert.equal(viewed.text.includes("\\u200e"), false);
  assert.equal(viewed.text.includes(arabicLetterMark), false);
  assert.equal(viewed.text.includes("\\u061C"), false);
  assert.equal(viewed.text.includes("\\u061c"), false);
  assert.equal(viewed.text.includes(mongolianVowelSeparator), false);
  assert.equal(viewed.text.includes("\\u180E"), false);
  assert.equal(viewed.text.includes("\\u180e"), false);
  assert.equal(viewed.text.includes(applicationProgramCommand), false);
  assert.equal(viewed.text.includes("\\u009F"), false);
  assert.equal(f.records.get(reference).etag, openedEtag);
  assert.equal(stored(f, reference).inviteHash, inviteHash);
  assert.equal(stored(f, reference).sessionHash, sessionHash);
  assert.deepEqual(stored(f, reference).answers, {});
});
