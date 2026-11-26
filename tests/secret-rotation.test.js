import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import worker, { Assessment } from "../src/worker.js";

// The invite secret stays the secret that was issued. A mismatch does not replace it.
// A successful start keeps that hash and hands the browser a different session secret
// derived from the invite secret and the claim. Nothing here describes a deployed Worker.

const origin = "https://assessment.example";
const notice = {
  controller: "Test controller", contact: "privacy@example.invalid", basis: "Test basis",
  recipients: "Test reviewer", transfers: "Test transfer description", rights: "Test rights",
  purpose: "Test purpose", supervisoryAuthority: "Test authority", version: "test-1", retentionMinutes: 30,
};
const random = () => crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");

function nearMiss(secret) {
  return secret.slice(0, -1) + (secret.at(-1) === "a" ? "b" : "a");
}

async function digest(value) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
}

function fixture() {
  const objects = new Map();
  const records = new Map();
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
      async list() {
        return {
          objects: [...records].map(([key, entry]) => ({ key, customMetadata: entry.metadata })),
          truncated: false,
        };
      },
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
  return { env, records, req, admin: { admin: true } };
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

async function issue(f, durationMinutes) {
  const issued = await read(await f.req("/api/ops/invites", "POST", { durationMinutes }, f.admin));
  assert.equal(issued.status, 201, JSON.stringify(issued.body));
  return issued.body;
}

test("a wrong invite secret does not rotate the stored secret", async () => {
  const source = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(source, /"LIVE_ENABLED": "false"/);

  const f = fixture();
  const issued = await issue(f, 26);
  const secret = issued.invite.split(".")[1];
  const before = structuredClone(stored(f, issued.reference));
  const etag = f.records.get(issued.reference).etag;
  assert.equal(before.inviteHash, await digest(secret));
  assert.equal(before.status, "invited");
  assert.equal(before.sessionHash, undefined);

  const preview = await read(await f.req("/api/invitation", "POST", { invite: issued.invite }));
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get("Set-Cookie"), null);
  assert.equal(preview.text.includes(secret), false);
  assert.equal(f.records.get(issued.reference).etag, etag);

  const mismatched = issued.reference + "." + nearMiss(secret);
  const refusedPreview = await read(await f.req("/api/invitation", "POST", { invite: mismatched }));
  const refusedStart = await read(await f.req("/api/start", "POST", {
    invite: mismatched, claim: random(), noticeVersion: notice.version,
  }));
  for (const refused of [refusedPreview, refusedStart]) {
    assert.equal(refused.status, 403);
    assert.match(refused.body.error, /unavailable/);
    assert.doesNotMatch(refused.body.error, /already been used|currently closed/);
    assert.equal(refused.headers.get("Set-Cookie"), null);
    assert.equal(refused.text.includes(secret), false);
    assert.deepEqual(stored(f, issued.reference), before);
    assert.equal(f.records.get(issued.reference).etag, etag);
  }

  const claim = random();
  const started = await f.req("/api/start", "POST", {
    invite: issued.invite, claim, noticeVersion: notice.version,
  });
  const sitting = await read(started);
  assert.equal(sitting.status, 200, JSON.stringify(sitting.body));
  const cookie = started.headers.get("Set-Cookie");
  const sessionSecret = cookie.split(";")[0].split(".")[1];
  assert.equal(sessionSecret, await digest("assessment-session-v1/" + secret + "/" + claim));
  assert.notEqual(sessionSecret, secret);
  assert.equal(stored(f, issued.reference).inviteHash, before.inviteHash);
  assert.equal(stored(f, issued.reference).sessionHash, await digest(sessionSecret));
  assert.equal(sitting.text.includes(secret), false);
  assert.equal(sitting.text.includes(sessionSecret), false);
  assert.equal(cookie.includes(secret), false);
  const etagAfterStart = f.records.get(issued.reference).etag;

  const again = await read(await f.req("/api/invitation", "POST", { invite: mismatched }));
  assert.equal(again.status, 403);
  assert.equal(again.headers.get("Set-Cookie"), null);
  assert.equal(stored(f, issued.reference).inviteHash, before.inviteHash);
  assert.equal(f.records.get(issued.reference).etag, etagAfterStart);
  const afterMismatch = await read(await f.req("/api/start", "POST", {
    invite: mismatched, claim, noticeVersion: notice.version,
  }));
  assert.equal(afterMismatch.status, 403);
  assert.equal(afterMismatch.headers.get("Set-Cookie"), null);
  assert.equal(stored(f, issued.reference).inviteHash, before.inviteHash);
  assert.equal(stored(f, issued.reference).sessionHash, await digest(sessionSecret));
  assert.equal(f.records.get(issued.reference).etag, etagAfterStart);

  const session = await read(await f.req("/api/session", "GET", undefined, {
    cookie: cookie.split(";")[0], reference: issued.reference,
  }));
  assert.equal(session.status, 200);
  assert.equal(session.body.attempt.status, "active");
  assert.equal(session.body.attempt.reference, issued.reference);
});

test("a successful start derives the session secret from that invite and does not replace it", async () => {
  const f = fixture();
  const claim = random();
  const first = await issue(f, 19);
  const second = await issue(f, 23);
  const firstSecret = first.invite.split(".")[1];
  const secondSecret = second.invite.split(".")[1];
  const firstHash = stored(f, first.reference).inviteHash;
  const secondHash = stored(f, second.reference).inviteHash;
  assert.equal(firstHash, await digest(firstSecret));
  assert.equal(secondHash, await digest(secondSecret));
  assert.notEqual(firstSecret, secondSecret);

  const start = (issued) => f.req("/api/start", "POST", {
    invite: issued.invite, claim, noticeVersion: notice.version,
  });
  const startedFirst = await start(first);
  const startedSecond = await start(second);
  const a = await read(startedFirst);
  const b = await read(startedSecond);
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(b.status, 200, JSON.stringify(b.body));
  const cookieA = startedFirst.headers.get("Set-Cookie").split(";")[0];
  const cookieB = startedSecond.headers.get("Set-Cookie").split(";")[0];
  const sessionA = cookieA.split(".")[1];
  const sessionB = cookieB.split(".")[1];
  assert.equal(sessionA, await digest("assessment-session-v1/" + firstSecret + "/" + claim));
  assert.equal(sessionB, await digest("assessment-session-v1/" + secondSecret + "/" + claim));
  assert.notEqual(sessionA, sessionB);
  assert.notEqual(sessionA, firstSecret);
  assert.notEqual(sessionB, secondSecret);
  assert.equal(stored(f, first.reference).inviteHash, firstHash);
  assert.equal(stored(f, second.reference).inviteHash, secondHash);
  assert.equal(stored(f, first.reference).sessionHash, await digest(sessionA));
  assert.equal(stored(f, second.reference).sessionHash, await digest(sessionB));
  assert.equal(JSON.stringify(stored(f, first.reference)).includes(firstSecret), false);
  assert.equal(JSON.stringify(stored(f, first.reference)).includes(sessionA), false);
  assert.equal(JSON.stringify(stored(f, first.reference)).includes(claim), false);

  const etag = f.records.get(first.reference).etag;
  const paper = stored(f, first.reference).paper.questions.map(question => question.id).join();
  const retry = await start(first);
  const retried = await read(retry);
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  assert.equal(retry.headers.get("Set-Cookie").split(";")[0], cookieA);
  assert.equal(f.records.get(first.reference).etag, etag);
  assert.equal(stored(f, first.reference).inviteHash, firstHash);
  assert.equal(stored(f, first.reference).sessionHash, await digest(sessionA));
  assert.equal(stored(f, first.reference).paper.questions.map(question => question.id).join(), paper);

  const presented = first.reference + "." + sessionA;
  const rotatedBack = await read(await f.req("/api/start", "POST", {
    invite: presented, claim: random(), noticeVersion: notice.version,
  }));
  assert.equal(rotatedBack.status, 403);
  assert.match(rotatedBack.body.error, /unavailable/);
  assert.equal(rotatedBack.headers.get("Set-Cookie"), null);
  assert.equal(f.records.get(first.reference).etag, etag);
  assert.equal(stored(f, first.reference).inviteHash, firstHash);

  const otherClaim = await read(await f.req("/api/start", "POST", {
    invite: first.invite, claim: random(), noticeVersion: notice.version,
  }));
  assert.equal(otherClaim.status, 403);
  assert.match(otherClaim.body.error, /already been used/);
  assert.equal(otherClaim.headers.get("Set-Cookie"), null);
  assert.equal(f.records.get(first.reference).etag, etag);
  assert.equal(stored(f, second.reference).inviteHash, secondHash);

  const resumed = await read(await f.req("/api/invitation", "POST", { invite: first.invite }, { cookie: cookieA }));
  assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
  assert.equal(resumed.body.resume, true);
  assert.equal(resumed.body.attempt.reference, first.reference);
  assert.equal(stored(f, first.reference).inviteHash, firstHash);
});
