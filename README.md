# Azure Cost Analyzer

[English](./README.en.md)

Azure Cost Analyzer de nível empresarial com uma CLI em TypeScript e um dashboard baseado em Express para visibilidade de custos, detecção de anomalias, descoberta de recursos ociosos e recomendações de otimização.

## Funcionalidades

- Agregação via Azure Cost Management por serviço, grupo de recursos, localização ou tags
- Análise de tendência de custos, detecção de anomalias e previsão simples
- Detecção de recursos ociosos para VMs, App Services, Storage, SQL, discos, IPs públicos e load balancers
- Recomendações de otimização priorizadas com pontuação de ROI, risco e esforço
- API do dashboard em Express com placeholder de frontend estático
- TypeScript estrito, validação com Zod, logging com Winston, cobertura com Vitest, ESLint e Prettier

## Instalação

```bash
npm install
npm run build
npm install -g .
```

## Configuração

Copie `.env.example` para `.env` e atualize os valores.

| Variável | Obrigatório | Padrão | Descrição |
| --- | --- | --- | --- |
| `AZURE_SUBSCRIPTION_ID` | Sim | - | Subscription do Azure a ser analisada |
| `AZURE_TENANT_ID` | Somente service principal | - | Tenant do Microsoft Entra |
| `AZURE_CLIENT_ID` | Service principal ou managed identity opcional | - | Id do client/application |
| `AZURE_CLIENT_SECRET` | Somente service principal | - | Client secret |
| `AUTH_METHOD` | Não | `cli` | `cli`, `service-principal` ou `managed-identity` |
| `CACHE_TTL_MINUTES` | Não | `15` | TTL do cache em memória |
| `LOG_LEVEL` | Não | `info` | `error`, `warn`, `info` ou `debug` |
| `LOG_FORMAT` | Não | `auto` | `auto`, `json` ou `text` |
| `DASHBOARD_PORT` | Não | `3000` | Porta do servidor do dashboard |

## Uso

### 1. Comando costs

```bash
cost-analyzer costs --period 3 --group-by service --format table
```

Exemplo de saída:

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

### 2. Comando detect

```bash
cost-analyzer detect --resource-type all --threshold 75
```

### 3. Comando recommend

```bash
cost-analyzer recommend --min-savings 50 --max-risk medium --limit 10
```

### 4. Comando dashboard

```bash
cost-analyzer dashboard --port 3000 --open
```

APIs do dashboard:

- `GET /health`
- `GET /api/costs?period=3&groupBy=service`
- `GET /api/resources/idle`
- `GET /api/recommendations`
- `GET /api/summary`

## Screenshot do dashboard

_Placeholder: adicione aqui uma screenshot do seu frontend conectado._

## Arquitetura

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

## Desenvolvimento

```bash
npm install
npm run lint
npm run test:coverage
npm run build
```

## Contribuindo

Veja [CONTRIBUTING.md](./CONTRIBUTING.md) para o fluxo de desenvolvimento, expectativas de testes e orientações de pull request.
