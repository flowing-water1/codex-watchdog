import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";

import WebSocket from "ws";

import { allocateTcpPort, resolveCodexEntrypoint, waitForHttpReady } from "../src/launcher-support.mjs";
import { createWatchdogProxy } from "../src/proxy.mjs";
import { analyzeCodexQuota } from "../src/quota.mjs";

function waitForOpen(socket) {
  return new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

function waitForResponse(socket, id, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for response ${id}`));
    }, timeoutMs);
    const onMessage = (data) => {
      const message = JSON.parse(data.toString());
      if (message.id !== id) return;
      cleanup();
      if (message.error) {
        const error = new Error(message.error.message);
        error.code = message.error.code;
        reject(error);
      }
      else resolve(message.result);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("message", onMessage);
      socket.off("error", onError);
    };
    socket.on("message", onMessage);
    socket.on("error", onError);
  });
}

async function stopChild(child) {
  if (!child || child.exitCode != null || child.signalCode != null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await exited;
}

const host = "127.0.0.1";
const appServerPort = await allocateTcpPort(host);
const appServerUrl = `ws://${host}:${appServerPort}`;
const codexEntrypoint = resolveCodexEntrypoint();
const appServer = spawn(process.execPath, [codexEntrypoint, "app-server", "--listen", appServerUrl], {
  cwd: process.cwd(),
  env: process.env,
  windowsHide: true,
  stdio: "ignore",
});
let proxy;
let client;

try {
  await waitForHttpReady(`http://${host}:${appServerPort}/readyz`, { timeoutMs: 20_000 });
  proxy = await createWatchdogProxy({
    listenHost: host,
    listenPort: 0,
    upstreamUrl: appServerUrl,
    delaysMs: [5],
    logger: { info() {}, warn() {}, error() {} },
  });
  client = new WebSocket(proxy.url);
  await waitForOpen(client);

  const initialized = waitForResponse(client, "live-initialize");
  client.send(
    JSON.stringify({
      method: "initialize",
      id: "live-initialize",
      params: {
        clientInfo: {
          name: "codex_cli",
          title: "Codex Goal Watchdog Smoke Test",
          version: "0.1.0",
        },
      },
    }),
  );
  const result = await initialized;
  assert.equal(typeof result.userAgent, "string");
  client.send(JSON.stringify({ method: "initialized", params: {} }));

  const rateLimits = waitForResponse(client, "live-rate-limits");
  client.send(
    JSON.stringify({
      method: "account/rateLimits/read",
      id: "live-rate-limits",
    }),
  );
  const quota = analyzeCodexQuota(await rateLimits);
  assert.equal(quota.known, true);

  const interruptError = waitForResponse(client, "live-interrupt");
  client.send(
    JSON.stringify({
      method: "turn/interrupt",
      id: "live-interrupt",
      params: { threadId: "missing-thread", turnId: "missing-turn" },
    }),
  );
  await assert.rejects(interruptError, (error) => {
    assert.notEqual(error.code, -32601);
    return true;
  });

  const compactError = waitForResponse(client, "live-compact");
  client.send(
    JSON.stringify({
      method: "thread/compact/start",
      id: "live-compact",
      params: { threadId: "missing-thread" },
    }),
  );
  await assert.rejects(compactError, (error) => {
    assert.notEqual(error.code, -32601);
    return true;
  });
  process.stdout.write(
    "live app-server websocket, rate limits, turn/interrupt, and compact smoke passed\n",
  );
} finally {
  client?.close();
  if (proxy) await proxy.close();
  await stopChild(appServer);
}
