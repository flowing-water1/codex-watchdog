import { createServer } from "node:http";

import WebSocket, { WebSocketServer } from "ws";

import { GoalWatchdogController } from "./controller.mjs";
import { RpcChannel } from "./rpc-channel.mjs";

function parseJson(data, isBinary, logger) {
  if (isBinary) return null;
  try {
    return JSON.parse(data.toString());
  } catch (error) {
    logger.warn(`Ignored non-JSON app-server frame: ${error.message}`);
    return null;
  }
}

function closeSocket(socket, code = 1000, reason = "closing") {
  if (!socket) return;
  if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
    socket.close(code, reason);
  }
}

export async function createWatchdogProxy({
  listenHost = "127.0.0.1",
  listenPort = 0,
  upstreamUrl,
  delaysMs,
  interruptAfterMs,
  quotaPollMs,
  quotaResetGraceMs,
  upstreamConnectDelaysMs = [100, 250, 500, 1_000, 2_000, 5_000],
  logger = console,
}) {
  if (!upstreamUrl) throw new Error("upstreamUrl is required");
  if (!Array.isArray(upstreamConnectDelaysMs) || upstreamConnectDelaysMs.length === 0) {
    throw new Error("upstreamConnectDelaysMs must contain at least one delay");
  }
  const httpServer = createServer((request, response) => {
    if (request.url === "/readyz" || request.url === "/healthz") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("ok\n");
      return;
    }
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found\n");
  });
  const wss = new WebSocketServer({ server: httpServer });
  let activeSession = null;
  let closing = false;

  wss.on("connection", (client) => {
    if (activeSession) {
      client.close(1013, "watchdog proxy already has an active TUI");
      return;
    }

    let upstream;
    let sessionClosed = false;
    let upstreamReady = false;
    let initializeFrame = null;
    let initializedFrame = null;
    let initializeAcknowledged = false;
    let replayInitializeId = null;
    let forwardReplayResponse = false;
    let reconnecting = false;
    let connectAttempt = 0;
    let reconnectTimer = null;
    let controller;
    const rpc = new RpcChannel({
      send(message) {
        if (upstream?.readyState !== WebSocket.OPEN) {
          throw new Error("app-server websocket is not open");
        }
        upstream.send(message);
      },
    });
    controller = new GoalWatchdogController({
      sendRequest: (method, params) => rpc.request(method, params),
      delaysMs,
      interruptAfterMs,
      quotaPollMs,
      quotaResetGraceMs,
      logger,
    });

    const closeSession = (code = 1000, reason = "session closed") => {
      if (sessionClosed) return;
      sessionClosed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      controller.close();
      rpc.close(reason);
      closeSocket(client, code, reason);
      closeSocket(upstream, code, reason);
      if (activeSession?.client === client) activeSession = null;
    };
    activeSession = { client, close: closeSession };

    const scheduleInitialReconnect = () => {
      if (closing || sessionClosed || upstreamReady || reconnectTimer) return;
      const delayIndex = Math.min(connectAttempt, upstreamConnectDelaysMs.length - 1);
      const delayMs = upstreamConnectDelaysMs[delayIndex];
      connectAttempt += 1;
      logger.warn(`App-server connection attempt ${connectAttempt} failed; retry in ${delayMs}ms`);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectUpstream();
      }, delayMs);
    };

    const connectUpstream = () => {
      if (closing || sessionClosed || upstreamReady) return;
      const candidate = new WebSocket(upstreamUrl);
      upstream = candidate;
      candidate.on("open", () => {
        if (candidate !== upstream || sessionClosed) return;
        logger.info(`Connected watchdog proxy to ${upstreamUrl}`);
        if (initializeFrame && !initializeAcknowledged) {
          replayInitializeId = initializeFrame.message.id;
          forwardReplayResponse = !initializeAcknowledged;
          candidate.send(initializeFrame.data, { binary: initializeFrame.isBinary });
          return;
        }
        if (reconnecting && initializeFrame) {
          replayInitializeId = initializeFrame.message.id;
          candidate.send(initializeFrame.data, { binary: initializeFrame.isBinary });
          return;
        }
        upstreamReady = true;
      });
      candidate.on("message", (data, isBinary) => {
        if (candidate !== upstream || sessionClosed) return;
        const message = parseJson(data, isBinary, logger);
        if (message && rpc.consume(message)) return;
        if (replayInitializeId !== null && message?.id === replayInitializeId) {
          replayInitializeId = null;
          if (message.error) {
            if (forwardReplayResponse && client.readyState === WebSocket.OPEN) {
              client.send(data, { binary: isBinary });
            }
            forwardReplayResponse = false;
            logger.error(`App-server reinitialization failed: ${message.error.message ?? "unknown error"}`);
            candidate.close(1011, "app-server reinitialization failed");
            return;
          }
          initializeAcknowledged = true;
          if (initializedFrame) {
            candidate.send(initializedFrame.data, { binary: initializedFrame.isBinary });
          }
          upstreamReady = true;
          reconnecting = false;
          if (forwardReplayResponse && client.readyState === WebSocket.OPEN) {
            client.send(data, { binary: isBinary });
          }
          forwardReplayResponse = false;
          return;
        }
        if (initializeFrame && message?.id === initializeFrame.message.id && !message.error) {
          initializeAcknowledged = true;
        }
        if (message?.method) controller.handleNotification(message);
        if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
      });
      candidate.on("close", () => {
        if (candidate !== upstream || sessionClosed) return;
        upstreamReady = false;
        replayInitializeId = null;
        reconnecting = true;
        logger.warn("App-server websocket disconnected after connection");
        rpc.close("app-server disconnected");
        scheduleInitialReconnect();
      });
      candidate.on("error", (error) => {
        if (candidate !== upstream || sessionClosed) return;
        logger.error(`App-server websocket error: ${error.message}`);
        if (!upstreamReady) scheduleInitialReconnect();
      });
    };
    connectUpstream();

    client.on("message", (data, isBinary) => {
      const message = parseJson(data, isBinary, logger);
      if (message?.method === "initialize" && message.id !== undefined) {
        initializeFrame = { data, isBinary, message };
        initializeAcknowledged = false;
      } else if (message?.method === "initialized") {
        initializedFrame = { data, isBinary };
        if (upstreamReady && upstream?.readyState === WebSocket.OPEN) {
          upstream.send(data, { binary: isBinary });
        }
        return;
      }
      if (upstreamReady && upstream?.readyState === WebSocket.OPEN) {
        upstream.send(data, { binary: isBinary });
      } else if (message?.method !== "initialize" && message?.id !== undefined && client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({
          id: message.id,
          error: { code: -32000, message: "app-server is reconnecting; request was not sent" },
        }));
      } else if (message?.method !== "initialize") {
        logger.warn(`Dropped ${message?.method ?? "invalid"} while app-server was reconnecting`);
      }
    });

    client.on("close", () => closeSession(1000, "TUI disconnected"));
    client.on("error", (error) => {
      logger.error(`TUI websocket error: ${error.message}`);
      closeSession(1011, "TUI websocket error");
    });
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      httpServer.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      httpServer.off("error", onError);
      resolve();
    };
    httpServer.once("error", onError);
    httpServer.once("listening", onListening);
    httpServer.listen(listenPort, listenHost);
  });

  const address = httpServer.address();
  const url = `ws://${listenHost}:${address.port}`;
  logger.info(`Watchdog proxy listening on ${url}`);
  httpServer.on("error", (error) => {
    logger.error(`Watchdog proxy server error: ${error.message}`);
  });

  return {
    server: httpServer,
    url,
    async close() {
      closing = true;
      activeSession?.close(1001, "watchdog proxy shutting down");
      for (const client of wss.clients) client.terminate();
      await new Promise((resolve) => wss.close(resolve));
      if (httpServer.listening) {
        await new Promise((resolve) => httpServer.close(resolve));
      }
    },
  };
}
