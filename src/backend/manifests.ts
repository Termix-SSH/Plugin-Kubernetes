import type { Request, Response, Router } from "express";
import { KINDS, kubectl } from "./kubectl.js";
import { decodeSecret, parseItems } from "./resources.js";
import type { Deps, RouteKit } from "./route-kit.js";

const MAX_YAML_BYTES = 1024 * 1024;

export type ApplyMode = "apply" | "replace";

/** The YAML in a request body, or an error message. */
export function manifestOf(
  body: Record<string, unknown>,
): string | { error: string } {
  const yaml = body.yaml;
  if (typeof yaml !== "string" || !yaml.trim()) {
    return { error: "YAML is required" };
  }
  if (Buffer.byteLength(yaml, "utf-8") > MAX_YAML_BYTES) {
    return { error: "YAML is larger than 1 MB" };
  }
  return yaml;
}

/** Args for apply or replace. The manifest always goes in on stdin. */
export function applyArgs(
  mode: ApplyMode,
  namespace: string | null,
  dryRun: boolean,
): string[] {
  const args = [mode, "-f", "-"];
  if (namespace) args.push("-n", namespace);
  if (dryRun) args.push("--dry-run=server");
  args.push("-o", "name");
  return args;
}

export function registerManifests(
  router: Router,
  { ctx, sessions }: Deps,
  kit: RouteKit,
) {
  const { sessionOf, targetFor, namespaceFor, writable, audit, fail } = kit;

  const handler =
    (step: "validate" | "diff" | "apply") =>
    async (req: Request, res: Response) => {
      const session = sessionOf(req, res);
      if (!session) return;
      if (step === "apply" && !writable(session, res)) return;
      const target = targetFor(req, res, session);
      if (!target) return;
      const namespace = namespaceFor(req, res);
      if (namespace === undefined) return;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const yaml = manifestOf(body);
      if (typeof yaml !== "string") return res.status(400).json(yaml);
      const mode: ApplyMode = body.mode === "replace" ? "replace" : "apply";

      const args =
        step === "diff"
          ? ["diff", "-f", "-", ...(namespace ? ["-n", namespace] : [])]
          : applyArgs(mode, namespace, step === "validate");
      const details = { step, mode, namespace, context: target.context };
      try {
        const output = await sessions.run(session, () =>
          sessions.exec(session, kubectl(target, args), {
            input: yaml,
            // diff exits 1 when there are differences.
            okCodes: step === "diff" ? [0, 1] : [0],
          }),
        );
        if (step === "apply") audit(req, session, mode, details);
        if (step === "diff") return res.json({ diff: output });
        res.json({
          success: true,
          resources: output
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean),
        });
      } catch (error) {
        if (step === "apply") audit(req, session, mode, details, error);
        fail(res, session, error, `${step} manifest`);
      }
    };

  /**
   * @openapi
   * /plugin-api/kubernetes/manifests/{sessionId}/validate:
   *   post:
   *     summary: Check a manifest
   *     description: A server side dry run of apply or replace. Nothing changes in the cluster.
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
   *             required:
   *               - yaml
   *             properties:
   *               yaml:
   *                 type: string
   *               mode:
   *                 type: string
   *               namespace:
   *                 type: string
   *     responses:
   *       200:
   *         description: The resources it would change.
   *       400:
   *         description: Missing or too large YAML.
   *       500:
   *         description: The manifest is not valid.
   */
  router.post("/manifests/:sessionId/validate", handler("validate"));

  /**
   * @openapi
   * /plugin-api/kubernetes/manifests/{sessionId}/diff:
   *   post:
   *     summary: Diff a manifest
   *     description: kubectl diff of the manifest against the cluster. Needs diff on the host.
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
   *             required:
   *               - yaml
   *             properties:
   *               yaml:
   *                 type: string
   *               namespace:
   *                 type: string
   *     responses:
   *       200:
   *         description: The diff text, empty when nothing changes.
   */
  router.post("/manifests/:sessionId/diff", handler("diff"));

  /**
   * @openapi
   * /plugin-api/kubernetes/manifests/{sessionId}/apply:
   *   post:
   *     summary: Apply a manifest
   *     description: kubectl apply, or kubectl replace when mode is replace (used when editing a resource so a stale copy is refused).
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
   *             required:
   *               - yaml
   *             properties:
   *               yaml:
   *                 type: string
   *               mode:
   *                 type: string
   *               namespace:
   *                 type: string
   *     responses:
   *       200:
   *         description: The resources that changed.
   *       403:
   *         description: The host is read only.
   */
  router.post("/manifests/:sessionId/apply", handler("apply"));

  /**
   * @openapi
   * /plugin-api/kubernetes/secrets/{sessionId}/{name}/reveal:
   *   post:
   *     summary: Reveal a secret
   *     description: The decoded values of a secret. Needs kubernetes.secrets and is written to the audit log.
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
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - namespace
   *             properties:
   *               namespace:
   *                 type: string
   *     responses:
   *       200:
   *         description: Key and value pairs.
   *       403:
   *         description: The user lacks kubernetes.secrets.
   */
  router.post(
    "/secrets/:sessionId/:name/reveal",
    ctx.rbac.require("secrets") as never,
    async (req, res) => {
      const session = sessionOf(req, res);
      if (!session) return;
      const target = targetFor(req, res, session);
      if (!target) return;
      const namespace = namespaceFor(req, res);
      if (namespace === undefined) return;
      if (!namespace) {
        return res.status(400).json({ error: "Namespace is required" });
      }
      const name = String(req.params.name);
      const details = {
        kind: "secrets",
        name,
        namespace,
        context: target.context,
      };
      try {
        const output = await sessions.run(session, () =>
          sessions.exec(
            session,
            kubectl(target, [
              "get",
              KINDS.secrets.resource,
              name,
              "-n",
              namespace,
              "-o",
              "json",
            ]),
          ),
        );
        audit(req, session, "secret_reveal", details);
        res.json({ data: decodeSecret(parseItems(output)[0] ?? {}) });
      } catch (error) {
        audit(req, session, "secret_reveal", details, error);
        fail(res, session, error, "read secret");
      }
    },
  );
}
