import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import worker, { Assessment } from "../src/worker.js";

// An issued invitation keeps its country. Withdrawing that country afterwards closes
// preview and start for it, and does not mint a paper. A sitting that already started
// keeps the notice it snapshotted. Nothing here describes a deployed Worker.

const MINUTE = 60_000;
const origin = "https://assessment.example";
const notice = {
  controller: "Test controller", contact: "privacy@example.invalid", basis: "Test basis",
  recipients: "Test reviewer", transfers: "Test transfer description", rights: "Test rights",
  purpose: "Test purpose", supervisoryAuthority: "Test authority", version: "test-1", retentionMinutes: 30,
};
const french = { ...notice, version: "fr-1" };
const italian = { ...notice, version: "it-1", purpose: "Italian purpose" };
const random = () => crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");

function fixture() {
  const objects = new Map();
  const records = new Map();
  const env = {
    LIVE_ENABLED: "true", NOTICE_PROFILES: { FR: french, IT: italian }, OPS_TOKEN: random(),
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

test("withdrawing a country closes its unused invitation without minting a paper", async () => {
  const source = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(source, /"LIVE_ENABLED": "false"/);

  const f = fixture();
  const issued = await read(await f.req("/api/ops/invites", "POST", { country: "FR", durationMinutes: 27 }, f.admin));
  assert.equal(issued.status, 201, JSON.stringify(issued.body));
  assert.equal(issued.body.country, "FR");
  assert.equal(issued.body.durationMinutes, 27);
  const secret = issued.body.invite.split(".")[1];
  const before = structuredClone(stored(f, issued.body.reference));
  const etag = f.records.get(issued.body.reference).etag;
  assert.equal(before.status, "invited");
  assert.equal(before.paper, undefined);

  f.env.NOTICE_PROFILES = { IT: italian };
  const cfg = await read(await f.req("/api/config"));
  assert.equal(cfg.body.enabled, true);
  assert.deepEqual(cfg.body.countries, ["IT"]);
  assert.equal(cfg.body.notice.version, "it-1");
  assert.equal(cfg.text.includes(secret), false);
  assert.equal(cfg.text.includes("fr-1"), false);

  const replacement = await read(await f.req("/api/ops/invites", "POST", { country: "FR", durationMinutes: 27 }, f.admin));
  assert.equal(replacement.status, 422);
  assert.match(replacement.body.error, /approved privacy notice/);
  assert.equal(f.records.size, 1);

  const preview = await read(await f.req("/api/invitation", "POST", { invite: issued.body.invite }));
  assert.equal(preview.status, 403);
  assert.match(preview.body.error, /currently closed/);
  assert.doesNotMatch(preview.body.error, /full time allowance|Scored assessments are currently closed/);
  assert.equal(preview.headers.get("Set-Cookie"), null);
  assert.equal(preview.text.includes(secret), false);
  assert.equal(preview.body.attempt, undefined);

  const wrongSecret = issued.body.reference + "." + "ab".repeat(32);
  const hidden = await read(await f.req("/api/invitation", "POST", { invite: wrongSecret }));
  assert.equal(hidden.status, 403);
  assert.match(hidden.body.error, /unavailable/);
  assert.doesNotMatch(hidden.body.error, /currently closed/);

  const refused = await read(await f.req("/api/start", "POST", {
    invite: issued.body.invite, claim: random(), noticeVersion: "fr-1",
  }));
  assert.equal(refused.status, 403);
  assert.match(refused.body.error, /currently closed/);
  assert.equal(refused.headers.get("Set-Cookie"), null);
  assert.equal(refused.text.includes(secret), false);
  assert.deepEqual(stored(f, issued.body.reference), before);
  assert.equal(f.records.get(issued.body.reference).etag, etag);

  const open = await read(await f.req("/api/ops/invites", "POST", { country: "IT", durationMinutes: 18 }, f.admin));
  assert.equal(open.status, 201, JSON.stringify(open.body));
  assert.equal(open.body.country, "IT");
  assert.equal(open.body.durationMinutes, 18);
  const started = await f.req("/api/start", "POST", {
    invite: open.body.invite, claim: random(), noticeVersion: "it-1",
  });
  const sitting = await read(started);
  assert.equal(sitting.status, 200, JSON.stringify(sitting.body));
  assert.equal(sitting.body.attempt.country, "IT");
  assert.equal(sitting.body.attempt.notice.purpose, "Italian purpose");
  assert.equal(sitting.body.attempt.deadline - sitting.body.attempt.startedAt, 18 * MINUTE);
  assert.equal(stored(f, issued.body.reference).status, "invited");
  assert.equal(stored(f, issued.body.reference).paper, undefined);

  f.env.NOTICE_PROFILES = { FR: french, IT: italian };
  const resumed = await f.req("/api/start", "POST", {
    invite: issued.body.invite, claim: random(), noticeVersion: "fr-1",
  });
  const restored = await read(resumed);
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  assert.match(resumed.headers.get("Set-Cookie"), /^__Host-assessment=/);
  assert.equal(restored.body.attempt.country, "FR");
  assert.equal(restored.body.attempt.notice.version, "fr-1");
  assert.equal(restored.body.attempt.deadline - restored.body.attempt.startedAt, 27 * MINUTE);
  assert.equal(stored(f, issued.body.reference).status, "active");
  assert.equal(stored(f, issued.body.reference).inviteHash, before.inviteHash);
  assert.equal(stored(f, issued.body.reference).paper.questions.length, 15);
});

test("a sitting already underway keeps its snapshot after that country is withdrawn", async () => {
  const f = fixture();
  const issued = await read(await f.req("/api/ops/invites", "POST", { country: "FR", durationMinutes: 21 }, f.admin));
  assert.equal(issued.status, 201, JSON.stringify(issued.body));
  const claim = random();
  const started = await f.req("/api/start", "POST", {
    invite: issued.body.invite, claim, noticeVersion: "fr-1",
  });
  const sitting = await read(started);
  assert.equal(sitting.status, 200, JSON.stringify(sitting.body));
  const cookie = started.headers.get("Set-Cookie").split(";")[0];
  const question = sitting.body.attempt.questions[0];
  const prompt = question.prompt;

  f.env.NOTICE_PROFILES = { IT: italian };
  const preview = await read(await f.req("/api/invitation", "POST", { invite: issued.body.invite }, { cookie }));
  assert.equal(preview.status, 403);
  assert.match(preview.body.error, /currently closed/);
  assert.equal(preview.text.includes(prompt), false);

  const sameClaim = await read(await f.req("/api/start", "POST", {
    invite: issued.body.invite, claim, noticeVersion: "fr-1",
  }, { cookie }));
  assert.equal(sameClaim.status, 403);
  assert.match(sameClaim.body.error, /currently closed/);
  assert.equal(sameClaim.headers.get("Set-Cookie"), null);
  const otherClaim = await read(await f.req("/api/start", "POST", {
    invite: issued.body.invite, claim: random(), noticeVersion: "fr-1",
  }, { cookie }));
  assert.equal(otherClaim.status, 403);
  assert.match(otherClaim.body.error, /currently closed/);

  const session = await read(await f.req("/api/session", "GET", undefined, {
    cookie, reference: issued.body.reference,
  }));
  assert.equal(session.status, 200);
  assert.equal(session.body.attempt.status, "active");
  assert.equal(session.body.attempt.notice.version, "fr-1");
  assert.equal(session.body.attempt.questions[0].id, question.id);
  const saved = await read(await f.req("/api/answers", "PUT", {
    reference: issued.body.reference, questionId: question.id, choices: [question.options[0].id],
    revision: sitting.body.attempt.revision,
  }, { cookie }));
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(stored(f, issued.body.reference).answers[question.id], [question.options[0].id]);
  assert.equal(stored(f, issued.body.reference).status, "active");
  assert.equal(stored(f, issued.body.reference).notice.version, "fr-1");
  assert.equal(stored(f, issued.body.reference).paper.questions[0].id, question.id);
  assert.equal(stored(f, issued.body.reference).score, undefined);
  const etag = f.records.get(issued.body.reference).etag;
  const again = await read(await f.req("/api/start", "POST", {
    invite: issued.body.invite, claim: random(), noticeVersion: "fr-1",
  }));
  assert.equal(again.status, 403);
  assert.equal(f.records.get(issued.body.reference).etag, etag);

  const exported = await read(await f.req("/api/ops/attempts/" + issued.body.reference, "GET", undefined, f.admin));
  assert.equal(exported.status, 200);
  assert.equal(exported.body.status, "active");
  assert.equal(exported.body.country, "FR");
  assert.equal(exported.body.score, null);
  assert.equal(exported.body.responses, undefined);
  assert.equal(exported.text.includes(issued.body.invite.split(".")[1]), false);
});
