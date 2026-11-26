import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import worker, { Assessment } from "../src/worker.js";

// One live hiring sitting. Save an answer for a real item on this paper
// whose choice id is that item's legal choice string with a medium mathematical space
// (U+205F) inserted in the middle. The save is refused. No answer is
// stored. The invite hash and the session secret stay unchanged.
// A three-per-em space in the middle, a four-per-em space in the middle, and an
// ordinary space are separate checks.

const origin = "https://assessment.example";
const notice = {
  controller: "Test controller", contact: "privacy@example.invalid", basis: "Test basis",
  recipients: "Test reviewer", transfers: "Test transfer description", rights: "Test rights",
  purpose: "Test purpose", supervisoryAuthority: "Test authority", version: "test-1", retentionMinutes: 30,
};
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const random = () => crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
const mediumMathematicalSpace = "\u205F";
const threePerEmSpace = "\u2004";
const fourPerEmSpace = "\u2005";
const ordinarySpace = "\u0020";

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

test("a legal choice with a medium mathematical space inserted in the middle is refused and stores nothing", async () => {
  const source = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(source, /"LIVE_ENABLED": "false"/);
  assert.equal(mediumMathematicalSpace, "\u205F");
  assert.equal(mediumMathematicalSpace.charCodeAt(0), 0x205F);
  assert.equal(mediumMathematicalSpace.codePointAt(0), 0x205F);
  assert.equal(mediumMathematicalSpace.length, 1);
  assert.notEqual(mediumMathematicalSpace, threePerEmSpace);
  assert.notEqual(mediumMathematicalSpace.charCodeAt(0), 0x2004);
  assert.notEqual(mediumMathematicalSpace, fourPerEmSpace);
  assert.notEqual(mediumMathematicalSpace.charCodeAt(0), 0x2005);
  assert.notEqual(mediumMathematicalSpace, ordinarySpace);
  assert.notEqual(mediumMathematicalSpace.charCodeAt(0), 0x0020);
  assert.equal(threePerEmSpace, "\u2004");
  assert.equal(threePerEmSpace.charCodeAt(0), 0x2004);
  assert.equal(threePerEmSpace.length, 1);
  assert.equal(fourPerEmSpace, "\u2005");
  assert.equal(fourPerEmSpace.charCodeAt(0), 0x2005);
  assert.equal(fourPerEmSpace.length, 1);
  assert.equal(ordinarySpace, " ");
  assert.equal(ordinarySpace.charCodeAt(0), 0x0020);
  assert.equal(ordinarySpace.length, 1);
  assert.equal(/\s/.test(mediumMathematicalSpace), true);
  assert.equal(/\s/.test(threePerEmSpace), true);
  assert.equal(/\s/.test(fourPerEmSpace), true);
  assert.equal(/\s/.test(ordinarySpace), true);
  assert.equal(/\p{Zs}/u.test(mediumMathematicalSpace), true);
  assert.equal(/\p{Cf}/u.test(mediumMathematicalSpace), false);
  assert.equal(/\p{Cc}/u.test(mediumMathematicalSpace), false);
  assert.equal(/\p{Zs}/u.test(threePerEmSpace), true);
  assert.equal(/\p{Cf}/u.test(threePerEmSpace), false);
  assert.equal(/\p{Cc}/u.test(threePerEmSpace), false);
  assert.equal(/\p{Zs}/u.test(fourPerEmSpace), true);
  assert.equal(/\p{Cf}/u.test(fourPerEmSpace), false);
  assert.equal(/\p{Cc}/u.test(fourPerEmSpace), false);
  assert.equal(/\p{Zs}/u.test(ordinarySpace), true);
  assert.equal(/\p{Cf}/u.test(ordinarySpace), false);
  assert.equal(/\p{Cc}/u.test(ordinarySpace), false);
  assert.equal(mediumMathematicalSpace.trim(), "");
  assert.equal(threePerEmSpace.trim(), "");
  assert.equal(fourPerEmSpace.trim(), "");
  assert.equal(ordinarySpace.trim(), "");
  assert.equal(JSON.stringify(mediumMathematicalSpace), '"' + mediumMathematicalSpace + '"');
  assert.equal(JSON.stringify(mediumMathematicalSpace).includes("\\"), false);
  assert.notEqual(JSON.stringify(mediumMathematicalSpace), '"\\u205F"');
  assert.notEqual(JSON.stringify(mediumMathematicalSpace), JSON.stringify(threePerEmSpace));
  assert.notEqual(JSON.stringify(mediumMathematicalSpace), JSON.stringify(fourPerEmSpace));
  assert.notEqual(JSON.stringify(mediumMathematicalSpace), JSON.stringify(ordinarySpace));
  assert.equal(JSON.stringify(ordinarySpace), '" "');
  assert.equal(JSON.stringify(ordinarySpace).includes("\\"), false);

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
  assert.equal(opened.sessionHash, await digest(sessionSecret));
  assert.notEqual(sessionSecret, secret);
  assert.equal(cookie, "__Host-assessment=" + reference + "." + sessionSecret);
  assert.equal(opened.notice.integrityReview, undefined);

  const questions = opened.paper.questions;
  assert.equal(questions.length, 15);
  const target = questions.find(question => typeof question.id === "string" && uuid.test(question.id) &&
    question.options.some(option => typeof option.id === "string" && uuid.test(option.id) && option.id.length >= 2));
  assert.ok(target, "a real item has a legal choice that can take an interior medium mathematical space");
  const legal = target.options.find(option => uuid.test(option.id)).id;
  assert.equal(questions.some(question => question.id === target.id), true);
  assert.equal(target.options.some(option => option.id === legal), true);
  assert.equal(uuid.test(legal), true);
  assert.equal(uuid.test(target.id), true);
  assert.equal(legal.length, 36);
  assert.equal(legal.includes(mediumMathematicalSpace), false);
  assert.equal(legal.includes(threePerEmSpace), false);
  assert.equal(legal.includes(fourPerEmSpace), false);
  assert.equal(legal.includes(ordinarySpace), false);
  assert.equal(legal.trim(), legal);

  const inserted = insertedInMiddle(legal, mediumMathematicalSpace);
  const broken = inserted.value;
  const at = inserted.at;
  const threeMiddle = insertedInMiddle(legal, threePerEmSpace).value;
  const fourMiddle = insertedInMiddle(legal, fourPerEmSpace).value;
  const ordinaryMiddle = insertedInMiddle(legal, ordinarySpace).value;
  const leadingOrdinary = ordinarySpace + legal;
  const trailingOrdinary = legal + ordinarySpace;
  assert.ok(at > 0 && at < legal.length);
  assert.equal(at, 18);
  assert.equal(legal.charCodeAt(at), 0x002D);
  assert.equal(broken.charCodeAt(at), 0x205F);
  assert.equal(broken.charCodeAt(at + 1), 0x002D);
  assert.notEqual(broken.charCodeAt(at), 0x2004);
  assert.notEqual(broken.charCodeAt(at), 0x2005);
  assert.notEqual(broken.charCodeAt(at), 0x0020);
  assert.equal(broken[at], mediumMathematicalSpace);
  assert.equal(broken.slice(0, at), legal.slice(0, at));
  assert.equal(broken.slice(at + 1), legal.slice(at));
  assert.equal(broken.slice(0, at).length > 0, true);
  assert.equal(broken.slice(at + 1).length > 0, true);
  assert.equal(broken.length, legal.length + 1);
  assert.notEqual(broken, legal);
  assert.equal(broken.replace(mediumMathematicalSpace, ""), legal);
  assert.equal([...broken].filter(char => char === mediumMathematicalSpace).length, 1);
  assert.equal(broken.indexOf(mediumMathematicalSpace), at);
  assert.equal(broken.startsWith(mediumMathematicalSpace), false);
  assert.equal(broken.endsWith(mediumMathematicalSpace), false);
  assert.notEqual(broken, mediumMathematicalSpace + legal);
  assert.notEqual(broken, legal + mediumMathematicalSpace);
  assert.notEqual(broken, threePerEmSpace + legal);
  assert.notEqual(broken, legal + threePerEmSpace);
  assert.notEqual(broken, fourPerEmSpace + legal);
  assert.notEqual(broken, legal + fourPerEmSpace);
  assert.notEqual(broken, leadingOrdinary);
  assert.notEqual(broken, trailingOrdinary);
  assert.notEqual(broken, threeMiddle);
  assert.notEqual(broken, fourMiddle);
  assert.notEqual(broken, ordinaryMiddle);
  assert.equal((mediumMathematicalSpace + legal).trim(), legal);
  assert.equal((legal + mediumMathematicalSpace).trim(), legal);
  assert.equal((threePerEmSpace + legal).trim(), legal);
  assert.equal((legal + threePerEmSpace).trim(), legal);
  assert.equal((fourPerEmSpace + legal).trim(), legal);
  assert.equal((legal + fourPerEmSpace).trim(), legal);
  assert.equal(leadingOrdinary.trim(), legal);
  assert.equal(trailingOrdinary.trim(), legal);
  assert.equal(broken.trim(), broken);
  assert.notEqual(broken.trim(), legal);
  assert.notEqual(broken.trim(), "");
  assert.equal(threeMiddle.trim(), threeMiddle);
  assert.notEqual(threeMiddle.trim(), legal);
  assert.equal(fourMiddle.trim(), fourMiddle);
  assert.notEqual(fourMiddle.trim(), legal);
  assert.equal(ordinaryMiddle.trim(), ordinaryMiddle);
  assert.notEqual(ordinaryMiddle.trim(), legal);
  assert.equal(/^\s+$/.test(broken), false);
  assert.equal(/\s/.test(broken), true);
  assert.equal(/\p{Zs}/u.test(broken), true);
  assert.equal(/\p{Cf}/u.test(broken), false);
  assert.equal(broken.includes(threePerEmSpace), false);
  assert.equal(broken.includes(fourPerEmSpace), false);
  assert.equal(broken.includes(ordinarySpace), false);
  assert.equal(threeMiddle.charCodeAt(at), 0x2004);
  assert.equal(threeMiddle.includes(mediumMathematicalSpace), false);
  assert.equal(threeMiddle.includes(fourPerEmSpace), false);
  assert.equal(threeMiddle.includes(ordinarySpace), false);
  assert.equal(fourMiddle.charCodeAt(at), 0x2005);
  assert.equal(fourMiddle.includes(mediumMathematicalSpace), false);
  assert.equal(fourMiddle.includes(threePerEmSpace), false);
  assert.equal(fourMiddle.includes(ordinarySpace), false);
  assert.equal(ordinaryMiddle.charCodeAt(at), 0x0020);
  assert.equal(ordinaryMiddle.includes(mediumMathematicalSpace), false);
  assert.equal(ordinaryMiddle.includes(threePerEmSpace), false);
  assert.equal(ordinaryMiddle.includes(fourPerEmSpace), false);
  assert.equal(leadingOrdinary.startsWith(ordinarySpace), true);
  assert.equal(leadingOrdinary.includes(mediumMathematicalSpace), false);
  assert.equal(leadingOrdinary.includes(threePerEmSpace), false);
  assert.equal(leadingOrdinary.includes(fourPerEmSpace), false);
  assert.equal(trailingOrdinary.endsWith(ordinarySpace), true);
  assert.equal(trailingOrdinary.includes(mediumMathematicalSpace), false);
  assert.equal(trailingOrdinary.includes(threePerEmSpace), false);
  assert.equal(trailingOrdinary.includes(fourPerEmSpace), false);
  assert.equal(uuid.test(broken), false);
  assert.equal(uuid.test(threeMiddle), false);
  assert.equal(uuid.test(fourMiddle), false);
  assert.equal(uuid.test(ordinaryMiddle), false);
  assert.equal(uuid.test(leadingOrdinary), false);
  assert.equal(uuid.test(trailingOrdinary), false);
  const optionIds = questions.flatMap(question => question.options.map(option => option.id));
  assert.equal(optionIds.includes(legal), true);
  assert.equal(optionIds.includes(broken), false);
  assert.equal(optionIds.includes(threeMiddle), false);
  assert.equal(optionIds.includes(fourMiddle), false);
  assert.equal(optionIds.includes(ordinaryMiddle), false);
  assert.equal(optionIds.includes(leadingOrdinary), false);
  assert.equal(optionIds.includes(trailingOrdinary), false);
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
  assert.equal(typeof payload.questionId, "string");
  assert.deepEqual(payload.choices, [broken]);
  assert.equal(payload.choices.length, 1);
  assert.equal(typeof payload.choices[0], "string");
  assert.equal(payload.choices[0].includes(mediumMathematicalSpace), true);
  assert.equal(payload.choices[0].charCodeAt(at), 0x205F);
  assert.equal(roundTrip.choices[0], broken);
  assert.equal(roundTrip.choices[0].charCodeAt(at), 0x205F);
  assert.notEqual(roundTrip.choices[0].charCodeAt(at), 0x2004);
  assert.notEqual(roundTrip.choices[0].charCodeAt(at), 0x2005);
  assert.notEqual(roundTrip.choices[0].charCodeAt(at), 0x0020);
  assert.equal(payload.choices[0].includes(threePerEmSpace), false);
  assert.equal(payload.choices[0].includes(fourPerEmSpace), false);
  assert.equal(payload.choices[0].includes(ordinarySpace), false);
  assert.equal(payload.choices[0] === legal, false);
  assert.equal(payload.choices[0] === threeMiddle, false);
  assert.equal(payload.choices[0] === fourMiddle, false);
  assert.equal(payload.choices[0] === ordinaryMiddle, false);
  assert.equal(payload.choices[0] === leadingOrdinary, false);
  assert.equal(payload.choices[0] === trailingOrdinary, false);
  assert.equal(payload.choices[0] === mediumMathematicalSpace + legal, false);
  assert.equal(payload.choices[0] === legal + mediumMathematicalSpace, false);
  assert.equal(payload.choices[0] === threePerEmSpace + legal, false);
  assert.equal(payload.choices[0] === legal + threePerEmSpace, false);
  assert.equal(payload.choices[0] === fourPerEmSpace + legal, false);
  assert.equal(payload.choices[0] === legal + fourPerEmSpace, false);
  assert.equal(raw.includes(JSON.stringify(broken)), true);
  assert.equal(raw.includes(mediumMathematicalSpace), true);
  assert.equal(raw.includes("\\u205F"), false);
  assert.equal(raw.includes(threePerEmSpace), false);
  assert.equal(raw.includes("\\u2004"), false);
  assert.equal(raw.includes(fourPerEmSpace), false);
  assert.equal(raw.includes("\\u2005"), false);
  assert.equal(raw.includes(ordinarySpace), false);
  assert.equal(raw.includes("\\u0020"), false);
  assert.equal(raw.includes(legal), false);
  f.resetWrites();
  const refused = await read(await f.req("/api/answers", "PUT", payload, { cookie }));
  assert.equal(refused.status, 422, JSON.stringify(refused.body));
  assert.equal(refused.body.error, "Choose an available answer.");
  assert.equal(refused.headers.get("Set-Cookie"), null);
  assert.equal(refused.text.includes(secret), false);
  assert.equal(refused.text.includes(sessionSecret), false);
  assert.equal(refused.text.includes(broken), false);
  assert.equal(refused.text.includes(mediumMathematicalSpace), false);
  assert.equal(refused.text.includes("\\u205F"), false);
  assert.equal(refused.text.includes(threePerEmSpace), false);
  assert.equal(refused.text.includes("\\u2004"), false);
  assert.equal(refused.text.includes(fourPerEmSpace), false);
  assert.equal(refused.text.includes("\\u2005"), false);
  assert.equal(refused.text.includes(legal), false);
  assert.deepEqual(f.written, []);

  const after = stored(f, reference);
  assert.deepEqual(after, snapshot);
  assert.deepEqual(after.answers, {});
  assert.equal(Object.hasOwn(after.answers, target.id), false);
  assert.equal(JSON.stringify(after.answers).includes(legal), false);
  assert.equal(JSON.stringify(after.answers).includes(mediumMathematicalSpace), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u205F"), false);
  assert.equal(JSON.stringify(after.answers).includes(threePerEmSpace), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u2004"), false);
  assert.equal(JSON.stringify(after.answers).includes(fourPerEmSpace), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u2005"), false);
  assert.equal(JSON.stringify(after.answers).includes(ordinarySpace), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u0020"), false);
  assert.equal(JSON.stringify(after).includes(mediumMathematicalSpace), false);
  assert.equal(JSON.stringify(after).includes("\\u205F"), false);
  assert.equal(JSON.stringify(after).includes(threePerEmSpace), false);
  assert.equal(JSON.stringify(after).includes("\\u2004"), false);
  assert.equal(JSON.stringify(after).includes(fourPerEmSpace), false);
  assert.equal(JSON.stringify(after).includes("\\u2005"), false);
  assert.equal(after.revision, 1);
  assert.equal(after.status, "active");
  assert.equal(after.submittedAt, undefined);
  assert.equal(after.score, undefined);
  assert.equal(after.integrityMasks, undefined);
  assert.deepEqual(after.paper, paper);
  assert.equal(after.inviteHash, inviteHash);
  assert.equal(after.sessionHash, sessionHash);
  assert.equal(after.inviteHash, await digest(secret));
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
  assert.equal(viewed.text.includes(mediumMathematicalSpace), false);
  assert.equal(viewed.text.includes("\\u205F"), false);
  assert.equal(viewed.text.includes(threePerEmSpace), false);
  assert.equal(viewed.text.includes("\\u2004"), false);
  assert.equal(viewed.text.includes(fourPerEmSpace), false);
  assert.equal(viewed.text.includes("\\u2005"), false);
  assert.equal(f.records.get(reference).etag, openedEtag);
  assert.equal(stored(f, reference).inviteHash, inviteHash);
  assert.equal(stored(f, reference).sessionHash, sessionHash);
  assert.deepEqual(stored(f, reference).answers, {});
});
