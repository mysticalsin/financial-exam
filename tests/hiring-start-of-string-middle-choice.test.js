import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import worker, { Assessment } from "../src/worker.js";

// One live hiring sitting. Save an answer for a real item on this paper
// whose choice id is that item's legal choice string with a
// start-of-string character (U+0098) inserted in the middle.
// The save is refused. No answer is stored. The invite hash and the
// session secret stay unchanged.
// An end-of-guarded-area character in the middle, a
// start-of-guarded-area character in the middle, and a
// message-waiting character in the middle are separate checks.

const origin = "https://assessment.example";
const notice = {
  controller: "Test controller", contact: "privacy@example.invalid", basis: "Test basis",
  recipients: "Test reviewer", transfers: "Test transfer description", rights: "Test rights",
  purpose: "Test purpose", supervisoryAuthority: "Test authority", version: "test-1", retentionMinutes: 30,
};
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const random = () => crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
const startOfString = "\u0098";
const endOfGuardedArea = "\u0097";
const startOfGuardedArea = "\u0096";
const messageWaiting = "\u0095";

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

test("a legal choice with a start-of-string character inserted in the middle is refused and stores nothing", async () => {
  const source = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(source, /"LIVE_ENABLED": "false"/);
  assert.equal(startOfString, "\u0098");
  assert.equal(startOfString.charCodeAt(0), 0x0098);
  assert.equal(startOfString.codePointAt(0), 0x0098);
  assert.equal(startOfString.length, 1);
  assert.notEqual(startOfString, endOfGuardedArea);
  assert.notEqual(startOfString.charCodeAt(0), 0x0097);
  assert.notEqual(startOfString, startOfGuardedArea);
  assert.notEqual(startOfString.charCodeAt(0), 0x0096);
  assert.notEqual(startOfString, messageWaiting);
  assert.notEqual(startOfString.charCodeAt(0), 0x0095);
  assert.equal(endOfGuardedArea, "\u0097");
  assert.equal(endOfGuardedArea.charCodeAt(0), 0x0097);
  assert.equal(endOfGuardedArea.codePointAt(0), 0x0097);
  assert.equal(endOfGuardedArea.length, 1);
  assert.equal(startOfGuardedArea, "\u0096");
  assert.equal(startOfGuardedArea.charCodeAt(0), 0x0096);
  assert.equal(startOfGuardedArea.codePointAt(0), 0x0096);
  assert.equal(startOfGuardedArea.length, 1);
  assert.equal(messageWaiting, "\u0095");
  assert.equal(messageWaiting.charCodeAt(0), 0x0095);
  assert.equal(messageWaiting.codePointAt(0), 0x0095);
  assert.equal(messageWaiting.length, 1);
  assert.equal(/\s/.test(startOfString), false);
  assert.equal(/\s/.test(endOfGuardedArea), false);
  assert.equal(/\s/.test(startOfGuardedArea), false);
  assert.equal(/\s/.test(messageWaiting), false);
  assert.equal(/\p{Cc}/u.test(startOfString), true);
  assert.equal(/\p{Cf}/u.test(startOfString), false);
  assert.equal(/\p{Zl}/u.test(startOfString), false);
  assert.equal(/\p{Zp}/u.test(startOfString), false);
  assert.equal(/\p{Zs}/u.test(startOfString), false);
  assert.equal(/\p{White_Space}/u.test(startOfString), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(startOfString), false);
  assert.equal(/\p{Cc}/u.test(endOfGuardedArea), true);
  assert.equal(/\p{Cf}/u.test(endOfGuardedArea), false);
  assert.equal(/\p{White_Space}/u.test(endOfGuardedArea), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(endOfGuardedArea), false);
  assert.equal(/\p{Cc}/u.test(startOfGuardedArea), true);
  assert.equal(/\p{Cf}/u.test(startOfGuardedArea), false);
  assert.equal(/\p{White_Space}/u.test(startOfGuardedArea), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(startOfGuardedArea), false);
  assert.equal(/\p{Cc}/u.test(messageWaiting), true);
  assert.equal(/\p{Cf}/u.test(messageWaiting), false);
  assert.equal(/\p{White_Space}/u.test(messageWaiting), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(messageWaiting), false);
  assert.equal(startOfString.trim(), startOfString);
  assert.notEqual(startOfString.trim(), "");
  assert.equal(endOfGuardedArea.trim(), endOfGuardedArea);
  assert.notEqual(endOfGuardedArea.trim(), "");
  assert.equal(startOfGuardedArea.trim(), startOfGuardedArea);
  assert.notEqual(startOfGuardedArea.trim(), "");
  assert.equal(messageWaiting.trim(), messageWaiting);
  assert.notEqual(messageWaiting.trim(), "");
  assert.equal(JSON.stringify(startOfString), '"' + startOfString + '"');
  assert.equal(JSON.stringify(startOfString).includes(startOfString), true);
  assert.equal(JSON.stringify(startOfString).includes("\\"), false);
  assert.equal(JSON.stringify(startOfString).includes("\\u0098"), false);
  assert.notEqual(JSON.stringify(startOfString), '"\\u0098"');
  assert.equal(JSON.stringify(endOfGuardedArea), '"' + endOfGuardedArea + '"');
  assert.equal(JSON.stringify(endOfGuardedArea).includes(endOfGuardedArea), true);
  assert.equal(JSON.stringify(endOfGuardedArea).includes("\\"), false);
  assert.equal(JSON.stringify(endOfGuardedArea).includes("\\u0097"), false);
  assert.notEqual(JSON.stringify(endOfGuardedArea), '"\\u0097"');
  assert.notEqual(JSON.stringify(endOfGuardedArea), '"\\u0098"');
  assert.equal(JSON.stringify(startOfGuardedArea), '"' + startOfGuardedArea + '"');
  assert.equal(JSON.stringify(startOfGuardedArea).includes(startOfGuardedArea), true);
  assert.equal(JSON.stringify(startOfGuardedArea).includes("\\"), false);
  assert.equal(JSON.stringify(startOfGuardedArea).includes("\\u0096"), false);
  assert.notEqual(JSON.stringify(startOfGuardedArea), '"\\u0096"');
  assert.notEqual(JSON.stringify(startOfGuardedArea), '"\\u0098"');
  assert.equal(JSON.stringify(messageWaiting), '"' + messageWaiting + '"');
  assert.equal(JSON.stringify(messageWaiting).includes(messageWaiting), true);
  assert.equal(JSON.stringify(messageWaiting).includes("\\"), false);
  assert.equal(JSON.stringify(messageWaiting).includes("\\u0095"), false);
  assert.notEqual(JSON.stringify(messageWaiting), '"\\u0095"');
  assert.notEqual(JSON.stringify(messageWaiting), '"\\u0098"');
  assert.notEqual(JSON.stringify(startOfString), JSON.stringify(endOfGuardedArea));
  assert.notEqual(JSON.stringify(startOfString), JSON.stringify(startOfGuardedArea));
  assert.notEqual(JSON.stringify(startOfString), JSON.stringify(messageWaiting));

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
  assert.ok(target, "a real item has a legal choice that can take an interior start-of-string character");
  const legal = target.options.find(option => uuid.test(option.id)).id;
  assert.equal(questions.some(question => question.id === target.id), true);
  assert.equal(target.options.some(option => option.id === legal), true);
  assert.equal(uuid.test(legal), true);
  assert.equal(uuid.test(target.id), true);
  assert.equal(legal.length, 36);
  assert.equal(legal.includes(startOfString), false);
  assert.equal(legal.includes(endOfGuardedArea), false);
  assert.equal(legal.includes(startOfGuardedArea), false);
  assert.equal(legal.includes(messageWaiting), false);
  assert.equal(legal.trim(), legal);

  const inserted = insertedInMiddle(legal, startOfString);
  const broken = inserted.value;
  const at = inserted.at;
  const endOfGuardedAreaMiddle = insertedInMiddle(legal, endOfGuardedArea).value;
  const startOfGuardedAreaMiddle = insertedInMiddle(legal, startOfGuardedArea).value;
  const messageWaitingMiddle = insertedInMiddle(legal, messageWaiting).value;
  assert.ok(at > 0 && at < legal.length);
  assert.equal(at, 18);
  assert.equal(legal.charCodeAt(at), 0x002D);
  assert.equal(broken.charCodeAt(at), 0x0098);
  assert.equal(broken.charCodeAt(at + 1), 0x002D);
  assert.notEqual(broken.charCodeAt(at), 0x0097);
  assert.notEqual(broken.charCodeAt(at), 0x0096);
  assert.notEqual(broken.charCodeAt(at), 0x0095);
  assert.equal(broken.slice(0, at), legal.slice(0, at));
  assert.equal(broken.slice(at + 1), legal.slice(at));
  assert.equal(broken.length, legal.length + 1);
  assert.notEqual(broken, legal);
  assert.equal(broken.replace(startOfString, ""), legal);
  assert.equal([...broken].filter(char => char === startOfString).length, 1);
  assert.equal(broken.indexOf(startOfString), at);
  assert.equal(broken.startsWith(startOfString), false);
  assert.equal(broken.endsWith(startOfString), false);
  assert.notEqual(broken, startOfString + legal);
  assert.notEqual(broken, legal + startOfString);
  assert.notEqual(broken, endOfGuardedAreaMiddle);
  assert.notEqual(broken, startOfGuardedAreaMiddle);
  assert.notEqual(broken, messageWaitingMiddle);
  assert.equal(broken.trim(), broken);
  assert.notEqual(broken.trim(), legal);
  assert.notEqual(broken.trim(), "");
  assert.equal((startOfString + legal).trim(), startOfString + legal);
  assert.notEqual((startOfString + legal).trim(), legal);
  assert.equal((legal + startOfString).trim(), legal + startOfString);
  assert.notEqual((legal + startOfString).trim(), legal);
  assert.equal((endOfGuardedArea + legal).trim(), endOfGuardedArea + legal);
  assert.notEqual((endOfGuardedArea + legal).trim(), legal);
  assert.equal((legal + endOfGuardedArea).trim(), legal + endOfGuardedArea);
  assert.notEqual((legal + endOfGuardedArea).trim(), legal);
  assert.equal((startOfGuardedArea + legal).trim(), startOfGuardedArea + legal);
  assert.notEqual((startOfGuardedArea + legal).trim(), legal);
  assert.equal((legal + startOfGuardedArea).trim(), legal + startOfGuardedArea);
  assert.notEqual((legal + startOfGuardedArea).trim(), legal);
  assert.equal((messageWaiting + legal).trim(), messageWaiting + legal);
  assert.notEqual((messageWaiting + legal).trim(), legal);
  assert.equal((legal + messageWaiting).trim(), legal + messageWaiting);
  assert.notEqual((legal + messageWaiting).trim(), legal);
  assert.equal(endOfGuardedAreaMiddle.trim(), endOfGuardedAreaMiddle);
  assert.notEqual(endOfGuardedAreaMiddle.trim(), legal);
  assert.equal(startOfGuardedAreaMiddle.trim(), startOfGuardedAreaMiddle);
  assert.notEqual(startOfGuardedAreaMiddle.trim(), legal);
  assert.equal(messageWaitingMiddle.trim(), messageWaitingMiddle);
  assert.notEqual(messageWaitingMiddle.trim(), legal);
  assert.notEqual(messageWaitingMiddle.trim(), "");
  assert.equal(/\s/.test(broken), false);
  assert.equal(/\s/.test(endOfGuardedAreaMiddle), false);
  assert.equal(/\s/.test(startOfGuardedAreaMiddle), false);
  assert.equal(/\s/.test(messageWaitingMiddle), false);
  assert.equal(/\p{Cc}/u.test(broken), true);
  assert.equal(/\p{White_Space}/u.test(broken), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(broken), false);
  assert.equal(/\p{White_Space}/u.test(endOfGuardedAreaMiddle), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(endOfGuardedAreaMiddle), false);
  assert.equal(/\p{White_Space}/u.test(startOfGuardedAreaMiddle), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(startOfGuardedAreaMiddle), false);
  assert.equal(/\p{White_Space}/u.test(messageWaitingMiddle), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(messageWaitingMiddle), false);
  assert.equal(broken.includes(endOfGuardedArea), false);
  assert.equal(broken.includes(startOfGuardedArea), false);
  assert.equal(broken.includes(messageWaiting), false);
  assert.equal(endOfGuardedAreaMiddle.charCodeAt(at), 0x0097);
  assert.equal(endOfGuardedAreaMiddle.includes(startOfString), false);
  assert.equal(endOfGuardedAreaMiddle.includes(startOfGuardedArea), false);
  assert.equal(endOfGuardedAreaMiddle.includes(messageWaiting), false);
  assert.equal(startOfGuardedAreaMiddle.charCodeAt(at), 0x0096);
  assert.equal(startOfGuardedAreaMiddle.includes(startOfString), false);
  assert.equal(startOfGuardedAreaMiddle.includes(endOfGuardedArea), false);
  assert.equal(startOfGuardedAreaMiddle.includes(messageWaiting), false);
  assert.equal(messageWaitingMiddle.charCodeAt(at), 0x0095);
  assert.equal(messageWaitingMiddle.includes(startOfString), false);
  assert.equal(messageWaitingMiddle.includes(endOfGuardedArea), false);
  assert.equal(messageWaitingMiddle.includes(startOfGuardedArea), false);
  assert.equal(uuid.test(broken), false);
  const optionIds = questions.flatMap(question => question.options.map(option => option.id));
  assert.equal(optionIds.includes(legal), true);
  assert.equal(optionIds.includes(broken), false);
  assert.equal(optionIds.includes(endOfGuardedAreaMiddle), false);
  assert.equal(optionIds.includes(startOfGuardedAreaMiddle), false);
  assert.equal(optionIds.includes(messageWaitingMiddle), false);
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
  assert.equal(payload.choices[0].charCodeAt(at), 0x0098);
  assert.equal(roundTrip.choices[0], broken);
  assert.equal(roundTrip.choices[0].charCodeAt(at), 0x0098);
  assert.notEqual(roundTrip.choices[0].charCodeAt(at), 0x0097);
  assert.notEqual(roundTrip.choices[0].charCodeAt(at), 0x0096);
  assert.notEqual(roundTrip.choices[0].charCodeAt(at), 0x0095);
  assert.equal(payload.choices[0] === legal, false);
  assert.equal(payload.choices[0] === endOfGuardedAreaMiddle, false);
  assert.equal(payload.choices[0] === startOfGuardedAreaMiddle, false);
  assert.equal(payload.choices[0] === messageWaitingMiddle, false);
  assert.equal(raw.includes(startOfString), true);
  assert.equal(raw.includes("\\u0098"), false);
  assert.equal(raw.includes(endOfGuardedArea), false);
  assert.equal(raw.includes("\\u0097"), false);
  assert.equal(raw.includes(startOfGuardedArea), false);
  assert.equal(raw.includes("\\u0096"), false);
  assert.equal(raw.includes(messageWaiting), false);
  assert.equal(raw.includes("\\u0095"), false);
  assert.equal(raw.includes(legal), false);
  assert.equal(JSON.stringify(broken).includes(startOfString), true);
  assert.equal(JSON.stringify(broken).includes("\\"), false);
  assert.equal(JSON.stringify(broken).includes("\\u0098"), false);
  assert.equal(JSON.stringify(broken).includes("\\u0097"), false);
  assert.equal(JSON.stringify(broken).includes("\\u0096"), false);
  assert.equal(JSON.stringify(broken).includes("\\u0095"), false);
  assert.equal(JSON.stringify(endOfGuardedAreaMiddle).includes(endOfGuardedArea), true);
  assert.equal(JSON.stringify(endOfGuardedAreaMiddle).includes("\\"), false);
  assert.equal(JSON.stringify(endOfGuardedAreaMiddle).includes("\\u0097"), false);
  assert.equal(JSON.stringify(endOfGuardedAreaMiddle).includes("\\u0098"), false);
  assert.equal(JSON.stringify(endOfGuardedAreaMiddle).includes(startOfString), false);
  assert.equal(JSON.stringify(startOfGuardedAreaMiddle).includes(startOfGuardedArea), true);
  assert.equal(JSON.stringify(startOfGuardedAreaMiddle).includes("\\"), false);
  assert.equal(JSON.stringify(startOfGuardedAreaMiddle).includes("\\u0096"), false);
  assert.equal(JSON.stringify(startOfGuardedAreaMiddle).includes("\\u0098"), false);
  assert.equal(JSON.stringify(startOfGuardedAreaMiddle).includes(startOfString), false);
  assert.equal(JSON.stringify(messageWaitingMiddle).includes(messageWaiting), true);
  assert.equal(JSON.stringify(messageWaitingMiddle).includes("\\"), false);
  assert.equal(JSON.stringify(messageWaitingMiddle).includes("\\u0095"), false);
  assert.equal(JSON.stringify(messageWaitingMiddle).includes("\\u0098"), false);
  assert.equal(JSON.stringify(messageWaitingMiddle).includes(startOfString), false);
  assert.notEqual(JSON.stringify(broken), JSON.stringify(endOfGuardedAreaMiddle));
  assert.notEqual(JSON.stringify(broken), JSON.stringify(startOfGuardedAreaMiddle));
  assert.notEqual(JSON.stringify(broken), JSON.stringify(messageWaitingMiddle));
  f.resetWrites();
  const refused = await read(await f.req("/api/answers", "PUT", payload, { cookie }));
  assert.equal(refused.status, 422, JSON.stringify(refused.body));
  assert.equal(refused.body.error, "Choose an available answer.");
  assert.equal(refused.headers.get("Set-Cookie"), null);
  assert.equal(refused.text.includes(secret), false);
  assert.equal(refused.text.includes(sessionSecret), false);
  assert.equal(refused.text.includes(broken), false);
  assert.equal(refused.text.includes(startOfString), false);
  assert.equal(refused.text.includes("\\u0098"), false);
  assert.equal(refused.text.includes(endOfGuardedArea), false);
  assert.equal(refused.text.includes("\\u0097"), false);
  assert.equal(refused.text.includes(startOfGuardedArea), false);
  assert.equal(refused.text.includes("\\u0096"), false);
  assert.equal(refused.text.includes(messageWaiting), false);
  assert.equal(refused.text.includes("\\u0095"), false);
  assert.equal(refused.text.includes(legal), false);
  assert.deepEqual(f.written, []);

  const after = stored(f, reference);
  assert.deepEqual(after, snapshot);
  assert.deepEqual(after.answers, {});
  assert.equal(Object.hasOwn(after.answers, target.id), false);
  assert.equal(JSON.stringify(after.answers).includes(startOfString), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u0098"), false);
  assert.equal(JSON.stringify(after.answers).includes(endOfGuardedArea), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u0097"), false);
  assert.equal(JSON.stringify(after.answers).includes(startOfGuardedArea), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u0096"), false);
  assert.equal(JSON.stringify(after.answers).includes(messageWaiting), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u0095"), false);
  assert.equal(JSON.stringify(after.answers).includes(legal), false);
  assert.equal(JSON.stringify(after).includes(startOfString), false);
  assert.equal(JSON.stringify(after).includes("\\u0098"), false);
  assert.equal(JSON.stringify(after).includes(endOfGuardedArea), false);
  assert.equal(JSON.stringify(after).includes("\\u0097"), false);
  assert.equal(JSON.stringify(after).includes(startOfGuardedArea), false);
  assert.equal(JSON.stringify(after).includes("\\u0096"), false);
  assert.equal(JSON.stringify(after).includes(messageWaiting), false);
  assert.equal(JSON.stringify(after).includes("\\u0095"), false);
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
  assert.equal(viewed.text.includes(startOfString), false);
  assert.equal(viewed.text.includes("\\u0098"), false);
  assert.equal(viewed.text.includes(endOfGuardedArea), false);
  assert.equal(viewed.text.includes("\\u0097"), false);
  assert.equal(viewed.text.includes(startOfGuardedArea), false);
  assert.equal(viewed.text.includes("\\u0096"), false);
  assert.equal(viewed.text.includes(messageWaiting), false);
  assert.equal(viewed.text.includes("\\u0095"), false);
  assert.equal(f.records.get(reference).etag, openedEtag);
  assert.equal(stored(f, reference).inviteHash, inviteHash);
  assert.equal(stored(f, reference).sessionHash, sessionHash);
  assert.deepEqual(stored(f, reference).answers, {});
});
