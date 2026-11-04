import type { Client } from "ssh2";
import type {
  PluginContext,
  PluginOperationContext,
} from "@termix-ssh/plugin-sdk/backend";
import { readKubeHostSettings, targetOf } from "./host-settings.js";
import { isName, isNamespace, kubectl } from "./kubectl.js";
import { parseResourceList, type ResourceSummary } from "./resources.js";
import { ref } from "./routes.js";
import { execOnClient } from "./sessions.js";
import { summarizeCluster } from "./summary.js";

const POOL = "kubernetes";

const WORKLOADS = ["deployments", "statefulsets", "daemonsets"] as const;
type Workload = (typeof WORKLOADS)[number];

function requireHost(context: PluginOperationContext): number {
  if (context.hostId === undefined) throw new Error("This needs a host");
  return context.hostId;
}

/** Pods read as namespace/name, workloads as kind/namespace/name. */
function parseKey(key: string | undefined, parts: 2 | 3): string[] {
  const split = (key ?? "").split("/");
  const [namespace, name] = split.slice(-2);
  if (split.length !== parts || !isNamespace(namespace) || !isName(name)) {
    throw new Error("Invalid target");
  }
  return split;
}

function parseWorkload(key: string | undefined) {
  const [kind, namespace, name] = parseKey(key, 3) as [
    Workload,
    string,
    string,
  ];
  if (!WORKLOADS.includes(kind)) throw new Error("Invalid target");
  return { kind, namespace, name };
}

/** Everything Kubernetes offers to the rest of Termix. */
export function registerOperations(ctx: PluginContext): void {
  const exec = async (
    hostId: number,
    commands: string[][],
    write = false,
  ): Promise<string[]> => {
    const settings = await readKubeHostSettings(ctx, hostId);
    if (write && settings.readOnly) throw new Error("This host is read only");
    const target = targetOf(settings);
    return ctx.ssh.withConnection<string[], Client>(
      hostId,
      { pool: POOL, purpose: "kubernetes", profile: "session" },
      async (client) => {
        const outputs: string[] = [];
        for (const args of commands) {
          outputs.push(await execOnClient(client, kubectl(target, args)));
        }
        return outputs;
      },
    );
  };

  const rowOf = (row: ResourceSummary, key: string) => ({
    id: key,
    name: row.name,
    namespace: row.namespace ?? "",
    status: row.status,
    ...row.fields,
  });

  ctx.operations.register("kubernetes.list-pods", {
    run: async (_input, context) => {
      const [output = ""] = await exec(requireHost(context), [
        ["get", "pods", "-A", "-o", "json"],
      ]);
      const rows = parseResourceList("pods", output).map((row) =>
        rowOf(row, `${row.namespace}/${row.name}`),
      );
      return { summary: `${rows.length} pods`, data: { rows } };
    },
  });

  ctx.operations.register("kubernetes.list-workloads", {
    run: async (_input, context) => {
      const outputs = await exec(
        requireHost(context),
        WORKLOADS.map((kind) => ["get", kind, "-A", "-o", "json"]),
      );
      const rows = WORKLOADS.flatMap((kind, index) =>
        parseResourceList(kind, outputs[index] ?? "").map((row) => ({
          ...rowOf(row, `${kind}/${row.namespace}/${row.name}`),
          kind,
        })),
      );
      return { summary: `${rows.length} workloads`, data: { rows } };
    },
  });

  ctx.operations.register("kubernetes.summary", {
    run: async (_input, context) => {
      const [nodes = "", pods = ""] = await exec(requireHost(context), [
        ["get", "nodes", "-o", "json"],
        ["get", "pods", "-A", "-o", "json"],
      ]);
      const summary = summarizeCluster(
        parseResourceList("nodes", nodes),
        parseResourceList("pods", pods),
      );
      const label = `${summary.podsRunning} of ${summary.podsTotal} pods running`;
      return {
        summary: label,
        data: {
          value: summary.podsFailing,
          status: summary.podsFailing > 0 ? "fail" : "ok",
          label,
        },
      };
    },
  });

  ctx.operations.register("kubernetes.restart-workload", {
    describe: (_input, context) => {
      const { kind, namespace, name } = parseWorkload(context.resourceKey);
      return `Would restart ${kind} ${namespace}/${name}`;
    },
    run: async (_input, context) => {
      const { kind, namespace, name } = parseWorkload(context.resourceKey);
      await exec(
        requireHost(context),
        [["rollout", "restart", ref(kind, name), "-n", namespace]],
        true,
      );
      return { summary: `Restarted ${namespace}/${name}`, changed: true };
    },
  });

  ctx.operations.register("kubernetes.scale-workload", {
    describe: (input, context) => {
      const { namespace, name } = parseWorkload(context.resourceKey);
      return `Would scale ${namespace}/${name} to ${String(input.replicas)}`;
    },
    run: async (input, context) => {
      const { kind, namespace, name } = parseWorkload(context.resourceKey);
      if (kind === "daemonsets") throw new Error("A daemonset cannot scale");
      await exec(
        requireHost(context),
        [
          [
            "scale",
            ref(kind, name),
            `--replicas=${String(input.replicas)}`,
            "-n",
            namespace,
          ],
        ],
        true,
      );
      return {
        summary: `Scaled ${namespace}/${name} to ${String(input.replicas)}`,
        changed: true,
      };
    },
  });

  ctx.operations.register("kubernetes.delete-pod", {
    describe: (_input, context) => {
      const [namespace, name] = parseKey(context.resourceKey, 2);
      return `Would delete pod ${namespace}/${name}`;
    },
    run: async (_input, context) => {
      const [namespace = "", name = ""] = parseKey(context.resourceKey, 2);
      await exec(
        requireHost(context),
        [["delete", "pod", name, "-n", namespace, "--wait=false"]],
        true,
      );
      return { summary: `Deleted ${namespace}/${name}`, changed: true };
    },
  });
}
