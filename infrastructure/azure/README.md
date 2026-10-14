# Loopiter Azure infrastructure

Terraform for the Loopiter platform, separate from the standalone Loopiter SDK and
`loopiter.co` marketing site. Subscription: `d865e614-32e3-4149-860e-36ccec037536`
(the sponsored subscription). Region: Central US. No CLI default subscription changes.

## Layout

- `bootstrap`: remote state storage, private state container, image registry.
- `environment`: shared Terraform configuration, instantiated independently.
- `environments`: dev/prod backend keys and nonsecret defaults.
- `deploy.sh`: selects the environment explicitly and produces a reviewable plan.

Dev and prod have separate resource groups, networks, private PostgreSQL 17 servers,
Blob Storage, queues, Key Vaults, managed identities, Container Apps environments,
and search services. Terraform state uses separate encrypted Azure Blob keys with
leases and version history. Local plans/state/private variable files are ignored.
State and plans contain sensitive values; restrict access accordingly.

The web app serves the console and REST API. A separate worker processes the queue
and periodically dispatches durable PostgreSQL jobs. Request identity, idempotency,
leases, evidence checks and release pointers remain in the application database.
Each app uses managed identity for blobs, queues, search and Key Vault. PostgreSQL
uses a restricted application role; only the one-off migration job gets the admin
credential. Database endpoints have no public access. Production cloud environments,
including dev, never enable the unauthenticated localhost bypass.

Managed KBs use Azure AI Search document extraction and version-filtered retrieval,
backed by private Azure blobs. Learned guidance and release pointers remain versioned.
Customer-owned Bedrock KBs and external model providers are optional integrations,
not dependencies of Azure-managed storage. Confluence credentials stay encrypted.
The new Azure Confluence crawler has a 500-item bound per sync; exceeding the bound
fails without activating partial content. Live Confluence verification requires
customer credentials. The marketing site remains on Cloudflare.

## Deploy

The platform source and Dockerfile are in the sibling `loopiter-platform` repository.
Build a NEW immutable image tag for each release, then deploy the same tested image
to both environments. Do not reuse a tag for different code.

```sh
cd /absolute/path/to/loopiter-platform
az acr build --subscription d865e614-32e3-4149-860e-36ccec037536 \
  --registry loopiterregistry7536 --image loopiter:RELEASE_TAG --file Dockerfile.azure .

# Supply values securely in environment variables; never commit or paste them into logs.
# TF_VAR_owner_email, TF_VAR_encryption_key, TF_VAR_auth_secret
/absolute/path/to/ai-feedback-loop/infrastructure/azure/deploy.sh dev \
  loopiterregistry7536.azurecr.io/loopiter:RELEASE_TAG apply
```

Upload the private initial account bootstrap JSON (`email`, `password`) to the new
environment's `files/migration/bootstrap.json` blob before its first migration.
For the existing production migration this is instead a consistent database export.
The migration job deletes that bootstrap blob after a successful atomic import.
A matching import ledger allows recovery from a lost successful response; different
input or a populated destination without that ledger is rejected.

Run `az containerapp job start --subscription ... --resource-group rg-loopiter-dev
--name migrate-loopiter-dev`, inspect job completion/logs, and test the deployed URL.
Repeat deployment with `prod` after dev passes. The schema script never runs in HTTP
requests. Keep the original production encryption key when importing encrypted data.

## Recovery and retirement

Keep source RDS and Cloudflare resources until Azure data, authentication, jobs and
knowledge checks pass. Preserve a final RDS snapshot and the private blob manifest
before retiring old resources. Do not delete customer-owned AWS integrations.
Rollback application code by applying an earlier immutable image; roll back agent
behavior through Loopiter's release API. Database schema changes must stay backward
compatible. `prevent_destroy` protects databases and storage; removing those guards
requires an intentional reviewed change.

## Cost

Azure credits eligibility/balance must be checked in Azure billing. Container Apps,
PostgreSQL, registry, storage, monitoring and AI Search have separate meters; this is
not the Cloudflare $5 plan. Both environments use Search Basic: this subscription already has its single Free
search service assigned to Opsentry. No Opsentry resources are modified.
Database servers and the always-on background worker continue billing while idle.
Log ingestion has a 0.1 GB/day quota. Increase capacity based on observed workload.

## Verification status — October 13, 2026

Both environments serve image `cloud-mcp-20261012-3`; web and worker latest revisions
were verified ready. Production data was imported atomically, all five copied
objects passed SHA-256 verification, and temporary bootstrap blobs were deleted.

- Production: https://web-loopiter-prod.redmushroom-e2f381a3.centralus.azurecontainerapps.io
- Dev: https://web-loopiter-dev.politeglacier-0584684a.centralus.azurecontainerapps.io
- Real browser login, upload to Blob Storage, Search document indexing, durable
  release activation and scoped retrieval passed in both environments.
- A real-model production CEM cycle passed feedback, automatic activation, unseen
  cases, conflict rejection and complete rollback on the final image.
- The support candidate was rejected for inventing a product detail. Its original
  release remained active; this is not a successful support deployment cycle.
- Anonymous, cross-origin and cross-project access checks passed. All 26 platform
  tests passed with PostgreSQL enabled; Azure knowledge tests were rerun after fixes.
- Cloud MCP regression coverage passed. The combined platform run passed 27 tests
  and timed out in its legacy lifecycle test; that test passed on an isolated rerun
  (93 seconds). Typechecking passed.
- Docker builds verify Node startup and every browser asset referenced by login.
  Deployment success additionally requires the newest revision to become ready.
- Authenticated cloud MCP at `/mcp` passed HTTP and stdio bridge initialization,
  tool calls, REST parity, project isolation, foreign-Origin denial and immediate
  key revocation in both environments. Keys are created in console Settings.
  Cloud tools expose inspection and feedback; owner-only setup stays in the console.
- October 13 cloud MCP CEM acceptance passed 11 real-model checks, automatic
  learned-guidance activation, eight unseen cases, conflicting-feedback blocking,
  and complete rollback in an isolated development project on production.
  An interrupted earlier run retained an uncertain-call reservation and did not
  activate its candidate; it was preserved without replay.
- Live Confluence remains unverified without customer credentials.

The old production Cloudflare Workers, queues, Hyperdrive and R2 bucket were deleted.
The empty AWS knowledge CloudFormation stack, OpenSearch collection and retained
S3 bucket were deleted. Marketing `loopiter.co` was not changed. RDS and its security group were deleted after final snapshot
`loopiter-final-azure-migration-20261012` reached available/100%. The final snapshot
and retained automated backups remain in AWS for recovery. Both Azure environments
have clean Terraform plans with no drift.

Owner credentials were rotated in all environments. The updated login is stored
privately in the platform checkout's `.live-reports/production/owner-login.json`.
Never commit that file or reuse credentials from old test output.
