# Azure Cost Analyzer

[Português (Brasil)](./README.md)

Enterprise-grade Azure Cost Analyzer with a TypeScript CLI and an Express-powered dashboard for cost visibility, anomaly detection, idle resource discovery, and optimization recommendations.

## Features

- Azure Cost Management aggregation by service, resource group, location, or tags
- Cost trend analysis, anomaly detection, and simple forecasting
- Idle resource detection for VMs, App Services, Storage, SQL, disks, public IPs, and load balancers
- Prioritized optimization recommendations with ROI, risk, and effort scoring
- Express dashboard API with static frontend placeholder
- Strict TypeScript, Zod validation, Winston logging, Vitest coverage, ESLint, and Prettier

## Installation

```bash
npm install
npm run build
npm install -g .
```

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
