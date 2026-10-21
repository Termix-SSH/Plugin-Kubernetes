import type { Request, Response, Router } from "express";
import { RELEASE_RE, helm, isNamespace } from "./kubectl.js";
import type { Deps, RouteKit } from "./route-kit.js";

export interface HelmRelease {
  name: string;
  namespace: string;
  revision: number;
  updated: string;
  status: string;
  chart: string;
  appVersion: string;
}

export interface HelmRevision {
  revision: number;
  updated: string;
  status: string;
  chart: string;
  appVersion: string;
  description: string;
}

type Obj = Record<string, unknown>;

function list(output: string): Obj[] {
  const trimmed = output.trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed) as unknown;
  return Array.isArray(parsed) ? (parsed as Obj[]) : [];
}

const text = (value: unknown) => (typeof value === "string" ? value : "");

/** helm list prints Go time ("2026-10-21 19:13:21.68 +0000 UTC"); turn it into ISO. */
export function helmTime(value: unknown): string {
  const raw = text(value);
  const match = raw.match(
    /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(\.\d+)? ([+-]\d{2})(\d{2})/,
  );
  if (!match) return raw;
  const ms = match[3] ? match[3].slice(0, 4) : "";
  return new Date(
    `${match[1]}T${match[2]}${ms}${match[4]}:${match[5]}`,
  ).toISOString();
}

export function parseHelmList(output: string): HelmRelease[] {
  return list(output).map((r) => ({
    name: text(r.name),
    namespace: text(r.namespace),
    revision: Number(r.revision) || 0,
    updated: helmTime(r.updated),
    status: text(r.status),
    chart: text(r.chart),
    appVersion: text(r.app_version),
  }));
}

export function parseHelmHistory(output: string): HelmRevision[] {
  return list(output)
    .map((r) => ({
      revision: Number(r.revision) || 0,
      updated: helmTime(r.updated),
      status: text(r.status),
      chart: text(r.chart),
      appVersion: text(r.app_version),
      description: text(r.description),
    }))
    .sort((a, b) => b.revision - a.revision);
}

export function registerHelm(
  router: Router,
  { sessions }: Deps,
  kit: RouteKit,
) {
  const { sessionOf, targetFor, namespaceFor, writable, audit, fail } = kit;

  router.param("releaseNamespace", (_req, res, next, value) => {
    if (!isNamespace(value)) {
      res.status(400).json({ error: "Invalid namespace" });
      return;
    }
    next();
  });
  router.param("release", (_req, res, next, value) => {
    if (!RELEASE_RE.test(value)) {
      res.status(400).json({ error: "Invalid release name" });
      return;
    }
    next();
  });

  const exec = (req: Request, res: Response, write = false) => {
    const session = sessionOf(req, res);
    if (!session) return null;
    if (write && !writable(session, res)) return null;
    const target = targetFor(req, res, session);
    if (!target) return null;
    return {
      session,
      target,
      run: (args: string[]) =>
        sessions.run(session, () => sessions.exec(session, helm(target, args))),
    };
  };

  const releaseArgs = (req: Request) => [
    String(req.params.release),
    "-n",
    String(req.params.releaseNamespace),
  ];

  /**
   * @openapi
   * /plugin-api/kubernetes/helm/{sessionId}:
   *   get:
   *     summary: List Helm releases
   *     description: Releases in a namespace, or in every namespace when none is given.
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
   *         description: A list of releases.
   */
  router.get("/helm/:sessionId", async (req, res) => {
    const call = exec(req, res);
    if (!call) return;
    const namespace = namespaceFor(req, res);
    if (namespace === undefined) return;
    try {
      const output = await call.run([
        "list",
        "-a",
        ...(namespace ? ["-n", namespace] : ["-A"]),
        "-o",
        "json",
        "--max=1000",
      ]);
      res.json(parseHelmList(output));
    } catch (error) {
      fail(res, call.session, error, "list helm releases");
    }
  });

  /**
   * @openapi
   * /plugin-api/kubernetes/helm/{sessionId}/{releaseNamespace}/{release}/history:
   *   get:
   *     summary: Helm release history
   *     description: The revisions of a release, newest first.
   *     tags:
   *       - Kubernetes
   *     parameters:
   *       - in: path
   *         name: sessionId
   *         required: true
   *         schema:
   *           type: string
   *       - in: path
   *         name: releaseNamespace
   *         required: true
   *         schema:
   *           type: string
   *       - in: path
   *         name: release
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: Revisions.
   */
  router.get(
    "/helm/:sessionId/:releaseNamespace/:release/history",
    async (req, res) => {
      const call = exec(req, res);
      if (!call) return;
      try {
        const output = await call.run([
          "history",
          ...releaseArgs(req),
          "-o",
          "json",
          "--max=50",
        ]);
        res.json(parseHelmHistory(output));
      } catch (error) {
        fail(res, call.session, error, "read helm history");
      }
    },
  );

  /**
   * @openapi
   * /plugin-api/kubernetes/helm/{sessionId}/{releaseNamespace}/{release}/values:
   *   get:
   *     summary: Helm release values
   *     description: The values a release was installed with as YAML. all includes the chart defaults.
   *     tags:
   *       - Kubernetes
   *     parameters:
   *       - in: path
   *         name: sessionId
   *         required: true
   *         schema:
   *           type: string
   *       - in: path
   *         name: releaseNamespace
   *         required: true
   *         schema:
   *           type: string
   *       - in: path
   *         name: release
   *         required: true
   *         schema:
   *           type: string
   *       - in: query
   *         name: all
   *         schema:
   *           type: boolean
   *     responses:
   *       200:
   *         description: The values YAML.
   */
  router.get(
    "/helm/:sessionId/:releaseNamespace/:release/values",
    async (req, res) => {
      const call = exec(req, res);
      if (!call) return;
      try {
        const values = await call.run([
          "get",
          "values",
          ...releaseArgs(req),
          "-o",
          "yaml",
          ...(req.query.all === "true" ? ["--all"] : []),
        ]);
        res.json({ values });
      } catch (error) {
        fail(res, call.session, error, "read helm values");
      }
    },
  );

  /**
   * @openapi
   * /plugin-api/kubernetes/helm/{sessionId}/{releaseNamespace}/{release}/manifest:
   *   get:
   *     summary: Helm release manifest
   *     description: The rendered manifest of the release's current revision.
   *     tags:
   *       - Kubernetes
   *     parameters:
   *       - in: path
   *         name: sessionId
   *         required: true
   *         schema:
   *           type: string
   *       - in: path
   *         name: releaseNamespace
   *         required: true
   *         schema:
   *           type: string
   *       - in: path
   *         name: release
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: The manifest YAML.
   */
  router.get(
    "/helm/:sessionId/:releaseNamespace/:release/manifest",
    async (req, res) => {
      const call = exec(req, res);
      if (!call) return;
      try {
        const manifest = await call.run([
          "get",
          "manifest",
          ...releaseArgs(req),
        ]);
        res.json({ manifest });
      } catch (error) {
        fail(res, call.session, error, "read helm manifest");
      }
    },
  );

  /**
   * @openapi
   * /plugin-api/kubernetes/helm/{sessionId}/{releaseNamespace}/{release}/rollback:
   *   post:
   *     summary: Roll back a Helm release
   *     description: Rolls the release back to a revision, or the one before the current one when none is given.
   *     tags:
   *       - Kubernetes
   *     parameters:
   *       - in: path
   *         name: sessionId
   *         required: true
   *         schema:
   *           type: string
   *       - in: path
   *         name: releaseNamespace
   *         required: true
   *         schema:
   *           type: string
   *       - in: path
   *         name: release
   *         required: true
   *         schema:
   *           type: string
   *     requestBody:
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               revision:
   *                 type: integer
   *     responses:
   *       200:
   *         description: Rolled back.
   *       403:
   *         description: The host is read only.
   */
  router.post(
    "/helm/:sessionId/:releaseNamespace/:release/rollback",
    async (req, res) => {
      const call = exec(req, res, true);
      if (!call) return;
      const revision = (req.body ?? {}).revision;
      const args = ["rollback", String(req.params.release)];
      if (revision !== undefined && revision !== null) {
        const n = Number(revision);
        if (!Number.isInteger(n) || n < 1) {
          return res.status(400).json({ error: "Invalid revision" });
        }
        args.push(String(n));
      }
      args.push("-n", String(req.params.releaseNamespace));
      const details = {
        release: req.params.release,
        namespace: req.params.releaseNamespace,
        revision,
      };
      try {
        const output = await call.run(args);
        audit(req, call.session, "helm_rollback", details);
        res.json({ success: true, output: output.trim() });
      } catch (error) {
        audit(req, call.session, "helm_rollback", details, error);
        fail(res, call.session, error, "roll back helm release");
      }
    },
  );

  /**
   * @openapi
   * /plugin-api/kubernetes/helm/{sessionId}/{releaseNamespace}/{release}:
   *   delete:
   *     summary: Uninstall a Helm release
   *     description: Runs helm uninstall on the release.
   *     tags:
   *       - Kubernetes
   *     parameters:
   *       - in: path
   *         name: sessionId
   *         required: true
   *         schema:
   *           type: string
   *       - in: path
   *         name: releaseNamespace
   *         required: true
   *         schema:
   *           type: string
   *       - in: path
   *         name: release
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: Uninstalled.
   *       403:
   *         description: The host is read only.
   */
  router.delete(
    "/helm/:sessionId/:releaseNamespace/:release",
    async (req, res) => {
      const call = exec(req, res, true);
      if (!call) return;
      const details = {
        release: req.params.release,
        namespace: req.params.releaseNamespace,
      };
      try {
        const output = await call.run(["uninstall", ...releaseArgs(req)]);
        audit(req, call.session, "helm_uninstall", details);
        res.json({ success: true, output: output.trim() });
      } catch (error) {
        audit(req, call.session, "helm_uninstall", details, error);
        fail(res, call.session, error, "uninstall helm release");
      }
    },
  );
}
