import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import worker, { Assessment } from "../src/worker.js";

// One live hiring sitting. Save an answer whose item id is a real item id
// from this paper with the letter case flipped, and whose choice id is a
// legal choice for that original item. A lower letter becomes upper, and an
// upper letter becomes lower. The save is refused. No answer is stored. The
// invite hash and the session secret stay unchanged.
// A case-flipped choice id, a leading or trailing space, and a JSON null
// item id are separate checks.

const origin = "https://assessment.example";
const notice = {
  controller: "Test controller", contact: "privacy@example.invalid", basis: "Test basis",
  recipients: "Test reviewer", transfers: "Test transfer description", rights: "Test rights",
  purpose: "Test purpose", supervisoryAuthority: "Test authority", version: "test-1", retentionMinutes: 30,
};
const random = () => crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");

function flipLetterCase(value) {
  return Array.from(value, char => {
    const upper = char.toUpperCase();
    const lower = char.toLowerCase();
    if (char === lower && char !== upper) return upper;
    if (char === upper && char !== lower) return lower;
    return char;
  }).join("");
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

test("a real item id with its letter case flipped is refused and stores nothing", async () => {
  const source = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(source, /"LIVE_ENABLED": "false"/);

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
  let flipped = null;
  for (const question of questions) {
    assert.equal(typeof question.id, "string");
    assert.equal(Number.isInteger(question.id), false);
    assert.equal(question.id === null, false);
    const next = flipLetterCase(question.id);
    if (next === question.id || next.length !== question.id.length) continue;
    for (const option of question.options) {
      const flippedChoice = flipLetterCase(option.id);
      if (typeof option.id === "string" && flippedChoice !== option.id && option.id !== next && flippedChoice !== next) {
        target = question;
        legal = option.id;
        flipped = next;
        break;
      }
    }
    if (target) break;
  }
  assert.ok(target, "a real item id contains a letter whose case can flip");
  assert.equal(questions.some(question => question.id === target.id), true);
  assert.equal(questions.some(question => question.id === flipped), false);
  assert.equal(questions.filter(question => question.id.toLowerCase() === flipped.toLowerCase()).length, 1);
  assert.equal(questions.find(question => question.id.toLowerCase() === flipped.toLowerCase()).id, target.id);
  assert.equal(target.options.some(option => option.id === legal), true);
  assert.equal(legal.length > 0, true);
  assert.equal(legal === null, false);
  assert.equal(typeof legal, "string");
  assert.equal(legal.trim(), legal);
  assert.equal(legal.startsWith(" "), false);
  assert.equal(legal.endsWith(" "), false);
  assert.equal(flipped.length, target.id.length);
  assert.notEqual(flipped, target.id);
  assert.equal(flipLetterCase(flipped), target.id);
  assert.equal(flipped.toLowerCase(), target.id.toLowerCase());
  assert.notEqual(flipped, legal);
  assert.notEqual(flipped, flipLetterCase(legal));
  assert.notEqual(legal, flipLetterCase(legal));
  let changed = 0;
  for (let i = 0; i < target.id.length; i++) {
    const before = target.id[i];
    const after = flipped[i];
    const upper = before.toUpperCase();
    const lower = before.toLowerCase();
    if (upper === lower) assert.equal(after, before);
    else if (before === lower) {
      assert.equal(after, upper);
      changed += 1;
    } else {
      assert.equal(before, upper);
      assert.equal(after, lower);
      changed += 1;
    }
  }
  assert.ok(changed >= 1);
  assert.equal(typeof flipped, "string");
  assert.equal(flipped.trim(), flipped);
  assert.equal(flipped.startsWith(" "), false);
  assert.equal(flipped.endsWith(" "), false);
  assert.notEqual(flipped, " " + target.id);
  assert.notEqual(flipped, target.id + " ");
  assert.equal(flipped === "", false);
  assert.equal(flipped === null, false);
  const optionIds = questions.flatMap(question => question.options.map(option => option.id));
  assert.equal(optionIds.includes(legal), true);
  assert.equal(optionIds.includes(flipped), false);
  assert.equal(target.options.some(option => option.id === flipped), false);
  const paper = structuredClone(opened.paper);
  const inviteHash = opened.inviteHash;
  const sessionHash = opened.sessionHash;
  const alarm = f.objects.get(reference).ctx.storage.alarm;
  const openedEtag = f.records.get(reference).etag;
  const snapshot = structuredClone(opened);
  const metadata = structuredClone(f.records.get(reference).metadata);

  const payload = { reference, questionId: flipped, choices: [legal], revision: 1 };
  const raw = JSON.stringify(payload);
  const parsed = JSON.parse(raw);
  assert.deepEqual(Object.keys(payload).sort(), ["choices", "questionId", "reference", "revision"]);
  assert.deepEqual(Object.keys(parsed).sort(), ["choices", "questionId", "reference", "revision"]);
  assert.equal(Object.hasOwn(payload, "questionId"), true);
  assert.equal(payload.questionId, flipped);
  assert.equal(parsed.questionId, flipped);
  assert.equal(typeof payload.questionId, "string");
  assert.equal(payload.questionId === target.id, false);
  assert.equal(payload.questionId === null, false);
  assert.equal(Number.isInteger(payload.questionId), false);
  assert.equal(questions.some(question => question.id === payload.questionId), false);
  assert.deepEqual(payload.choices, [legal]);
  assert.equal(payload.choices.length, 1);
  assert.equal(typeof payload.choices[0], "string");
  assert.equal(payload.choices[0], legal);
  assert.equal(payload.choices[0] === flipLetterCase(legal), false);
  assert.equal(payload.choices[0] === "", false);
  assert.equal(payload.choices[0] === null, false);
  assert.equal(payload.choices[0].trim(), legal);
  assert.equal(target.options.some(option => option.id === payload.choices[0]), true);
  assert.equal(raw.includes(JSON.stringify(flipped)), true);
  assert.equal(raw.includes(JSON.stringify(legal)), true);
  assert.equal(raw.includes(JSON.stringify(target.id)), false);
  assert.equal(raw.includes(JSON.stringify(flipLetterCase(legal))), false);
  assert.equal(raw.includes('"questionId":null'), false);
  assert.equal(raw.includes('"choices":[null]'), false);
  assert.equal(raw.includes('"choices":[""]'), false);
  f.resetWrites();
  const refused = await read(await f.req("/api/answers", "PUT", payload, { cookie }));
  assert.equal(refused.status, 422, JSON.stringify(refused.body));
  assert.equal(refused.body.error, "Choose a question from this assessment.");
  assert.equal(refused.headers.get("Set-Cookie"), null);
  assert.equal(refused.text.includes(secret), false);
  assert.equal(refused.text.includes(sessionSecret), false);
  assert.equal(refused.text.includes(flipped), false);
  assert.equal(refused.text.includes(legal), false);
  assert.equal(refused.text.includes(target.id), false);
  assert.deepEqual(f.written, []);

  const after = stored(f, reference);
  assert.deepEqual(after, snapshot);
  assert.deepEqual(after.answers, {});
  assert.equal(Object.hasOwn(after.answers, target.id), false);
  assert.equal(Object.hasOwn(after.answers, flipped), false);
  assert.equal(JSON.stringify(after.answers).includes(flipped), false);
  assert.equal(JSON.stringify(after.answers).includes(legal), false);
  assert.equal(JSON.stringify(after).includes(flipped), false);
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
  assert.equal(viewed.text.includes(flipped), false);
  assert.equal(f.records.get(reference).etag, openedEtag);
  assert.equal(stored(f, reference).inviteHash, inviteHash);
  assert.equal(stored(f, reference).sessionHash, sessionHash);
  assert.deepEqual(stored(f, reference).answers, {});
});
