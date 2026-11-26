import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../src/worker.js";

const origin = "https://assessment.example";
const requiredFields = [
  "controller", "contact", "basis", "recipients", "transfers", "rights",
  "purpose", "supervisoryAuthority", "version",
];

function notice(overrides = {}) {
  return {
    controller: "Test controller",
    contact: "privacy@example.invalid",
    basis: "Test basis",
    recipients: "Test reviewer",
    transfers: "Test transfer description",
    rights: "Test rights",
    purpose: "Test purpose",
    supervisoryAuthority: "Test authority",
    version: "test-1",
    retentionMinutes: 30,
    ...overrides,
  };
}

function openEnv(extra = {}) {
  return {
    LIVE_ENABLED: "true",
    DURATION_MINUTES: "30",
    INVITE_TTL_MINUTES: "30",
    ACCESS_ISSUER: "https://synthetic-test.cloudflareaccess.com",
    ACCESS_AUD: "a".repeat(64),
    RATE_LIMITER: {},
    ATTEMPTS: {},
    RECORDS: {},
    ...extra,
  };
}

async function readConfig(environment) {
  const response = await worker.fetch(new Request(origin + "/api/config"), environment);
  assert.equal(response.status, 200);
  return response.json();
}

function assertClosed(body, label) {
  assert.equal(body.enabled, false, label);
  assert.deepEqual(body.countries, [], label);
  assert.equal(body.notice, null, label);
}

test("one complete country profile is published with a 30-minute retention and trimmed notice fields", async () => {
  const body = await readConfig(openEnv({
    PRIVACY_COUNTRY: "FR",
    PRIVACY_NOTICE: notice({
      controller: "  Test controller  ",
      footnote: "not part of the public notice",
    }),
  }));
  assert.equal(body.enabled, true);
  assert.deepEqual(body.countries, ["FR"]);
  assert.deepEqual(body.notice, {
    controller: "Test controller",
    contact: "privacy@example.invalid",
    basis: "Test basis",
    recipients: "Test reviewer",
    transfers: "Test transfer description",
    rights: "Test rights",
    purpose: "Test purpose",
    supervisoryAuthority: "Test authority",
    version: "test-1",
    retentionMinutes: 30,
  });
});

test("string profiles approve only countries whose retentionMinutes is exactly 30", async () => {
  const body = await readConfig(openEnv({
    PRIVACY_COUNTRY: "DE",
    PRIVACY_NOTICE: notice(),
    NOTICE_PROFILES: JSON.stringify({
      FR: notice({ version: "fr-30" }),
      DE: notice({ retentionMinutes: 15, version: "de-15" }),
      US: notice({ retentionMinutes: "30", version: "us-string" }),
    }),
  }));
  assert.equal(body.enabled, true);
  assert.deepEqual(body.countries, ["FR"]);
  assert.equal(body.notice.version, "fr-30");
  assert.equal(body.notice.retentionMinutes, 30);
});

test("a retention other than 30 drops the country and keeps scored recruitment closed", async () => {
  for (const retentionMinutes of [15, 0, 29, 31, 60, "30", 30.5, null, undefined]) {
    const profile = notice();
    if (retentionMinutes === undefined) delete profile.retentionMinutes;
    else profile.retentionMinutes = retentionMinutes;
    const body = await readConfig(openEnv({ PRIVACY_COUNTRY: "FR", PRIVACY_NOTICE: profile }));
    assertClosed(body, "retentionMinutes " + String(retentionMinutes));
  }
});

test("every required notice field must be a non-empty string", async () => {
  for (const field of requiredFields) {
    for (const value of [undefined, "", "   ", 30, null]) {
      const profile = notice();
      if (value === undefined) delete profile[field];
      else profile[field] = value;
      const body = await readConfig(openEnv({ PRIVACY_COUNTRY: "FR", PRIVACY_NOTICE: profile }));
      assertClosed(body, field + "=" + String(value));
    }
  }
});

test("only two-letter codes with complete profiles are approved", async () => {
  const body = await readConfig(openEnv({
    NOTICE_PROFILES: {
      FR: notice({ version: "fr-30" }),
      US: notice({ version: "  us-30  " }),
      DE: notice({ retentionMinutes: 15 }),
      IT: notice({ purpose: "   " }),
      fr: notice(),
      FRA: notice(),
      F: notice(),
      F1: notice(),
    },
  }));
  assert.equal(body.enabled, true);
  assert.deepEqual(body.countries, ["FR", "US"]);
  assert.equal(body.notice, null);
});

test("an unreadable or empty profile map approves no country and ignores a legacy notice", async () => {
  for (const profiles of ["{}", "null", "", "[]", "{", "15"]) {
    const body = await readConfig(openEnv({
      NOTICE_PROFILES: profiles,
      PRIVACY_COUNTRY: "FR",
      PRIVACY_NOTICE: notice(),
    }));
    assertClosed(body, profiles === "" ? "empty string" : profiles);
  }
});

test("scored recruitment stays closed unless LIVE_ENABLED is the string true", async () => {
  const profile = { PRIVACY_COUNTRY: "FR", PRIVACY_NOTICE: notice() };
  const open = await readConfig(openEnv(profile));
  assert.equal(open.enabled, true);
  assert.deepEqual(open.countries, ["FR"]);

  for (const LIVE_ENABLED of ["false", "TRUE", "True", "1", "yes", "", true, false, undefined]) {
    const body = await readConfig(openEnv({ ...profile, LIVE_ENABLED }));
    assert.equal(body.enabled, false, String(LIVE_ENABLED));
    assert.deepEqual(body.countries, ["FR"], String(LIVE_ENABLED));
    assert.equal(body.notice.retentionMinutes, 30, String(LIVE_ENABLED));
  }

  const closed = await worker.fetch(new Request(origin + "/api/start", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: "{}",
  }), openEnv({ ...profile, LIVE_ENABLED: "false" }));
  assert.equal(closed.status, 503);
  assert.deepEqual(await closed.json(), { error: "Scored assessments are currently closed." });

  const unapproved = await worker.fetch(new Request(origin + "/api/start", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: "{}",
  }), openEnv({
    LIVE_ENABLED: "true",
    PRIVACY_COUNTRY: "FR",
    PRIVACY_NOTICE: notice({ retentionMinutes: 15 }),
  }));
  assert.equal(unapproved.status, 503);
  assert.deepEqual(await unapproved.json(), { error: "Scored assessments are currently closed." });
});

test("checked-in wrangler config approves no country and leaves recruitment closed", async () => {
  const text = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  const vars = JSON.parse(text).vars;
  assert.equal(vars.LIVE_ENABLED, "false");
  for (const key of ["PRIVACY_COUNTRY", "PRIVACY_NOTICE", "NOTICE_PROFILES"]) {
    assert.equal(Object.hasOwn(vars, key), false, key);
  }
  assert.equal(text.includes("retentionMinutes"), false);
  assert.equal(text.includes("PRIVACY_"), false);
  assert.equal(text.includes("NOTICE_PROFILES"), false);

  const asCheckedIn = await readConfig({
    ...vars,
    RATE_LIMITER: {},
    ATTEMPTS: {},
    RECORDS: {},
  });
  assertClosed(asCheckedIn, "checked-in vars");

  const liveFlagOnly = await readConfig(openEnv({ ...vars, LIVE_ENABLED: "true" }));
  assertClosed(liveFlagOnly, "checked-in vars with the live flag on");
});
