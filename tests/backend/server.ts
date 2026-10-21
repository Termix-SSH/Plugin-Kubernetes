import http from "node:http";
import type { AddressInfo } from "node:net";
import express, { type Router } from "express";
import {
  createMockCtx,
  type MockContextOptions,
  type MockPluginContext,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import manifestJson from "../../manifest.json";
import { activate } from "../../src/backend/index.js";
import { FakeClient } from "./fake-ssh";

export const manifest = manifestJson as unknown as PluginManifest;

export function podJson(
  name: string,
  extra: {
    namespace?: string;
    phase?: string;
    waiting?: string;
    restarts?: number;
  } = {},
) {
  return {
    metadata: {
      name,
      namespace: extra.namespace ?? "default",
      creationTimestamp: "2026-10-01T00:00:00Z",
      labels: { app: "web" },
      ownerReferences: [{ kind: "ReplicaSet", name: "web-abc" }],
    },
    spec: {
      nodeName: "node-1",
      containers: [{ name: "web", image: "nginx:1.27" }],
    },
    status: {
      phase: extra.phase ?? "Running",
      podIP: "10.42.0.5",
      containerStatuses: [
        {
          name: "web",
          ready: !extra.waiting,
          restartCount: extra.restarts ?? 0,
          state: extra.waiting
            ? { waiting: { reason: extra.waiting } }
            : { running: {} },
        },
      ],
    },
  };
}

export const PODS = JSON.stringify({
  items: [
    podJson("web-1"),
    podJson("web-2", { waiting: "CrashLoopBackOff", restarts: 4 }),
  ],
});

/** A host owned by user-1, as ctx.ssh.resolveHost sees it. */
export function sshHost(id: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    userId: "user-1",
    name: `host-${id}`,
    ip: `10.0.0.${id}`,
    port: 22,
    username: "root",
    authType: "password",
    password: "pw",
    ...extra,
  };
}

/** A client that looks like a host with kubectl, a cluster and helm. */
export function kubeClient(): FakeClient {
  return new FakeClient([
    [
      /'version' '--client'/,
      { stdout: '{"clientVersion":{"gitVersion":"v1.31.2"}}' },
    ],
    [
      /'version' '-o' 'json'/,
      {
        stdout:
          '{"clientVersion":{"gitVersion":"v1.31.2"},"serverVersion":{"gitVersion":"v1.31.1+k3s1"}}',
      },
    ],
    [/helm.*'version'/, { stdout: "v3.16.2+g13654a5\n" }],
    [/'config' 'get-contexts'/, { stdout: "prod\nstaging\n" }],
    [/'config' 'current-context'/, { stdout: "prod\n" }],
    [/'get' 'namespaces' '-o' 'jsonpath/, { stdout: "default kube-system" }],
    [/'get' 'pods'/, { stdout: PODS }],
  ]);
}

export interface TestServer {
  mock: MockPluginContext;
  client: FakeClient;
  request: (
    method: string,
    path: string,
    options?: { user?: string; body?: unknown },
    // Route bodies vary per test; asserting on them is the point.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ) => Promise<{ status: number; body: any }>;
  /** Connects session s1 to host 7. */
  connect: () => Promise<void>;
  /** The kubectl commands run so far, without the connect probes. */
  commands: () => string[];
  close: () => Promise<void>;
}

/** The plugin activated with its router served the way core mounts it. */
export async function startServer(
  options: {
    permissions?: string[];
    enabled?: boolean;
    settings?: Record<string, unknown>;
    client?: FakeClient;
    mock?: Partial<MockContextOptions>;
  } = {},
): Promise<TestServer> {
  const client = options.client ?? kubeClient();
  let router: Router | null = null;
  const mock = createMockCtx({
    pluginId: manifest.id,
    manifest,
    capabilities: manifest.capabilities,
    router: () => (router = express.Router()),
    permissions: options.permissions ?? ["kubernetes.use"],
    sshHosts: [sshHost(7), sshHost(8)],
    sshClient: client,
    ...options.mock,
  });
  if (options.enabled !== false) {
    await mock.ctx.settings.setHost(7, "enableKubernetes", true);
  }
  for (const [key, value] of Object.entries(options.settings ?? {})) {
    await mock.ctx.settings.setHost(7, key, value);
  }

  await activate(mock.ctx);

  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use((req, _res, next) => {
    mock.setActor(req.header("x-test-user") ?? undefined);
    next();
  });
  app.use((req, res, next) => router!(req, res, next));

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  const request: TestServer["request"] = async (
    method,
    path,
    { user = "user-1", body } = {},
  ) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        "x-test-user": user,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };

  let mark = 0;
  return {
    mock,
    client,
    request,
    async connect() {
      const response = await request("POST", "/ssh/connect", {
        body: { sessionId: "s1", hostId: 7 },
      });
      if (response.status !== 200) {
        throw new Error(`connect failed: ${JSON.stringify(response.body)}`);
      }
      mark = client.commands.length;
    },
    commands: () => client.commands.slice(mark),
    async close() {
      for (const dispose of mock.disposals.reverse()) await dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
