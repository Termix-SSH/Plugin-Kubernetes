import { describe, expect, it } from "vitest";
import {
  helm,
  isContext,
  isKubeconfigPath,
  isName,
  isNamespace,
  kubectl,
  labelSelector,
  namespaceArgs,
  normalizeFlavor,
  shellQuote,
} from "../../src/backend/kubectl.js";
import {
  parseKubeHostSettings,
  targetOf,
} from "../../src/backend/host-settings.js";

describe("shellQuote", () => {
  it("wraps in single quotes and escapes inner quotes", () => {
    expect(shellQuote("a b")).toBe("'a b'");
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(shellQuote("$(rm -rf /)")).toBe("'$(rm -rf /)'");
  });
});

describe("kubectl", () => {
  it("quotes every argument and extends PATH", () => {
    const cmd = kubectl({ flavor: "kubectl" }, ["get", "pods", "-n", "web"]);
    expect(cmd).toMatch(/^PATH=".*:\$PATH" kubectl 'get' 'pods' '-n' 'web'$/);
  });

  it("uses the flavor's command", () => {
    expect(kubectl({ flavor: "k3s" }, ["get"])).toContain(" k3s kubectl 'get'");
    expect(kubectl({ flavor: "microk8s" }, ["get"])).toContain(
      " microk8s kubectl 'get'",
    );
    expect(kubectl({ flavor: "oc" }, ["get"])).toContain(" oc 'get'");
  });

  it("passes kubeconfig and context, expanding ~ through $HOME", () => {
    const cmd = kubectl(
      {
        flavor: "kubectl",
        kubeconfig: "~/.kube/prod",
        context: "arn:aws:eks:x",
      },
      ["get"],
    );
    expect(cmd).toContain(`--kubeconfig="$HOME"/'.kube/prod'`);
    expect(cmd).toContain("--context='arn:aws:eks:x'");
  });

  it("keeps a hostile context inside its quotes", () => {
    const cmd = kubectl({ flavor: "kubectl", context: "x'; rm -rf / #" }, []);
    expect(cmd).toContain(`--context='x'\\''; rm -rf / #'`);
  });

  it("runs through sudo -n without the PATH prefix", () => {
    const cmd = kubectl({ flavor: "k3s", sudo: true }, ["get"]);
    expect(cmd).toBe("sudo -n k3s kubectl 'get'");
  });
});

describe("helm", () => {
  it("points helm at the same cluster", () => {
    const cmd = helm({ flavor: "kubectl", context: "prod" }, ["list"]);
    expect(cmd).toContain(" helm --kube-context='prod' 'list'");
  });

  it("reads the k3s config by default on k3s", () => {
    expect(helm({ flavor: "k3s" }, ["list"])).toContain(
      "--kubeconfig='/etc/rancher/k3s/k3s.yaml'",
    );
  });

  it("uses microk8s helm on MicroK8s", () => {
    expect(helm({ flavor: "microk8s" }, ["list"])).toContain(
      " microk8s helm 'list'",
    );
  });
});

describe("validation", () => {
  it("accepts DNS names and refuses anything else", () => {
    expect(isName("web-1.example")).toBe(true);
    expect(isName("Web")).toBe(false);
    expect(isName("-web")).toBe(false);
    expect(isName("a b")).toBe(false);
    expect(isNamespace("kube-system")).toBe(true);
    expect(isNamespace("a.b")).toBe(false);
  });

  it("refuses control characters in a context", () => {
    expect(isContext("user@cluster")).toBe(true);
    expect(isContext("bad\nline")).toBe(false);
    expect(isContext("")).toBe(false);
  });

  it("only allows absolute or home kubeconfig paths without ..", () => {
    expect(isKubeconfigPath("/etc/rancher/k3s/k3s.yaml")).toBe(true);
    expect(isKubeconfigPath("~/.kube/config")).toBe(true);
    expect(isKubeconfigPath("relative/config")).toBe(false);
    expect(isKubeconfigPath("/etc/../root/config")).toBe(false);
    expect(isKubeconfigPath("/tmp/$(id)")).toBe(false);
  });

  it("builds a label selector only from safe labels", () => {
    expect(labelSelector({ app: "web", "app.kubernetes.io/name": "x" })).toBe(
      "app=web,app.kubernetes.io/name=x",
    );
    expect(labelSelector({ app: "a,b" })).toBeNull();
    expect(labelSelector({ "bad key": "x" })).toBeNull();
    expect(labelSelector({})).toBeNull();
  });

  it("scopes namespaced kinds only", () => {
    expect(namespaceArgs("pods", "web")).toEqual(["-n", "web"]);
    expect(namespaceArgs("pods", null)).toEqual(["-A"]);
    expect(namespaceArgs("nodes", "web")).toEqual([]);
  });

  it("falls back to kubectl for an unknown flavor", () => {
    expect(normalizeFlavor("docker")).toBe("kubectl");
    expect(normalizeFlavor("oc")).toBe("oc");
  });
});

describe("host settings", () => {
  it("drops values that fail validation", () => {
    const settings = parseKubeHostSettings({
      enableKubernetes: true,
      kubectlFlavor: "k3s",
      kubeconfig: "../config",
      context: " prod ",
      namespace: "Bad_NS",
      readOnly: true,
      useSudo: true,
    });
    expect(settings).toEqual({
      enabled: true,
      flavor: "k3s",
      kubeconfig: undefined,
      context: "prod",
      namespace: undefined,
      readOnly: true,
      sudo: true,
    });
  });

  it("lets a request override the context", () => {
    const settings = parseKubeHostSettings({ context: "prod" });
    expect(targetOf(settings).context).toBe("prod");
    expect(targetOf(settings, "staging").context).toBe("staging");
  });
});
