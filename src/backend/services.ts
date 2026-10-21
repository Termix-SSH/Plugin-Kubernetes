import type { Client } from "ssh2";
import type {
  PluginContext,
  PluginSshHost,
} from "@termix-ssh/plugin-sdk/backend";
import { readKubeHostSettings, targetOf } from "./host-settings.js";
import { isName, isNamespace, kubectl, type KubeTarget } from "./kubectl.js";
import { parseResourceList, type ResourceSummary } from "./resources.js";
import { ref } from "./routes.js";
import { execOnClient } from "./sessions.js";
import { getErrorMessage, type KubeLogger } from "./helpers.js";

const POOL = "kubernetes";
const TICK_MS = 15_000;
const POLL_INTERVAL_MS = 60_000;
const HOST_CACHE_MS = 5 * 60_000;

export interface KubePodSummary {
  namespace: string;
  name: string;
  status: string;
  ready: string;
  restarts: number;
  node: string | null;
}

export type KubeWorkloadKind = "deployments" | "statefulsets" | "daemonsets";

/** The "kubernetes.workloads" service, version 1. Runs as the caller's user. */
export interface KubeWorkloadsV1 {
  listPods: (
    hostId: number,
    options?: { namespace?: string },
  ) => Promise<KubePodSummary[]>;
  restart: (
    hostId: number,
    kind: KubeWorkloadKind,
    namespace: string,
    name: string,
  ) => Promise<void>;
  scale: (
    hostId: number,
    kind: "deployments" | "statefulsets",
    namespace: string,
    name: string,
    replicas: number,
  ) => Promise<void>;
}

export type KubePodEventName =
  "started" | "restarted" | "crashloop" | "failed" | "removed";

export interface KubePodEvent {
  hostId: number;
  namespace: string;
  pod: string;
  event: KubePodEventName;
}

/** The "kubernetes.events" service, version 1. Runs as the caller's user. */
export interface KubeEventsV1 {
  /**
   * Calls `listener` for pod state changes on a host, polled about once a
   * minute as the subscribing user. Subscribing the same listener again is a
   * no-op. Resolves to an unsubscribe function.
   */
  subscribe: (
    hostId: number,
    listener: (event: KubePodEvent) => void,
  ) => Promise<() => void>;
}

export interface PodState {
  status: string;
  restarts: number;
}

export function podStates(rows: ResourceSummary[]): Map<string, PodState> {
  return new Map(
    rows.map((row) => [
      `${row.namespace}/${row.name}`,
      { status: row.status, restarts: Number(row.fields.restarts) || 0 },
    ]),
  );
}

const FAILED = new Set([
  "Error",
  "Failed",
  "OOMKilled",
  "ImagePullBackOff",
  "ErrImagePull",
]);

/** What changed between two polls, one event per pod at most. */
export function diffPodStates(
  previous: Map<string, PodState>,
  current: Map<string, PodState>,
): { namespace: string; pod: string; event: KubePodEventName }[] {
  const out: { namespace: string; pod: string; event: KubePodEventName }[] = [];
  const split = (key: string) => {
    const [namespace = "", pod = ""] = key.split("/");
    return { namespace, pod };
  };
  for (const [key, now] of current) {
    const before = previous.get(key);
    let event: KubePodEventName | null = null;
    if (now.status === "CrashLoopBackOff" && before?.status !== now.status) {
      event = "crashloop";
    } else if (FAILED.has(now.status) && before?.status !== now.status) {
      event = "failed";
    } else if (before && now.restarts > before.restarts) {
      event = "restarted";
    } else if (now.status === "Running" && before?.status !== "Running") {
      event = "started";
    }
    if (event) out.push({ ...split(key), event });
  }
  for (const key of previous.keys()) {
    if (!current.has(key)) out.push({ ...split(key), event: "removed" });
  }
  return out;
}

function actorOf(ctx: PluginContext): string {
  const userId = ctx.currentActor();
  if (!userId) throw new Error("The kubernetes service needs a calling user");
  return userId;
}

export function registerServices(ctx: PluginContext, log: KubeLogger): void {
  const runOnHost = async (
    host: number | PluginSshHost,
    hostId: number,
    args: (target: KubeTarget) => string[],
    write = false,
  ): Promise<string> => {
    const settings = await readKubeHostSettings(ctx, hostId);
    if (!settings.enabled)
      throw new Error("Kubernetes is not enabled for this host");
    if (write && settings.readOnly) throw new Error("This host is read only");
    const target = targetOf(settings);
    return ctx.ssh.withConnection<string, Client>(
      host,
      { pool: POOL, purpose: "kubernetes", profile: "session" },
      (client) => execOnClient(client, kubectl(target, args(target))),
    );
  };

  const checkObject = (namespace: string, name: string) => {
    if (!isNamespace(namespace) || !isName(name)) {
      throw new Error("Invalid namespace or name");
    }
  };

  const listPods = async (
    host: number | PluginSshHost,
    hostId: number,
    namespace?: string,
  ) => {
    if (namespace !== undefined && !isNamespace(namespace)) {
      throw new Error("Invalid namespace");
    }
    const output = await runOnHost(host, hostId, () => [
      "get",
      "pods",
      ...(namespace ? ["-n", namespace] : ["-A"]),
      "-o",
      "json",
    ]);
    return parseResourceList("pods", output);
  };

  ctx.services.provide<KubeWorkloadsV1>("kubernetes.workloads", {
    listPods: async (hostId, options) => {
      actorOf(ctx);
      const rows = await listPods(hostId, hostId, options?.namespace);
      return rows.map((row) => ({
        namespace: row.namespace ?? "",
        name: row.name,
        status: row.status,
        ready: String(row.fields.ready ?? ""),
        restarts: Number(row.fields.restarts) || 0,
        node: (row.fields.node as string | null) ?? null,
      }));
    },
    restart: async (hostId, kind, namespace, name) => {
      actorOf(ctx);
      if (!["deployments", "statefulsets", "daemonsets"].includes(kind)) {
        throw new Error(`Cannot restart ${kind}`);
      }
      checkObject(namespace, name);
      await runOnHost(
        hostId,
        hostId,
        () => ["rollout", "restart", ref(kind, name), "-n", namespace],
        true,
      );
    },
    scale: async (hostId, kind, namespace, name, replicas) => {
      actorOf(ctx);
      if (kind !== "deployments" && kind !== "statefulsets") {
        throw new Error(`Cannot scale ${kind}`);
      }
      checkObject(namespace, name);
      if (!Number.isInteger(replicas) || replicas < 0 || replicas > 1000) {
        throw new Error("Replicas must be a whole number from 0 to 1000");
      }
      await runOnHost(
        hostId,
        hostId,
        () => [
          "scale",
          ref(kind, name),
          `--replicas=${replicas}`,
          "-n",
          namespace,
        ],
        true,
      );
    },
  });

  interface Watch {
    userId: string;
    hostId: number;
    listeners: Set<(event: KubePodEvent) => void>;
    snapshot?: Map<string, PodState>;
    host?: { value: PluginSshHost; at: number };
    lastPolledAt: number;
    failing: boolean;
  }
  const watches = new Map<string, Watch>();
  ctx.disposables.add(() => watches.clear());

  const hostFor = async (watch: Watch): Promise<PluginSshHost | null> => {
    if (watch.host && Date.now() - watch.host.at < HOST_CACHE_MS) {
      return watch.host.value;
    }
    const host = await ctx.asUser(watch.userId, () =>
      ctx.ssh.resolveHost(watch.hostId),
    );
    watch.host = host ? { value: host, at: Date.now() } : undefined;
    return host;
  };

  const pollOne = async (watch: Watch) => {
    try {
      const host = await hostFor(watch);
      if (!host) throw new Error("Host not found");
      const current = podStates(await listPods(host, watch.hostId));
      const previous = watch.snapshot;
      watch.snapshot = current;
      watch.failing = false;
      if (!previous) return;
      for (const change of diffPodStates(previous, current)) {
        for (const listener of [...watch.listeners]) {
          try {
            listener({ hostId: watch.hostId, ...change });
          } catch (error) {
            log.warn("Kubernetes event listener failed", {
              hostId: watch.hostId,
              error: getErrorMessage(error),
            });
          }
        }
      }
    } catch (error) {
      // A later success is a first observation again rather than a diff.
      watch.snapshot = undefined;
      watch.host = undefined;
      if (!watch.failing) {
        log.warn("Kubernetes event poll failed", {
          hostId: watch.hostId,
          error: getErrorMessage(error),
        });
      }
      watch.failing = true;
    }
  };

  ctx.schedule.every(TICK_MS, async () => {
    const now = Date.now();
    for (const watch of [...watches.values()]) {
      if (now - watch.lastPolledAt < POLL_INTERVAL_MS) continue;
      watch.lastPolledAt = now;
      await pollOne(watch);
    }
  });

  ctx.events.on("host.updated", (payload) => {
    const { hostId } = payload as { hostId?: number };
    if (!hostId) return;
    ctx.ssh.dropPooled(POOL, hostId);
    for (const watch of watches.values()) {
      if (watch.hostId === hostId) watch.host = undefined;
    }
  });
  ctx.events.on("host.deleted", (payload) => {
    const { hostId } = payload as { hostId?: number };
    if (!hostId) return;
    for (const [key, watch] of watches) {
      if (watch.hostId === hostId) watches.delete(key);
    }
  });

  ctx.services.provide<KubeEventsV1>("kubernetes.events", {
    subscribe: async (hostId, listener) => {
      const userId = actorOf(ctx);
      const key = `${userId}:${hostId}`;
      let watch = watches.get(key);
      if (!watch) {
        watch = {
          userId,
          hostId,
          listeners: new Set(),
          lastPolledAt: 0,
          failing: false,
        };
        watches.set(key, watch);
      }
      watch.listeners.add(listener);
      const current = watch;
      return () => {
        current.listeners.delete(listener);
        if (current.listeners.size === 0 && watches.get(key) === current) {
          watches.delete(key);
        }
      };
    },
  });
}
