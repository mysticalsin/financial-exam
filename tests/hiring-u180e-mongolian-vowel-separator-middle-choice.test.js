import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import worker, { Assessment } from "../src/worker.js";

// One live hiring sitting. Save an answer for a real item on this paper
// whose choice id is that item's legal choice string with a Mongolian
// vowel separator (U+180E) inserted in the middle. The save is refused.
// No answer is stored. The invite hash and the session secret stay unchanged.
// A word joiner (U+2060) in the middle, a line separator (U+2028) in the
// middle, and an application-program-command character (U+009F) in the
// middle are separate checks.

const origin = "https://assessment.example";
const notice = {
  controller: "Test controller", contact: "privacy@example.invalid", basis: "Test basis",
  recipients: "Test reviewer", transfers: "Test transfer description", rights: "Test rights",
  purpose: "Test purpose", supervisoryAuthority: "Test authority", version: "test-1", retentionMinutes: 30,
};
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const random = () => crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
const mongolianVowelSeparator = "\u180E";
const wordJoiner = "\u2060";
const lineSeparator = "\u2028";
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

test("a legal choice with a Mongolian vowel separator (U+180E) inserted in the middle is refused and stores nothing", async () => {
  const source = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(source, /"LIVE_ENABLED": "false"/);
  assert.equal(mongolianVowelSeparator, "\u180E");
  assert.equal(mongolianVowelSeparator.charCodeAt(0), 0x180E);
  assert.equal(mongolianVowelSeparator.codePointAt(0), 0x180E);
  assert.equal(mongolianVowelSeparator.length, 1);
  assert.notEqual(mongolianVowelSeparator, wordJoiner);
  assert.notEqual(mongolianVowelSeparator.charCodeAt(0), 0x2060);
  assert.notEqual(mongolianVowelSeparator, lineSeparator);
  assert.notEqual(mongolianVowelSeparator.charCodeAt(0), 0x2028);
  assert.notEqual(mongolianVowelSeparator, applicationProgramCommand);
  assert.notEqual(mongolianVowelSeparator.charCodeAt(0), 0x009F);
  assert.equal(wordJoiner, "\u2060");
  assert.equal(wordJoiner.charCodeAt(0), 0x2060);
  assert.equal(wordJoiner.codePointAt(0), 0x2060);
  assert.equal(wordJoiner.length, 1);
  assert.equal(lineSeparator, "\u2028");
  assert.equal(lineSeparator.charCodeAt(0), 0x2028);
  assert.equal(lineSeparator.codePointAt(0), 0x2028);
  assert.equal(lineSeparator.length, 1);
  assert.equal(applicationProgramCommand, "\u009F");
  assert.equal(applicationProgramCommand.charCodeAt(0), 0x009F);
  assert.equal(applicationProgramCommand.codePointAt(0), 0x009F);
  assert.equal(applicationProgramCommand.length, 1);
  assert.equal(/\s/.test(mongolianVowelSeparator), false);
  assert.equal(/\s/.test(wordJoiner), false);
  assert.equal(/\s/.test(lineSeparator), true);
  assert.equal(/\s/.test(applicationProgramCommand), false);
  assert.equal(/\p{Cf}/u.test(mongolianVowelSeparator), true);
  assert.equal(/\p{Cc}/u.test(mongolianVowelSeparator), false);
  assert.equal(/\p{Zl}/u.test(mongolianVowelSeparator), false);
  assert.equal(/\p{Zp}/u.test(mongolianVowelSeparator), false);
  assert.equal(/\p{Zs}/u.test(mongolianVowelSeparator), false);
  assert.equal(/\p{White_Space}/u.test(mongolianVowelSeparator), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(mongolianVowelSeparator), false);
  assert.equal(/\p{Cf}/u.test(wordJoiner), true);
  assert.equal(/\p{Cc}/u.test(wordJoiner), false);
  assert.equal(/\p{Zl}/u.test(wordJoiner), false);
  assert.equal(/\p{White_Space}/u.test(wordJoiner), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(wordJoiner), false);
  assert.equal(/\p{Cf}/u.test(lineSeparator), false);
  assert.equal(/\p{Cc}/u.test(lineSeparator), false);
  assert.equal(/\p{Zl}/u.test(lineSeparator), true);
  assert.equal(/\p{White_Space}/u.test(lineSeparator), true);
  assert.equal(/\p{Pattern_White_Space}/u.test(lineSeparator), true);
  assert.equal(/\p{Cc}/u.test(applicationProgramCommand), true);
  assert.equal(/\p{Cf}/u.test(applicationProgramCommand), false);
  assert.equal(/\p{Zl}/u.test(applicationProgramCommand), false);
  assert.equal(/\p{White_Space}/u.test(applicationProgramCommand), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(applicationProgramCommand), false);
  assert.equal(mongolianVowelSeparator.trim(), mongolianVowelSeparator);
  assert.notEqual(mongolianVowelSeparator.trim(), "");
  assert.equal(wordJoiner.trim(), wordJoiner);
  assert.notEqual(wordJoiner.trim(), "");
  assert.equal(lineSeparator.trim(), "");
  assert.notEqual(lineSeparator.trim(), lineSeparator);
  assert.equal(applicationProgramCommand.trim(), applicationProgramCommand);
  assert.notEqual(applicationProgramCommand.trim(), "");
  assert.equal(JSON.stringify(mongolianVowelSeparator), '"' + mongolianVowelSeparator + '"');
  assert.equal(JSON.stringify(mongolianVowelSeparator).includes(mongolianVowelSeparator), true);
  assert.equal(JSON.stringify(mongolianVowelSeparator).includes("\\"), false);
  assert.equal(JSON.stringify(mongolianVowelSeparator).includes("\\u180E"), false);
  assert.equal(JSON.stringify(mongolianVowelSeparator).includes("\\u180e"), false);
  assert.notEqual(JSON.stringify(mongolianVowelSeparator), '"\\u180E"');
  assert.equal(JSON.stringify(wordJoiner), '"' + wordJoiner + '"');
  assert.equal(JSON.stringify(wordJoiner).includes(wordJoiner), true);
  assert.equal(JSON.stringify(wordJoiner).includes("\\"), false);
  assert.equal(JSON.stringify(wordJoiner).includes("\\u2060"), false);
  assert.notEqual(JSON.stringify(wordJoiner), '"\\u2060"');
  assert.notEqual(JSON.stringify(wordJoiner), '"\\u180E"');
  assert.equal(JSON.stringify(lineSeparator), '"' + lineSeparator + '"');
  assert.equal(JSON.stringify(lineSeparator).includes(lineSeparator), true);
  assert.equal(JSON.stringify(lineSeparator).includes("\\"), false);
  assert.equal(JSON.stringify(lineSeparator).includes("\\u2028"), false);
  assert.notEqual(JSON.stringify(lineSeparator), '"\\u2028"');
  assert.notEqual(JSON.stringify(lineSeparator), '"\\u180E"');
  assert.equal(JSON.stringify(applicationProgramCommand), '"' + applicationProgramCommand + '"');
  assert.equal(JSON.stringify(applicationProgramCommand).includes(applicationProgramCommand), true);
  assert.equal(JSON.stringify(applicationProgramCommand).includes("\\"), false);
  assert.equal(JSON.stringify(applicationProgramCommand).includes("\\u009F"), false);
  assert.notEqual(JSON.stringify(applicationProgramCommand), '"\\u009F"');
  assert.notEqual(JSON.stringify(applicationProgramCommand), '"\\u180E"');
  assert.notEqual(JSON.stringify(mongolianVowelSeparator), JSON.stringify(wordJoiner));
  assert.notEqual(JSON.stringify(mongolianVowelSeparator), JSON.stringify(lineSeparator));
  assert.notEqual(JSON.stringify(mongolianVowelSeparator), JSON.stringify(applicationProgramCommand));

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
  assert.ok(target, "a real item has a legal choice that can take an interior Mongolian vowel separator (U+180E)");
  const legal = target.options.find(option => uuid.test(option.id)).id;
  assert.equal(questions.some(question => question.id === target.id), true);
  assert.equal(target.options.some(option => option.id === legal), true);
  assert.equal(uuid.test(legal), true);
  assert.equal(uuid.test(target.id), true);
  assert.equal(legal.length, 36);
  assert.equal(legal.includes(mongolianVowelSeparator), false);
  assert.equal(legal.includes(wordJoiner), false);
  assert.equal(legal.includes(lineSeparator), false);
  assert.equal(legal.includes(applicationProgramCommand), false);
  assert.equal(legal.trim(), legal);

  const inserted = insertedInMiddle(legal, mongolianVowelSeparator);
  const broken = inserted.value;
  const at = inserted.at;
  const wordJoinerMiddle = insertedInMiddle(legal, wordJoiner).value;
  const lineSeparatorMiddle = insertedInMiddle(legal, lineSeparator).value;
  const applicationProgramCommandMiddle = insertedInMiddle(legal, applicationProgramCommand).value;
  assert.ok(at > 0 && at < legal.length);
  assert.equal(at, 18);
  assert.equal(legal.charCodeAt(at), 0x002D);
  assert.equal(broken.charCodeAt(at), 0x180E);
  assert.equal(broken.charCodeAt(at + 1), 0x002D);
  assert.notEqual(broken.charCodeAt(at), 0x2060);
  assert.notEqual(broken.charCodeAt(at), 0x2028);
  assert.notEqual(broken.charCodeAt(at), 0x009F);
  assert.equal(broken.slice(0, at), legal.slice(0, at));
  assert.equal(broken.slice(at + 1), legal.slice(at));
  assert.equal(broken.length, legal.length + 1);
  assert.notEqual(broken, legal);
  assert.equal(broken.replace(mongolianVowelSeparator, ""), legal);
  assert.equal([...broken].filter(char => char === mongolianVowelSeparator).length, 1);
  assert.equal(broken.indexOf(mongolianVowelSeparator), at);
  assert.equal(broken.startsWith(mongolianVowelSeparator), false);
  assert.equal(broken.endsWith(mongolianVowelSeparator), false);
  assert.notEqual(broken, mongolianVowelSeparator + legal);
  assert.notEqual(broken, legal + mongolianVowelSeparator);
  assert.notEqual(broken, wordJoinerMiddle);
  assert.notEqual(broken, lineSeparatorMiddle);
  assert.notEqual(broken, applicationProgramCommandMiddle);
  assert.equal(broken.trim(), broken);
  assert.notEqual(broken.trim(), legal);
  assert.notEqual(broken.trim(), "");
  assert.equal((mongolianVowelSeparator + legal).trim(), mongolianVowelSeparator + legal);
  assert.notEqual((mongolianVowelSeparator + legal).trim(), legal);
  assert.equal((legal + mongolianVowelSeparator).trim(), legal + mongolianVowelSeparator);
  assert.notEqual((legal + mongolianVowelSeparator).trim(), legal);
  assert.equal((wordJoiner + legal).trim(), wordJoiner + legal);
  assert.notEqual((wordJoiner + legal).trim(), legal);
  assert.equal((legal + wordJoiner).trim(), legal + wordJoiner);
  assert.notEqual((legal + wordJoiner).trim(), legal);
  assert.equal((lineSeparator + legal).trim(), legal);
  assert.notEqual((lineSeparator + legal).trim(), lineSeparator + legal);
  assert.equal((legal + lineSeparator).trim(), legal);
  assert.notEqual((legal + lineSeparator).trim(), legal + lineSeparator);
  assert.equal((applicationProgramCommand + legal).trim(), applicationProgramCommand + legal);
  assert.notEqual((applicationProgramCommand + legal).trim(), legal);
  assert.equal((legal + applicationProgramCommand).trim(), legal + applicationProgramCommand);
  assert.notEqual((legal + applicationProgramCommand).trim(), legal);
  assert.equal(wordJoinerMiddle.trim(), wordJoinerMiddle);
  assert.notEqual(wordJoinerMiddle.trim(), legal);
  assert.equal(lineSeparatorMiddle.trim(), lineSeparatorMiddle);
  assert.notEqual(lineSeparatorMiddle.trim(), legal);
  assert.notEqual(lineSeparatorMiddle.trim(), "");
  assert.equal(applicationProgramCommandMiddle.trim(), applicationProgramCommandMiddle);
  assert.notEqual(applicationProgramCommandMiddle.trim(), legal);
  assert.equal(/\s/.test(broken), false);
  assert.equal(/\s/.test(wordJoinerMiddle), false);
  assert.equal(/\s/.test(lineSeparatorMiddle), true);
  assert.equal(/\s/.test(applicationProgramCommandMiddle), false);
  assert.equal(/\p{Cf}/u.test(broken), true);
  assert.equal(/\p{Cc}/u.test(broken), false);
  assert.equal(/\p{Zl}/u.test(broken), false);
  assert.equal(/\p{White_Space}/u.test(broken), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(broken), false);
  assert.equal(/\p{Cf}/u.test(wordJoinerMiddle), true);
  assert.equal(/\p{White_Space}/u.test(wordJoinerMiddle), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(wordJoinerMiddle), false);
  assert.equal(/\p{Zl}/u.test(lineSeparatorMiddle), true);
  assert.equal(/\p{Cf}/u.test(lineSeparatorMiddle), false);
  assert.equal(/\p{White_Space}/u.test(lineSeparatorMiddle), true);
  assert.equal(/\p{Pattern_White_Space}/u.test(lineSeparatorMiddle), true);
  assert.equal(/\p{Cc}/u.test(applicationProgramCommandMiddle), true);
  assert.equal(/\p{Cf}/u.test(applicationProgramCommandMiddle), false);
  assert.equal(/\p{White_Space}/u.test(applicationProgramCommandMiddle), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(applicationProgramCommandMiddle), false);
  assert.equal(broken.includes(wordJoiner), false);
  assert.equal(broken.includes(lineSeparator), false);
  assert.equal(broken.includes(applicationProgramCommand), false);
  assert.equal(wordJoinerMiddle.charCodeAt(at), 0x2060);
  assert.equal(wordJoinerMiddle.includes(mongolianVowelSeparator), false);
  assert.equal(wordJoinerMiddle.includes(lineSeparator), false);
  assert.equal(wordJoinerMiddle.includes(applicationProgramCommand), false);
  assert.equal(lineSeparatorMiddle.charCodeAt(at), 0x2028);
  assert.equal(lineSeparatorMiddle.includes(mongolianVowelSeparator), false);
  assert.equal(lineSeparatorMiddle.includes(wordJoiner), false);
  assert.equal(lineSeparatorMiddle.includes(applicationProgramCommand), false);
  assert.equal(applicationProgramCommandMiddle.charCodeAt(at), 0x009F);
  assert.equal(applicationProgramCommandMiddle.includes(mongolianVowelSeparator), false);
  assert.equal(applicationProgramCommandMiddle.includes(wordJoiner), false);
  assert.equal(applicationProgramCommandMiddle.includes(lineSeparator), false);
  assert.equal(uuid.test(broken), false);
  const optionIds = questions.flatMap(question => question.options.map(option => option.id));
  assert.equal(optionIds.includes(legal), true);
  assert.equal(optionIds.includes(broken), false);
  assert.equal(optionIds.includes(wordJoinerMiddle), false);
  assert.equal(optionIds.includes(lineSeparatorMiddle), false);
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
  assert.equal(payload.choices[0].charCodeAt(at), 0x180E);
  assert.equal(roundTrip.choices[0], broken);
  assert.equal(roundTrip.choices[0].charCodeAt(at), 0x180E);
  assert.notEqual(roundTrip.choices[0].charCodeAt(at), 0x2060);
  assert.notEqual(roundTrip.choices[0].charCodeAt(at), 0x2028);
  assert.notEqual(roundTrip.choices[0].charCodeAt(at), 0x009F);
  assert.equal(payload.choices[0] === legal, false);
  assert.equal(payload.choices[0] === wordJoinerMiddle, false);
  assert.equal(payload.choices[0] === lineSeparatorMiddle, false);
  assert.equal(payload.choices[0] === applicationProgramCommandMiddle, false);
  assert.equal(raw.includes(mongolianVowelSeparator), true);
  assert.equal(raw.includes("\\u180E"), false);
  assert.equal(raw.includes("\\u180e"), false);
  assert.equal(raw.includes(wordJoiner), false);
  assert.equal(raw.includes("\\u2060"), false);
  assert.equal(raw.includes(lineSeparator), false);
  assert.equal(raw.includes("\\u2028"), false);
  assert.equal(raw.includes(applicationProgramCommand), false);
  assert.equal(raw.includes("\\u009F"), false);
  assert.equal(raw.includes(legal), false);
  assert.equal(JSON.stringify(broken).includes(mongolianVowelSeparator), true);
  assert.equal(JSON.stringify(broken).includes("\\"), false);
  assert.equal(JSON.stringify(broken).includes("\\u180E"), false);
  assert.equal(JSON.stringify(broken).includes("\\u180e"), false);
  assert.equal(JSON.stringify(broken).includes("\\u2060"), false);
  assert.equal(JSON.stringify(broken).includes("\\u2028"), false);
  assert.equal(JSON.stringify(broken).includes("\\u009F"), false);
  assert.equal(JSON.stringify(wordJoinerMiddle).includes(wordJoiner), true);
  assert.equal(JSON.stringify(wordJoinerMiddle).includes("\\"), false);
  assert.equal(JSON.stringify(wordJoinerMiddle).includes("\\u2060"), false);
  assert.equal(JSON.stringify(wordJoinerMiddle).includes("\\u180E"), false);
  assert.equal(JSON.stringify(wordJoinerMiddle).includes(mongolianVowelSeparator), false);
  assert.equal(JSON.stringify(lineSeparatorMiddle).includes(lineSeparator), true);
  assert.equal(JSON.stringify(lineSeparatorMiddle).includes("\\"), false);
  assert.equal(JSON.stringify(lineSeparatorMiddle).includes("\\u2028"), false);
  assert.equal(JSON.stringify(lineSeparatorMiddle).includes("\\u180E"), false);
  assert.equal(JSON.stringify(lineSeparatorMiddle).includes(mongolianVowelSeparator), false);
  assert.equal(JSON.stringify(applicationProgramCommandMiddle).includes(applicationProgramCommand), true);
  assert.equal(JSON.stringify(applicationProgramCommandMiddle).includes("\\"), false);
  assert.equal(JSON.stringify(applicationProgramCommandMiddle).includes("\\u009F"), false);
  assert.equal(JSON.stringify(applicationProgramCommandMiddle).includes("\\u180E"), false);
  assert.equal(JSON.stringify(applicationProgramCommandMiddle).includes(mongolianVowelSeparator), false);
  assert.notEqual(JSON.stringify(broken), JSON.stringify(wordJoinerMiddle));
  assert.notEqual(JSON.stringify(broken), JSON.stringify(lineSeparatorMiddle));
  assert.notEqual(JSON.stringify(broken), JSON.stringify(applicationProgramCommandMiddle));
  f.resetWrites();
  const refused = await read(await f.req("/api/answers", "PUT", payload, { cookie }));
  assert.equal(refused.status, 422, JSON.stringify(refused.body));
  assert.equal(refused.body.error, "Choose an available answer.");
  assert.equal(refused.headers.get("Set-Cookie"), null);
  assert.equal(refused.text.includes(secret), false);
  assert.equal(refused.text.includes(sessionSecret), false);
  assert.equal(refused.text.includes(broken), false);
  assert.equal(refused.text.includes(mongolianVowelSeparator), false);
  assert.equal(refused.text.includes("\\u180E"), false);
  assert.equal(refused.text.includes("\\u180e"), false);
  assert.equal(refused.text.includes(wordJoiner), false);
  assert.equal(refused.text.includes("\\u2060"), false);
  assert.equal(refused.text.includes(lineSeparator), false);
  assert.equal(refused.text.includes("\\u2028"), false);
  assert.equal(refused.text.includes(applicationProgramCommand), false);
  assert.equal(refused.text.includes("\\u009F"), false);
  assert.equal(refused.text.includes(legal), false);
  assert.deepEqual(f.written, []);

  const after = stored(f, reference);
  assert.deepEqual(after, snapshot);
  assert.deepEqual(after.answers, {});
  assert.equal(Object.hasOwn(after.answers, target.id), false);
  assert.equal(JSON.stringify(after.answers).includes(mongolianVowelSeparator), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u180E"), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u180e"), false);
  assert.equal(JSON.stringify(after.answers).includes(wordJoiner), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u2060"), false);
  assert.equal(JSON.stringify(after.answers).includes(lineSeparator), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u2028"), false);
  assert.equal(JSON.stringify(after.answers).includes(applicationProgramCommand), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u009F"), false);
  assert.equal(JSON.stringify(after.answers).includes(legal), false);
  assert.equal(JSON.stringify(after).includes(mongolianVowelSeparator), false);
  assert.equal(JSON.stringify(after).includes("\\u180E"), false);
  assert.equal(JSON.stringify(after).includes("\\u180e"), false);
  assert.equal(JSON.stringify(after).includes(wordJoiner), false);
  assert.equal(JSON.stringify(after).includes("\\u2060"), false);
  assert.equal(JSON.stringify(after).includes(lineSeparator), false);
  assert.equal(JSON.stringify(after).includes("\\u2028"), false);
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
  assert.equal(viewed.text.includes(mongolianVowelSeparator), false);
  assert.equal(viewed.text.includes("\\u180E"), false);
  assert.equal(viewed.text.includes("\\u180e"), false);
  assert.equal(viewed.text.includes(wordJoiner), false);
  assert.equal(viewed.text.includes("\\u2060"), false);
  assert.equal(viewed.text.includes(lineSeparator), false);
  assert.equal(viewed.text.includes("\\u2028"), false);
  assert.equal(viewed.text.includes(applicationProgramCommand), false);
  assert.equal(viewed.text.includes("\\u009F"), false);
  assert.equal(f.records.get(reference).etag, openedEtag);
  assert.equal(stored(f, reference).inviteHash, inviteHash);
  assert.equal(stored(f, reference).sessionHash, sessionHash);
  assert.deepEqual(stored(f, reference).answers, {});
});
