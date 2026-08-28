import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  allocateDistinctTcpPorts,
  allocateTcpPort,
  ensureWorkingDirectoryArg,
  parseNonNegativeMilliseconds,
  resolveCodexEntrypoint,
  validateForwardedArgs,
  waitForHttpReady,
} from "./launcher-support.mjs";
import { createWatchdogProxy } from "./proxy.mjs";
import { superviseStandardRuntime, terminateChild } from "./standard-runtime.mjs";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEFAULT_DELAYS_MS = [30_000, 60_000, 120_000, 300_000];
const DEFAULT_INTERRUPT_AFTER_MS = 120_000;
const DEFAULT_QUOTA_POLL_MS = 60_000;
const DEFAULT_QUOTA_RESET_GRACE_MS = 10_000;

function parseDelays(value) {
  if (!value) return DEFAULT_DELAYS_MS;
  const delays = value.split(",").map((part) => Number(part.trim()));
  if (delays.length === 0 || delays.some((delayMs) => !Number.isFinite(delayMs) || delayMs < 0)) {
    throw new Error("CODEX_WATCHDOG_DELAYS_MS must be a comma-separated list of milliseconds");
  }
  return delays;
}

function createFileLogger(logPath) {
  const fd = openSync(logPath, "a");
  const write = (level, message) => {
    writeSync(fd, `${new Date().toISOString()} ${level} ${message}\n`);
  };
  return {
    fd,
    info: (message) => write("INFO", message),
    warn: (message) => write("WARN", message),
    error: (message) => write("ERROR", message),
  };
}

async function main() {
  const logDir = path.join(projectRoot, "logs");
  mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, `watchdog-${new Date().toISOString().slice(0, 10)}.log`);
  const logger = createFileLogger(logPath);
  const host = "127.0.0.1";
  let appServer;
  let tui;
  let proxy;
  let requestedSignal = null;
  let resolveSignal;
  const signalPromise = new Promise((resolve) => { resolveSignal = resolve; });
  const signalHandlers = new Map();

  for (const signal of ["SIGINT", "SIGTERM"]) {
    const handler = () => {
      if (requestedSignal) return;
      requestedSignal = signal;
      logger.info(`Received ${signal}; shutting down`);
      resolveSignal({ type: "signal", signal });
    };
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }

  try {
    const codexEntrypoint = resolveCodexEntrypoint();
    const delaysMs = parseDelays(process.env.CODEX_WATCHDOG_DELAYS_MS);
    const interruptAfterMs = parseNonNegativeMilliseconds(
      process.env.CODEX_WATCHDOG_INTERRUPT_AFTER_MS,
      DEFAULT_INTERRUPT_AFTER_MS,
      "CODEX_WATCHDOG_INTERRUPT_AFTER_MS",
    );
    const quotaPollMs = parseNonNegativeMilliseconds(
      process.env.CODEX_WATCHDOG_QUOTA_POLL_MS,
      DEFAULT_QUOTA_POLL_MS,
      "CODEX_WATCHDOG_QUOTA_POLL_MS",
    );
    const quotaResetGraceMs = parseNonNegativeMilliseconds(
      process.env.CODEX_WATCHDOG_QUOTA_RESET_GRACE_MS,
      DEFAULT_QUOTA_RESET_GRACE_MS,
      "CODEX_WATCHDOG_QUOTA_RESET_GRACE_MS",
    );
    const forwardedArgs = process.argv.slice(2);
    validateForwardedArgs(forwardedArgs);
    const launchCwd = process.cwd();
    const tuiArgs = ensureWorkingDirectoryArg(forwardedArgs, launchCwd);
    const [appServerPort, proxyPort] = await allocateDistinctTcpPorts(
      2,
      () => allocateTcpPort(host),
    );
    const appServerUrl = `ws://${host}:${appServerPort}`;

    const startAppServer = () => {
      const child = spawn(process.execPath, [codexEntrypoint, "app-server", "--listen", appServerUrl], {
        cwd: launchCwd,
        env: process.env,
        windowsHide: true,
        stdio: ["ignore", logger.fd, logger.fd],
      });
      child.once("error", (error) => logger.error(`Failed to start app-server: ${error.message}`));
      return child;
    };
    appServer = startAppServer();
    await waitForHttpReady(`http://${host}:${appServerPort}/readyz`);
    logger.info(`Codex app-server ready at ${appServerUrl}`);

    proxy = await createWatchdogProxy({
      listenHost: host,
      listenPort: proxyPort,
      upstreamUrl: appServerUrl,
      delaysMs,
      interruptAfterMs,
      quotaPollMs,
      quotaResetGraceMs,
      logger,
    });

    process.stderr.write(`[goal-watchdog] enabled; log: ${logPath}\n`);
    tui = spawn(process.execPath, [codexEntrypoint, "--remote", proxy.url, ...tuiArgs], {
      cwd: launchCwd,
      env: process.env,
      windowsHide: false,
      stdio: "inherit",
    });
    tui.once("error", (error) => logger.error(`Failed to start TUI: ${error.message}`));

    const outcome = await superviseStandardRuntime({
      initialAppServer: appServer,
      tui,
      signalPromise,
      startAppServer,
      waitForAppServerReady: (_child, options) => waitForHttpReady(
        `http://${host}:${appServerPort}/readyz`,
        options,
      ),
      logger,
    });

    if (outcome.type === "signal") {
      process.exitCode = outcome.signal === "SIGINT" ? 130 : 143;
    } else {
      process.exitCode = outcome.error ? 1 : outcome.code ?? (outcome.signal ? 1 : 0);
    }
  } finally {
    for (const [signal, handler] of signalHandlers) process.off(signal, handler);
    if (proxy) await proxy.close();
    await terminateChild(tui);
    await terminateChild(appServer);
    closeSync(logger.fd);
  }
}

main().catch((error) => {
  process.stderr.write(`[goal-watchdog] ${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
