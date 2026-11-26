import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import worker, { Assessment } from "../src/worker.js";

// One live hiring sitting. Save an answer for a real item on this paper
// whose choice id is that item's legal choice string with a
// single-shift-three character (U+008F) inserted in the middle.
// The save is refused. No answer is stored. The invite hash and the
// session secret stay unchanged.
// A single-shift-two character in the middle, a
// reverse-line-feed character in the middle, and a
// partial-line-backward character in the middle are separate checks.

const origin = "https://assessment.example";
const notice = {
  controller: "Test controller", contact: "privacy@example.invalid", basis: "Test basis",
  recipients: "Test reviewer", transfers: "Test transfer description", rights: "Test rights",
  purpose: "Test purpose", supervisoryAuthority: "Test authority", version: "test-1", retentionMinutes: 30,
};
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const random = () => crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
const singleShiftThree = "\u008f";
const singleShiftTwo = "\u008e";
const reverseLineFeed = "\u008d";
const partialLineBackward = "\u008c";

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

test("a legal choice with a single-shift-three character inserted in the middle is refused and stores nothing", async () => {
  const source = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(source, /"LIVE_ENABLED": "false"/);
  assert.equal(singleShiftThree, "\u008f");
  assert.equal(singleShiftThree.charCodeAt(0), 0x008f);
  assert.equal(singleShiftThree.codePointAt(0), 0x008f);
  assert.equal(singleShiftThree.length, 1);
  assert.notEqual(singleShiftThree, singleShiftTwo);
  assert.notEqual(singleShiftThree.charCodeAt(0), 0x008e);
  assert.notEqual(singleShiftThree, reverseLineFeed);
  assert.notEqual(singleShiftThree.charCodeAt(0), 0x008d);
  assert.notEqual(singleShiftThree, partialLineBackward);
  assert.notEqual(singleShiftThree.charCodeAt(0), 0x008c);
  assert.equal(partialLineBackward, "\u008c");
  assert.equal(partialLineBackward.charCodeAt(0), 0x008c);
  assert.equal(partialLineBackward.codePointAt(0), 0x008c);
  assert.equal(partialLineBackward.length, 1);
  assert.equal(reverseLineFeed, "\u008d");
  assert.equal(reverseLineFeed.charCodeAt(0), 0x008d);
  assert.equal(reverseLineFeed.codePointAt(0), 0x008d);
  assert.equal(reverseLineFeed.length, 1);
  assert.equal(singleShiftTwo, "\u008e");
  assert.equal(singleShiftTwo.charCodeAt(0), 0x008e);
  assert.equal(singleShiftTwo.codePointAt(0), 0x008e);
  assert.equal(singleShiftTwo.length, 1);
  assert.equal(/\s/.test(singleShiftThree), false);
  assert.equal(/\s/.test(partialLineBackward), false);
  assert.equal(/\s/.test(reverseLineFeed), false);
  assert.equal(/\s/.test(singleShiftTwo), false);
  assert.equal(/\p{Cc}/u.test(singleShiftThree), true);
  assert.equal(/\p{Cf}/u.test(singleShiftThree), false);
  assert.equal(/\p{Zl}/u.test(singleShiftThree), false);
  assert.equal(/\p{Zp}/u.test(singleShiftThree), false);
  assert.equal(/\p{Zs}/u.test(singleShiftThree), false);
  assert.equal(/\p{White_Space}/u.test(singleShiftThree), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(singleShiftThree), false);
  assert.equal(/\p{Cc}/u.test(partialLineBackward), true);
  assert.equal(/\p{Cf}/u.test(partialLineBackward), false);
  assert.equal(/\p{White_Space}/u.test(partialLineBackward), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(partialLineBackward), false);
  assert.equal(/\p{Cc}/u.test(reverseLineFeed), true);
  assert.equal(/\p{Cf}/u.test(reverseLineFeed), false);
  assert.equal(/\p{White_Space}/u.test(reverseLineFeed), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(reverseLineFeed), false);
  assert.equal(/\p{Cc}/u.test(singleShiftTwo), true);
  assert.equal(/\p{Cf}/u.test(singleShiftTwo), false);
  assert.equal(/\p{White_Space}/u.test(singleShiftTwo), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(singleShiftTwo), false);
  assert.equal(singleShiftThree.trim(), singleShiftThree);
  assert.notEqual(singleShiftThree.trim(), "");
  assert.equal(partialLineBackward.trim(), partialLineBackward);
  assert.notEqual(partialLineBackward.trim(), "");
  assert.equal(reverseLineFeed.trim(), reverseLineFeed);
  assert.notEqual(reverseLineFeed.trim(), "");
  assert.equal(singleShiftTwo.trim(), singleShiftTwo);
  assert.notEqual(singleShiftTwo.trim(), "");
  assert.equal(JSON.stringify(singleShiftThree), '"' + singleShiftThree + '"');
  assert.equal(JSON.stringify(singleShiftThree).includes(singleShiftThree), true);
  assert.equal(JSON.stringify(singleShiftThree).includes("\\"), false);
  assert.equal(JSON.stringify(singleShiftThree).includes("\\u008f"), false);
  assert.notEqual(JSON.stringify(singleShiftThree), '"\\u008f"');
  assert.equal(JSON.stringify(partialLineBackward), '"' + partialLineBackward + '"');
  assert.equal(JSON.stringify(partialLineBackward).includes(partialLineBackward), true);
  assert.equal(JSON.stringify(partialLineBackward).includes("\\"), false);
  assert.equal(JSON.stringify(partialLineBackward).includes("\\u008c"), false);
  assert.notEqual(JSON.stringify(partialLineBackward), '"\\u008c"');
  assert.notEqual(JSON.stringify(partialLineBackward), '"\\u008f"');
  assert.equal(JSON.stringify(reverseLineFeed), '"' + reverseLineFeed + '"');
  assert.equal(JSON.stringify(reverseLineFeed).includes(reverseLineFeed), true);
  assert.equal(JSON.stringify(reverseLineFeed).includes("\\"), false);
  assert.equal(JSON.stringify(reverseLineFeed).includes("\\u008d"), false);
  assert.notEqual(JSON.stringify(reverseLineFeed), '"\\u008d"');
  assert.notEqual(JSON.stringify(reverseLineFeed), '"\\u008f"');
  assert.equal(JSON.stringify(singleShiftTwo), '"' + singleShiftTwo + '"');
  assert.equal(JSON.stringify(singleShiftTwo).includes(singleShiftTwo), true);
  assert.equal(JSON.stringify(singleShiftTwo).includes("\\"), false);
  assert.equal(JSON.stringify(singleShiftTwo).includes("\\u008e"), false);
  assert.notEqual(JSON.stringify(singleShiftTwo), '"\\u008e"');
  assert.notEqual(JSON.stringify(singleShiftTwo), '"\\u008f"');
  assert.notEqual(JSON.stringify(singleShiftThree), JSON.stringify(partialLineBackward));
  assert.notEqual(JSON.stringify(singleShiftThree), JSON.stringify(reverseLineFeed));
  assert.notEqual(JSON.stringify(singleShiftThree), JSON.stringify(singleShiftTwo));

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
  assert.ok(target, "a real item has a legal choice that can take an interior single-shift-three character");
  const legal = target.options.find(option => uuid.test(option.id)).id;
  assert.equal(questions.some(question => question.id === target.id), true);
  assert.equal(target.options.some(option => option.id === legal), true);
  assert.equal(uuid.test(legal), true);
  assert.equal(uuid.test(target.id), true);
  assert.equal(legal.length, 36);
  assert.equal(legal.includes(singleShiftThree), false);
  assert.equal(legal.includes(partialLineBackward), false);
  assert.equal(legal.includes(reverseLineFeed), false);
  assert.equal(legal.includes(singleShiftTwo), false);
  assert.equal(legal.trim(), legal);

  const inserted = insertedInMiddle(legal, singleShiftThree);
  const broken = inserted.value;
  const at = inserted.at;
  const partialLineBackwardMiddle = insertedInMiddle(legal, partialLineBackward).value;
  const reverseLineFeedMiddle = insertedInMiddle(legal, reverseLineFeed).value;
  const singleShiftTwoMiddle = insertedInMiddle(legal, singleShiftTwo).value;
  assert.ok(at > 0 && at < legal.length);
  assert.equal(at, 18);
  assert.equal(legal.charCodeAt(at), 0x002D);
  assert.equal(broken.charCodeAt(at), 0x008f);
  assert.equal(broken.charCodeAt(at + 1), 0x002D);
  assert.notEqual(broken.charCodeAt(at), 0x008e);
  assert.notEqual(broken.charCodeAt(at), 0x008d);
  assert.notEqual(broken.charCodeAt(at), 0x008c);
  assert.equal(broken.slice(0, at), legal.slice(0, at));
  assert.equal(broken.slice(at + 1), legal.slice(at));
  assert.equal(broken.length, legal.length + 1);
  assert.notEqual(broken, legal);
  assert.equal(broken.replace(singleShiftThree, ""), legal);
  assert.equal([...broken].filter(char => char === singleShiftThree).length, 1);
  assert.equal(broken.indexOf(singleShiftThree), at);
  assert.equal(broken.startsWith(singleShiftThree), false);
  assert.equal(broken.endsWith(singleShiftThree), false);
  assert.notEqual(broken, singleShiftThree + legal);
  assert.notEqual(broken, legal + singleShiftThree);
  assert.notEqual(broken, partialLineBackwardMiddle);
  assert.notEqual(broken, reverseLineFeedMiddle);
  assert.notEqual(broken, singleShiftTwoMiddle);
  assert.equal(broken.trim(), broken);
  assert.notEqual(broken.trim(), legal);
  assert.notEqual(broken.trim(), "");
  assert.equal((singleShiftThree + legal).trim(), singleShiftThree + legal);
  assert.notEqual((singleShiftThree + legal).trim(), legal);
  assert.equal((legal + singleShiftThree).trim(), legal + singleShiftThree);
  assert.notEqual((legal + singleShiftThree).trim(), legal);
  assert.equal((partialLineBackward + legal).trim(), partialLineBackward + legal);
  assert.notEqual((partialLineBackward + legal).trim(), legal);
  assert.equal((legal + partialLineBackward).trim(), legal + partialLineBackward);
  assert.notEqual((legal + partialLineBackward).trim(), legal);
  assert.equal((reverseLineFeed + legal).trim(), reverseLineFeed + legal);
  assert.notEqual((reverseLineFeed + legal).trim(), legal);
  assert.equal((legal + reverseLineFeed).trim(), legal + reverseLineFeed);
  assert.notEqual((legal + reverseLineFeed).trim(), legal);
  assert.equal((singleShiftTwo + legal).trim(), singleShiftTwo + legal);
  assert.notEqual((singleShiftTwo + legal).trim(), legal);
  assert.equal((legal + singleShiftTwo).trim(), legal + singleShiftTwo);
  assert.notEqual((legal + singleShiftTwo).trim(), legal);
  assert.equal(partialLineBackwardMiddle.trim(), partialLineBackwardMiddle);
  assert.notEqual(partialLineBackwardMiddle.trim(), legal);
  assert.equal(reverseLineFeedMiddle.trim(), reverseLineFeedMiddle);
  assert.notEqual(reverseLineFeedMiddle.trim(), legal);
  assert.equal(singleShiftTwoMiddle.trim(), singleShiftTwoMiddle);
  assert.notEqual(singleShiftTwoMiddle.trim(), legal);
  assert.notEqual(singleShiftTwoMiddle.trim(), "");
  assert.equal(/\s/.test(broken), false);
  assert.equal(/\s/.test(partialLineBackwardMiddle), false);
  assert.equal(/\s/.test(reverseLineFeedMiddle), false);
  assert.equal(/\s/.test(singleShiftTwoMiddle), false);
  assert.equal(/\p{Cc}/u.test(broken), true);
  assert.equal(/\p{White_Space}/u.test(broken), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(broken), false);
  assert.equal(/\p{White_Space}/u.test(partialLineBackwardMiddle), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(partialLineBackwardMiddle), false);
  assert.equal(/\p{White_Space}/u.test(reverseLineFeedMiddle), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(reverseLineFeedMiddle), false);
  assert.equal(/\p{White_Space}/u.test(singleShiftTwoMiddle), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(singleShiftTwoMiddle), false);
  assert.equal(broken.includes(partialLineBackward), false);
  assert.equal(broken.includes(reverseLineFeed), false);
  assert.equal(broken.includes(singleShiftTwo), false);
  assert.equal(partialLineBackwardMiddle.charCodeAt(at), 0x008c);
  assert.equal(partialLineBackwardMiddle.includes(singleShiftThree), false);
  assert.equal(partialLineBackwardMiddle.includes(reverseLineFeed), false);
  assert.equal(partialLineBackwardMiddle.includes(singleShiftTwo), false);
  assert.equal(reverseLineFeedMiddle.charCodeAt(at), 0x008d);
  assert.equal(reverseLineFeedMiddle.includes(singleShiftThree), false);
  assert.equal(reverseLineFeedMiddle.includes(partialLineBackward), false);
  assert.equal(reverseLineFeedMiddle.includes(singleShiftTwo), false);
  assert.equal(singleShiftTwoMiddle.charCodeAt(at), 0x008e);
  assert.equal(singleShiftTwoMiddle.includes(singleShiftThree), false);
  assert.equal(singleShiftTwoMiddle.includes(partialLineBackward), false);
  assert.equal(singleShiftTwoMiddle.includes(reverseLineFeed), false);
  assert.equal(uuid.test(broken), false);
  const optionIds = questions.flatMap(question => question.options.map(option => option.id));
  assert.equal(optionIds.includes(legal), true);
  assert.equal(optionIds.includes(broken), false);
  assert.equal(optionIds.includes(partialLineBackwardMiddle), false);
  assert.equal(optionIds.includes(reverseLineFeedMiddle), false);
  assert.equal(optionIds.includes(singleShiftTwoMiddle), false);
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
  assert.equal(payload.choices[0].charCodeAt(at), 0x008f);
  assert.equal(roundTrip.choices[0], broken);
  assert.equal(roundTrip.choices[0].charCodeAt(at), 0x008f);
  assert.notEqual(roundTrip.choices[0].charCodeAt(at), 0x008e);
  assert.notEqual(roundTrip.choices[0].charCodeAt(at), 0x008d);
  assert.notEqual(roundTrip.choices[0].charCodeAt(at), 0x008c);
  assert.equal(payload.choices[0] === legal, false);
  assert.equal(payload.choices[0] === partialLineBackwardMiddle, false);
  assert.equal(payload.choices[0] === reverseLineFeedMiddle, false);
  assert.equal(payload.choices[0] === singleShiftTwoMiddle, false);
  assert.equal(raw.includes(singleShiftThree), true);
  assert.equal(raw.includes("\\u008f"), false);
  assert.equal(raw.includes(partialLineBackward), false);
  assert.equal(raw.includes("\\u008c"), false);
  assert.equal(raw.includes(reverseLineFeed), false);
  assert.equal(raw.includes("\\u008d"), false);
  assert.equal(raw.includes(singleShiftTwo), false);
  assert.equal(raw.includes("\\u008e"), false);
  assert.equal(raw.includes(legal), false);
  assert.equal(JSON.stringify(broken).includes(singleShiftThree), true);
  assert.equal(JSON.stringify(broken).includes("\\"), false);
  assert.equal(JSON.stringify(broken).includes("\\u008f"), false);
  assert.equal(JSON.stringify(broken).includes("\\u008c"), false);
  assert.equal(JSON.stringify(broken).includes("\\u008d"), false);
  assert.equal(JSON.stringify(broken).includes("\\u008e"), false);
  assert.equal(JSON.stringify(partialLineBackwardMiddle).includes(partialLineBackward), true);
  assert.equal(JSON.stringify(partialLineBackwardMiddle).includes("\\"), false);
  assert.equal(JSON.stringify(partialLineBackwardMiddle).includes("\\u008c"), false);
  assert.equal(JSON.stringify(partialLineBackwardMiddle).includes("\\u008f"), false);
  assert.equal(JSON.stringify(partialLineBackwardMiddle).includes(singleShiftThree), false);
  assert.equal(JSON.stringify(reverseLineFeedMiddle).includes(reverseLineFeed), true);
  assert.equal(JSON.stringify(reverseLineFeedMiddle).includes("\\"), false);
  assert.equal(JSON.stringify(reverseLineFeedMiddle).includes("\\u008d"), false);
  assert.equal(JSON.stringify(reverseLineFeedMiddle).includes("\\u008f"), false);
  assert.equal(JSON.stringify(reverseLineFeedMiddle).includes(singleShiftThree), false);
  assert.equal(JSON.stringify(singleShiftTwoMiddle).includes(singleShiftTwo), true);
  assert.equal(JSON.stringify(singleShiftTwoMiddle).includes("\\"), false);
  assert.equal(JSON.stringify(singleShiftTwoMiddle).includes("\\u008e"), false);
  assert.equal(JSON.stringify(singleShiftTwoMiddle).includes("\\u008f"), false);
  assert.equal(JSON.stringify(singleShiftTwoMiddle).includes(singleShiftThree), false);
  assert.notEqual(JSON.stringify(broken), JSON.stringify(partialLineBackwardMiddle));
  assert.notEqual(JSON.stringify(broken), JSON.stringify(reverseLineFeedMiddle));
  assert.notEqual(JSON.stringify(broken), JSON.stringify(singleShiftTwoMiddle));
  f.resetWrites();
  const refused = await read(await f.req("/api/answers", "PUT", payload, { cookie }));
  assert.equal(refused.status, 422, JSON.stringify(refused.body));
  assert.equal(refused.body.error, "Choose an available answer.");
  assert.equal(refused.headers.get("Set-Cookie"), null);
  assert.equal(refused.text.includes(secret), false);
  assert.equal(refused.text.includes(sessionSecret), false);
  assert.equal(refused.text.includes(broken), false);
  assert.equal(refused.text.includes(singleShiftThree), false);
  assert.equal(refused.text.includes("\\u008f"), false);
  assert.equal(refused.text.includes(partialLineBackward), false);
  assert.equal(refused.text.includes("\\u008c"), false);
  assert.equal(refused.text.includes(reverseLineFeed), false);
  assert.equal(refused.text.includes("\\u008d"), false);
  assert.equal(refused.text.includes(singleShiftTwo), false);
  assert.equal(refused.text.includes("\\u008e"), false);
  assert.equal(refused.text.includes(legal), false);
  assert.deepEqual(f.written, []);

  const after = stored(f, reference);
  assert.deepEqual(after, snapshot);
  assert.deepEqual(after.answers, {});
  assert.equal(Object.hasOwn(after.answers, target.id), false);
  assert.equal(JSON.stringify(after.answers).includes(singleShiftThree), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u008f"), false);
  assert.equal(JSON.stringify(after.answers).includes(partialLineBackward), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u008c"), false);
  assert.equal(JSON.stringify(after.answers).includes(reverseLineFeed), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u008d"), false);
  assert.equal(JSON.stringify(after.answers).includes(legal), false);
  assert.equal(JSON.stringify(after).includes(singleShiftThree), false);
  assert.equal(JSON.stringify(after).includes("\\u008f"), false);
  assert.equal(JSON.stringify(after).includes(partialLineBackward), false);
  assert.equal(JSON.stringify(after).includes("\\u008c"), false);
  assert.equal(JSON.stringify(after).includes(reverseLineFeed), false);
  assert.equal(JSON.stringify(after).includes("\\u008d"), false);
  assert.equal(JSON.stringify(after).includes(singleShiftTwo), false);
  assert.equal(JSON.stringify(after).includes("\\u008e"), false);
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
  assert.equal(viewed.text.includes(singleShiftThree), false);
  assert.equal(viewed.text.includes("\\u008f"), false);
  assert.equal(viewed.text.includes(partialLineBackward), false);
  assert.equal(viewed.text.includes("\\u008c"), false);
  assert.equal(viewed.text.includes(reverseLineFeed), false);
  assert.equal(viewed.text.includes("\\u008d"), false);
  assert.equal(viewed.text.includes(singleShiftTwo), false);
  assert.equal(viewed.text.includes("\\u008e"), false);
  assert.equal(f.records.get(reference).etag, openedEtag);
  assert.equal(stored(f, reference).inviteHash, inviteHash);
  assert.equal(stored(f, reference).sessionHash, sessionHash);
  assert.deepEqual(stored(f, reference).answers, {});
});
