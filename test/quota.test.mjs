import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeCodexQuota,
  nextQuotaCheckDelayMs,
  quotaWindowLabel,
} from "../src/quota.mjs";

function codexQuota(primary, secondary = null) {
  return {
    rateLimitsByLimitId: {
      codex: { limitId: "codex", primary, secondary },
    },
  };
}

test("detects an exhausted 5-hour window from its 300 minute duration", () => {
  const analysis = analyzeCodexQuota(codexQuota({
    usedPercent: 100,
    windowDurationMins: 300,
    resetsAt: 1_787_000_000,
  }));

  assert.equal(analysis.known, true);
  assert.equal(analysis.available, false);
  assert.equal(analysis.exhaustedWindows.length, 1);
  assert.equal(quotaWindowLabel(analysis.exhaustedWindows[0]), "5-hour window");
});

test("detects an exhausted weekly window from its 10080 minute duration", () => {
  const analysis = analyzeCodexQuota(codexQuota({
    usedPercent: 100,
    windowDurationMins: 10_080,
    resetsAt: 1_787_100_000,
  }));

  assert.equal(analysis.available, false);
  assert.equal(quotaWindowLabel(analysis.exhaustedWindows[0]), "weekly window");
});

test("reports every exhausted window when multiple windows are limited", () => {
  const analysis = analyzeCodexQuota(codexQuota(
    { usedPercent: 100, windowDurationMins: 300, resetsAt: 1_787_000_000 },
    { usedPercent: 105, windowDurationMins: 10_080, resetsAt: 1_787_500_000 },
  ));

  assert.equal(analysis.exhaustedWindows.length, 2);
  assert.deepEqual(
    analysis.exhaustedWindows.map((window) => window.windowDurationMins),
    [300, 10_080],
  );
});

test("treats all known windows below 100 percent as available", () => {
  const analysis = analyzeCodexQuota(codexQuota(
    { usedPercent: 99, windowDurationMins: 300, resetsAt: 1_787_000_000 },
    { usedPercent: 42, windowDurationMins: 10_080, resetsAt: 1_787_500_000 },
  ));

  assert.deepEqual(analysis, {
    known: true,
    available: true,
    exhaustedWindows: [],
    resetAt: null,
  });
});

test("preserves the service-provided resetsAt timestamp", () => {
  const analysis = analyzeCodexQuota(codexQuota({
    usedPercent: 100,
    windowDurationMins: 300,
    resetsAt: 1_787_654_321,
  }));

  assert.equal(analysis.exhaustedWindows[0].resetsAt, 1_787_654_321);
  assert.equal(analysis.resetAt, 1_787_654_321);
});

test("prefers rateLimitsByLimitId.codex over the legacy view", () => {
  const analysis = analyzeCodexQuota({
    rateLimitsByLimitId: {
      codex: {
        primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: null },
      },
    },
    rateLimits: {
      primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1_787_000_000 },
    },
  });

  assert.equal(analysis.known, true);
  assert.equal(analysis.available, true);
});

test("parses the backward-compatible rateLimits view", () => {
  const analysis = analyzeCodexQuota({
    rateLimits: {
      primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1_787_000_000 },
      secondary: null,
    },
  });

  assert.equal(analysis.known, true);
  assert.equal(analysis.available, false);
});

test("keeps unknown or incomplete quota data unavailable", () => {
  const cases = [
    null,
    {},
    { rateLimits: null },
    { rateLimits: {} },
    { rateLimits: { primary: { windowDurationMins: 300 } } },
    { rateLimitsByLimitId: { other: { primary: { usedPercent: 0 } } } },
  ];

  for (const response of cases) {
    assert.deepEqual(analyzeCodexQuota(response), {
      known: false,
      available: false,
      exhaustedWindows: [],
      resetAt: null,
    });
  }
});

test("adds reset grace time and falls back to polling for unknown data", () => {
  assert.equal(nextQuotaCheckDelayMs({
    known: true,
    available: false,
    resetAt: 1_010,
  }, {
    nowMs: 1_000_000,
    pollMs: 60_000,
    resetGraceMs: 10_000,
  }), 20_000);

  assert.equal(nextQuotaCheckDelayMs({
    known: false,
    available: false,
    resetAt: null,
  }, {
    nowMs: 1_000_000,
    pollMs: 12_345,
    resetGraceMs: 10_000,
  }), 12_345);
});

test("uses the latest reset when multiple exhausted windows recover", () => {
  const analysis = analyzeCodexQuota(codexQuota(
    { usedPercent: 100, windowDurationMins: 10_080, resetsAt: 1_787_900_000 },
    { usedPercent: 100, windowDurationMins: 300, resetsAt: 1_787_100_000 },
  ));

  assert.equal(analysis.resetAt, 1_787_900_000);
});
