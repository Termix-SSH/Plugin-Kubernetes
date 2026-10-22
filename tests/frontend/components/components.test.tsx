import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  ClusterProvider,
  type ClusterValue,
} from "../../../src/frontend/cluster-context";
import type { KubernetesApi } from "../../../src/frontend/kubernetes-api";
import type { HelmRelease } from "../../../src/frontend/types";

const api = {
  checkManifest: vi.fn(),
  diffManifest: vi.fn(),
  applyManifest: vi.fn(),
  logs: vi.fn(),
  get: vi.fn(),
  action: vi.fn(),
  remove: vi.fn(),
} as unknown as Record<keyof KubernetesApi, ReturnType<typeof vi.fn>>;

vi.mock("../../../src/frontend/kubernetes-api", () => ({
  useKubernetesApi: () => api,
}));

const { YamlEditor } =
  await import("../../../src/frontend/components/YamlEditor");
const { LogViewer } =
  await import("../../../src/frontend/components/LogViewer");
const { ResourceActions } =
  await import("../../../src/frontend/components/ResourceActions");
const { HelmList } = await import("../../../src/frontend/components/HelmView");

function cluster(extra: Partial<ClusterValue> = {}): ClusterValue {
  return {
    sessionId: "s1",
    host: { id: 7, ip: "10.0.0.7", port: 22 },
    validation: {
      available: true,
      flavor: "kubectl",
      readOnly: false,
      namespace: "default",
    },
    context: "prod",
    readOnly: false,
    compact: false,
    open: vi.fn(),
    ...extra,
  };
}

function wrap(node: React.ReactNode, value = cluster()) {
  return render(<ClusterProvider value={value}>{node}</ClusterProvider>);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("YamlEditor", () => {
  it("checks, diffs and saves the edited text", async () => {
    api.checkManifest.mockResolvedValue({
      success: true,
      resources: ["deployment.apps/web"],
    });
    api.diffManifest.mockResolvedValue({ diff: "+  replicas: 3\n" });
    api.applyManifest.mockResolvedValue({
      success: true,
      resources: ["deployment.apps/web"],
    });
    const onSaved = vi.fn();
    wrap(
      <YamlEditor
        initial="kind: Deployment"
        mode="replace"
        namespace="prod"
        onSaved={onSaved}
      />,
    );

    fireEvent.change(screen.getByLabelText("yaml.editor"), {
      target: { value: "kind: Deployment\n# edit" },
    });
    expect(screen.getByText("yaml.unsaved")).toBeTruthy();

    fireEvent.click(screen.getByText("yaml.check"));
    expect(await screen.findByText("deployment.apps/web")).toBeTruthy();
    expect(api.checkManifest).toHaveBeenCalledWith("s1", {
      yaml: "kind: Deployment\n# edit",
      mode: "replace",
      namespace: "prod",
      context: "prod",
    });

    fireEvent.click(screen.getByText("yaml.diff"));
    expect(await screen.findByText(/replicas: 3/)).toBeTruthy();

    fireEvent.click(screen.getByText("yaml.save"));
    await waitFor(() =>
      expect(onSaved).toHaveBeenCalledWith(["deployment.apps/web"]),
    );
  });

  it("shows the server's error", async () => {
    api.checkManifest.mockRejectedValue(new Error("error validating data"));
    wrap(<YamlEditor initial="kind: Pod" mode="apply" />);
    fireEvent.click(screen.getByText("yaml.check"));
    expect(await screen.findByText("error validating data")).toBeTruthy();
  });

  it("has no save on a read only host", () => {
    wrap(
      <YamlEditor initial="kind: Pod" mode="apply" />,
      cluster({ readOnly: true }),
    );
    expect(screen.queryByText("yaml.save")).toBeNull();
    expect(screen.getByText("yaml.check")).toBeTruthy();
  });
});

describe("LogViewer", () => {
  it("loads the first container's logs and switches containers", async () => {
    api.logs.mockResolvedValue({ logs: "line one\nline two\n" });
    const target = {
      kind: "pods" as const,
      name: "web-1",
      namespace: "default",
    };
    wrap(
      <LogViewer
        sessionId="s1"
        context="prod"
        target={target}
        containers={["web", "sidecar"]}
      />,
    );
    expect(await screen.findByText("line two")).toBeTruthy();
    expect(api.logs).toHaveBeenCalledWith(
      "s1",
      target,
      expect.objectContaining({ container: "web", tail: 100 }),
      "prod",
    );
    // Select2 keeps a native select next to its popover button.
    const picker = screen
      .getAllByLabelText("logs.container")
      .find((el) => el.tagName === "SELECT")!;
    fireEvent.change(picker, { target: { value: "sidecar" } });
    await waitFor(() =>
      expect(api.logs).toHaveBeenLastCalledWith(
        "s1",
        target,
        expect.objectContaining({ container: "sidecar" }),
        "prod",
      ),
    );
  });
});

describe("ResourceActions", () => {
  const deployment = {
    kind: "deployments" as const,
    name: "web",
    namespace: "prod",
    created: "",
    status: "Ready",
    tone: "ok" as const,
    fields: {},
    containers: ["web"],
    images: ["nginx:1.27"],
    replicas: 2,
  };

  it("offers workload actions and runs a restart after a confirm", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    api.action.mockResolvedValue({ success: true, output: "" });
    const onChanged = vi.fn();
    wrap(<ResourceActions row={deployment} onChanged={onChanged} />);
    for (const label of [
      "actions.scale.label",
      "actions.restart.label",
      "actions.setImage.label",
      "actions.delete.label",
    ]) {
      expect(screen.getByLabelText(label)).toBeTruthy();
    }
    fireEvent.click(screen.getByLabelText("actions.restart.label"));
    await waitFor(() =>
      expect(api.action).toHaveBeenCalledWith(
        "s1",
        { kind: "deployments", name: "web", namespace: "prod" },
        "restart",
        {},
        "prod",
      ),
    );
    expect(onChanged).toHaveBeenCalled();
    confirm.mockRestore();
  });

  it("does nothing when the confirm is declined", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    wrap(<ResourceActions row={deployment} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByLabelText("actions.delete.label"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(api.remove).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it("shows only read actions on a read only host", () => {
    const podRow = { ...deployment, kind: "pods" as const, status: "Running" };
    wrap(
      <ResourceActions row={podRow} onChanged={vi.fn()} />,
      cluster({ readOnly: true }),
    );
    expect(screen.getByLabelText("actions.logs")).toBeTruthy();
    expect(screen.queryByLabelText("actions.console")).toBeNull();
    expect(screen.queryByLabelText("actions.delete.label")).toBeNull();
  });

  it("cordons or uncordons a node by its state", () => {
    const node = {
      ...deployment,
      kind: "nodes" as const,
      namespace: undefined,
      unschedulable: true,
    };
    wrap(<ResourceActions row={node} onChanged={vi.fn()} />);
    expect(screen.getByLabelText("actions.uncordon.label")).toBeTruthy();
    expect(screen.getByLabelText("actions.drain.label")).toBeTruthy();
    expect(screen.queryByLabelText("actions.delete.label")).toBeNull();
  });
});

describe("HelmList", () => {
  const releases: HelmRelease[] = [
    {
      name: "podinfo",
      namespace: "demo",
      revision: 2,
      status: "deployed",
      chart: "podinfo-6.0.0",
      appVersion: "6.0.0",
      updated: "",
    },
  ];

  it("uses the picked cards per row", () => {
    const { container } = render(
      <HelmList
        releases={releases}
        view="grid"
        size="3"
        showNamespace
        onOpen={() => {}}
      />,
    );
    const grid = container.querySelector<HTMLElement>(
      "[style*='grid-template-columns']",
    );
    expect(grid?.style.gridTemplateColumns).toContain("/ 3");
  });
});
