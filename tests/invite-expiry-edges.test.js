import test from "node:test";
import assert from "node:assert/strict";
import worker, { Assessment } from "../src/worker.js";

// Invitation expiry is stored when the invite is issued. Closing a country, restoring it,
// turning scored recruitment off and on, or changing the TTL and duration settings afterwards
// must not move that instant. These cases sit outside the issue-time TTL grid.

const MINUTE = 60_000;
const HARD_MINUTES = 60;
const origin = "https://assessment.example";
const notice = {
  controller: "Test controller", contact: "privacy@example.invalid", basis: "Test basis",
  recipients: "Test reviewer", transfers: "Test transfer description", rights: "Test rights",
  purpose: "Test purpose", supervisoryAuthority: "Test authority", version: "test-1", retentionMinutes: 30,
};
const random = () => crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
const italy = { ...notice, version: "it-1", basis: "Italian basis" };

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
      async list(opts) {
        assert.deepEqual(opts.include, ["customMetadata"]);
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
  return { env, objects, records, req, admin: { admin: true } };
}

function holdClock(run) {
  const original = Date.now;
  const base = original();
  let now = base;
  const clock = {
    value: () => now,
    set(next) { now = next; },
    reset() { now = base; },
  };
  Date.now = () => now;
  return Promise.resolve(run(clock)).finally(() => { Date.now = original; });
}

async function read(response) {
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: response.status, body, headers: response.headers };
}

function snap(records, objects, reference) {
  const entry = records.get(reference);
  return {
    record: structuredClone(entry.record),
    purgeAt: entry.metadata.purgeAt,
    alarm: objects.get(reference).ctx.storage.alarm,
  };
}

function assertUnchanged(records, objects, reference, before, label) {
  const entry = records.get(reference);
  assert.deepEqual(entry.record, before.record, label);
  assert.equal(entry.metadata.purgeAt, before.purgeAt, label);
  assert.equal(objects.get(reference).ctx.storage.alarm, before.alarm, label);
  assert.equal(before.record.status, "invited", label);
  assert.equal(before.record.purgeAt, before.record.expiresAt, label);
}

async function issue(req, admin, data) {
  const response = await read(await req("/api/ops/invites", "POST", data, admin));
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body;
}

async function assertRecruitmentClosed(req, admin, issued, records, objects, label) {
  const before = snap(records, objects, issued.reference);
  const cfg = await read(await req("/api/config"));
  assert.equal(cfg.body.enabled, false, label);
  const inspect = await read(await req("/api/invitation", "POST", { invite: issued.invite }));
  assert.equal(inspect.status, 503, label);
  assert.match(inspect.body.error, /currently closed/, label);
  const start = await read(await req("/api/start", "POST", {
    invite: issued.invite, claim: random(), noticeVersion: notice.version,
  }));
  assert.equal(start.status, 503, label);
  assert.match(start.body.error, /currently closed/, label);
  assert.equal(start.headers.get("Set-Cookie"), null, label);
  const denied = await read(await req("/api/ops/invites", "POST", { durationMinutes: issued.durationMinutes }, admin));
  assert.equal(denied.status, 503, label);
  assertUnchanged(records, objects, issued.reference, before, label);
}

async function assertCountryClosed(req, issued, records, objects, label) {
  const before = snap(records, objects, issued.reference);
  const inspected = await read(await req("/api/invitation", "POST", { invite: issued.invite }));
  assert.equal(inspected.status, 403, label);
  assert.match(inspected.body.error, /country is currently closed/, label);
  const started = await read(await req("/api/start", "POST", {
    invite: issued.invite, claim: random(), noticeVersion: notice.version,
  }));
  assert.equal(started.status, 403, label);
  assert.match(started.body.error, /country is currently closed/, label);
  assert.equal(started.headers.get("Set-Cookie"), null, label);
  assertUnchanged(records, objects, issued.reference, before, label);
}

async function assertUnavailable(req, issued, records, label) {
  const inspected = await read(await req("/api/invitation", "POST", { invite: issued.invite }));
  assert.equal(inspected.status, 403, label + " " + JSON.stringify(inspected.body));
  assert.match(inspected.body.error, /unavailable/, label);
  assert.doesNotMatch(inspected.body.error, /country is currently closed/, label);
  assert.doesNotMatch(inspected.body.error, /full time allowance/, label);
  const started = await read(await req("/api/start", "POST", {
    invite: issued.invite, claim: random(), noticeVersion: notice.version,
  }));
  assert.equal(started.status, 403, label + " " + JSON.stringify(started.body));
  assert.match(started.body.error, /unavailable/, label);
  assert.doesNotMatch(started.body.error, /full time allowance/, label);
  assert.equal(started.headers.get("Set-Cookie"), null, label);
  assert.equal(records.has(issued.reference), false, label);
}

async function assertFreshInvite(req, admin, clock, minutes, duration, previous, label) {
  const fresh = await issue(req, admin, { durationMinutes: duration });
  assert.notEqual(fresh.reference, previous.reference, label);
  assert.equal(fresh.expiresAt - clock.value(), minutes * MINUTE, label);
  assert.equal(fresh.hardEnd - clock.value(), HARD_MINUTES * MINUTE, label);
  assert.equal(fresh.durationMinutes, duration, label);
  return fresh;
}

test("restoring a country or a recruitment setting does not extend an issued invitation", async () => {
  await holdClock(async clock => {
    await assertRestoreAfterExpiryDoesNotExtend(clock);
    await assertCountryGapKeepsTheOriginalExpiry(clock);
    await assertCleanupWhileTheCountryIsAbsent(clock);
    await assertExpiryWinsOverTheCountryCheck(clock);
    await assertLaterSettingsDoNotRecomputeExpiry(clock);
    await assertLiveGateDoesNotExtendAnExpiredInvite(clock);
  });
});

async function assertRestoreAfterExpiryDoesNotExtend(clock) {
  const { env, records, objects, req, admin } = fixture();
  clock.reset();
  env.INVITE_TTL_MINUTES = 10;
  const gated = await issue(req, admin, { durationMinutes: 20 });
  const blinked = await issue(req, admin, { durationMinutes: 20 });
  assert.equal(gated.expiresAt - clock.value(), 10 * MINUTE);
  assert.equal(blinked.expiresAt, gated.expiresAt);
  assert.ok(gated.hardEnd - gated.expiresAt > 20 * MINUTE, "a full sitting would still fit at the original expiry");
  const frozen = snap(records, objects, gated.reference);

  env.PRIVACY_NOTICE = { ...notice, retentionMinutes: 15 };
  await assertRecruitmentClosed(req, admin, gated, records, objects, "sole country dropped before expiry");
  clock.set(gated.expiresAt - 1);
  await assertRecruitmentClosed(req, admin, gated, records, objects, "closed country does not pause the stored expiry");
  clock.set(gated.expiresAt);
  await assertRecruitmentClosed(req, admin, gated, records, objects, "closed country does not erase or extend at expiry");
  assertUnchanged(records, objects, gated.reference, frozen, "expiry instant is the issued instant");

  env.INVITE_TTL_MINUTES = 30;
  env.PRIVACY_NOTICE = { ...notice };
  const restored = await read(await req("/api/config"));
  assert.equal(restored.body.enabled, true);
  assert.deepEqual(restored.body.countries, ["FR"]);
  assert.equal(restored.body.inviteTtlMinutes, 30);
  assertUnchanged(records, objects, gated.reference, frozen, "restore does not rewrite an expired invite");
  await assertUnavailable(req, gated, records, "restored country after expiry");
  assert.equal(records.has(gated.reference), false);

  const blinkFrozen = snap(records, objects, blinked.reference);
  clock.set(blinked.expiresAt + 1);
  env.PRIVACY_NOTICE = { ...notice, retentionMinutes: 15 };
  await assertRecruitmentClosed(req, admin, blinked, records, objects, "already expired before the country is removed");
  env.PRIVACY_NOTICE = { ...notice };
  assertUnchanged(records, objects, blinked.reference, blinkFrozen, "putting the country back does not extend it");
  await assertUnavailable(req, blinked, records, "country restored after the invite had already expired");
  await assertFreshInvite(req, admin, clock, 30, 20, blinked, "a new invite uses the restored TTL");
  assert.equal(records.has(gated.reference), false);
  assert.equal(records.has(blinked.reference), false);
}

async function assertCountryGapKeepsTheOriginalExpiry(clock) {
  const { env, records, objects, req, admin } = fixture();
  clock.reset();
  env.INVITE_TTL_MINUTES = 12;
  env.NOTICE_PROFILES = { FR: { ...notice }, IT: italy };
  const frLive = await issue(req, admin, { country: "FR", durationMinutes: 25 });
  const frIdle = await issue(req, admin, { country: "FR", durationMinutes: 25 });
  const itIdle = await issue(req, admin, { country: "IT", durationMinutes: 25 });
  assert.equal(frLive.expiresAt - clock.value(), 12 * MINUTE);
  assert.equal(frIdle.expiresAt, frLive.expiresAt);
  assert.equal(itIdle.expiresAt, frLive.expiresAt);
  const frFrozen = snap(records, objects, frLive.reference);
  const frIdleFrozen = snap(records, objects, frIdle.reference);
  const itFrozen = snap(records, objects, itIdle.reference);

  env.NOTICE_PROFILES = { IT: italy };
  await assertCountryClosed(req, frLive, records, objects, "missing country before expiry");
  await assertCountryClosed(req, frIdle, records, objects, "sibling invite for the missing country");
  const itOpen = await read(await req("/api/invitation", "POST", { invite: itIdle.invite }));
  assert.equal(itOpen.status, 200);
  assert.equal(itOpen.body.expiresAt, itIdle.expiresAt);
  assert.equal(itOpen.body.country, "IT");

  clock.set(frLive.expiresAt - 1);
  await assertCountryClosed(req, frLive, records, objects, "one millisecond before expiry the country is still closed");
  assertUnchanged(records, objects, frLive.reference, frFrozen, "the closed interval does not move expiresAt");

  env.INVITE_TTL_MINUTES = 30;
  env.NOTICE_PROFILES = { FR: { ...notice, version: "fr-2" }, IT: italy };
  const cfg = await read(await req("/api/config"));
  assert.equal(cfg.body.enabled, true);
  assert.deepEqual(cfg.body.countries, ["FR", "IT"]);
  assert.equal(cfg.body.inviteTtlMinutes, 30);
  const inspected = await read(await req("/api/invitation", "POST", { invite: frLive.invite }));
  assert.equal(inspected.status, 200, JSON.stringify(inspected.body));
  assert.equal(inspected.body.expiresAt, frLive.expiresAt);
  assert.equal(inspected.body.hardEnd, frLive.hardEnd);
  assert.equal(inspected.body.durationMinutes, 25);
  assert.equal(inspected.body.notice.version, "fr-2");
  assert.equal(inspected.body.serverNow, frLive.expiresAt - 1);
  assertUnchanged(records, objects, frIdle.reference, frIdleFrozen, "restoring the country does not move an idle invite");
  assertUnchanged(records, objects, itIdle.reference, itFrozen, "restoring another country does not move this invite");

  const stale = await read(await req("/api/start", "POST", {
    invite: frLive.invite, claim: random(), noticeVersion: notice.version,
  }));
  assert.equal(stale.status, 409, JSON.stringify(stale.body));
  assert.match(stale.body.error, /privacy notice changed/);
  assert.equal(records.get(frLive.reference).record.status, "invited");
  assert.equal(records.get(frLive.reference).record.expiresAt, frLive.expiresAt);

  const started = await read(await req("/api/start", "POST", {
    invite: frLive.invite, claim: random(), noticeVersion: "fr-2",
  }));
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.equal(started.body.attempt.deadline - started.body.attempt.startedAt, 25 * MINUTE);
  assert.equal(started.body.serverNow, frLive.expiresAt - 1);
  assert.equal(records.get(frLive.reference).record.expiresAt, frLive.expiresAt);
  assert.equal(records.get(frLive.reference).record.hardEnd, frLive.hardEnd);
  assert.equal(records.get(frIdle.reference).record.expiresAt, frIdle.expiresAt);

  clock.set(frIdle.expiresAt);
  await assertUnavailable(req, frIdle, records, "original expiry after the country returns");
  await assertUnavailable(req, itIdle, records, "the other country's invite keeps its own expiry");
  assert.equal(records.get(frLive.reference).record.status, "active");
  assert.equal(records.get(frLive.reference).record.expiresAt, frLive.expiresAt);
}

async function assertCleanupWhileTheCountryIsAbsent(clock) {
  const { env, records, objects, req, admin } = fixture();
  clock.reset();
  env.INVITE_TTL_MINUTES = 10;
  const alarmed = await issue(req, admin, { durationMinutes: 20 });
  const swept = await issue(req, admin, { durationMinutes: 20 });
  env.NOTICE_PROFILES = {};
  clock.set(alarmed.expiresAt - 1);
  await objects.get(alarmed.reference).alarm();
  assert.equal(records.has(alarmed.reference), true, "alarm waits for the issued expiry while the country is absent");
  assert.equal(records.get(alarmed.reference).record.expiresAt, alarmed.expiresAt);
  await worker.scheduled({}, env);
  assert.equal(records.has(swept.reference), true, "sweep waits for the issued expiry while the country is absent");

  clock.set(alarmed.expiresAt);
  await objects.get(alarmed.reference).alarm();
  assert.equal(records.has(alarmed.reference), false, "alarm erases at the issued expiry");
  assert.equal(objects.get(alarmed.reference).ctx.storage.alarm, null);
  await worker.scheduled({}, env);
  assert.equal(records.has(swept.reference), false, "sweep erases at the issued expiry");

  env.INVITE_TTL_MINUTES = 30;
  delete env.NOTICE_PROFILES;
  const cfg = await read(await req("/api/config"));
  assert.equal(cfg.body.enabled, true);
  assert.deepEqual(cfg.body.countries, ["FR"]);
  await assertUnavailable(req, alarmed, records, "restore after the alarm");
  await assertUnavailable(req, swept, records, "restore after the sweep");
  await assertFreshInvite(req, admin, clock, 30, 20, alarmed, "cleanup does not block a later invite");
  assert.equal(records.has(swept.reference), false);
}

async function assertExpiryWinsOverTheCountryCheck(clock) {
  const { env, records, objects, req, admin } = fixture();
  clock.reset();
  env.INVITE_TTL_MINUTES = 9;
  env.NOTICE_PROFILES = { FR: { ...notice }, IT: italy };
  const expired = await issue(req, admin, { country: "FR", durationMinutes: 22 });
  env.NOTICE_PROFILES = { IT: italy };
  clock.set(expired.expiresAt);
  await assertUnavailable(req, expired, records, "expiry is applied before the missing-country check");
  assert.equal(objects.get(expired.reference).ctx.storage.alarm, null);

  env.INVITE_TTL_MINUTES = 30;
  env.NOTICE_PROFILES = { FR: { ...notice }, IT: italy };
  const cfg = await read(await req("/api/config"));
  assert.equal(cfg.body.enabled, true);
  assert.deepEqual(cfg.body.countries, ["FR", "IT"]);
  await assertUnavailable(req, expired, records, "restoring the country does not recreate an erased invite");
  const fresh = await issue(req, admin, { country: "FR", durationMinutes: 22 });
  assert.notEqual(fresh.reference, expired.reference);
  assert.equal(fresh.expiresAt - clock.value(), 30 * MINUTE);
  assert.equal(records.has(expired.reference), false);
}

async function assertLaterSettingsDoNotRecomputeExpiry(clock) {
  const { env, records, objects, req, admin } = fixture();
  clock.reset();
  env.INVITE_TTL_MINUTES = 30;
  const started = await issue(req, admin, { durationMinutes: 55 });
  const unused = await issue(req, admin, { durationMinutes: 55 });
  assert.equal(started.expiresAt - clock.value(), 5 * MINUTE, "the hard end shortens the issued window");
  assert.equal(unused.expiresAt, started.expiresAt);
  assert.equal(started.hardEnd - started.expiresAt, 55 * MINUTE);

  env.DURATION_MINUTES = 15;
  env.INVITE_TTL_MINUTES = 30;
  env.PRIVACY_NOTICE = { ...notice, retentionMinutes: 15 };
  clock.set(started.expiresAt - 1);
  await assertRecruitmentClosed(req, admin, unused, records, objects, "new duration and TTL do not rewrite a closed invite");
  assert.equal(records.get(started.reference).record.expiresAt, started.expiresAt);
  assert.equal(records.get(started.reference).record.durationMinutes, 55);

  env.PRIVACY_NOTICE = { ...notice };
  const open = await read(await req("/api/invitation", "POST", { invite: started.invite }));
  assert.equal(open.status, 200, JSON.stringify(open.body));
  assert.equal(open.body.expiresAt, started.expiresAt);
  assert.equal(open.body.durationMinutes, 55);
  const sitting = await read(await req("/api/start", "POST", {
    invite: started.invite, claim: random(), noticeVersion: notice.version,
  }));
  assert.equal(sitting.status, 200, JSON.stringify(sitting.body));
  assert.equal(sitting.body.attempt.deadline - sitting.body.attempt.startedAt, 55 * MINUTE);
  assert.equal(records.get(started.reference).record.expiresAt, started.expiresAt);
  assert.equal(records.get(unused.reference).record.expiresAt, unused.expiresAt);

  clock.set(unused.expiresAt + 1);
  assert.ok(clock.value() + 55 * MINUTE > unused.hardEnd, "the issued sitting would no longer fit");
  await assertUnavailable(req, unused, records, "a later, looser setting does not keep the shortened invite alive");
  assert.equal(records.get(started.reference).record.expiresAt, started.expiresAt);

  env.INVITE_TTL_MINUTES = 8;
  const shortened = await issue(req, admin, { durationMinutes: 20 });
  assert.equal(shortened.expiresAt - clock.value(), 8 * MINUTE);
  env.INVITE_TTL_MINUTES = 1;
  clock.set(shortened.expiresAt - 1);
  const still = await read(await req("/api/invitation", "POST", { invite: shortened.invite }));
  assert.equal(still.status, 200, JSON.stringify(still.body));
  assert.equal(still.body.expiresAt, shortened.expiresAt, "a shorter TTL does not pull an issued expiry forward");
  clock.set(shortened.expiresAt);
  await assertUnavailable(req, shortened, records, "the issued TTL still ends the invite");
  await assertFreshInvite(req, admin, clock, 1, 15, shortened, "a new invite uses the shorter TTL");
}

async function assertLiveGateDoesNotExtendAnExpiredInvite(clock) {
  const { env, records, objects, req, admin } = fixture();
  clock.reset();
  env.INVITE_TTL_MINUTES = 7;
  const issued = await issue(req, admin, { durationMinutes: 18 });
  const frozen = snap(records, objects, issued.reference);
  env.LIVE_ENABLED = "false";
  clock.set(issued.expiresAt + 1);
  const cfg = await read(await req("/api/config"));
  assert.equal(cfg.body.enabled, false);
  assert.deepEqual(cfg.body.countries, ["FR"]);
  await assertRecruitmentClosed(req, admin, issued, records, objects, "live gate hides the invite without moving it");
  assertUnchanged(records, objects, issued.reference, frozen, "time spent offline is not added back");

  env.LIVE_ENABLED = "true";
  env.INVITE_TTL_MINUTES = 30;
  const restored = await read(await req("/api/config"));
  assert.equal(restored.body.enabled, true);
  assert.equal(restored.body.inviteTtlMinutes, 30);
  assertUnchanged(records, objects, issued.reference, frozen, "turning recruitment back on does not extend the invite");
  await assertUnavailable(req, issued, records, "live gate restored after expiry");
  await assertFreshInvite(req, admin, clock, 30, 18, issued, "recruitment can issue again on the new clock");
  assert.equal(records.has(issued.reference), false);
}
