import { afterEach, describe, expect, it } from "vitest";
import {
  customStatus,
  listForwardsScript,
  parseCrds,
  parseCustomList,
  parseForwards,
  readForwardSpec,
  startForwardScript,
  stopForwardScript,
} from "../../src/backend/custom.js";
import { startServer, type TestServer } from "./server";

let server: TestServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

const CRDS = JSON.stringify({
  items: [
    {
      metadata: { name: "certificates.cert-manager.io" },
      spec: {
        group: "cert-manager.io",
        scope: "Namespaced",
        names: { kind: "Certificate", plural: "certificates" },
        versions: [{ name: "v1", served: true }],
      },
    },
    {
      metadata: { name: "clusterissuers.cert-manager.io" },
      spec: {
        group: "cert-manager.io",
        scope: "Cluster",
        names: { kind: "ClusterIssuer", plural: "clusterissuers" },
        versions: [{ name: "v1", served: true }],
      },
    },
  ],
});

const CERTS = JSON.stringify({
  items: [
    {
      metadata: {
        name: "web-tls",
        namespace: "default",
        creationTimestamp: "2026-11-01T00:00:00Z",
      },
      status: { conditions: [{ type: "Ready", status: "True" }] },
    },
  ],
});

const SPEC = {
  kind: "services",
  name: "web",
  namespace: "default",
  localPort: 8080,
  remotePort: 80,
  address: "127.0.0.1",
};

describe("parsers", () => {
  it("reads CRDs with their scope", () => {
    expect(parseCrds(CRDS)).toEqual([
      {
        name: "certificates.cert-manager.io",
        group: "cert-manager.io",
        kind: "Certificate",
        plural: "certificates",
        namespaced: true,
        versions: ["v1"],
      },
      expect.objectContaining({ kind: "ClusterIssuer", namespaced: false }),
    ]);
  });

  it("takes status from the Ready condition, then the phase", () => {
    expect(
      customStatus({
        status: {
          conditions: [{ type: "Ready", status: "False", reason: "Failed" }],
        },
      }),
    ).toEqual({ status: "Failed", tone: "error" });
    expect(customStatus({ status: { phase: "Pending" } })).toEqual({
      status: "Pending",
      tone: "warn",
    });
    expect(customStatus({})).toEqual({ status: "", tone: "idle" });
    expect(parseCustomList(CERTS)[0]).toMatchObject({
      name: "web-tls",
      namespace: "default",
      status: "Ready",
      tone: "ok",
    });
  });
});

describe("port forward scripts", () => {
  it("checks every field", () => {
    expect(readForwardSpec({ ...SPEC, kind: "nodes" })).toMatch(/pod/);
    expect(readForwardSpec({ ...SPEC, name: "a;b" })).toBe("Invalid name");
    expect(readForwardSpec({ ...SPEC, localPort: 70000 })).toMatch(/Ports/);
    expect(readForwardSpec({ ...SPEC, address: "10.0.0.1" })).toBe(
      "Invalid address",
    );
    expect(readForwardSpec(SPEC)).toEqual(SPEC);
  });

  it("quotes every value it puts on the command line", () => {
    const spec = readForwardSpec(SPEC);
    if (typeof spec === "string") throw new Error(spec);
    const script = startForwardScript(
      { flavor: "kubectl", context: "it's" },
      spec,
      "abcdefabcdef",
      new Date("2026-11-20T00:00:00Z"),
    );
    expect(script).toContain(
      "'port-forward' '-n' 'default' '--address' '127.0.0.1' 'svc/web' '8080:80'",
    );
    expect(script).toContain(`--context='it'\\''s'`);
    expect(script).toContain('"$D/abcdefabcdef.pid"');
  });

  it("refuses a bad id when stopping", () => {
    expect(() => stopForwardScript("../x")).toThrow();
    expect(stopForwardScript("abcdefabcdef")).toContain("kill");
  });

  it("reads the list the host prints", () => {
    const meta = JSON.stringify({ ...SPEC, created: "2026-11-20T00:00:00Z" });
    const rows = parseForwards(
      `abcdefabcdef\t1\tForwarding from 127.0.0.1:8080 -> 80\t${meta}\n` +
        `bad\t1\t\t${meta}\n` +
        `111111111111\t0\terror: lost connection to pod\t${meta}\n`,
    );
    expect(rows.map((row) => [row.id, row.running, row.lastLine])).toEqual([
      ["abcdefabcdef", true, "Forwarding from 127.0.0.1:8080 -> 80"],
      ["111111111111", false, "error: lost connection to pod"],
    ]);
    expect(listForwardsScript()).toContain("kill -0");
  });
});

describe("custom resource and forward routes", () => {
  it("lists CRDs and the objects of one", async () => {
    server = await startServer();
    server.client.reply(/'customresourcedefinitions/, { stdout: CRDS });
    server.client.reply(/'get' 'certificates.cert-manager.io' '-A'/, {
      stdout: CERTS,
    });
    await server.connect();
    const crds = await server.request("GET", "/crds/s1");
    expect(crds.body).toHaveLength(2);
    const list = await server.request(
      "GET",
      "/custom/s1?crd=certificates.cert-manager.io",
    );
    expect(list.body[0]).toMatchObject({ name: "web-tls", tone: "ok" });
    const bad = await server.request("GET", "/custom/s1?crd=pods");
    expect(bad.status).toBe(400);
  });

  it("deletes a custom resource only on a writable host", async () => {
    server = await startServer({ settings: { readOnly: true } });
    await server.connect();
    const refused = await server.request(
      "DELETE",
      "/custom/s1?crd=certificates.cert-manager.io&name=web-tls&namespace=default",
    );
    expect(refused.status).toBe(403);
  });

  it("starts a forward through bash on stdin and reports kubectl's error", async () => {
    server = await startServer();
    server.client.reply(/^bash -s$/, {
      code: 1,
      stderr: "unable to listen on any of the requested ports",
    });
    await server.connect();
    const failed = await server.request("POST", "/forwards/s1", {
      body: SPEC,
    });
    expect(failed.status).toBe(400);
    expect(failed.body.error).toMatch(/unable to listen/);
    const stream = server.client.streams.at(-1)!;
    expect(stream.written.join("")).toContain("'port-forward'");
    const invalid = await server.request("POST", "/forwards/s1", {
      body: { ...SPEC, localPort: 0 },
    });
    expect(invalid.status).toBe(400);
  });
});
