# Contributing

Keep the action reusable: domain-specific categories and judgments belong in policies, not the transport or runner.

Use Node.js 22 or newer and run `npm test`. Add focused tests for changes to trusted-checkout enforcement, model-response validation, evidence limits, policy outcomes, or GitHub writes. Tests must not require credentials or call live providers.

Include the concrete behavior change and validation in your PR. New evidence adapters need fixed service origins, bounded reads, reproducible source identities, and explicit data-transfer documentation. Never run submitted code or treat a model response as authorization.

Do not commit keys or raw private PR material. Report security problems through GitHub private vulnerability reporting when enabled.
