import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import worker, { Assessment } from "../src/worker.js";

// One live hiring sitting. Save an answer for a real item on this paper
// whose choice id is that item's legal choice string with an escape
// character (U+001B) inserted in the middle. The save is refused. No
// answer is stored. The invite hash and the session secret stay unchanged.
// A delete character in the middle, a null character in the middle, and a
// newline in the middle are separate checks.

const origin = "https://assessment.example";
const notice = {
  controller: "Test controller", contact: "privacy@example.invalid", basis: "Test basis",
  recipients: "Test reviewer", transfers: "Test transfer description", rights: "Test rights",
  purpose: "Test purpose", supervisoryAuthority: "Test authority", version: "test-1", retentionMinutes: 30,
};
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const random = () => crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
const escapeCharacter = "\u001b";
const deleteCharacter = "\u007f";
const nullCharacter = "\u0000";
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

test("a legal choice with an escape character inserted in the middle is refused and stores nothing", async () => {
  const source = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(source, /"LIVE_ENABLED": "false"/);
  assert.equal(escapeCharacter, "\u001b");
  assert.equal(escapeCharacter.charCodeAt(0), 0x001B);
  assert.equal(escapeCharacter.codePointAt(0), 0x001B);
  assert.equal(escapeCharacter.length, 1);
  assert.notEqual(escapeCharacter, deleteCharacter);
  assert.notEqual(escapeCharacter.charCodeAt(0), 0x007F);
  assert.notEqual(escapeCharacter, nullCharacter);
  assert.notEqual(escapeCharacter.charCodeAt(0), 0x0000);
  assert.notEqual(escapeCharacter, newline);
  assert.notEqual(escapeCharacter.charCodeAt(0), 0x000A);
  assert.equal(deleteCharacter, "\u007f");
  assert.equal(deleteCharacter.charCodeAt(0), 0x007F);
  assert.equal(deleteCharacter.codePointAt(0), 0x007F);
  assert.equal(deleteCharacter.length, 1);
  assert.equal(nullCharacter, "\u0000");
  assert.equal(nullCharacter.charCodeAt(0), 0x0000);
  assert.equal(nullCharacter.length, 1);
  assert.equal(newline, "\n");
  assert.equal(newline.charCodeAt(0), 0x000A);
  assert.equal(newline.length, 1);
  assert.equal(/\s/.test(escapeCharacter), false);
  assert.equal(/\s/.test(deleteCharacter), false);
  assert.equal(/\s/.test(nullCharacter), false);
  assert.equal(/\s/.test(newline), true);
  assert.equal(/\p{Cc}/u.test(escapeCharacter), true);
  assert.equal(/\p{Cf}/u.test(escapeCharacter), false);
  assert.equal(/\p{Zl}/u.test(escapeCharacter), false);
  assert.equal(/\p{Zp}/u.test(escapeCharacter), false);
  assert.equal(/\p{Zs}/u.test(escapeCharacter), false);
  assert.equal(/\p{White_Space}/u.test(escapeCharacter), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(escapeCharacter), false);
  assert.equal(/\p{Cc}/u.test(deleteCharacter), true);
  assert.equal(/\p{Cf}/u.test(deleteCharacter), false);
  assert.equal(/\p{White_Space}/u.test(deleteCharacter), false);
  assert.equal(/\p{Cc}/u.test(nullCharacter), true);
  assert.equal(/\p{Cf}/u.test(nullCharacter), false);
  assert.equal(/\p{White_Space}/u.test(nullCharacter), false);
  assert.equal(/\p{Cc}/u.test(newline), true);
  assert.equal(/\p{Cf}/u.test(newline), false);
  assert.equal(/\p{White_Space}/u.test(newline), true);
  assert.equal(/\p{Pattern_White_Space}/u.test(newline), true);
  assert.equal(escapeCharacter.trim(), escapeCharacter);
  assert.notEqual(escapeCharacter.trim(), "");
  assert.equal(deleteCharacter.trim(), deleteCharacter);
  assert.notEqual(deleteCharacter.trim(), "");
  assert.equal(nullCharacter.trim(), nullCharacter);
  assert.notEqual(nullCharacter.trim(), "");
  assert.equal(newline.trim(), "");
  assert.equal(JSON.stringify(escapeCharacter), '"\\u001b"');
  assert.equal(JSON.stringify(escapeCharacter).includes("\\"), true);
  assert.equal(JSON.stringify(escapeCharacter).includes(escapeCharacter), false);
  assert.notEqual(JSON.stringify(escapeCharacter), '"' + escapeCharacter + '"');
  assert.notEqual(JSON.stringify(escapeCharacter), '"\\u001B"');
  assert.notEqual(JSON.stringify(escapeCharacter), '"\\u007f"');
  assert.notEqual(JSON.stringify(escapeCharacter), '"\\u007F"');
  assert.notEqual(JSON.stringify(escapeCharacter), '"\\u0000"');
  assert.notEqual(JSON.stringify(escapeCharacter), '"\\n"');
  assert.notEqual(JSON.stringify(escapeCharacter), '"\\u000a"');
  assert.notEqual(JSON.stringify(escapeCharacter), '"\\u000A"');
  assert.equal(JSON.stringify(deleteCharacter), '"' + deleteCharacter + '"');
  assert.equal(JSON.stringify(deleteCharacter).includes(deleteCharacter), true);
  assert.equal(JSON.stringify(deleteCharacter).includes("\\"), false);
  assert.notEqual(JSON.stringify(deleteCharacter), '"\\u007f"');
  assert.notEqual(JSON.stringify(deleteCharacter), '"\\u007F"');
  assert.notEqual(JSON.stringify(deleteCharacter), '"\\u001b"');
  assert.equal(JSON.stringify(nullCharacter), '"\\u0000"');
  assert.equal(JSON.stringify(nullCharacter).includes("\\"), true);
  assert.equal(JSON.stringify(nullCharacter).includes(nullCharacter), false);
  assert.notEqual(JSON.stringify(nullCharacter), '"' + nullCharacter + '"');
  assert.notEqual(JSON.stringify(nullCharacter), '"\\u001b"');
  assert.equal(JSON.stringify(newline), '"\\n"');
  assert.equal(JSON.stringify(newline).includes("\\"), true);
  assert.equal(JSON.stringify(newline).includes(newline), false);
  assert.notEqual(JSON.stringify(newline), '"\\u000a"');
  assert.notEqual(JSON.stringify(newline), '"\\u000A"');
  assert.notEqual(JSON.stringify(newline), '"\\u001b"');
  assert.notEqual(JSON.stringify(escapeCharacter), JSON.stringify(deleteCharacter));
  assert.notEqual(JSON.stringify(escapeCharacter), JSON.stringify(nullCharacter));
  assert.notEqual(JSON.stringify(escapeCharacter), JSON.stringify(newline));

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
  assert.ok(target, "a real item has a legal choice that can take an interior escape character");
  const legal = target.options.find(option => uuid.test(option.id)).id;
  assert.equal(questions.some(question => question.id === target.id), true);
  assert.equal(target.options.some(option => option.id === legal), true);
  assert.equal(uuid.test(legal), true);
  assert.equal(uuid.test(target.id), true);
  assert.equal(legal.length, 36);
  assert.equal(legal.includes(escapeCharacter), false);
  assert.equal(legal.includes(deleteCharacter), false);
  assert.equal(legal.includes(nullCharacter), false);
  assert.equal(legal.includes(newline), false);
  assert.equal(legal.trim(), legal);

  const inserted = insertedInMiddle(legal, escapeCharacter);
  const broken = inserted.value;
  const at = inserted.at;
  const deleteMiddle = insertedInMiddle(legal, deleteCharacter).value;
  const nullMiddle = insertedInMiddle(legal, nullCharacter).value;
  const newlineMiddle = insertedInMiddle(legal, newline).value;
  assert.ok(at > 0 && at < legal.length);
  assert.equal(at, 18);
  assert.equal(legal.charCodeAt(at), 0x002D);
  assert.equal(broken.charCodeAt(at), 0x001B);
  assert.equal(broken.charCodeAt(at + 1), 0x002D);
  assert.notEqual(broken.charCodeAt(at), 0x007F);
  assert.notEqual(broken.charCodeAt(at), 0x0000);
  assert.notEqual(broken.charCodeAt(at), 0x000A);
  assert.equal(broken.slice(0, at), legal.slice(0, at));
  assert.equal(broken.slice(at + 1), legal.slice(at));
  assert.equal(broken.length, legal.length + 1);
  assert.notEqual(broken, legal);
  assert.equal(broken.replace(escapeCharacter, ""), legal);
  assert.equal([...broken].filter(char => char === escapeCharacter).length, 1);
  assert.equal(broken.indexOf(escapeCharacter), at);
  assert.equal(broken.startsWith(escapeCharacter), false);
  assert.equal(broken.endsWith(escapeCharacter), false);
  assert.notEqual(broken, escapeCharacter + legal);
  assert.notEqual(broken, legal + escapeCharacter);
  assert.notEqual(broken, deleteMiddle);
  assert.notEqual(broken, nullMiddle);
  assert.notEqual(broken, newlineMiddle);
  assert.equal(broken.trim(), broken);
  assert.notEqual(broken.trim(), legal);
  assert.notEqual(broken.trim(), "");
  assert.equal((newline + legal).trim(), legal);
  assert.equal((legal + newline).trim(), legal);
  assert.equal((escapeCharacter + legal).trim(), escapeCharacter + legal);
  assert.notEqual((escapeCharacter + legal).trim(), legal);
  assert.equal(newlineMiddle.trim(), newlineMiddle);
  assert.notEqual(newlineMiddle.trim(), legal);
  assert.equal(/\s/.test(broken), false);
  assert.equal(/\p{Cc}/u.test(broken), true);
  assert.equal(/\p{White_Space}/u.test(broken), false);
  assert.equal(broken.includes(deleteCharacter), false);
  assert.equal(broken.includes(nullCharacter), false);
  assert.equal(broken.includes(newline), false);
  assert.equal(deleteMiddle.charCodeAt(at), 0x007F);
  assert.equal(deleteMiddle.includes(escapeCharacter), false);
  assert.equal(deleteMiddle.includes(nullCharacter), false);
  assert.equal(deleteMiddle.includes(newline), false);
  assert.equal(nullMiddle.charCodeAt(at), 0x0000);
  assert.equal(nullMiddle.includes(escapeCharacter), false);
  assert.equal(nullMiddle.includes(deleteCharacter), false);
  assert.equal(nullMiddle.includes(newline), false);
  assert.equal(newlineMiddle.charCodeAt(at), 0x000A);
  assert.equal(newlineMiddle.includes(escapeCharacter), false);
  assert.equal(newlineMiddle.includes(deleteCharacter), false);
  assert.equal(newlineMiddle.includes(nullCharacter), false);
  assert.equal(uuid.test(broken), false);
  const optionIds = questions.flatMap(question => question.options.map(option => option.id));
  assert.equal(optionIds.includes(legal), true);
  assert.equal(optionIds.includes(broken), false);
  assert.equal(optionIds.includes(deleteMiddle), false);
  assert.equal(optionIds.includes(nullMiddle), false);
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
  assert.equal(payload.choices[0].charCodeAt(at), 0x001B);
  assert.equal(roundTrip.choices[0], broken);
  assert.equal(roundTrip.choices[0].charCodeAt(at), 0x001B);
  assert.notEqual(roundTrip.choices[0].charCodeAt(at), 0x007F);
  assert.notEqual(roundTrip.choices[0].charCodeAt(at), 0x0000);
  assert.notEqual(roundTrip.choices[0].charCodeAt(at), 0x000A);
  assert.equal(payload.choices[0] === legal, false);
  assert.equal(payload.choices[0] === deleteMiddle, false);
  assert.equal(payload.choices[0] === nullMiddle, false);
  assert.equal(payload.choices[0] === newlineMiddle, false);
  assert.equal(raw.includes(escapeCharacter), false);
  assert.equal(raw.includes("\\u001b"), true);
  assert.equal(raw.includes("\\u001B"), false);
  assert.equal(raw.includes(deleteCharacter), false);
  assert.equal(raw.includes("\\u007f"), false);
  assert.equal(raw.includes("\\u007F"), false);
  assert.equal(raw.includes(nullCharacter), false);
  assert.equal(raw.includes("\\u0000"), false);
  assert.equal(raw.includes(newline), false);
  assert.equal(raw.includes("\\n"), false);
  assert.equal(raw.includes("\\u000a"), false);
  assert.equal(raw.includes("\\u000A"), false);
  assert.equal(raw.includes(legal), false);
  assert.equal(JSON.stringify(broken).includes("\\u001b"), true);
  assert.equal(JSON.stringify(broken).includes("\\u001B"), false);
  assert.equal(JSON.stringify(broken).includes(escapeCharacter), false);
  assert.equal(JSON.stringify(deleteMiddle).includes(deleteCharacter), true);
  assert.equal(JSON.stringify(deleteMiddle).includes("\\"), false);
  assert.equal(JSON.stringify(deleteMiddle).includes("\\u007f"), false);
  assert.equal(JSON.stringify(deleteMiddle).includes("\\u001b"), false);
  assert.equal(JSON.stringify(deleteMiddle).includes(escapeCharacter), false);
  assert.equal(JSON.stringify(nullMiddle).includes("\\u0000"), true);
  assert.equal(JSON.stringify(nullMiddle).includes(nullCharacter), false);
  assert.equal(JSON.stringify(nullMiddle).includes("\\u001b"), false);
  assert.equal(JSON.stringify(nullMiddle).includes(escapeCharacter), false);
  assert.equal(JSON.stringify(newlineMiddle).includes("\\n"), true);
  assert.equal(JSON.stringify(newlineMiddle).includes("\\u000a"), false);
  assert.equal(JSON.stringify(newlineMiddle).includes("\\u000A"), false);
  assert.equal(JSON.stringify(newlineMiddle).includes("\\u001b"), false);
  assert.equal(JSON.stringify(newlineMiddle).includes(newline), false);
  assert.equal(JSON.stringify(newlineMiddle).includes(escapeCharacter), false);
  assert.notEqual(JSON.stringify(broken), JSON.stringify(deleteMiddle));
  assert.notEqual(JSON.stringify(broken), JSON.stringify(nullMiddle));
  assert.notEqual(JSON.stringify(broken), JSON.stringify(newlineMiddle));
  f.resetWrites();
  const refused = await read(await f.req("/api/answers", "PUT", payload, { cookie }));
  assert.equal(refused.status, 422, JSON.stringify(refused.body));
  assert.equal(refused.body.error, "Choose an available answer.");
  assert.equal(refused.headers.get("Set-Cookie"), null);
  assert.equal(refused.text.includes(secret), false);
  assert.equal(refused.text.includes(sessionSecret), false);
  assert.equal(refused.text.includes(broken), false);
  assert.equal(refused.text.includes(escapeCharacter), false);
  assert.equal(refused.text.includes("\\u001b"), false);
  assert.equal(refused.text.includes("\\u001B"), false);
  assert.equal(refused.text.includes(deleteCharacter), false);
  assert.equal(refused.text.includes("\\u007f"), false);
  assert.equal(refused.text.includes("\\u007F"), false);
  assert.equal(refused.text.includes(nullCharacter), false);
  assert.equal(refused.text.includes("\\u0000"), false);
  assert.equal(refused.text.includes(newline), false);
  assert.equal(refused.text.includes("\\n"), false);
  assert.equal(refused.text.includes(legal), false);
  assert.deepEqual(f.written, []);

  const after = stored(f, reference);
  assert.deepEqual(after, snapshot);
  assert.deepEqual(after.answers, {});
  assert.equal(Object.hasOwn(after.answers, target.id), false);
  assert.equal(JSON.stringify(after.answers).includes(escapeCharacter), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u001b"), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u001B"), false);
  assert.equal(JSON.stringify(after.answers).includes(legal), false);
  assert.equal(JSON.stringify(after).includes(escapeCharacter), false);
  assert.equal(JSON.stringify(after).includes("\\u001b"), false);
  assert.equal(JSON.stringify(after).includes("\\u001B"), false);
  assert.equal(JSON.stringify(after).includes(deleteCharacter), false);
  assert.equal(JSON.stringify(after).includes("\\u007f"), false);
  assert.equal(JSON.stringify(after).includes("\\u007F"), false);
  assert.equal(JSON.stringify(after).includes(nullCharacter), false);
  assert.equal(JSON.stringify(after).includes("\\u0000"), false);
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
  assert.equal(viewed.text.includes(escapeCharacter), false);
  assert.equal(viewed.text.includes("\\u001b"), false);
  assert.equal(viewed.text.includes("\\u001B"), false);
  assert.equal(viewed.text.includes(deleteCharacter), false);
  assert.equal(viewed.text.includes(nullCharacter), false);
  assert.equal(viewed.text.includes("\\u0000"), false);
  assert.equal(viewed.text.includes(newline), false);
  assert.equal(viewed.text.includes("\\n"), false);
  assert.equal(f.records.get(reference).etag, openedEtag);
  assert.equal(stored(f, reference).inviteHash, inviteHash);
  assert.equal(stored(f, reference).sessionHash, sessionHash);
  assert.deepEqual(stored(f, reference).answers, {});
});
