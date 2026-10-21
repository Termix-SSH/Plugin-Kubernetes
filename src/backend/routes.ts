import type { Request, Response, Router } from "express";
import type { PluginSshHost } from "@termix-ssh/plugin-sdk/backend";
import { answerConnect, startConnect } from "./connect.js";
import { readKubeHostSettings, targetOf } from "./host-settings.js";
import {
  CONTAINER_RE,
  IMAGE_RE,
  KINDS,
  SELECTOR_KINDS,
  flavorLabel,
  helm,
  isName,
  isNamespace,
  kubectl,
  labelSelector,
  namespaceArgs,
  type KindId,
  type KubeTarget,
} from "./kubectl.js";
import {
  configMapData,
  parseItems,
  parseResourceList,
  parseRolloutHistory,
  selectorLabels,
  summarize,
} from "./resources.js";
import { createRouteKit, type Deps } from "./route-kit.js";
import type { KubeSession } from "./sessions.js";
import {
  connectionLog,
  getErrorMessage,
  type ConnectionLogLine,
} from "./helpers.js";

const REQUEST_TIMEOUT = "--request-timeout=30s";
const MAX_REPLICAS = 1000;

const SCALE_KINDS: KindId[] = ["deployments", "statefulsets", "replicasets"];
const ROLLOUT_KINDS: KindId[] = ["deployments", "statefulsets", "daemonsets"];
const SUSPEND_KINDS: KindId[] = ["cronjobs", "jobs"];

export const ACTIONS = [
  "scale",
  "restart",
  "undo",
  "setImage",
  "suspend",
  "resume",
  "trigger",
  "cordon",
  "uncordon",
  "drain",
] as const;
export type ResourceAction = (typeof ACTIONS)[number];

/** Which kinds each action works on. */
export const ACTION_KINDS: Record<ResourceAction, KindId[]> = {
  scale: SCALE_KINDS,
  restart: ROLLOUT_KINDS,
  undo: ROLLOUT_KINDS,
  setImage: ROLLOUT_KINDS,
  suspend: SUSPEND_KINDS,
  resume: SUSPEND_KINDS,
  trigger: ["cronjobs"],
  cordon: ["nodes"],
  uncordon: ["nodes"],
  drain: ["nodes"],
};

/** `type/name` as kubectl's resource builder reads it. */
export function ref(kind: KindId, name: string): string {
  return `${KINDS[kind].resource}/${name}`;
}

/** A name for a job started by hand from a cronjob, within the 63 char limit. */
export function manualJobName(cronJob: string, now = Date.now()): string {
  const suffix = `-manual-${now.toString(36).slice(-6)}`;
  return `${cronJob.slice(0, 63 - suffix.length).replace(/[-.]+$/, "")}${suffix}`;
}

/** The kubectl arguments for an action, or an error message. */
export function actionArgs(
  kind: KindId,
  name: string,
  namespace: string | null,
  action: ResourceAction,
  body: Record<string, unknown>,
): string[] | string {
  if (!ACTION_KINDS[action].includes(kind)) {
    return `Action ${action} does not apply to ${kind}`;
  }
  const ns = KINDS[kind].namespaced && namespace ? ["-n", namespace] : [];
  switch (action) {
    case "scale": {
      const replicas = Number(body.replicas);
      if (
        !Number.isInteger(replicas) ||
        replicas < 0 ||
        replicas > MAX_REPLICAS
      ) {
        return "Replicas must be a whole number from 0 to 1000";
      }
      return ["scale", ref(kind, name), `--replicas=${replicas}`, ...ns];
    }
    case "restart":
      return ["rollout", "restart", ref(kind, name), ...ns];
    case "undo": {
      if (body.revision === undefined || body.revision === null) {
        return ["rollout", "undo", ref(kind, name), ...ns];
      }
      const revision = Number(body.revision);
      if (!Number.isInteger(revision) || revision < 1) {
        return "Invalid revision";
      }
      return [
        "rollout",
        "undo",
        ref(kind, name),
        `--to-revision=${revision}`,
        ...ns,
      ];
    }
    case "setImage": {
      const container = body.container;
      const image = body.image;
      if (typeof container !== "string" || !CONTAINER_RE.test(container)) {
        return "Invalid container name";
      }
      if (typeof image !== "string" || !IMAGE_RE.test(image)) {
        return "Invalid image";
      }
      return ["set", "image", ref(kind, name), `${container}=${image}`, ...ns];
    }
    case "suspend":
    case "resume":
      return [
        "patch",
        ref(kind, name),
        "--type=merge",
        "-p",
        JSON.stringify({ spec: { suspend: action === "suspend" } }),
        ...ns,
      ];
    case "trigger":
      return [
        "create",
        "job",
        manualJobName(name),
        `--from=cronjob/${name}`,
        ...ns,
      ];
    case "cordon":
    case "uncordon":
      return [action, name];
    case "drain": {
      const args = ["drain", name, "--ignore-daemonsets", "--timeout=120s"];
      if (body.deleteEmptyDirData === true) args.push("--delete-emptydir-data");
      if (body.force === true) args.push("--force");
      return args;
    }
  }
}

function validateCode(message: string): string {
  if (/command not found|not found|No such file/i.test(message))
    return "NOT_INSTALLED";
  if (/sudo:|password is required/i.test(message)) return "SUDO_REQUIRED";
  if (/permission denied/i.test(message)) return "PERMISSION_DENIED";
  if (/Unauthorized|must be logged in|credentials/i.test(message))
    return "UNAUTHORIZED";
  if (
    /Unable to connect|connection.*refused|i\/o timeout|no such host/i.test(
      message,
    )
  )
    return "CLUSTER_UNREACHABLE";
  return "KUBECTL_ERROR";
}

export function registerRoutes(router: Router, deps: Deps) {
  const { ctx, sessions, log } = deps;
  const kit = createRouteKit(deps);
  const { userOf, sessionOf, targetFor, namespaceFor, writable, audit, fail } =
    kit;

  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  router.use(ctx.rbac.require("use") as never);

  router.param("kind", (_req, res, next, value) => {
    if (!Object.hasOwn(KINDS, value)) {
      res.status(400).json({ error: "Unknown resource kind" });
      return;
    }
    next();
  });
  router.param("name", (_req, res, next, value) => {
    if (!isName(value)) {
      res.status(400).json({ error: "Invalid resource name" });
      return;
    }
    next();
  });

  const run = (
    session: KubeSession,
    target: KubeTarget,
    args: string[],
    options?: { input?: string; okCodes?: number[]; timeoutMs?: number },
  ) =>
    sessions.run(session, () =>
      sessions.exec(session, kubectl(target, args), options),
    );

  /** The path's kind, name and namespace, or null after replying. */
  const objectOf = (req: Request, res: Response) => {
    const kind = req.params.kind as KindId;
    const name = String(req.params.name);
    const namespace = namespaceFor(req, res);
    if (namespace === undefined) return null;
    if (KINDS[kind].namespaced && !namespace) {
      res.status(400).json({ error: "Namespace is required" });
      return null;
    }
    const ns = KINDS[kind].namespaced && namespace ? ["-n", namespace] : [];
    return { kind, name, namespace, ns };
  };

  /**
   * @openapi
   * /plugin-api/kubernetes/ssh/connect:
   *   post:
   *     summary: Establish SSH session for Kubernetes
   *     description: Opens an SSH session to a host for kubectl. When the host asks for a code, a browser sign-in or a password, the reply says so and the session waits for connect-totp or connect-browser-sign-in.
   *     tags:
   *       - Kubernetes
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - sessionId
   *               - hostId
   *             properties:
   *               sessionId:
   *                 type: string
   *               hostId:
   *                 type: integer
   *               userProvidedPassword:
   *                 type: string
   *               userProvidedSshKey:
   *                 type: string
   *               userProvidedKeyPassword:
   *                 type: string
   *     responses:
   *       200:
   *         description: Connected, or a prompt the user has to answer.
   *       400:
   *         description: Missing sessionId or hostId.
   *       403:
   *         description: Kubernetes is not enabled for this host, or the user lacks kubernetes.use.
   *       404:
   *         description: Host not found.
   *       500:
   *         description: SSH connection failed.
   */
  router.post("/ssh/connect", async (req, res) => {
    const userId = userOf(res);
    if (!userId) return;
    const {
      sessionId,
      hostId,
      userProvidedPassword,
      userProvidedSshKey,
      userProvidedKeyPassword,
    } = (req.body ?? {}) as Record<string, unknown>;
    const logs: ConnectionLogLine[] = [];

    if (typeof sessionId !== "string" || !sessionId || !hostId) {
      logs.push(
        connectionLog(
          "error",
          "kube_connecting",
          "Missing connection parameters",
        ),
      );
      return res
        .status(400)
        .json({ error: "Missing sessionId or hostId", connectionLogs: logs });
    }
    const numericHostId = Number(hostId);

    logs.push(
      connectionLog(
        "info",
        "kube_connecting",
        "Initiating Kubernetes SSH connection",
      ),
    );

    try {
      const host = await ctx.ssh.resolveHost(numericHostId);
      if (!host) {
        logs.push(connectionLog("error", "kube_connecting", "Host not found"));
        return res
          .status(404)
          .json({ error: "Host not found", connectionLogs: logs });
      }

      const settings = await readKubeHostSettings(ctx, numericHostId);
      if (!settings.enabled) {
        logs.push(
          connectionLog(
            "error",
            "kube_connecting",
            "Kubernetes is not enabled for this host",
          ),
        );
        return res.status(403).json({
          error:
            "Kubernetes is not enabled for this host. Enable it in Host Settings.",
          code: "KUBERNETES_DISABLED",
          connectionLogs: logs,
        });
      }

      sessions.close(sessionId);
      logs.push(
        connectionLog(
          "info",
          "kube_auth",
          "Resolving authentication credentials",
        ),
      );

      const hasAuthOverride = [
        userProvidedPassword,
        userProvidedSshKey,
        userProvidedKeyPassword,
      ].some((value) => typeof value === "string" && value.length > 0);
      // Core associates the redacted host object with its stored credentials.
      const target: PluginSshHost = hasAuthOverride ? { ...host } : host;
      if (typeof userProvidedPassword === "string" && userProvidedPassword) {
        target.password = userProvidedPassword;
        target.authType = "password";
      }
      if (typeof userProvidedSshKey === "string" && userProvidedSshKey) {
        target.key = userProvidedSshKey;
        target.authType = "key";
      }
      if (
        typeof userProvidedKeyPassword === "string" &&
        userProvidedKeyPassword
      ) {
        target.keyPassword = userProvidedKeyPassword;
      }

      const step = await startConnect(ctx, sessions, log, {
        sessionId,
        userId,
        host: target,
        settings,
        logs,
      });
      return res.status(step.status).json(step.body);
    } catch (error) {
      log.error("Kubernetes SSH connection error", error, {
        hostId: numericHostId,
        userId,
      });
      logs.push(
        connectionLog(
          "error",
          "kube_connecting",
          `Connection error: ${getErrorMessage(error)}`,
        ),
      );
      return res.status(500).json({
        success: false,
        message: getErrorMessage(error),
        connectionLogs: logs,
      });
    }
  });

  /**
   * @openapi
   * /plugin-api/kubernetes/ssh/connect-totp:
   *   post:
   *     summary: Answer a verification prompt
   *     description: Sends the code (or password) the host asked for and waits for the next step of the connect.
   *     tags:
   *       - Kubernetes
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - sessionId
   *               - totpCode
   *             properties:
   *               sessionId:
   *                 type: string
   *               totpCode:
   *                 type: string
   *     responses:
   *       200:
   *         description: Connected, or another prompt.
   *       400:
   *         description: Session ID and code required, or the session is not waiting for a code.
   *       404:
   *         description: The connect expired.
   *       408:
   *         description: The host did not answer in time.
   */
  router.post("/ssh/connect-totp", async (req, res) => {
    const userId = userOf(res);
    if (!userId) return;
    const { sessionId, totpCode } = (req.body ?? {}) as Record<string, unknown>;
    if (typeof sessionId !== "string" || typeof totpCode !== "string") {
      return res
        .status(400)
        .json({ error: "Session ID and TOTP code required" });
    }
    const step = await answerConnect(
      sessions,
      sessionId,
      userId,
      "totp",
      totpCode.trim(),
    );
    return res.status(step.status).json(step.body);
  });

  /**
   * @openapi
   * /plugin-api/kubernetes/ssh/connect-browser-sign-in:
   *   post:
   *     summary: Continue after a browser sign-in
   *     description: Continues a connect after the user finished signing in in the browser (an SSH gateway's approval, for example).
   *     tags:
   *       - Kubernetes
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - sessionId
   *             properties:
   *               sessionId:
   *                 type: string
   *     responses:
   *       200:
   *         description: Connected, or another prompt.
   *       400:
   *         description: Session ID required, or the session is not waiting for a browser sign-in.
   *       404:
   *         description: The connect expired.
   *       408:
   *         description: The host did not answer in time.
   */
  router.post("/ssh/connect-browser-sign-in", async (req, res) => {
    const userId = userOf(res);
    if (!userId) return;
    const { sessionId } = (req.body ?? {}) as Record<string, unknown>;
    if (typeof sessionId !== "string" || !sessionId) {
      return res.status(400).json({ error: "Session ID required" });
    }
    const step = await answerConnect(
      sessions,
      sessionId,
      userId,
      "browser",
      "",
    );
    return res.status(step.status).json(step.body);
  });

  /**
   * @openapi
   * /plugin-api/kubernetes/ssh/disconnect:
   *   post:
   *     summary: Disconnect SSH session
   *     description: Closes the caller's Kubernetes SSH session.
   *     tags:
   *       - Kubernetes
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               sessionId:
   *                 type: string
   *     responses:
   *       200:
   *         description: SSH session disconnected.
   *       400:
   *         description: Session ID is required.
   */
  router.post("/ssh/disconnect", (req, res) => {
    const userId = userOf(res);
    if (!userId) return;
    const { sessionId } = (req.body ?? {}) as Record<string, unknown>;
    if (typeof sessionId !== "string" || !sessionId) {
      return res.status(400).json({ error: "Session ID is required" });
    }
    const pending = sessions.getPending(sessionId);
    if (sessions.get(sessionId, userId) || pending?.userId === userId) {
      sessions.close(sessionId);
    }
    return res.json({ success: true, message: "SSH session disconnected" });
  });

  /**
   * @openapi
   * /plugin-api/kubernetes/ssh/keepalive:
   *   post:
   *     summary: Keep SSH session alive
   *     description: Resets the idle timeout of the caller's Kubernetes SSH session.
   *     tags:
   *       - Kubernetes
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               sessionId:
   *                 type: string
   *     responses:
   *       200:
   *         description: Session keepalive successful.
   *       400:
   *         description: Session ID is required or session not found.
   */
  router.post("/ssh/keepalive", (req, res) => {
    const userId = userOf(res);
    if (!userId) return;
    const { sessionId } = (req.body ?? {}) as Record<string, unknown>;
    if (typeof sessionId !== "string" || !sessionId) {
      return res.status(400).json({ error: "Session ID is required" });
    }
    const session = sessions.get(sessionId, userId);
    if (!session) {
      return res.status(400).json({
        error: "SSH session not found or not connected",
        connected: false,
      });
    }
    sessions.touch(session);
    return res.json({
      success: true,
      connected: true,
      lastActive: session.lastActive,
    });
  });

  /**
   * @openapi
   * /plugin-api/kubernetes/ssh/status:
   *   get:
   *     summary: Check SSH session status
   *     description: Whether the caller's Kubernetes SSH session is connected.
   *     tags:
   *       - Kubernetes
   *     parameters:
   *       - in: query
   *         name: sessionId
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: Session status.
   *       400:
   *         description: Session ID is required.
   */
  router.get("/ssh/status", (req, res) => {
    const userId = userOf(res);
    if (!userId) return;
    const sessionId = req.query.sessionId;
    if (typeof sessionId !== "string" || !sessionId) {
      return res.status(400).json({ error: "Session ID is required" });
    }
    return res.json({
      success: true,
      connected: !!sessions.get(sessionId, userId),
    });
  });

  /**
   * @openapi
   * /plugin-api/kubernetes/validate/{sessionId}:
   *   get:
   *     summary: Validate kubectl and the cluster
   *     description: Checks that kubectl is installed and the cluster answers, and reports helm and what the caller may do.
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
   *         description: Availability, versions and host options.
   *       400:
   *         description: SSH session not found or not connected.
   */
  router.get("/validate/:sessionId", async (req, res) => {
    const session = sessionOf(req, res);
    if (!session) return;
    const target = targetOf(session.settings);
    const { settings } = session;
    const label = flavorLabel(settings.flavor);
    const base = {
      flavor: settings.flavor,
      readOnly: settings.readOnly,
      namespace: settings.namespace ?? "default",
    };

    let client = "unknown";
    try {
      const output = await run(session, target, [
        "version",
        "--client",
        "-o",
        "json",
      ]);
      client =
        (JSON.parse(output) as { clientVersion?: { gitVersion?: string } })
          .clientVersion?.gitVersion ?? "unknown";
    } catch (error) {
      const message = getErrorMessage(error, "");
      const code = validateCode(message);
      return res.json({
        ...base,
        available: false,
        code,
        error:
          code === "NOT_INSTALLED"
            ? `${label} is not installed on this host.`
            : message,
      });
    }

    let server = "unknown";
    try {
      const output = await run(session, target, [
        "version",
        "-o",
        "json",
        "--request-timeout=10s",
      ]);
      server =
        (JSON.parse(output) as { serverVersion?: { gitVersion?: string } })
          .serverVersion?.gitVersion ?? "unknown";
    } catch (error) {
      const message = getErrorMessage(error, "");
      return res.json({
        ...base,
        available: false,
        code: validateCode(message),
        error: message,
        version: { client },
      });
    }

    let helmVersion: string | null = null;
    try {
      helmVersion =
        (
          await sessions.run(session, () =>
            sessions.exec(session, helm(target, ["version", "--short"]), {
              timeoutMs: 15_000,
            }),
          )
        ).trim() || null;
    } catch {
      helmVersion = null;
    }

    const userId = ctx.currentActor();
    const canRevealSecrets = userId
      ? await ctx.rbac.hasFor(userId, "secrets")
      : false;

    res.json({
      ...base,
      available: true,
      version: { client, server },
      helm: helmVersion,
      canRevealSecrets,
    });
  });

  /**
   * @openapi
   * /plugin-api/kubernetes/contexts/{sessionId}:
   *   get:
   *     summary: List kubeconfig contexts
   *     description: The contexts in the host's kubeconfig and the one in use.
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
   *         description: Contexts and the current one.
   *       400:
   *         description: SSH session not found or not connected.
   */
  router.get("/contexts/:sessionId", async (req, res) => {
    const session = sessionOf(req, res);
    if (!session) return;
    const target = { ...targetOf(session.settings), context: undefined };
    try {
      const names = await run(session, target, [
        "config",
        "get-contexts",
        "-o",
        "name",
      ]);
      let current = session.settings.context ?? "";
      if (!current) {
        current = (
          await run(session, target, ["config", "current-context"]).catch(
            () => "",
          )
        ).trim();
      }
      res.json({
        contexts: names
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean),
        current: current || null,
      });
    } catch (error) {
      fail(res, session, error, "list contexts");
    }
  });

  /**
   * @openapi
   * /plugin-api/kubernetes/namespaces/{sessionId}:
   *   get:
   *     summary: List namespaces
   *     description: Namespace names in the cluster. When the user may not list namespaces, only the default one comes back and restricted is true.
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
   *         description: Namespace names.
   *       400:
   *         description: SSH session not found or not connected.
   */
  router.get("/namespaces/:sessionId", async (req, res) => {
    const session = sessionOf(req, res);
    if (!session) return;
    const target = targetFor(req, res, session);
    if (!target) return;
    try {
      const output = await run(session, target, [
        "get",
        "namespaces",
        "-o",
        "jsonpath={.items[*].metadata.name}",
        REQUEST_TIMEOUT,
      ]);
      res.json({
        namespaces: output.split(/\s+/).filter(isNamespace).sort(),
        restricted: false,
      });
    } catch (error) {
      if (/forbidden/i.test(getErrorMessage(error, ""))) {
        res.json({
          namespaces: [session.settings.namespace ?? "default"],
          restricted: true,
        });
        return;
      }
      fail(res, session, error, "list namespaces");
    }
  });

  /**
   * @openapi
   * /plugin-api/kubernetes/resources/{sessionId}/{kind}:
   *   get:
   *     summary: List resources of a kind
   *     description: Rows for one kind (pods, deployments, services, nodes and so on) in a namespace, or in every namespace when none is given.
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
   *       - in: query
   *         name: namespace
   *         schema:
   *           type: string
   *       - in: query
   *         name: context
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: A list of resources.
   *       400:
   *         description: Bad kind, namespace or session.
   *       403:
   *         description: The cluster refused the request.
   *       500:
   *         description: kubectl failed.
   */
  router.get("/resources/:sessionId/:kind", async (req, res) => {
    const session = sessionOf(req, res);
    if (!session) return;
    const target = targetFor(req, res, session);
    if (!target) return;
    const namespace = namespaceFor(req, res);
    if (namespace === undefined) return;
    const kind = req.params.kind as KindId;
    try {
      const output = await run(session, target, [
        "get",
        KINDS[kind].resource,
        ...namespaceArgs(kind, namespace),
        "-o",
        "json",
        REQUEST_TIMEOUT,
      ]);
      res.json(parseResourceList(kind, output));
    } catch (error) {
      fail(res, session, error, `list ${kind}`);
    }
  });

  /**
   * @openapi
   * /plugin-api/kubernetes/resources/{sessionId}/{kind}/{name}:
   *   get:
   *     summary: Get one resource
   *     description: The resource's row, its kubectl describe text and, for a configmap, its data.
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
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: The resource.
   *       400:
   *         description: Bad kind, name, namespace or session.
   *       404:
   *         description: Not found.
   */
  router.get("/resources/:sessionId/:kind/:name", async (req, res) => {
    const session = sessionOf(req, res);
    if (!session) return;
    const target = targetFor(req, res, session);
    if (!target) return;
    const object = objectOf(req, res);
    if (!object) return;
    const { kind, name, ns } = object;
    try {
      const [json, describe] = await Promise.all([
        run(session, target, [
          "get",
          KINDS[kind].resource,
          name,
          ...ns,
          "-o",
          "json",
          REQUEST_TIMEOUT,
        ]),
        run(session, target, [
          "describe",
          KINDS[kind].resource,
          name,
          ...ns,
          REQUEST_TIMEOUT,
        ]).catch(() => ""),
      ]);
      const item = parseItems(json)[0] ?? {};
      res.json({
        summary: summarize(kind, item),
        describe,
        data: kind === "configmaps" ? configMapData(item) : undefined,
      });
    } catch (error) {
      fail(res, session, error, `get ${kind}`);
    }
  });

  /**
   * @openapi
   * /plugin-api/kubernetes/resources/{sessionId}/{kind}/{name}/yaml:
   *   get:
   *     summary: Get a resource as YAML
   *     description: The resource's manifest as kubectl get -o yaml prints it.
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
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: The YAML text.
   *       404:
   *         description: Not found.
   */
  router.get("/resources/:sessionId/:kind/:name/yaml", async (req, res) => {
    const session = sessionOf(req, res);
    if (!session) return;
    const target = targetFor(req, res, session);
    if (!target) return;
    const object = objectOf(req, res);
    if (!object) return;
    const { kind, name, ns } = object;
    try {
      const yaml = await run(session, target, [
        "get",
        KINDS[kind].resource,
        name,
        ...ns,
        "-o",
        "yaml",
        REQUEST_TIMEOUT,
      ]);
      res.json({ yaml });
    } catch (error) {
      fail(res, session, error, `get ${kind} yaml`);
    }
  });

  /**
   * @openapi
   * /plugin-api/kubernetes/resources/{sessionId}/{kind}/{name}/events:
   *   get:
   *     summary: Events for a resource
   *     description: Cluster events whose involved object is this resource, newest first.
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
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: A list of events.
   */
  router.get("/resources/:sessionId/:kind/:name/events", async (req, res) => {
    const session = sessionOf(req, res);
    if (!session) return;
    const target = targetFor(req, res, session);
    if (!target) return;
    const object = objectOf(req, res);
    if (!object) return;
    const { kind, name, namespace } = object;
    try {
      const output = await run(session, target, [
        "get",
        "events",
        ...(namespace ? ["-n", namespace] : ["-A"]),
        `--field-selector=involvedObject.name=${name},involvedObject.kind=${KINDS[kind].kind}`,
        "-o",
        "json",
        REQUEST_TIMEOUT,
      ]);
      res.json(parseResourceList("events", output));
    } catch (error) {
      fail(res, session, error, "list events");
    }
  });

  /**
   * @openapi
   * /plugin-api/kubernetes/resources/{sessionId}/{kind}/{name}/pods:
   *   get:
   *     summary: Pods of a workload, service or node
   *     description: The pods a workload or service selects, or the pods scheduled on a node.
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
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: A list of pods.
   *       400:
   *         description: The kind has no pods.
   */
  router.get("/resources/:sessionId/:kind/:name/pods", async (req, res) => {
    const session = sessionOf(req, res);
    if (!session) return;
    const target = targetFor(req, res, session);
    if (!target) return;
    const object = objectOf(req, res);
    if (!object) return;
    const { kind, name, ns } = object;
    try {
      if (kind === "nodes") {
        const output = await run(session, target, [
          "get",
          "pods",
          "-A",
          `--field-selector=spec.nodeName=${name}`,
          "-o",
          "json",
          REQUEST_TIMEOUT,
        ]);
        return res.json(parseResourceList("pods", output));
      }
      if (!SELECTOR_KINDS.includes(kind)) {
        return res.status(400).json({ error: `${kind} have no pods` });
      }
      const json = await run(session, target, [
        "get",
        KINDS[kind].resource,
        name,
        ...ns,
        "-o",
        "json",
        REQUEST_TIMEOUT,
      ]);
      const selector = labelSelector(
        selectorLabels(kind, parseItems(json)[0] ?? {}) as Record<
          string,
          unknown
        > | null,
      );
      if (!selector) return res.json([]);
      const output = await run(session, target, [
        "get",
        "pods",
        ...ns,
        "-l",
        selector,
        "-o",
        "json",
        REQUEST_TIMEOUT,
      ]);
      res.json(parseResourceList("pods", output));
    } catch (error) {
      fail(res, session, error, "list pods");
    }
  });

  /**
   * @openapi
   * /plugin-api/kubernetes/resources/{sessionId}/{kind}/{name}/history:
   *   get:
   *     summary: Rollout history
   *     description: The revisions of a deployment, statefulset or daemonset. With revision, the pod template of that revision.
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
   *         schema:
   *           type: string
   *       - in: query
   *         name: revision
   *         schema:
   *           type: integer
   *     responses:
   *       200:
   *         description: Revisions, or one revision's details.
   *       400:
   *         description: The kind has no rollout history.
   */
  router.get("/resources/:sessionId/:kind/:name/history", async (req, res) => {
    const session = sessionOf(req, res);
    if (!session) return;
    const target = targetFor(req, res, session);
    if (!target) return;
    const object = objectOf(req, res);
    if (!object) return;
    const { kind, name, ns } = object;
    if (!ROLLOUT_KINDS.includes(kind)) {
      return res.status(400).json({ error: `${kind} have no rollout history` });
    }
    const revision = req.query.revision;
    const args = ["rollout", "history", ref(kind, name), ...ns];
    if (revision !== undefined) {
      const n = Number(revision);
      if (!Number.isInteger(n) || n < 1) {
        return res.status(400).json({ error: "Invalid revision" });
      }
      args.push(`--revision=${n}`);
    }
    try {
      const output = await run(session, target, args);
      if (revision !== undefined) return res.json({ details: output });
      res.json(parseRolloutHistory(output));
    } catch (error) {
      fail(res, session, error, "read rollout history");
    }
  });

  /**
   * @openapi
   * /plugin-api/kubernetes/resources/{sessionId}/{kind}/{name}:
   *   delete:
   *     summary: Delete a resource
   *     description: Deletes the resource without waiting for it to go. force skips the grace period of a pod.
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
   *         schema:
   *           type: string
   *       - in: query
   *         name: force
   *         schema:
   *           type: boolean
   *     responses:
   *       200:
   *         description: Deleted.
   *       403:
   *         description: The host is read only, or the cluster refused.
   *       404:
   *         description: Not found.
   */
  router.delete("/resources/:sessionId/:kind/:name", async (req, res) => {
    const session = sessionOf(req, res);
    if (!session) return;
    if (!writable(session, res)) return;
    const target = targetFor(req, res, session);
    if (!target) return;
    const object = objectOf(req, res);
    if (!object) return;
    const { kind, name, namespace, ns } = object;
    const args = ["delete", KINDS[kind].resource, name, ...ns, "--wait=false"];
    if (kind === "pods" && req.query.force === "true") {
      args.push("--grace-period=0", "--force");
    }
    const details = { kind, name, namespace, context: target.context };
    try {
      const output = await run(session, target, args);
      audit(req, session, "delete", details);
      res.json({ success: true, output: output.trim() });
    } catch (error) {
      audit(req, session, "delete", details, error);
      fail(res, session, error, `delete ${kind}`);
    }
  });

  /**
   * @openapi
   * /plugin-api/kubernetes/resources/{sessionId}/{kind}/{name}/action:
   *   post:
   *     summary: Run an action on a resource
   *     description: scale, restart, undo, setImage (deployments, statefulsets, daemonsets, replicasets), suspend and resume (cronjobs, jobs), trigger (cronjobs), cordon, uncordon and drain (nodes).
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
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - action
   *             properties:
   *               action:
   *                 type: string
   *               namespace:
   *                 type: string
   *               replicas:
   *                 type: integer
   *               revision:
   *                 type: integer
   *               container:
   *                 type: string
   *               image:
   *                 type: string
   *               deleteEmptyDirData:
   *                 type: boolean
   *               force:
   *                 type: boolean
   *     responses:
   *       200:
   *         description: The action ran.
   *       400:
   *         description: Unknown action, wrong kind or bad value.
   *       403:
   *         description: The host is read only, or the cluster refused.
   */
  router.post("/resources/:sessionId/:kind/:name/action", async (req, res) => {
    const session = sessionOf(req, res);
    if (!session) return;
    if (!writable(session, res)) return;
    const target = targetFor(req, res, session);
    if (!target) return;
    const object = objectOf(req, res);
    if (!object) return;
    const { kind, name, namespace } = object;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const action = body.action as ResourceAction;
    if (!ACTIONS.includes(action)) {
      return res.status(400).json({ error: "Unknown action" });
    }
    const args = actionArgs(kind, name, namespace, action, body);
    if (typeof args === "string") {
      return res.status(400).json({ error: args });
    }
    const details = { kind, name, namespace, action, context: target.context };
    try {
      const output = await run(session, target, args, {
        timeoutMs: action === "drain" ? 180_000 : undefined,
      });
      audit(req, session, action, details);
      res.json({ success: true, output: output.trim() });
    } catch (error) {
      audit(req, session, action, details, error);
      fail(res, session, error, `${action} ${kind}`);
    }
  });

  return kit;
}
