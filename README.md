<div align="center">

<img src="https://termix.site/img/logo.svg" width="120" alt="Termix Logo" />

<h1>Kubernetes</h1>

<p>Manage Kubernetes clusters from your hosts over SSH, with logs, metrics, YAML and a shell</p>

</div>

<br />

## Overview

Kubernetes runs kubectl on one of your hosts over SSH and shows the cluster it can reach. Browse workloads, read logs, open a shell in a pod, scale and restart deployments, edit YAML, drain nodes and roll back Helm releases without leaving Termix. It works with kubectl, k3s, MicroK8s and OpenShift.

Read the [docs](https://docs.termix.site/plugins/kubernetes) to set it up and use it.

<br />

## Features

- Browse pods, deployments, statefulsets, daemonsets, jobs and cronjobs
- Scale, restart, roll back and change images of workloads
- Read and download pod logs, and open a shell inside a pod
- View, edit and apply YAML with a dry run and diff first
- Services, ingresses, configmaps, secrets, volumes, nodes and events
- Cordon, uncordon and drain nodes
- CPU and memory from metrics-server
- Helm releases with history, values, rollback and uninstall
- Works with kubectl, k3s, MicroK8s and OpenShift
- A pods panel beside any SSH terminal

<br />

## Sponsors

For a paid sponsor spot, email [mail@termix.site](mailto:mail@termix.site).

<!-- SPONSORS:START -->

<div align="center">

<br />

<a href="https://www.blacksmith.sh/">
  <img src="https://termix.site/img/sponsors/blacksmith.svg" height="40" alt="Blacksmith" />
</a>
&nbsp;&nbsp;&nbsp;
<a href="https://www.cloudflare.com/">
  <img src="https://termix.site/img/sponsors/cloudflare.png" height="40" alt="Cloudflare" />
</a>
&nbsp;&nbsp;&nbsp;
<a href="https://akamai.com/">
  <img src="https://termix.site/img/sponsors/akamai.svg" height="40" alt="Akamai" />
</a>
&nbsp;&nbsp;&nbsp;
<a href="https://aws.amazon.com/">
  <img src="https://termix.site/img/sponsors/aws.png" height="40" alt="AWS" />
</a>
&nbsp;&nbsp;&nbsp;
<a href="https://rackgenius.com/">
  <img src="https://termix.site/img/sponsors/rackgenius.png" height="40" alt="Rack Genius" />
</a>
&nbsp;&nbsp;&nbsp;
<a href="https://ginernet.com/">
  <img src="https://termix.site/img/sponsors/ginernet.png" height="40" alt="Ginernet" />
</a>
&nbsp;&nbsp;&nbsp;
<a href="https://www.hetzner.com/?mtm_campaign=termix&mtm_medium=referral&mtm_content=sponsoring_link">
  <img src="https://termix.site/img/sponsors/hetzner.png" height="40" alt="Hetzner" />
</a>

</div>

<!-- SPONSORS:END -->

<br />

## Support

Bugs and ideas for Kubernetes go in this repo: [report a bug](https://github.com/Termix-SSH/Plugin-Kubernetes/issues/new?template=bug_report.yml) or [request a feature](https://github.com/Termix-SSH/Plugin-Kubernetes/issues/new?template=feature_request.yml). Report an issue on the plugin's page in the Plugins tab fills in your versions for you.

Problems with Termix itself (login, hosts, credentials, sharing, sync) go in the [Termix repo](https://github.com/Termix-SSH/Termix/issues/new/choose). Not sure where it goes? Open it there and it will be moved.

Add as much detail as you can, in English if possible. For questions, join the [Discord](https://discord.gg/jVQGdvHDrf) server.

<br />

## License

Apache License 2.0. See [LICENSE](LICENSE).
