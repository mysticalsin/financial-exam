import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import worker, { Assessment } from "../src/worker.js";

// Hiring invitation TTL and the exam clock are different timelines that share one server clock.
// An unused invitation dies at its start-by time. A start before that time always receives the
// full issued duration, and that duration must still fit before the hard end. The practice ticket
// is a separate clock and is not what these cases measure.

const MINUTE = 60_000;
const HARD_MINUTES = 60;
const POST_ATTEMPT_MINUTES = 30;
const origin = "https://assessment.example";
const notice = {
  controller: "Test controller", contact: "privacy@example.invalid", basis: "Test basis",
  recipients: "Test reviewer", transfers: "Test transfer description", rights: "Test rights",
  purpose: "Test purpose", supervisoryAuthority: "Test authority", version: "test-1", retentionMinutes: 30,
};
const random = () => crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");

function windowMinutes(duration, ttl) {
  return Math.min(ttl, HARD_MINUTES - duration);
}

function fixture() {
  const objects = new Map();
  const records = new Map();
  const env = {
    LIVE_ENABLED: "true", PRIVACY_COUNTRY: "FR", PRIVACY_NOTICE: { ...notice }, OPS_TOKEN: random(),
    ACCESS_ISSUER: "https://synthetic-test.cloudflareaccess.com", ACCESS_AUD: "a".repeat(64),
    DURATION_MINUTES: 30, INVITE_TTL_MINUTES: 30,
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
  const admin = { admin: true };
  return { env, objects, records, req, admin };
}

async function read(response) {
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: response.status, body, headers: response.headers };
}

function holdClock(run) {
  const original = Date.now;
  const base = original();
  let now = base;
  const clock = {
    base,
    value: () => now,
    set(next) { now = next; },
    reset() { now = base; },
  };
  Date.now = () => now;
  return Promise.resolve(run(clock)).finally(() => { Date.now = original; });
}

test("invitation TTL and the exam clock stay on one server timeline", async () => {
  await holdClock(async clock => {
    await assertCheckedInRecruitmentStaysClosed();
    await assertEveryLegalPairReservesAFullSitting(clock);
    await assertClockBoundaries(clock);
    await assertSweepUsesTheInviteClockOnlyWhileUnused(clock);
    await assertClientsCannotMoveEitherClock(clock);
    await assertIllegalBoundsCannotIssue(clock);
    await assertOmittedDurationUsesTheHiringSetting(clock);
  });
});

async function assertCheckedInRecruitmentStaysClosed() {
  const source = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(source, /"LIVE_ENABLED": "false"/);
}

async function assertEveryLegalPairReservesAFullSitting(clock) {
  const { env, records, objects, req, admin } = fixture();
  let checked = 0;
  for (let duration = 5; duration <= 55; duration++) {
    for (let ttl = 1; ttl <= 30; ttl++) {
      clock.reset();
      env.INVITE_TTL_MINUTES = ttl;
      const issued = await issue(req, admin, duration);
      assertInvitationWindow(records, objects, issued, duration, ttl, clock.value(), `${duration}m sitting, ${ttl}m ttl`);
      checked++;
    }
  }
  assert.equal(checked, 51 * 30);
}

async function assertClockBoundaries(clock) {
  const { env, records, objects, req, admin } = fixture();
  const pairs = boundaryPairs();
  for (const [duration, ttl] of pairs) {
    const label = `${duration}m sitting, ${ttl}m ttl`;
    clock.reset();
    env.INVITE_TTL_MINUTES = ttl;
    const early = await issue(req, admin, duration);
    const late = await issue(req, admin, duration);
    const exact = await issue(req, admin, duration);
    const after = await issue(req, admin, duration);
    for (const issued of [early, late, exact, after]) {
      assertInvitationWindow(records, objects, issued, duration, ttl, clock.base, label);
    }
    assert.equal(early.hardEnd, late.hardEnd, label);
    assert.equal(early.expiresAt, exact.expiresAt, label);

    const startedEarly = await start(req, early);
    assertFullSitting(records, startedEarly, duration, clock.value(), label + " from issue");
    assert.equal(records.get(early.reference).record.expiresAt, early.expiresAt, label);
    if (windowMinutes(duration, ttl) !== duration) {
      assert.notEqual(
        startedEarly.attempt.deadline - startedEarly.serverNow,
        early.expiresAt - startedEarly.serverNow,
        label + " exam length is the issued duration, not the time left on the invitation",
      );
    }

    clock.set(late.expiresAt - 1);
    const inspected = await inspect(req, late);
    assert.equal(inspected.serverNow, late.expiresAt - 1, label);
    assert.equal(inspected.expiresAt - inspected.serverNow, 1, label);
    assert.equal(inspected.hardEnd, late.hardEnd, label);
    assert.equal(inspected.durationMinutes, duration, label);
    const startedLate = await start(req, late);
    assertFullSitting(records, startedLate, duration, clock.value(), label + " one millisecond before TTL");
    assert.equal(
      startedLate.attempt.deadline - startedEarly.attempt.deadline,
      startedLate.attempt.startedAt - startedEarly.attempt.startedAt,
      label + " a later start shifts the exam clock and does not shrink it",
    );
    assert.notEqual(startedLate.attempt.deadline - startedLate.serverNow, 1, label);

    const question = startedLate.attempt.questions[0];
    assert.ok(question.options.length >= 2, label);
    const answers = answerClient(req, startedLate, question);
    clock.set(late.expiresAt);
    const during = await session(req, startedLate);
    assert.equal(during.serverNow, late.expiresAt, label);
    assert.equal(during.attempt.status, "active", label);
    assert.equal(during.attempt.deadline, startedLate.attempt.deadline, label);
    assert.equal(during.attempt.deadline - during.serverNow, duration * MINUTE - 1, label);
    const saved = await answers.choose(1);
    assert.equal(saved.status, 200, label + " " + JSON.stringify(saved.body));
    assert.equal(saved.body.serverNow, late.expiresAt, label);
    assert.equal(records.get(late.reference).record.expiresAt, late.expiresAt, label);
    assert.deepEqual(records.get(late.reference).record.answers[question.id], [question.options[1].id], label);

    clock.set(startedLate.attempt.deadline - 1);
    const stillOpen = await answers.choose(0);
    assert.equal(stillOpen.status, 200, label + " " + JSON.stringify(stillOpen.body));
    clock.set(startedLate.attempt.deadline);
    const closed = await answers.choose(1);
    assert.equal(closed.status, 409, label);
    assert.match(closed.body.error, /closed/, label);
    const closedRecord = records.get(late.reference).record;
    assert.equal(closedRecord.status, "expired", label);
    assert.equal(closedRecord.score, undefined, label);
    assert.deepEqual(closedRecord.answers[question.id], [question.options[0].id], label);
    assert.ok(closedRecord.purgeAt > closedRecord.deadline, label);
    assert.ok(closedRecord.purgeAt <= closedRecord.hardEnd, label);
    assert.equal(closedRecord.expiresAt, late.expiresAt, label);
    assert.equal(closedRecord.deadline, startedLate.attempt.deadline, label);

    const slack = exact.hardEnd - (exact.expiresAt + duration * MINUTE);
    assert.ok(slack >= 0, label);
    clock.set(exact.expiresAt);
    assert.ok(exact.expiresAt + duration * MINUTE <= exact.hardEnd, label + " full sitting still fits at the TTL instant");
    await rejectExpired(req, records, exact, label + " at TTL");

    clock.set(after.expiresAt + 1);
    if (slack >= MINUTE) {
      assert.ok(clock.value() + duration * MINUTE <= after.hardEnd, label + " full sitting still fits just after TTL");
    }
    await rejectExpired(req, records, after, label + " after TTL");

    if (duration === 55 && ttl === 30) {
      clock.set(closedRecord.hardEnd);
      const erased = await session(req, startedLate);
      assert.equal(erased.attempt, null, "the hard end removes the record after the exam clock has already stopped");
      assert.equal(records.has(late.reference), false);
    }
  }
}

async function assertSweepUsesTheInviteClockOnlyWhileUnused(clock) {
  const { env, records, objects, req, admin } = fixture();
  clock.reset();
  env.INVITE_TTL_MINUTES = 10;
  const live = await issue(req, admin, 40);
  const unused = await issue(req, admin, 40);
  const alarmed = await issue(req, admin, 40);
  assert.equal(live.expiresAt, unused.expiresAt);
  const started = await start(req, live);
  assert.ok(Number(records.get(live.reference).metadata.purgeAt) > live.expiresAt);
  assert.equal(records.get(unused.reference).metadata.purgeAt, String(unused.expiresAt));

  clock.set(alarmed.expiresAt - 1);
  await objects.get(alarmed.reference).alarm();
  assert.equal(records.has(alarmed.reference), true, "the cleanup alarm waits until the invitation TTL");
  clock.set(alarmed.expiresAt);
  await objects.get(alarmed.reference).alarm();
  assert.equal(records.has(alarmed.reference), false, "the cleanup alarm erases an unused invitation at its TTL");
  assert.equal(objects.get(alarmed.reference).ctx.storage.alarm, null);

  await worker.scheduled({}, env);
  assert.equal(records.has(unused.reference), false, "the sweep erases an unused invitation at its TTL");
  assert.equal(records.has(live.reference), true, "an open exam is not swept at the invitation TTL");
  const viewed = await session(req, started);
  assert.equal(viewed.attempt.status, "active");
  assert.equal(viewed.serverNow, live.expiresAt);
  assert.ok(viewed.attempt.deadline > viewed.serverNow);
  assert.equal(records.get(live.reference).record.expiresAt, live.expiresAt);
}

async function assertClientsCannotMoveEitherClock(clock) {
  const { env, records, req, admin } = fixture();
  clock.reset();
  env.INVITE_TTL_MINUTES = 16;
  const denied = await read(await req("/api/ops/invites", "POST", {
    durationMinutes: 21, inviteTtlMinutes: 1, expiresAt: clock.value() + MINUTE,
    hardEnd: clock.value() + 2 * MINUTE, serverNow: 0, deadline: clock.value() + MINUTE,
  }, admin));
  assert.equal(denied.status, 400);
  assert.equal(records.size, 0);

  const issued = await issue(req, admin, 21);
  assert.equal(issued.durationMinutes, 21);
  assert.equal(issued.expiresAt - clock.value(), 16 * MINUTE);
  assert.equal(issued.hardEnd - clock.value(), HARD_MINUTES * MINUTE);
  const deniedStart = await read(await req("/api/start", "POST", {
    invite: issued.invite, claim: random(), noticeVersion: notice.version,
    deadline: clock.value() + 86_400_000, serverNow: 0, expiresAt: clock.value() + 86_400_000,
  }));
  assert.equal(deniedStart.status, 400);
  assert.equal(records.get(issued.reference).record.status, "invited");
  assert.equal(records.get(issued.reference).record.expiresAt, issued.expiresAt);
  assert.equal(records.get(issued.reference).record.paper, undefined);

  const started = await start(req, issued);
  assertFullSitting(records, started, 21, clock.value(), "client clocks are ignored");
}

async function assertIllegalBoundsCannotIssue() {
  const { env, records, req, admin } = fixture();
  for (const ttl of ["0", "31", "1.5", "-4", "30m", ""]) {
    env.INVITE_TTL_MINUTES = ttl;
    const cfg = await read(await req("/api/config"));
    assert.equal(cfg.body.enabled, false, `ttl ${JSON.stringify(ttl)} keeps recruitment closed`);
    assert.equal((await req("/api/ops/invites", "POST", { durationMinutes: 30 }, admin)).status, 503, `ttl ${JSON.stringify(ttl)}`);
  }
  assert.equal(records.size, 0);
  env.INVITE_TTL_MINUTES = 30;
  for (const duration of [4, 56, 0, 15.5]) {
    assert.equal((await req("/api/ops/invites", "POST", { durationMinutes: duration }, admin)).status, 422, `duration ${duration}`);
  }
  assert.equal(records.size, 0);
}

async function assertOmittedDurationUsesTheHiringSetting(clock) {
  const { env, records, req, admin } = fixture();
  clock.reset();
  env.DURATION_MINUTES = 22;
  env.INVITE_TTL_MINUTES = 9;
  const cfg = await read(await req("/api/config"));
  assert.equal(cfg.body.enabled, true);
  assert.equal(cfg.body.durationMinutes, 22);
  assert.equal(cfg.body.inviteTtlMinutes, 9);
  const issued = await read(await req("/api/ops/invites", "POST", {}, admin));
  assert.equal(issued.status, 201, JSON.stringify(issued.body));
  assert.equal(issued.body.durationMinutes, 22);
  assert.equal(issued.body.expiresAt - clock.value(), 9 * MINUTE);
  const started = await start(req, issued.body);
  assertFullSitting(records, started, 22, clock.value(), "omitted duration");
}

function boundaryPairs() {
  const explicit = [
    [5, 1], [5, 30], [17, 30], [30, 30], [31, 30], [40, 10], [54, 6], [55, 5], [55, 6], [55, 30],
  ];
  const seen = new Set(explicit.map(([duration, ttl]) => duration + ":" + ttl));
  const next = lcg(0xC10C4);
  const sampled = [];
  while (sampled.length < 8) {
    const duration = 5 + (next() % 51);
    const ttl = 1 + (next() % 30);
    const key = duration + ":" + ttl;
    if (seen.has(key)) continue;
    seen.add(key);
    sampled.push([duration, ttl]);
  }
  return [...explicit, ...sampled];
}

function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state;
  };
}

async function issue(req, admin, durationMinutes) {
  const response = await read(await req("/api/ops/invites", "POST", { durationMinutes }, admin));
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body;
}

function assertInvitationWindow(records, objects, issued, duration, ttl, issuedAt, label) {
  const record = records.get(issued.reference).record;
  const windowMs = windowMinutes(duration, ttl) * MINUTE;
  assert.equal(record.status, "invited", label);
  assert.equal(record.paper, undefined, label);
  assert.equal(record.issuedAt, issuedAt, label);
  assert.equal(record.durationMinutes, duration, label);
  assert.equal(record.expiresAt, issuedAt + windowMs, label);
  assert.equal(record.hardEnd, issuedAt + HARD_MINUTES * MINUTE, label);
  assert.equal(record.purgeAt, record.expiresAt, label + " unused invitation purge matches the TTL");
  assert.equal(issued.expiresAt, record.expiresAt, label);
  assert.equal(issued.hardEnd, record.hardEnd, label);
  assert.equal(issued.durationMinutes, duration, label);
  assert.ok(record.expiresAt <= issuedAt + ttl * MINUTE, label);
  assert.ok(record.hardEnd - record.expiresAt >= duration * MINUTE, label);
  assert.ok(record.expiresAt < record.hardEnd, label);
  assert.equal(records.get(issued.reference).metadata.purgeAt, String(record.expiresAt), label);
  assert.equal(objects.get(issued.reference).ctx.storage.alarm, record.expiresAt, label);
}

function assertFullSitting(records, started, duration, now, label) {
  const record = records.get(started.attempt.reference).record;
  assert.equal(started.serverNow, now, label);
  assert.equal(started.attempt.startedAt, now, label);
  assert.equal(started.attempt.status, "active", label);
  assert.equal(started.attempt.deadline - started.attempt.startedAt, duration * MINUTE, label);
  assert.equal(started.attempt.deadline, record.deadline, label);
  assert.ok(record.deadline <= record.hardEnd, label);
  assert.equal(record.purgeAt, Math.min(record.deadline + POST_ATTEMPT_MINUTES * MINUTE, record.hardEnd), label);
  assert.ok(record.purgeAt > record.expiresAt, label);
  const maxAge = Number(/Max-Age=(\d+)/.exec(started.setCookie)[1]);
  assert.equal(maxAge, Math.floor((record.purgeAt - now) / 1000), label);
  assert.ok(maxAge > 0, label);
  assert.ok(maxAge <= Math.floor((record.hardEnd - now) / 1000), label);
}

async function start(req, issued) {
  const response = await req("/api/start", "POST", {
    invite: issued.invite, claim: random(), noticeVersion: notice.version,
  });
  const parsed = await read(response);
  assert.equal(parsed.status, 200, JSON.stringify(parsed.body));
  const setCookie = response.headers.get("Set-Cookie");
  assert.ok(setCookie, "a started sitting sets a session cookie");
  return { cookie: setCookie.split(";")[0], setCookie, ...parsed.body };
}

async function inspect(req, issued) {
  const response = await read(await req("/api/invitation", "POST", { invite: issued.invite }));
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body;
}

async function session(req, started) {
  const response = await read(await req("/api/session", "GET", undefined, {
    cookie: started.cookie, reference: started.attempt.reference,
  }));
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body;
}

function answerClient(req, started, question) {
  let revision = started.attempt.revision;
  return {
    async choose(index) {
      const response = await read(await req("/api/answers", "PUT", {
        reference: started.attempt.reference,
        questionId: question.id,
        choices: [question.options[index].id],
        revision,
      }, { cookie: started.cookie }));
      if (response.status === 200) revision = response.body.attempt.revision;
      return response;
    },
  };
}

async function rejectExpired(req, records, issued, label) {
  const inspected = await read(await req("/api/invitation", "POST", { invite: issued.invite }));
  assert.equal(inspected.status, 403, label);
  assert.match(inspected.body.error, /unavailable/, label);
  const started = await read(await req("/api/start", "POST", {
    invite: issued.invite, claim: random(), noticeVersion: notice.version,
  }));
  assert.equal(started.status, 403, label + " " + JSON.stringify(started.body));
  assert.match(started.body.error, /unavailable/, label);
  assert.doesNotMatch(started.body.error, /full time allowance/, label);
  assert.equal(started.headers.get("Set-Cookie"), null, label);
  assert.equal(records.has(issued.reference), false, label);
}
