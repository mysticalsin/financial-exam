import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import worker, { Assessment } from "../src/worker.js";

// One live hiring sitting. Save an answer for a real item on this paper
// whose choice id is that item's legal choice string with a narrow
// no-break space (U+202F) inserted in the middle. The save is refused. No
// answer is stored. The invite hash and the session secret stay unchanged.
// A byte-order mark in the middle, a zero-width joiner in the middle, a
// non-breaking space in the middle, and a zero-width space in the middle
// are separate checks.

const origin = "https://assessment.example";
const notice = {
  controller: "Test controller", contact: "privacy@example.invalid", basis: "Test basis",
  recipients: "Test reviewer", transfers: "Test transfer description", rights: "Test rights",
  purpose: "Test purpose", supervisoryAuthority: "Test authority", version: "test-1", retentionMinutes: 30,
};
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const random = () => crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
const narrowNoBreakSpace = "\u202F";
const byteOrderMark = "\uFEFF";
const zeroWidthJoiner = "\u200D";
const nbsp = "\u00A0";
const zeroWidthSpace = "\u200B";

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

test("a legal choice with a narrow no-break space inserted in the middle is refused and stores nothing", async () => {
  const source = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(source, /"LIVE_ENABLED": "false"/);
  assert.equal(narrowNoBreakSpace, "\u202F");
  assert.equal(narrowNoBreakSpace.charCodeAt(0), 0x202F);
  assert.equal(narrowNoBreakSpace.length, 1);
  assert.notEqual(narrowNoBreakSpace, byteOrderMark);
  assert.notEqual(narrowNoBreakSpace.charCodeAt(0), 0xFEFF);
  assert.notEqual(narrowNoBreakSpace, zeroWidthJoiner);
  assert.notEqual(narrowNoBreakSpace.charCodeAt(0), 0x200D);
  assert.notEqual(narrowNoBreakSpace, nbsp);
  assert.notEqual(narrowNoBreakSpace.charCodeAt(0), 0x00A0);
  assert.notEqual(narrowNoBreakSpace, zeroWidthSpace);
  assert.notEqual(narrowNoBreakSpace.charCodeAt(0), 0x200B);
  assert.equal(/\s/.test(narrowNoBreakSpace), true);
  assert.equal(/\s/.test(byteOrderMark), true);
  assert.equal(/\s/.test(zeroWidthJoiner), false);
  assert.equal(/\s/.test(nbsp), true);
  assert.equal(/\s/.test(zeroWidthSpace), false);
  assert.equal(/\p{Zs}/u.test(narrowNoBreakSpace), true);
  assert.equal(/\p{Cf}/u.test(narrowNoBreakSpace), false);
  assert.equal(/\p{Cc}/u.test(narrowNoBreakSpace), false);
  assert.equal(/\p{Zs}/u.test(byteOrderMark), false);
  assert.equal(/\p{Cf}/u.test(byteOrderMark), true);
  assert.equal(/\p{Zs}/u.test(zeroWidthJoiner), false);
  assert.equal(/\p{Cf}/u.test(zeroWidthJoiner), true);
  assert.equal(/\p{Zs}/u.test(nbsp), true);
  assert.equal(/\p{Cf}/u.test(nbsp), false);
  assert.equal(/\p{Zs}/u.test(zeroWidthSpace), false);
  assert.equal(/\p{Cf}/u.test(zeroWidthSpace), true);
  assert.equal(narrowNoBreakSpace.trim(), "");
  assert.equal(byteOrderMark.trim(), "");
  assert.equal(zeroWidthJoiner.trim(), zeroWidthJoiner);
  assert.equal(nbsp.trim(), "");
  assert.equal(zeroWidthSpace.trim(), zeroWidthSpace);
  assert.equal(JSON.stringify(narrowNoBreakSpace), '"' + narrowNoBreakSpace + '"');
  assert.equal(JSON.stringify(narrowNoBreakSpace).includes("\\"), false);
  assert.notEqual(JSON.stringify(narrowNoBreakSpace), '"\\u202f"');
  assert.notEqual(JSON.stringify(narrowNoBreakSpace), '"\\u202F"');
  assert.notEqual(JSON.stringify(narrowNoBreakSpace), JSON.stringify(byteOrderMark));
  assert.notEqual(JSON.stringify(narrowNoBreakSpace), JSON.stringify(zeroWidthJoiner));
  assert.notEqual(JSON.stringify(narrowNoBreakSpace), JSON.stringify(nbsp));
  assert.notEqual(JSON.stringify(narrowNoBreakSpace), JSON.stringify(zeroWidthSpace));

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
  assert.ok(target, "a real item has a legal choice that can take an interior narrow no-break space");
  const legal = target.options.find(option => uuid.test(option.id)).id;
  assert.equal(questions.some(question => question.id === target.id), true);
  assert.equal(target.options.some(option => option.id === legal), true);
  assert.equal(uuid.test(legal), true);
  assert.equal(uuid.test(target.id), true);
  assert.equal(legal.length, 36);
  assert.equal(legal.includes(narrowNoBreakSpace), false);
  assert.equal(legal.includes(byteOrderMark), false);
  assert.equal(legal.includes(zeroWidthJoiner), false);
  assert.equal(legal.includes(nbsp), false);
  assert.equal(legal.includes(zeroWidthSpace), false);
  assert.equal(legal.trim(), legal);

  const inserted = insertedInMiddle(legal, narrowNoBreakSpace);
  const broken = inserted.value;
  const at = inserted.at;
  const bomMiddle = insertedInMiddle(legal, byteOrderMark).value;
  const joinerMiddle = insertedInMiddle(legal, zeroWidthJoiner).value;
  const nbspMiddle = insertedInMiddle(legal, nbsp).value;
  const zeroWidthMiddle = insertedInMiddle(legal, zeroWidthSpace).value;
  assert.ok(at > 0 && at < legal.length);
  assert.equal(at, 18);
  assert.equal(legal.charCodeAt(at), 0x002D);
  assert.equal(broken.charCodeAt(at), 0x202F);
  assert.equal(broken.charCodeAt(at + 1), 0x002D);
  assert.notEqual(broken.charCodeAt(at), 0xFEFF);
  assert.notEqual(broken.charCodeAt(at), 0x200D);
  assert.notEqual(broken.charCodeAt(at), 0x00A0);
  assert.notEqual(broken.charCodeAt(at), 0x200B);
  assert.equal(broken[at], narrowNoBreakSpace);
  assert.equal(broken.slice(0, at), legal.slice(0, at));
  assert.equal(broken.slice(at + 1), legal.slice(at));
  assert.equal(broken.slice(0, at).length > 0, true);
  assert.equal(broken.slice(at + 1).length > 0, true);
  assert.equal(broken.length, legal.length + 1);
  assert.notEqual(broken, legal);
  assert.equal(broken.replace(narrowNoBreakSpace, ""), legal);
  assert.equal([...broken].filter(char => char === narrowNoBreakSpace).length, 1);
  assert.equal(broken.indexOf(narrowNoBreakSpace), at);
  assert.equal(broken.startsWith(narrowNoBreakSpace), false);
  assert.equal(broken.endsWith(narrowNoBreakSpace), false);
  assert.notEqual(broken, narrowNoBreakSpace + legal);
  assert.notEqual(broken, legal + narrowNoBreakSpace);
  assert.equal((narrowNoBreakSpace + legal).trim(), legal);
  assert.equal((legal + narrowNoBreakSpace).trim(), legal);
  assert.equal((byteOrderMark + legal).trim(), legal);
  assert.equal((legal + byteOrderMark).trim(), legal);
  assert.notEqual((zeroWidthJoiner + legal).trim(), legal);
  assert.equal((zeroWidthJoiner + legal).trim(), zeroWidthJoiner + legal);
  assert.equal((nbsp + legal).trim(), legal);
  assert.equal((legal + nbsp).trim(), legal);
  assert.notEqual((zeroWidthSpace + legal).trim(), legal);
  assert.equal((zeroWidthSpace + legal).trim(), zeroWidthSpace + legal);
  assert.equal(broken.trim(), broken);
  assert.notEqual(broken.trim(), legal);
  assert.notEqual(broken.trim(), "");
  assert.equal(/^\s+$/.test(broken), false);
  assert.equal(/\s/.test(broken), true);
  assert.equal(/\p{Zs}/u.test(broken), true);
  assert.equal(/\p{Cf}/u.test(broken), false);
  assert.equal(broken.includes(byteOrderMark), false);
  assert.equal(broken.includes(zeroWidthJoiner), false);
  assert.equal(broken.includes(nbsp), false);
  assert.equal(broken.includes(zeroWidthSpace), false);
  assert.notEqual(broken, bomMiddle);
  assert.notEqual(broken, joinerMiddle);
  assert.notEqual(broken, nbspMiddle);
  assert.notEqual(broken, zeroWidthMiddle);
  assert.equal(bomMiddle.charCodeAt(at), 0xFEFF);
  assert.equal(bomMiddle.includes(narrowNoBreakSpace), false);
  assert.equal(joinerMiddle.charCodeAt(at), 0x200D);
  assert.equal(joinerMiddle.includes(narrowNoBreakSpace), false);
  assert.equal(joinerMiddle.includes(byteOrderMark), false);
  assert.equal(nbspMiddle.charCodeAt(at), 0x00A0);
  assert.equal(nbspMiddle.includes(narrowNoBreakSpace), false);
  assert.equal(nbspMiddle.includes(byteOrderMark), false);
  assert.equal(nbspMiddle.includes(zeroWidthJoiner), false);
  assert.equal(zeroWidthMiddle.charCodeAt(at), 0x200B);
  assert.equal(zeroWidthMiddle.includes(narrowNoBreakSpace), false);
  assert.equal(zeroWidthMiddle.includes(byteOrderMark), false);
  assert.equal(zeroWidthMiddle.includes(zeroWidthJoiner), false);
  assert.equal(zeroWidthMiddle.includes(nbsp), false);
  assert.equal(uuid.test(broken), false);
  assert.equal(uuid.test(bomMiddle), false);
  assert.equal(uuid.test(joinerMiddle), false);
  assert.equal(uuid.test(nbspMiddle), false);
  assert.equal(uuid.test(zeroWidthMiddle), false);
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
  assert.equal(payload.choices[0].includes(narrowNoBreakSpace), true);
  assert.equal(payload.choices[0].charCodeAt(at), 0x202F);
  assert.equal(payload.choices[0].includes(byteOrderMark), false);
  assert.equal(payload.choices[0].includes(zeroWidthJoiner), false);
  assert.equal(payload.choices[0].includes(nbsp), false);
  assert.equal(payload.choices[0].includes(zeroWidthSpace), false);
  assert.equal(payload.choices[0] === legal, false);
  assert.equal(payload.choices[0] === bomMiddle, false);
  assert.equal(payload.choices[0] === joinerMiddle, false);
  assert.equal(payload.choices[0] === nbspMiddle, false);
  assert.equal(payload.choices[0] === zeroWidthMiddle, false);
  assert.equal(payload.choices[0] === narrowNoBreakSpace + legal, false);
  assert.equal(payload.choices[0] === legal + narrowNoBreakSpace, false);
  assert.equal(raw.includes(JSON.stringify(broken)), true);
  assert.equal(raw.includes(narrowNoBreakSpace), true);
  assert.equal(raw.includes("\\u202f"), false);
  assert.equal(raw.includes("\\u202F"), false);
  assert.equal(raw.includes(byteOrderMark), false);
  assert.equal(raw.includes("\\ufeff"), false);
  assert.equal(raw.includes("\\uFEFF"), false);
  assert.equal(raw.includes(zeroWidthJoiner), false);
  assert.equal(raw.includes("\\u200d"), false);
  assert.equal(raw.includes("\\u200D"), false);
  assert.equal(raw.includes(nbsp), false);
  assert.equal(raw.includes("\\u00a0"), false);
  assert.equal(raw.includes("\\u00A0"), false);
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
  assert.equal(refused.text.includes(narrowNoBreakSpace), false);
  assert.equal(refused.text.includes("\\u202f"), false);
  assert.equal(refused.text.includes("\\u202F"), false);
  assert.equal(refused.text.includes(byteOrderMark), false);
  assert.equal(refused.text.includes("\\ufeff"), false);
  assert.equal(refused.text.includes("\\uFEFF"), false);
  assert.equal(refused.text.includes(zeroWidthJoiner), false);
  assert.equal(refused.text.includes("\\u200d"), false);
  assert.equal(refused.text.includes("\\u200D"), false);
  assert.equal(refused.text.includes(nbsp), false);
  assert.equal(refused.text.includes("\\u00a0"), false);
  assert.equal(refused.text.includes("\\u00A0"), false);
  assert.equal(refused.text.includes(zeroWidthSpace), false);
  assert.equal(refused.text.includes("\\u200b"), false);
  assert.equal(refused.text.includes("\\u200B"), false);
  assert.equal(refused.text.includes(legal), false);
  assert.deepEqual(f.written, []);

  const after = stored(f, reference);
  assert.deepEqual(after, snapshot);
  assert.deepEqual(after.answers, {});
  assert.equal(Object.hasOwn(after.answers, target.id), false);
  assert.equal(JSON.stringify(after.answers).includes(legal), false);
  assert.equal(JSON.stringify(after.answers).includes(narrowNoBreakSpace), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u202f"), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u202F"), false);
  assert.equal(JSON.stringify(after.answers).includes(byteOrderMark), false);
  assert.equal(JSON.stringify(after.answers).includes("\\ufeff"), false);
  assert.equal(JSON.stringify(after.answers).includes("\\uFEFF"), false);
  assert.equal(JSON.stringify(after.answers).includes(zeroWidthJoiner), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u200d"), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u200D"), false);
  assert.equal(JSON.stringify(after.answers).includes(nbsp), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u00a0"), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u00A0"), false);
  assert.equal(JSON.stringify(after.answers).includes(zeroWidthSpace), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u200b"), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u200B"), false);
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
  assert.equal(viewed.text.includes(narrowNoBreakSpace), false);
  assert.equal(viewed.text.includes("\\u202f"), false);
  assert.equal(viewed.text.includes("\\u202F"), false);
  assert.equal(viewed.text.includes(byteOrderMark), false);
  assert.equal(viewed.text.includes("\\ufeff"), false);
  assert.equal(viewed.text.includes("\\uFEFF"), false);
  assert.equal(viewed.text.includes(zeroWidthJoiner), false);
  assert.equal(viewed.text.includes("\\u200d"), false);
  assert.equal(viewed.text.includes("\\u200D"), false);
  assert.equal(viewed.text.includes(nbsp), false);
  assert.equal(viewed.text.includes("\\u00a0"), false);
  assert.equal(viewed.text.includes("\\u00A0"), false);
  assert.equal(viewed.text.includes(zeroWidthSpace), false);
  assert.equal(viewed.text.includes("\\u200b"), false);
  assert.equal(viewed.text.includes("\\u200B"), false);
  assert.equal(f.records.get(reference).etag, openedEtag);
  assert.equal(stored(f, reference).inviteHash, inviteHash);
  assert.equal(stored(f, reference).sessionHash, sessionHash);
  assert.deepEqual(stored(f, reference).answers, {});
});
