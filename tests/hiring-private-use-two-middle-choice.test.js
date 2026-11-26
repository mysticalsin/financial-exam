import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import worker, { Assessment } from "../src/worker.js";

// One live hiring sitting. Save an answer for a real item on this paper
// whose choice id is that item's legal choice string with a
// private-use-two character (U+0092) inserted in the middle.
// The save is refused. No answer is stored. The invite hash and the
// session secret stay unchanged.
// A private-use-one character in the middle, a
// device-control-string character in the middle, and a
// single-shift-three character in the middle are separate checks.

const origin = "https://assessment.example";
const notice = {
  controller: "Test controller", contact: "privacy@example.invalid", basis: "Test basis",
  recipients: "Test reviewer", transfers: "Test transfer description", rights: "Test rights",
  purpose: "Test purpose", supervisoryAuthority: "Test authority", version: "test-1", retentionMinutes: 30,
};
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const random = () => crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
const privateUseTwo = "\u0092";
const privateUseOne = "\u0091";
const deviceControlString = "\u0090";
const singleShiftThree = "\u008f";

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

test("a legal choice with a private-use-two character inserted in the middle is refused and stores nothing", async () => {
  const source = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(source, /"LIVE_ENABLED": "false"/);
  assert.equal(privateUseTwo, "\u0092");
  assert.equal(privateUseTwo.charCodeAt(0), 0x0092);
  assert.equal(privateUseTwo.codePointAt(0), 0x0092);
  assert.equal(privateUseTwo.length, 1);
  assert.notEqual(privateUseTwo, deviceControlString);
  assert.notEqual(privateUseTwo.charCodeAt(0), 0x0090);
  assert.notEqual(privateUseTwo, singleShiftThree);
  assert.notEqual(privateUseTwo.charCodeAt(0), 0x008f);
  assert.notEqual(privateUseTwo, privateUseOne);
  assert.notEqual(privateUseTwo.charCodeAt(0), 0x0091);
  assert.equal(privateUseOne, "\u0091");
  assert.equal(privateUseOne.charCodeAt(0), 0x0091);
  assert.equal(privateUseOne.codePointAt(0), 0x0091);
  assert.equal(privateUseOne.length, 1);
  assert.equal(singleShiftThree, "\u008f");
  assert.equal(singleShiftThree.charCodeAt(0), 0x008f);
  assert.equal(singleShiftThree.codePointAt(0), 0x008f);
  assert.equal(singleShiftThree.length, 1);
  assert.equal(deviceControlString, "\u0090");
  assert.equal(deviceControlString.charCodeAt(0), 0x0090);
  assert.equal(deviceControlString.codePointAt(0), 0x0090);
  assert.equal(deviceControlString.length, 1);
  assert.equal(/\s/.test(privateUseTwo), false);
  assert.equal(/\s/.test(privateUseOne), false);
  assert.equal(/\s/.test(singleShiftThree), false);
  assert.equal(/\s/.test(deviceControlString), false);
  assert.equal(/\p{Cc}/u.test(privateUseTwo), true);
  assert.equal(/\p{Cf}/u.test(privateUseTwo), false);
  assert.equal(/\p{Zl}/u.test(privateUseTwo), false);
  assert.equal(/\p{Zp}/u.test(privateUseTwo), false);
  assert.equal(/\p{Zs}/u.test(privateUseTwo), false);
  assert.equal(/\p{White_Space}/u.test(privateUseTwo), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(privateUseTwo), false);
  assert.equal(/\p{Cc}/u.test(privateUseOne), true);
  assert.equal(/\p{Cf}/u.test(privateUseOne), false);
  assert.equal(/\p{White_Space}/u.test(privateUseOne), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(privateUseOne), false);
  assert.equal(/\p{Cc}/u.test(singleShiftThree), true);
  assert.equal(/\p{Cf}/u.test(singleShiftThree), false);
  assert.equal(/\p{White_Space}/u.test(singleShiftThree), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(singleShiftThree), false);
  assert.equal(/\p{Cc}/u.test(deviceControlString), true);
  assert.equal(/\p{Cf}/u.test(deviceControlString), false);
  assert.equal(/\p{White_Space}/u.test(deviceControlString), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(deviceControlString), false);
  assert.equal(privateUseTwo.trim(), privateUseTwo);
  assert.notEqual(privateUseTwo.trim(), "");
  assert.equal(privateUseOne.trim(), privateUseOne);
  assert.notEqual(privateUseOne.trim(), "");
  assert.equal(singleShiftThree.trim(), singleShiftThree);
  assert.notEqual(singleShiftThree.trim(), "");
  assert.equal(deviceControlString.trim(), deviceControlString);
  assert.notEqual(deviceControlString.trim(), "");
  assert.equal(JSON.stringify(privateUseTwo), '"' + privateUseTwo + '"');
  assert.equal(JSON.stringify(privateUseTwo).includes(privateUseTwo), true);
  assert.equal(JSON.stringify(privateUseTwo).includes("\\"), false);
  assert.equal(JSON.stringify(privateUseTwo).includes("\\u0092"), false);
  assert.notEqual(JSON.stringify(privateUseTwo), '"\\u0092"');
  assert.equal(JSON.stringify(privateUseOne), '"' + privateUseOne + '"');
  assert.equal(JSON.stringify(privateUseOne).includes(privateUseOne), true);
  assert.equal(JSON.stringify(privateUseOne).includes("\\"), false);
  assert.equal(JSON.stringify(privateUseOne).includes("\\u0091"), false);
  assert.notEqual(JSON.stringify(privateUseOne), '"\\u0091"');
  assert.notEqual(JSON.stringify(privateUseOne), '"\\u0092"');
  assert.equal(JSON.stringify(singleShiftThree), '"' + singleShiftThree + '"');
  assert.equal(JSON.stringify(singleShiftThree).includes(singleShiftThree), true);
  assert.equal(JSON.stringify(singleShiftThree).includes("\\"), false);
  assert.equal(JSON.stringify(singleShiftThree).includes("\\u008f"), false);
  assert.notEqual(JSON.stringify(singleShiftThree), '"\\u008f"');
  assert.notEqual(JSON.stringify(singleShiftThree), '"\\u0092"');
  assert.equal(JSON.stringify(deviceControlString), '"' + deviceControlString + '"');
  assert.equal(JSON.stringify(deviceControlString).includes(deviceControlString), true);
  assert.equal(JSON.stringify(deviceControlString).includes("\\"), false);
  assert.equal(JSON.stringify(deviceControlString).includes("\\u0090"), false);
  assert.notEqual(JSON.stringify(deviceControlString), '"\\u0090"');
  assert.notEqual(JSON.stringify(deviceControlString), '"\\u0092"');
  assert.notEqual(JSON.stringify(privateUseTwo), JSON.stringify(privateUseOne));
  assert.notEqual(JSON.stringify(privateUseTwo), JSON.stringify(singleShiftThree));
  assert.notEqual(JSON.stringify(privateUseTwo), JSON.stringify(deviceControlString));

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
  assert.ok(target, "a real item has a legal choice that can take an interior private-use-two character");
  const legal = target.options.find(option => uuid.test(option.id)).id;
  assert.equal(questions.some(question => question.id === target.id), true);
  assert.equal(target.options.some(option => option.id === legal), true);
  assert.equal(uuid.test(legal), true);
  assert.equal(uuid.test(target.id), true);
  assert.equal(legal.length, 36);
  assert.equal(legal.includes(privateUseTwo), false);
  assert.equal(legal.includes(privateUseOne), false);
  assert.equal(legal.includes(singleShiftThree), false);
  assert.equal(legal.includes(deviceControlString), false);
  assert.equal(legal.trim(), legal);

  const inserted = insertedInMiddle(legal, privateUseTwo);
  const broken = inserted.value;
  const at = inserted.at;
  const privateUseOneMiddle = insertedInMiddle(legal, privateUseOne).value;
  const singleShiftThreeMiddle = insertedInMiddle(legal, singleShiftThree).value;
  const deviceControlStringMiddle = insertedInMiddle(legal, deviceControlString).value;
  assert.ok(at > 0 && at < legal.length);
  assert.equal(at, 18);
  assert.equal(legal.charCodeAt(at), 0x002D);
  assert.equal(broken.charCodeAt(at), 0x0092);
  assert.equal(broken.charCodeAt(at + 1), 0x002D);
  assert.notEqual(broken.charCodeAt(at), 0x0090);
  assert.notEqual(broken.charCodeAt(at), 0x008f);
  assert.notEqual(broken.charCodeAt(at), 0x0091);
  assert.equal(broken.slice(0, at), legal.slice(0, at));
  assert.equal(broken.slice(at + 1), legal.slice(at));
  assert.equal(broken.length, legal.length + 1);
  assert.notEqual(broken, legal);
  assert.equal(broken.replace(privateUseTwo, ""), legal);
  assert.equal([...broken].filter(char => char === privateUseTwo).length, 1);
  assert.equal(broken.indexOf(privateUseTwo), at);
  assert.equal(broken.startsWith(privateUseTwo), false);
  assert.equal(broken.endsWith(privateUseTwo), false);
  assert.notEqual(broken, privateUseTwo + legal);
  assert.notEqual(broken, legal + privateUseTwo);
  assert.notEqual(broken, privateUseOneMiddle);
  assert.notEqual(broken, singleShiftThreeMiddle);
  assert.notEqual(broken, deviceControlStringMiddle);
  assert.equal(broken.trim(), broken);
  assert.notEqual(broken.trim(), legal);
  assert.notEqual(broken.trim(), "");
  assert.equal((privateUseTwo + legal).trim(), privateUseTwo + legal);
  assert.notEqual((privateUseTwo + legal).trim(), legal);
  assert.equal((legal + privateUseTwo).trim(), legal + privateUseTwo);
  assert.notEqual((legal + privateUseTwo).trim(), legal);
  assert.equal((privateUseOne + legal).trim(), privateUseOne + legal);
  assert.notEqual((privateUseOne + legal).trim(), legal);
  assert.equal((legal + privateUseOne).trim(), legal + privateUseOne);
  assert.notEqual((legal + privateUseOne).trim(), legal);
  assert.equal((singleShiftThree + legal).trim(), singleShiftThree + legal);
  assert.notEqual((singleShiftThree + legal).trim(), legal);
  assert.equal((legal + singleShiftThree).trim(), legal + singleShiftThree);
  assert.notEqual((legal + singleShiftThree).trim(), legal);
  assert.equal((deviceControlString + legal).trim(), deviceControlString + legal);
  assert.notEqual((deviceControlString + legal).trim(), legal);
  assert.equal((legal + deviceControlString).trim(), legal + deviceControlString);
  assert.notEqual((legal + deviceControlString).trim(), legal);
  assert.equal(privateUseOneMiddle.trim(), privateUseOneMiddle);
  assert.notEqual(privateUseOneMiddle.trim(), legal);
  assert.equal(singleShiftThreeMiddle.trim(), singleShiftThreeMiddle);
  assert.notEqual(singleShiftThreeMiddle.trim(), legal);
  assert.equal(deviceControlStringMiddle.trim(), deviceControlStringMiddle);
  assert.notEqual(deviceControlStringMiddle.trim(), legal);
  assert.notEqual(deviceControlStringMiddle.trim(), "");
  assert.equal(/\s/.test(broken), false);
  assert.equal(/\s/.test(privateUseOneMiddle), false);
  assert.equal(/\s/.test(singleShiftThreeMiddle), false);
  assert.equal(/\s/.test(deviceControlStringMiddle), false);
  assert.equal(/\p{Cc}/u.test(broken), true);
  assert.equal(/\p{White_Space}/u.test(broken), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(broken), false);
  assert.equal(/\p{White_Space}/u.test(privateUseOneMiddle), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(privateUseOneMiddle), false);
  assert.equal(/\p{White_Space}/u.test(singleShiftThreeMiddle), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(singleShiftThreeMiddle), false);
  assert.equal(/\p{White_Space}/u.test(deviceControlStringMiddle), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(deviceControlStringMiddle), false);
  assert.equal(broken.includes(privateUseOne), false);
  assert.equal(broken.includes(singleShiftThree), false);
  assert.equal(broken.includes(deviceControlString), false);
  assert.equal(privateUseOneMiddle.charCodeAt(at), 0x0091);
  assert.equal(privateUseOneMiddle.includes(privateUseTwo), false);
  assert.equal(privateUseOneMiddle.includes(singleShiftThree), false);
  assert.equal(privateUseOneMiddle.includes(deviceControlString), false);
  assert.equal(singleShiftThreeMiddle.charCodeAt(at), 0x008f);
  assert.equal(singleShiftThreeMiddle.includes(privateUseTwo), false);
  assert.equal(singleShiftThreeMiddle.includes(privateUseOne), false);
  assert.equal(singleShiftThreeMiddle.includes(deviceControlString), false);
  assert.equal(deviceControlStringMiddle.charCodeAt(at), 0x0090);
  assert.equal(deviceControlStringMiddle.includes(privateUseTwo), false);
  assert.equal(deviceControlStringMiddle.includes(privateUseOne), false);
  assert.equal(deviceControlStringMiddle.includes(singleShiftThree), false);
  assert.equal(uuid.test(broken), false);
  const optionIds = questions.flatMap(question => question.options.map(option => option.id));
  assert.equal(optionIds.includes(legal), true);
  assert.equal(optionIds.includes(broken), false);
  assert.equal(optionIds.includes(privateUseOneMiddle), false);
  assert.equal(optionIds.includes(singleShiftThreeMiddle), false);
  assert.equal(optionIds.includes(deviceControlStringMiddle), false);
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
  assert.equal(payload.choices[0].charCodeAt(at), 0x0092);
  assert.equal(roundTrip.choices[0], broken);
  assert.equal(roundTrip.choices[0].charCodeAt(at), 0x0092);
  assert.notEqual(roundTrip.choices[0].charCodeAt(at), 0x0090);
  assert.notEqual(roundTrip.choices[0].charCodeAt(at), 0x008f);
  assert.notEqual(roundTrip.choices[0].charCodeAt(at), 0x0091);
  assert.equal(payload.choices[0] === legal, false);
  assert.equal(payload.choices[0] === privateUseOneMiddle, false);
  assert.equal(payload.choices[0] === singleShiftThreeMiddle, false);
  assert.equal(payload.choices[0] === deviceControlStringMiddle, false);
  assert.equal(raw.includes(privateUseTwo), true);
  assert.equal(raw.includes("\\u0092"), false);
  assert.equal(raw.includes(privateUseOne), false);
  assert.equal(raw.includes("\\u0091"), false);
  assert.equal(raw.includes(singleShiftThree), false);
  assert.equal(raw.includes("\\u008f"), false);
  assert.equal(raw.includes(deviceControlString), false);
  assert.equal(raw.includes("\\u0090"), false);
  assert.equal(raw.includes(legal), false);
  assert.equal(JSON.stringify(broken).includes(privateUseTwo), true);
  assert.equal(JSON.stringify(broken).includes("\\"), false);
  assert.equal(JSON.stringify(broken).includes("\\u0092"), false);
  assert.equal(JSON.stringify(broken).includes("\\u0091"), false);
  assert.equal(JSON.stringify(broken).includes("\\u008f"), false);
  assert.equal(JSON.stringify(broken).includes("\\u0090"), false);
  assert.equal(JSON.stringify(privateUseOneMiddle).includes(privateUseOne), true);
  assert.equal(JSON.stringify(privateUseOneMiddle).includes("\\"), false);
  assert.equal(JSON.stringify(privateUseOneMiddle).includes("\\u0091"), false);
  assert.equal(JSON.stringify(privateUseOneMiddle).includes("\\u0092"), false);
  assert.equal(JSON.stringify(privateUseOneMiddle).includes(privateUseTwo), false);
  assert.equal(JSON.stringify(singleShiftThreeMiddle).includes(singleShiftThree), true);
  assert.equal(JSON.stringify(singleShiftThreeMiddle).includes("\\"), false);
  assert.equal(JSON.stringify(singleShiftThreeMiddle).includes("\\u008f"), false);
  assert.equal(JSON.stringify(singleShiftThreeMiddle).includes("\\u0092"), false);
  assert.equal(JSON.stringify(singleShiftThreeMiddle).includes(privateUseTwo), false);
  assert.equal(JSON.stringify(deviceControlStringMiddle).includes(deviceControlString), true);
  assert.equal(JSON.stringify(deviceControlStringMiddle).includes("\\"), false);
  assert.equal(JSON.stringify(deviceControlStringMiddle).includes("\\u0090"), false);
  assert.equal(JSON.stringify(deviceControlStringMiddle).includes("\\u0092"), false);
  assert.equal(JSON.stringify(deviceControlStringMiddle).includes(privateUseTwo), false);
  assert.notEqual(JSON.stringify(broken), JSON.stringify(privateUseOneMiddle));
  assert.notEqual(JSON.stringify(broken), JSON.stringify(singleShiftThreeMiddle));
  assert.notEqual(JSON.stringify(broken), JSON.stringify(deviceControlStringMiddle));
  f.resetWrites();
  const refused = await read(await f.req("/api/answers", "PUT", payload, { cookie }));
  assert.equal(refused.status, 422, JSON.stringify(refused.body));
  assert.equal(refused.body.error, "Choose an available answer.");
  assert.equal(refused.headers.get("Set-Cookie"), null);
  assert.equal(refused.text.includes(secret), false);
  assert.equal(refused.text.includes(sessionSecret), false);
  assert.equal(refused.text.includes(broken), false);
  assert.equal(refused.text.includes(privateUseTwo), false);
  assert.equal(refused.text.includes("\\u0092"), false);
  assert.equal(refused.text.includes(privateUseOne), false);
  assert.equal(refused.text.includes("\\u0091"), false);
  assert.equal(refused.text.includes(singleShiftThree), false);
  assert.equal(refused.text.includes("\\u008f"), false);
  assert.equal(refused.text.includes(deviceControlString), false);
  assert.equal(refused.text.includes("\\u0090"), false);
  assert.equal(refused.text.includes(legal), false);
  assert.deepEqual(f.written, []);

  const after = stored(f, reference);
  assert.deepEqual(after, snapshot);
  assert.deepEqual(after.answers, {});
  assert.equal(Object.hasOwn(after.answers, target.id), false);
  assert.equal(JSON.stringify(after.answers).includes(privateUseTwo), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u0092"), false);
  assert.equal(JSON.stringify(after.answers).includes(privateUseOne), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u0091"), false);
  assert.equal(JSON.stringify(after.answers).includes(singleShiftThree), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u008f"), false);
  assert.equal(JSON.stringify(after.answers).includes(legal), false);
  assert.equal(JSON.stringify(after).includes(privateUseTwo), false);
  assert.equal(JSON.stringify(after).includes("\\u0092"), false);
  assert.equal(JSON.stringify(after).includes(privateUseOne), false);
  assert.equal(JSON.stringify(after).includes("\\u0091"), false);
  assert.equal(JSON.stringify(after).includes(singleShiftThree), false);
  assert.equal(JSON.stringify(after).includes("\\u008f"), false);
  assert.equal(JSON.stringify(after).includes(deviceControlString), false);
  assert.equal(JSON.stringify(after).includes("\\u0090"), false);
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
  assert.equal(viewed.text.includes(privateUseTwo), false);
  assert.equal(viewed.text.includes("\\u0092"), false);
  assert.equal(viewed.text.includes(privateUseOne), false);
  assert.equal(viewed.text.includes("\\u0091"), false);
  assert.equal(viewed.text.includes(singleShiftThree), false);
  assert.equal(viewed.text.includes("\\u008f"), false);
  assert.equal(viewed.text.includes(deviceControlString), false);
  assert.equal(viewed.text.includes("\\u0090"), false);
  assert.equal(f.records.get(reference).etag, openedEtag);
  assert.equal(stored(f, reference).inviteHash, inviteHash);
  assert.equal(stored(f, reference).sessionHash, sessionHash);
  assert.deepEqual(stored(f, reference).answers, {});
});
