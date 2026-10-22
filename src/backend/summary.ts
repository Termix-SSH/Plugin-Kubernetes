import type { Client } from "ssh2";
import type { Request, Response, Router } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { getErrorMessage } from "./helpers.js";
import { readKubeHostSettings, targetOf } from "./host-settings.js";
import { kubectl } from "./kubectl.js";
import { parseResourceList, type ResourceSummary } from "./resources.js";
import { execOnClient } from "./sessions.js";

const POOL = "kubernetes";
const CACHE_MS = 60_000;
const TIMEOUT_MS = 30_000;
/** Clusters checked at once, so a big fleet does not open every connection together. */
export const SUMMARY_CONCURRENCY = 4;

export interface ClusterSummary {
  hostId: number;
  nodesReady: number;
  nodesTotal: number;
  podsRunning: number;
  podsFailing: number;
  podsTotal: number;
  error?: string;
  checkedAt: string;
}

/** Runs `fn` over `items`, at most `limit` at a time, keeping their order. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

/** Node and pod counts from parsed `get nodes` and `get pods -A` lists. */
export function summarizeCluster(
  nodes: ResourceSummary[],
  pods: ResourceSummary[],
): Omit<ClusterSummary, "hostId" | "checkedAt"> {
  return {
    nodesReady: nodes.filter((node) => node.status.startsWith("Ready")).length,
    nodesTotal: nodes.length,
    podsRunning: pods.filter((pod) => pod.status === "Running").length,
    podsFailing: pods.filter((pod) => pod.tone === "error").length,
    podsTotal: pods.length,
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("The cluster did not answer in time")),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * GET /summary: node and pod health for every host the caller can reach with
 * Kubernetes on. Read only, run as the caller over the pooled connection, a
 * few clusters at a time, and kept for a minute.
 */
export function registerSummary(router: Router, ctx: PluginContext): void {
  const cache = new Map<string, ClusterSummary>();

  const check = async (hostId: number): Promise<ClusterSummary> => {
    const checkedAt = new Date().toISOString();
    try {
      const target = targetOf(await readKubeHostSettings(ctx, hostId));
      const [nodes, pods] = await withTimeout(
        ctx.ssh.withConnection<[string, string], Client>(
          hostId,
          { pool: POOL, purpose: "kubernetes", profile: "session" },
          async (client) => [
            await execOnClient(
              client,
              kubectl(target, ["get", "nodes", "-o", "json"]),
            ),
            await execOnClient(
              client,
              kubectl(target, ["get", "pods", "-A", "-o", "json"]),
            ),
          ],
        ),
        TIMEOUT_MS,
      );
      return {
        hostId,
        checkedAt,
        ...summarizeCluster(
          parseResourceList("nodes", nodes),
          parseResourceList("pods", pods),
        ),
      };
    } catch (error) {
      return {
        hostId,
        checkedAt,
        nodesReady: 0,
        nodesTotal: 0,
        podsRunning: 0,
        podsFailing: 0,
        podsTotal: 0,
        error: getErrorMessage(error, "Could not reach the cluster"),
      };
    }
  };

  /**
   * @openapi
   * /plugin-api/kubernetes/summary:
   *   get:
   *     summary: Health of every cluster
   *     description: Ready nodes and running and failing pods for each host the caller can reach with Kubernetes turned on. Results are kept for a minute; refresh=1 checks again.
   *     tags:
   *       - Kubernetes
   *     parameters:
   *       - in: query
   *         name: refresh
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: One entry per host.
   */
  router.get("/summary", async (req: Request, res: Response) => {
    try {
      const user = String(ctx.currentActor() ?? "");
      const refresh = req.query.refresh === "1";
      const enabled: number[] = [];
      for (const host of await ctx.hosts.list()) {
        if ((await readKubeHostSettings(ctx, host.id)).enabled) {
          enabled.push(host.id);
        }
      }
      const now = Date.now();
      res.json(
        await mapLimit(enabled, SUMMARY_CONCURRENCY, async (hostId) => {
          const key = `${user}:${hostId}`;
          const cached = cache.get(key);
          if (
            !refresh &&
            cached &&
            now - Date.parse(cached.checkedAt) < CACHE_MS
          ) {
            return cached;
          }
          const fresh = await check(hostId);
          cache.set(key, fresh);
          return fresh;
        }),
      );
    } catch (error) {
      ctx.log.error(
        "Failed to build the Kubernetes summary",
        error instanceof Error ? error : undefined,
      );
      res.status(500).json({ error: "Failed to build the Kubernetes summary" });
    }
  });
}
