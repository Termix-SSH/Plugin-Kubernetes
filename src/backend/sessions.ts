import type { Client } from "ssh2";
import type { PluginSchedule } from "@termix-ssh/plugin-sdk/backend";
import type { KubeHostSettings } from "./host-settings.js";
import type { KubeLogger } from "./helpers.js";

const SESSION_IDLE_MS = 60 * 60 * 1000;
const PENDING_SWEEP_MS = 60 * 1000;

/** A live SSH connection behind the Kubernetes panel, owned by one user. */
export interface KubeSession {
  id: string;
  client: Client;
  dispose: () => void;
  hostId: number;
  userId: string;
  settings: KubeHostSettings;
  lastActive: number;
  activeOperations: number;
  cancelIdle?: () => void;
}

/** A connect still waiting on a person (TOTP, a browser sign-in). */
interface PendingEntry {
  userId: string;
  hostId: number;
  expiresAt: number;
  /** Gives up: answers the open prompt with nothing. */
  cancel: () => void;
}

export interface KubeSessions {
  add: (session: KubeSession) => void;
  /** The session when `userId` owns it. */
  get: (id: string, userId: string) => KubeSession | undefined;
  close: (id: string) => void;
  touch: (session: KubeSession) => void;
  /** Runs `fn` with the session marked busy, so idle cleanup waits. */
  run: <T>(session: KubeSession, fn: () => Promise<T>) => Promise<T>;
  exec: (
    session: KubeSession,
    command: string,
    options?: RunOptions,
  ) => Promise<string>;
  setPending: (id: string, entry: PendingEntry) => void;
  getPending: (id: string) => PendingEntry | undefined;
  clearPending: (id: string) => void;
  closeAll: () => void;
}

export interface RunOptions {
  /** Written to stdin, then stdin is closed. */
  input?: string;
  /** Exit codes that still count as success (kubectl diff exits 1 on changes). */
  okCodes?: number[];
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;

/** Runs one command and resolves stdout, rejecting on a failing exit. */
export function execOnClient(
  client: Client,
  command: string,
  options: RunOptions = {},
): Promise<string> {
  const okCodes = options.okCodes ?? [0];
  return new Promise((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err) return reject(err);
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        stream.close();
        reject(new Error("Command timed out"));
      }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      stream.on("close", (code: number) => {
        clearTimeout(timer);
        if (code !== null && code !== undefined && !okCodes.includes(code)) {
          reject(
            new Error(stderr.trim() || `Command exited with code ${code}`),
          );
        } else {
          resolve(stdout);
        }
      });
      stream.on("data", (data: Buffer) => {
        stdout += data.toString();
      });
      stream.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });
      stream.on("error", (streamErr: Error) => {
        clearTimeout(timer);
        reject(streamErr);
      });
      if (options.input !== undefined) {
        stream.write(options.input);
        stream.end();
      }
    });
  });
}

export function createKubeSessions(
  schedule: PluginSchedule,
  log: KubeLogger,
): KubeSessions {
  const sessions = new Map<string, KubeSession>();
  const pending = new Map<string, PendingEntry>();

  const end = (session: KubeSession) => {
    session.cancelIdle?.();
    sessions.delete(session.id);
    session.dispose();
  };

  const scheduleIdle = (session: KubeSession) => {
    session.cancelIdle?.();
    session.cancelIdle = schedule.after(SESSION_IDLE_MS, () => {
      if (sessions.get(session.id) !== session) return;
      if (session.activeOperations > 0) {
        scheduleIdle(session);
        return;
      }
      end(session);
    });
  };

  schedule.every(PENDING_SWEEP_MS, () => {
    const now = Date.now();
    for (const [id, entry] of pending) {
      if (now < entry.expiresAt) continue;
      pending.delete(id);
      entry.cancel();
    }
  });

  return {
    add: (session) => {
      const existing = sessions.get(session.id);
      if (existing) end(existing);
      sessions.set(session.id, session);
      session.client.once("close", () => {
        if (sessions.get(session.id) === session) {
          session.cancelIdle?.();
          sessions.delete(session.id);
        }
      });
      scheduleIdle(session);
    },

    get: (id, userId) => {
      const session = sessions.get(id);
      return session && session.userId === userId ? session : undefined;
    },

    close: (id) => {
      const session = sessions.get(id);
      if (session) end(session);
      const entry = pending.get(id);
      if (entry) {
        pending.delete(id);
        entry.cancel();
      }
    },

    touch: (session) => {
      session.lastActive = Date.now();
      scheduleIdle(session);
    },

    run: async (session, fn) => {
      session.lastActive = Date.now();
      session.activeOperations++;
      try {
        return await fn();
      } finally {
        session.activeOperations--;
      }
    },

    exec: async (session, command, options) => {
      const started = Date.now();
      try {
        return await execOnClient(session.client, command, options);
      } catch (error) {
        log.warn("Kubernetes command failed", {
          hostId: session.hostId,
          command: command.match(
            /(?:kubectl|oc|helm) (?:--\S+ )*'([a-z-]+)'/,
          )?.[1],
          durationMs: Date.now() - started,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },

    setPending: (id, entry) => {
      const existing = pending.get(id);
      if (existing) existing.cancel();
      pending.set(id, entry);
    },

    getPending: (id) => pending.get(id),

    clearPending: (id) => {
      pending.delete(id);
    },

    closeAll: () => {
      for (const session of [...sessions.values()]) end(session);
      for (const entry of pending.values()) entry.cancel();
      pending.clear();
    },
  };
}
