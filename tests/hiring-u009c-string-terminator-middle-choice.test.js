import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import worker, { Assessment } from "../src/worker.js";

// One live hiring sitting. Save an answer for a real item on this paper
// whose choice id is that item's legal choice string with a
// string-terminator character (U+009C) inserted in the middle.
// The save is refused. No answer is stored. The invite hash and the
// session secret stay unchanged.
// A control-sequence-introducer character (U+009B) in the middle, a
// single-character-introducer character (U+009A) in the middle, and a
// single-graphic-character-introducer character (U+0099) in the middle are separate checks.

const origin = "https://assessment.example";
const notice = {
  controller: "Test controller", contact: "privacy@example.invalid", basis: "Test basis",
  recipients: "Test reviewer", transfers: "Test transfer description", rights: "Test rights",
  purpose: "Test purpose", supervisoryAuthority: "Test authority", version: "test-1", retentionMinutes: 30,
};
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const random = () => crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
const stringTerminator = "\u009C";
const controlSequenceIntroducer = "\u009B";
const singleCharacterIntroducer = "\u009A";
const singleGraphicCharacterIntroducer = "\u0099";

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

test("a legal choice with a string-terminator character (U+009C) inserted in the middle is refused and stores nothing", async () => {
  const source = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(source, /"LIVE_ENABLED": "false"/);
  assert.equal(stringTerminator, "\u009C");
  assert.equal(stringTerminator.charCodeAt(0), 0x009C);
  assert.equal(stringTerminator.codePointAt(0), 0x009C);
  assert.equal(stringTerminator.length, 1);
  assert.notEqual(stringTerminator, controlSequenceIntroducer);
  assert.notEqual(stringTerminator.charCodeAt(0), 0x009B);
  assert.notEqual(stringTerminator, singleCharacterIntroducer);
  assert.notEqual(stringTerminator.charCodeAt(0), 0x009A);
  assert.notEqual(stringTerminator, singleGraphicCharacterIntroducer);
  assert.notEqual(stringTerminator.charCodeAt(0), 0x0099);
  assert.equal(controlSequenceIntroducer, "\u009B");
  assert.equal(controlSequenceIntroducer.charCodeAt(0), 0x009B);
  assert.equal(controlSequenceIntroducer.codePointAt(0), 0x009B);
  assert.equal(controlSequenceIntroducer.length, 1);
  assert.equal(singleCharacterIntroducer, "\u009A");
  assert.equal(singleCharacterIntroducer.charCodeAt(0), 0x009A);
  assert.equal(singleCharacterIntroducer.codePointAt(0), 0x009A);
  assert.equal(singleCharacterIntroducer.length, 1);
  assert.equal(singleGraphicCharacterIntroducer, "\u0099");
  assert.equal(singleGraphicCharacterIntroducer.charCodeAt(0), 0x0099);
  assert.equal(singleGraphicCharacterIntroducer.codePointAt(0), 0x0099);
  assert.equal(singleGraphicCharacterIntroducer.length, 1);
  assert.equal(/\s/.test(stringTerminator), false);
  assert.equal(/\s/.test(controlSequenceIntroducer), false);
  assert.equal(/\s/.test(singleCharacterIntroducer), false);
  assert.equal(/\s/.test(singleGraphicCharacterIntroducer), false);
  assert.equal(/\p{Cc}/u.test(stringTerminator), true);
  assert.equal(/\p{Cf}/u.test(stringTerminator), false);
  assert.equal(/\p{Zl}/u.test(stringTerminator), false);
  assert.equal(/\p{Zp}/u.test(stringTerminator), false);
  assert.equal(/\p{Zs}/u.test(stringTerminator), false);
  assert.equal(/\p{White_Space}/u.test(stringTerminator), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(stringTerminator), false);
  assert.equal(/\p{Cc}/u.test(controlSequenceIntroducer), true);
  assert.equal(/\p{Cf}/u.test(controlSequenceIntroducer), false);
  assert.equal(/\p{White_Space}/u.test(controlSequenceIntroducer), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(controlSequenceIntroducer), false);
  assert.equal(/\p{Cc}/u.test(singleCharacterIntroducer), true);
  assert.equal(/\p{Cf}/u.test(singleCharacterIntroducer), false);
  assert.equal(/\p{White_Space}/u.test(singleCharacterIntroducer), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(singleCharacterIntroducer), false);
  assert.equal(/\p{Cc}/u.test(singleGraphicCharacterIntroducer), true);
  assert.equal(/\p{Cf}/u.test(singleGraphicCharacterIntroducer), false);
  assert.equal(/\p{White_Space}/u.test(singleGraphicCharacterIntroducer), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(singleGraphicCharacterIntroducer), false);
  assert.equal(stringTerminator.trim(), stringTerminator);
  assert.notEqual(stringTerminator.trim(), "");
  assert.equal(controlSequenceIntroducer.trim(), controlSequenceIntroducer);
  assert.notEqual(controlSequenceIntroducer.trim(), "");
  assert.equal(singleCharacterIntroducer.trim(), singleCharacterIntroducer);
  assert.notEqual(singleCharacterIntroducer.trim(), "");
  assert.equal(singleGraphicCharacterIntroducer.trim(), singleGraphicCharacterIntroducer);
  assert.notEqual(singleGraphicCharacterIntroducer.trim(), "");
  assert.equal(JSON.stringify(stringTerminator), '"' + stringTerminator + '"');
  assert.equal(JSON.stringify(stringTerminator).includes(stringTerminator), true);
  assert.equal(JSON.stringify(stringTerminator).includes("\\"), false);
  assert.equal(JSON.stringify(stringTerminator).includes("\\u009C"), false);
  assert.notEqual(JSON.stringify(stringTerminator), '"\\u009C"');
  assert.equal(JSON.stringify(controlSequenceIntroducer), '"' + controlSequenceIntroducer + '"');
  assert.equal(JSON.stringify(controlSequenceIntroducer).includes(controlSequenceIntroducer), true);
  assert.equal(JSON.stringify(controlSequenceIntroducer).includes("\\"), false);
  assert.equal(JSON.stringify(controlSequenceIntroducer).includes("\\u009B"), false);
  assert.notEqual(JSON.stringify(controlSequenceIntroducer), '"\\u009B"');
  assert.notEqual(JSON.stringify(controlSequenceIntroducer), '"\\u009C"');
  assert.equal(JSON.stringify(singleCharacterIntroducer), '"' + singleCharacterIntroducer + '"');
  assert.equal(JSON.stringify(singleCharacterIntroducer).includes(singleCharacterIntroducer), true);
  assert.equal(JSON.stringify(singleCharacterIntroducer).includes("\\"), false);
  assert.equal(JSON.stringify(singleCharacterIntroducer).includes("\\u009A"), false);
  assert.notEqual(JSON.stringify(singleCharacterIntroducer), '"\\u009A"');
  assert.notEqual(JSON.stringify(singleCharacterIntroducer), '"\\u009C"');
  assert.equal(JSON.stringify(singleGraphicCharacterIntroducer), '"' + singleGraphicCharacterIntroducer + '"');
  assert.equal(JSON.stringify(singleGraphicCharacterIntroducer).includes(singleGraphicCharacterIntroducer), true);
  assert.equal(JSON.stringify(singleGraphicCharacterIntroducer).includes("\\"), false);
  assert.equal(JSON.stringify(singleGraphicCharacterIntroducer).includes("\\u0099"), false);
  assert.notEqual(JSON.stringify(singleGraphicCharacterIntroducer), '"\\u0099"');
  assert.notEqual(JSON.stringify(singleGraphicCharacterIntroducer), '"\\u009C"');
  assert.notEqual(JSON.stringify(stringTerminator), JSON.stringify(controlSequenceIntroducer));
  assert.notEqual(JSON.stringify(stringTerminator), JSON.stringify(singleCharacterIntroducer));
  assert.notEqual(JSON.stringify(stringTerminator), JSON.stringify(singleGraphicCharacterIntroducer));

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
  assert.ok(target, "a real item has a legal choice that can take an interior string-terminator character (U+009C)");
  const legal = target.options.find(option => uuid.test(option.id)).id;
  assert.equal(questions.some(question => question.id === target.id), true);
  assert.equal(target.options.some(option => option.id === legal), true);
  assert.equal(uuid.test(legal), true);
  assert.equal(uuid.test(target.id), true);
  assert.equal(legal.length, 36);
  assert.equal(legal.includes(stringTerminator), false);
  assert.equal(legal.includes(controlSequenceIntroducer), false);
  assert.equal(legal.includes(singleCharacterIntroducer), false);
  assert.equal(legal.includes(singleGraphicCharacterIntroducer), false);
  assert.equal(legal.trim(), legal);

  const inserted = insertedInMiddle(legal, stringTerminator);
  const broken = inserted.value;
  const at = inserted.at;
  const controlSequenceIntroducerMiddle = insertedInMiddle(legal, controlSequenceIntroducer).value;
  const singleCharacterIntroducerMiddle = insertedInMiddle(legal, singleCharacterIntroducer).value;
  const singleGraphicCharacterIntroducerMiddle = insertedInMiddle(legal, singleGraphicCharacterIntroducer).value;
  assert.ok(at > 0 && at < legal.length);
  assert.equal(at, 18);
  assert.equal(legal.charCodeAt(at), 0x002D);
  assert.equal(broken.charCodeAt(at), 0x009C);
  assert.equal(broken.charCodeAt(at + 1), 0x002D);
  assert.notEqual(broken.charCodeAt(at), 0x009B);
  assert.notEqual(broken.charCodeAt(at), 0x009A);
  assert.notEqual(broken.charCodeAt(at), 0x0099);
  assert.equal(broken.slice(0, at), legal.slice(0, at));
  assert.equal(broken.slice(at + 1), legal.slice(at));
  assert.equal(broken.length, legal.length + 1);
  assert.notEqual(broken, legal);
  assert.equal(broken.replace(stringTerminator, ""), legal);
  assert.equal([...broken].filter(char => char === stringTerminator).length, 1);
  assert.equal(broken.indexOf(stringTerminator), at);
  assert.equal(broken.startsWith(stringTerminator), false);
  assert.equal(broken.endsWith(stringTerminator), false);
  assert.notEqual(broken, stringTerminator + legal);
  assert.notEqual(broken, legal + stringTerminator);
  assert.notEqual(broken, controlSequenceIntroducerMiddle);
  assert.notEqual(broken, singleCharacterIntroducerMiddle);
  assert.notEqual(broken, singleGraphicCharacterIntroducerMiddle);
  assert.equal(broken.trim(), broken);
  assert.notEqual(broken.trim(), legal);
  assert.notEqual(broken.trim(), "");
  assert.equal((stringTerminator + legal).trim(), stringTerminator + legal);
  assert.notEqual((stringTerminator + legal).trim(), legal);
  assert.equal((legal + stringTerminator).trim(), legal + stringTerminator);
  assert.notEqual((legal + stringTerminator).trim(), legal);
  assert.equal((controlSequenceIntroducer + legal).trim(), controlSequenceIntroducer + legal);
  assert.notEqual((controlSequenceIntroducer + legal).trim(), legal);
  assert.equal((legal + controlSequenceIntroducer).trim(), legal + controlSequenceIntroducer);
  assert.notEqual((legal + controlSequenceIntroducer).trim(), legal);
  assert.equal((singleCharacterIntroducer + legal).trim(), singleCharacterIntroducer + legal);
  assert.notEqual((singleCharacterIntroducer + legal).trim(), legal);
  assert.equal((legal + singleCharacterIntroducer).trim(), legal + singleCharacterIntroducer);
  assert.notEqual((legal + singleCharacterIntroducer).trim(), legal);
  assert.equal((singleGraphicCharacterIntroducer + legal).trim(), singleGraphicCharacterIntroducer + legal);
  assert.notEqual((singleGraphicCharacterIntroducer + legal).trim(), legal);
  assert.equal((legal + singleGraphicCharacterIntroducer).trim(), legal + singleGraphicCharacterIntroducer);
  assert.notEqual((legal + singleGraphicCharacterIntroducer).trim(), legal);
  assert.equal(controlSequenceIntroducerMiddle.trim(), controlSequenceIntroducerMiddle);
  assert.notEqual(controlSequenceIntroducerMiddle.trim(), legal);
  assert.equal(singleCharacterIntroducerMiddle.trim(), singleCharacterIntroducerMiddle);
  assert.notEqual(singleCharacterIntroducerMiddle.trim(), legal);
  assert.equal(singleGraphicCharacterIntroducerMiddle.trim(), singleGraphicCharacterIntroducerMiddle);
  assert.notEqual(singleGraphicCharacterIntroducerMiddle.trim(), legal);
  assert.notEqual(singleGraphicCharacterIntroducerMiddle.trim(), "");
  assert.equal(/\s/.test(broken), false);
  assert.equal(/\s/.test(controlSequenceIntroducerMiddle), false);
  assert.equal(/\s/.test(singleCharacterIntroducerMiddle), false);
  assert.equal(/\s/.test(singleGraphicCharacterIntroducerMiddle), false);
  assert.equal(/\p{Cc}/u.test(broken), true);
  assert.equal(/\p{White_Space}/u.test(broken), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(broken), false);
  assert.equal(/\p{White_Space}/u.test(controlSequenceIntroducerMiddle), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(controlSequenceIntroducerMiddle), false);
  assert.equal(/\p{White_Space}/u.test(singleCharacterIntroducerMiddle), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(singleCharacterIntroducerMiddle), false);
  assert.equal(/\p{White_Space}/u.test(singleGraphicCharacterIntroducerMiddle), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(singleGraphicCharacterIntroducerMiddle), false);
  assert.equal(broken.includes(controlSequenceIntroducer), false);
  assert.equal(broken.includes(singleCharacterIntroducer), false);
  assert.equal(broken.includes(singleGraphicCharacterIntroducer), false);
  assert.equal(controlSequenceIntroducerMiddle.charCodeAt(at), 0x009B);
  assert.equal(controlSequenceIntroducerMiddle.includes(stringTerminator), false);
  assert.equal(controlSequenceIntroducerMiddle.includes(singleCharacterIntroducer), false);
  assert.equal(controlSequenceIntroducerMiddle.includes(singleGraphicCharacterIntroducer), false);
  assert.equal(singleCharacterIntroducerMiddle.charCodeAt(at), 0x009A);
  assert.equal(singleCharacterIntroducerMiddle.includes(stringTerminator), false);
  assert.equal(singleCharacterIntroducerMiddle.includes(controlSequenceIntroducer), false);
  assert.equal(singleCharacterIntroducerMiddle.includes(singleGraphicCharacterIntroducer), false);
  assert.equal(singleGraphicCharacterIntroducerMiddle.charCodeAt(at), 0x0099);
  assert.equal(singleGraphicCharacterIntroducerMiddle.includes(stringTerminator), false);
  assert.equal(singleGraphicCharacterIntroducerMiddle.includes(controlSequenceIntroducer), false);
  assert.equal(singleGraphicCharacterIntroducerMiddle.includes(singleCharacterIntroducer), false);
  assert.equal(uuid.test(broken), false);
  const optionIds = questions.flatMap(question => question.options.map(option => option.id));
  assert.equal(optionIds.includes(legal), true);
  assert.equal(optionIds.includes(broken), false);
  assert.equal(optionIds.includes(controlSequenceIntroducerMiddle), false);
  assert.equal(optionIds.includes(singleCharacterIntroducerMiddle), false);
  assert.equal(optionIds.includes(singleGraphicCharacterIntroducerMiddle), false);
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
  assert.equal(payload.choices[0].charCodeAt(at), 0x009C);
  assert.equal(roundTrip.choices[0], broken);
  assert.equal(roundTrip.choices[0].charCodeAt(at), 0x009C);
  assert.notEqual(roundTrip.choices[0].charCodeAt(at), 0x009B);
  assert.notEqual(roundTrip.choices[0].charCodeAt(at), 0x009A);
  assert.notEqual(roundTrip.choices[0].charCodeAt(at), 0x0099);
  assert.equal(payload.choices[0] === legal, false);
  assert.equal(payload.choices[0] === controlSequenceIntroducerMiddle, false);
  assert.equal(payload.choices[0] === singleCharacterIntroducerMiddle, false);
  assert.equal(payload.choices[0] === singleGraphicCharacterIntroducerMiddle, false);
  assert.equal(raw.includes(stringTerminator), true);
  assert.equal(raw.includes("\\u009C"), false);
  assert.equal(raw.includes(controlSequenceIntroducer), false);
  assert.equal(raw.includes("\\u009B"), false);
  assert.equal(raw.includes(singleCharacterIntroducer), false);
  assert.equal(raw.includes("\\u009A"), false);
  assert.equal(raw.includes(singleGraphicCharacterIntroducer), false);
  assert.equal(raw.includes("\\u0099"), false);
  assert.equal(raw.includes(legal), false);
  assert.equal(JSON.stringify(broken).includes(stringTerminator), true);
  assert.equal(JSON.stringify(broken).includes("\\"), false);
  assert.equal(JSON.stringify(broken).includes("\\u009C"), false);
  assert.equal(JSON.stringify(broken).includes("\\u009B"), false);
  assert.equal(JSON.stringify(broken).includes("\\u009A"), false);
  assert.equal(JSON.stringify(broken).includes("\\u0099"), false);
  assert.equal(JSON.stringify(controlSequenceIntroducerMiddle).includes(controlSequenceIntroducer), true);
  assert.equal(JSON.stringify(controlSequenceIntroducerMiddle).includes("\\"), false);
  assert.equal(JSON.stringify(controlSequenceIntroducerMiddle).includes("\\u009B"), false);
  assert.equal(JSON.stringify(controlSequenceIntroducerMiddle).includes("\\u009C"), false);
  assert.equal(JSON.stringify(controlSequenceIntroducerMiddle).includes(stringTerminator), false);
  assert.equal(JSON.stringify(singleCharacterIntroducerMiddle).includes(singleCharacterIntroducer), true);
  assert.equal(JSON.stringify(singleCharacterIntroducerMiddle).includes("\\"), false);
  assert.equal(JSON.stringify(singleCharacterIntroducerMiddle).includes("\\u009A"), false);
  assert.equal(JSON.stringify(singleCharacterIntroducerMiddle).includes("\\u009C"), false);
  assert.equal(JSON.stringify(singleCharacterIntroducerMiddle).includes(stringTerminator), false);
  assert.equal(JSON.stringify(singleGraphicCharacterIntroducerMiddle).includes(singleGraphicCharacterIntroducer), true);
  assert.equal(JSON.stringify(singleGraphicCharacterIntroducerMiddle).includes("\\"), false);
  assert.equal(JSON.stringify(singleGraphicCharacterIntroducerMiddle).includes("\\u0099"), false);
  assert.equal(JSON.stringify(singleGraphicCharacterIntroducerMiddle).includes("\\u009C"), false);
  assert.equal(JSON.stringify(singleGraphicCharacterIntroducerMiddle).includes(stringTerminator), false);
  assert.notEqual(JSON.stringify(broken), JSON.stringify(controlSequenceIntroducerMiddle));
  assert.notEqual(JSON.stringify(broken), JSON.stringify(singleCharacterIntroducerMiddle));
  assert.notEqual(JSON.stringify(broken), JSON.stringify(singleGraphicCharacterIntroducerMiddle));
  f.resetWrites();
  const refused = await read(await f.req("/api/answers", "PUT", payload, { cookie }));
  assert.equal(refused.status, 422, JSON.stringify(refused.body));
  assert.equal(refused.body.error, "Choose an available answer.");
  assert.equal(refused.headers.get("Set-Cookie"), null);
  assert.equal(refused.text.includes(secret), false);
  assert.equal(refused.text.includes(sessionSecret), false);
  assert.equal(refused.text.includes(broken), false);
  assert.equal(refused.text.includes(stringTerminator), false);
  assert.equal(refused.text.includes("\\u009C"), false);
  assert.equal(refused.text.includes(controlSequenceIntroducer), false);
  assert.equal(refused.text.includes("\\u009B"), false);
  assert.equal(refused.text.includes(singleCharacterIntroducer), false);
  assert.equal(refused.text.includes("\\u009A"), false);
  assert.equal(refused.text.includes(singleGraphicCharacterIntroducer), false);
  assert.equal(refused.text.includes("\\u0099"), false);
  assert.equal(refused.text.includes(legal), false);
  assert.deepEqual(f.written, []);

  const after = stored(f, reference);
  assert.deepEqual(after, snapshot);
  assert.deepEqual(after.answers, {});
  assert.equal(Object.hasOwn(after.answers, target.id), false);
  assert.equal(JSON.stringify(after.answers).includes(stringTerminator), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u009C"), false);
  assert.equal(JSON.stringify(after.answers).includes(controlSequenceIntroducer), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u009B"), false);
  assert.equal(JSON.stringify(after.answers).includes(singleCharacterIntroducer), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u009A"), false);
  assert.equal(JSON.stringify(after.answers).includes(singleGraphicCharacterIntroducer), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u0099"), false);
  assert.equal(JSON.stringify(after.answers).includes(legal), false);
  assert.equal(JSON.stringify(after).includes(stringTerminator), false);
  assert.equal(JSON.stringify(after).includes("\\u009C"), false);
  assert.equal(JSON.stringify(after).includes(controlSequenceIntroducer), false);
  assert.equal(JSON.stringify(after).includes("\\u009B"), false);
  assert.equal(JSON.stringify(after).includes(singleCharacterIntroducer), false);
  assert.equal(JSON.stringify(after).includes("\\u009A"), false);
  assert.equal(JSON.stringify(after).includes(singleGraphicCharacterIntroducer), false);
  assert.equal(JSON.stringify(after).includes("\\u0099"), false);
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
  assert.equal(viewed.text.includes(stringTerminator), false);
  assert.equal(viewed.text.includes("\\u009C"), false);
  assert.equal(viewed.text.includes(controlSequenceIntroducer), false);
  assert.equal(viewed.text.includes("\\u009B"), false);
  assert.equal(viewed.text.includes(singleCharacterIntroducer), false);
  assert.equal(viewed.text.includes("\\u009A"), false);
  assert.equal(viewed.text.includes(singleGraphicCharacterIntroducer), false);
  assert.equal(viewed.text.includes("\\u0099"), false);
  assert.equal(f.records.get(reference).etag, openedEtag);
  assert.equal(stored(f, reference).inviteHash, inviteHash);
  assert.equal(stored(f, reference).sessionHash, sessionHash);
  assert.deepEqual(stored(f, reference).answers, {});
});
