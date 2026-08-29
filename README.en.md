# Azure Cost Analyzer

[Português (Brasil)](./README.md) | [English](./README.en.md)

Enterprise-grade Azure Cost Analyzer with a TypeScript CLI and an Express-powered dashboard for cost visibility, anomaly detection, idle resource discovery, and optimization recommendations.

## Features

- Azure Cost Management aggregation by service, resource group, location, or tags
- Cost trend analysis, anomaly detection, and simple forecasting
- Idle resource detection for VMs, App Services, Storage, SQL, disks, public IPs, and load balancers
- Prioritized optimization recommendations with ROI, risk, and effort scoring
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

Ideal for a quick analysis directly in Azure Cloud Shell, without cloning or permanently installing anything — in the same spirit as [Azure Resource Inventory (ARI)](https://github.com/microsoft/ARI), which runs with a single command after installing the module.

```bash
npx --yes github:leandrocastor/azure-cost-analyzer export \
  --period 3 \
  --output "$HOME/clouddrive/azure-cost-report.html"
```

`npx` downloads the repository, runs the build automatically (via the `prepare` script), and executes the `export` command once. Since Cloud Shell is already authenticated (implicit `az login`), the analysis uses the same session identity. Any other command (`costs`, `detect`, `recommend`, `dashboard`) can be run the same way — just swap `export` for the desired command.

## Configuration

Copy `.env.example` to `.env` and update the values.

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `AZURE_SUBSCRIPTION_ID` | Yes | - | Azure subscription to analyze |
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

Generates a static HTML report, with the same look as the dashboard, without requiring a running server — ideal for Azure Cloud Shell or hosting as a static site.

```bash
cost-analyzer export --period 3 --output ./azure-cost-report.html
```

The generated file already has the data embedded (costs, idle resources, and recommendations) and can be opened directly in a browser or hosted on any static site (Azure Storage Static Website, App Service, etc.).

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
