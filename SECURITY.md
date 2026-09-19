# Security

Use GitHub's private vulnerability reporting for credential exposure, trust-boundary bypasses, or unauthorized writes. Do not include real keys in a public issue.

The privileged workflow must use the trusted base checkout and a pinned action. The action reads untrusted submissions as data, never runs them, and only uses fixed origins: GitHub plus the enabled Jev providers (TypeSafe, Vercel AI Gateway, Cloudflare Workers AI). The model has no shell, GitHub token, or merge authority. Provider errors do not echo response bodies.

Prompt injection can still influence model judgments. Recommendations are advisory; a maintainer reviews and merges. This project does not claim to audit software security or prove a project's behavior.

Only the latest 0.x release is supported during initial development.
