import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import worker, { Assessment } from "../src/worker.js";

const origin = "https://assessment.example";
const notice = {
  controller: "Test controller", contact: "privacy@example.invalid", basis: "Test basis",
  recipients: "Test reviewer", transfers: "Test transfer description", rights: "Test rights",
  purpose: "Test purpose", supervisoryAuthority: "Test authority", version: "test-1",
  retentionMinutes: 30, integrityReview: true,
};
const random = () => crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
const token = () => "a".repeat(32) + "." + "b".repeat(64);

function fixture() {
  const objects = new Map();
  const records = new Map();
  const env = {
    LIVE_ENABLED: "true", PRIVACY_COUNTRY: "FR", PRIVACY_NOTICE: { ...notice }, OPS_TOKEN: random(),
    ACCESS_ISSUER: "https://synthetic-test.cloudflareaccess.com", ACCESS_AUD: "a".repeat(64),
    DURATION_MINUTES: 30, INVITE_TTL_MINUTES: 12,
    PRACTICE_KEY: "c".repeat(64),
    RATE_LIMITER: { async limit() { return { success: true }; } },
    ASSETS: { async fetch() { return new Response("<!doctype html><title>Test</title>", { headers: { "Content-Type": "text/html; charset=utf-8" } }); } },
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
  async function issue() {
    const response = await req("/api/ops/invites", "POST", {}, admin);
    assert.equal(response.status, 201);
    return response.json();
  }
  async function start(invite, claim = random()) {
    const response = await req("/api/start", "POST", { invite, claim, noticeVersion: notice.version, integrityReview: true });
    assert.equal(response.status, 200);
    const setCookie = response.headers.get("Set-Cookie");
    return { cookie: setCookie.split(";")[0], setCookie, claim, ...(await response.json()) };
  }
  return { env, records, req, issue, start, admin };
}

function leaked(response, secret, body) {
  const headerText = [...response.headers].map(([name, value]) => name + ":" + value).join("\n");
  return headerText.includes(secret) || body.includes(secret);
}

test("deployment stays closed", async () => {
  const source = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(source, /"LIVE_ENABLED":\s*"false"/);
});

test("closed recruitment does not publish the hiring notice, countries, or invite lifetime", async () => {
  const f = fixture();
  f.env.LIVE_ENABLED = "false";
  const closed = await (await f.req("/api/config")).json();
  assert.equal(closed.enabled, false);
  assert.deepEqual(Object.keys(closed).sort(), ["durationMinutes", "enabled"]);
  assert.equal(JSON.stringify(closed).includes(notice.controller), false);
  assert.equal(JSON.stringify(closed).includes("integrityReview"), false);
  const secret = token();
  assert.equal((await f.req("/api/invitation", "POST", { invite: secret })).status, 503);
  assert.equal((await f.req("/api/start", "POST", { invite: secret, claim: random(), noticeVersion: notice.version, integrityReview: true })).status, 503);
  assert.equal(f.records.size, 0);
  f.env.LIVE_ENABLED = "true";
  delete f.env.ACCESS_AUD;
  const unsigned = await (await f.req("/api/config")).json();
  assert.equal(unsigned.enabled, false);
  assert.equal(Object.hasOwn(unsigned, "notice"), false);
  assert.equal(Object.hasOwn(unsigned, "countries"), false);
  assert.equal(Object.hasOwn(unsigned, "inviteTtlMinutes"), false);
  f.env.ACCESS_AUD = "a".repeat(64);
  const live = await (await f.req("/api/config")).json();
  assert.equal(live.enabled, true);
  assert.equal(live.notice.version, notice.version);
  assert.deepEqual(live.countries, ["FR"]);
});

test("a closed deployment does not resume a hiring paper, and practice stays cookieless", async () => {
  const f = fixture();
  const invite = await f.issue();
  const started = await f.start(invite.invite);
  f.env.LIVE_ENABLED = "false";
  const session = await f.req("/api/session", "GET", undefined, { cookie: started.cookie, reference: invite.reference });
  assert.equal((await session.json()).attempt, null);
  const practice = await f.req("/api/practice/start", "POST", {});
  assert.equal(practice.status, 200);
  assert.equal(practice.headers.has("Set-Cookie"), false);
  assert.equal(practice.headers.get("Cross-Origin-Resource-Policy"), "same-origin");
  const body = await practice.json();
  assert.equal(body.challenge.startsWith("p1."), true);
  assert.equal(Object.hasOwn(body, "key"), false);
  assert.equal(f.records.size, 1);
});

test("invitation secrets in the document query are discarded and never echoed", async () => {
  const f = fixture();
  const secret = token();
  const page = await f.req("/?invite=" + secret);
  assert.equal(page.status, 303);
  assert.equal(page.headers.get("Location"), "/");
  assert.equal(leaked(page, secret, await page.text()), false);
  const review = await f.req("/review/?Invite=" + secret);
  assert.equal(review.status, 303);
  assert.equal(review.headers.get("Location"), "/review/");
  assert.equal(leaked(review, secret, await review.text()), false);
  const buried = await f.req("/?next=" + secret);
  assert.equal(buried.status, 303);
  assert.equal(buried.headers.get("Location"), "/");
  const api = await f.req("/api/config?invite=" + secret);
  assert.equal(api.status, 400);
  assert.equal(leaked(api, secret, JSON.stringify(await api.json())), false);
});

test("the session cookie is host-only and a second host cookie does not select a paper", async () => {
  const f = fixture();
  const invite = await f.issue();
  const started = await f.start(invite.invite);
  assert.match(started.setCookie, /^__Host-assessment=[0-9a-f]{32}\.[0-9a-f]{64}; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=\d+$/);
  assert.doesNotMatch(started.setCookie, /Domain=/i);
  assert.equal((await f.req("/api/session", "GET", undefined, {
    cookie: "assessment=" + started.cookie.split("=")[1], reference: invite.reference,
  }).then(r => r.json())).attempt, null);
  const shadowed = await f.req("/api/session", "GET", undefined, {
    cookie: started.cookie + "; __Host-assessment=" + invite.reference + "." + "d".repeat(64),
    reference: invite.reference,
  });
  assert.equal((await shadowed.json()).attempt, null);
  const http = await worker.fetch(new Request("http://assessment.example/api/session", {
    headers: { Cookie: started.cookie, "X-Assessment-Reference": invite.reference },
  }), f.env);
  assert.equal(http.status, 400);
  assert.equal(JSON.stringify(await http.json()).includes(started.cookie.split(".")[1]), false);
});

test("a cross-site fetch cannot read or mutate a hiring session even with the page origin copied", async () => {
  const f = fixture();
  const invite = await f.issue();
  const started = await f.start(invite.invite);
  const cross = { headers: { Origin: origin, "Sec-Fetch-Site": "cross-site" } };
  const blocked = await f.req("/api/session", "GET", undefined, { ...cross, cookie: started.cookie, reference: invite.reference });
  assert.equal(blocked.status, 403);
  assert.equal(JSON.stringify(await blocked.json()).includes(started.attempt.questions[0].prompt), false);
  const fresh = await f.issue();
  const start = await f.req("/api/start", "POST", {
    invite: fresh.invite, claim: random(), noticeVersion: notice.version, integrityReview: true,
  }, cross);
  assert.equal(start.status, 403);
  assert.equal(f.records.get(fresh.reference).record.status, "invited");
  assert.equal(f.records.get(invite.reference).record.status, "active");
  const same = await f.req("/api/answers", "PUT", {
    reference: invite.reference, questionId: started.attempt.questions[0].id,
    choices: [started.attempt.questions[0].options[0].id], revision: started.attempt.revision,
  }, { cookie: started.cookie, headers: { "Sec-Fetch-Site": "same-origin" } });
  assert.equal(same.status, 200);
  assert.equal(same.headers.has("Access-Control-Allow-Origin"), false);
});

test("sensitive hiring JSON is uncacheable and export stays behind operator authorization", async () => {
  const f = fixture();
  const created = await f.req("/api/ops/invites", "POST", {}, f.admin);
  assert.equal(created.status, 201);
  assert.equal(created.headers.get("Cache-Control"), "private, no-store");
  assert.equal(created.headers.get("CDN-Cache-Control"), "no-store");
  assert.equal(created.headers.get("Pragma"), "no-cache");
  assert.equal(created.headers.has("Access-Control-Allow-Origin"), false);
  const issued = await created.json();
  const started = await f.start(issued.invite);
  const path = "/api/ops/attempts/" + issued.reference;
  assert.equal((await f.req(path)).status, 403);
  assert.equal((await f.req(path, "GET", undefined, { cookie: started.cookie })).status, 403);
  assert.equal((await f.req(path, "GET", undefined, { headers: { Authorization: "Bearer " + issued.invite } })).status, 403);
  const exported = await f.req(path, "GET", undefined, f.admin);
  assert.equal(exported.status, 200);
  assert.match(exported.headers.get("Cache-Control"), /no-store/);
  assert.equal(exported.headers.get("CDN-Cache-Control"), "no-store");
  assert.equal(exported.headers.has("Access-Control-Allow-Origin"), false);
  const body = await exported.json();
  const serial = JSON.stringify(body);
  assert.equal(serial.includes(issued.invite.split(".")[1]), false);
  assert.equal(body.inviteHash, undefined);
  assert.equal(body.paper, undefined);
  assert.equal(body.key, undefined);
  assert.equal(body.responses, undefined);
  f.env.LIVE_ENABLED = "false";
  assert.equal((await f.req(path)).status, 403);
  const closedExport = await f.req(path, "GET", undefined, f.admin);
  assert.equal(closedExport.status, 200);
  assert.equal(closedExport.headers.get("CDN-Cache-Control"), "no-store");
});

test("HTML responses carry a strict content security policy and host transport policy", async () => {
  const f = fixture();
  const page = await f.req("/");
  const policy = page.headers.get("Content-Security-Policy");
  assert.match(policy, /script-src 'self'/);
  assert.match(policy, /script-src-attr 'none'/);
  assert.match(policy, /worker-src 'none'/);
  assert.match(policy, /frame-src 'none'/);
  assert.match(policy, /frame-ancestors 'none'/);
  assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval/);
  assert.equal(page.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(page.headers.get("Strict-Transport-Security"), "max-age=31536000; includeSubDomains");
  assert.equal(page.headers.has("Access-Control-Allow-Origin"), false);
  assert.equal(page.headers.get("Cache-Control"), "private, no-store");
  const head = await f.req("/", "HEAD");
  assert.match(head.headers.get("Content-Security-Policy"), /script-src-attr 'none'/);
});
