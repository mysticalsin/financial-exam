import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import worker, { Assessment } from "../src/worker.js";

// These tests describe this repository's source. They do not describe a deployed
// Worker. Recruitment stays closed until Tony deploy-yes. The practice sitting
// in this source is 15 minutes. A hiring sitting uses the duration written on
// that invitation and is not assumed to be 15 minutes.

const PRACTICE_MS = 15 * 60 * 1000;
const MINUTE = 60_000;
const origin = "https://assessment.example";
const practiceKey = "a".repeat(64);
const notice = {
  controller: "Test controller", contact: "privacy@example.invalid", basis: "Test basis",
  recipients: "Test reviewer", transfers: "Test transfer description", rights: "Test rights",
  purpose: "Test purpose", supervisoryAuthority: "Test authority", version: "test-1", retentionMinutes: 30,
};
const random = () => crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");

function practiceEnv(extra = {}, { isolate = false } = {}) {
  const target = {
    PRACTICE_KEY: practiceKey,
    RATE_KEY: "b".repeat(64),
    RATE_LIMITER: { async limit() { return { success: true }; } },
    ...extra,
  };
  if (!isolate) return target;
  return new Proxy(target, {
    get(object, name) {
      if (["ATTEMPTS", "RECORDS", "OPS_TOKEN", "LIVE_ENABLED", "DURATION_MINUTES", "INVITE_TTL_MINUTES", "PRIVACY_NOTICE", "PRIVACY_COUNTRY"].includes(name))
        throw new Error("Practice timer must not read hiring configuration or hiring storage.");
      return object[name];
    },
  });
}

async function practiceCall(env, path, data) {
  return worker.fetch(new Request(origin + path, {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      "CF-Connecting-IP": "192.0.2.15",
    },
    body: JSON.stringify(data),
  }), env);
}

async function startPractice(env) {
  const response = await practiceCall(env, "/api/practice/start", {});
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(response.headers.has("Set-Cookie"), false);
  assert.equal(Object.hasOwn(body, "durationMinutes"), false, "practice start does not borrow the hiring duration field");
  assert.equal(body.deadline - body.serverNow, PRACTICE_MS);
  assert.notEqual(body.deadline - body.serverNow, 30 * MINUTE);
  return body;
}

function hiringFixture(durationMinutes = 30) {
  const objects = new Map();
  const records = new Map();
  const env = {
    LIVE_ENABLED: "true", PRIVACY_COUNTRY: "FR", PRIVACY_NOTICE: { ...notice }, OPS_TOKEN: random(),
    ACCESS_ISSUER: "https://synthetic-test.cloudflareaccess.com", ACCESS_AUD: "a".repeat(64),
    DURATION_MINUTES: durationMinutes, INVITE_TTL_MINUTES: 30, PRACTICE_KEY: practiceKey,
    RATE_LIMITER: { async limit() { return { success: true }; } },
    ASSETS: { async fetch() { return new Response("Test page"); } },
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
        return { objects: [...records].map(([key, entry]) => ({ key, customMetadata: entry.metadata })), truncated: false };
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
  async function req(path, method = "GET", data, { admin } = {}) {
    const headers = {};
    if (!admin && method !== "GET") headers.Origin = origin;
    if (admin) headers.Authorization = "Bearer " + env.OPS_TOKEN;
    if (data !== undefined) headers["Content-Type"] = "application/json";
    const response = await worker.fetch(new Request(origin + path, {
      method, headers, body: data === undefined ? undefined : JSON.stringify(data),
    }), env);
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { status: response.status, body, headers: response.headers };
  }
  return { env, records, req, admin: { admin: true } };
}

async function issueAndStart(fixture, durationMinutes) {
  const { req, records, admin } = fixture;
  const payload = durationMinutes === undefined ? {} : { durationMinutes };
  const issued = await req("/api/ops/invites", "POST", payload, admin);
  assert.equal(issued.status, 201, JSON.stringify(issued.body));
  const expected = durationMinutes === undefined ? Number(fixture.env.DURATION_MINUTES) : durationMinutes;
  assert.equal(issued.body.durationMinutes, expected);
  const inspected = await req("/api/invitation", "POST", { invite: issued.body.invite });
  assert.equal(inspected.status, 200, JSON.stringify(inspected.body));
  assert.equal(inspected.body.durationMinutes, expected);
  const started = await req("/api/start", "POST", {
    invite: issued.body.invite, claim: random(), noticeVersion: notice.version,
  });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const record = records.get(issued.body.reference).record;
  assert.equal(record.durationMinutes, expected);
  assert.equal(started.body.attempt.deadline - started.body.attempt.startedAt, expected * MINUTE);
  assert.equal(started.body.attempt.deadline - started.body.serverNow, expected * MINUTE);
  assert.equal(started.body.attempt.startedAt, started.body.serverNow);
  return { expected, issued: issued.body, started: started.body };
}

test("repository practice sittings last exactly 15 minutes and ignore the hiring duration setting", async () => {
  const variants = [
    {},
    { DURATION_MINUTES: "5" },
    { DURATION_MINUTES: "15" },
    { DURATION_MINUTES: "30" },
    { DURATION_MINUTES: "55" },
    { DURATION_MINUTES: "41", LIVE_ENABLED: "false" },
    { DURATION_MINUTES: "15", LIVE_ENABLED: "true" },
    { DURATION_MINUTES: "nope", LIVE_ENABLED: "true", INVITE_TTL_MINUTES: "1" },
  ];
  for (const extra of variants) {
    for (let copy = 0; copy < 2; copy++) {
      const paper = await startPractice(practiceEnv(extra));
      assert.equal(paper.questions.length, 15);
      assert.equal(paper.deadline, paper.serverNow + PRACTICE_MS);
    }
  }
  const isolated = await startPractice(practiceEnv({}, { isolate: true }));
  assert.equal(isolated.deadline - isolated.serverNow, PRACTICE_MS);
});

test("repository practice submit stays open through 14:59.999 and closes at 15:00, including a former 30-minute mark", async () => {
  const originalNow = Date.now;
  try {
    for (const extra of [{}, { DURATION_MINUTES: "30", LIVE_ENABLED: "true" }, { DURATION_MINUTES: "5" }]) {
      const env = practiceEnv(extra);
      const paper = await startPractice(env);
      const submit = async (at) => {
        Date.now = () => at;
        return practiceCall(env, "/api/practice/submit", { challenge: paper.challenge, answers: {} });
      };
      const open = await submit(paper.deadline - 1);
      assert.equal(open.status, 200, "a practice paper is still gradeable 1ms before 15 minutes");
      assert.equal((await open.json()).total, 15);
      const closed = await submit(paper.deadline);
      assert.equal(closed.status, 410, "the practice paper closes at its 15-minute deadline");
      assert.match((await closed.json()).error, /expired/i);
      const formerHalfHour = await submit(paper.serverNow + 30 * MINUTE - 1);
      assert.equal(formerHalfHour.status, 410, "a 30-minute practice window is not still open in this repository");
    }
  } finally {
    Date.now = originalNow;
  }
});

test("checked-in practice pages describe a 15-minute sitting and follow the server deadline", async () => {
  const server = await readFile(new URL("../src/practice.js", import.meta.url), "utf8");
  const client = await readFile(new URL("../public/practice.js", import.meta.url), "utf8");
  const page = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

  assert.match(server, /const TICKET_LIFETIME = 15 \* 60 \* 1000;/);
  assert.match(server, /ticket\.deadline !== ticket\.issuedAt \+ TICKET_LIFETIME/);
  assert.match(server, /deadline: now \+ TICKET_LIFETIME/);
  assert.doesNotMatch(server, /DURATION_MINUTES|LIVE_ENABLED|INVITE_TTL_MINUTES/);

  assert.match(page, /15 questions <span aria-hidden="true">·<\/span> 15 minutes/);
  assert.match(page, /Allow 15 minutes, use a calculator if helpful/);
  assert.doesNotMatch(page, /30 minutes/);

  assert.match(client, /Take 15 minutes\./);
  assert.match(client, /Start 15-minute practice/);
  assert.match(client, /"15:00"/);
  assert.match(client, /15 QUESTIONS · 15 MINUTES/);
  assert.match(client, /deadline = data\.deadline;/);
  assert.match(client, /deadline - serverTime\(\)/);
  assert.match(client, /resultUntil = result\.submittedAt \+ 30 \* 60 \* 1000;/);
  assert.doesNotMatch(client, /30-minute practice|Take 30 minutes|30 minutes/);

  assert.match(app, /else scope\.textContent = "15 questions · 15 minutes"/);
  assert.match(app, /Allow 15 minutes, use a calculator if helpful, and review every answer before you submit\./);
  assert.match(app, /invitation\?\.durationMinutes\s*\?\s*`15 questions · \$\{invitation\.durationMinutes\} minutes`/);
  assert.match(app, /Personal invitation · time allowance confirmed before start/);
  assert.match(app, /const duration = invitation\?\.durationMinutes;/);
  assert.match(app, /duration \+ " minutes from the moment you start"/);
  assert.match(app, /Use the duration shown in your invitation\./);
  assert.match(app, /attempt\.deadline - serverTime\(\)/);
  assert.doesNotMatch(app, /15 \* 60 \* 1000|15 \* 60000/);
});

test("hiring sittings use the invitation duration and are not assumed to be 15 minutes", async () => {
  const seen = new Map();
  for (let duration = 5; duration <= 55; duration++) {
    const fixture = hiringFixture(15);
    const sitting = await issueAndStart(fixture, duration);
    seen.set(duration, sitting.started.attempt.deadline - sitting.started.attempt.startedAt);
    if (duration !== 15) {
      assert.notEqual(sitting.started.attempt.deadline - sitting.started.attempt.startedAt, PRACTICE_MS,
        duration + " minute invitation must not inherit the practice timer");
    }
    const rejected = await fixture.req("/api/start", "POST", {
      invite: sitting.issued.invite, claim: random(), noticeVersion: notice.version,
      durationMinutes: 15, deadline: Date.now() + PRACTICE_MS,
    });
    assert.equal(rejected.status, 400, "a candidate cannot rewrite an invitation duration to 15 minutes");
  }
  assert.equal(seen.size, 51);
  assert.equal(seen.get(15), PRACTICE_MS, "15 minutes occurs only when that invitation says 15");
  assert.equal(seen.get(17), 17 * MINUTE);
  assert.equal(seen.get(30), 30 * MINUTE);
  assert.equal(seen.get(55), 55 * MINUTE);

  const omitted = hiringFixture(22);
  const fromSetting = await issueAndStart(omitted, undefined);
  assert.equal(fromSetting.expected, 22);
  assert.notEqual(fromSetting.started.attempt.deadline - fromSetting.started.attempt.startedAt, PRACTICE_MS);
  omitted.env.DURATION_MINUTES = 15;
  const explicit = await issueAndStart(omitted, 8);
  assert.equal(explicit.started.attempt.deadline - explicit.started.attempt.startedAt, 8 * MINUTE,
    "an explicit invitation duration wins over a 15-minute hiring default");
});

test("checked-in wrangler keeps recruitment closed and is not a live 15-minute Worker claim", async () => {
  const source = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(source, /"LIVE_ENABLED": "false"/);
  assert.doesNotMatch(source, /"LIVE_ENABLED": "true"/);
  const practice = await startPractice(practiceEnv({ DURATION_MINUTES: "55", LIVE_ENABLED: "false" }));
  assert.equal(practice.deadline - practice.serverNow, PRACTICE_MS,
    "the repository practice sitting stays 15 minutes while recruitment is closed");
});
