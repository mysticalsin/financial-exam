import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import worker, { Assessment } from "../src/worker.js";

// One live hiring sitting. Save an answer for a real item on this paper
// whose choice id is that item's legal choice string with a private-use-area
// character (U+E000) inserted in the middle. The save is refused. No answer
// is stored. The invite hash and the session secret stay unchanged. A
// replacement character (U+FFFD) in the middle, an object replacement
// character (U+FFFC) in the middle, and an interlinear annotation terminator
// (U+FFFB) in the middle are separate checks.

const origin = "https://assessment.example";
const notice = {
  controller: "Test controller", contact: "privacy@example.invalid", basis: "Test basis",
  recipients: "Test reviewer", transfers: "Test transfer description", rights: "Test rights",
  purpose: "Test purpose", supervisoryAuthority: "Test authority", version: "test-1", retentionMinutes: 30,
};
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const random = () => crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
const privateUseArea = "\uE000";
const replacementCharacter = "\uFFFD";
const objectReplacement = "\uFFFC";
const interlinearAnnotationTerminator = "\uFFFB";

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

function assertMark(mark, codePoint, { format, symbol, privateUse }) {
  assert.equal(mark, String.fromCodePoint(codePoint));
  assert.equal(mark.charCodeAt(0), codePoint);
  assert.equal(mark.codePointAt(0), codePoint);
  assert.equal(mark.length, 1);
  assert.equal(/\s/.test(mark), false);
  assert.equal(/\p{Cf}/u.test(mark), format);
  assert.equal(/\p{So}/u.test(mark), symbol);
  assert.equal(/\p{Co}/u.test(mark), privateUse);
  assert.equal(/\p{Cc}/u.test(mark), false);
  assert.equal(/\p{Zl}/u.test(mark), false);
  assert.equal(/\p{Zp}/u.test(mark), false);
  assert.equal(/\p{Zs}/u.test(mark), false);
  assert.equal(/\p{White_Space}/u.test(mark), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(mark), false);
  assert.equal(/\p{Bidi_Control}/u.test(mark), false);
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

test("a legal choice with a private-use-area character (U+E000) inserted in the middle is refused and stores nothing", async () => {
  const source = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(source, /"LIVE_ENABLED": "false"/);
  assert.equal(privateUseArea.codePointAt(0), 0xE000);
  assert.notEqual(0xE000, 0xFFFD);
  assert.notEqual(0xE000, 0xFFFC);
  assert.notEqual(0xE000, 0xFFFB);
  assertMark(privateUseArea, 0xE000, { format: false, symbol: false, privateUse: true });
  assertMark(replacementCharacter, 0xFFFD, { format: false, symbol: true, privateUse: false });
  assertMark(objectReplacement, 0xFFFC, { format: false, symbol: true, privateUse: false });
  assertMark(interlinearAnnotationTerminator, 0xFFFB, { format: true, symbol: false, privateUse: false });
  assert.notEqual(privateUseArea, replacementCharacter);
  assert.notEqual(privateUseArea, objectReplacement);
  assert.notEqual(privateUseArea, interlinearAnnotationTerminator);
  assert.notEqual(JSON.stringify(privateUseArea), JSON.stringify(replacementCharacter));
  assert.notEqual(JSON.stringify(privateUseArea), JSON.stringify(objectReplacement));
  assert.notEqual(JSON.stringify(privateUseArea), JSON.stringify(interlinearAnnotationTerminator));
  assert.equal((privateUseArea + "choice").trim(), privateUseArea + "choice");
  assert.notEqual((privateUseArea + "choice").trim(), "choice");
  assert.equal((replacementCharacter + "choice").trim(), replacementCharacter + "choice");
  assert.notEqual((replacementCharacter + "choice").trim(), "choice");
  assert.equal((objectReplacement + "choice").trim(), objectReplacement + "choice");
  assert.notEqual((objectReplacement + "choice").trim(), "choice");
  assert.equal((interlinearAnnotationTerminator + "choice").trim(), interlinearAnnotationTerminator + "choice");
  assert.notEqual((interlinearAnnotationTerminator + "choice").trim(), "choice");

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
  assert.ok(target, "a real item has a legal choice that can take an interior private-use-area character (U+E000)");
  const legal = target.options.find(option => uuid.test(option.id)).id;
  assert.equal(questions.some(question => question.id === target.id), true);
  assert.equal(target.options.some(option => option.id === legal), true);
  assert.equal(uuid.test(legal), true);
  assert.equal(uuid.test(target.id), true);
  assert.equal(legal.length, 36);
  assert.equal(legal.includes(privateUseArea), false);
  assert.equal(legal.includes(replacementCharacter), false);
  assert.equal(legal.includes(objectReplacement), false);
  assert.equal(legal.includes(interlinearAnnotationTerminator), false);
  assert.equal(legal.trim(), legal);
  assert.equal(/\p{Pattern_White_Space}/u.test(legal), false);

  const inserted = insertedInMiddle(legal, privateUseArea);
  const broken = inserted.value;
  const at = inserted.at;
  const replacementMiddle = insertedInMiddle(legal, replacementCharacter).value;
  const objectMiddle = insertedInMiddle(legal, objectReplacement).value;
  const terminatorMiddle = insertedInMiddle(legal, interlinearAnnotationTerminator).value;
  assert.ok(at > 0 && at < legal.length);
  assert.equal(at, 18);
  assert.equal(legal.charCodeAt(at), 0x002D);
  assert.equal(broken.charCodeAt(at), 0xE000);
  assert.equal(broken.charCodeAt(at + 1), 0x002D);
  assert.notEqual(broken.charCodeAt(at), 0xFFFD);
  assert.notEqual(broken.charCodeAt(at), 0xFFFC);
  assert.notEqual(broken.charCodeAt(at), 0xFFFB);
  assert.equal(broken.slice(0, at), legal.slice(0, at));
  assert.equal(broken.slice(at + 1), legal.slice(at));
  assert.equal(broken.length, legal.length + 1);
  assert.notEqual(broken, legal);
  assert.equal(broken.replace(privateUseArea, ""), legal);
  assert.equal([...broken].filter(char => char === privateUseArea).length, 1);
  assert.equal(broken.indexOf(privateUseArea), at);
  assert.equal(broken.startsWith(privateUseArea), false);
  assert.equal(broken.endsWith(privateUseArea), false);
  assert.notEqual(broken, privateUseArea + legal);
  assert.notEqual(broken, legal + privateUseArea);
  assert.notEqual(broken, replacementMiddle);
  assert.notEqual(broken, objectMiddle);
  assert.notEqual(broken, terminatorMiddle);
  assert.equal(broken.trim(), broken);
  assert.notEqual(broken.trim(), legal);
  assert.notEqual(broken.trim(), "");
  for (const marked of [
    privateUseArea + legal, legal + privateUseArea,
    replacementCharacter + legal, legal + replacementCharacter,
    objectReplacement + legal, legal + objectReplacement,
    interlinearAnnotationTerminator + legal, legal + interlinearAnnotationTerminator,
    replacementMiddle, objectMiddle, terminatorMiddle,
  ]) {
    assert.equal(marked.trim(), marked);
    assert.notEqual(marked.trim(), legal);
  }
  assert.equal(/\s/.test(broken), false);
  assert.equal(/\s/.test(replacementMiddle), false);
  assert.equal(/\s/.test(objectMiddle), false);
  assert.equal(/\s/.test(terminatorMiddle), false);
  assert.equal(/\p{Co}/u.test(broken), true);
  assert.equal(/\p{So}/u.test(broken), false);
  assert.equal(/\p{Cf}/u.test(broken), false);
  assert.equal(/\p{Cc}/u.test(broken), false);
  assert.equal(/\p{Zl}/u.test(broken), false);
  assert.equal(/\p{Bidi_Control}/u.test(broken), false);
  assert.equal(/\p{White_Space}/u.test(broken), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(broken), false);
  assert.equal(broken.includes(replacementCharacter), false);
  assert.equal(broken.includes(objectReplacement), false);
  assert.equal(broken.includes(interlinearAnnotationTerminator), false);
  assert.equal(replacementMiddle.charCodeAt(at), 0xFFFD);
  assert.equal(replacementMiddle.includes(privateUseArea), false);
  assert.equal(/\s/.test(replacementMiddle), false);
  assert.equal(/\p{Cf}/u.test(replacementMiddle), false);
  assert.equal(/\p{So}/u.test(replacementMiddle), true);
  assert.equal(/\p{Co}/u.test(replacementMiddle), false);
  assert.equal(/\p{Bidi_Control}/u.test(replacementMiddle), false);
  assert.equal(objectMiddle.charCodeAt(at), 0xFFFC);
  assert.equal(objectMiddle.includes(privateUseArea), false);
  assert.equal(/\s/.test(objectMiddle), false);
  assert.equal(/\p{Cf}/u.test(objectMiddle), false);
  assert.equal(/\p{So}/u.test(objectMiddle), true);
  assert.equal(/\p{Co}/u.test(objectMiddle), false);
  assert.equal(/\p{Bidi_Control}/u.test(objectMiddle), false);
  assert.equal(terminatorMiddle.charCodeAt(at), 0xFFFB);
  assert.equal(terminatorMiddle.includes(privateUseArea), false);
  assert.equal(/\s/.test(terminatorMiddle), false);
  assert.equal(/\p{Cf}/u.test(terminatorMiddle), true);
  assert.equal(/\p{So}/u.test(terminatorMiddle), false);
  assert.equal(/\p{Co}/u.test(terminatorMiddle), false);
  assert.equal(/\p{Bidi_Control}/u.test(terminatorMiddle), false);
  assert.equal(uuid.test(broken), false);
  const optionIds = questions.flatMap(question => question.options.map(option => option.id));
  assert.equal(optionIds.includes(legal), true);
  assert.equal(optionIds.includes(broken), false);
  assert.equal(optionIds.includes(replacementMiddle), false);
  assert.equal(optionIds.includes(objectMiddle), false);
  assert.equal(optionIds.includes(terminatorMiddle), false);
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
  assert.equal(payload.choices[0].charCodeAt(at), 0xE000);
  assert.equal(roundTrip.choices[0], broken);
  assert.equal(roundTrip.choices[0].charCodeAt(at), 0xE000);
  assert.notEqual(roundTrip.choices[0].charCodeAt(at), 0xFFFD);
  assert.notEqual(roundTrip.choices[0].charCodeAt(at), 0xFFFC);
  assert.notEqual(roundTrip.choices[0].charCodeAt(at), 0xFFFB);
  assert.equal(payload.choices[0] === legal, false);
  assert.equal(payload.choices[0] === replacementMiddle, false);
  assert.equal(payload.choices[0] === objectMiddle, false);
  assert.equal(payload.choices[0] === terminatorMiddle, false);
  assert.equal(raw.includes(privateUseArea), true);
  assert.equal(raw.includes(legal), false);
  assert.equal(raw.includes("\\"), false);
  for (const form of [...escapeForms(0xE000), ...escapeForms(0xFFFD), ...escapeForms(0xFFFC), ...escapeForms(0xFFFB)]) {
    assert.equal(raw.includes(form), false);
    assert.equal(JSON.stringify(broken).includes(form), false);
  }
  assert.equal(JSON.stringify(broken).includes(privateUseArea), true);
  assert.equal(JSON.stringify(broken).includes(replacementCharacter), false);
  assert.equal(JSON.stringify(broken).includes(objectReplacement), false);
  assert.equal(JSON.stringify(broken).includes(interlinearAnnotationTerminator), false);
  assert.notEqual(JSON.stringify(broken), JSON.stringify(replacementMiddle));
  assert.notEqual(JSON.stringify(broken), JSON.stringify(objectMiddle));
  assert.notEqual(JSON.stringify(broken), JSON.stringify(terminatorMiddle));
  f.resetWrites();
  const refused = await read(await f.req("/api/answers", "PUT", payload, { cookie }));
  assert.equal(refused.status, 422, JSON.stringify(refused.body));
  assert.equal(refused.body.error, "Choose an available answer.");
  assert.equal(refused.headers.get("Set-Cookie"), null);
  assert.equal(refused.text.includes(secret), false);
  assert.equal(refused.text.includes(sessionSecret), false);
  assert.equal(refused.text.includes(broken), false);
  assert.equal(refused.text.includes(privateUseArea), false);
  assert.equal(refused.text.includes(replacementCharacter), false);
  assert.equal(refused.text.includes(objectReplacement), false);
  assert.equal(refused.text.includes(interlinearAnnotationTerminator), false);
  assert.equal(refused.text.includes(legal), false);
  for (const form of [...escapeForms(0xE000), ...escapeForms(0xFFFD), ...escapeForms(0xFFFC), ...escapeForms(0xFFFB)]) {
    assert.equal(refused.text.includes(form), false);
  }
  assert.deepEqual(f.written, []);

  const after = stored(f, reference);
  assert.deepEqual(after, snapshot);
  assert.deepEqual(after.answers, {});
  assert.equal(Object.hasOwn(after.answers, target.id), false);
  assert.equal(JSON.stringify(after.answers).includes(privateUseArea), false);
  assert.equal(JSON.stringify(after.answers).includes(replacementCharacter), false);
  assert.equal(JSON.stringify(after.answers).includes(objectReplacement), false);
  assert.equal(JSON.stringify(after.answers).includes(interlinearAnnotationTerminator), false);
  assert.equal(JSON.stringify(after.answers).includes(legal), false);
  assert.equal(JSON.stringify(after).includes(privateUseArea), false);
  assert.equal(JSON.stringify(after).includes(replacementCharacter), false);
  assert.equal(JSON.stringify(after).includes(objectReplacement), false);
  assert.equal(JSON.stringify(after).includes(interlinearAnnotationTerminator), false);
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
  assert.equal(viewed.text.includes(privateUseArea), false);
  assert.equal(viewed.text.includes(replacementCharacter), false);
  assert.equal(viewed.text.includes(objectReplacement), false);
  assert.equal(viewed.text.includes(interlinearAnnotationTerminator), false);
  assert.equal(f.records.get(reference).etag, openedEtag);
  assert.equal(stored(f, reference).inviteHash, inviteHash);
  assert.equal(stored(f, reference).sessionHash, sessionHash);
  assert.deepEqual(stored(f, reference).answers, {});
  assert.deepEqual(f.written, []);
});
