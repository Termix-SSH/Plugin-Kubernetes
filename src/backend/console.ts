import { AsyncResource } from "node:async_hooks";
import { StringDecoder } from "node:string_decoder";
import type { Client, ClientChannel } from "ssh2";
import { WebSocket, type RawData } from "ws";
import type {
  PluginContext,
  PluginWebSocketConnection,
} from "@termix-ssh/plugin-sdk/backend";
import { readKubeHostSettings, targetOf } from "./host-settings.js";
import {
  CONTAINER_RE,
  SHELLS,
  isContext,
  isName,
  isNamespace,
  kubectl,
} from "./kubectl.js";
import {
  HOST_ADDRESS_MISMATCH_MESSAGE,
  HOST_NOT_ON_THIS_SERVER_MESSAGE,
  asObject,
  asString,
  getErrorMessage,
  hostAddressMismatch,
  parseWsMessage,
  toTerminalDimension,
  type KubeLogger,
} from "./helpers.js";

const PING_MS = 30_000;

interface ConsoleSession {
  client: Client;
  dispose: () => void;
  stream: ClientChannel | null;
}

/** Tries the requested shell first, then the usual ones, inside the container. */
export function shellScript(requested?: string): string {
  const order = [...new Set([requested, "bash", "ash", "sh"].filter(Boolean))];
  return `for s in ${order.join(" ")}; do if command -v "$s" >/dev/null 2>&1; then exec "$s"; fi; done; exec sh`;
}

/**
 * The pod console at /plugin-ws/kubernetes/console.
 *
 * Public with optionalAuth: core still resolves the caller's token, and the
 * handler refuses a socket without a user or without kubernetes.use. Every live
 * console is closed when the plugin deactivates.
 */
export function registerConsole(ctx: PluginContext, log: KubeLogger): void {
  const live = new Set<() => void>();
  ctx.disposables.add(() => {
    for (const end of [...live]) end();
    live.clear();
  });

  const onConnection = async (connection: PluginWebSocketConnection) => {
    const ws = connection.socket as WebSocket;
    const userId = connection.userId;
    if (!userId || !(await ctx.rbac.hasFor(userId, "use"))) {
      ws.close(1008, "Authentication required");
      return;
    }

    let session: ConsoleSession | null = null;
    // Bumped by every connect and disconnect, so a slow connect that lost
    // the race drops its client instead of leaking it.
    let attempt = 0;
    const send = (message: Record<string, unknown>) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
    };

    const endSession = () => {
      if (!session) return;
      const current = session;
      session = null;
      current.stream?.end();
      current.dispose();
    };

    const pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, PING_MS);

    const cleanup = () => {
      attempt++;
      clearInterval(pingTimer);
      endSession();
      live.delete(shutdown);
    };
    const shutdown = () => {
      cleanup();
      try {
        ws.close(1001, "Kubernetes plugin disabled");
      } catch {
        // already closed
      }
    };
    live.add(shutdown);

    const connect = async (data: unknown) => {
      const myAttempt = ++attempt;
      if (!connection.isDataUnlocked()) {
        send({
          type: "error",
          message: "Session expired - please log in again",
        });
        return;
      }
      const payload = asObject(data);
      const hostConfig = asObject(payload.hostConfig);
      const hostId = Number(hostConfig.id);
      const syncId =
        typeof hostConfig.syncId === "string" ? hostConfig.syncId : null;
      const namespace = asString(payload.namespace);
      const pod = asString(payload.pod);
      const container = asString(payload.container) || undefined;
      const context = asString(payload.context) || undefined;
      const shell = asString(payload.shell) || undefined;
      const cols = toTerminalDimension(payload.cols) || 80;
      const rows = toTerminalDimension(payload.rows) || 24;

      if (!hostId || !namespace || !pod) {
        send({
          type: "error",
          message: "Host configuration, namespace and pod are required",
        });
        return;
      }
      if (
        !isNamespace(namespace) ||
        !isName(pod) ||
        (container && !CONTAINER_RE.test(container)) ||
        (context && !isContext(context))
      ) {
        send({ type: "error", message: "Invalid pod, container or context" });
        return;
      }
      if (shell && !(SHELLS as readonly string[]).includes(shell)) {
        send({ type: "error", message: "Invalid shell" });
        return;
      }

      endSession();

      try {
        // syncId names the host on both sides of a sync pair; the numeric
        // id only names it in the database the client is displaying.
        const host = await ctx.ssh.resolveHost(hostId, { syncId });
        if (!host) {
          send({
            type: "error",
            message: syncId
              ? HOST_NOT_ON_THIS_SERVER_MESSAGE
              : "Host not found",
          });
          return;
        }
        if (!syncId && hostAddressMismatch(hostConfig.ip, host.ip)) {
          log.error("Refusing Kubernetes console: host id resolves elsewhere", {
            hostId,
            userId,
          });
          send({ type: "error", message: HOST_ADDRESS_MISMATCH_MESSAGE });
          return;
        }

        const settings = await readKubeHostSettings(ctx, host.id);
        if (!settings.enabled) {
          send({
            type: "error",
            message:
              "Kubernetes is not enabled for this host. Enable it in Host Settings.",
          });
          return;
        }
        if (settings.readOnly) {
          send({
            type: "error",
            message: "This host is read only, so the pod shell is off.",
          });
          return;
        }

        const { client, dispose } = await ctx.ssh.connect<Client>(host, {
          purpose: "kubernetes-console",
          profile: "stream",
          timeoutMs: 65_000,
        });
        if (ws.readyState !== WebSocket.OPEN || myAttempt !== attempt) {
          dispose();
          return;
        }
        const current: ConsoleSession = { client, dispose, stream: null };
        session = current;

        client.exec(
          kubectl(targetOf(settings, context), [
            "exec",
            "-i",
            "-t",
            "-n",
            namespace,
            pod,
            ...(container ? ["-c", container] : []),
            "--",
            "sh",
            "-c",
            shellScript(shell),
          ]),
          { pty: { term: "xterm-256color", cols, rows } },
          (err, stream) => {
            if (err) {
              send({
                type: "error",
                message: `Failed to start console: ${err.message}`,
              });
              return;
            }
            if (session !== current) {
              stream.end();
              return;
            }
            current.stream = stream;

            // Buffers split multi-byte UTF-8 sequences across chunks.
            const decoder = new StringDecoder("utf-8");
            stream.on("data", (chunk: Buffer) => {
              const text = decoder.write(chunk);
              if (text) send({ type: "output", data: text });
            });
            stream.stderr.on("data", () => {});
            stream.stderr.on("error", () => {});
            stream.on("error", (streamErr: Error) => {
              send({
                type: "error",
                message: `Console error: ${streamErr.message}`,
              });
            });
            stream.on("close", () => {
              send({ type: "disconnected", message: "Console session ended" });
              if (session === current) endSession();
            });

            void ctx.audit.record({
              action: "kubernetes_exec",
              resourceType: "host",
              resourceId: String(host.id),
              details: JSON.stringify({ namespace, pod, container, context }),
              success: true,
            });
            send({ type: "connected", data: { pod, container } });
          },
        );
      } catch (error) {
        log.error("Failed to connect to pod", error, {
          hostId,
          namespace,
          pod,
        });
        send({
          type: "error",
          message: getErrorMessage(error, "Failed to connect to pod"),
        });
      }
    };

    ws.on(
      "message",
      AsyncResource.bind(async (raw: RawData) => {
        let type: string;
        let data: unknown;
        try {
          ({ type, data } = parseWsMessage(raw));
        } catch (error) {
          send({ type: "error", message: getErrorMessage(error) });
          return;
        }

        switch (type) {
          case "connect":
            await connect(data);
            break;
          case "input": {
            const input = asString(data);
            if (input) session?.stream?.write(input);
            break;
          }
          case "resize": {
            const size = asObject(data);
            const cols = toTerminalDimension(size.cols);
            const rows = toTerminalDimension(size.rows);
            if (cols && rows)
              session?.stream?.setWindow(rows, cols, rows, cols);
            break;
          }
          case "disconnect":
            attempt++;
            if (session) {
              endSession();
              send({
                type: "disconnected",
                message: "Disconnected from pod",
              });
            }
            break;
          case "ping":
            send({ type: "pong" });
            break;
          default:
            log.warn("Unknown kubernetes console message", { type });
        }
      }),
    );

    ws.on("close", cleanup);
    ws.on("error", (error: Error) => {
      log.error("Kubernetes console socket error", error);
      cleanup();
    });
  };

  ctx.ws.route("/console", onConnection, { public: true, optionalAuth: true });
}
