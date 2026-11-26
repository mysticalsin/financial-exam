import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import worker, { Assessment } from "../src/worker.js";

// One live hiring sitting. Save an answer for a real item on this paper
// whose choice id is that item's legal choice string with a device-control
// one character (U+0011) inserted in the middle. The save is refused. No
// answer is stored. The invite hash and the session secret stay unchanged.
// A cancel character in the middle, an end-of-medium character in the
// middle, and a newline in the middle are separate checks.

const origin = "https://assessment.example";
const notice = {
  controller: "Test controller", contact: "privacy@example.invalid", basis: "Test basis",
  recipients: "Test reviewer", transfers: "Test transfer description", rights: "Test rights",
  purpose: "Test purpose", supervisoryAuthority: "Test authority", version: "test-1", retentionMinutes: 30,
};
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const random = () => crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
const deviceControlOne = "\u0011";
const cancelCharacter = "\u0018";
const endOfMedium = "\u0019";
const newline = "\n";

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

test("a legal choice with a device-control one character inserted in the middle is refused and stores nothing", async () => {
  const source = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(source, /"LIVE_ENABLED": "false"/);
  assert.equal(deviceControlOne, "\u0011");
  assert.equal(deviceControlOne.charCodeAt(0), 0x0011);
  assert.equal(deviceControlOne.codePointAt(0), 0x0011);
  assert.equal(deviceControlOne.length, 1);
  assert.notEqual(deviceControlOne, cancelCharacter);
  assert.notEqual(deviceControlOne.charCodeAt(0), 0x0018);
  assert.notEqual(deviceControlOne, endOfMedium);
  assert.notEqual(deviceControlOne.charCodeAt(0), 0x0019);
  assert.notEqual(deviceControlOne, newline);
  assert.notEqual(deviceControlOne.charCodeAt(0), 0x000A);
  assert.equal(cancelCharacter, "\u0018");
  assert.equal(cancelCharacter.charCodeAt(0), 0x0018);
  assert.equal(cancelCharacter.codePointAt(0), 0x0018);
  assert.equal(cancelCharacter.length, 1);
  assert.equal(endOfMedium, "\u0019");
  assert.equal(endOfMedium.charCodeAt(0), 0x0019);
  assert.equal(endOfMedium.codePointAt(0), 0x0019);
  assert.equal(endOfMedium.length, 1);
  assert.equal(newline, "\n");
  assert.equal(newline.charCodeAt(0), 0x000A);
  assert.equal(newline.codePointAt(0), 0x000A);
  assert.equal(newline.length, 1);
  assert.equal(/\s/.test(deviceControlOne), false);
  assert.equal(/\s/.test(cancelCharacter), false);
  assert.equal(/\s/.test(endOfMedium), false);
  assert.equal(/\s/.test(newline), true);
  assert.equal(/\p{Cc}/u.test(deviceControlOne), true);
  assert.equal(/\p{Cf}/u.test(deviceControlOne), false);
  assert.equal(/\p{Zl}/u.test(deviceControlOne), false);
  assert.equal(/\p{Zp}/u.test(deviceControlOne), false);
  assert.equal(/\p{Zs}/u.test(deviceControlOne), false);
  assert.equal(/\p{White_Space}/u.test(deviceControlOne), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(deviceControlOne), false);
  assert.equal(/\p{Cc}/u.test(cancelCharacter), true);
  assert.equal(/\p{Cf}/u.test(cancelCharacter), false);
  assert.equal(/\p{White_Space}/u.test(cancelCharacter), false);
  assert.equal(/\p{Cc}/u.test(endOfMedium), true);
  assert.equal(/\p{Cf}/u.test(endOfMedium), false);
  assert.equal(/\p{White_Space}/u.test(endOfMedium), false);
  assert.equal(/\p{Cc}/u.test(newline), true);
  assert.equal(/\p{Cf}/u.test(newline), false);
  assert.equal(/\p{White_Space}/u.test(newline), true);
  assert.equal(/\p{Pattern_White_Space}/u.test(newline), true);
  assert.equal(deviceControlOne.trim(), deviceControlOne);
  assert.notEqual(deviceControlOne.trim(), "");
  assert.equal(cancelCharacter.trim(), cancelCharacter);
  assert.notEqual(cancelCharacter.trim(), "");
  assert.equal(endOfMedium.trim(), endOfMedium);
  assert.notEqual(endOfMedium.trim(), "");
  assert.equal(newline.trim(), "");
  assert.notEqual(newline.trim(), newline);
  assert.equal(JSON.stringify(deviceControlOne), '"\\u0011"');
  assert.equal(JSON.stringify(deviceControlOne).includes("\\"), true);
  assert.equal(JSON.stringify(deviceControlOne).includes(deviceControlOne), false);
  assert.notEqual(JSON.stringify(deviceControlOne), '"' + deviceControlOne + '"');
  assert.notEqual(JSON.stringify(deviceControlOne), '"\\u0018"');
  assert.notEqual(JSON.stringify(deviceControlOne), '"\\u0019"');
  assert.notEqual(JSON.stringify(deviceControlOne), '"\\n"');
  assert.notEqual(JSON.stringify(deviceControlOne), '"\\u000a"');
  assert.notEqual(JSON.stringify(deviceControlOne), '"\\u000A"');
  assert.equal(JSON.stringify(cancelCharacter), '"\\u0018"');
  assert.equal(JSON.stringify(cancelCharacter).includes("\\"), true);
  assert.equal(JSON.stringify(cancelCharacter).includes(cancelCharacter), false);
  assert.notEqual(JSON.stringify(cancelCharacter), '"' + cancelCharacter + '"');
  assert.notEqual(JSON.stringify(cancelCharacter), '"\\u0011"');
  assert.notEqual(JSON.stringify(cancelCharacter), '"\\u0019"');
  assert.equal(JSON.stringify(endOfMedium), '"\\u0019"');
  assert.equal(JSON.stringify(endOfMedium).includes("\\"), true);
  assert.equal(JSON.stringify(endOfMedium).includes(endOfMedium), false);
  assert.notEqual(JSON.stringify(endOfMedium), '"' + endOfMedium + '"');
  assert.notEqual(JSON.stringify(endOfMedium), '"\\u0011"');
  assert.notEqual(JSON.stringify(endOfMedium), '"\\u0018"');
  assert.equal(JSON.stringify(newline), '"\\n"');
  assert.equal(JSON.stringify(newline).includes("\\n"), true);
  assert.equal(JSON.stringify(newline).includes(newline), false);
  assert.notEqual(JSON.stringify(newline), '"' + newline + '"');
  assert.notEqual(JSON.stringify(newline), '"\\u000a"');
  assert.notEqual(JSON.stringify(newline), '"\\u000A"');
  assert.notEqual(JSON.stringify(newline), '"\\u0011"');
  assert.notEqual(JSON.stringify(deviceControlOne), JSON.stringify(cancelCharacter));
  assert.notEqual(JSON.stringify(deviceControlOne), JSON.stringify(endOfMedium));
  assert.notEqual(JSON.stringify(deviceControlOne), JSON.stringify(newline));

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
  assert.ok(target, "a real item has a legal choice that can take an interior device-control one character");
  const legal = target.options.find(option => uuid.test(option.id)).id;
  assert.equal(questions.some(question => question.id === target.id), true);
  assert.equal(target.options.some(option => option.id === legal), true);
  assert.equal(uuid.test(legal), true);
  assert.equal(uuid.test(target.id), true);
  assert.equal(legal.length, 36);
  assert.equal(legal.includes(deviceControlOne), false);
  assert.equal(legal.includes(cancelCharacter), false);
  assert.equal(legal.includes(endOfMedium), false);
  assert.equal(legal.includes(newline), false);
  assert.equal(legal.trim(), legal);

  const inserted = insertedInMiddle(legal, deviceControlOne);
  const broken = inserted.value;
  const at = inserted.at;
  const cancelMiddle = insertedInMiddle(legal, cancelCharacter).value;
  const endOfMediumMiddle = insertedInMiddle(legal, endOfMedium).value;
  const newlineMiddle = insertedInMiddle(legal, newline).value;
  assert.ok(at > 0 && at < legal.length);
  assert.equal(at, 18);
  assert.equal(legal.charCodeAt(at), 0x002D);
  assert.equal(broken.charCodeAt(at), 0x0011);
  assert.equal(broken.charCodeAt(at + 1), 0x002D);
  assert.notEqual(broken.charCodeAt(at), 0x0018);
  assert.notEqual(broken.charCodeAt(at), 0x0019);
  assert.notEqual(broken.charCodeAt(at), 0x000A);
  assert.equal(broken.slice(0, at), legal.slice(0, at));
  assert.equal(broken.slice(at + 1), legal.slice(at));
  assert.equal(broken.length, legal.length + 1);
  assert.notEqual(broken, legal);
  assert.equal(broken.replace(deviceControlOne, ""), legal);
  assert.equal([...broken].filter(char => char === deviceControlOne).length, 1);
  assert.equal(broken.indexOf(deviceControlOne), at);
  assert.equal(broken.startsWith(deviceControlOne), false);
  assert.equal(broken.endsWith(deviceControlOne), false);
  assert.notEqual(broken, deviceControlOne + legal);
  assert.notEqual(broken, legal + deviceControlOne);
  assert.notEqual(broken, cancelMiddle);
  assert.notEqual(broken, endOfMediumMiddle);
  assert.notEqual(broken, newlineMiddle);
  assert.equal(broken.trim(), broken);
  assert.notEqual(broken.trim(), legal);
  assert.notEqual(broken.trim(), "");
  assert.equal((deviceControlOne + legal).trim(), deviceControlOne + legal);
  assert.notEqual((deviceControlOne + legal).trim(), legal);
  assert.equal((legal + deviceControlOne).trim(), legal + deviceControlOne);
  assert.notEqual((legal + deviceControlOne).trim(), legal);
  assert.equal((cancelCharacter + legal).trim(), cancelCharacter + legal);
  assert.equal((endOfMedium + legal).trim(), endOfMedium + legal);
  assert.equal((newline + legal).trim(), legal);
  assert.equal((legal + newline).trim(), legal);
  assert.equal(cancelMiddle.trim(), cancelMiddle);
  assert.notEqual(cancelMiddle.trim(), legal);
  assert.equal(endOfMediumMiddle.trim(), endOfMediumMiddle);
  assert.notEqual(endOfMediumMiddle.trim(), legal);
  assert.equal(newlineMiddle.trim(), newlineMiddle);
  assert.notEqual(newlineMiddle.trim(), legal);
  assert.notEqual(newlineMiddle.trim(), "");
  assert.equal(/\s/.test(broken), false);
  assert.equal(/\s/.test(newlineMiddle), true);
  assert.equal(/\p{Cc}/u.test(broken), true);
  assert.equal(/\p{White_Space}/u.test(broken), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(broken), false);
  assert.equal(/\p{White_Space}/u.test(newlineMiddle), true);
  assert.equal(/\p{Pattern_White_Space}/u.test(newlineMiddle), true);
  assert.equal(broken.includes(cancelCharacter), false);
  assert.equal(broken.includes(endOfMedium), false);
  assert.equal(broken.includes(newline), false);
  assert.equal(cancelMiddle.charCodeAt(at), 0x0018);
  assert.equal(cancelMiddle.includes(deviceControlOne), false);
  assert.equal(cancelMiddle.includes(endOfMedium), false);
  assert.equal(cancelMiddle.includes(newline), false);
  assert.equal(endOfMediumMiddle.charCodeAt(at), 0x0019);
  assert.equal(endOfMediumMiddle.includes(deviceControlOne), false);
  assert.equal(endOfMediumMiddle.includes(cancelCharacter), false);
  assert.equal(endOfMediumMiddle.includes(newline), false);
  assert.equal(newlineMiddle.charCodeAt(at), 0x000A);
  assert.equal(newlineMiddle.includes(deviceControlOne), false);
  assert.equal(newlineMiddle.includes(cancelCharacter), false);
  assert.equal(newlineMiddle.includes(endOfMedium), false);
  assert.equal(uuid.test(broken), false);
  const optionIds = questions.flatMap(question => question.options.map(option => option.id));
  assert.equal(optionIds.includes(legal), true);
  assert.equal(optionIds.includes(broken), false);
  assert.equal(optionIds.includes(cancelMiddle), false);
  assert.equal(optionIds.includes(endOfMediumMiddle), false);
  assert.equal(optionIds.includes(newlineMiddle), false);
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
  assert.equal(payload.choices[0].charCodeAt(at), 0x0011);
  assert.equal(roundTrip.choices[0], broken);
  assert.equal(roundTrip.choices[0].charCodeAt(at), 0x0011);
  assert.notEqual(roundTrip.choices[0].charCodeAt(at), 0x0018);
  assert.notEqual(roundTrip.choices[0].charCodeAt(at), 0x0019);
  assert.notEqual(roundTrip.choices[0].charCodeAt(at), 0x000A);
  assert.equal(payload.choices[0] === legal, false);
  assert.equal(payload.choices[0] === cancelMiddle, false);
  assert.equal(payload.choices[0] === endOfMediumMiddle, false);
  assert.equal(payload.choices[0] === newlineMiddle, false);
  assert.equal(raw.includes(deviceControlOne), false);
  assert.equal(raw.includes("\\u0011"), true);
  assert.equal(raw.includes(cancelCharacter), false);
  assert.equal(raw.includes("\\u0018"), false);
  assert.equal(raw.includes(endOfMedium), false);
  assert.equal(raw.includes("\\u0019"), false);
  assert.equal(raw.includes(newline), false);
  assert.equal(raw.includes("\\n"), false);
  assert.equal(raw.includes("\\u000a"), false);
  assert.equal(raw.includes("\\u000A"), false);
  assert.equal(raw.includes(legal), false);
  assert.equal(JSON.stringify(broken).includes("\\u0011"), true);
  assert.equal(JSON.stringify(broken).includes(deviceControlOne), false);
  assert.equal(JSON.stringify(broken).includes("\\u0018"), false);
  assert.equal(JSON.stringify(broken).includes("\\u0019"), false);
  assert.equal(JSON.stringify(broken).includes("\\n"), false);
  assert.equal(JSON.stringify(broken).includes("\\u000a"), false);
  assert.equal(JSON.stringify(broken).includes("\\u000A"), false);
  assert.equal(JSON.stringify(cancelMiddle).includes("\\u0018"), true);
  assert.equal(JSON.stringify(cancelMiddle).includes(cancelCharacter), false);
  assert.equal(JSON.stringify(cancelMiddle).includes("\\u0011"), false);
  assert.equal(JSON.stringify(cancelMiddle).includes(deviceControlOne), false);
  assert.equal(JSON.stringify(endOfMediumMiddle).includes("\\u0019"), true);
  assert.equal(JSON.stringify(endOfMediumMiddle).includes(endOfMedium), false);
  assert.equal(JSON.stringify(endOfMediumMiddle).includes("\\u0011"), false);
  assert.equal(JSON.stringify(endOfMediumMiddle).includes(deviceControlOne), false);
  assert.equal(JSON.stringify(newlineMiddle).includes("\\n"), true);
  assert.equal(JSON.stringify(newlineMiddle).includes("\\u000a"), false);
  assert.equal(JSON.stringify(newlineMiddle).includes("\\u000A"), false);
  assert.equal(JSON.stringify(newlineMiddle).includes(newline), false);
  assert.equal(JSON.stringify(newlineMiddle).includes("\\u0011"), false);
  assert.equal(JSON.stringify(newlineMiddle).includes(deviceControlOne), false);
  assert.notEqual(JSON.stringify(broken), JSON.stringify(cancelMiddle));
  assert.notEqual(JSON.stringify(broken), JSON.stringify(endOfMediumMiddle));
  assert.notEqual(JSON.stringify(broken), JSON.stringify(newlineMiddle));
  f.resetWrites();
  const refused = await read(await f.req("/api/answers", "PUT", payload, { cookie }));
  assert.equal(refused.status, 422, JSON.stringify(refused.body));
  assert.equal(refused.body.error, "Choose an available answer.");
  assert.equal(refused.headers.get("Set-Cookie"), null);
  assert.equal(refused.text.includes(secret), false);
  assert.equal(refused.text.includes(sessionSecret), false);
  assert.equal(refused.text.includes(broken), false);
  assert.equal(refused.text.includes(deviceControlOne), false);
  assert.equal(refused.text.includes("\\u0011"), false);
  assert.equal(refused.text.includes(cancelCharacter), false);
  assert.equal(refused.text.includes("\\u0018"), false);
  assert.equal(refused.text.includes(endOfMedium), false);
  assert.equal(refused.text.includes("\\u0019"), false);
  assert.equal(refused.text.includes(newline), false);
  assert.equal(refused.text.includes("\\n"), false);
  assert.equal(refused.text.includes("\\u000a"), false);
  assert.equal(refused.text.includes("\\u000A"), false);
  assert.equal(refused.text.includes(legal), false);
  assert.deepEqual(f.written, []);

  const after = stored(f, reference);
  assert.deepEqual(after, snapshot);
  assert.deepEqual(after.answers, {});
  assert.equal(Object.hasOwn(after.answers, target.id), false);
  assert.equal(JSON.stringify(after.answers).includes(deviceControlOne), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u0011"), false);
  assert.equal(JSON.stringify(after.answers).includes(legal), false);
  assert.equal(JSON.stringify(after).includes(deviceControlOne), false);
  assert.equal(JSON.stringify(after).includes("\\u0011"), false);
  assert.equal(JSON.stringify(after).includes(cancelCharacter), false);
  assert.equal(JSON.stringify(after).includes("\\u0018"), false);
  assert.equal(JSON.stringify(after).includes(endOfMedium), false);
  assert.equal(JSON.stringify(after).includes("\\u0019"), false);
  assert.equal(JSON.stringify(after).includes(newline), false);
  assert.equal(JSON.stringify(after).includes("\\n"), false);
  assert.equal(JSON.stringify(after).includes("\\u000a"), false);
  assert.equal(JSON.stringify(after).includes("\\u000A"), false);
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
  assert.equal(viewed.text.includes(deviceControlOne), false);
  assert.equal(viewed.text.includes("\\u0011"), false);
  assert.equal(viewed.text.includes(cancelCharacter), false);
  assert.equal(viewed.text.includes("\\u0018"), false);
  assert.equal(viewed.text.includes(endOfMedium), false);
  assert.equal(viewed.text.includes("\\u0019"), false);
  assert.equal(viewed.text.includes(newline), false);
  assert.equal(viewed.text.includes("\\n"), false);
  assert.equal(viewed.text.includes("\\u000a"), false);
  assert.equal(viewed.text.includes("\\u000A"), false);
  assert.equal(f.records.get(reference).etag, openedEtag);
  assert.equal(stored(f, reference).inviteHash, inviteHash);
  assert.equal(stored(f, reference).sessionHash, sessionHash);
  assert.deepEqual(stored(f, reference).answers, {});
});
