import { randomBytes } from "node:crypto";
import type { Request, Response, Router } from "express";
import {
  isName,
  isNamespace,
  kubectl,
  shellQuote,
  type KubeTarget,
} from "./kubectl.js";
import type { Deps, RouteKit } from "./route-kit.js";
import type { KubeSession } from "./sessions.js";

const REQUEST_TIMEOUT = "--request-timeout=30s";

type Obj = Record<string, unknown>;

const text = (value: unknown) => (typeof value === "string" ? value : "");
const obj = (value: unknown): Obj =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Obj)
    : {};

function items(output: string): Obj[] {
  const trimmed = output.trim();
  if (!trimmed) return [];
  const parsed = obj(JSON.parse(trimmed));
  return Array.isArray(parsed.items) ? (parsed.items as Obj[]) : [];
}

export interface CrdSummary {
  /** plural.group, which kubectl takes as the resource. */
  name: string;
  group: string;
  kind: string;
  plural: string;
  namespaced: boolean;
  versions: string[];
}

export interface CustomRow {
  name: string;
  namespace: string | null;
  status: string;
  tone: "ok" | "warn" | "error" | "idle";
  created: string;
}

export function parseCrds(output: string): CrdSummary[] {
  return items(output)
    .map((item) => {
      const spec = obj(item.spec);
      const names = obj(spec.names);
      const versions = Array.isArray(spec.versions)
        ? (spec.versions as Obj[])
            .filter((v) => v.served !== false)
            .map((v) => text(v.name))
        : [];
      return {
        name: text(obj(item.metadata).name),
        group: text(spec.group),
        kind: text(names.kind),
        plural: text(names.plural),
        namespaced: spec.scope !== "Cluster",
        versions,
      };
    })
    .filter((crd) => crd.name)
    .sort((a, b) => a.kind.localeCompare(b.kind));
}

/** The Ready condition when there is one, else status.phase or state. */
export function customStatus(item: Obj): Pick<CustomRow, "status" | "tone"> {
  const status = obj(item.status);
  const conditions = Array.isArray(status.conditions)
    ? (status.conditions as Obj[])
    : [];
  const ready =
    conditions.find((c) => c.type === "Ready") ??
    conditions.find((c) => c.type === "Available");
  if (ready) {
    const ok = ready.status === "True";
    return {
      status: ok ? text(ready.type) : text(ready.reason) || "Not ready",
      tone: ok ? "ok" : ready.status === "False" ? "error" : "warn",
    };
  }
  const phase = text(status.phase) || text(status.state);
  if (!phase) return { status: "", tone: "idle" };
  const lower = phase.toLowerCase();
  const tone = /fail|error|degraded/.test(lower)
    ? "error"
    : /pending|progress|unknown/.test(lower)
      ? "warn"
      : "ok";
  return { status: phase, tone };
}

export function parseCustomList(output: string): CustomRow[] {
  return items(output).map((item) => {
    const meta = obj(item.metadata);
    return {
      name: text(meta.name),
      namespace: text(meta.namespace) || null,
      created: text(meta.creationTimestamp),
      ...customStatus(item),
    };
  });
}

/** Kinds a port forward can point at. */
export const FORWARD_KINDS = {
  pods: "pod",
  services: "svc",
  deployments: "deployment",
} as const;
export type ForwardKind = keyof typeof FORWARD_KINDS;

export const FORWARD_ADDRESSES = ["127.0.0.1", "0.0.0.0"] as const;

export interface ForwardSpec {
  kind: ForwardKind;
  name: string;
  namespace: string;
  localPort: number;
  remotePort: number;
  address: (typeof FORWARD_ADDRESSES)[number];
}

export interface ForwardRow extends ForwardSpec {
  id: string;
  running: boolean;
  context?: string;
  created: string;
  /** Last line kubectl printed, which says why a dead one stopped. */
  lastLine: string;
}

const FORWARD_DIR = '"$HOME/.cache/termix-k8s-forwards"';
export const FORWARD_ID_RE = /^[a-f0-9]{12}$/;

function port(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

/** The spec, or why it is not valid. */
export function readForwardSpec(body: unknown): ForwardSpec | string {
  const input = obj(body);
  if (!Object.hasOwn(FORWARD_KINDS, text(input.kind))) {
    return "Pick a pod, service or deployment";
  }
  if (!isName(input.name)) return "Invalid name";
  if (!isNamespace(input.namespace)) return "Invalid namespace";
  const localPort = port(input.localPort);
  const remotePort = port(input.remotePort);
  if (!localPort || !remotePort) return "Ports must be from 1 to 65535";
  const address = text(input.address) || "127.0.0.1";
  if (!(FORWARD_ADDRESSES as readonly string[]).includes(address)) {
    return "Invalid address";
  }
  return {
    kind: input.kind as ForwardKind,
    name: input.name as string,
    namespace: input.namespace as string,
    localPort,
    remotePort,
    address: address as ForwardSpec["address"],
  };
}

/**
 * Starts kubectl port-forward in the background on the host, so it outlives
 * the SSH session, and fails when it exits within a second.
 */
export function startForwardScript(
  target: KubeTarget,
  spec: ForwardSpec,
  id: string,
  now = new Date(),
): string {
  const command = kubectl(target, [
    "port-forward",
    "-n",
    spec.namespace,
    "--address",
    spec.address,
    `${FORWARD_KINDS[spec.kind]}/${spec.name}`,
    `${spec.localPort}:${spec.remotePort}`,
  ]);
  const meta = JSON.stringify({
    ...spec,
    context: target.context,
    created: now.toISOString(),
  });
  return [
    `D=${FORWARD_DIR}`,
    'mkdir -p "$D" && chmod 700 "$D"',
    // env, since nohup cannot run a PATH=... prefix itself.
    `nohup env ${command} >"$D/${id}.log" 2>&1 </dev/null &`,
    "PID=$!",
    `echo "$PID" >"$D/${id}.pid"`,
    `printf '%s' ${shellQuote(meta)} >"$D/${id}.json"`,
    "sleep 1",
    'if kill -0 "$PID" 2>/dev/null; then echo STARTED; else ' +
      `cat "$D/${id}.log" >&2; rm -f "$D/${id}".*; exit 1; fi`,
  ].join("\n");
}

export function listForwardsScript(): string {
  return [
    `D=${FORWARD_DIR}`,
    'for f in "$D"/*.json; do',
    '  [ -e "$f" ] || continue',
    '  id=$(basename "$f" .json)',
    '  pid=$(cat "$D/$id.pid" 2>/dev/null)',
    '  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then up=1; else up=0; fi',
    `  last=$(tail -n 1 "$D/$id.log" 2>/dev/null | tr '\\t\\r' '  ')`,
    `  printf '%s\\t%s\\t%s\\t' "$id" "$up" "$last"`,
    '  cat "$f"',
    "  echo",
    "done",
  ].join("\n");
}

export function stopForwardScript(id: string): string {
  if (!FORWARD_ID_RE.test(id)) throw new Error("Invalid forward id");
  return [
    `D=${FORWARD_DIR}`,
    `pid=$(cat "$D/${id}.pid" 2>/dev/null)`,
    '[ -n "$pid" ] && kill "$pid" 2>/dev/null',
    `rm -f "$D/${id}.pid" "$D/${id}.json" "$D/${id}.log"`,
    "echo STOPPED",
  ].join("\n");
}

export function parseForwards(output: string): ForwardRow[] {
  const rows: ForwardRow[] = [];
  for (const line of output.split(/\r?\n/)) {
    const [id, up, last, ...rest] = line.split("\t");
    if (!id || !FORWARD_ID_RE.test(id)) continue;
    try {
      const meta = obj(JSON.parse(rest.join("\t")));
      const spec = readForwardSpec(meta);
      if (typeof spec === "string") continue;
      rows.push({
        ...spec,
        id,
        running: up === "1",
        context: text(meta.context) || undefined,
        created: text(meta.created),
        lastLine: (last ?? "").trim(),
      });
    } catch {
      // A file someone else wrote; skip it.
    }
  }
  return rows.sort((a, b) => a.created.localeCompare(b.created));
}

export function registerCustom(
  router: Router,
  { sessions }: Deps,
  kit: RouteKit,
) {
  const { sessionOf, targetFor, namespaceFor, writable, audit, fail } = kit;

  const run = (session: KubeSession, target: KubeTarget, args: string[]) =>
    sessions.run(session, () => sessions.exec(session, kubectl(target, args)));

  const shell = (session: KubeSession, script: string) =>
    sessions.run(session, () =>
      sessions.exec(session, "bash -s", { input: `${script}\n` }),
    );

  const crdOf = (req: Request, res: Response): string | null => {
    const crd = req.query.crd ?? req.body?.crd;
    if (!isName(crd) || !String(crd).includes(".")) {
      res.status(400).json({ error: "Invalid custom resource type" });
      return null;
    }
    return String(crd);
  };

  /**
   * @openapi
   * /plugin-api/kubernetes/crds/{sessionId}:
   *   get:
   *     summary: List custom resource definitions
   *     description: Every CRD in the cluster, with its kind, group and scope.
   *     tags:
   *       - Kubernetes
   *     parameters:
   *       - in: path
   *         name: sessionId
   *         required: true
   *         schema:
   *           type: string
   *       - in: query
   *         name: context
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: A list of CRDs.
   *       400:
   *         description: SSH session not found or not connected.
   */
  router.get("/crds/:sessionId", async (req, res) => {
    const session = sessionOf(req, res);
    if (!session) return;
    const target = targetFor(req, res, session);
    if (!target) return;
    try {
      const output = await run(session, target, [
        "get",
        "customresourcedefinitions.apiextensions.k8s.io",
        "-o",
        "json",
        REQUEST_TIMEOUT,
      ]);
      res.json(parseCrds(output));
    } catch (error) {
      fail(res, session, error, "list custom resource definitions");
    }
  });

  /**
   * @openapi
   * /plugin-api/kubernetes/custom/{sessionId}:
   *   get:
   *     summary: List custom resources
   *     description: Objects of one custom resource type, in a namespace or all of them.
   *     tags:
   *       - Kubernetes
   *     parameters:
   *       - in: path
   *         name: sessionId
   *         required: true
   *         schema:
   *           type: string
   *       - in: query
   *         name: crd
   *         required: true
   *         schema:
   *           type: string
   *       - in: query
   *         name: namespace
   *         schema:
   *           type: string
   *       - in: query
   *         name: namespaced
   *         schema:
   *           type: boolean
   *     responses:
   *       200:
   *         description: The objects.
   *       400:
   *         description: Bad type or namespace, or no session.
   */
  router.get("/custom/:sessionId", async (req, res) => {
    const session = sessionOf(req, res);
    if (!session) return;
    const target = targetFor(req, res, session);
    if (!target) return;
    const crd = crdOf(req, res);
    if (!crd) return;
    const namespace = namespaceFor(req, res);
    if (namespace === undefined) return;
    const scoped = req.query.namespaced !== "false";
    const ns = !scoped ? [] : namespace ? ["-n", namespace] : ["-A"];
    try {
      const output = await run(session, target, [
        "get",
        crd,
        ...ns,
        "-o",
        "json",
        REQUEST_TIMEOUT,
      ]);
      res.json(parseCustomList(output));
    } catch (error) {
      fail(res, session, error, `list ${crd}`);
    }
  });

  const objectArgs = (req: Request, res: Response) => {
    const crd = crdOf(req, res);
    if (!crd) return null;
    const name = req.query.name ?? req.body?.name;
    if (!isName(name)) {
      res.status(400).json({ error: "Invalid name" });
      return null;
    }
    const namespace = req.query.namespace ?? req.body?.namespace;
    if (
      namespace !== undefined &&
      namespace !== "" &&
      !isNamespace(namespace)
    ) {
      res.status(400).json({ error: "Invalid namespace" });
      return null;
    }
    const ns = namespace ? ["-n", String(namespace)] : [];
    return { crd, name: String(name), namespace: namespace || null, ns };
  };

  /**
   * @openapi
   * /plugin-api/kubernetes/custom/{sessionId}/yaml:
   *   get:
   *     summary: Get a custom resource as YAML
   *     tags:
   *       - Kubernetes
   *     parameters:
   *       - in: path
   *         name: sessionId
   *         required: true
   *         schema:
   *           type: string
   *       - in: query
   *         name: crd
   *         required: true
   *         schema:
   *           type: string
   *       - in: query
   *         name: name
   *         required: true
   *         schema:
   *           type: string
   *       - in: query
   *         name: namespace
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: The YAML.
   *       404:
   *         description: Not found.
   */
  router.get("/custom/:sessionId/yaml", async (req, res) => {
    const session = sessionOf(req, res);
    if (!session) return;
    const target = targetFor(req, res, session);
    if (!target) return;
    const object = objectArgs(req, res);
    if (!object) return;
    try {
      const yaml = await run(session, target, [
        "get",
        object.crd,
        object.name,
        ...object.ns,
        "-o",
        "yaml",
        REQUEST_TIMEOUT,
      ]);
      res.json({ yaml });
    } catch (error) {
      fail(res, session, error, `get ${object.crd}`);
    }
  });

  /**
   * @openapi
   * /plugin-api/kubernetes/custom/{sessionId}:
   *   delete:
   *     summary: Delete a custom resource
   *     description: Needs edit access to the host and a host that is not read only.
   *     tags:
   *       - Kubernetes
   *     parameters:
   *       - in: path
   *         name: sessionId
   *         required: true
   *         schema:
   *           type: string
   *       - in: query
   *         name: crd
   *         required: true
   *         schema:
   *           type: string
   *       - in: query
   *         name: name
   *         required: true
   *         schema:
   *           type: string
   *       - in: query
   *         name: namespace
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: Deleted.
   *       403:
   *         description: No edit access, or the host is read only.
   */
  router.delete("/custom/:sessionId", kit.requireEdit, async (req, res) => {
    const session = sessionOf(req, res);
    if (!session) return;
    if (!writable(session, res)) return;
    const target = targetFor(req, res, session);
    if (!target) return;
    const object = objectArgs(req, res);
    if (!object) return;
    const details = {
      kind: object.crd,
      name: object.name,
      namespace: object.namespace,
      context: target.context,
    };
    try {
      const output = await run(session, target, [
        "delete",
        object.crd,
        object.name,
        ...object.ns,
        "--wait=false",
      ]);
      audit(req, session, "delete", details);
      res.json({ success: true, output: output.trim() });
    } catch (error) {
      audit(req, session, "delete", details, error);
      fail(res, session, error, `delete ${object.crd}`);
    }
  });

  /**
   * @openapi
   * /plugin-api/kubernetes/forwards/{sessionId}:
   *   get:
   *     summary: List port forwards
   *     description: Port forwards Termix started on this host, and whether each still runs.
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
   *         description: The forwards.
   */
  router.get("/forwards/:sessionId", async (req, res) => {
    const session = sessionOf(req, res);
    if (!session) return;
    try {
      res.json(parseForwards(await shell(session, listForwardsScript())));
    } catch (error) {
      fail(res, session, error, "list port forwards");
    }
  });

  /**
   * @openapi
   * /plugin-api/kubernetes/forwards/{sessionId}:
   *   post:
   *     summary: Start a port forward
   *     description: Runs kubectl port-forward in the background on the host. It keeps running after you close Termix, until you stop it or the pod goes away.
   *     tags:
   *       - Kubernetes
   *     parameters:
   *       - in: path
   *         name: sessionId
   *         required: true
   *         schema:
   *           type: string
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [kind, name, namespace, localPort, remotePort]
   *             properties:
   *               kind:
   *                 type: string
   *                 enum: [pods, services, deployments]
   *               name:
   *                 type: string
   *               namespace:
   *                 type: string
   *               localPort:
   *                 type: integer
   *               remotePort:
   *                 type: integer
   *               address:
   *                 type: string
   *                 enum: ["127.0.0.1", "0.0.0.0"]
   *               context:
   *                 type: string
   *     responses:
   *       200:
   *         description: Started.
   *       400:
   *         description: Bad input, or kubectl stopped right away.
   *       403:
   *         description: No edit access, or the host is read only.
   */
  router.post("/forwards/:sessionId", kit.requireEdit, async (req, res) => {
    const session = sessionOf(req, res);
    if (!session) return;
    if (!writable(session, res)) return;
    const target = targetFor(req, res, session);
    if (!target) return;
    const spec = readForwardSpec(req.body);
    if (typeof spec === "string") {
      return res.status(400).json({ error: spec });
    }
    const id = randomBytes(6).toString("hex");
    const details = { ...spec, context: target.context };
    try {
      await shell(session, startForwardScript(target, spec, id));
      audit(req, session, "port_forward", details);
      res.json({ success: true, id });
    } catch (error) {
      audit(req, session, "port_forward", details, error);
      const message = error instanceof Error ? error.message : "";
      // kubectl's own reason, like a port already in use.
      res.status(400).json({
        error: message.trim() || "kubectl port-forward stopped right away",
      });
    }
  });

  /**
   * @openapi
   * /plugin-api/kubernetes/forwards/{sessionId}/{id}:
   *   delete:
   *     summary: Stop a port forward
   *     tags:
   *       - Kubernetes
   *     parameters:
   *       - in: path
   *         name: sessionId
   *         required: true
   *         schema:
   *           type: string
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: Stopped.
   *       400:
   *         description: Bad id.
   */
  router.delete(
    "/forwards/:sessionId/:id",
    kit.requireEdit,
    async (req, res) => {
      const session = sessionOf(req, res);
      if (!session) return;
      const id = String(req.params.id);
      if (!FORWARD_ID_RE.test(id)) {
        return res.status(400).json({ error: "Invalid forward id" });
      }
      try {
        await shell(session, stopForwardScript(id));
        audit(req, session, "port_forward_stop", { id });
        res.json({ success: true });
      } catch (error) {
        fail(res, session, error, "stop the port forward");
      }
    },
  );
}
