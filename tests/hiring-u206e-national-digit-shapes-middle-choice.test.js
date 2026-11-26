import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import worker, { Assessment } from "../src/worker.js";

// One live hiring sitting. Save an answer for a real item on this paper
// whose choice id is that item's legal choice string with a national digit
// shapes character (U+206E) inserted in the middle. The save is refused.
// No answer is stored. The invite hash and the session secret stay unchanged.
// An activate arabic form shaping character (U+206D) in the middle, an inhibit
// arabic form shaping character (U+206C) in the middle, and an activate
// symmetric swapping character (U+206B) in the middle are separate checks.

const origin = "https://assessment.example";
const notice = {
  controller: "Test controller", contact: "privacy@example.invalid", basis: "Test basis",
  recipients: "Test reviewer", transfers: "Test transfer description", rights: "Test rights",
  purpose: "Test purpose", supervisoryAuthority: "Test authority", version: "test-1", retentionMinutes: 30,
};
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const random = () => crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
const nationalDigitShapes = "\u206E";
const activateArabicFormShaping = "\u206D";
const inhibitArabicFormShaping = "\u206C";
const activateSymmetricSwapping = "\u206B";

function insertedInMiddle(value, mark) {
  const at = Math.floor(value.length / 2);
  return { at, value: value.slice(0, at) + mark + value.slice(at) };
}

function escapeForms(codePoint) {
  const hex = codePoint.toString(16).padStart(4, "0");
  return [...new Set(["\\u" + hex, "\\u" + hex.toUpperCase()])];
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

function assertFormatMark(mark, codePoint, bidiControl) {
  assert.equal(mark, String.fromCodePoint(codePoint));
  assert.equal(mark.charCodeAt(0), codePoint);
  assert.equal(mark.codePointAt(0), codePoint);
  assert.equal(mark.length, 1);
  assert.equal(/\s/.test(mark), false);
  assert.equal(/\p{Cf}/u.test(mark), true);
  assert.equal(/\p{Cc}/u.test(mark), false);
  assert.equal(/\p{Zl}/u.test(mark), false);
  assert.equal(/\p{Zp}/u.test(mark), false);
  assert.equal(/\p{Zs}/u.test(mark), false);
  assert.equal(/\p{White_Space}/u.test(mark), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(mark), false);
  assert.equal(/\p{Bidi_Control}/u.test(mark), bidiControl);
  assert.equal(mark.trim(), mark);
  assert.notEqual(mark.trim(), "");
  const encoded = JSON.stringify(mark);
  assert.equal(encoded, '"' + mark + '"');
  assert.equal(encoded.includes(mark), true);
  assert.equal(encoded.includes("\\"), false);
  for (const form of escapeForms(codePoint)) {
    assert.equal(encoded.includes(form), false);
    assert.notEqual(encoded, form);
  }
}

test("a legal choice with a national digit shapes character (U+206E) inserted in the middle is refused and stores nothing", async () => {
  const source = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(source, /"LIVE_ENABLED": "false"/);
  assert.equal(nationalDigitShapes.codePointAt(0), 0x206E);
  assert.notEqual(0x206E, 0x206D);
  assert.notEqual(0x206E, 0x206C);
  assert.notEqual(0x206E, 0x206B);
  assertFormatMark(nationalDigitShapes, 0x206E, false);
  assertFormatMark(activateArabicFormShaping, 0x206D, false);
  assertFormatMark(inhibitArabicFormShaping, 0x206C, false);
  assertFormatMark(activateSymmetricSwapping, 0x206B, false);
  assert.notEqual(nationalDigitShapes, activateArabicFormShaping);
  assert.notEqual(nationalDigitShapes, inhibitArabicFormShaping);
  assert.notEqual(nationalDigitShapes, activateSymmetricSwapping);
  assert.notEqual(JSON.stringify(nationalDigitShapes), JSON.stringify(activateArabicFormShaping));
  assert.notEqual(JSON.stringify(nationalDigitShapes), JSON.stringify(inhibitArabicFormShaping));
  assert.notEqual(JSON.stringify(nationalDigitShapes), JSON.stringify(activateSymmetricSwapping));

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
  assert.ok(target, "a real item has a legal choice that can take an interior national digit shapes character (U+206E)");
  const legal = target.options.find(option => uuid.test(option.id)).id;
  assert.equal(questions.some(question => question.id === target.id), true);
  assert.equal(target.options.some(option => option.id === legal), true);
  assert.equal(uuid.test(legal), true);
  assert.equal(uuid.test(target.id), true);
  assert.equal(legal.length, 36);
  assert.equal(legal.includes(nationalDigitShapes), false);
  assert.equal(legal.includes(activateArabicFormShaping), false);
  assert.equal(legal.includes(inhibitArabicFormShaping), false);
  assert.equal(legal.includes(activateSymmetricSwapping), false);
  assert.equal(legal.trim(), legal);
  assert.equal(/\p{Pattern_White_Space}/u.test(legal), false);

  const inserted = insertedInMiddle(legal, nationalDigitShapes);
  const broken = inserted.value;
  const at = inserted.at;
  const activateArabicFormShapingMiddle = insertedInMiddle(legal, activateArabicFormShaping).value;
  const inhibitArabicFormShapingMiddle = insertedInMiddle(legal, inhibitArabicFormShaping).value;
  const activateSymmetricSwappingMiddle = insertedInMiddle(legal, activateSymmetricSwapping).value;
  assert.ok(at > 0 && at < legal.length);
  assert.equal(at, 18);
  assert.equal(legal.charCodeAt(at), 0x002D);
  assert.equal(broken.charCodeAt(at), 0x206E);
  assert.equal(broken.charCodeAt(at + 1), 0x002D);
  assert.notEqual(broken.charCodeAt(at), 0x206D);
  assert.notEqual(broken.charCodeAt(at), 0x206C);
  assert.notEqual(broken.charCodeAt(at), 0x206B);
  assert.equal(broken.slice(0, at), legal.slice(0, at));
  assert.equal(broken.slice(at + 1), legal.slice(at));
  assert.equal(broken.length, legal.length + 1);
  assert.notEqual(broken, legal);
  assert.equal(broken.replace(nationalDigitShapes, ""), legal);
  assert.equal([...broken].filter(char => char === nationalDigitShapes).length, 1);
  assert.equal(broken.indexOf(nationalDigitShapes), at);
  assert.equal(broken.startsWith(nationalDigitShapes), false);
  assert.equal(broken.endsWith(nationalDigitShapes), false);
  assert.notEqual(broken, nationalDigitShapes + legal);
  assert.notEqual(broken, legal + nationalDigitShapes);
  assert.notEqual(broken, activateArabicFormShapingMiddle);
  assert.notEqual(broken, inhibitArabicFormShapingMiddle);
  assert.notEqual(broken, activateSymmetricSwappingMiddle);
  assert.equal(broken.trim(), broken);
  assert.notEqual(broken.trim(), legal);
  assert.notEqual(broken.trim(), "");
  for (const marked of [
    nationalDigitShapes + legal, legal + nationalDigitShapes,
    activateArabicFormShaping + legal, legal + activateArabicFormShaping,
    inhibitArabicFormShaping + legal, legal + inhibitArabicFormShaping,
    activateSymmetricSwapping + legal, legal + activateSymmetricSwapping,
    activateArabicFormShapingMiddle, inhibitArabicFormShapingMiddle, activateSymmetricSwappingMiddle,
  ]) {
    assert.equal(marked.trim(), marked);
    assert.notEqual(marked.trim(), legal);
  }
  assert.equal(/\s/.test(broken), false);
  assert.equal(/\p{Cf}/u.test(broken), true);
  assert.equal(/\p{Cc}/u.test(broken), false);
  assert.equal(/\p{Zl}/u.test(broken), false);
  assert.equal(/\p{Bidi_Control}/u.test(broken), false);
  assert.equal(/\p{White_Space}/u.test(broken), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(broken), false);
  assert.equal(broken.includes(activateArabicFormShaping), false);
  assert.equal(broken.includes(inhibitArabicFormShaping), false);
  assert.equal(broken.includes(activateSymmetricSwapping), false);
  assert.equal(activateArabicFormShapingMiddle.charCodeAt(at), 0x206D);
  assert.equal(activateArabicFormShapingMiddle.includes(nationalDigitShapes), false);
  assert.equal(/\p{Bidi_Control}/u.test(activateArabicFormShapingMiddle), false);
  assert.equal(inhibitArabicFormShapingMiddle.charCodeAt(at), 0x206C);
  assert.equal(inhibitArabicFormShapingMiddle.includes(nationalDigitShapes), false);
  assert.equal(/\p{Bidi_Control}/u.test(inhibitArabicFormShapingMiddle), false);
  assert.equal(activateSymmetricSwappingMiddle.charCodeAt(at), 0x206B);
  assert.equal(activateSymmetricSwappingMiddle.includes(nationalDigitShapes), false);
  assert.equal(/\p{Bidi_Control}/u.test(activateSymmetricSwappingMiddle), false);
  assert.equal(uuid.test(broken), false);
  const optionIds = questions.flatMap(question => question.options.map(option => option.id));
  assert.equal(optionIds.includes(legal), true);
  assert.equal(optionIds.includes(broken), false);
  assert.equal(optionIds.includes(activateArabicFormShapingMiddle), false);
  assert.equal(optionIds.includes(inhibitArabicFormShapingMiddle), false);
  assert.equal(optionIds.includes(activateSymmetricSwappingMiddle), false);
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
  assert.equal(payload.choices[0].charCodeAt(at), 0x206E);
  assert.equal(roundTrip.choices[0], broken);
  assert.equal(roundTrip.choices[0].charCodeAt(at), 0x206E);
  assert.notEqual(roundTrip.choices[0].charCodeAt(at), 0x206D);
  assert.notEqual(roundTrip.choices[0].charCodeAt(at), 0x206C);
  assert.notEqual(roundTrip.choices[0].charCodeAt(at), 0x206B);
  assert.equal(payload.choices[0] === legal, false);
  assert.equal(payload.choices[0] === activateArabicFormShapingMiddle, false);
  assert.equal(payload.choices[0] === inhibitArabicFormShapingMiddle, false);
  assert.equal(payload.choices[0] === activateSymmetricSwappingMiddle, false);
  assert.equal(raw.includes(nationalDigitShapes), true);
  assert.equal(raw.includes(legal), false);
  assert.equal(raw.includes("\\"), false);
  for (const form of [...escapeForms(0x206E), ...escapeForms(0x206D), ...escapeForms(0x206C), ...escapeForms(0x206B)]) {
    assert.equal(raw.includes(form), false);
    assert.equal(JSON.stringify(broken).includes(form), false);
  }
  assert.equal(JSON.stringify(broken).includes(nationalDigitShapes), true);
  assert.equal(JSON.stringify(broken).includes(activateArabicFormShaping), false);
  assert.equal(JSON.stringify(broken).includes(inhibitArabicFormShaping), false);
  assert.equal(JSON.stringify(broken).includes(activateSymmetricSwapping), false);
  assert.notEqual(JSON.stringify(broken), JSON.stringify(activateArabicFormShapingMiddle));
  assert.notEqual(JSON.stringify(broken), JSON.stringify(inhibitArabicFormShapingMiddle));
  assert.notEqual(JSON.stringify(broken), JSON.stringify(activateSymmetricSwappingMiddle));
  f.resetWrites();
  const refused = await read(await f.req("/api/answers", "PUT", payload, { cookie }));
  assert.equal(refused.status, 422, JSON.stringify(refused.body));
  assert.equal(refused.body.error, "Choose an available answer.");
  assert.equal(refused.headers.get("Set-Cookie"), null);
  assert.equal(refused.text.includes(secret), false);
  assert.equal(refused.text.includes(sessionSecret), false);
  assert.equal(refused.text.includes(broken), false);
  assert.equal(refused.text.includes(nationalDigitShapes), false);
  assert.equal(refused.text.includes(activateArabicFormShaping), false);
  assert.equal(refused.text.includes(inhibitArabicFormShaping), false);
  assert.equal(refused.text.includes(activateSymmetricSwapping), false);
  assert.equal(refused.text.includes(legal), false);
  for (const form of [...escapeForms(0x206E), ...escapeForms(0x206D), ...escapeForms(0x206C), ...escapeForms(0x206B)]) {
    assert.equal(refused.text.includes(form), false);
  }
  assert.deepEqual(f.written, []);

  const after = stored(f, reference);
  assert.deepEqual(after, snapshot);
  assert.deepEqual(after.answers, {});
  assert.equal(Object.hasOwn(after.answers, target.id), false);
  assert.equal(JSON.stringify(after.answers).includes(nationalDigitShapes), false);
  assert.equal(JSON.stringify(after.answers).includes(activateArabicFormShaping), false);
  assert.equal(JSON.stringify(after.answers).includes(inhibitArabicFormShaping), false);
  assert.equal(JSON.stringify(after.answers).includes(activateSymmetricSwapping), false);
  assert.equal(JSON.stringify(after.answers).includes(legal), false);
  assert.equal(JSON.stringify(after).includes(nationalDigitShapes), false);
  assert.equal(JSON.stringify(after).includes(activateArabicFormShaping), false);
  assert.equal(JSON.stringify(after).includes(inhibitArabicFormShaping), false);
  assert.equal(JSON.stringify(after).includes(activateSymmetricSwapping), false);
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
  assert.equal(viewed.text.includes(nationalDigitShapes), false);
  assert.equal(viewed.text.includes(activateArabicFormShaping), false);
  assert.equal(viewed.text.includes(inhibitArabicFormShaping), false);
  assert.equal(viewed.text.includes(activateSymmetricSwapping), false);
  assert.equal(f.records.get(reference).etag, openedEtag);
  assert.equal(stored(f, reference).inviteHash, inviteHash);
  assert.equal(stored(f, reference).sessionHash, sessionHash);
  assert.deepEqual(stored(f, reference).answers, {});
  assert.deepEqual(f.written, []);
});
