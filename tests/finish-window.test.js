import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import worker, { Assessment } from "../src/worker.js";

// #19 locks the purge chosen when a sitting starts, and it erases one long
// unfinished paper at the hard end. It does not submit, and after the exam
// deadline it only checks that purgeAt is still somewhere before the hard end.
// These cases walk the computed finish instant: retrieval, the cleanup alarm,
// and the sweep all stop there, and a second submit does not move it.

const MINUTE = 60_000;
const POST = 30 * MINUTE;
const origin = "https://assessment.example";
const notice = {
  controller: "Test controller", contact: "privacy@example.invalid", basis: "Test basis",
  recipients: "Test reviewer", transfers: "Test transfer description", rights: "Test rights",
  purpose: "Test purpose", supervisoryAuthority: "Test authority", version: "test-1", retentionMinutes: 30,
};
const random = () => crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");

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
  const admin = { admin: true };
  return { env, objects, records, req, admin };
}

async function read(response) {
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: response.status, body, headers: response.headers, text };
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

async function sitting(duration) {
  const f = fixture();
  const issued = await read(await f.req("/api/ops/invites", "POST", { durationMinutes: duration }, f.admin));
  assert.equal(issued.status, 201, JSON.stringify(issued.body));
  const started = await f.req("/api/start", "POST", {
    invite: issued.body.invite, claim: random(), noticeVersion: notice.version,
  });
  const parsed = await read(started);
  assert.equal(parsed.status, 200, JSON.stringify(parsed.body));
  const reference = issued.body.reference;
  const stored = f.records.get(reference).record;
  assert.equal(stored.deadline - stored.startedAt, duration * MINUTE);
  assert.equal(stored.hardEnd - stored.issuedAt, 60 * MINUTE);
  assert.equal(stored.purgeAt, Math.min(stored.deadline + POST, stored.hardEnd));
  assert.equal(f.objects.get(reference).ctx.storage.alarm, stored.purgeAt);
  return {
    f, reference, cookie: started.headers.get("Set-Cookie").split(";")[0],
    setCookie: started.headers.get("Set-Cookie"), attempt: parsed.body.attempt,
  };
}

function stored(sitting) {
  return sitting.f.records.get(sitting.reference)?.record;
}

function seed(sitting) {
  const record = stored(sitting);
  record.answers = Object.fromEntries(record.paper.questions.map(q => [q.id, [q.options[0].id]]));
}

async function submit(sitting, extra = {}) {
  const record = stored(sitting);
  return read(await sitting.f.req("/api/submit", "POST", {
    reference: sitting.reference, revision: record.revision, ...extra,
  }, { cookie: sitting.cookie }));
}

async function session(sitting) {
  return read(await sitting.f.req("/api/session", "GET", undefined, {
    cookie: sitting.cookie, reference: sitting.reference,
  }));
}

async function staff(sitting) {
  return read(await sitting.f.req("/api/ops/attempts/" + sitting.reference, "GET", undefined, sitting.f.admin));
}

function maxAge(header) {
  return Number(/Max-Age=(\d+)/.exec(header)[1]);
}

test("retrieval, the alarm, and the sweep stop at the post-attempt finish and a resubmit does not move it", async () => {
  const source = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(source, /"LIVE_ENABLED": "false"/);

  await holdClock(async clock => {
    await assertUnfinishedRecordOutlivesTheDeadline(clock);
    await assertEarlySubmitClosesThirtyMinutesLater(clock);
    await assertLateSubmitClosesAtTheHardEnd(clock);
  });
});

async function assertUnfinishedRecordOutlivesTheDeadline(clock) {
  clock.reset();
  const viaRead = await sitting(15);
  const viaAlarm = await sitting(15);
  const viaSweep = await sitting(15);
  const deadline = stored(viaRead).deadline;
  const finish = stored(viaRead).purgeAt;
  assert.equal(finish, deadline + POST);
  assert.ok(finish < stored(viaRead).hardEnd);
  for (const item of [viaAlarm, viaSweep]) {
    assert.equal(stored(item).deadline, deadline);
    assert.equal(stored(item).purgeAt, finish);
  }

  clock.set(deadline);
  const closed = await session(viaRead);
  assert.equal(closed.body.attempt.status, "expired");
  assert.deepEqual(closed.body.attempt.questions, []);
  assert.equal(closed.body.attempt.purgeAt, finish, "the exam deadline does not bring the finish forward");
  assert.equal(stored(viaRead).purgeAt, finish);
  assert.equal(stored(viaRead).score, undefined);
  const exported = await staff(viaRead);
  assert.equal(exported.status, 200);
  assert.equal(exported.body.status, "expired");
  assert.equal(exported.body.score, null);
  assert.equal(exported.body.purgeAt, finish);
  assert.equal(exported.body.responses.length, 15);

  await viaAlarm.f.objects.get(viaAlarm.reference).alarm();
  assert.equal(stored(viaAlarm).status, "expired");
  assert.equal(stored(viaAlarm).purgeAt, finish);
  assert.equal(viaAlarm.f.objects.get(viaAlarm.reference).ctx.storage.alarm, finish);

  await worker.scheduled({}, viaSweep.f.env);
  assert.equal(stored(viaSweep).status, "active", "the sweep does not visit an unfinished paper at the exam deadline");
  assert.equal(stored(viaSweep).purgeAt, finish);

  clock.set(finish - 1);
  const still = await session(viaRead);
  assert.equal(still.body.serverNow, finish - 1);
  assert.equal(still.body.attempt.status, "expired");
  assert.equal(still.body.attempt.purgeAt, finish);
  assert.equal((await staff(viaRead)).status, 200);
  await viaAlarm.f.objects.get(viaAlarm.reference).alarm();
  assert.equal(stored(viaAlarm).purgeAt, finish);
  assert.equal(viaAlarm.f.records.has(viaAlarm.reference), true);
  await worker.scheduled({}, viaSweep.f.env);
  assert.equal(viaSweep.f.records.has(viaSweep.reference), true);

  clock.set(finish);
  const gone = await session(viaRead);
  assert.equal(gone.body.attempt, null);
  assert.equal(gone.body.serverNow, finish);
  assert.equal(viaRead.f.records.has(viaRead.reference), false);
  assert.equal((await staff(viaRead)).status, 404);
  await viaAlarm.f.objects.get(viaAlarm.reference).alarm();
  assert.equal(viaAlarm.f.records.has(viaAlarm.reference), false);
  assert.equal(viaAlarm.f.objects.get(viaAlarm.reference).ctx.storage.alarm, null);
  await worker.scheduled({}, viaSweep.f.env);
  assert.equal(viaSweep.f.records.has(viaSweep.reference), false);
  assert.equal(viaSweep.f.objects.get(viaSweep.reference).ctx.storage.alarm, null);
}

async function assertEarlySubmitClosesThirtyMinutesLater(clock) {
  clock.reset();
  const viaRead = await sitting(15);
  const viaAlarm = await sitting(15);
  const viaSweep = await sitting(15);
  for (const item of [viaRead, viaAlarm, viaSweep]) seed(item);
  const unfinished = stored(viaRead).purgeAt;
  const submitted = await submit(viaRead);
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  const finish = stored(viaRead).purgeAt;
  const submittedAt = stored(viaRead).submittedAt;
  assert.equal(finish, submittedAt + POST);
  assert.ok(finish < stored(viaRead).hardEnd);
  assert.ok(finish < unfinished, "submission pulls the finish in from the unfinished window");
  assert.equal(submitted.body.attempt.status, "submitted");
  assert.equal(submitted.body.attempt.score, undefined);
  assert.equal(submitted.body.attempt.purgeAt, finish);
  assert.equal(maxAge(submitted.headers.get("Set-Cookie")), POST / 1000);
  assert.equal(viaRead.f.objects.get(viaRead.reference).ctx.storage.alarm, finish);
  assert.equal(viaRead.f.records.get(viaRead.reference).metadata.purgeAt, String(finish));
  assert.equal(viaRead.f.records.get(viaRead.reference).metadata.compactAt, undefined);
  const score = stored(viaRead).score;
  assert.equal(Number.isInteger(score), true);

  const kept = new Map();
  for (const item of [viaAlarm, viaSweep]) {
    const response = await submit(item);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(stored(item).purgeAt, finish);
    assert.equal(stored(item).submittedAt, submittedAt);
    kept.set(item, stored(item).score);
  }

  const deadline = stored(viaRead).deadline;
  clock.set(deadline);
  const during = await session(viaRead);
  assert.equal(during.body.attempt.status, "submitted");
  assert.equal(during.body.attempt.purgeAt, finish);
  assert.deepEqual(during.body.attempt.questions, []);
  assert.equal(stored(viaRead).score, score);
  assert.equal(stored(viaRead).submittedAt, submittedAt);
  const review = await staff(viaRead);
  assert.equal(review.body.status, "submitted");
  assert.equal(review.body.score, score);
  assert.equal(review.body.purgeAt, finish);
  assert.equal(review.body.responses.length, 15);

  await viaAlarm.f.objects.get(viaAlarm.reference).alarm();
  assert.equal(stored(viaAlarm).status, "submitted");
  assert.equal(stored(viaAlarm).purgeAt, finish);
  assert.equal(stored(viaAlarm).score, kept.get(viaAlarm));
  await worker.scheduled({}, viaSweep.f.env);
  assert.equal(stored(viaSweep).status, "submitted");
  assert.equal(stored(viaSweep).purgeAt, finish);

  clock.set(finish - 1);
  const rejected = await submit(viaRead, { purgeAt: finish + POST, submittedAt: 0, hardEnd: finish + POST });
  assert.equal(rejected.status, 400);
  assert.equal(stored(viaRead).purgeAt, finish);
  assert.equal(stored(viaRead).submittedAt, submittedAt);
  const again = await submit(viaRead);
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.attempt.purgeAt, finish);
  assert.equal(again.body.attempt.submittedAt, submittedAt);
  assert.equal(stored(viaRead).score, score);
  assert.equal(stored(viaRead).revision, submitted.body.attempt.revision);
  const still = await session(viaRead);
  assert.equal(still.body.serverNow, finish - 1);
  assert.equal(still.body.attempt.status, "submitted");
  assert.equal((await staff(viaRead)).body.score, score);
  await viaAlarm.f.objects.get(viaAlarm.reference).alarm();
  assert.equal(viaAlarm.f.records.has(viaAlarm.reference), true);
  assert.equal(stored(viaAlarm).purgeAt, finish);
  await worker.scheduled({}, viaSweep.f.env);
  assert.equal(viaSweep.f.records.has(viaSweep.reference), true);

  clock.set(finish);
  const late = await submit(viaRead);
  assert.equal(late.status, 403);
  assert.match(late.body.error, /unavailable/);
  assert.equal(viaRead.f.records.has(viaRead.reference), false);
  assert.equal((await session(viaRead)).body.attempt, null);
  assert.equal((await staff(viaRead)).status, 404);
  await viaAlarm.f.objects.get(viaAlarm.reference).alarm();
  assert.equal(viaAlarm.f.records.has(viaAlarm.reference), false);
  assert.equal(viaAlarm.f.objects.get(viaAlarm.reference).ctx.storage.alarm, null);
  await worker.scheduled({}, viaSweep.f.env);
  assert.equal(viaSweep.f.records.has(viaSweep.reference), false);
}

async function assertLateSubmitClosesAtTheHardEnd(clock) {
  clock.reset();
  const paper = await sitting(55);
  assert.equal(stored(paper).purgeAt, stored(paper).hardEnd);
  seed(paper);
  clock.set(clock.base + 31 * MINUTE);
  assert.ok(clock.value() < stored(paper).deadline);
  const submitted = await submit(paper);
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  const record = stored(paper);
  assert.equal(record.purgeAt, record.hardEnd);
  assert.ok(record.purgeAt < record.submittedAt + POST);
  assert.equal(record.submittedAt, clock.base + 31 * MINUTE);
  assert.equal(paper.f.objects.get(paper.reference).ctx.storage.alarm, record.hardEnd);
  assert.equal(paper.f.records.get(paper.reference).metadata.purgeAt, String(record.hardEnd));
  assert.equal(maxAge(submitted.headers.get("Set-Cookie")), 29 * 60);
  const score = record.score;
  const submittedAt = record.submittedAt;

  clock.set(record.hardEnd - 1);
  const again = await submit(paper);
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(stored(paper).purgeAt, record.hardEnd);
  assert.equal(stored(paper).submittedAt, submittedAt);
  assert.equal(stored(paper).score, score);
  const open = await session(paper);
  assert.equal(open.body.attempt.status, "submitted");
  assert.equal(open.body.attempt.purgeAt, record.hardEnd);
  assert.equal((await staff(paper)).body.score, score);
  await worker.scheduled({}, paper.f.env);
  assert.equal(paper.f.records.has(paper.reference), true);
  await paper.f.objects.get(paper.reference).alarm();
  assert.equal(stored(paper).status, "submitted");
  assert.equal(stored(paper).purgeAt, record.hardEnd);

  clock.set(record.hardEnd);
  const late = await submit(paper);
  assert.equal(late.status, 403);
  assert.equal(paper.f.records.has(paper.reference), false);
  assert.equal((await session(paper)).body.attempt, null);
  assert.equal((await staff(paper)).status, 404);
  assert.equal(paper.f.objects.get(paper.reference).ctx.storage.alarm, null);
}
