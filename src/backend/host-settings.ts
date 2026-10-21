import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import {
  isContext,
  isKubeconfigPath,
  isNamespace,
  normalizeFlavor,
  type KubeTarget,
  type KubectlFlavor,
} from "./kubectl.js";

export interface KubeHostSettings {
  enabled: boolean;
  flavor: KubectlFlavor;
  kubeconfig?: string;
  context?: string;
  namespace?: string;
  readOnly: boolean;
  sudo: boolean;
}

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** A host's settings, with anything that fails validation left out. */
export function parseKubeHostSettings(
  values: Record<string, unknown>,
): KubeHostSettings {
  const kubeconfig = trimmed(values.kubeconfig);
  const context = trimmed(values.context);
  const namespace = trimmed(values.namespace);
  return {
    enabled: values.enableKubernetes === true,
    flavor: normalizeFlavor(values.kubectlFlavor),
    kubeconfig: isKubeconfigPath(kubeconfig) ? kubeconfig : undefined,
    context: isContext(context) ? context : undefined,
    namespace: isNamespace(namespace) ? namespace : undefined,
    readOnly: values.readOnly === true,
    sudo: values.useSudo === true,
  };
}

export async function readKubeHostSettings(
  ctx: PluginContext,
  hostId: number,
): Promise<KubeHostSettings> {
  return parseKubeHostSettings(await ctx.settings.getAll("host", hostId));
}

/** The kubectl target for a host, with an optional context override. */
export function targetOf(
  settings: KubeHostSettings,
  context?: string,
): KubeTarget {
  return {
    flavor: settings.flavor,
    kubeconfig: settings.kubeconfig,
    context: context ?? settings.context,
    sudo: settings.sudo,
  };
}
