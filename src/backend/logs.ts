import type { Router } from "express";
import {
  CONTAINER_RE,
  KINDS,
  SELECTOR_KINDS,
  kubectl,
  labelSelector,
  type KindId,
} from "./kubectl.js";
import { parseItems, selectorLabels } from "./resources.js";
import type { Deps, RouteKit } from "./route-kit.js";

const SINCE_RE = /^\d{1,5}[smh]$/;
const MAX_TAIL = 10_000;
const DEFAULT_TAIL = 200;
const MAX_LOG_REQUESTS = "--max-log-requests=10";

export interface LogOptions {
  container?: string;
  tail: number;
  timestamps: boolean;
  previous: boolean;
  since?: string;
}

/** Reads the log options from a query, or returns an error message. */
export function parseLogOptions(
  query: Record<string, unknown>,
): LogOptions | string {
  const options: LogOptions = {
    tail: DEFAULT_TAIL,
    timestamps: query.timestamps === "true",
    previous: query.previous === "true",
  };
  if (query.container !== undefined && query.container !== "") {
    if (
      typeof query.container !== "string" ||
      !CONTAINER_RE.test(query.container)
    ) {
      return "Invalid container name";
    }
    options.container = query.container;
  }
  if (query.tail !== undefined && query.tail !== "") {
    const tail = Number(query.tail);
    if (!Number.isInteger(tail) || tail < 1 || tail > MAX_TAIL) {
      return "Tail must be from 1 to 10000";
    }
    options.tail = tail;
  }
  if (query.since !== undefined && query.since !== "") {
    if (typeof query.since !== "string" || !SINCE_RE.test(query.since)) {
      return "Invalid since";
    }
    options.since = query.since;
  }
  return options;
}

export function logFlags(options: LogOptions): string[] {
  const flags = [`--tail=${options.tail}`];
  if (options.timestamps) flags.push("--timestamps");
  if (options.previous) flags.push("--previous");
  if (options.since) flags.push(`--since=${options.since}`);
  return flags;
}

export function registerLogs(
  router: Router,
  { sessions }: Deps,
  kit: RouteKit,
) {
  const { sessionOf, targetFor, namespaceFor, fail } = kit;

  /**
   * @openapi
   * /plugin-api/kubernetes/resources/{sessionId}/{kind}/{name}/logs:
   *   get:
   *     summary: Read logs
   *     description: Logs of a pod, or of every pod a workload selects with each line prefixed by its pod and container.
   *     tags:
   *       - Kubernetes
   *     parameters:
   *       - in: path
   *         name: sessionId
   *         required: true
   *         schema:
   *           type: string
   *       - in: path
   *         name: kind
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
   *       - in: query
   *         name: container
   *         schema:
   *           type: string
   *       - in: query
   *         name: tail
   *         schema:
   *           type: integer
   *       - in: query
   *         name: timestamps
   *         schema:
   *           type: boolean
   *       - in: query
   *         name: previous
   *         schema:
   *           type: boolean
   *       - in: query
   *         name: since
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: The log text.
   *       400:
   *         description: Bad options, or the kind has no logs.
   */
  router.get("/resources/:sessionId/:kind/:name/logs", async (req, res) => {
    const session = sessionOf(req, res);
    if (!session) return;
    const target = targetFor(req, res, session);
    if (!target) return;
    const namespace = namespaceFor(req, res);
    if (namespace === undefined) return;
    if (!namespace) {
      return res.status(400).json({ error: "Namespace is required" });
    }
    const kind = req.params.kind as KindId;
    const name = String(req.params.name);
    if (kind !== "pods" && !SELECTOR_KINDS.includes(kind)) {
      return res.status(400).json({ error: `${kind} have no logs` });
    }
    const options = parseLogOptions(req.query as Record<string, unknown>);
    if (typeof options === "string") {
      return res.status(400).json({ error: options });
    }
    const exec = (args: string[]) =>
      sessions.run(session, () =>
        sessions.exec(session, kubectl(target, args)),
      );

    try {
      if (kind === "pods") {
        const which = options.container
          ? ["-c", options.container]
          : ["--all-containers=true", "--prefix=true"];
        const logs = await exec([
          "logs",
          name,
          "-n",
          namespace,
          ...which,
          ...logFlags(options),
        ]);
        return res.json({ logs });
      }
      const json = await exec([
        "get",
        KINDS[kind].resource,
        name,
        "-n",
        namespace,
        "-o",
        "json",
      ]);
      const selector = labelSelector(
        selectorLabels(kind, parseItems(json)[0] ?? {}) as Record<
          string,
          unknown
        > | null,
      );
      if (!selector) return res.json({ logs: "" });
      const logs = await exec([
        "logs",
        "-n",
        namespace,
        "-l",
        selector,
        ...(options.container
          ? ["-c", options.container]
          : ["--all-containers=true"]),
        "--prefix=true",
        MAX_LOG_REQUESTS,
        ...logFlags(options),
      ]);
      res.json({ logs });
    } catch (error) {
      fail(res, session, error, "read logs");
    }
  });
}
