import { afterEach, describe, expect, it } from "vitest";
import { kubeClient, startServer, type TestServer } from "./server";

let server: TestServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

describe("kubernetes routes", () => {
  it("refuses every route without kubernetes.use", async () => {
    server = await startServer({ permissions: [] });
    const calls: Array<[string, string]> = [
      ["POST", "/ssh/connect"],
      ["POST", "/ssh/disconnect"],
      ["GET", "/validate/s1"],
      ["GET", "/contexts/s1"],
      ["GET", "/namespaces/s1"],
      ["GET", "/resources/s1/pods"],
      ["GET", "/resources/s1/pods/web-1?namespace=default"],
      ["DELETE", "/resources/s1/pods/web-1?namespace=default"],
      ["POST", "/resources/s1/deployments/web/action"],
      ["GET", "/resources/s1/pods/web-1/logs?namespace=default"],
      ["GET", "/metrics/s1/pods"],
      ["POST", "/manifests/s1/apply"],
      ["GET", "/helm/s1"],
      ["POST", "/secrets/s1/db/reveal"],
    ];
    for (const [method, path] of calls) {
      const response = await server.request(method, path, {
        body: method === "GET" ? undefined : {},
      });
      expect(response.status, `${method} ${path}`).toBe(403);
    }
  });

  it("refuses a host with Kubernetes switched off", async () => {
    server = await startServer({ enabled: false });
    const response = await server.request("POST", "/ssh/connect", {
      body: { sessionId: "s1", hostId: 7 },
    });
    expect(response.status).toBe(403);
    expect(response.body.code).toBe("KUBERNETES_DISABLED");
  });

  it("connects and validates kubectl, the cluster and helm", async () => {
    server = await startServer({
      permissions: ["kubernetes.use", "kubernetes.secrets"],
    });
    await server.connect();
    expect(server.mock.audits.at(-1)).toMatchObject({
      action: "kubernetes_connect",
    });
    const response = await server.request("GET", "/validate/s1");
    expect(response.body).toMatchObject({
      available: true,
      flavor: "kubectl",
      readOnly: false,
      namespace: "default",
      version: { client: "v1.31.2", server: "v1.31.1+k3s1" },
      helm: "v3.16.2+g13654a5",
      canRevealSecrets: true,
    });
  });

  it("explains a missing kubectl", async () => {
    const client = kubeClient();
    client.reply(/'version' '--client'/, {
      code: 127,
      stderr: "bash: kubectl: command not found",
    });
    server = await startServer({ client });
    await server.connect();
    const response = await server.request("GET", "/validate/s1");
    expect(response.body).toMatchObject({
      available: false,
      code: "NOT_INSTALLED",
    });
  });

  it("explains an unreachable cluster", async () => {
    const client = kubeClient();
    client.reply(/'version' '-o' 'json'/, {
      code: 1,
      stderr:
        "Unable to connect to the server: dial tcp 10.0.0.1:6443: i/o timeout",
    });
    server = await startServer({ client });
    await server.connect();
    const response = await server.request("GET", "/validate/s1");
    expect(response.body).toMatchObject({
      available: false,
      code: "CLUSTER_UNREACHABLE",
    });
  });

  it("lists pods in a namespace or every namespace", async () => {
    server = await startServer();
    await server.connect();
    const scoped = await server.request(
      "GET",
      "/resources/s1/pods?namespace=web",
    );
    expect(scoped.status).toBe(200);
    expect(scoped.body.map((r: { name: string }) => r.name)).toEqual([
      "web-1",
      "web-2",
    ]);
    expect(server.commands().at(-1)).toContain(
      "'get' 'pods' '-n' 'web' '-o' 'json'",
    );
    await server.request("GET", "/resources/s1/pods");
    expect(server.commands().at(-1)).toContain("'get' 'pods' '-A'");
  });

  it("uses the host's kubeconfig, flavor and a picked context", async () => {
    server = await startServer({
      settings: {
        kubectlFlavor: "k3s",
        kubeconfig: "/etc/rancher/k3s/k3s.yaml",
        useSudo: true,
      },
    });
    await server.connect();
    await server.request("GET", "/resources/s1/nodes?context=staging");
    expect(server.commands().at(-1)).toMatch(
      /^sudo -n k3s kubectl --kubeconfig='\/etc\/rancher\/k3s\/k3s.yaml' --context='staging' 'get' 'nodes' '-o' 'json'/,
    );
  });

  it("refuses bad kinds, names, namespaces and contexts", async () => {
    server = await startServer();
    await server.connect();
    expect(
      (await server.request("GET", "/resources/s1/clusterroles")).status,
    ).toBe(400);
    expect(
      (
        await server.request(
          "GET",
          "/resources/s1/pods/Bad_Name?namespace=default",
        )
      ).status,
    ).toBe(400);
    expect(
      (await server.request("GET", "/resources/s1/pods?namespace=a;b")).status,
    ).toBe(400);
    expect(
      (await server.request("GET", "/resources/s1/pods?context=a%0Ab")).status,
    ).toBe(400);
    expect(
      (await server.request("GET", "/resources/s1/pods/web-1")).status,
    ).toBe(400);
  });

  it("refuses a session owned by someone else", async () => {
    server = await startServer();
    await server.connect();
    const response = await server.request("GET", "/resources/s1/pods", {
      user: "user-2",
    });
    expect(response.status).toBe(400);
  });

  it("deletes and runs actions, and audits them", async () => {
    server = await startServer();
    await server.connect();
    const deleted = await server.request(
      "DELETE",
      "/resources/s1/pods/web-1?namespace=default&force=true",
    );
    expect(deleted.status).toBe(200);
    expect(server.commands().at(-1)).toContain(
      "'delete' 'pods' 'web-1' '-n' 'default' '--wait=false' '--grace-period=0' '--force'",
    );
    const scaled = await server.request(
      "POST",
      "/resources/s1/deployments/web/action",
      {
        body: { action: "scale", replicas: 2, namespace: "prod" },
      },
    );
    expect(scaled.status).toBe(200);
    expect(server.commands().at(-1)).toContain(
      "'scale' 'deployments.apps/web' '--replicas=2' '-n' 'prod'",
    );
    expect(server.mock.audits.map((a) => a.action)).toEqual(
      expect.arrayContaining(["kubernetes_delete", "kubernetes_scale"]),
    );
    const bad = await server.request(
      "POST",
      "/resources/s1/pods/web-1/action",
      {
        body: { action: "scale", replicas: 2, namespace: "default" },
      },
    );
    expect(bad.status).toBe(400);
  });

  it("blocks every write on a read only host", async () => {
    server = await startServer({ settings: { readOnly: true } });
    await server.connect();
    const writes: Array<[string, string, unknown?]> = [
      ["DELETE", "/resources/s1/pods/web-1?namespace=default"],
      [
        "POST",
        "/resources/s1/deployments/web/action",
        { action: "restart", namespace: "prod" },
      ],
      ["POST", "/manifests/s1/apply", { yaml: "kind: Pod" }],
      ["POST", "/helm/s1/prod/web/rollback", {}],
      ["DELETE", "/helm/s1/prod/web"],
    ];
    for (const [method, path, body] of writes) {
      const response = await server.request(method, path, { body });
      expect(response.status, `${method} ${path}`).toBe(403);
      expect(response.body.code).toBe("READ_ONLY");
    }
    expect(server.commands()).toEqual([]);
    expect((await server.request("GET", "/resources/s1/pods")).status).toBe(
      200,
    );
  });

  it("sends a manifest on stdin, never in the command", async () => {
    server = await startServer();
    await server.connect();
    const yaml =
      'kind: ConfigMap\nmetadata:\n  name: x\n  annotations:\n    a: "\'; rm -rf /"\n';
    const response = await server.request("POST", "/manifests/s1/apply", {
      body: { yaml, namespace: "web" },
    });
    expect(response.status).toBe(200);
    const command = server.commands().at(-1)!;
    expect(command).toContain("'apply' '-f' '-' '-n' 'web' '-o' 'name'");
    expect(command).not.toContain("rm -rf");
    const stream = server.client.streams.at(-1)!;
    expect(stream.written).toEqual([yaml]);
    expect(stream.ended).toBe(true);
    expect(server.mock.audits.at(-1)).toMatchObject({
      action: "kubernetes_apply",
      success: true,
    });
  });

  it("treats diff's exit code 1 as changes", async () => {
    const client = kubeClient();
    client.reply(/'diff' '-f' '-'/, { code: 1, stdout: "+  replicas: 3\n" });
    server = await startServer({ client });
    await server.connect();
    const response = await server.request("POST", "/manifests/s1/diff", {
      body: { yaml: "kind: Pod" },
    });
    expect(response.status).toBe(200);
    expect(response.body.diff).toBe("+  replicas: 3\n");
  });

  it("reports a failed dry run", async () => {
    const client = kubeClient();
    client.reply(/'--dry-run=server'/, {
      code: 1,
      stderr: "error: error validating data",
    });
    server = await startServer({ client });
    await server.connect();
    const response = await server.request("POST", "/manifests/s1/validate", {
      body: { yaml: "kind: Pod" },
    });
    expect(response.status).toBe(500);
    expect(response.body.error).toContain("error validating data");
  });

  it("reveals a secret only with kubernetes.secrets", async () => {
    const secretClient = () => {
      const client = kubeClient();
      client.reply(/'get' 'secrets' 'db'/, {
        stdout: JSON.stringify({
          metadata: { name: "db" },
          data: { password: "aHVudGVyMg==" },
        }),
      });
      return client;
    };
    server = await startServer({ client: secretClient() });
    await server.connect();
    const refused = await server.request("POST", "/secrets/s1/db/reveal", {
      body: { namespace: "prod" },
    });
    expect(refused.status).toBe(403);
    await server.close();

    server = await startServer({
      client: secretClient(),
      permissions: ["kubernetes.use", "kubernetes.secrets"],
    });
    await server.connect();
    const revealed = await server.request("POST", "/secrets/s1/db/reveal", {
      body: { namespace: "prod" },
    });
    expect(revealed.status).toBe(200);
    expect(revealed.body.data).toEqual({ password: "hunter2" });
    expect(server.mock.audits.at(-1)).toMatchObject({
      action: "kubernetes_secret_reveal",
      success: true,
    });
  });

  it("reads logs of a pod and of a workload through its selector", async () => {
    const client = kubeClient();
    client.reply(/'logs' 'web-1'/, { stdout: "hello\n" });
    client.reply(/'get' 'deployments.apps' 'web'/, {
      stdout: JSON.stringify({
        metadata: { name: "web" },
        spec: { selector: { matchLabels: { app: "web" } } },
      }),
    });
    client.reply(/'logs' '-n' 'prod' '-l'/, { stdout: "[pod/web-1/web] hi\n" });
    server = await startServer({ client });
    await server.connect();
    const pod = await server.request(
      "GET",
      "/resources/s1/pods/web-1/logs?namespace=default&container=web&tail=50",
    );
    expect(pod.body.logs).toBe("hello\n");
    expect(server.commands().at(-1)).toContain(
      "'logs' 'web-1' '-n' 'default' '-c' 'web' '--tail=50'",
    );
    const workload = await server.request(
      "GET",
      "/resources/s1/deployments/web/logs?namespace=prod",
    );
    expect(workload.body.logs).toBe("[pod/web-1/web] hi\n");
    expect(server.commands().at(-1)).toContain(
      "'-l' 'app=web' '--all-containers=true' '--prefix=true'",
    );
    expect(
      (
        await server.request(
          "GET",
          "/resources/s1/configmaps/x/logs?namespace=prod",
        )
      ).status,
    ).toBe(400);
  });

  it("says when metrics-server is missing", async () => {
    const client = kubeClient();
    client.reply(/'top' 'pods'/, {
      code: 1,
      stderr: "error: Metrics API not available",
    });
    server = await startServer({ client });
    await server.connect();
    const response = await server.request("GET", "/metrics/s1/pods");
    expect(response.body).toEqual({ available: false, rows: [] });
  });

  it("lists namespaces, falling back when the user may not", async () => {
    const client = kubeClient();
    server = await startServer({ client, settings: { namespace: "team-a" } });
    await server.connect();
    expect((await server.request("GET", "/namespaces/s1")).body).toEqual({
      namespaces: ["default", "kube-system"],
      restricted: false,
    });
    client.reply(/'get' 'namespaces'/, {
      code: 1,
      stderr: 'namespaces is forbidden: User "x" cannot list',
    });
    expect((await server.request("GET", "/namespaces/s1")).body).toEqual({
      namespaces: ["team-a"],
      restricted: true,
    });
  });

  it("lists contexts and the current one", async () => {
    server = await startServer();
    await server.connect();
    const response = await server.request("GET", "/contexts/s1");
    expect(response.body).toEqual({
      contexts: ["prod", "staging"],
      current: "prod",
    });
  });

  it("lists and rolls back helm releases", async () => {
    const client = kubeClient();
    client.reply(/helm.*'list'/, {
      stdout: JSON.stringify([
        {
          name: "web",
          namespace: "prod",
          revision: "2",
          status: "deployed",
          chart: "web-1.0.0",
          app_version: "1.0",
        },
      ]),
    });
    server = await startServer({ client });
    await server.connect();
    const list = await server.request("GET", "/helm/s1");
    expect(list.body[0]).toMatchObject({ name: "web", revision: 2 });
    expect(server.commands().at(-1)).toContain("'list' '-a' '-A' '-o' 'json'");
    const rollback = await server.request(
      "POST",
      "/helm/s1/prod/web/rollback",
      { body: { revision: 1 } },
    );
    expect(rollback.status).toBe(200);
    expect(server.commands().at(-1)).toContain(
      "'rollback' 'web' '1' '-n' 'prod'",
    );
    expect(
      (await server.request("GET", "/helm/s1/prod/Bad_Name/history")).status,
    ).toBe(400);
  });

  it("finds a workload's pods through its selector", async () => {
    const client = kubeClient();
    client.reply(/'get' 'deployments.apps' 'web'/, {
      stdout: JSON.stringify({
        metadata: { name: "web" },
        spec: { selector: { matchLabels: { app: "web" } } },
      }),
    });
    server = await startServer({ client });
    await server.connect();
    const response = await server.request(
      "GET",
      "/resources/s1/deployments/web/pods?namespace=prod",
    );
    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(2);
    expect(server.commands().at(-1)).toContain(
      "'get' 'pods' '-n' 'prod' '-l' 'app=web'",
    );
  });
});
