import type { Request, Response, Router } from "express";
import { kubectl } from "./kubectl.js";
import type { Deps, RouteKit } from "./route-kit.js";
import { getErrorMessage } from "./helpers.js";

export interface UsageRow {
  namespace?: string;
  name: string;
  /** CPU in millicores. */
  cpu: number | null;
  /** Memory in bytes. */
  memory: number | null;
  cpuPercent?: number | null;
  memoryPercent?: number | null;
}

const MEMORY_UNITS: Record<string, number> = {
  "": 1,
  k: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
};

/** "250m" or "2" to millicores. */
export function parseCpu(value: string): number | null {
  const match = value.match(/^(\d+(?:\.\d+)?)(m|n|u)?$/);
  if (!match) return null;
  const n = Number(match[1]);
  if (match[2] === "m") return n;
  if (match[2] === "u") return n / 1000;
  if (match[2] === "n") return n / 1_000_000;
  return n * 1000;
}

/** "128Mi" to bytes. */
export function parseMemory(value: string): number | null {
  const match = value.match(/^(\d+(?:\.\d+)?)(k|M|G|T|Ki|Mi|Gi|Ti)?$/);
  if (!match) return null;
  return Math.round(Number(match[1]) * MEMORY_UNITS[match[2] ?? ""]);
}

function percent(value: string | undefined): number | null {
  const match = value?.match(/^(\d+)%$/);
  return match ? Number(match[1]) : null;
}

function rows(output: string): string[][] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/));
}

/** `top pods --no-headers`, with or without the namespace column. */
export function parseTopPods(
  output: string,
  allNamespaces: boolean,
): UsageRow[] {
  return rows(output).map((cols) => {
    const [namespace, name, cpu, memory] = allNamespaces
      ? cols
      : [undefined, ...cols];
    return {
      ...(namespace ? { namespace } : {}),
      name: name ?? "",
      cpu: parseCpu(cpu ?? ""),
      memory: parseMemory(memory ?? ""),
    };
  });
}

/** `top nodes --no-headers`. */
export function parseTopNodes(output: string): UsageRow[] {
  return rows(output).map(([name, cpu, cpuPct, memory, memoryPct]) => ({
    name: name ?? "",
    cpu: parseCpu(cpu ?? ""),
    cpuPercent: percent(cpuPct),
    memory: parseMemory(memory ?? ""),
    memoryPercent: percent(memoryPct),
  }));
}

/** `top pod <name> --containers --no-headers`: POD NAME CPU MEMORY. */
export function parseTopContainers(output: string): UsageRow[] {
  return rows(output).map(([, name, cpu, memory]) => ({
    name: name ?? "",
    cpu: parseCpu(cpu ?? ""),
    memory: parseMemory(memory ?? ""),
  }));
}

export function metricsUnavailable(message: string): boolean {
  return /Metrics API not available|metrics not available|the server could not find the requested resource|metrics\.k8s\.io/i.test(
    message,
  );
}

export function registerMetrics(
  router: Router,
  { sessions }: Deps,
  kit: RouteKit,
) {
  const { sessionOf, targetFor, namespaceFor, fail } = kit;

  const top = async (
    req: Request,
    res: Response,
    args: (namespace: string | null) => string[] | null,
    parse: (output: string, namespace: string | null) => UsageRow[],
  ) => {
    const session = sessionOf(req, res);
    if (!session) return;
    const target = targetFor(req, res, session);
    if (!target) return;
    const namespace = namespaceFor(req, res);
    if (namespace === undefined) return;
    const list = args(namespace);
    if (!list) return;
    try {
      const output = await sessions.run(session, () =>
        sessions.exec(
          session,
          kubectl(target, ["top", ...list, "--no-headers"]),
        ),
      );
      res.json({ available: true, rows: parse(output, namespace) });
    } catch (error) {
      if (metricsUnavailable(getErrorMessage(error, ""))) {
        res.json({ available: false, rows: [] });
        return;
      }
      fail(res, session, error, "read metrics");
    }
  };

  /**
   * @openapi
   * /plugin-api/kubernetes/metrics/{sessionId}/pods:
   *   get:
   *     summary: Pod CPU and memory
   *     description: kubectl top pods for a namespace or every namespace. available is false when metrics-server is not installed.
   *     tags:
   *       - Kubernetes
   *     parameters:
   *       - in: path
   *         name: sessionId
   *         required: true
   *         schema:
   *           type: string
   *       - in: query
   *         name: namespace
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: Usage rows.
   */
  router.get("/metrics/:sessionId/pods", (req, res) =>
    top(
      req,
      res,
      (namespace) => ["pods", ...(namespace ? ["-n", namespace] : ["-A"])],
      (output, namespace) => parseTopPods(output, !namespace),
    ),
  );

  /**
   * @openapi
   * /plugin-api/kubernetes/metrics/{sessionId}/nodes:
   *   get:
   *     summary: Node CPU and memory
   *     description: kubectl top nodes. available is false when metrics-server is not installed.
   *     tags:
   *       - Kubernetes
   *     parameters:
   *       - in: path
   *         name: sessionId
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: Usage rows.
   */
  router.get("/metrics/:sessionId/nodes", (req, res) =>
    top(req, res, () => ["nodes"], parseTopNodes),
  );

  /**
   * @openapi
   * /plugin-api/kubernetes/metrics/{sessionId}/pods/{name}:
   *   get:
   *     summary: Container CPU and memory of a pod
   *     description: kubectl top pod with one row per container.
   *     tags:
   *       - Kubernetes
   *     parameters:
   *       - in: path
   *         name: sessionId
   *         required: true
   *         schema:
   *           type: string
   *       - in: path
   *         name: name
   *         required: true
   *         schema:
   *           type: string
   *       - in: query
   *         name: namespace
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: Usage rows.
   */
  router.get("/metrics/:sessionId/pods/:name", (req, res) =>
    top(
      req,
      res,
      (namespace) => {
        if (!namespace) {
          res.status(400).json({ error: "Namespace is required" });
          return null;
        }
        return [
          "pod",
          String(req.params.name),
          "-n",
          namespace,
          "--containers",
        ];
      },
      parseTopContainers,
    ),
  );
}
