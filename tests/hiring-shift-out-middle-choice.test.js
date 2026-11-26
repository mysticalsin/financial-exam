import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import worker, { Assessment } from "../src/worker.js";

// One live hiring sitting. Save an answer for a real item on this paper
// whose choice id is that item's legal choice string with a shift-out
// character (U+000E) inserted in the middle. The save is refused. No
// answer is stored. The invite hash and the session secret stay unchanged.
// A data-link escape character in the middle, a device-control one
// character in the middle, and a newline in the middle are separate checks.

const origin = "https://assessment.example";
const notice = {
  controller: "Test controller", contact: "privacy@example.invalid", basis: "Test basis",
  recipients: "Test reviewer", transfers: "Test transfer description", rights: "Test rights",
  purpose: "Test purpose", supervisoryAuthority: "Test authority", version: "test-1", retentionMinutes: 30,
};
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const random = () => crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
const shiftOut = "\u000e";
const dataLinkEscape = "\u0010";
const deviceControlOne = "\u0011";
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

test("a legal choice with a shift-out character inserted in the middle is refused and stores nothing", async () => {
  const source = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(source, /"LIVE_ENABLED": "false"/);
  assert.equal(shiftOut, "\u000e");
  assert.equal(shiftOut, "\u000E");
  assert.equal(shiftOut.charCodeAt(0), 0x000E);
  assert.equal(shiftOut.codePointAt(0), 0x000E);
  assert.equal(shiftOut.length, 1);
  assert.notEqual(shiftOut, dataLinkEscape);
  assert.notEqual(shiftOut.charCodeAt(0), 0x0010);
  assert.notEqual(shiftOut, deviceControlOne);
  assert.notEqual(shiftOut.charCodeAt(0), 0x0011);
  assert.notEqual(shiftOut, newline);
  assert.notEqual(shiftOut.charCodeAt(0), 0x000A);
  assert.equal(dataLinkEscape, "\u0010");
  assert.equal(dataLinkEscape.charCodeAt(0), 0x0010);
  assert.equal(dataLinkEscape.codePointAt(0), 0x0010);
  assert.equal(dataLinkEscape.length, 1);
  assert.equal(deviceControlOne, "\u0011");
  assert.equal(deviceControlOne.charCodeAt(0), 0x0011);
  assert.equal(deviceControlOne.codePointAt(0), 0x0011);
  assert.equal(deviceControlOne.length, 1);
  assert.equal(newline, "\n");
  assert.equal(newline.charCodeAt(0), 0x000A);
  assert.equal(newline.codePointAt(0), 0x000A);
  assert.equal(newline.length, 1);
  assert.equal(/\s/.test(shiftOut), false);
  assert.equal(/\s/.test(dataLinkEscape), false);
  assert.equal(/\s/.test(deviceControlOne), false);
  assert.equal(/\s/.test(newline), true);
  assert.equal(/\p{Cc}/u.test(shiftOut), true);
  assert.equal(/\p{Cf}/u.test(shiftOut), false);
  assert.equal(/\p{Zl}/u.test(shiftOut), false);
  assert.equal(/\p{Zp}/u.test(shiftOut), false);
  assert.equal(/\p{Zs}/u.test(shiftOut), false);
  assert.equal(/\p{White_Space}/u.test(shiftOut), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(shiftOut), false);
  assert.equal(/\p{Cc}/u.test(dataLinkEscape), true);
  assert.equal(/\p{Cf}/u.test(dataLinkEscape), false);
  assert.equal(/\p{White_Space}/u.test(dataLinkEscape), false);
  assert.equal(/\p{Cc}/u.test(deviceControlOne), true);
  assert.equal(/\p{Cf}/u.test(deviceControlOne), false);
  assert.equal(/\p{White_Space}/u.test(deviceControlOne), false);
  assert.equal(/\p{Cc}/u.test(newline), true);
  assert.equal(/\p{Cf}/u.test(newline), false);
  assert.equal(/\p{White_Space}/u.test(newline), true);
  assert.equal(/\p{Pattern_White_Space}/u.test(newline), true);
  assert.equal(shiftOut.trim(), shiftOut);
  assert.notEqual(shiftOut.trim(), "");
  assert.equal(dataLinkEscape.trim(), dataLinkEscape);
  assert.notEqual(dataLinkEscape.trim(), "");
  assert.equal(deviceControlOne.trim(), deviceControlOne);
  assert.notEqual(deviceControlOne.trim(), "");
  assert.equal(newline.trim(), "");
  assert.notEqual(newline.trim(), newline);
  assert.equal(JSON.stringify(shiftOut), '"\\u000e"');
  assert.notEqual(JSON.stringify(shiftOut), '"\\u000E"');
  assert.equal(JSON.stringify(shiftOut).includes("\\"), true);
  assert.equal(JSON.stringify(shiftOut).includes("\\u000e"), true);
  assert.equal(JSON.stringify(shiftOut).includes("\\u000E"), false);
  assert.equal(JSON.stringify(shiftOut).includes(shiftOut), false);
  assert.notEqual(JSON.stringify(shiftOut), '"' + shiftOut + '"');
  assert.notEqual(JSON.stringify(shiftOut), '"\\u0010"');
  assert.notEqual(JSON.stringify(shiftOut), '"\\u0011"');
  assert.notEqual(JSON.stringify(shiftOut), '"\\n"');
  assert.notEqual(JSON.stringify(shiftOut), '"\\u000a"');
  assert.notEqual(JSON.stringify(shiftOut), '"\\u000A"');
  assert.equal(JSON.stringify(dataLinkEscape), '"\\u0010"');
  assert.equal(JSON.stringify(dataLinkEscape).includes("\\"), true);
  assert.equal(JSON.stringify(dataLinkEscape).includes(dataLinkEscape), false);
  assert.notEqual(JSON.stringify(dataLinkEscape), '"' + dataLinkEscape + '"');
  assert.notEqual(JSON.stringify(dataLinkEscape), '"\\u000e"');
  assert.notEqual(JSON.stringify(dataLinkEscape), '"\\u000E"');
  assert.notEqual(JSON.stringify(dataLinkEscape), '"\\u0011"');
  assert.equal(JSON.stringify(deviceControlOne), '"\\u0011"');
  assert.equal(JSON.stringify(deviceControlOne).includes("\\"), true);
  assert.equal(JSON.stringify(deviceControlOne).includes(deviceControlOne), false);
  assert.notEqual(JSON.stringify(deviceControlOne), '"' + deviceControlOne + '"');
  assert.notEqual(JSON.stringify(deviceControlOne), '"\\u000e"');
  assert.notEqual(JSON.stringify(deviceControlOne), '"\\u000E"');
  assert.notEqual(JSON.stringify(deviceControlOne), '"\\u0010"');
  assert.equal(JSON.stringify(newline), '"\\n"');
  assert.equal(JSON.stringify(newline).includes("\\n"), true);
  assert.equal(JSON.stringify(newline).includes(newline), false);
  assert.notEqual(JSON.stringify(newline), '"' + newline + '"');
  assert.notEqual(JSON.stringify(newline), '"\\u000a"');
  assert.notEqual(JSON.stringify(newline), '"\\u000A"');
  assert.notEqual(JSON.stringify(newline), '"\\u000e"');
  assert.notEqual(JSON.stringify(newline), '"\\u000E"');
  assert.notEqual(JSON.stringify(shiftOut), JSON.stringify(dataLinkEscape));
  assert.notEqual(JSON.stringify(shiftOut), JSON.stringify(deviceControlOne));
  assert.notEqual(JSON.stringify(shiftOut), JSON.stringify(newline));

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
  assert.ok(target, "a real item has a legal choice that can take an interior shift-out character");
  const legal = target.options.find(option => uuid.test(option.id)).id;
  assert.equal(questions.some(question => question.id === target.id), true);
  assert.equal(target.options.some(option => option.id === legal), true);
  assert.equal(uuid.test(legal), true);
  assert.equal(uuid.test(target.id), true);
  assert.equal(legal.length, 36);
  assert.equal(legal.includes(shiftOut), false);
  assert.equal(legal.includes(dataLinkEscape), false);
  assert.equal(legal.includes(deviceControlOne), false);
  assert.equal(legal.includes(newline), false);
  assert.equal(legal.trim(), legal);

  const inserted = insertedInMiddle(legal, shiftOut);
  const broken = inserted.value;
  const at = inserted.at;
  const dataLinkMiddle = insertedInMiddle(legal, dataLinkEscape).value;
  const deviceControlOneMiddle = insertedInMiddle(legal, deviceControlOne).value;
  const newlineMiddle = insertedInMiddle(legal, newline).value;
  assert.ok(at > 0 && at < legal.length);
  assert.equal(at, 18);
  assert.equal(legal.charCodeAt(at), 0x002D);
  assert.equal(broken.charCodeAt(at), 0x000E);
  assert.equal(broken.charCodeAt(at + 1), 0x002D);
  assert.notEqual(broken.charCodeAt(at), 0x0010);
  assert.notEqual(broken.charCodeAt(at), 0x0011);
  assert.notEqual(broken.charCodeAt(at), 0x000A);
  assert.equal(broken.slice(0, at), legal.slice(0, at));
  assert.equal(broken.slice(at + 1), legal.slice(at));
  assert.equal(broken.length, legal.length + 1);
  assert.notEqual(broken, legal);
  assert.equal(broken.replace(shiftOut, ""), legal);
  assert.equal([...broken].filter(char => char === shiftOut).length, 1);
  assert.equal(broken.indexOf(shiftOut), at);
  assert.equal(broken.startsWith(shiftOut), false);
  assert.equal(broken.endsWith(shiftOut), false);
  assert.notEqual(broken, shiftOut + legal);
  assert.notEqual(broken, legal + shiftOut);
  assert.notEqual(broken, dataLinkMiddle);
  assert.notEqual(broken, deviceControlOneMiddle);
  assert.notEqual(broken, newlineMiddle);
  assert.equal(broken.trim(), broken);
  assert.notEqual(broken.trim(), legal);
  assert.notEqual(broken.trim(), "");
  assert.equal((shiftOut + legal).trim(), shiftOut + legal);
  assert.notEqual((shiftOut + legal).trim(), legal);
  assert.equal((legal + shiftOut).trim(), legal + shiftOut);
  assert.notEqual((legal + shiftOut).trim(), legal);
  assert.equal((dataLinkEscape + legal).trim(), dataLinkEscape + legal);
  assert.equal((deviceControlOne + legal).trim(), deviceControlOne + legal);
  assert.equal((newline + legal).trim(), legal);
  assert.equal((legal + newline).trim(), legal);
  assert.equal(dataLinkMiddle.trim(), dataLinkMiddle);
  assert.notEqual(dataLinkMiddle.trim(), legal);
  assert.equal(deviceControlOneMiddle.trim(), deviceControlOneMiddle);
  assert.notEqual(deviceControlOneMiddle.trim(), legal);
  assert.equal(newlineMiddle.trim(), newlineMiddle);
  assert.notEqual(newlineMiddle.trim(), legal);
  assert.notEqual(newlineMiddle.trim(), "");
  assert.equal(/\s/.test(broken), false);
  assert.equal(/\s/.test(newlineMiddle), true);
  assert.equal(/\p{Cc}/u.test(broken), true);
  assert.equal(/\p{White_Space}/u.test(broken), false);
  assert.equal(/\p{Pattern_White_Space}/u.test(broken), false);
  assert.equal(/\p{White_Space}/u.test(newlineMiddle), true);
  assert.equal(/\p{Pattern_White_Space}/u.test(newlineMiddle), true);
  assert.equal(broken.includes(dataLinkEscape), false);
  assert.equal(broken.includes(deviceControlOne), false);
  assert.equal(broken.includes(newline), false);
  assert.equal(dataLinkMiddle.charCodeAt(at), 0x0010);
  assert.equal(dataLinkMiddle.includes(shiftOut), false);
  assert.equal(dataLinkMiddle.includes(deviceControlOne), false);
  assert.equal(dataLinkMiddle.includes(newline), false);
  assert.equal(deviceControlOneMiddle.charCodeAt(at), 0x0011);
  assert.equal(deviceControlOneMiddle.includes(shiftOut), false);
  assert.equal(deviceControlOneMiddle.includes(dataLinkEscape), false);
  assert.equal(deviceControlOneMiddle.includes(newline), false);
  assert.equal(newlineMiddle.charCodeAt(at), 0x000A);
  assert.equal(newlineMiddle.includes(shiftOut), false);
  assert.equal(newlineMiddle.includes(dataLinkEscape), false);
  assert.equal(newlineMiddle.includes(deviceControlOne), false);
  assert.equal(uuid.test(broken), false);
  const optionIds = questions.flatMap(question => question.options.map(option => option.id));
  assert.equal(optionIds.includes(legal), true);
  assert.equal(optionIds.includes(broken), false);
  assert.equal(optionIds.includes(dataLinkMiddle), false);
  assert.equal(optionIds.includes(deviceControlOneMiddle), false);
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
  assert.equal(payload.choices[0].charCodeAt(at), 0x000E);
  assert.equal(roundTrip.choices[0], broken);
  assert.equal(roundTrip.choices[0].charCodeAt(at), 0x000E);
  assert.notEqual(roundTrip.choices[0].charCodeAt(at), 0x0010);
  assert.notEqual(roundTrip.choices[0].charCodeAt(at), 0x0011);
  assert.notEqual(roundTrip.choices[0].charCodeAt(at), 0x000A);
  assert.equal(payload.choices[0] === legal, false);
  assert.equal(payload.choices[0] === dataLinkMiddle, false);
  assert.equal(payload.choices[0] === deviceControlOneMiddle, false);
  assert.equal(payload.choices[0] === newlineMiddle, false);
  assert.equal(raw.includes(shiftOut), false);
  assert.equal(raw.includes("\\u000e"), true);
  assert.equal(raw.includes("\\u000E"), false);
  assert.equal(raw.includes(dataLinkEscape), false);
  assert.equal(raw.includes("\\u0010"), false);
  assert.equal(raw.includes(deviceControlOne), false);
  assert.equal(raw.includes("\\u0011"), false);
  assert.equal(raw.includes(newline), false);
  assert.equal(raw.includes("\\n"), false);
  assert.equal(raw.includes("\\u000a"), false);
  assert.equal(raw.includes("\\u000A"), false);
  assert.equal(raw.includes(legal), false);
  assert.equal(JSON.stringify(broken).includes("\\u000e"), true);
  assert.equal(JSON.stringify(broken).includes("\\u000E"), false);
  assert.equal(JSON.stringify(broken).includes(shiftOut), false);
  assert.equal(JSON.stringify(broken).includes("\\u0010"), false);
  assert.equal(JSON.stringify(broken).includes("\\u0011"), false);
  assert.equal(JSON.stringify(broken).includes("\\n"), false);
  assert.equal(JSON.stringify(broken).includes("\\u000a"), false);
  assert.equal(JSON.stringify(broken).includes("\\u000A"), false);
  assert.equal(JSON.stringify(dataLinkMiddle).includes("\\u0010"), true);
  assert.equal(JSON.stringify(dataLinkMiddle).includes(dataLinkEscape), false);
  assert.equal(JSON.stringify(dataLinkMiddle).includes("\\u000e"), false);
  assert.equal(JSON.stringify(dataLinkMiddle).includes("\\u000E"), false);
  assert.equal(JSON.stringify(dataLinkMiddle).includes(shiftOut), false);
  assert.equal(JSON.stringify(deviceControlOneMiddle).includes("\\u0011"), true);
  assert.equal(JSON.stringify(deviceControlOneMiddle).includes(deviceControlOne), false);
  assert.equal(JSON.stringify(deviceControlOneMiddle).includes("\\u000e"), false);
  assert.equal(JSON.stringify(deviceControlOneMiddle).includes(shiftOut), false);
  assert.equal(JSON.stringify(newlineMiddle).includes("\\n"), true);
  assert.equal(JSON.stringify(newlineMiddle).includes("\\u000a"), false);
  assert.equal(JSON.stringify(newlineMiddle).includes("\\u000A"), false);
  assert.equal(JSON.stringify(newlineMiddle).includes(newline), false);
  assert.equal(JSON.stringify(newlineMiddle).includes("\\u000e"), false);
  assert.equal(JSON.stringify(newlineMiddle).includes("\\u000E"), false);
  assert.equal(JSON.stringify(newlineMiddle).includes(shiftOut), false);
  assert.notEqual(JSON.stringify(broken), JSON.stringify(dataLinkMiddle));
  assert.notEqual(JSON.stringify(broken), JSON.stringify(deviceControlOneMiddle));
  assert.notEqual(JSON.stringify(broken), JSON.stringify(newlineMiddle));
  f.resetWrites();
  const refused = await read(await f.req("/api/answers", "PUT", payload, { cookie }));
  assert.equal(refused.status, 422, JSON.stringify(refused.body));
  assert.equal(refused.body.error, "Choose an available answer.");
  assert.equal(refused.headers.get("Set-Cookie"), null);
  assert.equal(refused.text.includes(secret), false);
  assert.equal(refused.text.includes(sessionSecret), false);
  assert.equal(refused.text.includes(broken), false);
  assert.equal(refused.text.includes(shiftOut), false);
  assert.equal(refused.text.includes("\\u000e"), false);
  assert.equal(refused.text.includes("\\u000E"), false);
  assert.equal(refused.text.includes(dataLinkEscape), false);
  assert.equal(refused.text.includes("\\u0010"), false);
  assert.equal(refused.text.includes(deviceControlOne), false);
  assert.equal(refused.text.includes("\\u0011"), false);
  assert.equal(refused.text.includes(newline), false);
  assert.equal(refused.text.includes("\\n"), false);
  assert.equal(refused.text.includes("\\u000a"), false);
  assert.equal(refused.text.includes("\\u000A"), false);
  assert.equal(refused.text.includes(legal), false);
  assert.deepEqual(f.written, []);

  const after = stored(f, reference);
  assert.deepEqual(after, snapshot);
  assert.deepEqual(after.answers, {});
  assert.equal(Object.hasOwn(after.answers, target.id), false);
  assert.equal(JSON.stringify(after.answers).includes(shiftOut), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u000e"), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u000E"), false);
  assert.equal(JSON.stringify(after.answers).includes(legal), false);
  assert.equal(JSON.stringify(after).includes(shiftOut), false);
  assert.equal(JSON.stringify(after).includes("\\u000e"), false);
  assert.equal(JSON.stringify(after).includes("\\u000E"), false);
  assert.equal(JSON.stringify(after).includes(dataLinkEscape), false);
  assert.equal(JSON.stringify(after).includes("\\u0010"), false);
  assert.equal(JSON.stringify(after).includes(deviceControlOne), false);
  assert.equal(JSON.stringify(after).includes("\\u0011"), false);
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
  assert.equal(viewed.text.includes(shiftOut), false);
  assert.equal(viewed.text.includes("\\u000e"), false);
  assert.equal(viewed.text.includes("\\u000E"), false);
  assert.equal(viewed.text.includes(dataLinkEscape), false);
  assert.equal(viewed.text.includes("\\u0010"), false);
  assert.equal(viewed.text.includes(deviceControlOne), false);
  assert.equal(viewed.text.includes("\\u0011"), false);
  assert.equal(viewed.text.includes(newline), false);
  assert.equal(viewed.text.includes("\\n"), false);
  assert.equal(viewed.text.includes("\\u000a"), false);
  assert.equal(viewed.text.includes("\\u000A"), false);
  assert.equal(f.records.get(reference).etag, openedEtag);
  assert.equal(stored(f, reference).inviteHash, inviteHash);
  assert.equal(stored(f, reference).sessionHash, sessionHash);
  assert.deepEqual(stored(f, reference).answers, {});
});
