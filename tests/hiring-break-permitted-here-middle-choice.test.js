import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import worker, { Assessment } from "../src/worker.js";

// One live hiring sitting. Save an answer for a real item on this paper
// whose choice id is that item's legal choice string with a break-permitted-here
// character (U+0082) inserted in the middle. The save is refused.
// No answer is stored. The invite hash and the session secret stay unchanged.
// A high-octet preset character in the middle, a padding character in the
// middle, and a start-of-heading character in the middle are separate checks.

const origin = "https://assessment.example";
const notice = {
  controller: "Test controller", contact: "privacy@example.invalid", basis: "Test basis",
  recipients: "Test reviewer", transfers: "Test transfer description", rights: "Test rights",
  purpose: "Test purpose", supervisoryAuthority: "Test authority", version: "test-1", retentionMinutes: 30,
};
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const random = () => crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
const breakPermittedHere = "\u0082";
const highOctetPreset = "\u0081";
const paddingCharacter = "\u0080";
const startOfHeading = "\u0001";

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

test("a legal choice with a break-permitted-here character inserted in the middle is refused and stores nothing", async () => {
  const source = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(source, /"LIVE_ENABLED": "false"/);
  assert.equal(breakPermittedHere, "\u0082");
  assert.equal(breakPermittedHere.charCodeAt(0), 0x0082);
  assert.equal(breakPermittedHere.codePointAt(0), 0x0082);
  assert.equal(breakPermittedHere.length, 1);
  assert.notEqual(breakPermittedHere, paddingCharacter);
  assert.notEqual(breakPermittedHere.charCodeAt(0), 0x0080);
  assert.notEqual(breakPermittedHere, startOfHeading);
  assert.notEqual(breakPermittedHere.charCodeAt(0), 0x0001);
  assert.notEqual(breakPermittedHere, highOctetPreset);
  assert.notEqual(breakPermittedHere.charCodeAt(0), 0x0081);
  assert.equal(paddingCharacter, "\u0080");
  assert.equal(paddingCharacter.charCodeAt(0), 0x0080);
  assert.equal(paddingCharacter.codePointAt(0), 0x0080);
  assert.equal(paddingCharacter.length, 1);
  assert.equal(startOfHeading, "\u0001");
  assert.equal(startOfHeading.charCodeAt(0), 0x0001);
  assert.equal(startOfHeading.codePointAt(0), 0x0001);
  assert.equal(startOfHeading.length, 1);
  assert.equal(highOctetPreset, "\u0081");
  assert.equal(highOctetPreset.charCodeAt(0), 0x0081);
  assert.equal(highOctetPreset.codePointAt(0), 0x0081);
  assert.equal(highOctetPreset.length, 1);
  assert.equal(/\s/.test(breakPermittedHere), false);
  assert.equal(/\s/.test(paddingCharacter), false);
  assert.equal(/\s/.test(startOfHeading), false);
  assert.equal(/\s/.test(highOctetPreset), false);
  assert.equal(/\p{Cc}/u.test(breakPermittedHere), true);
  assert.equal(/\p{Cf}/u.test(breakPermittedHere), false);
  assert.equal(/\p{Zl}/u.test(breakPermittedHere), false);
  assert.equal(/\p{Zp}/u.test(breakPermittedHere), false);
  assert.equal(/\p{Zs}/u.test(breakPermittedHere), false);
  assert.equal(/\p{White_Space}/u.test(breakPermittedHere), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(breakPermittedHere), false);
  assert.equal(/\p{Cc}/u.test(paddingCharacter), true);
  assert.equal(/\p{Cf}/u.test(paddingCharacter), false);
  assert.equal(/\p{White_Space}/u.test(paddingCharacter), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(paddingCharacter), false);
  assert.equal(/\p{Cc}/u.test(startOfHeading), true);
  assert.equal(/\p{Cf}/u.test(startOfHeading), false);
  assert.equal(/\p{White_Space}/u.test(startOfHeading), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(startOfHeading), false);
  assert.equal(/\p{Cc}/u.test(highOctetPreset), true);
  assert.equal(/\p{Cf}/u.test(highOctetPreset), false);
  assert.equal(/\p{Zl}/u.test(highOctetPreset), false);
  assert.equal(/\p{Zp}/u.test(highOctetPreset), false);
  assert.equal(/\p{Zs}/u.test(highOctetPreset), false);
  assert.equal(/\p{White_Space}/u.test(highOctetPreset), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(highOctetPreset), false);
  assert.equal(breakPermittedHere.trim(), breakPermittedHere);
  assert.notEqual(breakPermittedHere.trim(), "");
  assert.equal(paddingCharacter.trim(), paddingCharacter);
  assert.notEqual(paddingCharacter.trim(), "");
  assert.equal(startOfHeading.trim(), startOfHeading);
  assert.notEqual(startOfHeading.trim(), "");
  assert.equal(highOctetPreset.trim(), highOctetPreset);
  assert.notEqual(highOctetPreset.trim(), "");
  assert.equal(JSON.stringify(breakPermittedHere), '"' + breakPermittedHere + '"');
  assert.equal(JSON.stringify(breakPermittedHere).includes(breakPermittedHere), true);
  assert.equal(JSON.stringify(breakPermittedHere).includes("\\"), false);
  assert.equal(JSON.stringify(breakPermittedHere).includes("\\u0082"), false);
  assert.notEqual(JSON.stringify(breakPermittedHere), '"\\u0082"');
  assert.equal(JSON.stringify(paddingCharacter), '"' + paddingCharacter + '"');
  assert.equal(JSON.stringify(paddingCharacter).includes(paddingCharacter), true);
  assert.equal(JSON.stringify(paddingCharacter).includes("\\"), false);
  assert.equal(JSON.stringify(paddingCharacter).includes("\\u0080"), false);
  assert.notEqual(JSON.stringify(paddingCharacter), '"\\u0080"');
  assert.notEqual(JSON.stringify(paddingCharacter), '"\\u0082"');
  assert.equal(JSON.stringify(startOfHeading), '"\\u0001"');
  assert.equal(JSON.stringify(startOfHeading).includes("\\"), true);
  assert.equal(JSON.stringify(startOfHeading).includes("\\u0001"), true);
  assert.equal(JSON.stringify(startOfHeading).includes(startOfHeading), false);
  assert.notEqual(JSON.stringify(startOfHeading), '"' + startOfHeading + '"');
  assert.notEqual(JSON.stringify(startOfHeading), '"\\u0082"');
  assert.equal(JSON.stringify(highOctetPreset), '"' + highOctetPreset + '"');
  assert.equal(JSON.stringify(highOctetPreset).includes(highOctetPreset), true);
  assert.equal(JSON.stringify(highOctetPreset).includes("\\"), false);
  assert.equal(JSON.stringify(highOctetPreset).includes("\\u0081"), false);
  assert.notEqual(JSON.stringify(highOctetPreset), '"\\u0081"');
  assert.notEqual(JSON.stringify(highOctetPreset), '"\\u0082"');
  assert.notEqual(JSON.stringify(breakPermittedHere), JSON.stringify(paddingCharacter));
  assert.notEqual(JSON.stringify(breakPermittedHere), JSON.stringify(startOfHeading));
  assert.notEqual(JSON.stringify(breakPermittedHere), JSON.stringify(highOctetPreset));

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
  assert.ok(target, "a real item has a legal choice that can take an interior break-permitted-here character");
  const legal = target.options.find(option => uuid.test(option.id)).id;
  assert.equal(questions.some(question => question.id === target.id), true);
  assert.equal(target.options.some(option => option.id === legal), true);
  assert.equal(uuid.test(legal), true);
  assert.equal(uuid.test(target.id), true);
  assert.equal(legal.length, 36);
  assert.equal(legal.includes(breakPermittedHere), false);
  assert.equal(legal.includes(paddingCharacter), false);
  assert.equal(legal.includes(startOfHeading), false);
  assert.equal(legal.includes(highOctetPreset), false);
  assert.equal(legal.trim(), legal);

  const inserted = insertedInMiddle(legal, breakPermittedHere);
  const broken = inserted.value;
  const at = inserted.at;
  const paddingMiddle = insertedInMiddle(legal, paddingCharacter).value;
  const startOfHeadingMiddle = insertedInMiddle(legal, startOfHeading).value;
  const highOctetMiddle = insertedInMiddle(legal, highOctetPreset).value;
  assert.ok(at > 0 && at < legal.length);
  assert.equal(at, 18);
  assert.equal(legal.charCodeAt(at), 0x002D);
  assert.equal(broken.charCodeAt(at), 0x0082);
  assert.equal(broken.charCodeAt(at + 1), 0x002D);
  assert.notEqual(broken.charCodeAt(at), 0x0080);
  assert.notEqual(broken.charCodeAt(at), 0x0001);
  assert.notEqual(broken.charCodeAt(at), 0x0081);
  assert.equal(broken.slice(0, at), legal.slice(0, at));
  assert.equal(broken.slice(at + 1), legal.slice(at));
  assert.equal(broken.length, legal.length + 1);
  assert.notEqual(broken, legal);
  assert.equal(broken.replace(breakPermittedHere, ""), legal);
  assert.equal([...broken].filter(char => char === breakPermittedHere).length, 1);
  assert.equal(broken.indexOf(breakPermittedHere), at);
  assert.equal(broken.startsWith(breakPermittedHere), false);
  assert.equal(broken.endsWith(breakPermittedHere), false);
  assert.notEqual(broken, breakPermittedHere + legal);
  assert.notEqual(broken, legal + breakPermittedHere);
  assert.notEqual(broken, paddingMiddle);
  assert.notEqual(broken, startOfHeadingMiddle);
  assert.notEqual(broken, highOctetMiddle);
  assert.equal(broken.trim(), broken);
  assert.notEqual(broken.trim(), legal);
  assert.notEqual(broken.trim(), "");
  assert.equal((breakPermittedHere + legal).trim(), breakPermittedHere + legal);
  assert.notEqual((breakPermittedHere + legal).trim(), legal);
  assert.equal((legal + breakPermittedHere).trim(), legal + breakPermittedHere);
  assert.notEqual((legal + breakPermittedHere).trim(), legal);
  assert.equal((paddingCharacter + legal).trim(), paddingCharacter + legal);
  assert.notEqual((paddingCharacter + legal).trim(), legal);
  assert.equal((legal + paddingCharacter).trim(), legal + paddingCharacter);
  assert.notEqual((legal + paddingCharacter).trim(), legal);
  assert.equal((startOfHeading + legal).trim(), startOfHeading + legal);
  assert.notEqual((startOfHeading + legal).trim(), legal);
  assert.equal((legal + startOfHeading).trim(), legal + startOfHeading);
  assert.notEqual((legal + startOfHeading).trim(), legal);
  assert.equal((highOctetPreset + legal).trim(), highOctetPreset + legal);
  assert.notEqual((highOctetPreset + legal).trim(), legal);
  assert.equal((legal + highOctetPreset).trim(), legal + highOctetPreset);
  assert.notEqual((legal + highOctetPreset).trim(), legal);
  assert.equal(paddingMiddle.trim(), paddingMiddle);
  assert.notEqual(paddingMiddle.trim(), legal);
  assert.equal(startOfHeadingMiddle.trim(), startOfHeadingMiddle);
  assert.notEqual(startOfHeadingMiddle.trim(), legal);
  assert.equal(highOctetMiddle.trim(), highOctetMiddle);
  assert.notEqual(highOctetMiddle.trim(), legal);
  assert.notEqual(highOctetMiddle.trim(), "");
  assert.equal(/\s/.test(broken), false);
  assert.equal(/\s/.test(paddingMiddle), false);
  assert.equal(/\s/.test(startOfHeadingMiddle), false);
  assert.equal(/\s/.test(highOctetMiddle), false);
  assert.equal(/\p{Cc}/u.test(broken), true);
  assert.equal(/\p{White_Space}/u.test(broken), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(broken), false);
  assert.equal(/\p{White_Space}/u.test(paddingMiddle), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(paddingMiddle), false);
  assert.equal(/\p{White_Space}/u.test(startOfHeadingMiddle), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(startOfHeadingMiddle), false);
  assert.equal(/\p{White_Space}/u.test(highOctetMiddle), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(highOctetMiddle), false);
  assert.equal(broken.includes(paddingCharacter), false);
  assert.equal(broken.includes(startOfHeading), false);
  assert.equal(broken.includes(highOctetPreset), false);
  assert.equal(paddingMiddle.charCodeAt(at), 0x0080);
  assert.equal(paddingMiddle.includes(breakPermittedHere), false);
  assert.equal(paddingMiddle.includes(startOfHeading), false);
  assert.equal(paddingMiddle.includes(highOctetPreset), false);
  assert.equal(startOfHeadingMiddle.charCodeAt(at), 0x0001);
  assert.equal(startOfHeadingMiddle.includes(breakPermittedHere), false);
  assert.equal(startOfHeadingMiddle.includes(paddingCharacter), false);
  assert.equal(startOfHeadingMiddle.includes(highOctetPreset), false);
  assert.equal(highOctetMiddle.charCodeAt(at), 0x0081);
  assert.equal(highOctetMiddle.includes(breakPermittedHere), false);
  assert.equal(highOctetMiddle.includes(paddingCharacter), false);
  assert.equal(highOctetMiddle.includes(startOfHeading), false);
  assert.equal(uuid.test(broken), false);
  const optionIds = questions.flatMap(question => question.options.map(option => option.id));
  assert.equal(optionIds.includes(legal), true);
  assert.equal(optionIds.includes(broken), false);
  assert.equal(optionIds.includes(paddingMiddle), false);
  assert.equal(optionIds.includes(startOfHeadingMiddle), false);
  assert.equal(optionIds.includes(highOctetMiddle), false);
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
  assert.equal(payload.choices[0].charCodeAt(at), 0x0082);
  assert.equal(roundTrip.choices[0], broken);
  assert.equal(roundTrip.choices[0].charCodeAt(at), 0x0082);
  assert.notEqual(roundTrip.choices[0].charCodeAt(at), 0x0080);
  assert.notEqual(roundTrip.choices[0].charCodeAt(at), 0x0001);
  assert.notEqual(roundTrip.choices[0].charCodeAt(at), 0x0081);
  assert.equal(payload.choices[0] === legal, false);
  assert.equal(payload.choices[0] === paddingMiddle, false);
  assert.equal(payload.choices[0] === startOfHeadingMiddle, false);
  assert.equal(payload.choices[0] === highOctetMiddle, false);
  assert.equal(raw.includes(breakPermittedHere), true);
  assert.equal(raw.includes("\\u0082"), false);
  assert.equal(raw.includes(paddingCharacter), false);
  assert.equal(raw.includes("\\u0080"), false);
  assert.equal(raw.includes(startOfHeading), false);
  assert.equal(raw.includes("\\u0001"), false);
  assert.equal(raw.includes(highOctetPreset), false);
  assert.equal(raw.includes("\\u0081"), false);
  assert.equal(raw.includes(legal), false);
  assert.equal(JSON.stringify(broken).includes(breakPermittedHere), true);
  assert.equal(JSON.stringify(broken).includes("\\"), false);
  assert.equal(JSON.stringify(broken).includes("\\u0082"), false);
  assert.equal(JSON.stringify(broken).includes("\\u0080"), false);
  assert.equal(JSON.stringify(broken).includes("\\u0001"), false);
  assert.equal(JSON.stringify(broken).includes("\\u0081"), false);
  assert.equal(JSON.stringify(paddingMiddle).includes(paddingCharacter), true);
  assert.equal(JSON.stringify(paddingMiddle).includes("\\"), false);
  assert.equal(JSON.stringify(paddingMiddle).includes("\\u0080"), false);
  assert.equal(JSON.stringify(paddingMiddle).includes("\\u0082"), false);
  assert.equal(JSON.stringify(paddingMiddle).includes(breakPermittedHere), false);
  assert.equal(JSON.stringify(startOfHeadingMiddle).includes("\\u0001"), true);
  assert.equal(JSON.stringify(startOfHeadingMiddle).includes(startOfHeading), false);
  assert.equal(JSON.stringify(startOfHeadingMiddle).includes("\\u0082"), false);
  assert.equal(JSON.stringify(startOfHeadingMiddle).includes(breakPermittedHere), false);
  assert.equal(JSON.stringify(highOctetMiddle).includes(highOctetPreset), true);
  assert.equal(JSON.stringify(highOctetMiddle).includes("\\"), false);
  assert.equal(JSON.stringify(highOctetMiddle).includes("\\u0081"), false);
  assert.equal(JSON.stringify(highOctetMiddle).includes("\\u0082"), false);
  assert.equal(JSON.stringify(highOctetMiddle).includes(breakPermittedHere), false);
  assert.notEqual(JSON.stringify(broken), JSON.stringify(paddingMiddle));
  assert.notEqual(JSON.stringify(broken), JSON.stringify(startOfHeadingMiddle));
  assert.notEqual(JSON.stringify(broken), JSON.stringify(highOctetMiddle));
  f.resetWrites();
  const refused = await read(await f.req("/api/answers", "PUT", payload, { cookie }));
  assert.equal(refused.status, 422, JSON.stringify(refused.body));
  assert.equal(refused.body.error, "Choose an available answer.");
  assert.equal(refused.headers.get("Set-Cookie"), null);
  assert.equal(refused.text.includes(secret), false);
  assert.equal(refused.text.includes(sessionSecret), false);
  assert.equal(refused.text.includes(broken), false);
  assert.equal(refused.text.includes(breakPermittedHere), false);
  assert.equal(refused.text.includes("\\u0082"), false);
  assert.equal(refused.text.includes(paddingCharacter), false);
  assert.equal(refused.text.includes("\\u0080"), false);
  assert.equal(refused.text.includes(startOfHeading), false);
  assert.equal(refused.text.includes("\\u0001"), false);
  assert.equal(refused.text.includes(highOctetPreset), false);
  assert.equal(refused.text.includes("\\u0081"), false);
  assert.equal(refused.text.includes(legal), false);
  assert.deepEqual(f.written, []);

  const after = stored(f, reference);
  assert.deepEqual(after, snapshot);
  assert.deepEqual(after.answers, {});
  assert.equal(Object.hasOwn(after.answers, target.id), false);
  assert.equal(JSON.stringify(after.answers).includes(breakPermittedHere), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u0082"), false);
  assert.equal(JSON.stringify(after.answers).includes(paddingCharacter), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u0080"), false);
  assert.equal(JSON.stringify(after.answers).includes(highOctetPreset), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u0081"), false);
  assert.equal(JSON.stringify(after.answers).includes(legal), false);
  assert.equal(JSON.stringify(after).includes(breakPermittedHere), false);
  assert.equal(JSON.stringify(after).includes("\\u0082"), false);
  assert.equal(JSON.stringify(after).includes(paddingCharacter), false);
  assert.equal(JSON.stringify(after).includes("\\u0080"), false);
  assert.equal(JSON.stringify(after).includes(startOfHeading), false);
  assert.equal(JSON.stringify(after).includes("\\u0001"), false);
  assert.equal(JSON.stringify(after).includes(highOctetPreset), false);
  assert.equal(JSON.stringify(after).includes("\\u0081"), false);
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
  assert.equal(viewed.text.includes(breakPermittedHere), false);
  assert.equal(viewed.text.includes("\\u0082"), false);
  assert.equal(viewed.text.includes(paddingCharacter), false);
  assert.equal(viewed.text.includes("\\u0080"), false);
  assert.equal(viewed.text.includes(startOfHeading), false);
  assert.equal(viewed.text.includes("\\u0001"), false);
  assert.equal(viewed.text.includes(highOctetPreset), false);
  assert.equal(viewed.text.includes("\\u0081"), false);
  assert.equal(f.records.get(reference).etag, openedEtag);
  assert.equal(stored(f, reference).inviteHash, inviteHash);
  assert.equal(stored(f, reference).sessionHash, sessionHash);
  assert.deepEqual(stored(f, reference).answers, {});
});
