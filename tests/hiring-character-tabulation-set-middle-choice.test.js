import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import worker, { Assessment } from "../src/worker.js";

// One live hiring sitting. Save an answer for a real item on this paper
// whose choice id is that item's legal choice string with a
// character-tabulation-set character (U+0088) inserted in the middle.
// The save is refused. No answer is stored. The invite hash and the
// session secret stay unchanged.
// An end-of-selected-area character in the middle, a start-of-selected-area
// character in the middle, and an index character in the middle are separate checks.

const origin = "https://assessment.example";
const notice = {
  controller: "Test controller", contact: "privacy@example.invalid", basis: "Test basis",
  recipients: "Test reviewer", transfers: "Test transfer description", rights: "Test rights",
  purpose: "Test purpose", supervisoryAuthority: "Test authority", version: "test-1", retentionMinutes: 30,
};
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const random = () => crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
const characterTabulationSet = "\u0088";
const indexCharacter = "\u0084";
const startOfSelectedArea = "\u0086";
const endOfSelectedArea = "\u0087";

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

test("a legal choice with a character-tabulation-set character inserted in the middle is refused and stores nothing", async () => {
  const source = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(source, /"LIVE_ENABLED": "false"/);
  assert.equal(characterTabulationSet, "\u0088");
  assert.equal(characterTabulationSet.charCodeAt(0), 0x0088);
  assert.equal(characterTabulationSet.codePointAt(0), 0x0088);
  assert.equal(characterTabulationSet.length, 1);
  assert.notEqual(characterTabulationSet, endOfSelectedArea);
  assert.notEqual(characterTabulationSet.charCodeAt(0), 0x0087);
  assert.notEqual(characterTabulationSet, startOfSelectedArea);
  assert.notEqual(characterTabulationSet.charCodeAt(0), 0x0086);
  assert.notEqual(characterTabulationSet, indexCharacter);
  assert.notEqual(characterTabulationSet.charCodeAt(0), 0x0084);
  assert.equal(indexCharacter, "\u0084");
  assert.equal(indexCharacter.charCodeAt(0), 0x0084);
  assert.equal(indexCharacter.codePointAt(0), 0x0084);
  assert.equal(indexCharacter.length, 1);
  assert.equal(startOfSelectedArea, "\u0086");
  assert.equal(startOfSelectedArea.charCodeAt(0), 0x0086);
  assert.equal(startOfSelectedArea.codePointAt(0), 0x0086);
  assert.equal(startOfSelectedArea.length, 1);
  assert.equal(endOfSelectedArea, "\u0087");
  assert.equal(endOfSelectedArea.charCodeAt(0), 0x0087);
  assert.equal(endOfSelectedArea.codePointAt(0), 0x0087);
  assert.equal(endOfSelectedArea.length, 1);
  assert.equal(/\s/.test(characterTabulationSet), false);
  assert.equal(/\s/.test(indexCharacter), false);
  assert.equal(/\s/.test(startOfSelectedArea), false);
  assert.equal(/\s/.test(endOfSelectedArea), false);
  assert.equal(/\p{Cc}/u.test(characterTabulationSet), true);
  assert.equal(/\p{Cf}/u.test(characterTabulationSet), false);
  assert.equal(/\p{Zl}/u.test(characterTabulationSet), false);
  assert.equal(/\p{Zp}/u.test(characterTabulationSet), false);
  assert.equal(/\p{Zs}/u.test(characterTabulationSet), false);
  assert.equal(/\p{White_Space}/u.test(characterTabulationSet), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(characterTabulationSet), false);
  assert.equal(/\p{Cc}/u.test(indexCharacter), true);
  assert.equal(/\p{Cf}/u.test(indexCharacter), false);
  assert.equal(/\p{White_Space}/u.test(indexCharacter), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(indexCharacter), false);
  assert.equal(/\p{Cc}/u.test(startOfSelectedArea), true);
  assert.equal(/\p{Cf}/u.test(startOfSelectedArea), false);
  assert.equal(/\p{White_Space}/u.test(startOfSelectedArea), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(startOfSelectedArea), false);
  assert.equal(/\p{Cc}/u.test(endOfSelectedArea), true);
  assert.equal(/\p{Cf}/u.test(endOfSelectedArea), false);
  assert.equal(/\p{White_Space}/u.test(endOfSelectedArea), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(endOfSelectedArea), false);
  assert.equal(characterTabulationSet.trim(), characterTabulationSet);
  assert.notEqual(characterTabulationSet.trim(), "");
  assert.equal(indexCharacter.trim(), indexCharacter);
  assert.notEqual(indexCharacter.trim(), "");
  assert.equal(startOfSelectedArea.trim(), startOfSelectedArea);
  assert.notEqual(startOfSelectedArea.trim(), "");
  assert.equal(endOfSelectedArea.trim(), endOfSelectedArea);
  assert.notEqual(endOfSelectedArea.trim(), "");
  assert.equal(JSON.stringify(characterTabulationSet), '"' + characterTabulationSet + '"');
  assert.equal(JSON.stringify(characterTabulationSet).includes(characterTabulationSet), true);
  assert.equal(JSON.stringify(characterTabulationSet).includes("\\"), false);
  assert.equal(JSON.stringify(characterTabulationSet).includes("\\u0088"), false);
  assert.notEqual(JSON.stringify(characterTabulationSet), '"\\u0088"');
  assert.equal(JSON.stringify(indexCharacter), '"' + indexCharacter + '"');
  assert.equal(JSON.stringify(indexCharacter).includes(indexCharacter), true);
  assert.equal(JSON.stringify(indexCharacter).includes("\\"), false);
  assert.equal(JSON.stringify(indexCharacter).includes("\\u0084"), false);
  assert.notEqual(JSON.stringify(indexCharacter), '"\\u0084"');
  assert.notEqual(JSON.stringify(indexCharacter), '"\\u0088"');
  assert.equal(JSON.stringify(startOfSelectedArea), '"' + startOfSelectedArea + '"');
  assert.equal(JSON.stringify(startOfSelectedArea).includes(startOfSelectedArea), true);
  assert.equal(JSON.stringify(startOfSelectedArea).includes("\\"), false);
  assert.equal(JSON.stringify(startOfSelectedArea).includes("\\u0086"), false);
  assert.notEqual(JSON.stringify(startOfSelectedArea), '"\\u0086"');
  assert.notEqual(JSON.stringify(startOfSelectedArea), '"\\u0088"');
  assert.equal(JSON.stringify(endOfSelectedArea), '"' + endOfSelectedArea + '"');
  assert.equal(JSON.stringify(endOfSelectedArea).includes(endOfSelectedArea), true);
  assert.equal(JSON.stringify(endOfSelectedArea).includes("\\"), false);
  assert.equal(JSON.stringify(endOfSelectedArea).includes("\\u0087"), false);
  assert.notEqual(JSON.stringify(endOfSelectedArea), '"\\u0087"');
  assert.notEqual(JSON.stringify(endOfSelectedArea), '"\\u0088"');
  assert.notEqual(JSON.stringify(characterTabulationSet), JSON.stringify(indexCharacter));
  assert.notEqual(JSON.stringify(characterTabulationSet), JSON.stringify(startOfSelectedArea));
  assert.notEqual(JSON.stringify(characterTabulationSet), JSON.stringify(endOfSelectedArea));

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
  assert.ok(target, "a real item has a legal choice that can take an interior character-tabulation-set character");
  const legal = target.options.find(option => uuid.test(option.id)).id;
  assert.equal(questions.some(question => question.id === target.id), true);
  assert.equal(target.options.some(option => option.id === legal), true);
  assert.equal(uuid.test(legal), true);
  assert.equal(uuid.test(target.id), true);
  assert.equal(legal.length, 36);
  assert.equal(legal.includes(characterTabulationSet), false);
  assert.equal(legal.includes(indexCharacter), false);
  assert.equal(legal.includes(startOfSelectedArea), false);
  assert.equal(legal.includes(endOfSelectedArea), false);
  assert.equal(legal.trim(), legal);

  const inserted = insertedInMiddle(legal, characterTabulationSet);
  const broken = inserted.value;
  const at = inserted.at;
  const indexMiddle = insertedInMiddle(legal, indexCharacter).value;
  const startOfSelectedAreaMiddle = insertedInMiddle(legal, startOfSelectedArea).value;
  const endOfSelectedAreaMiddle = insertedInMiddle(legal, endOfSelectedArea).value;
  assert.ok(at > 0 && at < legal.length);
  assert.equal(at, 18);
  assert.equal(legal.charCodeAt(at), 0x002D);
  assert.equal(broken.charCodeAt(at), 0x0088);
  assert.equal(broken.charCodeAt(at + 1), 0x002D);
  assert.notEqual(broken.charCodeAt(at), 0x0087);
  assert.notEqual(broken.charCodeAt(at), 0x0086);
  assert.notEqual(broken.charCodeAt(at), 0x0084);
  assert.equal(broken.slice(0, at), legal.slice(0, at));
  assert.equal(broken.slice(at + 1), legal.slice(at));
  assert.equal(broken.length, legal.length + 1);
  assert.notEqual(broken, legal);
  assert.equal(broken.replace(characterTabulationSet, ""), legal);
  assert.equal([...broken].filter(char => char === characterTabulationSet).length, 1);
  assert.equal(broken.indexOf(characterTabulationSet), at);
  assert.equal(broken.startsWith(characterTabulationSet), false);
  assert.equal(broken.endsWith(characterTabulationSet), false);
  assert.notEqual(broken, characterTabulationSet + legal);
  assert.notEqual(broken, legal + characterTabulationSet);
  assert.notEqual(broken, indexMiddle);
  assert.notEqual(broken, startOfSelectedAreaMiddle);
  assert.notEqual(broken, endOfSelectedAreaMiddle);
  assert.equal(broken.trim(), broken);
  assert.notEqual(broken.trim(), legal);
  assert.notEqual(broken.trim(), "");
  assert.equal((characterTabulationSet + legal).trim(), characterTabulationSet + legal);
  assert.notEqual((characterTabulationSet + legal).trim(), legal);
  assert.equal((legal + characterTabulationSet).trim(), legal + characterTabulationSet);
  assert.notEqual((legal + characterTabulationSet).trim(), legal);
  assert.equal((indexCharacter + legal).trim(), indexCharacter + legal);
  assert.notEqual((indexCharacter + legal).trim(), legal);
  assert.equal((legal + indexCharacter).trim(), legal + indexCharacter);
  assert.notEqual((legal + indexCharacter).trim(), legal);
  assert.equal((startOfSelectedArea + legal).trim(), startOfSelectedArea + legal);
  assert.notEqual((startOfSelectedArea + legal).trim(), legal);
  assert.equal((legal + startOfSelectedArea).trim(), legal + startOfSelectedArea);
  assert.notEqual((legal + startOfSelectedArea).trim(), legal);
  assert.equal((endOfSelectedArea + legal).trim(), endOfSelectedArea + legal);
  assert.notEqual((endOfSelectedArea + legal).trim(), legal);
  assert.equal((legal + endOfSelectedArea).trim(), legal + endOfSelectedArea);
  assert.notEqual((legal + endOfSelectedArea).trim(), legal);
  assert.equal(indexMiddle.trim(), indexMiddle);
  assert.notEqual(indexMiddle.trim(), legal);
  assert.equal(startOfSelectedAreaMiddle.trim(), startOfSelectedAreaMiddle);
  assert.notEqual(startOfSelectedAreaMiddle.trim(), legal);
  assert.equal(endOfSelectedAreaMiddle.trim(), endOfSelectedAreaMiddle);
  assert.notEqual(endOfSelectedAreaMiddle.trim(), legal);
  assert.notEqual(endOfSelectedAreaMiddle.trim(), "");
  assert.equal(/\s/.test(broken), false);
  assert.equal(/\s/.test(indexMiddle), false);
  assert.equal(/\s/.test(startOfSelectedAreaMiddle), false);
  assert.equal(/\s/.test(endOfSelectedAreaMiddle), false);
  assert.equal(/\p{Cc}/u.test(broken), true);
  assert.equal(/\p{White_Space}/u.test(broken), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(broken), false);
  assert.equal(/\p{White_Space}/u.test(indexMiddle), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(indexMiddle), false);
  assert.equal(/\p{White_Space}/u.test(startOfSelectedAreaMiddle), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(startOfSelectedAreaMiddle), false);
  assert.equal(/\p{White_Space}/u.test(endOfSelectedAreaMiddle), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(endOfSelectedAreaMiddle), false);
  assert.equal(broken.includes(indexCharacter), false);
  assert.equal(broken.includes(startOfSelectedArea), false);
  assert.equal(broken.includes(endOfSelectedArea), false);
  assert.equal(indexMiddle.charCodeAt(at), 0x0084);
  assert.equal(indexMiddle.includes(characterTabulationSet), false);
  assert.equal(indexMiddle.includes(startOfSelectedArea), false);
  assert.equal(indexMiddle.includes(endOfSelectedArea), false);
  assert.equal(startOfSelectedAreaMiddle.charCodeAt(at), 0x0086);
  assert.equal(startOfSelectedAreaMiddle.includes(characterTabulationSet), false);
  assert.equal(startOfSelectedAreaMiddle.includes(indexCharacter), false);
  assert.equal(startOfSelectedAreaMiddle.includes(endOfSelectedArea), false);
  assert.equal(endOfSelectedAreaMiddle.charCodeAt(at), 0x0087);
  assert.equal(endOfSelectedAreaMiddle.includes(characterTabulationSet), false);
  assert.equal(endOfSelectedAreaMiddle.includes(indexCharacter), false);
  assert.equal(endOfSelectedAreaMiddle.includes(startOfSelectedArea), false);
  assert.equal(uuid.test(broken), false);
  const optionIds = questions.flatMap(question => question.options.map(option => option.id));
  assert.equal(optionIds.includes(legal), true);
  assert.equal(optionIds.includes(broken), false);
  assert.equal(optionIds.includes(indexMiddle), false);
  assert.equal(optionIds.includes(startOfSelectedAreaMiddle), false);
  assert.equal(optionIds.includes(endOfSelectedAreaMiddle), false);
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
  assert.equal(payload.choices[0].charCodeAt(at), 0x0088);
  assert.equal(roundTrip.choices[0], broken);
  assert.equal(roundTrip.choices[0].charCodeAt(at), 0x0088);
  assert.notEqual(roundTrip.choices[0].charCodeAt(at), 0x0087);
  assert.notEqual(roundTrip.choices[0].charCodeAt(at), 0x0086);
  assert.notEqual(roundTrip.choices[0].charCodeAt(at), 0x0084);
  assert.equal(payload.choices[0] === legal, false);
  assert.equal(payload.choices[0] === indexMiddle, false);
  assert.equal(payload.choices[0] === startOfSelectedAreaMiddle, false);
  assert.equal(payload.choices[0] === endOfSelectedAreaMiddle, false);
  assert.equal(raw.includes(characterTabulationSet), true);
  assert.equal(raw.includes("\\u0088"), false);
  assert.equal(raw.includes(indexCharacter), false);
  assert.equal(raw.includes("\\u0084"), false);
  assert.equal(raw.includes(startOfSelectedArea), false);
  assert.equal(raw.includes("\\u0086"), false);
  assert.equal(raw.includes(endOfSelectedArea), false);
  assert.equal(raw.includes("\\u0087"), false);
  assert.equal(raw.includes(legal), false);
  assert.equal(JSON.stringify(broken).includes(characterTabulationSet), true);
  assert.equal(JSON.stringify(broken).includes("\\"), false);
  assert.equal(JSON.stringify(broken).includes("\\u0088"), false);
  assert.equal(JSON.stringify(broken).includes("\\u0084"), false);
  assert.equal(JSON.stringify(broken).includes("\\u0086"), false);
  assert.equal(JSON.stringify(broken).includes("\\u0087"), false);
  assert.equal(JSON.stringify(indexMiddle).includes(indexCharacter), true);
  assert.equal(JSON.stringify(indexMiddle).includes("\\"), false);
  assert.equal(JSON.stringify(indexMiddle).includes("\\u0084"), false);
  assert.equal(JSON.stringify(indexMiddle).includes("\\u0088"), false);
  assert.equal(JSON.stringify(indexMiddle).includes(characterTabulationSet), false);
  assert.equal(JSON.stringify(startOfSelectedAreaMiddle).includes(startOfSelectedArea), true);
  assert.equal(JSON.stringify(startOfSelectedAreaMiddle).includes("\\"), false);
  assert.equal(JSON.stringify(startOfSelectedAreaMiddle).includes("\\u0086"), false);
  assert.equal(JSON.stringify(startOfSelectedAreaMiddle).includes("\\u0088"), false);
  assert.equal(JSON.stringify(startOfSelectedAreaMiddle).includes(characterTabulationSet), false);
  assert.equal(JSON.stringify(endOfSelectedAreaMiddle).includes(endOfSelectedArea), true);
  assert.equal(JSON.stringify(endOfSelectedAreaMiddle).includes("\\"), false);
  assert.equal(JSON.stringify(endOfSelectedAreaMiddle).includes("\\u0087"), false);
  assert.equal(JSON.stringify(endOfSelectedAreaMiddle).includes("\\u0088"), false);
  assert.equal(JSON.stringify(endOfSelectedAreaMiddle).includes(characterTabulationSet), false);
  assert.notEqual(JSON.stringify(broken), JSON.stringify(indexMiddle));
  assert.notEqual(JSON.stringify(broken), JSON.stringify(startOfSelectedAreaMiddle));
  assert.notEqual(JSON.stringify(broken), JSON.stringify(endOfSelectedAreaMiddle));
  f.resetWrites();
  const refused = await read(await f.req("/api/answers", "PUT", payload, { cookie }));
  assert.equal(refused.status, 422, JSON.stringify(refused.body));
  assert.equal(refused.body.error, "Choose an available answer.");
  assert.equal(refused.headers.get("Set-Cookie"), null);
  assert.equal(refused.text.includes(secret), false);
  assert.equal(refused.text.includes(sessionSecret), false);
  assert.equal(refused.text.includes(broken), false);
  assert.equal(refused.text.includes(characterTabulationSet), false);
  assert.equal(refused.text.includes("\\u0088"), false);
  assert.equal(refused.text.includes(indexCharacter), false);
  assert.equal(refused.text.includes("\\u0084"), false);
  assert.equal(refused.text.includes(startOfSelectedArea), false);
  assert.equal(refused.text.includes("\\u0086"), false);
  assert.equal(refused.text.includes(endOfSelectedArea), false);
  assert.equal(refused.text.includes("\\u0087"), false);
  assert.equal(refused.text.includes(legal), false);
  assert.deepEqual(f.written, []);

  const after = stored(f, reference);
  assert.deepEqual(after, snapshot);
  assert.deepEqual(after.answers, {});
  assert.equal(Object.hasOwn(after.answers, target.id), false);
  assert.equal(JSON.stringify(after.answers).includes(characterTabulationSet), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u0088"), false);
  assert.equal(JSON.stringify(after.answers).includes(indexCharacter), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u0084"), false);
  assert.equal(JSON.stringify(after.answers).includes(startOfSelectedArea), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u0086"), false);
  assert.equal(JSON.stringify(after.answers).includes(legal), false);
  assert.equal(JSON.stringify(after).includes(characterTabulationSet), false);
  assert.equal(JSON.stringify(after).includes("\\u0088"), false);
  assert.equal(JSON.stringify(after).includes(indexCharacter), false);
  assert.equal(JSON.stringify(after).includes("\\u0084"), false);
  assert.equal(JSON.stringify(after).includes(startOfSelectedArea), false);
  assert.equal(JSON.stringify(after).includes("\\u0086"), false);
  assert.equal(JSON.stringify(after).includes(endOfSelectedArea), false);
  assert.equal(JSON.stringify(after).includes("\\u0087"), false);
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
  assert.equal(viewed.text.includes(characterTabulationSet), false);
  assert.equal(viewed.text.includes("\\u0088"), false);
  assert.equal(viewed.text.includes(indexCharacter), false);
  assert.equal(viewed.text.includes("\\u0084"), false);
  assert.equal(viewed.text.includes(startOfSelectedArea), false);
  assert.equal(viewed.text.includes("\\u0086"), false);
  assert.equal(viewed.text.includes(endOfSelectedArea), false);
  assert.equal(viewed.text.includes("\\u0087"), false);
  assert.equal(f.records.get(reference).etag, openedEtag);
  assert.equal(stored(f, reference).inviteHash, inviteHash);
  assert.equal(stored(f, reference).sessionHash, sessionHash);
  assert.deepEqual(stored(f, reference).answers, {});
});
