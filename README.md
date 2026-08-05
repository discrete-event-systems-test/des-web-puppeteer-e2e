# DES web Puppeteer end-to-end tests

Independent browser, gateway, and compatibility contracts for [`discrete-event-systems/des-web.rs`](https://github.com/discrete-event-systems/des-web.rs).

**Automation contract:** `des-browser-fleet.v1`

This repository combines two complementary Puppeteer suites:

- `tests/des-web.test.mjs` retains the first-party health/readiness, shared-layout, routing-dashboard, htmx partial, mounted-link, hardening-header, and application-404 contracts.
- `tests/des-gateway.test.mjs` adds independent public-route, catalog-ownership, gateway-boundary, fixture-provenance, and `dd-des-simulator:8099` compatibility-Service coverage.

Execution lanes:

- **GitHub Actions** runs both suites against a public, checksum-pinned executable fixture reproduced by the production Dockerfile from source revision `77741ec8b5331617f71416748ef5f06846e43a5d`.
- **`gha-indie-worker`** first probes the in-cluster canonical and compatibility Services. When its isolated browser sandbox cannot cross the gateway-only NetworkPolicy, each suite runs the same verified fixture rather than weakening production ingress.

The fixture release is [`des-browser-fixture-77741ec8`](https://github.com/discrete-event-systems/des-web.rs/releases/tag/des-browser-fixture-77741ec8), pinned to archive SHA-256:

```text
1d8fe97fc285055558fd2e723789a82118d998a595b57a6e8581562bfd18befa
```

For deployed checks, target selection is `DES_BASE_URL`, then `dd-des-web:8130`, then `dd-des-simulator:8099`, then the configured/current public gateway, the prior gateway, and finally the verified fixture.

```bash
npm ci
npm run test:puppeteer
```

Use `DES_FORCE_FIXTURE=1 npm run test:puppeteer` for deterministic fixture-only evidence.

The repository retains screenshots, JUnit XML, target resolution, fixture provenance, and application logs for 14 days. A trusted GitOps dispatcher submits merged immutable revisions to `gha-indie-worker`; a separately labeled Kubernetes browser Job owns the live Service and compatibility-alias canary without broadening DES ingress.

Ownership and rollout policy are documented in the `discrete-event-systems-test/.github` repository and the Linear project `github.com/discrete-event-systems-test`.
