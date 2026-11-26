import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import worker, { Assessment } from "../src/worker.js";

// One live hiring sitting. Save an answer for a real item on this paper
// whose choice id is that item's legal choice string with a word joiner
// (U+2060) inserted in the middle. The save is refused. No answer is
// stored. The invite hash and the session secret stay unchanged.
// A non-breaking space in the middle, a soft hyphen in the middle, a
// zero-width space in the middle, a backspace in the middle, a vertical
// tab in the middle, a form feed in the middle, a CRLF pair in the middle,
// a carriage return alone in the middle, a newline in the middle, a tab
// in the middle, and a leading or trailing ordinary space are separate
// checks.

const origin = "https://assessment.example";
const notice = {
  controller: "Test controller", contact: "privacy@example.invalid", basis: "Test basis",
  recipients: "Test reviewer", transfers: "Test transfer description", rights: "Test rights",
  purpose: "Test purpose", supervisoryAuthority: "Test authority", version: "test-1", retentionMinutes: 30,
};
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const random = () => crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
const wordJoiner = "\u2060";
const nbsp = "\u00A0";
const softHyphen = "\u00AD";
const zeroWidthSpace = "\u200B";
const ordinarySpace = " ";

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

test("a legal choice with a word joiner inserted in the middle is refused and stores nothing", async () => {
  const source = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(source, /"LIVE_ENABLED": "false"/);
  assert.equal(wordJoiner, "\u2060");
  assert.equal(wordJoiner.charCodeAt(0), 0x2060);
  assert.equal(wordJoiner.length, 1);
  assert.notEqual(wordJoiner, nbsp);
  assert.notEqual(wordJoiner.charCodeAt(0), 0x00A0);
  assert.notEqual(wordJoiner, softHyphen);
  assert.notEqual(wordJoiner.charCodeAt(0), 0x00AD);
  assert.notEqual(wordJoiner, zeroWidthSpace);
  assert.notEqual(wordJoiner.charCodeAt(0), 0x200B);
  assert.notEqual(wordJoiner, ordinarySpace);
  assert.notEqual(wordJoiner.charCodeAt(0), 0x0020);
  assert.equal(/\s/.test(wordJoiner), false);
  assert.equal(/\s/.test(nbsp), true);
  assert.equal(/\s/.test(ordinarySpace), true);
  assert.equal(/\s/.test(softHyphen), false);
  assert.equal(/\s/.test(zeroWidthSpace), false);
  assert.equal(/\p{Cf}/u.test(wordJoiner), true);
  assert.equal(/\p{Zs}/u.test(wordJoiner), false);
  assert.equal(/\p{Cc}/u.test(wordJoiner), false);
  assert.equal(/\p{Zs}/u.test(nbsp), true);
  assert.equal(/\p{Cf}/u.test(nbsp), false);
  assert.equal(/\p{Cf}/u.test(softHyphen), true);
  assert.equal(/\p{Cf}/u.test(zeroWidthSpace), true);
  assert.equal(wordJoiner.trim(), wordJoiner);
  assert.equal(nbsp.trim(), "");
  assert.equal(ordinarySpace.trim(), "");
  assert.equal(softHyphen.trim(), softHyphen);
  assert.equal(zeroWidthSpace.trim(), zeroWidthSpace);
  assert.equal(JSON.stringify(wordJoiner), "\"\u2060\"");
  assert.equal(JSON.stringify(wordJoiner).includes("\\"), false);
  assert.notEqual(JSON.stringify(wordJoiner), "\"\\u2060\"");
  assert.notEqual(JSON.stringify(wordJoiner), JSON.stringify(nbsp));
  assert.notEqual(JSON.stringify(wordJoiner), JSON.stringify(softHyphen));
  assert.notEqual(JSON.stringify(wordJoiner), JSON.stringify(zeroWidthSpace));
  assert.notEqual(JSON.stringify(wordJoiner), JSON.stringify(ordinarySpace));

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
  assert.ok(target, "a real item has a legal choice that can take an interior word joiner");
  const legal = target.options.find(option => uuid.test(option.id)).id;
  assert.equal(questions.some(question => question.id === target.id), true);
  assert.equal(target.options.some(option => option.id === legal), true);
  assert.equal(uuid.test(legal), true);
  assert.equal(uuid.test(target.id), true);
  assert.equal(legal.length, 36);
  assert.equal(legal.includes(wordJoiner), false);
  assert.equal(legal.includes(nbsp), false);
  assert.equal(legal.includes(softHyphen), false);
  assert.equal(legal.includes(zeroWidthSpace), false);
  assert.equal(legal.includes(ordinarySpace), false);
  assert.equal(legal.startsWith(ordinarySpace), false);
  assert.equal(legal.endsWith(ordinarySpace), false);
  assert.equal(legal.trim(), legal);

  const inserted = insertedInMiddle(legal, wordJoiner);
  const broken = inserted.value;
  const at = inserted.at;
  const nbspMiddle = insertedInMiddle(legal, nbsp).value;
  const softMiddle = insertedInMiddle(legal, softHyphen).value;
  const zeroWidthMiddle = insertedInMiddle(legal, zeroWidthSpace).value;
  const ordinaryMiddle = insertedInMiddle(legal, ordinarySpace).value;
  const leading = ordinarySpace + legal;
  const trailing = legal + ordinarySpace;
  assert.ok(at > 0 && at < legal.length);
  assert.equal(at, 18);
  assert.equal(legal.charCodeAt(at), 0x002D);
  assert.equal(broken.charCodeAt(at), 0x2060);
  assert.equal(broken.charCodeAt(at + 1), 0x002D);
  assert.notEqual(broken.charCodeAt(at), 0x00A0);
  assert.notEqual(broken.charCodeAt(at), 0x00AD);
  assert.notEqual(broken.charCodeAt(at), 0x200B);
  assert.notEqual(broken.charCodeAt(at), 0x0020);
  assert.equal(broken[at], wordJoiner);
  assert.equal(broken.slice(0, at), legal.slice(0, at));
  assert.equal(broken.slice(at + 1), legal.slice(at));
  assert.equal(broken.slice(0, at).length > 0, true);
  assert.equal(broken.slice(at + 1).length > 0, true);
  assert.equal(broken.length, legal.length + 1);
  assert.notEqual(broken, legal);
  assert.equal(broken.replace(wordJoiner, ""), legal);
  assert.equal([...broken].filter(char => char === wordJoiner).length, 1);
  assert.equal(broken.indexOf(wordJoiner), at);
  assert.equal(broken.startsWith(wordJoiner), false);
  assert.equal(broken.endsWith(wordJoiner), false);
  assert.notEqual(broken, wordJoiner + legal);
  assert.notEqual(broken, legal + wordJoiner);
  assert.equal((wordJoiner + legal).trim(), wordJoiner + legal);
  assert.equal((legal + wordJoiner).trim(), legal + wordJoiner);
  assert.notEqual((wordJoiner + legal).trim(), legal);
  assert.equal((nbsp + legal).trim(), legal);
  assert.equal(broken.trim(), broken);
  assert.notEqual(broken.trim(), legal);
  assert.notEqual(broken.trim(), "");
  assert.equal(/^\s+$/.test(broken), false);
  assert.equal(/\s/.test(broken), false);
  assert.equal(/\p{Cf}/u.test(broken), true);
  assert.equal(/\p{Zs}/u.test(broken), false);
  assert.equal(broken.includes(nbsp), false);
  assert.equal(broken.includes(softHyphen), false);
  assert.equal(broken.includes(zeroWidthSpace), false);
  assert.equal(broken.includes(ordinarySpace), false);
  assert.notEqual(broken, nbspMiddle);
  assert.notEqual(broken, softMiddle);
  assert.notEqual(broken, zeroWidthMiddle);
  assert.notEqual(broken, ordinaryMiddle);
  assert.notEqual(broken, leading);
  assert.notEqual(broken, trailing);
  assert.equal(nbspMiddle.charCodeAt(at), 0x00A0);
  assert.equal(nbspMiddle.includes(wordJoiner), false);
  assert.equal(softMiddle.charCodeAt(at), 0x00AD);
  assert.equal(softMiddle.includes(wordJoiner), false);
  assert.equal(zeroWidthMiddle.charCodeAt(at), 0x200B);
  assert.equal(zeroWidthMiddle.includes(wordJoiner), false);
  assert.equal(ordinaryMiddle.charCodeAt(at), 0x0020);
  assert.equal(ordinaryMiddle.includes(wordJoiner), false);
  assert.equal(leading.trim(), legal);
  assert.equal(trailing.trim(), legal);
  assert.equal(leading[0], ordinarySpace);
  assert.equal(trailing.at(-1), ordinarySpace);
  assert.equal(uuid.test(broken), false);
  assert.equal(uuid.test(nbspMiddle), false);
  assert.equal(uuid.test(softMiddle), false);
  assert.equal(uuid.test(zeroWidthMiddle), false);
  assert.equal(uuid.test(leading), false);
  assert.equal(uuid.test(trailing), false);
  const optionIds = questions.flatMap(question => question.options.map(option => option.id));
  assert.equal(optionIds.includes(legal), true);
  assert.equal(optionIds.includes(broken), false);
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
  assert.deepEqual(Object.keys(payload).sort(), ["choices", "questionId", "reference", "revision"]);
  assert.equal(payload.questionId, target.id);
  assert.equal(typeof payload.questionId, "string");
  assert.deepEqual(payload.choices, [broken]);
  assert.equal(payload.choices.length, 1);
  assert.equal(typeof payload.choices[0], "string");
  assert.equal(payload.choices[0].includes(wordJoiner), true);
  assert.equal(payload.choices[0].charCodeAt(at), 0x2060);
  assert.equal(payload.choices[0].includes(nbsp), false);
  assert.equal(payload.choices[0].includes(softHyphen), false);
  assert.equal(payload.choices[0].includes(zeroWidthSpace), false);
  assert.equal(payload.choices[0].includes(ordinarySpace), false);
  assert.equal(payload.choices[0] === legal, false);
  assert.equal(payload.choices[0] === leading, false);
  assert.equal(payload.choices[0] === trailing, false);
  assert.equal(payload.choices[0] === nbspMiddle, false);
  assert.equal(payload.choices[0] === softMiddle, false);
  assert.equal(payload.choices[0] === zeroWidthMiddle, false);
  assert.equal(payload.choices[0] === ordinaryMiddle, false);
  assert.equal(payload.choices[0] === wordJoiner + legal, false);
  assert.equal(payload.choices[0] === legal + wordJoiner, false);
  assert.equal(raw.includes(JSON.stringify(broken)), true);
  assert.equal(raw.includes(wordJoiner), true);
  assert.equal(raw.includes("\\u2060"), false);
  assert.equal(raw.includes(nbsp), false);
  assert.equal(raw.includes("\\u00a0"), false);
  assert.equal(raw.includes("\\u00A0"), false);
  assert.equal(raw.includes(softHyphen), false);
  assert.equal(raw.includes("\\u00ad"), false);
  assert.equal(raw.includes("\\u00AD"), false);
  assert.equal(raw.includes(zeroWidthSpace), false);
  assert.equal(raw.includes("\\u200b"), false);
  assert.equal(raw.includes("\\u200B"), false);
  assert.equal(raw.includes(legal), false);
  f.resetWrites();
  const refused = await read(await f.req("/api/answers", "PUT", payload, { cookie }));
  assert.equal(refused.status, 422, JSON.stringify(refused.body));
  assert.equal(refused.body.error, "Choose an available answer.");
  assert.equal(refused.headers.get("Set-Cookie"), null);
  assert.equal(refused.text.includes(secret), false);
  assert.equal(refused.text.includes(sessionSecret), false);
  assert.equal(refused.text.includes(broken), false);
  assert.equal(refused.text.includes(wordJoiner), false);
  assert.equal(refused.text.includes("\\u2060"), false);
  assert.equal(refused.text.includes(nbsp), false);
  assert.equal(refused.text.includes("\\u00a0"), false);
  assert.equal(refused.text.includes("\\u00A0"), false);
  assert.equal(refused.text.includes(softHyphen), false);
  assert.equal(refused.text.includes(zeroWidthSpace), false);
  assert.equal(refused.text.includes(legal), false);
  assert.deepEqual(f.written, []);

  const after = stored(f, reference);
  assert.deepEqual(after, snapshot);
  assert.deepEqual(after.answers, {});
  assert.equal(Object.hasOwn(after.answers, target.id), false);
  assert.equal(JSON.stringify(after.answers).includes(legal), false);
  assert.equal(JSON.stringify(after.answers).includes(wordJoiner), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u2060"), false);
  assert.equal(JSON.stringify(after.answers).includes(nbsp), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u00a0"), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u00A0"), false);
  assert.equal(JSON.stringify(after.answers).includes(softHyphen), false);
  assert.equal(JSON.stringify(after.answers).includes(zeroWidthSpace), false);
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
  assert.equal(viewed.text.includes(wordJoiner), false);
  assert.equal(viewed.text.includes("\\u2060"), false);
  assert.equal(viewed.text.includes(nbsp), false);
  assert.equal(viewed.text.includes("\\u00a0"), false);
  assert.equal(viewed.text.includes("\\u00A0"), false);
  assert.equal(viewed.text.includes(softHyphen), false);
  assert.equal(viewed.text.includes(zeroWidthSpace), false);
  assert.equal(f.records.get(reference).etag, openedEtag);
  assert.equal(stored(f, reference).inviteHash, inviteHash);
  assert.equal(stored(f, reference).sessionHash, sessionHash);
  assert.deepEqual(stored(f, reference).answers, {});
});
