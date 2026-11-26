import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import worker, { Assessment } from "../src/worker.js";

// One live hiring sitting. Save an answer for a real item on this paper
// whose choice id is that item's legal choice string with a backspace
// (U+0008) inserted in the middle. The save is refused. No answer is stored.
// The invite hash and the session secret stay unchanged.
// A vertical tab in the middle, a form feed in the middle, a CRLF pair in
// the middle, a carriage return alone in the middle, a newline in the middle,
// and a tab in the middle are separate checks.

const origin = "https://assessment.example";
const notice = {
  controller: "Test controller", contact: "privacy@example.invalid", basis: "Test basis",
  recipients: "Test reviewer", transfers: "Test transfer description", rights: "Test rights",
  purpose: "Test purpose", supervisoryAuthority: "Test authority", version: "test-1", retentionMinutes: 30,
};
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const random = () => crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
const backspace = "\u0008";
const verticalTab = "\u000b";

function flipLetterCase(value) {
  return Array.from(value, char => {
    const upper = char.toUpperCase();
    const lower = char.toLowerCase();
    if (char === lower && char !== upper) return upper;
    if (char === upper && char !== lower) return lower;
    return char;
  }).join("");
}

function backspaceInMiddle(value) {
  const at = Math.floor(value.length / 2);
  return { at, value: value.slice(0, at) + backspace + value.slice(at) };
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

test("a legal choice with a backspace inserted in the middle is refused and stores nothing", async () => {
  const source = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(source, /"LIVE_ENABLED": "false"/);
  assert.equal(backspace, "\b");
  assert.equal(backspace.charCodeAt(0), 8);
  assert.notEqual(backspace, verticalTab);
  assert.notEqual(backspace, "\f");
  assert.notEqual(backspace, "\t");
  assert.notEqual(backspace, "\n");
  assert.notEqual(backspace, "\r");
  assert.equal(/\s/.test(backspace), false);
  assert.equal(/\s/.test(verticalTab), true);
  assert.equal(/\s/.test("\f"), true);
  assert.equal(/\s/.test("\r"), true);
  assert.equal(/\s/.test("\n"), true);
  assert.equal(/\s/.test("\t"), true);
  assert.equal(JSON.stringify(backspace), "\"\\b\"");
  assert.notEqual(JSON.stringify(backspace), "\"\\u0008\"");
  assert.notEqual(JSON.stringify(backspace), "\"\\u000b\"");

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
  let target = null;
  let legal = null;
  for (const question of questions) {
    if (typeof question.id !== "string" || flipLetterCase(question.id) === question.id) continue;
    for (const option of question.options) {
      if (typeof option.id !== "string" || option.id.length < 2) continue;
      if (option.id.includes("\t") || option.id.includes("\n") || option.id.includes("\r") || option.id.includes("\f") || option.id.includes(verticalTab) || option.id.includes(backspace)) continue;
      if (option.id !== option.id.trim() || flipLetterCase(option.id) === option.id) continue;
      target = question;
      legal = option.id;
      break;
    }
    if (target) break;
  }
  assert.ok(target, "a real item has a legal choice that can take an interior backspace");
  assert.equal(questions.some(question => question.id === target.id), true);
  assert.equal(target.options.some(option => option.id === legal), true);
  assert.equal(uuid.test(legal), true);
  assert.equal(uuid.test(target.id), true);
  const flippedItem = flipLetterCase(target.id);
  const flippedChoice = flipLetterCase(legal);
  assert.notEqual(flippedItem, target.id);
  assert.notEqual(flippedChoice, legal);
  assert.equal(flippedChoice.length, legal.length);
  assert.equal(legal.startsWith(" "), false);
  assert.equal(legal.endsWith(" "), false);

  const inserted = backspaceInMiddle(legal);
  const broken = inserted.value;
  const at = inserted.at;
  const verticalMiddle = legal.slice(0, at) + verticalTab + legal.slice(at);
  const formFeedMiddle = legal.slice(0, at) + "\f" + legal.slice(at);
  const carriageMiddle = legal.slice(0, at) + "\r" + legal.slice(at);
  const newlineMiddle = legal.slice(0, at) + "\n" + legal.slice(at);
  const tabMiddle = legal.slice(0, at) + "\t" + legal.slice(at);
  const crlfMiddle = legal.slice(0, at) + "\r\n" + legal.slice(at);
  assert.ok(at > 0 && at < legal.length);
  assert.equal(broken.charCodeAt(at), 8);
  assert.notEqual(broken.charCodeAt(at), 11);
  assert.notEqual(broken.charCodeAt(at), 12);
  assert.notEqual(broken.charCodeAt(at), 13);
  assert.notEqual(broken.charCodeAt(at), 10);
  assert.notEqual(broken.charCodeAt(at), 9);
  assert.notEqual(broken.charCodeAt(at), 32);
  assert.equal(broken[at], backspace);
  assert.equal(broken.slice(0, at), legal.slice(0, at));
  assert.equal(broken.slice(at + 1), legal.slice(at));
  assert.equal(broken.slice(0, at).length > 0, true);
  assert.equal(broken.slice(at + 1).length > 0, true);
  assert.equal(broken.length, legal.length + 1);
  assert.notEqual(broken, legal);
  assert.equal(broken.replace(backspace, ""), legal);
  assert.equal([...broken].filter(char => char === backspace).length, 1);
  assert.equal(broken.indexOf(backspace), at);
  assert.equal(broken.startsWith(backspace), false);
  assert.equal(broken.endsWith(backspace), false);
  assert.notEqual(broken, backspace + legal);
  assert.notEqual(broken, legal + backspace);
  assert.equal(broken.includes(verticalTab), false);
  assert.equal(broken.includes("\f"), false);
  assert.equal(broken.includes("\r"), false);
  assert.equal(broken.includes("\n"), false);
  assert.equal(broken.includes("\t"), false);
  assert.equal(broken.includes("\r\n"), false);
  assert.notEqual(broken, verticalMiddle);
  assert.notEqual(broken, formFeedMiddle);
  assert.notEqual(broken, carriageMiddle);
  assert.notEqual(broken, newlineMiddle);
  assert.notEqual(broken, tabMiddle);
  assert.notEqual(broken, crlfMiddle);
  assert.equal(verticalMiddle.length, legal.length + 1);
  assert.equal(formFeedMiddle.length, legal.length + 1);
  assert.equal(carriageMiddle.length, legal.length + 1);
  assert.equal(newlineMiddle.length, legal.length + 1);
  assert.equal(tabMiddle.length, legal.length + 1);
  assert.equal(crlfMiddle.length, legal.length + 2);
  assert.equal(verticalMiddle.charCodeAt(at), 11);
  assert.equal(verticalMiddle.includes(backspace), false);
  assert.equal(formFeedMiddle.charCodeAt(at), 12);
  assert.equal(formFeedMiddle.includes(backspace), false);
  assert.equal(formFeedMiddle.includes(verticalTab), false);
  assert.equal(carriageMiddle.charCodeAt(at), 13);
  assert.equal(carriageMiddle.includes("\n"), false);
  assert.equal(carriageMiddle.includes(backspace), false);
  assert.equal(carriageMiddle.includes(verticalTab), false);
  assert.equal(carriageMiddle.includes("\f"), false);
  assert.equal(newlineMiddle.charCodeAt(at), 10);
  assert.equal(newlineMiddle.includes("\r"), false);
  assert.equal(newlineMiddle.includes(backspace), false);
  assert.equal(newlineMiddle.includes(verticalTab), false);
  assert.equal(newlineMiddle.includes("\f"), false);
  assert.equal(tabMiddle.charCodeAt(at), 9);
  assert.equal(tabMiddle.includes(backspace), false);
  assert.equal(tabMiddle.includes(verticalTab), false);
  assert.equal(tabMiddle.includes("\f"), false);
  assert.equal(crlfMiddle.charCodeAt(at), 13);
  assert.equal(crlfMiddle.charCodeAt(at + 1), 10);
  assert.equal(crlfMiddle.includes(backspace), false);
  assert.equal(crlfMiddle.includes(verticalTab), false);
  assert.equal(crlfMiddle.includes("\f"), false);
  assert.equal(broken.startsWith(" "), false);
  assert.equal(broken.endsWith(" "), false);
  assert.notEqual(broken, " " + legal);
  assert.notEqual(broken, legal + " ");
  assert.equal(broken.trim(), broken);
  assert.notEqual(broken.trim(), "");
  assert.notEqual(broken.trim(), legal);
  assert.equal(/^\s+$/.test(broken), false);
  assert.notEqual(broken, flippedChoice);
  assert.notEqual(broken, legal.toUpperCase());
  assert.equal(flipLetterCase(broken.replace(backspace, "")), flippedChoice);
  assert.equal(uuid.test(broken), false);
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
  assert.notEqual(payload.questionId, flippedItem);
  assert.equal(typeof payload.questionId, "string");
  assert.deepEqual(payload.choices, [broken]);
  assert.equal(payload.choices.length, 1);
  assert.equal(typeof payload.choices[0], "string");
  assert.equal(payload.choices[0].includes(backspace), true);
  assert.equal(payload.choices[0].charCodeAt(at), 8);
  assert.equal(payload.choices[0].includes(verticalTab), false);
  assert.equal(payload.choices[0].includes("\f"), false);
  assert.equal(payload.choices[0].includes("\r"), false);
  assert.equal(payload.choices[0].includes("\n"), false);
  assert.equal(payload.choices[0].includes("\t"), false);
  assert.equal(payload.choices[0].includes("\r\n"), false);
  assert.equal(payload.choices[0] === legal, false);
  assert.equal(payload.choices[0] === flippedChoice, false);
  assert.equal(payload.choices[0] === " " + legal, false);
  assert.equal(payload.choices[0] === legal + " ", false);
  assert.equal(payload.choices[0] === verticalMiddle, false);
  assert.equal(payload.choices[0] === formFeedMiddle, false);
  assert.equal(payload.choices[0] === carriageMiddle, false);
  assert.equal(payload.choices[0] === newlineMiddle, false);
  assert.equal(payload.choices[0] === tabMiddle, false);
  assert.equal(payload.choices[0] === crlfMiddle, false);
  assert.equal(raw.includes(JSON.stringify(broken)), true);
  assert.equal(raw.includes("\\b"), true);
  assert.equal(raw.includes("\\u0008"), false);
  assert.equal(raw.includes("\\u000b"), false);
  assert.equal(raw.includes("\\v"), false);
  assert.equal(raw.includes("\\f"), false);
  assert.equal(raw.includes("\\u000c"), false);
  assert.equal(raw.includes("\\r\\n"), false);
  assert.equal(raw.includes("\\r"), false);
  assert.equal(raw.includes("\\n"), false);
  assert.equal(raw.includes("\\t"), false);
  assert.equal(raw.includes(legal), false);
  assert.equal(raw.includes(flippedChoice), false);
  assert.equal(raw.includes(flippedItem), false);
  f.resetWrites();
  const refused = await read(await f.req("/api/answers", "PUT", payload, { cookie }));
  assert.equal(refused.status, 422, JSON.stringify(refused.body));
  assert.equal(refused.body.error, "Choose an available answer.");
  assert.equal(refused.headers.get("Set-Cookie"), null);
  assert.equal(refused.text.includes(secret), false);
  assert.equal(refused.text.includes(sessionSecret), false);
  assert.equal(refused.text.includes(broken), false);
  assert.equal(refused.text.includes(backspace), false);
  assert.equal(refused.text.includes("\\b"), false);
  assert.equal(refused.text.includes("\\u0008"), false);
  assert.equal(refused.text.includes("\\u000b"), false);
  assert.equal(refused.text.includes("\\v"), false);
  assert.equal(refused.text.includes("\\f"), false);
  assert.equal(refused.text.includes("\\r"), false);
  assert.equal(refused.text.includes("\\n"), false);
  assert.equal(refused.text.includes(legal), false);
  assert.deepEqual(f.written, []);

  const after = stored(f, reference);
  assert.deepEqual(after, snapshot);
  assert.deepEqual(after.answers, {});
  assert.equal(Object.hasOwn(after.answers, target.id), false);
  assert.equal(JSON.stringify(after.answers).includes(legal), false);
  assert.equal(JSON.stringify(after.answers).includes("\\b"), false);
  assert.equal(JSON.stringify(after.answers).includes("\\u0008"), false);
  assert.equal(JSON.stringify(after.answers).includes(backspace), false);
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
  assert.equal(viewed.text.includes(backspace), false);
  assert.equal(viewed.text.includes("\\b"), false);
  assert.equal(viewed.text.includes("\\u0008"), false);
  assert.equal(f.records.get(reference).etag, openedEtag);
  assert.equal(stored(f, reference).inviteHash, inviteHash);
  assert.equal(stored(f, reference).sessionHash, sessionHash);
  assert.deepEqual(stored(f, reference).answers, {});
});
