import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import worker, { Assessment } from "../src/worker.js";

// A valid JSON object for hiring start or answer save, with Content-Type
// application/json; charset=utf-8. The bytes are that route's object, so this
// is distinct from a missing Content-Type, a text/plain object, a non-JSON or
// empty body, a JSON array or null, and an object with an extra field.
// The charset parameter is accepted. The paper, session, and stored answer
// match a bare application/json request, and the invite hash stays put.

const origin = "https://assessment.example";
const CHARSET = "application/json; charset=utf-8";
const BARE = "application/json";
const notice = {
  controller: "Test controller", contact: "privacy@example.invalid", basis: "Test basis",
  recipients: "Test reviewer", transfers: "Test transfer description", rights: "Test rights",
  purpose: "Test purpose", supervisoryAuthority: "Test authority", version: "test-1", retentionMinutes: 30,
};
const random = () => crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");

async function digest(value) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

function fixture() {
  const objects = new Map();
  const records = new Map();
  let writes = 0;
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
        writes += 1;
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
  async function req(path, method = "GET", data, { cookie, admin, headers = {} } = {}) {
    const init = { method, headers: { ...headers } };
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
    env, objects, records, req, admin: { admin: true },
    writes: () => writes,
    resetWrites() { writes = 0; },
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

async function send(f, path, method, payload, contentType, cookie) {
  const text = JSON.stringify(payload);
  const parsed = JSON.parse(text);
  assert.ok(parsed && typeof parsed === "object" && !Array.isArray(parsed), text);
  const headers = { Origin: origin, "Content-Type": contentType };
  if (cookie) headers.Cookie = cookie;
  const request = new Request(origin + path, { method, headers, body: text });
  assert.equal(request.headers.get("Content-Type"), contentType);
  assert.equal(await request.clone().text(), text);
  return worker.fetch(request, f.env);
}

async function issue(f) {
  const issued = await read(await f.req("/api/ops/invites", "POST", { durationMinutes: 20 }, f.admin));
  assert.equal(issued.status, 201, JSON.stringify(issued.body));
  assert.equal(issued.headers.get("Content-Type"), BARE);
  const secret = issued.body.invite.split(".")[1];
  const record = stored(f, issued.body.reference);
  assert.equal(record.inviteHash, await digest(secret));
  assert.equal(record.status, "invited");
  assert.equal(record.paper, undefined);
  assert.equal(record.answers, undefined);
  assert.equal(record.sessionHash, undefined);
  assert.equal(record.revision, 0);
  return { ...issued.body, secret, inviteHash: record.inviteHash };
}

async function begin(f, invite) {
  const claim = random();
  const started = await f.req("/api/start", "POST", {
    invite: invite.invite, claim, noticeVersion: notice.version,
  });
  const sitting = await read(started);
  assert.equal(sitting.status, 200, JSON.stringify(sitting.body));
  assert.equal(sitting.headers.get("Content-Type"), BARE);
  const cookie = started.headers.get("Set-Cookie").split(";")[0];
  const sessionSecret = cookie.slice(cookie.indexOf(".") + 1);
  const record = stored(f, invite.reference);
  assert.equal(record.status, "active");
  assert.equal(record.revision, 1);
  assert.deepEqual(record.answers, {});
  assert.equal(record.paper.questions.length, 15);
  assert.equal(record.inviteHash, invite.inviteHash);
  assert.equal(record.sessionHash, await digest(sessionSecret));
  assert.notEqual(sessionSecret, invite.secret);
  assert.equal(cookie, "__Host-assessment=" + invite.reference + "." + sessionSecret);
  return { cookie, sessionSecret, sitting, claim };
}

async function opened(f, invite, response) {
  const sitting = await read(response);
  assert.equal(sitting.status, 200, JSON.stringify(sitting.body));
  const setCookie = sitting.headers.get("Set-Cookie");
  assert.ok(setCookie);
  const cookie = setCookie.split(";")[0];
  const sessionSecret = cookie.slice(cookie.indexOf(".") + 1);
  const record = stored(f, invite.reference);
  const entry = f.records.get(invite.reference);
  return {
    sitting, cookie, sessionSecret, record,
    effect: {
      status: sitting.status,
      contentType: sitting.headers.get("Content-Type"),
      cacheControl: sitting.headers.get("Cache-Control"),
      error: sitting.body?.error ?? null,
      recordStatus: record.status,
      revision: record.revision,
      answers: record.answers,
      questionCount: record.paper.questions.length,
      attemptQuestionCount: sitting.body.attempt.questions.length,
      attemptAnswers: sitting.body.attempt.answers,
      attemptRevision: sitting.body.attempt.revision,
      attemptStatus: sitting.body.attempt.status,
      attemptTotal: sitting.body.attempt.total,
      attemptAnswered: sitting.body.attempt.answered,
      noticeVersion: record.notice.version,
      country: record.country,
      durationMinutes: record.durationMinutes,
      inviteHashUnchanged: record.inviteHash === invite.inviteHash,
      sessionBound: record.sessionHash === await digest(sessionSecret),
      sessionDiffersFromInvite: sessionSecret !== invite.secret,
      hostCookie: cookie === "__Host-assessment=" + invite.reference + "." + sessionSecret,
      secureCookie: setCookie.includes("; Secure; HttpOnly; SameSite=Strict;"),
      secretsHidden: !sitting.text.includes(invite.secret) && !sitting.text.includes(sessionSecret),
      writes: f.writes(),
      alarmSet: typeof f.objects.get(invite.reference).ctx.storage.alarm === "number",
      metadataKeys: Object.keys(entry.metadata).sort(),
    },
  };
}

function savedEffect(f, invite, before, saved, question, choice, sessionSecret, alarm, etag) {
  const after = stored(f, invite.reference);
  const entry = f.records.get(invite.reference);
  return {
    status: saved.status,
    contentType: saved.headers.get("Content-Type"),
    cacheControl: saved.headers.get("Cache-Control"),
    setCookie: saved.headers.get("Set-Cookie"),
    error: saved.body?.error ?? null,
    recordStatus: after.status,
    revision: after.revision,
    answerCount: Object.keys(after.answers).length,
    storedMatchesSubmitted: JSON.stringify(after.answers[question.id]) === JSON.stringify([choice]),
    responseMatchesStored: JSON.stringify(saved.body.attempt.answers) === JSON.stringify(after.answers),
    responseRevision: saved.body.attempt.revision,
    responseStatus: saved.body.attempt.status,
    responseAnswered: saved.body.attempt.answered,
    paperUnchanged: JSON.stringify(after.paper) === JSON.stringify(before.paper),
    inviteHashUnchanged: after.inviteHash === invite.inviteHash && after.inviteHash === before.inviteHash,
    sessionHashUnchanged: after.sessionHash === before.sessionHash,
    secretsHidden: !saved.text.includes(invite.secret) && !saved.text.includes(sessionSecret),
    writes: f.writes(),
    alarmUnchanged: f.objects.get(invite.reference).ctx.storage.alarm === alarm,
    metadataKeys: Object.keys(entry.metadata).sort(),
    etagChanged: entry.etag !== etag,
  };
}

test("a charset utf-8 JSON object on hiring start is accepted and matches a bare JSON start", async () => {
  const source = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(source, /"LIVE_ENABLED": "false"/);
  assert.equal(CHARSET.split(";")[0].trim().toLowerCase(), "application/json");
  assert.match(CHARSET, /;\s*charset=utf-8$/);
  assert.notEqual(CHARSET, BARE);

  const f = fixture();
  const charsetInvite = await issue(f);
  const claim = random();
  const payload = { invite: charsetInvite.invite, claim, noticeVersion: notice.version };
  assert.deepEqual(Object.keys(payload).sort(), ["claim", "invite", "noticeVersion"]);
  const before = structuredClone(stored(f, charsetInvite.reference));
  assert.equal(before.status, "invited");
  assert.equal(before.paper, undefined);
  assert.equal(before.sessionHash, undefined);
  assert.equal(before.inviteHash, charsetInvite.inviteHash);

  f.resetWrites();
  const charset = await opened(f, charsetInvite, await send(f, "/api/start", "POST", payload, CHARSET));
  assert.equal(charset.effect.status, 200);
  assert.equal(charset.effect.contentType, BARE);
  assert.equal(charset.effect.recordStatus, "active");
  assert.equal(charset.effect.revision, 1);
  assert.deepEqual(charset.effect.answers, {});
  assert.equal(charset.effect.questionCount, 15);
  assert.equal(charset.effect.inviteHashUnchanged, true);
  assert.equal(charset.effect.sessionBound, true);
  assert.equal(charset.record.inviteHash, await digest(charsetInvite.secret));
  assert.equal(f.records.size, 1);
  assert.equal(f.objects.size, 1);

  const bareInvite = await issue(f);
  const barePayload = { invite: bareInvite.invite, claim: random(), noticeVersion: notice.version };
  f.resetWrites();
  const bare = await opened(f, bareInvite, await send(f, "/api/start", "POST", barePayload, BARE));

  assert.deepEqual(charset.effect, bare.effect);
  assert.deepEqual(charset.effect, {
    status: 200,
    contentType: "application/json",
    cacheControl: "private, no-store",
    error: null,
    recordStatus: "active",
    revision: 1,
    answers: {},
    questionCount: 15,
    attemptQuestionCount: 15,
    attemptAnswers: {},
    attemptRevision: 1,
    attemptStatus: "active",
    attemptTotal: 15,
    attemptAnswered: 0,
    noticeVersion: "test-1",
    country: "FR",
    durationMinutes: 20,
    inviteHashUnchanged: true,
    sessionBound: true,
    sessionDiffersFromInvite: true,
    hostCookie: true,
    secureCookie: true,
    secretsHidden: true,
    writes: 1,
    alarmSet: true,
    metadataKeys: ["purgeAt"],
  });
  assert.equal(stored(f, bareInvite.reference).status, "active");
  assert.equal(stored(f, bareInvite.reference).inviteHash, bareInvite.inviteHash);
  assert.equal(f.records.size, 2);
  assert.equal(f.objects.size, 2);
});

test("a charset utf-8 JSON object on answer save is accepted and matches a bare JSON save", async () => {
  const f = fixture();

  async function save(contentType) {
    const invite = await issue(f);
    const { cookie, sessionSecret, sitting } = await begin(f, invite);
    const question = sitting.body.attempt.questions[0];
    const choice = question.options[0].id;
    const payload = {
      reference: invite.reference,
      questionId: question.id,
      choices: [choice],
      revision: sitting.body.attempt.revision,
    };
    assert.deepEqual(Object.keys(payload).sort(), ["choices", "questionId", "reference", "revision"]);
    const before = structuredClone(stored(f, invite.reference));
    const etag = f.records.get(invite.reference).etag;
    const alarm = f.objects.get(invite.reference).ctx.storage.alarm;
    assert.equal(before.inviteHash, invite.inviteHash);
    assert.equal(before.sessionHash, await digest(sessionSecret));
    assert.deepEqual(before.answers, {});
    assert.equal(before.revision, 1);

    f.resetWrites();
    const saved = await read(await send(f, "/api/answers", "PUT", payload, contentType, cookie));
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.headers.get("Content-Type"), BARE);
    const after = stored(f, invite.reference);
    assert.deepEqual(after.answers, { [question.id]: [choice] });
    assert.equal(after.revision, 2);
    assert.equal(after.inviteHash, invite.inviteHash);
    assert.equal(after.sessionHash, before.sessionHash);
    assert.deepEqual(after.paper, before.paper);
    return savedEffect(f, invite, before, saved, question, choice, sessionSecret, alarm, etag);
  }

  const charset = await save(CHARSET);
  const bare = await save(BARE);
  assert.deepEqual(charset, bare);
  assert.deepEqual(charset, {
    status: 200,
    contentType: "application/json",
    cacheControl: "private, no-store",
    setCookie: null,
    error: null,
    recordStatus: "active",
    revision: 2,
    answerCount: 1,
    storedMatchesSubmitted: true,
    responseMatchesStored: true,
    responseRevision: 2,
    responseStatus: "active",
    responseAnswered: 1,
    paperUnchanged: true,
    inviteHashUnchanged: true,
    sessionHashUnchanged: true,
    secretsHidden: true,
    writes: 1,
    alarmUnchanged: true,
    metadataKeys: ["purgeAt"],
    etagChanged: true,
  });
  assert.equal(f.records.size, 2);
  assert.equal(f.objects.size, 2);
});
