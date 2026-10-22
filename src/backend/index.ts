import type { Router } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { createLogger } from "./helpers.js";
import { createKubeSessions } from "./sessions.js";
import { registerRoutes } from "./routes.js";
import { registerLogs } from "./logs.js";
import { registerMetrics } from "./metrics.js";
import { registerHelm } from "./helm.js";
import { registerManifests } from "./manifests.js";
import { registerConsole } from "./console.js";
import { registerServices } from "./services.js";
import { registerSummary } from "./summary.js";

export type {
  KubeEventsV1,
  KubePodEvent,
  KubePodSummary,
  KubeWorkloadsV1,
} from "./services.js";

export async function activate(ctx: PluginContext) {
  const log = createLogger(ctx.log);
  const sessions = createKubeSessions(ctx.schedule, log);
  ctx.disposables.add(() => sessions.closeAll());

  const router = ctx.http.router<Router>();
  const deps = { ctx, sessions, log };
  const kit = registerRoutes(router, deps);
  registerLogs(router, deps, kit);
  registerMetrics(router, deps, kit);
  registerHelm(router, deps, kit);
  registerManifests(router, deps, kit);
  registerSummary(router, ctx);
  registerConsole(ctx, log);
  registerServices(ctx, log);

  ctx.log.info(
    "Kubernetes mounted at /plugin-api/kubernetes and /plugin-ws/kubernetes/console",
  );
}

export async function deactivate() {}
