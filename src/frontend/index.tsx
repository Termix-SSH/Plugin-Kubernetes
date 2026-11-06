// The pod shell needs xterm's own stylesheet.
import "@xterm/xterm/css/xterm.css";
import type { ComponentType } from "react";
import { ShipWheel } from "lucide-react";
import type {
  StandaloneViewProps,
  TabProps,
  TermixApp,
} from "@termix-ssh/plugin-sdk/frontend";
import { KubernetesManager } from "./KubernetesManager";
import KubernetesApp from "./KubernetesApp";
import { kubernetesWidget } from "./KubernetesWidget";
import { ClustersCard } from "./ClustersCard";
import { ClusterHostTile } from "./ClusterHostTile";
import {
  KubernetesCompanion,
  useKubernetesCompanionDefaults,
} from "./KubernetesCompanion";
import {
  kubernetesEnabled,
  kubernetesPanelEnabled,
  toKubeHost,
  type KubeHostSource,
} from "./types";

function KubernetesTab({ host, sshHost, label, isVisible }: TabProps) {
  const record = host ?? (sshHost as KubeHostSource | undefined);
  return (
    <KubernetesManager
      host={record ? toKubeHost(record) : undefined}
      title={label}
      isVisible={isVisible}
      isTopbarOpen={false}
      embedded={true}
    />
  );
}

function KubernetesStandalone({ hostId }: StandaloneViewProps) {
  return <KubernetesApp hostId={hostId} />;
}

export function activate(app: TermixApp): void {
  // Host actions filter synchronously, so the permission is read once here.
  let canUse = true;
  void app.hasPermission("use").then((allowed) => {
    canUse = allowed;
  });

  app.registerDashboardCard({
    id: "kubernetes-clusters",
    titleKey: "card.title",
    defaultPanel: "side",
    defaultHeight: 200,
    frame: "framed",
    component: ClustersCard,
  });

  app.registerTab("kubernetes", KubernetesTab, {
    icon: ShipWheel,
    titleKey: "nav.kubernetes",
    requiresHost: true,
    noHostMessageKey: "kube.noHostSelected",
    persistent: true,
    activityTypes: ["kubernetes"],
    standalone: KubernetesStandalone,
    preload: () => import("./KubernetesManager"),
  });

  app.registerCompanion("kubernetes", KubernetesCompanion, {
    icon: ShipWheel,
    titleKey: "nav.kubernetes",
    order: 31,
    tabTypes: ["terminal"],
    when: (_tab, host) =>
      canUse && !!host?.enableSsh && kubernetesPanelEnabled(host),
    useDefaults: useKubernetesCompanionDefaults,
  });

  app.registerAction("kubernetes.togglePanel", ((
    _handle: unknown,
    tab: unknown,
  ) => app.toggleCompanion(tab as never, "kubernetes")) as never);
  app.registerSlotContribution("tab.menu", {
    actionId: "kubernetes.togglePanel",
    titleKey: "nav.togglePanel",
    icon: ShipWheel,
    kind: "button",
    order: 7,
    when: (context) =>
      (context.tab as { type?: string } | null)?.type === "terminal",
  });

  app.registerHostAction({
    id: "kubernetes",
    titleKey: "nav.kubernetes",
    icon: ShipWheel,
    kind: "open",
    order: 31,
    tabType: "kubernetes",
    copyUrlView: "kubernetes",
    when: (host) => canUse && !!host.enableSsh && kubernetesEnabled(host),
  });

  app.registerPaletteEntry({
    id: "kubernetes.open",
    titleKey: "nav.kubernetes",
    icon: ShipWheel,
    keywords: ["k8s", "kubectl", "pods", "helm", "cluster"],
    scope: "host",
    when: (host) => canUse && !!host?.enableSsh && kubernetesEnabled(host),
    run: (shell, host) => {
      if (host) shell.openTab(host, "kubernetes");
    },
  });

  app.registerSlotContribution("host-page.tiles", {
    actionId: "kubernetes.hostTile",
    titleKey: "tile.title",
    icon: ShipWheel,
    kind: "component",
    component: ClusterHostTile as unknown as ComponentType<
      Record<string, unknown>
    >,
    when: (context?: { host?: unknown }) =>
      canUse && (!context?.host || kubernetesEnabled(context.host as object)),
  });

  app.registerExtension("homepage.widgets", kubernetesWidget);
}
