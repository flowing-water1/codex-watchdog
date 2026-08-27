const DEFAULT_QUOTA_POLL_MS = 60_000;
const DEFAULT_QUOTA_RESET_GRACE_MS = 10_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function codexRateLimitSnapshot(response) {
  const byLimitId = response?.rateLimitsByLimitId;
  if (isObject(byLimitId) && Object.hasOwn(byLimitId, "codex")) {
    return byLimitId.codex;
  }
  return response?.rateLimits;
}

function normalizeWindow(window) {
  if (!isObject(window) || !Number.isFinite(window.usedPercent)) return null;
  if (window.usedPercent < 0) return null;

  const windowDurationMins = window.windowDurationMins;
  if (
    windowDurationMins != null &&
    (!Number.isFinite(windowDurationMins) || windowDurationMins <= 0)
  ) return null;

  const resetsAt = window.resetsAt;
  if (resetsAt != null && (!Number.isFinite(resetsAt) || resetsAt < 0)) return null;

  return {
    usedPercent: window.usedPercent,
    windowDurationMins: windowDurationMins ?? null,
    resetsAt: resetsAt ?? null,
  };
}

function quotaWindows(snapshot) {
  if (!isObject(snapshot)) return { invalid: true, windows: [] };

  const candidates = [];
  let invalid = false;
  for (const [key, value] of Object.entries(snapshot)) {
    const namedWindow = key === "primary" || key === "secondary";
    const futureWindow = isObject(value) && Object.hasOwn(value, "usedPercent");
    if (!namedWindow && !futureWindow) continue;
    if (value == null) continue;

    const window = normalizeWindow(value);
    if (window) candidates.push(window);
    else invalid = true;
  }
  return { invalid, windows: candidates };
}

export function analyzeCodexQuota(response) {
  const snapshot = codexRateLimitSnapshot(response);
  const { invalid, windows } = quotaWindows(snapshot);
  if (invalid || windows.length === 0) {
    return {
      known: false,
      available: false,
      exhaustedWindows: [],
      resetAt: null,
    };
  }

  const exhaustedWindows = windows.filter((window) => window.usedPercent >= 100);
  const resetAt = exhaustedWindows.length > 0 &&
    exhaustedWindows.every((window) => Number.isFinite(window.resetsAt))
    ? Math.max(...exhaustedWindows.map((window) => window.resetsAt))
    : null;

  return {
    known: true,
    available: exhaustedWindows.length === 0,
    exhaustedWindows,
    resetAt,
  };
}

export function nextQuotaCheckDelayMs(
  analysis,
  {
    nowMs = Date.now(),
    pollMs = DEFAULT_QUOTA_POLL_MS,
    resetGraceMs = DEFAULT_QUOTA_RESET_GRACE_MS,
  } = {},
) {
  if (analysis?.known === true && analysis.available === true) return 0;
  if (
    analysis?.known !== true ||
    analysis.available !== false ||
    !Number.isFinite(analysis.resetAt)
  ) return pollMs;

  const untilResetMs = analysis.resetAt * 1_000 + resetGraceMs - nowMs;
  return untilResetMs > 0 ? Math.min(untilResetMs, MAX_TIMER_DELAY_MS) : pollMs;
}

export function quotaWindowLabel(window) {
  const durationMins = typeof window === "number"
    ? window
    : window?.windowDurationMins;
  if (durationMins === 300) return "5-hour window";
  if (durationMins === 10_080) return "weekly window";
  if (Number.isFinite(durationMins) && durationMins > 0) {
    return `${durationMins}-minute window`;
  }
  return "unknown window";
}
