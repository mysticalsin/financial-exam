import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import worker, { Assessment } from "../src/worker.js";

// One live hiring sitting. Save an answer for a real item on this paper
// whose choice id is that item's legal choice string with a
// start-of-text character (U+0002) inserted in the middle. The
// save is refused. No answer is stored. The invite hash and the session
// secret stay unchanged. An end-of-transmission character in the middle, an
// acknowledge character in the middle, and a newline in the middle
// are separate checks.

const origin = "https://assessment.example";
const notice = {
  controller: "Test controller", contact: "privacy@example.invalid", basis: "Test basis",
  recipients: "Test reviewer", transfers: "Test transfer description", rights: "Test rights",
  purpose: "Test purpose", supervisoryAuthority: "Test authority", version: "test-1", retentionMinutes: 30,
};
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const random = () => crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
const startOfText = "\u0002";
const endOfTransmission = "\u0004";
const acknowledge = "\u0006";
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

test("a legal choice with a start-of-text character inserted in the middle is refused and stores nothing", async () => {
  const source = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(source, /"LIVE_ENABLED": "false"/);
  assert.equal(startOfText, "\u0002");
  assert.equal(startOfText.charCodeAt(0), 0x0002);
  assert.equal(startOfText.codePointAt(0), 0x0002);
  assert.equal(startOfText.length, 1);
  assert.notEqual(startOfText, acknowledge);
  assert.notEqual(startOfText.charCodeAt(0), 0x0006);
  assert.notEqual(startOfText, endOfTransmission);
  assert.notEqual(startOfText.charCodeAt(0), 0x0004);
  assert.notEqual(startOfText, newline);
  assert.notEqual(startOfText.charCodeAt(0), 0x000A);
  assert.equal(acknowledge, "\u0006");
  assert.equal(acknowledge.charCodeAt(0), 0x0006);
  assert.equal(acknowledge.codePointAt(0), 0x0006);
  assert.equal(acknowledge.length, 1);
  assert.equal(endOfTransmission, "\u0004");
  assert.equal(endOfTransmission.charCodeAt(0), 0x0004);
  assert.equal(endOfTransmission.codePointAt(0), 0x0004);
  assert.equal(endOfTransmission.length, 1);
  assert.equal(newline, "\n");
  assert.equal(newline.charCodeAt(0), 0x000A);
  assert.equal(newline.codePointAt(0), 0x000A);
  assert.equal(newline.length, 1);
  assert.equal(/\s/.test(startOfText), false);
  assert.equal(/\s/.test(acknowledge), false);
  assert.equal(/\s/.test(endOfTransmission), false);
  assert.equal(/\s/.test(newline), true);
  assert.equal(/\p{Cc}/u.test(startOfText), true);
  assert.equal(/\p{Cf}/u.test(startOfText), false);
  assert.equal(/\p{Zl}/u.test(startOfText), false);
  assert.equal(/\p{Zp}/u.test(startOfText), false);
  assert.equal(/\p{Zs}/u.test(startOfText), false);
  assert.equal(/\p{White_Space}/u.test(startOfText), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(startOfText), false);
  assert.equal(/\p{Cc}/u.test(acknowledge), true);
  assert.equal(/\p{Cf}/u.test(acknowledge), false);
  assert.equal(/\p{White_Space}/u.test(acknowledge), false);
  assert.equal(/\p{Cc}/u.test(endOfTransmission), true);
  assert.equal(/\p{Cf}/u.test(endOfTransmission), false);
  assert.equal(/\p{White_Space}/u.test(endOfTransmission), false);
  assert.equal(/\p{Cc}/u.test(newline), true);
  assert.equal(/\p{Cf}/u.test(newline), false);
  assert.equal(/\p{Zl}/u.test(newline), false);
  assert.equal(/\p{Zp}/u.test(newline), false);
  assert.equal(/\p{Zs}/u.test(newline), false);
  assert.equal(/\p{White_Space}/u.test(newline), true);
  assert.equal(/\p{Pattern_White_Space}/u.test(newline), true);
  assert.equal(startOfText.trim(), startOfText);
  assert.notEqual(startOfText.trim(), "");
  assert.equal(acknowledge.trim(), acknowledge);
  assert.notEqual(acknowledge.trim(), "");
  assert.equal(endOfTransmission.trim(), endOfTransmission);
  assert.notEqual(endOfTransmission.trim(), "");
  assert.equal(newline.trim(), "");
  assert.notEqual(newline.trim(), newline);
  assert.equal(JSON.stringify(startOfText), '"\\u0002"');
  assert.equal(JSON.stringify(startOfText).includes("\\"), true);
  assert.equal(JSON.stringify(startOfText).includes("\\u0002"), true);
  assert.equal(JSON.stringify(startOfText).includes(startOfText), false);
  assert.notEqual(JSON.stringify(startOfText), '"' + startOfText + '"');
  assert.notEqual(JSON.stringify(startOfText), '"\\u0006"');
  assert.notEqual(JSON.stringify(startOfText), '"\\u0004"');
  assert.notEqual(JSON.stringify(startOfText), '"\\n"');
  assert.equal(JSON.stringify(acknowledge), '"\\u0006"');
  assert.equal(JSON.stringify(acknowledge).includes("\\u0006"), true);
  assert.equal(JSON.stringify(acknowledge).includes(acknowledge), false);
  assert.notEqual(JSON.stringify(acknowledge), '"' + acknowledge + '"');
  assert.notEqual(JSON.stringify(acknowledge), '"\\u0002"');
  assert.equal(JSON.stringify(endOfTransmission), '"\\u0004"');
  assert.equal(JSON.stringify(endOfTransmission).includes("\\u0004"), true);
  assert.equal(JSON.stringify(endOfTransmission).includes(endOfTransmission), false);
  assert.notEqual(JSON.stringify(endOfTransmission), '"' + endOfTransmission + '"');
  assert.notEqual(JSON.stringify(endOfTransmission), '"\\u0002"');
  assert.equal(JSON.stringify(newline), '"\\n"');
  assert.equal(JSON.stringify(newline).includes("\\n"), true);
  assert.equal(JSON.stringify(newline).includes(newline), false);
  assert.notEqual(JSON.stringify(newline), '"' + newline + '"');
  assert.notEqual(JSON.stringify(newline), '"\\u000a"');
  assert.notEqual(JSON.stringify(newline), '"\\u0002"');
  assert.notEqual(JSON.stringify(startOfText), JSON.stringify(acknowledge));
  assert.notEqual(JSON.stringify(startOfText), JSON.stringify(endOfTransmission));
  assert.notEqual(JSON.stringify(startOfText), JSON.stringify(newline));

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
  assert.ok(target, "a real item has a legal choice that can take an interior start-of-text character");
  const legal = target.options.find(option => uuid.test(option.id)).id;
  assert.equal(questions.some(question => question.id === target.id), true);
  assert.equal(target.options.some(option => option.id === legal), true);
  assert.equal(uuid.test(legal), true);
  assert.equal(uuid.test(target.id), true);
  assert.equal(legal.length, 36);
  assert.equal(legal.includes(startOfText), false);
  assert.equal(legal.includes(acknowledge), false);
  assert.equal(legal.includes(endOfTransmission), false);
  assert.equal(legal.includes(newline), false);
  assert.equal(legal.trim(), legal);

  const inserted = insertedInMiddle(legal, startOfText);
  const broken = inserted.value;
  const at = inserted.at;
  const acknowledgeMiddle = insertedInMiddle(legal, acknowledge).value;
  const endOfTransmissionMiddle = insertedInMiddle(legal, endOfTransmission).value;
  const newlineMiddle = insertedInMiddle(legal, newline).value;
  assert.ok(at > 0 && at < legal.length);
  assert.equal(at, 18);
  assert.equal(legal.charCodeAt(at), 0x002D);
  assert.equal(broken.charCodeAt(at), 0x0002);
  assert.equal(broken.charCodeAt(at + 1), 0x002D);
  assert.notEqual(broken.charCodeAt(at), 0x0006);
  assert.notEqual(broken.charCodeAt(at), 0x0004);
  assert.notEqual(broken.charCodeAt(at), 0x000A);
  assert.equal(broken.slice(0, at), legal.slice(0, at));
  assert.equal(broken.slice(at + 1), legal.slice(at));
  assert.equal(broken.length, legal.length + 1);
  assert.notEqual(broken, legal);
  assert.equal(broken.replace(startOfText, ""), legal);
  assert.equal([...broken].filter(char => char === startOfText).length, 1);
  assert.equal(broken.indexOf(startOfText), at);
  assert.equal(broken.startsWith(startOfText), false);
  assert.equal(broken.endsWith(startOfText), false);
  assert.notEqual(broken, startOfText + legal);
  assert.notEqual(broken, legal + startOfText);
  assert.notEqual(broken, acknowledgeMiddle);
  assert.notEqual(broken, endOfTransmissionMiddle);
  assert.notEqual(broken, newlineMiddle);
  assert.equal(broken.trim(), broken);
  assert.notEqual(broken.trim(), legal);
  assert.notEqual(broken.trim(), "");
  assert.equal((startOfText + legal).trim(), startOfText + legal);
  assert.notEqual((startOfText + legal).trim(), legal);
  assert.equal((legal + startOfText).trim(), legal + startOfText);
  assert.notEqual((legal + startOfText).trim(), legal);
  assert.equal((acknowledge + legal).trim(), acknowledge + legal);
  assert.equal((endOfTransmission + legal).trim(), endOfTransmission + legal);
  assert.equal((newline + legal).trim(), legal);
  assert.notEqual((newline + legal).trim(), newline + legal);
  assert.equal((legal + newline).trim(), legal);
  assert.notEqual((legal + newline).trim(), legal + newline);
  assert.equal(acknowledgeMiddle.trim(), acknowledgeMiddle);
  assert.notEqual(acknowledgeMiddle.trim(), legal);
  assert.equal(endOfTransmissionMiddle.trim(), endOfTransmissionMiddle);
  assert.notEqual(endOfTransmissionMiddle.trim(), legal);
  assert.equal(newlineMiddle.trim(), newlineMiddle);
  assert.notEqual(newlineMiddle.trim(), legal);
  assert.notEqual(newlineMiddle.trim(), "");
  assert.equal(/\s/.test(broken), false);
  assert.equal(/\s/.test(acknowledgeMiddle), false);
  assert.equal(/\s/.test(endOfTransmissionMiddle), false);
  assert.equal(/\s/.test(newlineMiddle), true);
  assert.equal(/\p{Cc}/u.test(broken), true);
  assert.equal(/\p{White_Space}/u.test(broken), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(broken), false);
  assert.equal(/\p{White_Space}/u.test(acknowledgeMiddle), false);
  assert.equal(/\p{White_Space}/u.test(endOfTransmissionMiddle), false);
  assert.equal(/\p{White_Space}/u.test(newlineMiddle), true);
  assert.equal(/\p{Pattern_White_Space}/u.test(newlineMiddle), true);
  assert.equal(broken.includes(acknowledge), false);
  assert.equal(broken.includes(endOfTransmission), false);
  assert.equal(broken.includes(newline), false);
  assert.equal(acknowledgeMiddle.charCodeAt(at), 0x0006);
  assert.equal(acknowledgeMiddle.includes(startOfText), false);
  assert.equal(acknowledgeMiddle.includes(endOfTransmission), false);
  assert.equal(acknowledgeMiddle.includes(newline), false);
  assert.equal(endOfTransmissionMiddle.charCodeAt(at), 0x0004);
  assert.equal(endOfTransmissionMiddle.includes(startOfText), false);
  assert.equal(endOfTransmissionMiddle.includes(acknowledge), false);
  assert.equal(endOfTransmissionMiddle.includes(newline), false);
  assert.equal(newlineMiddle.charCodeAt(at), 0x000A);
  assert.equal(newlineMiddle.includes(startOfText), false);
  assert.equal(newlineMiddle.includes(acknowledge), false);
  assert.equal(newlineMiddle.includes(endOfTransmission), false);
  assert.equal(uuid.test(broken), false);
  const optionIds = questions.flatMap(question => question.options.map(option => option.id));
  assert.equal(optionIds.includes(legal), true);
  assert.equal(optionIds.includes(broken), false);
  assert.equal(optionIds.includes(acknowledgeMiddle), false);
  assert.equal(optionIds.includes(endOfTransmissionMiddle), false);
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
  assert.equal(payload.choices[0].charCodeAt(at), 0x0002);
  assert.equal(roundTrip.choices[0], broken);
  assert.equal(roundTrip.choices[0].charCodeAt(at), 0x0002);
  assert.notEqual(roundTrip.choices[0].charCodeAt(at), 0x0006);
  assert.notEqual(roundTrip.choices[0].charCodeAt(at), 0x0004);
  assert.notEqual(roundTrip.choices[0].charCodeAt(at), 0x000A);
  assert.equal(payload.choices[0] === legal, false);
  assert.equal(payload.choices[0] === acknowledgeMiddle, false);
  assert.equal(payload.choices[0] === endOfTransmissionMiddle, false);
  assert.equal(payload.choices[0] === newlineMiddle, false);
  assert.equal(raw.includes(startOfText), false);
  assert.equal(raw.includes("\\u0002"), true);
  assert.equal(raw.includes(acknowledge), false);
  assert.equal(raw.includes("\\u0006"), false);
  assert.equal(raw.includes(endOfTransmission), false);
  assert.equal(raw.includes("\\u0004"), false);
  assert.equal(raw.includes(newline), false);
  assert.equal(raw.includes("\\n"), false);
  assert.equal(raw.includes(legal), false);
  assert.equal(JSON.stringify(broken).includes("\\u0002"), true);
  assert.equal(JSON.stringify(broken).includes(startOfText), false);
  assert.equal(JSON.stringify(broken).includes("\\u0006"), false);
  assert.equal(JSON.stringify(broken).includes("\\u0004"), false);
  assert.equal(JSON.stringify(broken).includes("\\n"), false);
  assert.equal(JSON.stringify(acknowledgeMiddle).includes("\\u0006"), true);
  assert.equal(JSON.stringify(acknowledgeMiddle).includes(acknowledge), false);
  assert.equal(JSON.stringify(acknowledgeMiddle).includes("\\u0002"), false);
  assert.equal(JSON.stringify(acknowledgeMiddle).includes(startOfText), false);
  assert.equal(JSON.stringify(endOfTransmissionMiddle).includes("\\u0004"), true);
  assert.equal(JSON.stringify(endOfTransmissionMiddle).includes(endOfTransmission), false);
  assert.equal(JSON.stringify(endOfTransmissionMiddle).includes("\\u0002"), false);
  assert.equal(JSON.stringify(endOfTransmissionMiddle).includes(startOfText), false);
  assert.equal(JSON.stringify(newlineMiddle).includes("\\n"), true);
  assert.equal(JSON.stringify(newlineMiddle).includes(newline), false);
  assert.equal(JSON.stringify(newlineMiddle).includes("\\u000a"), false);
  assert.equal(JSON.stringify(newlineMiddle).includes("\\u0002"), false);
  assert.equal(JSON.stringify(newlineMiddle).includes(startOfText), false);
  assert.notEqual(JSON.stringify(broken), JSON.stringify(acknowledgeMiddle));
  assert.notEqual(JSON.stringify(broken), JSON.stringify(endOfTransmissionMiddle));
  assert.notEqual(JSON.stringify(broken), JSON.stringify(newlineMiddle));
  f.resetWrites();
  const refused = await read(await f.req("/api/answers", "PUT", payload, { cookie }));
  assert.equal(refused.status, 422, JSON.stringify(refused.body));
  assert.equal(refused.body.error, "Choose an available answer.");
  assert.equal(refused.headers.get("Set-Cookie"), null);
  assert.equal(refused.text.includes(secret), false);
  assert.equal(refused.text.includes(sessionSecret), false);
  assert.equal(refused.text.includes(broken), false);
  assert.equal(refused.text.includes(startOfText), false);
  assert.equal(refused.text.includes("\\u0002"), false);
  assert.equal(refused.text.includes(acknowledge), false);
  assert.equal(refused.text.includes("\\u0006"), false);
  assert.equal(refused.text.includes(endOfTransmission), false);
  assert.equal(refused.text.includes("\\u0004"), false);
  assert.equal(refused.text.includes(newline), false);
  assert.equal(refused.text.includes("\\n"), false);
  assert.equal(refused.text.includes(legal), false);
  assert.deepEqual(f.written, []);

  const after = stored(f, reference);
  assert.deepEqual(after, snapshot);
  assert.deepEqual(after.answers, {});
  assert.equal(Object.hasOwn(after.answers, target.id), false);
  assert.equal(JSON.stringify(after.answers).includes(startOfText), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u0002"), false);
  assert.equal(JSON.stringify(after.answers).includes(newline), false);
  assert.equal(JSON.stringify(after.answers).includes("\\n"), false);
  assert.equal(JSON.stringify(after.answers).includes(legal), false);
  assert.equal(JSON.stringify(after).includes(startOfText), false);
  assert.equal(JSON.stringify(after).includes("\\u0002"), false);
  assert.equal(JSON.stringify(after).includes(acknowledge), false);
  assert.equal(JSON.stringify(after).includes("\\u0006"), false);
  assert.equal(JSON.stringify(after).includes(endOfTransmission), false);
  assert.equal(JSON.stringify(after).includes("\\u0004"), false);
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
  assert.equal(viewed.text.includes(startOfText), false);
  assert.equal(viewed.text.includes("\\u0002"), false);
  assert.equal(viewed.text.includes(acknowledge), false);
  assert.equal(viewed.text.includes("\\u0006"), false);
  assert.equal(viewed.text.includes(endOfTransmission), false);
  assert.equal(viewed.text.includes("\\u0004"), false);
  assert.equal(f.records.get(reference).etag, openedEtag);
  assert.equal(stored(f, reference).inviteHash, inviteHash);
  assert.equal(stored(f, reference).sessionHash, sessionHash);
  assert.deepEqual(stored(f, reference).answers, {});
});
