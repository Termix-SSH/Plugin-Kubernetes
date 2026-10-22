import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import {
  renderWithApp,
  type RenderedPluginApp,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import * as plugin from "../../src/frontend/index";
import manifestJson from "../../manifest.json";
import locales from "../../locales/en.json";

const manifest = manifestJson as unknown as PluginManifest;

const declared = (views?: Array<{ id: string }>) =>
  (views ?? []).map((view) => view.id).sort();

let rendered: RenderedPluginApp | null = null;

afterEach(async () => {
  await rendered?.deactivate();
  rendered = null;
});

describe(`${manifest.id} activate`, () => {
  it("activates and registers only views its manifest declares", async () => {
    rendered = await renderWithApp(plugin, { manifest, locales });
    const contributes = manifest.contributes as unknown as Record<
      string,
      Array<{ id: string }> | undefined
    >;
    const tabs = declared(contributes.tabs);
    // A rail panel may reuse one of the plugin's tab ids.
    const panels = [...declared(contributes.panels), ...tabs];
    const cards = declared(contributes.dashboardCards);
    for (const id of rendered.registered.tabs()) expect(tabs).toContain(id);
    for (const id of rendered.registered.panels()) expect(panels).toContain(id);
    for (const id of rendered.registered.dashboardCards()) {
      expect(cards).toContain(id);
    }
    // Host settings render from the manifest; there is no editor tab.
    expect(rendered.registered.hostEditorSections()).toEqual([]);
    expect(rendered.registered.hostActions()).toEqual([
      expect.objectContaining({ id: "kubernetes", tabType: "kubernetes" }),
    ]);
  });

  it("removes everything it registered on deactivate", async () => {
    const app = await renderWithApp(plugin, { manifest, locales });
    await app.deactivate();
    expect(app.registered.tabs()).toEqual([]);
    expect(app.registered.panels()).toEqual([]);
    expect(app.registered.railItems()).toEqual([]);
    expect(app.registered.hostActions()).toEqual([]);
    expect(app.registered.hostEditorSections()).toEqual([]);
    expect(app.registered.dashboardCards()).toEqual([]);
    expect(app.registered.settingsComponents()).toEqual([]);
    expect(app.registered.actions()).toEqual([]);
  });
});

describe("kubernetes clusters dashboard card", () => {
  it("shows node and pod health per cluster", async () => {
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      permissions: ["kubernetes.use"],
      hosts: [{ id: "7", name: "k3s", ip: "10.0.0.7", port: 22 }],
      api: {
        get: vi.fn(async () => ({
          data: [
            {
              hostId: 7,
              nodesReady: 2,
              nodesTotal: 2,
              podsRunning: 9,
              podsFailing: 1,
              podsTotal: 10,
              checkedAt: "",
            },
          ],
        })),
      } as never,
    });
    expect(rendered.registered.dashboardCards()).toEqual([
      "kubernetes-clusters",
    ]);
    rendered.renderDashboardCard("kubernetes-clusters");
    expect(await screen.findByText("k3s")).toBeTruthy();
    expect(
      screen.getByText("2/2 nodes ready | 9/10 pods running"),
    ).toBeTruthy();
    expect(screen.getByText("1 failing")).toBeTruthy();
  });
});
