// The pod shell needs xterm's own stylesheet.
import "@xterm/xterm/css/xterm.css";
import { ShipWheel } from "lucide-react";
import type {
  StandaloneViewProps,
  TabProps,
  TermixApp,
} from "@termix-ssh/plugin-sdk/frontend";
import { KubernetesManager } from "./KubernetesManager";
import KubernetesApp from "./KubernetesApp";
import { kubernetesWidget } from "./KubernetesWidget";
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

  app.registerExtension("homepage.widgets", kubernetesWidget);
}
