# des-web Puppeteer E2E

Independent Puppeteer/Chromium browser contracts for [`discrete-event-systems/des-web.rs`](https://github.com/discrete-event-systems/des-web.rs).

## Runner lanes

- **GitHub Actions** is exposed as a reusable workflow. `des-web.rs` calls it with the product repository's package-authorized `GITHUB_TOKEN`, starts the immutable image, and uploads screenshot/log evidence.
- **gha-indie-worker** consumes `.github/workflows/gha-indie-worker.yml` at an exact merged commit SHA and maps it to the fixed `puppeteer` profile. The suite defaults to the cluster-local `dd-des-web` service.

The implementation is independent of the Playwright repository and uses Node's built-in test runner plus Puppeteer.

## Tracking

- Product project: https://github.com/orgs/discrete-event-systems/projects/2
- Test project: https://github.com/orgs/discrete-event-systems-test/projects/1
- Linear project: https://linear.app/denman/project/githubcomdiscrete-event-systems-4a3086ae0c45

`gha-indie-worker` execution is intentionally disabled at the platform level until its repository/profile allowlist and runtime network access are certified; planning remains available.
