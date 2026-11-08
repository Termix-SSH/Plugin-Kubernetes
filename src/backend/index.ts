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
import { registerOperations } from "./operations.js";
import { registerServices } from "./services.js";
import { clusterProblems, readCluster, registerSummary } from "./summary.js";
import { startHostAlerts } from "./host-alerts.js";

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
  registerOperations(ctx);
  startHostAlerts({
    ctx,
    setting: "alertProblems",
    category: "kubernetes.cluster_problem",
    tab: "kubernetes",
    probe: async (hostId) => {
      const { nodes, pods } = await readCluster(ctx, hostId);
      return clusterProblems(nodes, pods);
    },
  });

  ctx.log.info(
    "Kubernetes mounted at /plugin-api/kubernetes and /plugin-ws/kubernetes/console",
  );
}

export async function deactivate() {}
