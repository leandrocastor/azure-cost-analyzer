# Azure Cost Analyzer

[Português (Brasil)](./README.md) | [English](./README.en.md)

Enterprise-grade Azure Cost Analyzer with a TypeScript CLI and an Express-powered dashboard for cost visibility, anomaly detection, idle resource discovery, and optimization recommendations.

## Features

- Azure Cost Management aggregation by service, resource group, location, or tags
- Cost trend analysis, anomaly detection, and simple forecasting
- Idle resource detection for VMs, App Services, Storage, SQL, disks, public IPs, and load balancers
- Prioritized optimization recommendations with ROI, risk, and effort scoring
- **Automatic executive summary** in plain language at the top of the report
- **Executable remediation plan**: ready-to-run `az` commands with pre-checks, rollback and equivalent Terraform/Bicep snippets, plus an `apply-remediation.sh` script that is dry-run by default
- **Run-to-run comparison** (cost diff): what changed since the last report and which service or resource group drove it
- **Waste by owner** (showback/chargeback): waste attributed through owner/team/cost center tags, with a tag coverage indicator
- Express dashboard API with static frontend placeholder
- Strict TypeScript, Zod validation, Winston logging, Vitest coverage, ESLint, and Prettier

## Installation

There are two ways to run Azure Cost Analyzer, depending on your scenario.

### Option 1 — Standard install (recurring use)

Ideal for development machines or environments where you'll run the CLI frequently.

```bash
npm install
npm run build
npm install -g .
```

### Option 2 — One-off run via Azure Cloud Shell (no install)

Ideal for a quick analysis directly in Azure Cloud Shell, without cloning or permanently installing anything.

> **Important:** use Cloud Shell in **Bash** mode (not PowerShell) to run the command below.

```bash
npx --yes github:leandrocastor/azure-cost-analyzer export \
  --period 3 \
  --output "$HOME/clouddrive/azure-cost-report.html"
```

`npx` downloads the repository, runs the build automatically (via the `prepare` script), and executes the `export` command once. Since Cloud Shell is already authenticated (implicit `az login`), the analysis uses the same session identity.

**No need to configure `AZURE_SUBSCRIPTION_ID` or a `.env` file:** if no subscription is passed via `--subscription`, the `export` command automatically discovers and analyzes **every enabled subscription** the authenticated identity can access in its tenant, consolidating costs, idle resources, and recommendations from all of them into a single report.

#### Cost Management query quota (QPU)

The Azure Cost Management API charges each query in **QPU (Query Processing Units)**: roughly **1 QPU per month of data requested**. Limits are enforced **per tenant**:

| Window | Limit |
| --- | --- |
| 10 seconds | 12 QPU |
| 1 minute | 60 QPU |
| 1 hour | 600 QPU |

Four subscriptions with `--period 3` therefore consume 12 QPU and exhaust the 10-second window. The command **paces itself within this quota**, waiting between queries and honoring the cool-down Azure returns on HTTP 429 — so runs across many subscriptions may take a few minutes. The spinner shows when it is waiting on quota.

To speed things up, lower `--period` or narrow the scope with `--subscription`.

Any other command (`costs`, `detect`, `recommend`, `dashboard`) can be run the same way — just swap `export` for the desired command — but those commands require a single subscription (via `--subscription` or `AZURE_SUBSCRIPTION_ID`).

## Configuration

Copy `.env.example` to `.env` and update the values.

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `AZURE_SUBSCRIPTION_ID` | No | - | Azure subscription to analyze. If omitted, the `export` command discovers and analyzes every accessible subscription; other commands require `--subscription` |
| `AZURE_TENANT_ID` | Service principal only | - | Microsoft Entra tenant |
| `AZURE_CLIENT_ID` | Service principal or optional managed identity | - | Client/application id |
| `AZURE_CLIENT_SECRET` | Service principal only | - | Client secret |
| `AUTH_METHOD` | No | `cli` | `cli`, `service-principal`, or `managed-identity` |
| `CACHE_TTL_MINUTES` | No | `15` | In-memory cache TTL |
| `LOG_LEVEL` | No | `info` | `error`, `warn`, `info`, or `debug` |
| `LOG_FORMAT` | No | `auto` | `auto`, `json`, or `text` |
| `DASHBOARD_PORT` | No | `3000` | Dashboard server port |

## Usage

### 1. Costs command

```bash
cost-analyzer costs --period 3 --group-by service --format table
```

Sample output:

```text
Period: 2026-01-01..2026-03-31
Total: $1105.00 USD
┌───────────────┬──────────┬─────────┐
│ Dimension     │ Name     │ Cost    │
├───────────────┼──────────┼─────────┤
│ Service       │ Compute  │ $205.00 │
│ Service       │ Storage  │ $130.00 │
│ Service       │ Database │ $770.00 │
└───────────────┴──────────┴─────────┘
```

### 2. Detect command

```bash
cost-analyzer detect --resource-type all --threshold 75
```

### 3. Recommend command

```bash
cost-analyzer recommend --min-savings 50 --max-risk medium --limit 10
```

### 4. Dashboard command

```bash
cost-analyzer dashboard --port 3000 --open
```

Dashboard APIs:

- `GET /health`
- `GET /api/costs?period=3&groupBy=service`
- `GET /api/resources/idle`
- `GET /api/recommendations`
- `GET /api/summary`

### 5. Export command

Generates a static HTML report, with the same look as the dashboard, without requiring a running server — ideal for Azure Cloud Shell or hosting as a static site. The report itself is rendered in Brazilian Portuguese; only Azure resource and service names are kept in English.

```bash
cost-analyzer export --period 3 --output ./azure-cost-report.html
```

The generated file already has the data embedded (costs, idle resources, recommendations, executive summary, waste by owner, and the remediation plan) and can be opened directly in a browser or hosted on any static site (Azure Storage Static Website, App Service, etc.).

Without `--subscription`, every enabled subscription visible to the authenticated identity is analyzed and consolidated into the report. To scope it to a single subscription, use `--subscription <id>`.

#### Flags

| Flag | Description |
| --- | --- |
| `--period`, `-p` | Trailing months to analyze (1 to 12, default 1) |
| `--output`, `-o` | Output HTML file path |
| `--subscription`, `-s` | Restrict the analysis to a single subscription |
| `--compare`, `-c` | Path to a previous report (HTML or JSON) to diff against |
| `--owner-tags` | Comma-separated tag keys used to attribute waste to an owner |
| `--no-remediation` | Skip the remediation plan and the `apply-remediation.sh` script |

#### Remediation plan

An `apply-remediation.sh` file is written next to the HTML report. It **changes nothing by default**: it runs in dry-run mode and only prints the commands.

```bash
# 1. Review what would run
./apply-remediation.sh

# 2. Actually execute
APPLY=true ./apply-remediation.sh

# 3. Or apply to a single resource
APPLY=true ONLY=vm-web01 ./apply-remediation.sh
```

High-risk actions require the operator to type `CONFIRMO` before proceeding. Every block includes the rollback commands as comments.

#### Run-to-run comparison

Keep the generated reports and diff them to see how the environment evolves:

```bash
cost-analyzer export --period 1 --output ./report-august.html
# ... one month later ...
cost-analyzer export --period 1 --output ./report-september.html --compare ./report-august.html
```

The report then shows the total variation, the largest movements by service and resource group, and which idle resources appeared or were resolved.

#### Waste by owner

Waste is attributed to an owner from the resource tags (`owner`, `team`, `costCenter`, and others, case-insensitive). When no tag is present, the resource group is used as the ownership boundary. To use your own convention:

```bash
cost-analyzer export --owner-tags responsavel,cost-center
```

The report also shows owner tag coverage, the key maturity indicator for enabling internal chargeback.

## Roadmap

Planned differentiators:

- [ ] **Cost-in-Pull-Request GitHub Action** — comments the estimated cost impact of IaC changes before merge
- [ ] **Unit economics** — cost per customer, per request, or per environment, derived from tags and application metrics
- [ ] **Consolidated multi-tenant view** — a single report covering several tenants, for CSPs and MSPs
- [ ] **Scheduled Teams and Slack digest** — periodic summary with history published to a static site
- [ ] **Anomaly detection with root cause** — pinpoints which resource or resource group caused a spend spike
- [ ] **Commitment simulator** — compares Reserved Instances, Savings Plans, and Spot, including payback
- [ ] **FinOps maturity score** — a 0 to 100 score for the tenant, tracked across runs

## Dashboard screenshot

_Placeholder: add a screenshot of your connected frontend here._

## Architecture

```text
+-------------------+       +-----------------------+
| cost-analyzer CLI |------>| Service Layer         |
| oclif dispatcher  |       | - AzureClientService  |
+-------------------+       | - CostAnalyzerService |
         |                  | - ResourceDetector    |
         |                  | - OptimizerService    |
         v                  +-----------+-----------+
+-------------------+                   |
| Express Dashboard |-------------------+
| /api + static UI  |                   |
+-------------------+                   v
                                 +-------------+
                                 | Azure APIs  |
                                 +-------------+
```

## Development

```bash
npm install
npm run lint
npm run test:coverage
npm run build
```

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development workflow, testing expectations, and pull request guidance.
