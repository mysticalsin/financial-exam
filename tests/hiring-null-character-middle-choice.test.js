import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import worker, { Assessment } from "../src/worker.js";

// One live hiring sitting. Save an answer for a real item on this paper
// whose choice id is that item's legal choice string with a null
// character (U+0000) inserted in the middle. The save is refused. No
// answer is stored. The invite hash and the session secret stay unchanged.
// A file separator in the middle, a group separator in the middle, and
// a newline in the middle are separate checks.

const origin = "https://assessment.example";
const notice = {
  controller: "Test controller", contact: "privacy@example.invalid", basis: "Test basis",
  recipients: "Test reviewer", transfers: "Test transfer description", rights: "Test rights",
  purpose: "Test purpose", supervisoryAuthority: "Test authority", version: "test-1", retentionMinutes: 30,
};
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const random = () => crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
const nullCharacter = "\u0000";
const fileSeparator = "\u001c";
const groupSeparator = "\u001d";
const newline = "\u000A";

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

test("a legal choice with a null character inserted in the middle is refused and stores nothing", async () => {
  const source = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(source, /"LIVE_ENABLED": "false"/);
  assert.equal(nullCharacter, "\u0000");
  assert.equal(nullCharacter.charCodeAt(0), 0x0000);
  assert.equal(nullCharacter.codePointAt(0), 0x0000);
  assert.equal(nullCharacter.length, 1);
  assert.notEqual(nullCharacter, fileSeparator);
  assert.notEqual(nullCharacter.charCodeAt(0), 0x001C);
  assert.notEqual(nullCharacter, groupSeparator);
  assert.notEqual(nullCharacter.charCodeAt(0), 0x001D);
  assert.notEqual(nullCharacter, newline);
  assert.notEqual(nullCharacter.charCodeAt(0), 0x000A);
  assert.equal(nullCharacter === null, false);
  assert.equal(fileSeparator, "\u001c");
  assert.equal(fileSeparator.charCodeAt(0), 0x001C);
  assert.equal(fileSeparator.codePointAt(0), 0x001C);
  assert.equal(fileSeparator.length, 1);
  assert.equal(groupSeparator, "\u001d");
  assert.equal(groupSeparator.charCodeAt(0), 0x001D);
  assert.equal(groupSeparator.length, 1);
  assert.equal(newline, "\n");
  assert.equal(newline.charCodeAt(0), 0x000A);
  assert.equal(newline.length, 1);
  assert.equal(/\s/.test(nullCharacter), false);
  assert.equal(/\s/.test(fileSeparator), false);
  assert.equal(/\s/.test(groupSeparator), false);
  assert.equal(/\s/.test(newline), true);
  assert.equal(/\p{Cc}/u.test(nullCharacter), true);
  assert.equal(/\p{Cf}/u.test(nullCharacter), false);
  assert.equal(/\p{Zl}/u.test(nullCharacter), false);
  assert.equal(/\p{Zp}/u.test(nullCharacter), false);
  assert.equal(/\p{Zs}/u.test(nullCharacter), false);
  assert.equal(/\p{White_Space}/u.test(nullCharacter), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(nullCharacter), false);
  assert.equal(/\p{Cc}/u.test(fileSeparator), true);
  assert.equal(/\p{Cf}/u.test(fileSeparator), false);
  assert.equal(/\p{Zl}/u.test(fileSeparator), false);
  assert.equal(/\p{Zp}/u.test(fileSeparator), false);
  assert.equal(/\p{Zs}/u.test(fileSeparator), false);
  assert.equal(/\p{White_Space}/u.test(fileSeparator), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(fileSeparator), false);
  assert.equal(/\p{Cc}/u.test(groupSeparator), true);
  assert.equal(/\p{Cf}/u.test(groupSeparator), false);
  assert.equal(/\p{Zl}/u.test(groupSeparator), false);
  assert.equal(/\p{Zp}/u.test(groupSeparator), false);
  assert.equal(/\p{Zs}/u.test(groupSeparator), false);
  assert.equal(/\p{White_Space}/u.test(groupSeparator), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(groupSeparator), false);
  assert.equal(/\p{Cc}/u.test(newline), true);
  assert.equal(/\p{Zl}/u.test(newline), false);
  assert.equal(/\p{Zp}/u.test(newline), false);
  assert.equal(/\p{Cf}/u.test(newline), false);
  assert.equal(/\p{Zs}/u.test(newline), false);
  assert.equal(/\p{White_Space}/u.test(newline), true);
  assert.equal(/\p{Pattern_White_Space}/u.test(newline), true);
  assert.equal(nullCharacter.trim(), nullCharacter);
  assert.notEqual(nullCharacter.trim(), "");
  assert.equal(fileSeparator.trim(), fileSeparator);
  assert.notEqual(fileSeparator.trim(), "");
  assert.equal(groupSeparator.trim(), groupSeparator);
  assert.notEqual(groupSeparator.trim(), "");
  assert.equal(newline.trim(), "");
  assert.equal(JSON.stringify(nullCharacter), '"\\u0000"');
  assert.equal(JSON.stringify(nullCharacter).includes("\\"), true);
  assert.notEqual(JSON.stringify(nullCharacter), '"' + nullCharacter + '"');
  assert.notEqual(JSON.stringify(nullCharacter), "null");
  assert.notEqual(JSON.stringify(nullCharacter), '"\\u001c"');
  assert.notEqual(JSON.stringify(nullCharacter), '"\\u001C"');
  assert.notEqual(JSON.stringify(nullCharacter), '"\\u001d"');
  assert.notEqual(JSON.stringify(nullCharacter), '"\\u001D"');
  assert.notEqual(JSON.stringify(nullCharacter), '"\\n"');
  assert.notEqual(JSON.stringify(nullCharacter), '"\\u000a"');
  assert.notEqual(JSON.stringify(nullCharacter), '"\\u000A"');
  assert.equal(JSON.stringify(fileSeparator), '"\\u001c"');
  assert.equal(JSON.stringify(fileSeparator).includes("\\"), true);
  assert.notEqual(JSON.stringify(fileSeparator), '"' + fileSeparator + '"');
  assert.notEqual(JSON.stringify(fileSeparator), '"\\u001C"');
  assert.equal(JSON.stringify(groupSeparator), '"\\u001d"');
  assert.equal(JSON.stringify(groupSeparator).includes("\\"), true);
  assert.notEqual(JSON.stringify(groupSeparator), '"' + groupSeparator + '"');
  assert.notEqual(JSON.stringify(groupSeparator), '"\\u001D"');
  assert.equal(JSON.stringify(newline), '"\\n"');
  assert.equal(JSON.stringify(newline).includes("\\"), true);
  assert.notEqual(JSON.stringify(newline), '"\\u000A"');
  assert.notEqual(JSON.stringify(newline), '"\\u000a"');
  assert.notEqual(JSON.stringify(nullCharacter), JSON.stringify(fileSeparator));
  assert.notEqual(JSON.stringify(nullCharacter), JSON.stringify(groupSeparator));
  assert.notEqual(JSON.stringify(nullCharacter), JSON.stringify(newline));

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
  assert.ok(target, "a real item has a legal choice that can take an interior null character");
  const legal = target.options.find(option => uuid.test(option.id)).id;
  assert.equal(questions.some(question => question.id === target.id), true);
  assert.equal(target.options.some(option => option.id === legal), true);
  assert.equal(uuid.test(legal), true);
  assert.equal(uuid.test(target.id), true);
  assert.equal(legal.length, 36);
  assert.equal(legal.includes(nullCharacter), false);
  assert.equal(legal.includes(fileSeparator), false);
  assert.equal(legal.includes(groupSeparator), false);
  assert.equal(legal.includes(newline), false);
  assert.equal(legal.trim(), legal);

  const inserted = insertedInMiddle(legal, nullCharacter);
  const broken = inserted.value;
  const at = inserted.at;
  const fileMiddle = insertedInMiddle(legal, fileSeparator).value;
  const groupMiddle = insertedInMiddle(legal, groupSeparator).value;
  const newlineMiddle = insertedInMiddle(legal, newline).value;
  const leadingNull = nullCharacter + legal;
  const trailingNull = legal + nullCharacter;
  assert.ok(at > 0 && at < legal.length);
  assert.equal(at, 18);
  assert.equal(legal.charCodeAt(at), 0x002D);
  assert.equal(broken.charCodeAt(at), 0x0000);
  assert.equal(broken.charCodeAt(at + 1), 0x002D);
  assert.notEqual(broken.charCodeAt(at), 0x001C);
  assert.notEqual(broken.charCodeAt(at), 0x001D);
  assert.notEqual(broken.charCodeAt(at), 0x000A);
  assert.equal(broken[at], nullCharacter);
  assert.equal(broken.slice(0, at), legal.slice(0, at));
  assert.equal(broken.slice(at + 1), legal.slice(at));
  assert.equal(broken.slice(0, at).length > 0, true);
  assert.equal(broken.slice(at + 1).length > 0, true);
  assert.equal(broken.length, legal.length + 1);
  assert.notEqual(broken, legal);
  assert.equal(broken.replace(nullCharacter, ""), legal);
  assert.equal([...broken].filter(char => char === nullCharacter).length, 1);
  assert.equal(broken.indexOf(nullCharacter), at);
  assert.equal(broken.startsWith(nullCharacter), false);
  assert.equal(broken.endsWith(nullCharacter), false);
  assert.notEqual(broken, leadingNull);
  assert.notEqual(broken, trailingNull);
  assert.notEqual(broken, fileSeparator + legal);
  assert.notEqual(broken, legal + fileSeparator);
  assert.notEqual(broken, groupSeparator + legal);
  assert.notEqual(broken, legal + groupSeparator);
  assert.notEqual(broken, newline + legal);
  assert.notEqual(broken, legal + newline);
  assert.notEqual(broken, fileMiddle);
  assert.notEqual(broken, groupMiddle);
  assert.notEqual(broken, newlineMiddle);
  assert.equal(leadingNull.trim(), leadingNull);
  assert.notEqual(leadingNull.trim(), legal);
  assert.equal(trailingNull.trim(), trailingNull);
  assert.notEqual(trailingNull.trim(), legal);
  assert.equal((fileSeparator + legal).trim(), fileSeparator + legal);
  assert.notEqual((fileSeparator + legal).trim(), legal);
  assert.equal((legal + fileSeparator).trim(), legal + fileSeparator);
  assert.notEqual((legal + fileSeparator).trim(), legal);
  assert.equal((groupSeparator + legal).trim(), groupSeparator + legal);
  assert.notEqual((groupSeparator + legal).trim(), legal);
  assert.equal((legal + groupSeparator).trim(), legal + groupSeparator);
  assert.notEqual((legal + groupSeparator).trim(), legal);
  assert.equal((newline + legal).trim(), legal);
  assert.equal((legal + newline).trim(), legal);
  assert.equal(broken.trim(), broken);
  assert.notEqual(broken.trim(), legal);
  assert.notEqual(broken.trim(), "");
  assert.equal(fileMiddle.trim(), fileMiddle);
  assert.notEqual(fileMiddle.trim(), legal);
  assert.equal(groupMiddle.trim(), groupMiddle);
  assert.notEqual(groupMiddle.trim(), legal);
  assert.equal(newlineMiddle.trim(), newlineMiddle);
  assert.notEqual(newlineMiddle.trim(), legal);
  assert.equal(/^\s+$/.test(broken), false);
  assert.equal(/\s/.test(broken), false);
  assert.equal(/\p{Cc}/u.test(broken), true);
  assert.equal(/\p{Cf}/u.test(broken), false);
  assert.equal(/\p{Zl}/u.test(broken), false);
  assert.equal(/\p{Zp}/u.test(broken), false);
  assert.equal(/\p{Zs}/u.test(broken), false);
  assert.equal(/\p{White_Space}/u.test(broken), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(broken), false);
  assert.equal(broken.includes(fileSeparator), false);
  assert.equal(broken.includes(groupSeparator), false);
  assert.equal(broken.includes(newline), false);
  assert.equal(fileMiddle.charCodeAt(at), 0x001C);
  assert.equal(fileMiddle.includes(nullCharacter), false);
  assert.equal(fileMiddle.includes(groupSeparator), false);
  assert.equal(fileMiddle.includes(newline), false);
  assert.equal(groupMiddle.charCodeAt(at), 0x001D);
  assert.equal(groupMiddle.includes(nullCharacter), false);
  assert.equal(groupMiddle.includes(fileSeparator), false);
  assert.equal(groupMiddle.includes(newline), false);
  assert.equal(newlineMiddle.charCodeAt(at), 0x000A);
  assert.equal(newlineMiddle.includes(nullCharacter), false);
  assert.equal(newlineMiddle.includes(fileSeparator), false);
  assert.equal(newlineMiddle.includes(groupSeparator), false);
  assert.equal(leadingNull.startsWith(nullCharacter), true);
  assert.equal(leadingNull.includes(fileSeparator), false);
  assert.equal(leadingNull.includes(groupSeparator), false);
  assert.equal(leadingNull.includes(newline), false);
  assert.equal(trailingNull.endsWith(nullCharacter), true);
  assert.equal(trailingNull.includes(fileSeparator), false);
  assert.equal(trailingNull.includes(groupSeparator), false);
  assert.equal(trailingNull.includes(newline), false);
  assert.equal(uuid.test(broken), false);
  assert.equal(uuid.test(fileMiddle), false);
  assert.equal(uuid.test(groupMiddle), false);
  assert.equal(uuid.test(newlineMiddle), false);
  assert.equal(uuid.test(leadingNull), false);
  assert.equal(uuid.test(trailingNull), false);
  const optionIds = questions.flatMap(question => question.options.map(option => option.id));
  assert.equal(optionIds.includes(legal), true);
  assert.equal(optionIds.includes(broken), false);
  assert.equal(optionIds.includes(fileMiddle), false);
  assert.equal(optionIds.includes(groupMiddle), false);
  assert.equal(optionIds.includes(newlineMiddle), false);
  assert.equal(optionIds.includes(leadingNull), false);
  assert.equal(optionIds.includes(trailingNull), false);
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
  assert.equal(payload.choices[0] === null, false);
  assert.notEqual(JSON.stringify(payload.choices), "null");
  assert.notEqual(JSON.stringify(payload.choices[0]), "null");
  assert.equal(payload.choices[0].includes(nullCharacter), true);
  assert.equal(payload.choices[0].charCodeAt(at), 0x0000);
  assert.equal(roundTrip.choices[0], broken);
  assert.equal(roundTrip.choices[0].charCodeAt(at), 0x0000);
  assert.notEqual(roundTrip.choices[0].charCodeAt(at), 0x001C);
  assert.notEqual(roundTrip.choices[0].charCodeAt(at), 0x001D);
  assert.notEqual(roundTrip.choices[0].charCodeAt(at), 0x000A);
  assert.equal(payload.choices[0].includes(fileSeparator), false);
  assert.equal(payload.choices[0].includes(groupSeparator), false);
  assert.equal(payload.choices[0].includes(newline), false);
  assert.equal(payload.choices[0] === legal, false);
  assert.equal(payload.choices[0] === fileMiddle, false);
  assert.equal(payload.choices[0] === groupMiddle, false);
  assert.equal(payload.choices[0] === newlineMiddle, false);
  assert.equal(payload.choices[0] === leadingNull, false);
  assert.equal(payload.choices[0] === trailingNull, false);
  assert.equal(payload.choices[0] === nullCharacter + legal, false);
  assert.equal(payload.choices[0] === legal + nullCharacter, false);
  assert.equal(payload.choices[0] === fileSeparator + legal, false);
  assert.equal(payload.choices[0] === legal + fileSeparator, false);
  assert.equal(payload.choices[0] === groupSeparator + legal, false);
  assert.equal(payload.choices[0] === legal + groupSeparator, false);
  assert.equal(payload.choices[0] === newline + legal, false);
  assert.equal(payload.choices[0] === legal + newline, false);
  assert.equal(raw.includes(JSON.stringify(broken)), true);
  assert.equal(raw.includes(nullCharacter), false);
  assert.equal(raw.includes("\\u0000"), true);
  assert.equal(raw.includes(fileSeparator), false);
  assert.equal(raw.includes("\\u001c"), false);
  assert.equal(raw.includes("\\u001C"), false);
  assert.equal(raw.includes(groupSeparator), false);
  assert.equal(raw.includes("\\u001d"), false);
  assert.equal(raw.includes("\\u001D"), false);
  assert.equal(raw.includes(newline), false);
  assert.equal(raw.includes("\\n"), false);
  assert.equal(raw.includes("\\u000A"), false);
  assert.equal(raw.includes("\\u000a"), false);
  assert.equal(raw.includes(legal), false);
  assert.equal(JSON.stringify(broken).includes("\\u0000"), true);
  assert.equal(JSON.stringify(broken).includes(nullCharacter), false);
  assert.equal(JSON.stringify(fileMiddle).includes("\\u001c"), true);
  assert.equal(JSON.stringify(fileMiddle).includes(fileSeparator), false);
  assert.equal(JSON.stringify(fileMiddle).includes("\\u0000"), false);
  assert.equal(JSON.stringify(fileMiddle).includes(nullCharacter), false);
  assert.equal(JSON.stringify(groupMiddle).includes("\\u001d"), true);
  assert.equal(JSON.stringify(groupMiddle).includes(groupSeparator), false);
  assert.equal(JSON.stringify(groupMiddle).includes("\\u0000"), false);
  assert.equal(JSON.stringify(groupMiddle).includes("\\u001c"), false);
  assert.equal(JSON.stringify(groupMiddle).includes(nullCharacter), false);
  assert.equal(JSON.stringify(groupMiddle).includes(fileSeparator), false);
  assert.equal(JSON.stringify(newlineMiddle).includes("\\n"), true);
  assert.equal(JSON.stringify(newlineMiddle).includes("\\u000a"), false);
  assert.equal(JSON.stringify(newlineMiddle).includes("\\u0000"), false);
  assert.equal(JSON.stringify(newlineMiddle).includes(nullCharacter), false);
  assert.equal(JSON.stringify(newlineMiddle).includes(newline), false);
  assert.notEqual(JSON.stringify(broken), JSON.stringify(fileMiddle));
  assert.notEqual(JSON.stringify(broken), JSON.stringify(groupMiddle));
  assert.notEqual(JSON.stringify(broken), JSON.stringify(newlineMiddle));
  assert.notEqual(JSON.stringify(broken), "null");
  f.resetWrites();
  const refused = await read(await f.req("/api/answers", "PUT", payload, { cookie }));
  assert.equal(refused.status, 422, JSON.stringify(refused.body));
  assert.equal(refused.body.error, "Choose an available answer.");
  assert.equal(refused.headers.get("Set-Cookie"), null);
  assert.equal(refused.text.includes(secret), false);
  assert.equal(refused.text.includes(sessionSecret), false);
  assert.equal(refused.text.includes(broken), false);
  assert.equal(refused.text.includes(nullCharacter), false);
  assert.equal(refused.text.includes("\\u0000"), false);
  assert.equal(refused.text.includes(fileSeparator), false);
  assert.equal(refused.text.includes("\\u001c"), false);
  assert.equal(refused.text.includes("\\u001C"), false);
  assert.equal(refused.text.includes(groupSeparator), false);
  assert.equal(refused.text.includes("\\u001d"), false);
  assert.equal(refused.text.includes("\\u001D"), false);
  assert.equal(refused.text.includes(newline), false);
  assert.equal(refused.text.includes("\\n"), false);
  assert.equal(refused.text.includes(legal), false);
  assert.deepEqual(f.written, []);

  const after = stored(f, reference);
  assert.deepEqual(after, snapshot);
  assert.deepEqual(after.answers, {});
  assert.equal(Object.hasOwn(after.answers, target.id), false);
  assert.equal(JSON.stringify(after.answers).includes(legal), false);
  assert.equal(JSON.stringify(after.answers).includes(nullCharacter), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u0000"), false);
  assert.equal(JSON.stringify(after.answers).includes(fileSeparator), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u001c"), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u001C"), false);
  assert.equal(JSON.stringify(after.answers).includes(groupSeparator), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u001d"), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u001D"), false);
  assert.equal(JSON.stringify(after.answers).includes(newline), false);
  assert.equal(JSON.stringify(after.answers).includes("\\n"), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u000A"), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u000a"), false);
  assert.equal(JSON.stringify(after).includes(nullCharacter), false);
  assert.equal(JSON.stringify(after).includes("\\u0000"), false);
  assert.equal(JSON.stringify(after).includes(fileSeparator), false);
  assert.equal(JSON.stringify(after).includes("\\u001c"), false);
  assert.equal(JSON.stringify(after).includes("\\u001C"), false);
  assert.equal(JSON.stringify(after).includes(groupSeparator), false);
  assert.equal(JSON.stringify(after).includes("\\u001d"), false);
  assert.equal(JSON.stringify(after).includes("\\u001D"), false);
  assert.equal(JSON.stringify(after).includes(newline), false);
  assert.equal(JSON.stringify(after).includes("\\n"), false);
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
  assert.equal(viewed.text.includes(nullCharacter), false);
  assert.equal(viewed.text.includes("\\u0000"), false);
  assert.equal(viewed.text.includes(fileSeparator), false);
  assert.equal(viewed.text.includes("\\u001c"), false);
  assert.equal(viewed.text.includes("\\u001C"), false);
  assert.equal(viewed.text.includes(groupSeparator), false);
  assert.equal(viewed.text.includes("\\u001d"), false);
  assert.equal(viewed.text.includes("\\u001D"), false);
  assert.equal(viewed.text.includes(newline), false);
  assert.equal(viewed.text.includes("\\n"), false);
  assert.equal(f.records.get(reference).etag, openedEtag);
  assert.equal(stored(f, reference).inviteHash, inviteHash);
  assert.equal(stored(f, reference).sessionHash, sessionHash);
  assert.deepEqual(stored(f, reference).answers, {});
});
