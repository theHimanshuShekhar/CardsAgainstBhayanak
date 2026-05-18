---
session: ses_1c5f
updated: 2026-05-18T08:22:17.687Z
---

The URL is missing the `https://` protocol. `new URL()` throws when given `eu-central-1.aws.edge.axiom.co` without a scheme. Let me check the current config and fix the logger to handle this.
