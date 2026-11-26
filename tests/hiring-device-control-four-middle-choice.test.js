import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import worker, { Assessment } from "../src/worker.js";

// One live hiring sitting. Save an answer for a real item on this paper
// whose choice id is that item's legal choice string with a device-control
// four character (U+0014) inserted in the middle. The save is refused. No
// answer is stored. The invite hash and the session secret stay unchanged.
// A device-control two character in the middle, a device-control three
// character in the middle, and a device-control one character in the middle
// are separate checks.

const origin = "https://assessment.example";
const notice = {
  controller: "Test controller", contact: "privacy@example.invalid", basis: "Test basis",
  recipients: "Test reviewer", transfers: "Test transfer description", rights: "Test rights",
  purpose: "Test purpose", supervisoryAuthority: "Test authority", version: "test-1", retentionMinutes: 30,
};
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const random = () => crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
const deviceControlFour = "\u0014";
const deviceControlTwo = "\u0012";
const deviceControlThree = "\u0013";
const deviceControlOne = "\u0011";

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

test("a legal choice with a device-control four character inserted in the middle is refused and stores nothing", async () => {
  const source = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(source, /"LIVE_ENABLED": "false"/);
  assert.equal(deviceControlFour, "\u0014");
  assert.equal(deviceControlFour.charCodeAt(0), 0x0014);
  assert.equal(deviceControlFour.codePointAt(0), 0x0014);
  assert.equal(deviceControlFour.length, 1);
  assert.notEqual(deviceControlFour, deviceControlTwo);
  assert.notEqual(deviceControlFour.charCodeAt(0), 0x0012);
  assert.notEqual(deviceControlFour, deviceControlThree);
  assert.notEqual(deviceControlFour.charCodeAt(0), 0x0013);
  assert.notEqual(deviceControlFour, deviceControlOne);
  assert.notEqual(deviceControlFour.charCodeAt(0), 0x0011);
  assert.equal(deviceControlTwo, "\u0012");
  assert.equal(deviceControlTwo.charCodeAt(0), 0x0012);
  assert.equal(deviceControlTwo.codePointAt(0), 0x0012);
  assert.equal(deviceControlTwo.length, 1);
  assert.equal(deviceControlThree, "\u0013");
  assert.equal(deviceControlThree.charCodeAt(0), 0x0013);
  assert.equal(deviceControlThree.codePointAt(0), 0x0013);
  assert.equal(deviceControlThree.length, 1);
  assert.equal(deviceControlOne, "\u0011");
  assert.equal(deviceControlOne.charCodeAt(0), 0x0011);
  assert.equal(deviceControlOne.codePointAt(0), 0x0011);
  assert.equal(deviceControlOne.length, 1);
  assert.equal(/\s/.test(deviceControlFour), false);
  assert.equal(/\s/.test(deviceControlTwo), false);
  assert.equal(/\s/.test(deviceControlThree), false);
  assert.equal(/\s/.test(deviceControlOne), false);
  assert.equal(/\p{Cc}/u.test(deviceControlFour), true);
  assert.equal(/\p{Cf}/u.test(deviceControlFour), false);
  assert.equal(/\p{Zl}/u.test(deviceControlFour), false);
  assert.equal(/\p{Zp}/u.test(deviceControlFour), false);
  assert.equal(/\p{Zs}/u.test(deviceControlFour), false);
  assert.equal(/\p{White_Space}/u.test(deviceControlFour), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(deviceControlFour), false);
  assert.equal(/\p{Cc}/u.test(deviceControlTwo), true);
  assert.equal(/\p{Cf}/u.test(deviceControlTwo), false);
  assert.equal(/\p{White_Space}/u.test(deviceControlTwo), false);
  assert.equal(/\p{Cc}/u.test(deviceControlThree), true);
  assert.equal(/\p{Cf}/u.test(deviceControlThree), false);
  assert.equal(/\p{White_Space}/u.test(deviceControlThree), false);
  assert.equal(/\p{Cc}/u.test(deviceControlOne), true);
  assert.equal(/\p{Cf}/u.test(deviceControlOne), false);
  assert.equal(/\p{White_Space}/u.test(deviceControlOne), false);
  assert.equal(deviceControlFour.trim(), deviceControlFour);
  assert.notEqual(deviceControlFour.trim(), "");
  assert.equal(deviceControlTwo.trim(), deviceControlTwo);
  assert.notEqual(deviceControlTwo.trim(), "");
  assert.equal(deviceControlThree.trim(), deviceControlThree);
  assert.notEqual(deviceControlThree.trim(), "");
  assert.equal(deviceControlOne.trim(), deviceControlOne);
  assert.notEqual(deviceControlOne.trim(), "");
  assert.equal(JSON.stringify(deviceControlFour), '"\\u0014"');
  assert.equal(JSON.stringify(deviceControlFour).includes("\\"), true);
  assert.equal(JSON.stringify(deviceControlFour).includes("\\u0014"), true);
  assert.equal(JSON.stringify(deviceControlFour).includes(deviceControlFour), false);
  assert.notEqual(JSON.stringify(deviceControlFour), '"' + deviceControlFour + '"');
  assert.notEqual(JSON.stringify(deviceControlFour), '"\\u0012"');
  assert.notEqual(JSON.stringify(deviceControlFour), '"\\u0013"');
  assert.notEqual(JSON.stringify(deviceControlFour), '"\\u0011"');
  assert.equal(JSON.stringify(deviceControlTwo), '"\\u0012"');
  assert.equal(JSON.stringify(deviceControlTwo).includes("\\u0012"), true);
  assert.equal(JSON.stringify(deviceControlTwo).includes(deviceControlTwo), false);
  assert.notEqual(JSON.stringify(deviceControlTwo), '"' + deviceControlTwo + '"');
  assert.notEqual(JSON.stringify(deviceControlTwo), '"\\u0014"');
  assert.equal(JSON.stringify(deviceControlThree), '"\\u0013"');
  assert.equal(JSON.stringify(deviceControlThree).includes("\\u0013"), true);
  assert.equal(JSON.stringify(deviceControlThree).includes(deviceControlThree), false);
  assert.notEqual(JSON.stringify(deviceControlThree), '"' + deviceControlThree + '"');
  assert.notEqual(JSON.stringify(deviceControlThree), '"\\u0014"');
  assert.equal(JSON.stringify(deviceControlOne), '"\\u0011"');
  assert.equal(JSON.stringify(deviceControlOne).includes("\\u0011"), true);
  assert.equal(JSON.stringify(deviceControlOne).includes(deviceControlOne), false);
  assert.notEqual(JSON.stringify(deviceControlOne), '"' + deviceControlOne + '"');
  assert.notEqual(JSON.stringify(deviceControlOne), '"\\u0014"');
  assert.notEqual(JSON.stringify(deviceControlFour), JSON.stringify(deviceControlTwo));
  assert.notEqual(JSON.stringify(deviceControlFour), JSON.stringify(deviceControlThree));
  assert.notEqual(JSON.stringify(deviceControlFour), JSON.stringify(deviceControlOne));

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
  assert.ok(target, "a real item has a legal choice that can take an interior device-control four character");
  const legal = target.options.find(option => uuid.test(option.id)).id;
  assert.equal(questions.some(question => question.id === target.id), true);
  assert.equal(target.options.some(option => option.id === legal), true);
  assert.equal(uuid.test(legal), true);
  assert.equal(uuid.test(target.id), true);
  assert.equal(legal.length, 36);
  assert.equal(legal.includes(deviceControlFour), false);
  assert.equal(legal.includes(deviceControlTwo), false);
  assert.equal(legal.includes(deviceControlThree), false);
  assert.equal(legal.includes(deviceControlOne), false);
  assert.equal(legal.trim(), legal);

  const inserted = insertedInMiddle(legal, deviceControlFour);
  const broken = inserted.value;
  const at = inserted.at;
  const deviceControlTwoMiddle = insertedInMiddle(legal, deviceControlTwo).value;
  const deviceControlThreeMiddle = insertedInMiddle(legal, deviceControlThree).value;
  const deviceControlOneMiddle = insertedInMiddle(legal, deviceControlOne).value;
  assert.ok(at > 0 && at < legal.length);
  assert.equal(at, 18);
  assert.equal(legal.charCodeAt(at), 0x002D);
  assert.equal(broken.charCodeAt(at), 0x0014);
  assert.equal(broken.charCodeAt(at + 1), 0x002D);
  assert.notEqual(broken.charCodeAt(at), 0x0012);
  assert.notEqual(broken.charCodeAt(at), 0x0013);
  assert.notEqual(broken.charCodeAt(at), 0x0011);
  assert.equal(broken.slice(0, at), legal.slice(0, at));
  assert.equal(broken.slice(at + 1), legal.slice(at));
  assert.equal(broken.length, legal.length + 1);
  assert.notEqual(broken, legal);
  assert.equal(broken.replace(deviceControlFour, ""), legal);
  assert.equal([...broken].filter(char => char === deviceControlFour).length, 1);
  assert.equal(broken.indexOf(deviceControlFour), at);
  assert.equal(broken.startsWith(deviceControlFour), false);
  assert.equal(broken.endsWith(deviceControlFour), false);
  assert.notEqual(broken, deviceControlFour + legal);
  assert.notEqual(broken, legal + deviceControlFour);
  assert.notEqual(broken, deviceControlTwoMiddle);
  assert.notEqual(broken, deviceControlThreeMiddle);
  assert.notEqual(broken, deviceControlOneMiddle);
  assert.equal(broken.trim(), broken);
  assert.notEqual(broken.trim(), legal);
  assert.notEqual(broken.trim(), "");
  assert.equal((deviceControlFour + legal).trim(), deviceControlFour + legal);
  assert.notEqual((deviceControlFour + legal).trim(), legal);
  assert.equal((legal + deviceControlFour).trim(), legal + deviceControlFour);
  assert.notEqual((legal + deviceControlFour).trim(), legal);
  assert.equal((deviceControlTwo + legal).trim(), deviceControlTwo + legal);
  assert.equal((deviceControlThree + legal).trim(), deviceControlThree + legal);
  assert.equal((deviceControlOne + legal).trim(), deviceControlOne + legal);
  assert.equal(deviceControlTwoMiddle.trim(), deviceControlTwoMiddle);
  assert.notEqual(deviceControlTwoMiddle.trim(), legal);
  assert.equal(deviceControlThreeMiddle.trim(), deviceControlThreeMiddle);
  assert.notEqual(deviceControlThreeMiddle.trim(), legal);
  assert.equal(deviceControlOneMiddle.trim(), deviceControlOneMiddle);
  assert.notEqual(deviceControlOneMiddle.trim(), legal);
  assert.equal(/\s/.test(broken), false);
  assert.equal(/\s/.test(deviceControlTwoMiddle), false);
  assert.equal(/\s/.test(deviceControlThreeMiddle), false);
  assert.equal(/\s/.test(deviceControlOneMiddle), false);
  assert.equal(/\p{Cc}/u.test(broken), true);
  assert.equal(/\p{White_Space}/u.test(broken), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(broken), false);
  assert.equal(/\p{White_Space}/u.test(deviceControlTwoMiddle), false);
  assert.equal(/\p{White_Space}/u.test(deviceControlThreeMiddle), false);
  assert.equal(/\p{White_Space}/u.test(deviceControlOneMiddle), false);
  assert.equal(broken.includes(deviceControlTwo), false);
  assert.equal(broken.includes(deviceControlThree), false);
  assert.equal(broken.includes(deviceControlOne), false);
  assert.equal(deviceControlTwoMiddle.charCodeAt(at), 0x0012);
  assert.equal(deviceControlTwoMiddle.includes(deviceControlFour), false);
  assert.equal(deviceControlTwoMiddle.includes(deviceControlThree), false);
  assert.equal(deviceControlTwoMiddle.includes(deviceControlOne), false);
  assert.equal(deviceControlThreeMiddle.charCodeAt(at), 0x0013);
  assert.equal(deviceControlThreeMiddle.includes(deviceControlFour), false);
  assert.equal(deviceControlThreeMiddle.includes(deviceControlTwo), false);
  assert.equal(deviceControlThreeMiddle.includes(deviceControlOne), false);
  assert.equal(deviceControlOneMiddle.charCodeAt(at), 0x0011);
  assert.equal(deviceControlOneMiddle.includes(deviceControlFour), false);
  assert.equal(deviceControlOneMiddle.includes(deviceControlTwo), false);
  assert.equal(deviceControlOneMiddle.includes(deviceControlThree), false);
  assert.equal(uuid.test(broken), false);
  const optionIds = questions.flatMap(question => question.options.map(option => option.id));
  assert.equal(optionIds.includes(legal), true);
  assert.equal(optionIds.includes(broken), false);
  assert.equal(optionIds.includes(deviceControlTwoMiddle), false);
  assert.equal(optionIds.includes(deviceControlThreeMiddle), false);
  assert.equal(optionIds.includes(deviceControlOneMiddle), false);
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
  assert.equal(payload.choices[0].charCodeAt(at), 0x0014);
  assert.equal(roundTrip.choices[0], broken);
  assert.equal(roundTrip.choices[0].charCodeAt(at), 0x0014);
  assert.notEqual(roundTrip.choices[0].charCodeAt(at), 0x0012);
  assert.notEqual(roundTrip.choices[0].charCodeAt(at), 0x0013);
  assert.notEqual(roundTrip.choices[0].charCodeAt(at), 0x0011);
  assert.equal(payload.choices[0] === legal, false);
  assert.equal(payload.choices[0] === deviceControlTwoMiddle, false);
  assert.equal(payload.choices[0] === deviceControlThreeMiddle, false);
  assert.equal(payload.choices[0] === deviceControlOneMiddle, false);
  assert.equal(raw.includes(deviceControlFour), false);
  assert.equal(raw.includes("\\u0014"), true);
  assert.equal(raw.includes(deviceControlTwo), false);
  assert.equal(raw.includes("\\u0012"), false);
  assert.equal(raw.includes(deviceControlThree), false);
  assert.equal(raw.includes("\\u0013"), false);
  assert.equal(raw.includes(deviceControlOne), false);
  assert.equal(raw.includes("\\u0011"), false);
  assert.equal(raw.includes(legal), false);
  assert.equal(JSON.stringify(broken).includes("\\u0014"), true);
  assert.equal(JSON.stringify(broken).includes(deviceControlFour), false);
  assert.equal(JSON.stringify(broken).includes("\\u0012"), false);
  assert.equal(JSON.stringify(broken).includes("\\u0013"), false);
  assert.equal(JSON.stringify(broken).includes("\\u0011"), false);
  assert.equal(JSON.stringify(deviceControlTwoMiddle).includes("\\u0012"), true);
  assert.equal(JSON.stringify(deviceControlTwoMiddle).includes(deviceControlTwo), false);
  assert.equal(JSON.stringify(deviceControlTwoMiddle).includes("\\u0014"), false);
  assert.equal(JSON.stringify(deviceControlTwoMiddle).includes(deviceControlFour), false);
  assert.equal(JSON.stringify(deviceControlThreeMiddle).includes("\\u0013"), true);
  assert.equal(JSON.stringify(deviceControlThreeMiddle).includes(deviceControlThree), false);
  assert.equal(JSON.stringify(deviceControlThreeMiddle).includes("\\u0014"), false);
  assert.equal(JSON.stringify(deviceControlThreeMiddle).includes(deviceControlFour), false);
  assert.equal(JSON.stringify(deviceControlOneMiddle).includes("\\u0011"), true);
  assert.equal(JSON.stringify(deviceControlOneMiddle).includes(deviceControlOne), false);
  assert.equal(JSON.stringify(deviceControlOneMiddle).includes("\\u0014"), false);
  assert.equal(JSON.stringify(deviceControlOneMiddle).includes(deviceControlFour), false);
  assert.notEqual(JSON.stringify(broken), JSON.stringify(deviceControlTwoMiddle));
  assert.notEqual(JSON.stringify(broken), JSON.stringify(deviceControlThreeMiddle));
  assert.notEqual(JSON.stringify(broken), JSON.stringify(deviceControlOneMiddle));
  f.resetWrites();
  const refused = await read(await f.req("/api/answers", "PUT", payload, { cookie }));
  assert.equal(refused.status, 422, JSON.stringify(refused.body));
  assert.equal(refused.body.error, "Choose an available answer.");
  assert.equal(refused.headers.get("Set-Cookie"), null);
  assert.equal(refused.text.includes(secret), false);
  assert.equal(refused.text.includes(sessionSecret), false);
  assert.equal(refused.text.includes(broken), false);
  assert.equal(refused.text.includes(deviceControlFour), false);
  assert.equal(refused.text.includes("\\u0014"), false);
  assert.equal(refused.text.includes(deviceControlTwo), false);
  assert.equal(refused.text.includes("\\u0012"), false);
  assert.equal(refused.text.includes(deviceControlThree), false);
  assert.equal(refused.text.includes("\\u0013"), false);
  assert.equal(refused.text.includes(deviceControlOne), false);
  assert.equal(refused.text.includes("\\u0011"), false);
  assert.equal(refused.text.includes(legal), false);
  assert.deepEqual(f.written, []);

  const after = stored(f, reference);
  assert.deepEqual(after, snapshot);
  assert.deepEqual(after.answers, {});
  assert.equal(Object.hasOwn(after.answers, target.id), false);
  assert.equal(JSON.stringify(after.answers).includes(deviceControlFour), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u0014"), false);
  assert.equal(JSON.stringify(after.answers).includes(legal), false);
  assert.equal(JSON.stringify(after).includes(deviceControlFour), false);
  assert.equal(JSON.stringify(after).includes("\\u0014"), false);
  assert.equal(JSON.stringify(after).includes(deviceControlTwo), false);
  assert.equal(JSON.stringify(after).includes("\\u0012"), false);
  assert.equal(JSON.stringify(after).includes(deviceControlThree), false);
  assert.equal(JSON.stringify(after).includes("\\u0013"), false);
  assert.equal(JSON.stringify(after).includes(deviceControlOne), false);
  assert.equal(JSON.stringify(after).includes("\\u0011"), false);
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
  assert.equal(viewed.text.includes(deviceControlFour), false);
  assert.equal(viewed.text.includes("\\u0014"), false);
  assert.equal(viewed.text.includes(deviceControlTwo), false);
  assert.equal(viewed.text.includes("\\u0012"), false);
  assert.equal(viewed.text.includes(deviceControlThree), false);
  assert.equal(viewed.text.includes("\\u0013"), false);
  assert.equal(viewed.text.includes(deviceControlOne), false);
  assert.equal(viewed.text.includes("\\u0011"), false);
  assert.equal(f.records.get(reference).etag, openedEtag);
  assert.equal(stored(f, reference).inviteHash, inviteHash);
  assert.equal(stored(f, reference).sessionHash, sessionHash);
  assert.deepEqual(stored(f, reference).answers, {});
});
