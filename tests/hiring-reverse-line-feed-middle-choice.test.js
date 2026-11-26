import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import worker, { Assessment } from "../src/worker.js";

// One live hiring sitting. Save an answer for a real item on this paper
// whose choice id is that item's legal choice string with a
// reverse-line-feed character (U+008D) inserted in the middle.
// The save is refused. No answer is stored. The invite hash and the
// session secret stay unchanged.
// A partial-line-backward character in the middle, a
// partial-line-forward character in the middle, and a
// line-tabulation-set character in the middle are separate checks.

const origin = "https://assessment.example";
const notice = {
  controller: "Test controller", contact: "privacy@example.invalid", basis: "Test basis",
  recipients: "Test reviewer", transfers: "Test transfer description", rights: "Test rights",
  purpose: "Test purpose", supervisoryAuthority: "Test authority", version: "test-1", retentionMinutes: 30,
};
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const random = () => crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
const reverseLineFeed = "\u008d";
const partialLineBackward = "\u008c";
const partialLineForward = "\u008b";
const lineTabulationSet = "\u008a";

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

test("a legal choice with a reverse-line-feed character inserted in the middle is refused and stores nothing", async () => {
  const source = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(source, /"LIVE_ENABLED": "false"/);
  assert.equal(reverseLineFeed, "\u008d");
  assert.equal(reverseLineFeed.charCodeAt(0), 0x008d);
  assert.equal(reverseLineFeed.codePointAt(0), 0x008d);
  assert.equal(reverseLineFeed.length, 1);
  assert.notEqual(reverseLineFeed, partialLineBackward);
  assert.notEqual(reverseLineFeed.charCodeAt(0), 0x008c);
  assert.notEqual(reverseLineFeed, partialLineForward);
  assert.notEqual(reverseLineFeed.charCodeAt(0), 0x008b);
  assert.notEqual(reverseLineFeed, lineTabulationSet);
  assert.notEqual(reverseLineFeed.charCodeAt(0), 0x008a);
  assert.equal(lineTabulationSet, "\u008a");
  assert.equal(lineTabulationSet.charCodeAt(0), 0x008a);
  assert.equal(lineTabulationSet.codePointAt(0), 0x008a);
  assert.equal(lineTabulationSet.length, 1);
  assert.equal(partialLineForward, "\u008b");
  assert.equal(partialLineForward.charCodeAt(0), 0x008b);
  assert.equal(partialLineForward.codePointAt(0), 0x008b);
  assert.equal(partialLineForward.length, 1);
  assert.equal(partialLineBackward, "\u008c");
  assert.equal(partialLineBackward.charCodeAt(0), 0x008c);
  assert.equal(partialLineBackward.codePointAt(0), 0x008c);
  assert.equal(partialLineBackward.length, 1);
  assert.equal(/\s/.test(reverseLineFeed), false);
  assert.equal(/\s/.test(lineTabulationSet), false);
  assert.equal(/\s/.test(partialLineForward), false);
  assert.equal(/\s/.test(partialLineBackward), false);
  assert.equal(/\p{Cc}/u.test(reverseLineFeed), true);
  assert.equal(/\p{Cf}/u.test(reverseLineFeed), false);
  assert.equal(/\p{Zl}/u.test(reverseLineFeed), false);
  assert.equal(/\p{Zp}/u.test(reverseLineFeed), false);
  assert.equal(/\p{Zs}/u.test(reverseLineFeed), false);
  assert.equal(/\p{White_Space}/u.test(reverseLineFeed), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(reverseLineFeed), false);
  assert.equal(/\p{Cc}/u.test(lineTabulationSet), true);
  assert.equal(/\p{Cf}/u.test(lineTabulationSet), false);
  assert.equal(/\p{White_Space}/u.test(lineTabulationSet), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(lineTabulationSet), false);
  assert.equal(/\p{Cc}/u.test(partialLineForward), true);
  assert.equal(/\p{Cf}/u.test(partialLineForward), false);
  assert.equal(/\p{White_Space}/u.test(partialLineForward), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(partialLineForward), false);
  assert.equal(/\p{Cc}/u.test(partialLineBackward), true);
  assert.equal(/\p{Cf}/u.test(partialLineBackward), false);
  assert.equal(/\p{White_Space}/u.test(partialLineBackward), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(partialLineBackward), false);
  assert.equal(reverseLineFeed.trim(), reverseLineFeed);
  assert.notEqual(reverseLineFeed.trim(), "");
  assert.equal(lineTabulationSet.trim(), lineTabulationSet);
  assert.notEqual(lineTabulationSet.trim(), "");
  assert.equal(partialLineForward.trim(), partialLineForward);
  assert.notEqual(partialLineForward.trim(), "");
  assert.equal(partialLineBackward.trim(), partialLineBackward);
  assert.notEqual(partialLineBackward.trim(), "");
  assert.equal(JSON.stringify(reverseLineFeed), '"' + reverseLineFeed + '"');
  assert.equal(JSON.stringify(reverseLineFeed).includes(reverseLineFeed), true);
  assert.equal(JSON.stringify(reverseLineFeed).includes("\\"), false);
  assert.equal(JSON.stringify(reverseLineFeed).includes("\\u008d"), false);
  assert.notEqual(JSON.stringify(reverseLineFeed), '"\\u008d"');
  assert.equal(JSON.stringify(lineTabulationSet), '"' + lineTabulationSet + '"');
  assert.equal(JSON.stringify(lineTabulationSet).includes(lineTabulationSet), true);
  assert.equal(JSON.stringify(lineTabulationSet).includes("\\"), false);
  assert.equal(JSON.stringify(lineTabulationSet).includes("\\u008a"), false);
  assert.notEqual(JSON.stringify(lineTabulationSet), '"\\u008a"');
  assert.notEqual(JSON.stringify(lineTabulationSet), '"\\u008d"');
  assert.equal(JSON.stringify(partialLineForward), '"' + partialLineForward + '"');
  assert.equal(JSON.stringify(partialLineForward).includes(partialLineForward), true);
  assert.equal(JSON.stringify(partialLineForward).includes("\\"), false);
  assert.equal(JSON.stringify(partialLineForward).includes("\\u008b"), false);
  assert.notEqual(JSON.stringify(partialLineForward), '"\\u008b"');
  assert.notEqual(JSON.stringify(partialLineForward), '"\\u008d"');
  assert.equal(JSON.stringify(partialLineBackward), '"' + partialLineBackward + '"');
  assert.equal(JSON.stringify(partialLineBackward).includes(partialLineBackward), true);
  assert.equal(JSON.stringify(partialLineBackward).includes("\\"), false);
  assert.equal(JSON.stringify(partialLineBackward).includes("\\u008c"), false);
  assert.notEqual(JSON.stringify(partialLineBackward), '"\\u008c"');
  assert.notEqual(JSON.stringify(partialLineBackward), '"\\u008d"');
  assert.notEqual(JSON.stringify(reverseLineFeed), JSON.stringify(lineTabulationSet));
  assert.notEqual(JSON.stringify(reverseLineFeed), JSON.stringify(partialLineForward));
  assert.notEqual(JSON.stringify(reverseLineFeed), JSON.stringify(partialLineBackward));

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
  assert.ok(target, "a real item has a legal choice that can take an interior reverse-line-feed character");
  const legal = target.options.find(option => uuid.test(option.id)).id;
  assert.equal(questions.some(question => question.id === target.id), true);
  assert.equal(target.options.some(option => option.id === legal), true);
  assert.equal(uuid.test(legal), true);
  assert.equal(uuid.test(target.id), true);
  assert.equal(legal.length, 36);
  assert.equal(legal.includes(reverseLineFeed), false);
  assert.equal(legal.includes(lineTabulationSet), false);
  assert.equal(legal.includes(partialLineForward), false);
  assert.equal(legal.includes(partialLineBackward), false);
  assert.equal(legal.trim(), legal);

  const inserted = insertedInMiddle(legal, reverseLineFeed);
  const broken = inserted.value;
  const at = inserted.at;
  const lineTabulationSetMiddle = insertedInMiddle(legal, lineTabulationSet).value;
  const partialLineForwardMiddle = insertedInMiddle(legal, partialLineForward).value;
  const partialLineBackwardMiddle = insertedInMiddle(legal, partialLineBackward).value;
  assert.ok(at > 0 && at < legal.length);
  assert.equal(at, 18);
  assert.equal(legal.charCodeAt(at), 0x002D);
  assert.equal(broken.charCodeAt(at), 0x008d);
  assert.equal(broken.charCodeAt(at + 1), 0x002D);
  assert.notEqual(broken.charCodeAt(at), 0x008c);
  assert.notEqual(broken.charCodeAt(at), 0x008b);
  assert.notEqual(broken.charCodeAt(at), 0x008a);
  assert.equal(broken.slice(0, at), legal.slice(0, at));
  assert.equal(broken.slice(at + 1), legal.slice(at));
  assert.equal(broken.length, legal.length + 1);
  assert.notEqual(broken, legal);
  assert.equal(broken.replace(reverseLineFeed, ""), legal);
  assert.equal([...broken].filter(char => char === reverseLineFeed).length, 1);
  assert.equal(broken.indexOf(reverseLineFeed), at);
  assert.equal(broken.startsWith(reverseLineFeed), false);
  assert.equal(broken.endsWith(reverseLineFeed), false);
  assert.notEqual(broken, reverseLineFeed + legal);
  assert.notEqual(broken, legal + reverseLineFeed);
  assert.notEqual(broken, lineTabulationSetMiddle);
  assert.notEqual(broken, partialLineForwardMiddle);
  assert.notEqual(broken, partialLineBackwardMiddle);
  assert.equal(broken.trim(), broken);
  assert.notEqual(broken.trim(), legal);
  assert.notEqual(broken.trim(), "");
  assert.equal((reverseLineFeed + legal).trim(), reverseLineFeed + legal);
  assert.notEqual((reverseLineFeed + legal).trim(), legal);
  assert.equal((legal + reverseLineFeed).trim(), legal + reverseLineFeed);
  assert.notEqual((legal + reverseLineFeed).trim(), legal);
  assert.equal((lineTabulationSet + legal).trim(), lineTabulationSet + legal);
  assert.notEqual((lineTabulationSet + legal).trim(), legal);
  assert.equal((legal + lineTabulationSet).trim(), legal + lineTabulationSet);
  assert.notEqual((legal + lineTabulationSet).trim(), legal);
  assert.equal((partialLineForward + legal).trim(), partialLineForward + legal);
  assert.notEqual((partialLineForward + legal).trim(), legal);
  assert.equal((legal + partialLineForward).trim(), legal + partialLineForward);
  assert.notEqual((legal + partialLineForward).trim(), legal);
  assert.equal((partialLineBackward + legal).trim(), partialLineBackward + legal);
  assert.notEqual((partialLineBackward + legal).trim(), legal);
  assert.equal((legal + partialLineBackward).trim(), legal + partialLineBackward);
  assert.notEqual((legal + partialLineBackward).trim(), legal);
  assert.equal(lineTabulationSetMiddle.trim(), lineTabulationSetMiddle);
  assert.notEqual(lineTabulationSetMiddle.trim(), legal);
  assert.equal(partialLineForwardMiddle.trim(), partialLineForwardMiddle);
  assert.notEqual(partialLineForwardMiddle.trim(), legal);
  assert.equal(partialLineBackwardMiddle.trim(), partialLineBackwardMiddle);
  assert.notEqual(partialLineBackwardMiddle.trim(), legal);
  assert.notEqual(partialLineBackwardMiddle.trim(), "");
  assert.equal(/\s/.test(broken), false);
  assert.equal(/\s/.test(lineTabulationSetMiddle), false);
  assert.equal(/\s/.test(partialLineForwardMiddle), false);
  assert.equal(/\s/.test(partialLineBackwardMiddle), false);
  assert.equal(/\p{Cc}/u.test(broken), true);
  assert.equal(/\p{White_Space}/u.test(broken), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(broken), false);
  assert.equal(/\p{White_Space}/u.test(lineTabulationSetMiddle), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(lineTabulationSetMiddle), false);
  assert.equal(/\p{White_Space}/u.test(partialLineForwardMiddle), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(partialLineForwardMiddle), false);
  assert.equal(/\p{White_Space}/u.test(partialLineBackwardMiddle), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(partialLineBackwardMiddle), false);
  assert.equal(broken.includes(lineTabulationSet), false);
  assert.equal(broken.includes(partialLineForward), false);
  assert.equal(broken.includes(partialLineBackward), false);
  assert.equal(lineTabulationSetMiddle.charCodeAt(at), 0x008a);
  assert.equal(lineTabulationSetMiddle.includes(reverseLineFeed), false);
  assert.equal(lineTabulationSetMiddle.includes(partialLineForward), false);
  assert.equal(lineTabulationSetMiddle.includes(partialLineBackward), false);
  assert.equal(partialLineForwardMiddle.charCodeAt(at), 0x008b);
  assert.equal(partialLineForwardMiddle.includes(reverseLineFeed), false);
  assert.equal(partialLineForwardMiddle.includes(lineTabulationSet), false);
  assert.equal(partialLineForwardMiddle.includes(partialLineBackward), false);
  assert.equal(partialLineBackwardMiddle.charCodeAt(at), 0x008c);
  assert.equal(partialLineBackwardMiddle.includes(reverseLineFeed), false);
  assert.equal(partialLineBackwardMiddle.includes(lineTabulationSet), false);
  assert.equal(partialLineBackwardMiddle.includes(partialLineForward), false);
  assert.equal(uuid.test(broken), false);
  const optionIds = questions.flatMap(question => question.options.map(option => option.id));
  assert.equal(optionIds.includes(legal), true);
  assert.equal(optionIds.includes(broken), false);
  assert.equal(optionIds.includes(lineTabulationSetMiddle), false);
  assert.equal(optionIds.includes(partialLineForwardMiddle), false);
  assert.equal(optionIds.includes(partialLineBackwardMiddle), false);
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
  assert.equal(payload.choices[0].charCodeAt(at), 0x008d);
  assert.equal(roundTrip.choices[0], broken);
  assert.equal(roundTrip.choices[0].charCodeAt(at), 0x008d);
  assert.notEqual(roundTrip.choices[0].charCodeAt(at), 0x008c);
  assert.notEqual(roundTrip.choices[0].charCodeAt(at), 0x008b);
  assert.notEqual(roundTrip.choices[0].charCodeAt(at), 0x008a);
  assert.equal(payload.choices[0] === legal, false);
  assert.equal(payload.choices[0] === lineTabulationSetMiddle, false);
  assert.equal(payload.choices[0] === partialLineForwardMiddle, false);
  assert.equal(payload.choices[0] === partialLineBackwardMiddle, false);
  assert.equal(raw.includes(reverseLineFeed), true);
  assert.equal(raw.includes("\\u008d"), false);
  assert.equal(raw.includes(lineTabulationSet), false);
  assert.equal(raw.includes("\\u008a"), false);
  assert.equal(raw.includes(partialLineForward), false);
  assert.equal(raw.includes("\\u008b"), false);
  assert.equal(raw.includes(partialLineBackward), false);
  assert.equal(raw.includes("\\u008c"), false);
  assert.equal(raw.includes(legal), false);
  assert.equal(JSON.stringify(broken).includes(reverseLineFeed), true);
  assert.equal(JSON.stringify(broken).includes("\\"), false);
  assert.equal(JSON.stringify(broken).includes("\\u008d"), false);
  assert.equal(JSON.stringify(broken).includes("\\u008a"), false);
  assert.equal(JSON.stringify(broken).includes("\\u008b"), false);
  assert.equal(JSON.stringify(broken).includes("\\u008c"), false);
  assert.equal(JSON.stringify(lineTabulationSetMiddle).includes(lineTabulationSet), true);
  assert.equal(JSON.stringify(lineTabulationSetMiddle).includes("\\"), false);
  assert.equal(JSON.stringify(lineTabulationSetMiddle).includes("\\u008a"), false);
  assert.equal(JSON.stringify(lineTabulationSetMiddle).includes("\\u008d"), false);
  assert.equal(JSON.stringify(lineTabulationSetMiddle).includes(reverseLineFeed), false);
  assert.equal(JSON.stringify(partialLineForwardMiddle).includes(partialLineForward), true);
  assert.equal(JSON.stringify(partialLineForwardMiddle).includes("\\"), false);
  assert.equal(JSON.stringify(partialLineForwardMiddle).includes("\\u008b"), false);
  assert.equal(JSON.stringify(partialLineForwardMiddle).includes("\\u008d"), false);
  assert.equal(JSON.stringify(partialLineForwardMiddle).includes(reverseLineFeed), false);
  assert.equal(JSON.stringify(partialLineBackwardMiddle).includes(partialLineBackward), true);
  assert.equal(JSON.stringify(partialLineBackwardMiddle).includes("\\"), false);
  assert.equal(JSON.stringify(partialLineBackwardMiddle).includes("\\u008c"), false);
  assert.equal(JSON.stringify(partialLineBackwardMiddle).includes("\\u008d"), false);
  assert.equal(JSON.stringify(partialLineBackwardMiddle).includes(reverseLineFeed), false);
  assert.notEqual(JSON.stringify(broken), JSON.stringify(lineTabulationSetMiddle));
  assert.notEqual(JSON.stringify(broken), JSON.stringify(partialLineForwardMiddle));
  assert.notEqual(JSON.stringify(broken), JSON.stringify(partialLineBackwardMiddle));
  f.resetWrites();
  const refused = await read(await f.req("/api/answers", "PUT", payload, { cookie }));
  assert.equal(refused.status, 422, JSON.stringify(refused.body));
  assert.equal(refused.body.error, "Choose an available answer.");
  assert.equal(refused.headers.get("Set-Cookie"), null);
  assert.equal(refused.text.includes(secret), false);
  assert.equal(refused.text.includes(sessionSecret), false);
  assert.equal(refused.text.includes(broken), false);
  assert.equal(refused.text.includes(reverseLineFeed), false);
  assert.equal(refused.text.includes("\\u008d"), false);
  assert.equal(refused.text.includes(lineTabulationSet), false);
  assert.equal(refused.text.includes("\\u008a"), false);
  assert.equal(refused.text.includes(partialLineForward), false);
  assert.equal(refused.text.includes("\\u008b"), false);
  assert.equal(refused.text.includes(partialLineBackward), false);
  assert.equal(refused.text.includes("\\u008c"), false);
  assert.equal(refused.text.includes(legal), false);
  assert.deepEqual(f.written, []);

  const after = stored(f, reference);
  assert.deepEqual(after, snapshot);
  assert.deepEqual(after.answers, {});
  assert.equal(Object.hasOwn(after.answers, target.id), false);
  assert.equal(JSON.stringify(after.answers).includes(reverseLineFeed), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u008d"), false);
  assert.equal(JSON.stringify(after.answers).includes(lineTabulationSet), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u008a"), false);
  assert.equal(JSON.stringify(after.answers).includes(partialLineForward), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u008b"), false);
  assert.equal(JSON.stringify(after.answers).includes(legal), false);
  assert.equal(JSON.stringify(after).includes(reverseLineFeed), false);
  assert.equal(JSON.stringify(after).includes("\\u008d"), false);
  assert.equal(JSON.stringify(after).includes(lineTabulationSet), false);
  assert.equal(JSON.stringify(after).includes("\\u008a"), false);
  assert.equal(JSON.stringify(after).includes(partialLineForward), false);
  assert.equal(JSON.stringify(after).includes("\\u008b"), false);
  assert.equal(JSON.stringify(after).includes(partialLineBackward), false);
  assert.equal(JSON.stringify(after).includes("\\u008c"), false);
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
  assert.equal(viewed.text.includes(reverseLineFeed), false);
  assert.equal(viewed.text.includes("\\u008d"), false);
  assert.equal(viewed.text.includes(lineTabulationSet), false);
  assert.equal(viewed.text.includes("\\u008a"), false);
  assert.equal(viewed.text.includes(partialLineForward), false);
  assert.equal(viewed.text.includes("\\u008b"), false);
  assert.equal(viewed.text.includes(partialLineBackward), false);
  assert.equal(viewed.text.includes("\\u008c"), false);
  assert.equal(f.records.get(reference).etag, openedEtag);
  assert.equal(stored(f, reference).inviteHash, inviteHash);
  assert.equal(stored(f, reference).sessionHash, sessionHash);
  assert.deepEqual(stored(f, reference).answers, {});
});
