import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import {
  renderWithApp,
  type RenderedPluginApp,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import type { PluginApiClient } from "@termix-ssh/plugin-sdk/frontend";
import * as plugin from "../../src/frontend/index";
import manifestJson from "../../manifest.json";
import locales from "../../locales/en.json";

const manifest = manifestJson as unknown as PluginManifest;

let rendered: RenderedPluginApp | null = null;

afterEach(async () => {
  await rendered?.deactivate();
  rendered = null;
});

function host(enableKubernetes: boolean) {
  return {
    id: "7",
    name: "box",
    ip: "10.0.0.7",
    port: 22,
    username: "root",
    enableSsh: true,
    pluginSettings: { kubernetes: { enableKubernetes } },
  };
}

const pod = (name: string, status: string, tone: string) => ({
  kind: "pods",
  name,
  namespace: "default",
  created: "2026-10-01T00:00:00Z",
  status,
  tone,
  fields: { ready: "1/1", restarts: 0, node: "node-1", ip: "10.42.0.5" },
  containers: ["web"],
});

function stubApi(
  connectResult: Record<string, unknown>,
  validation: Record<string, unknown> = {},
) {
  const post = vi.fn(async (url: string) => {
    if (url === "/ssh/connect") return { data: connectResult };
    return { data: { success: true } };
  });
  const get = vi.fn(async (url: string) => {
    if (url.startsWith("/validate/")) {
      return {
        data: {
          available: true,
          flavor: "k3s",
          readOnly: false,
          namespace: "default",
          version: { client: "v1.31.2", server: "v1.31.1+k3s1" },
          helm: null,
          ...validation,
        },
      };
    }
    if (url.startsWith("/contexts/")) {
      return { data: { contexts: ["default"], current: "default" } };
    }
    if (url.startsWith("/namespaces/")) {
      return {
        data: { namespaces: ["default", "kube-system"], restricted: false },
      };
    }
    if (url.startsWith("/metrics/")) {
      return { data: { available: false, rows: [] } };
    }
    if (url.match(/^\/resources\/[^/]+\/pods$/)) {
      return {
        data: [
          pod("web-1", "Running", "ok"),
          pod("web-2", "CrashLoopBackOff", "error"),
        ],
      };
    }
    return { data: [] };
  });
  return {
    post,
    get,
    delete: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
  } as unknown as {
    post: typeof post;
    get: typeof get;
  } & PluginApiClient;
}

async function renderTab(api: PluginApiClient, enabled = true) {
  rendered = await renderWithApp(plugin, {
    manifest,
    locales,
    hosts: [host(enabled)],
    api,
  });
  rendered.renderTab("kubernetes", {
    host: host(enabled),
    label: "box",
    isVisible: true,
  });
}

describe("KubernetesManager", () => {
  it("says Kubernetes is off for a host without the switch", async () => {
    const api = stubApi({ success: true });
    await renderTab(api, false);
    expect(
      await screen.findByText("Kubernetes is not enabled for this host"),
    ).toBeTruthy();
    expect(api.post).not.toHaveBeenCalled();
  });

  it("connects, validates and lists pods in the default namespace", async () => {
    const api = stubApi({ success: true, status: "success" });
    await renderTab(api);
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        "/ssh/connect",
        expect.objectContaining({ hostId: 7 }),
      ),
    );
    expect(await screen.findByText("web-1")).toBeTruthy();
    expect(screen.getByText("CrashLoopBackOff")).toBeTruthy();
    expect(screen.getByText("k3s v1.31.1+k3s1")).toBeTruthy();
    expect(api.get).toHaveBeenCalledWith(
      expect.stringMatching(/^\/resources\/.+\/pods$/),
      { params: { namespace: "default" } },
    );
  });

  it("filters to problems", async () => {
    const api = stubApi({ success: true, status: "success" });
    await renderTab(api);
    expect(await screen.findByText("web-1")).toBeTruthy();
    fireEvent.click(screen.getByText("Problems"));
    await waitFor(() => expect(screen.queryByText("web-1")).toBeNull());
    expect(screen.getByText("web-2")).toBeTruthy();
  });

  it("hides write actions on a read only host", async () => {
    const api = stubApi(
      { success: true, status: "success" },
      { readOnly: true },
    );
    await renderTab(api);
    expect(await screen.findByText("web-1")).toBeTruthy();
    expect(screen.getAllByText("Read only").length).toBeGreaterThan(0);
    expect(screen.queryAllByLabelText("Delete")).toEqual([]);
    expect(screen.getAllByLabelText("Logs").length).toBe(2);
  });

  it("shows why the cluster can't be used", async () => {
    const api = stubApi(
      { success: true, status: "success" },
      {
        available: false,
        code: "NOT_INSTALLED",
        error: "k3s is not installed on this host.",
      },
    );
    await renderTab(api);
    expect(
      (await screen.findAllByText("k3s is not installed on this host.")).length,
    ).toBeGreaterThan(0);
  });

  it("opens the code prompt when the host asks for one", async () => {
    const api = stubApi({
      requires_totp: true,
      sessionId: "s1",
      prompt: "Verification code:",
    });
    await renderTab(api);
    expect(await screen.findByText("Verification code:")).toBeTruthy();
  });
});
