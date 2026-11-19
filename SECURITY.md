# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue or pull request for a security problem.

Include the Briefsip version, the steps to reproduce, and the impact you expect. We will confirm receipt, keep you updated while we work on a fix, and credit you in the release notes unless you prefer otherwise.

## Supported versions

Only the latest release receives security fixes. Update from inside the app or install the newest release.

## Deployment model

Briefsip's local server has no login. Anyone who can reach its port can act as its owner, with access to agents, files and provider accounts. Run it on `127.0.0.1` or on a private network such as Tailscale, and never expose it directly to the internet. Reports that depend on exposing the local server publicly are still welcome when they show a way to bypass these expectations, for example by reaching the server from a web page in the owner's browser.
