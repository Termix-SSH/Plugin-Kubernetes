import { EventEmitter } from "node:events";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import {
  createMockCtx,
  type MockPluginContext,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginWebSocketConnection } from "@termix-ssh/plugin-sdk/backend";
import { activate } from "../../src/backend/index.js";
import { manifest, sshHost } from "./server";
import { FakeClient, FakeStream } from "./fake-ssh";

/** A ws WebSocket as far as the console uses one. */
class FakeSocket extends EventEmitter {
  readyState = 1;
  sent: Array<Record<string, unknown>> = [];
  closedWith: [number, string] | null = null;

  send(data: string) {
    this.sent.push(JSON.parse(data));
  }

  ping() {}

  close(code: number, reason: string) {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    this.closedWith = [code, reason];
    this.emit("close");
  }

  message(payload: unknown) {
    this.emit("message", Buffer.from(JSON.stringify(payload)));
  }
}

function consoleClient() {
  const shells: FakeStream[] = [];
  const client = new FakeClient([
    [/'exec' '-i' '-t'/, (stream) => shells.push(stream)],
  ]);
  return { client, shells };
}

async function activated(
  client: FakeClient,
  settings: Record<string, unknown> = {},
): Promise<MockPluginContext> {
  const mock = createMockCtx({
    pluginId: manifest.id,
    manifest,
    capabilities: manifest.capabilities,
    router: () => express.Router(),
    permissions: ["kubernetes.use"],
    sshHosts: [sshHost(7)],
    sshClient: client,
  });
  await mock.ctx.settings.setHost(7, "enableKubernetes", true);
  for (const [key, value] of Object.entries(settings)) {
    await mock.ctx.settings.setHost(7, key, value);
  }
  const connect = mock.ctx.ssh.connect;
  mock.ctx.ssh.connect = (async (...args: Parameters<typeof connect>) => ({
    ...(await connect(...args)),
    dispose: () => client.end(),
  })) as typeof connect;
  await activate(mock.ctx);
  return mock;
}

async function openConsole(mock: MockPluginContext, userId = "user-1") {
  const route = mock.wsRoutes.find((r) => r.path === "/console");
  expect(route?.options).toEqual({ public: true, optionalAuth: true });
  const socket = new FakeSocket();
  mock.setActor(userId || undefined);
  await route!.handler!({
    userId,
    request: {},
    socket,
    clientIp: "127.0.0.1",
    requestOrigin: "http://localhost",
    isDataUnlocked: () => true,
  } as PluginWebSocketConnection);
  return socket;
}

async function until(check: () => boolean) {
  for (let i = 0; i < 50 && !check(); i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  expect(check()).toBe(true);
}

const connectMessage = (extra: Record<string, unknown> = {}) => ({
  type: "connect",
  data: {
    hostConfig: { id: 7, ip: "10.0.0.7" },
    namespace: "default",
    pod: "web-1",
    container: "web",
    shell: "bash",
    cols: 100,
    rows: 30,
    ...extra,
  },
});

let disposals: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const dispose of disposals.reverse()) await dispose();
  disposals = [];
});

describe("kubernetes console", () => {
  it("refuses a socket without a user", async () => {
    const mock = await activated(consoleClient().client);
    disposals.push(...mock.disposals);
    const socket = await openConsole(mock, "");
    expect(socket.closedWith?.[0]).toBe(1008);
  });

  it("execs into the pod and forwards input and resizes", async () => {
    const { client, shells } = consoleClient();
    const mock = await activated(client);
    disposals.push(...mock.disposals);
    const socket = await openConsole(mock);
    socket.message(connectMessage({ context: "prod" }));
    await until(() => socket.sent.some((m) => m.type === "connected"));
    expect(client.commands.at(-1)).toMatch(
      /--context='prod' 'exec' '-i' '-t' '-n' 'default' 'web-1' '-c' 'web' '--' 'sh' '-c' 'for s in bash ash sh;/,
    );
    expect(mock.audits.at(-1)).toMatchObject({ action: "kubernetes_exec" });

    socket.message({ type: "input", data: "ls\n" });
    await until(() => shells[0]?.written.includes("ls\n") ?? false);
    socket.message({ type: "resize", data: { cols: 120, rows: 40 } });
    await until(() => shells[0]?.window?.[0] === 40);

    shells[0].emit("data", Buffer.from("hello"));
    await until(() =>
      socket.sent.some((m) => m.type === "output" && m.data === "hello"),
    );
  });

  it("refuses bad pod names, containers and shells", async () => {
    const { client } = consoleClient();
    const mock = await activated(client);
    disposals.push(...mock.disposals);
    const socket = await openConsole(mock);
    socket.message(connectMessage({ pod: "web; rm -rf /" }));
    socket.message(connectMessage({ container: "Web!" }));
    socket.message(connectMessage({ shell: "python" }));
    await until(
      () => socket.sent.filter((m) => m.type === "error").length === 3,
    );
    expect(client.commands).toEqual([]);
  });

  it("keeps the shell off on a read only host", async () => {
    const { client } = consoleClient();
    const mock = await activated(client, { readOnly: true });
    disposals.push(...mock.disposals);
    const socket = await openConsole(mock);
    socket.message(connectMessage());
    await until(() => socket.sent.some((m) => m.type === "error"));
    expect(String(socket.sent.at(-1)?.message)).toContain("read only");
    expect(client.commands).toEqual([]);
  });

  it("closes an open console when the plugin is disabled", async () => {
    const { client, shells } = consoleClient();
    const mock = await activated(client);
    const socket = await openConsole(mock);
    socket.message(connectMessage());
    await until(() => socket.sent.some((m) => m.type === "connected"));
    for (const dispose of [...mock.disposals].reverse()) await dispose();
    expect(shells[0].ended).toBe(true);
    expect(client.ended).toBe(true);
    expect(socket.closedWith?.[0]).toBe(1001);
  });
});
