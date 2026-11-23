import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import worker, { Assessment } from "../src/worker.js";
import { grade, makePaper, makePortfolioCase } from "../src/bank.js";
import { makePracticePaper, scorePractice } from "../src/practice.js";

// Fixed counts, stubbed clocks, and in-process storage. No network and no wrangler.
const origin = "https://assessment.example";
const FROZEN_NOW = 1_700_000_040_000;
const PACKS = [
  { name: "practice", sections: [["Foundations", 8], ["Applied Reading", 7]] },
  { name: "recruitment", sections: [["Foundations", 8], ["Applied Reading", 7]] },
];
const notice = {
  controller: "Test controller", contact: "privacy@example.invalid", basis: "Test basis",
  recipients: "Test reviewer", transfers: "Test transfer description", rights: "Test rights",
  purpose: "Test purpose", supervisoryAuthority: "Test authority", version: "test-1", retentionMinutes: 30,
};
const random = () => crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");

function countingLimiter(limit) {
  const keys = [];
  const counts = new Map();
  return {
    keys,
    counts,
    async limit({ key }) {
      keys.push(key);
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return { success: next <= limit };
    },
  };
}

function tally(responses) {
  const counts = {};
  for (const response of responses) counts[response.status] = (counts[response.status] ?? 0) + 1;
  return counts;
}

function freezeTime(at) {
  const original = Date.now;
  Date.now = () => at;
  return () => { Date.now = original; };
}

function recruitmentAnswers(paper, section, correct) {
  const answers = {};
  for (const question of paper.questions) {
    if (section && question.section !== section) continue;
    const right = paper.key[question.id][0];
    const wrong = question.options.find(option => option.id !== right).id;
    answers[question.id] = [correct ? right : wrong];
  }
  return answers;
}

function practiceAnswers(paper, section, correct) {
  const answers = {};
  for (const question of paper.questions) {
    if (section && question.section !== section) continue;
    const right = paper.key[question.id];
    answers[question.id] = correct ? right : question.options.find(option => option.id !== right).id;
  }
  return answers;
}

function fixture({ live = "true" } = {}) {
  const objects = new Map();
  const records = new Map();
  const limiterKeys = [];
  let limiter = async ({ key }) => {
    limiterKeys.push(key);
    return { success: true };
  };
  const env = {
    LIVE_ENABLED: live, PRIVACY_COUNTRY: "FR", PRIVACY_NOTICE: { ...notice },
    OPS_TOKEN: random(), RATE_KEY: "b".repeat(64), PRACTICE_KEY: "a".repeat(64),
    ACCESS_ISSUER: "https://synthetic-test.cloudflareaccess.com", ACCESS_AUD: "c".repeat(64),
    DURATION_MINUTES: "30", INVITE_TTL_MINUTES: "30",
    RATE_LIMITER: { limit: args => limiter(args) },
    ASSETS: { async fetch() { return new Response("Test page"); } },
    RECORDS: {
      async get(key) {
        const entry = records.get(key);
        return entry ? { etag: entry.etag, json: async () => structuredClone(entry.record) } : null;
      },
      async put(key, value, opts) {
        const existing = records.get(key);
        if (opts.onlyIf instanceof Headers) {
          if (opts.onlyIf.get("If-None-Match") !== "*" || existing) return null;
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
        if (name !== "eu") throw new Error("Recruitment storage must stay in the EU namespace.");
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
              const ctx = {
                id,
                storage,
                blockConcurrencyWhile(fn) {
                  const next = queue.then(fn);
                  queue = next.catch(() => {});
                  return next;
                },
              };
              objects.set(id, new Assessment(ctx, env));
            }
            return objects.get(id);
          },
        };
      },
    },
  };

  async function req(path, method = "GET", data, { cookie, admin, reference, headers = {}, ip = "192.0.2.10", stream } = {}) {
    const init = { method, headers: { "CF-Connecting-IP": ip, ...headers } };
    if (reference) init.headers["X-Assessment-Reference"] = reference;
    if (!admin && method !== "GET" && !("Origin" in init.headers)) init.headers.Origin = origin;
    if (admin) init.headers.Authorization = "Bearer " + env.OPS_TOKEN;
    if (cookie) init.headers.Cookie = cookie;
    if (stream) {
      init.body = stream;
      init.duplex = "half";
      init.headers["Content-Type"] ??= "application/json";
    } else if (data !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = typeof data === "string" ? data : JSON.stringify(data);
    }
    return worker.fetch(new Request(origin + path, init), env);
  }

  async function practice(path, data, options = {}) {
    return req(path, "POST", data, { ...options, admin: false });
  }

  const admin = { admin: true };
  async function issue(durationMinutes = 30, country) {
    const response = await req("/api/ops/invites", "POST", { durationMinutes, country }, admin);
    assert.equal(response.status, 201);
    return response.json();
  }
  async function start(inviteData, claim = random()) {
    const response = await req("/api/start", "POST", {
      invite: inviteData.invite, claim, noticeVersion: notice.version,
    });
    assert.equal(response.status, 200);
    const setCookie = response.headers.get("Set-Cookie");
    assert.match(setCookie, /Secure; HttpOnly; SameSite=Strict/);
    return { cookie: setCookie.split(";")[0], claim, ...(await response.json()) };
  }
  return { env, objects, records, limiterKeys, setLimiter(fn) { limiter = fn; }, req, practice, issue, start, admin };
}

function sectionCounts(questions) {
  return questions.map(question => question.section);
}

describe("pack stress", { concurrency: false }, () => {
  test("every pack repeats inside section, choice, and score bounds", () => {
    assert.deepEqual(PACKS.map(pack => pack.name), ["practice", "recruitment"]);
    for (const pack of PACKS) {
      for (let iteration = 0; iteration < 100; iteration++) {
        if (pack.name === "practice") {
          const paper = makePracticePaper();
          assert.deepEqual(sectionCounts(paper.questions), [
            ...Array(pack.sections[0][1]).fill(pack.sections[0][0]),
            ...Array(pack.sections[1][1]).fill(pack.sections[1][0]),
          ]);
          assert.equal(new Set(paper.questions.map(question => question.id)).size, 15);
          for (const question of paper.questions) {
            assert.equal(question.options.length, 4);
            assert.equal(new Set(question.options.map(option => option.text)).size, 4);
          }
          assert.deepEqual(paper.referenceTable.rows.map(row => row[1]), ["€120,000", "€78,000", "€42,000", "€18,000", "€24,000"]);
          const perfect = scorePractice(paper, practiceAnswers(paper, null, true));
          const foundations = scorePractice(paper, practiceAnswers(paper, "Foundations", true));
          const applied = scorePractice(paper, practiceAnswers(paper, "Applied Reading", true));
          const miss = scorePractice(paper, practiceAnswers(paper, null, false));
          assert.deepEqual([perfect.score, foundations.score, applied.score, miss.score], [15, 8, 7, 0]);
          assert.equal(foundations.answered + applied.answered, perfect.answered);
          assert.equal(scorePractice(paper, {}).score, 0);
          assert.ok(perfect.score <= perfect.answered && perfect.score <= 15);
        } else {
          const paper = makePaper();
          assert.deepEqual(sectionCounts(paper.questions), [
            ...Array(pack.sections[0][1]).fill(pack.sections[0][0]),
            ...Array(pack.sections[1][1]).fill(pack.sections[1][0]),
          ]);
          assert.equal(paper.questions.length, 15);
          for (const question of paper.questions) assert.equal(question.options.length, 4);
          const correct = recruitmentAnswers(paper, null, true);
          const first = paper.questions[0];
          correct[first.id] = [paper.key[first.id][0], first.options[0].id];
          assert.equal(grade(paper, recruitmentAnswers(paper, null, true)), 15);
          assert.equal(grade(paper, recruitmentAnswers(paper, "Foundations", true)), 8);
          assert.equal(grade(paper, recruitmentAnswers(paper, "Applied Reading", true)), 7);
          assert.equal(grade(paper, recruitmentAnswers(paper, null, false)), 0);
          assert.equal(grade(paper, correct), 14);
          assert.equal(grade(paper, {}), 0);
          const leaked = recruitmentAnswers(paper, null, true);
          leaked.notAQuestion = ["score"];
          assert.equal(grade(paper, leaked), 15);
        }
      }
    }
  });

  test("recruitment portfolio figures stay inside the supported numeric bounds", () => {
    const edges = [[90000, 28, 7200], [300000, 46, 72000]];
    for (const [revenue, margin, overhead] of edges) {
      const sample = makePortfolioCase(revenue, margin, overhead);
      assert.equal(sample.directCosts + sample.gross, revenue);
      assert.equal(sample.contribution, sample.gross - overhead);
      assert.ok(sample.contribution > 0);
    }
    for (let revenue = 90000; revenue <= 300000; revenue += 5300) {
      for (let margin = 28; margin <= 46; margin += 3) {
        const gross = revenue * margin / 100;
        const minimum = Math.ceil(revenue * 0.08 / 10) * 10;
        const maximum = Math.floor(Math.min(revenue * 0.24, gross - 1000) / 10) * 10;
        if (maximum < minimum) {
          assert.throws(() => makePortfolioCase(revenue, margin, minimum));
          continue;
        }
        for (const overhead of [minimum, maximum]) {
          const sample = makePortfolioCase(revenue, margin, overhead);
          assert.equal(sample.directCosts + sample.gross, revenue);
          assert.equal(sample.contribution, gross - overhead);
        }
        assert.throws(() => makePortfolioCase(revenue, margin, minimum - 10));
        assert.throws(() => makePortfolioCase(revenue, margin, maximum + 10));
      }
    }
    assert.throws(() => makePortfolioCase(89900, 35, 8000));
    assert.throws(() => makePortfolioCase(300100, 35, 20000));
    assert.throws(() => makePortfolioCase(120000, 27, 18000));
    assert.throws(() => makePortfolioCase(120000, 47, 18000));
    assert.throws(() => makePortfolioCase(120000, 35.5, 18000));
    assert.throws(() => makePortfolioCase(120050, 35, 18000));
  });

  test("practice pack: concurrent starts and submits stay stateless inside request bounds", async () => {
    const f = fixture({ live: "false" });
    const starts = await Promise.all(Array.from({ length: 16 }, () => f.practice("/api/practice/start", {})));
    assert.deepEqual(tally(starts), { 200: 16 });
    const papers = await Promise.all(starts.map(response => response.json()));
    assert.equal(new Set(papers.map(paper => paper.challenge)).size, 16);
    for (const response of starts) assert.equal(response.headers.has("Set-Cookie"), false);
    for (const paper of papers) {
      assert.deepEqual(paper.questions.map(question => question.section), [
        ...Array(8).fill("Foundations"), ...Array(7).fill("Applied Reading"),
      ]);
      assert.equal(paper.deadline - paper.serverNow, 30 * 60 * 1000);
      assert.equal(paper.questions.some(question => "correct" in question), false);
    }
    assert.equal(f.records.size, 0);
    assert.equal(f.objects.size, 0);

    const answers = Object.fromEntries(papers[0].questions.map(question => [question.id, question.options[0].id]));
    const submits = await Promise.all(Array.from({ length: 12 }, () =>
      f.practice("/api/practice/submit", { challenge: papers[0].challenge, answers })));
    assert.deepEqual(tally(submits), { 200: 12 });
    const scored = await Promise.all(submits.map(response => response.json()));
    assert.ok(scored.every(result => result.score === scored[0].score && result.answered === 15 && result.total === 15));
    assert.ok(scored[0].score >= 0 && scored[0].score <= 15);
    assert.equal(f.records.size, 0);

    const empty = await (await f.practice("/api/practice/submit", { challenge: papers[1].challenge, answers: {} })).json();
    assert.deepEqual({ score: empty.score, answered: empty.answered, total: empty.total }, { score: 0, answered: 0, total: 15 });
    const tooMany = {};
    for (let index = 0; index < 16; index++) tooMany["practice-extra-" + index] = "x".repeat(8);
    assert.equal((await f.practice("/api/practice/submit", { challenge: papers[1].challenge, answers: tooMany })).status, 400);
    assert.equal((await f.practice("/api/practice/submit", { challenge: papers[1].challenge, answers: [] })).status, 400);
    assert.equal((await f.practice("/api/practice/submit", {
      challenge: papers[1].challenge,
      answers: Object.fromEntries(papers[1].questions.map(question => [question.id, "not-issued"])),
    })).status, 422);
    assert.equal((await f.practice("/api/practice/submit", { challenge: "p1." + "a".repeat(17000), answers: {} })).status, 400);

    const under = `{"extra":"${"x".repeat(32 * 1024 - 12)}"}`;
    const over = under + "y";
    assert.equal(under.length, 32 * 1024);
    assert.equal((await f.practice("/api/practice/start", under)).status, 400);
    assert.equal((await f.practice("/api/practice/start", over)).status, 413);
    assert.equal((await f.practice("/api/practice/start", {}, { headers: { "Content-Length": "99999" } })).status, 413);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(32 * 1024 + 1));
        controller.close();
      },
    });
    assert.equal((await f.practice("/api/practice/start", undefined, { stream })).status, 413);
    assert.equal(f.records.size, 0);

    const restore = freezeTime(papers[2].deadline);
    try {
      assert.equal((await f.practice("/api/practice/submit", { challenge: papers[2].challenge, answers: {} })).status, 410);
    } finally { restore(); }
  });

  test("recruitment pack: concurrent starts serialize and a full paper grades on the server", async () => {
    const f = fixture();
    const contested = await f.issue(15);
    const claims = Array.from({ length: 8 }, () => random());
    const distinct = await Promise.all(claims.map(claim => f.req("/api/start", "POST", {
      invite: contested.invite, claim, noticeVersion: notice.version,
    })));
    assert.deepEqual(tally(distinct), { 200: 1, 403: 7 });
    assert.equal(distinct.filter(response => response.headers.has("Set-Cookie")).length, 1);
    const winner = await distinct.find(response => response.status === 200).json();
    assert.equal(winner.attempt.questions.filter(question => question.section === "Foundations").length, 8);
    assert.equal(winner.attempt.questions.filter(question => question.section === "Applied Reading").length, 7);
    assert.equal(winner.attempt.deadline - winner.attempt.startedAt, 15 * 60 * 1000);
    assert.equal(winner.attempt.score, undefined);
    assert.equal(winner.attempt.paper, undefined);
    for (const question of winner.attempt.questions) {
      assert.equal("correct" in question, false);
      assert.deepEqual(Object.keys(question.options[0]).sort(), ["id", "text"]);
    }
    const stored = f.records.get(contested.reference).record;
    assert.equal(stored.status, "active");
    assert.equal(stored.revision, 1);
    assert.equal(stored.paper.questions.length, 15);
    for (const loser of distinct.filter(response => response.status === 403)) {
      const body = await loser.json();
      assert.equal(body.attempt, undefined);
      assert.equal(body.questions, undefined);
    }

    const repeatedClaim = random();
    const replayInvite = await f.issue();
    let writes = 0;
    const put = f.env.RECORDS.put.bind(f.env.RECORDS);
    f.env.RECORDS.put = async (...args) => {
      writes++;
      return put(...args);
    };
    const replayed = await Promise.all(Array.from({ length: 6 }, () => f.req("/api/start", "POST", {
      invite: replayInvite.invite, claim: repeatedClaim, noticeVersion: notice.version,
    })));
    assert.deepEqual(tally(replayed), { 200: 6 });
    const replayedPapers = await Promise.all(replayed.map(response => response.json()));
    const signatures = replayedPapers.map(body => body.attempt.questions.map(question => question.id).join());
    assert.equal(new Set(signatures).size, 1);
    assert.equal(writes, 1);
    assert.equal(f.records.get(replayInvite.reference).record.revision, 1);
    f.env.RECORDS.put = put;

    const invites = [];
    for (let index = 0; index < 4; index++) invites.push(await f.issue());
    const pending = await f.issue();
    const started = await Promise.all(invites.map(invite => f.start(invite)));
    assert.equal(new Set(started.map(session => session.attempt.reference)).size, 4);
    const sharedIds = started.flatMap(session => session.attempt.questions.map(question => question.id));
    assert.equal(new Set(sharedIds).size, sharedIds.length);

    const active = started[0];
    const blocked = await Promise.all(Array.from({ length: 5 }, () => f.req("/api/start", "POST", {
      invite: pending.invite, claim: random(), noticeVersion: notice.version,
    }, { cookie: active.cookie })));
    assert.deepEqual(tally(blocked), { 409: 5 });
    assert.equal(f.records.get(pending.reference).record.status, "invited");
    assert.equal(f.records.get(pending.reference).record.paper, undefined);

    const question = active.attempt.questions[0];
    const revision = active.attempt.revision;
    const raced = await Promise.all([0, 1].map(index => f.req("/api/answers", "PUT", {
      reference: invites[0].reference, questionId: question.id, choices: [question.options[index].id], revision,
    }, { cookie: active.cookie })));
    assert.deepEqual(tally(raced), { 200: 1, 409: 1 });
    const saved = f.records.get(invites[0].reference).record;
    assert.equal(saved.revision, revision + 1);
    assert.equal(saved.answers[question.id].length, 1);

    async function answerAll(session, invite, mutate) {
      let current = session.attempt.revision;
      for (const item of session.attempt.questions) {
        const key = f.records.get(invite.reference).record.paper.key[item.id];
        const choices = mutate && item.id === session.attempt.questions[0].id
          ? [item.options.find(option => option.id !== key[0]).id]
          : key;
        const response = await f.req("/api/answers", "PUT", {
          reference: invite.reference, questionId: item.id, choices, revision: current,
        }, { cookie: session.cookie });
        assert.equal(response.status, 200);
        current = (await response.json()).attempt.revision;
      }
      return current;
    }

    const early = await f.req("/api/submit", "POST", { reference: invites[2].reference, revision: started[2].attempt.revision }, { cookie: started[2].cookie });
    assert.equal(early.status, 409);
    assert.equal(f.records.get(invites[2].reference).record.status, "active");
    assert.equal(f.records.get(invites[2].reference).record.score, undefined);

    const graded = await Promise.all(started.slice(2).map(async (session, index) => {
      const invite = invites[index + 2];
      const current = await answerAll(session, invite, index === 1);
      const submitted = await Promise.all([0, 1].map(() => f.req("/api/submit", "POST", {
        reference: invite.reference, revision: current,
      }, { cookie: session.cookie })));
      assert.deepEqual(tally(submitted), { 200: 2 });
      for (const response of submitted) assert.equal((await response.clone().json()).attempt.score, undefined);
      const review = await (await f.req("/api/ops/attempts/" + invite.reference, "GET", undefined, f.admin)).json();
      return review;
    }));
    assert.equal(graded[0].score, 15);
    assert.equal(graded[1].score, 14);
    assert.equal(graded[0].responses.length, 15);
    assert.equal(graded[0].paper, undefined);
    assert.equal(f.records.get(invites[2].reference).record.revision, started[2].attempt.revision + 16);
    const oversized = [question.options[0].id, question.options[1].id];
    assert.equal((await f.req("/api/answers", "PUT", {
      reference: invites[0].reference, questionId: question.id, choices: oversized, revision: saved.revision,
    }, { cookie: active.cookie })).status, 422);
  });

  test("recruitment bounds reject duration, body, and choice edges without opening a paper", async () => {
    const f = fixture();
    const invite = data => f.req("/api/ops/invites", "POST", data, f.admin);
    for (const durationMinutes of [4, 56, 5.5, "30", null, -1, 0]) {
      assert.equal((await invite({ durationMinutes })).status, 422);
    }
    assert.equal(f.records.size, 0);
    const short = await (await invite({ durationMinutes: 5 })).json();
    const long = await (await invite({ durationMinutes: 55 })).json();
    assert.equal(short.durationMinutes, 5);
    assert.equal(long.hardEnd - long.expiresAt, 55 * 60 * 1000);
    const started = await f.start(short);
    assert.equal(started.attempt.deadline - started.attempt.startedAt, 5 * 60 * 1000);

    const prefix = '{"durationMinutes":30,"pad":"';
    const suffix = '"}';
    const sized = size => prefix + "x".repeat(size - prefix.length - suffix.length) + suffix;
    const atCap = sized(2048);
    const overCap = sized(2049);
    assert.equal(atCap.length, 2048);
    assert.equal((await f.req("/api/ops/invites", "POST", atCap, f.admin)).status, 400);
    assert.equal((await f.req("/api/ops/invites", "POST", overCap, f.admin)).status, 413);
    assert.equal((await f.req("/api/ops/invites", "POST", { durationMinutes: 30 }, {
      ...f.admin, headers: { "Content-Length": "99999" },
    })).status, 413);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(2049));
        controller.close();
      },
    });
    assert.equal((await f.req("/api/ops/invites", "POST", undefined, { ...f.admin, stream })).status, 413);
    assert.equal((await f.req("/api/start", "POST", { invite: "not-an-invite" })).status, 403);
    assert.equal(f.records.size, 2);
  });

  test("rate limits follow the 120/60 binding and keep packs on separate keys", async () => {
    const source = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
    const limit = Number(source.match(/"limit": (\d+)/)[1]);
    const period = Number(source.match(/"period": (\d+)/)[1]);
    assert.equal(limit, 120);
    assert.equal(period, 60);

    const closed = fixture({ live: "false" });
    const bounded = countingLimiter(limit);
    closed.setLimiter(bounded.limit.bind(bounded));
    const restore = freezeTime(FROZEN_NOW);
    try {
      const responses = [];
      for (let attempt = 0; attempt < limit + 1; attempt++) {
        responses.push(await closed.req("/api/ops/whoami", "GET", undefined, closed.admin));
      }
      assert.deepEqual(tally(responses), { 200: limit, 429: 1 });
      assert.equal(responses.at(-1).status, 429);
      assert.equal(new Set(bounded.keys).size, 1);
      assert.equal(bounded.keys.length, limit + 1);
      assert.match(bounded.keys[0], /^[0-9a-f]{64}$/);
      assert.equal(bounded.keys[0].includes("192.0.2"), false);
      assert.equal(closed.records.size, 0);

      const practiceKey = (await (async () => {
        const seen = [];
        closed.setLimiter(async ({ key }) => { seen.push(key); return { success: true }; });
        assert.equal((await closed.practice("/api/practice/start", {})).status, 200);
        return seen[0];
      })());
      closed.setLimiter(async ({ key }) => ({ success: key !== practiceKey }));
      assert.equal((await closed.practice("/api/practice/start", {})).status, 429);
      assert.equal((await closed.req("/api/ops/whoami", "GET", undefined, closed.admin)).status, 200);
      assert.equal((await closed.req("/api/ops/invites", "POST", { durationMinutes: 30 }, closed.admin)).status, 503);
      assert.equal(closed.records.size, 0);

      const addresses = [];
      closed.setLimiter(async ({ key }) => { addresses.push(key); return { success: true }; });
      assert.equal((await closed.practice("/api/practice/start", {}, { ip: "192.0.2.10" })).status, 200);
      assert.equal((await closed.practice("/api/practice/start", {}, { ip: "192.0.2.11" })).status, 200);
      assert.equal(addresses.length, 2);
      assert.notEqual(addresses[0], addresses[1]);
    } finally { restore(); }

    const rolled = fixture({ live: "false" });
    const minutes = [];
    rolled.setLimiter(async ({ key }) => { minutes.push(key); return { success: true }; });
    const firstMinute = freezeTime(FROZEN_NOW);
    assert.equal((await rolled.practice("/api/practice/start", {})).status, 200);
    firstMinute();
    const secondMinute = freezeTime(FROZEN_NOW + period * 1000);
    assert.equal((await rolled.practice("/api/practice/start", {})).status, 200);
    secondMinute();
    assert.equal(minutes.length, 2);
    assert.notEqual(minutes[0], minutes[1]);

    const burst = fixture({ live: "false" });
    const cap = countingLimiter(10);
    burst.setLimiter(cap.limit.bind(cap));
    const burstClock = freezeTime(FROZEN_NOW);
    try {
      const responses = await Promise.all(Array.from({ length: 30 }, () => burst.practice("/api/practice/start", {})));
      assert.deepEqual(tally(responses), { 200: 10, 429: 20 });
      assert.equal(new Set(cap.keys).size, 1);
      assert.equal(burst.records.size, 0);
    } finally { burstClock(); }

    const hiring = fixture();
    const hiringClock = freezeTime(FROZEN_NOW);
    try {
      const invites = [];
      for (let index = 0; index < 12; index++) invites.push(await hiring.issue());
      const startCap = countingLimiter(5);
      hiring.setLimiter(startCap.limit.bind(startCap));
      const starts = await Promise.all(invites.map(invite => hiring.req("/api/start", "POST", {
        invite: invite.invite, claim: random(), noticeVersion: notice.version,
      })));
      assert.deepEqual(tally(starts), { 200: 5, 429: 7 });
      const active = [...hiring.records.values()].filter(entry => entry.record.status === "active").length;
      const invited = [...hiring.records.values()].filter(entry => entry.record.status === "invited").length;
      assert.deepEqual({ active, invited }, { active: 5, invited: 7 });
      assert.equal(new Set(startCap.keys).size, 1);

      hiring.setLimiter(async () => ({ success: true }));
      const session = await hiring.start(await hiring.issue());
      const attemptCap = countingLimiter(1);
      hiring.setLimiter(attemptCap.limit.bind(attemptCap));
      const item = session.attempt.questions[1];
      const answer = (choices, revision) => hiring.req("/api/answers", "PUT", {
        reference: session.attempt.reference, questionId: item.id, choices, revision,
      }, { cookie: session.cookie });
      assert.equal((await answer([item.options[0].id], session.attempt.revision)).status, 200);
      const after = hiring.records.get(session.attempt.reference).record;
      assert.equal((await answer([item.options[1].id], after.revision)).status, 429);
      assert.equal(hiring.records.get(session.attempt.reference).record.revision, after.revision);
      assert.deepEqual(hiring.records.get(session.attempt.reference).record.answers[item.id], [item.options[0].id]);
      assert.equal(attemptCap.keys.length >= 2, true);
      assert.equal(new Set(attemptCap.keys).size >= 2, true);
    } finally { hiringClock(); }
  });

  test("shipped configuration keeps recruitment closed while practice can still start", async () => {
    const source = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
    assert.match(source, /"LIVE_ENABLED": "false"/);
    const f = fixture({ live: "false" });
    const config = await (await f.req("/api/config")).json();
    assert.equal(config.enabled, false);
    const invites = await Promise.all([0, 1, 2].map(() => f.req("/api/ops/invites", "POST", { durationMinutes: 15 }, f.admin)));
    assert.deepEqual(tally(invites), { 503: 3 });
    const starts = await Promise.all([0, 1, 2].map(() => f.req("/api/start", "POST", {
      invite: "a".repeat(32) + "." + "b".repeat(64), claim: random(), noticeVersion: notice.version,
    })));
    assert.deepEqual(tally(starts), { 503: 3 });
    const practice = await Promise.all([0, 1, 2, 3].map(() => f.practice("/api/practice/start", {})));
    assert.deepEqual(tally(practice), { 200: 4 });
    assert.equal(f.records.size, 0);
    assert.equal(f.objects.size, 0);
    for (const flag of ["TRUE", "1", "yes"]) {
      f.env.LIVE_ENABLED = flag;
      assert.equal((await (await f.req("/api/config")).json()).enabled, false);
    }
  });
});
