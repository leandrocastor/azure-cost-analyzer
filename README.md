# Azure Cost Analyzer

Azure Cost Analyzer de nível empresarial com uma CLI em TypeScript e um dashboard com Express para visibilidade de custos, detecção de anomalias, descoberta de recursos ociosos e recomendações de otimização.

## Funcionalidades

- Agregação do Azure Cost Management por serviço, grupo de recursos, localização ou tags
- Análise de tendência de custos, detecção de anomalias e previsão simples
- Detecção de recursos ociosos para VMs, App Services, Storage, SQL, discos, IPs públicos e load balancers
- Recomendações priorizadas de otimização com pontuação de ROI, risco e esforço
- API do dashboard em Express com frontend estático provisório
- TypeScript estrito, validação com Zod, logs com Winston, cobertura com Vitest, ESLint e Prettier

## Instalação

```bash
npm install
npm run build
npm install -g .
```

## Configuração

Copie `.env.example` para `.env` e atualize os valores.

| Variável                | Obrigatória                                    | Padrão | Descrição                                        |
| ----------------------- | ---------------------------------------------- | ------ | ------------------------------------------------ |
| `AZURE_SUBSCRIPTION_ID` | Sim                                            | -      | Assinatura do Azure a ser analisada              |
| `AZURE_TENANT_ID`       | Apenas para service principal                  | -      | Tenant do Microsoft Entra                        |
| `AZURE_CLIENT_ID`       | Service principal ou managed identity opcional | -      | ID do cliente/aplicação                          |
| `AZURE_CLIENT_SECRET`   | Apenas para service principal                  | -      | Segredo do cliente                               |
| `AUTH_METHOD`           | Não                                            | `cli`  | `cli`, `service-principal` ou `managed-identity` |
| `CACHE_TTL_MINUTES`     | Não                                            | `15`   | TTL do cache em memória                          |
| `LOG_LEVEL`             | Não                                            | `info` | `error`, `warn`, `info` ou `debug`               |
| `LOG_FORMAT`            | Não                                            | `auto` | `auto`, `json` ou `text`                         |
| `DASHBOARD_PORT`        | Não                                            | `3000` | Porta do servidor do dashboard                   |

## Uso

### 1. Comando de custos

```bash
cost-analyzer costs --period 3 --group-by service --format table
```

Exemplo de saída:

```text
Período: 2026-01-01..2026-03-31
Total: $1105.00 USD
┌───────────────┬──────────┬─────────┐
│ Dimensão      │ Nome     │ Custo   │
├───────────────┼──────────┼─────────┤
│ Serviço       │ Compute  │ $205.00 │
│ Serviço       │ Storage  │ $130.00 │
│ Serviço       │ Database │ $770.00 │
└───────────────┴──────────┴─────────┘
```

### 2. Comando de detecção

```bash
cost-analyzer detect --resource-type all --threshold 75
```

### 3. Comando de recomendação

```bash
cost-analyzer recommend --min-savings 50 --max-risk medium --limit 10
```

### 4. Comando do dashboard

```bash
cost-analyzer dashboard --port 3000 --open
```

APIs do dashboard:

- `GET /health`
- `GET /api/costs?period=3&groupBy=service`
- `GET /api/resources/idle`
- `GET /api/recommendations`
- `GET /api/summary`

## Captura de tela do dashboard

_Marcador: adicione aqui uma captura de tela do frontend conectado._

## Arquitetura

```text
+-------------------+       +-----------------------+
| cost-analyzer CLI |------>| Camada de serviços    |
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

Scripts disponíveis:

- `npm run dev`
- `npm run build`
- `npm run start`
- `npm run lint`
- `npm run format`
- `npm test`
- `npm run test:watch`
- `npm run typecheck`

Fluxo básico:

```bash
npm install
npm run lint
npm run typecheck
npm test
npm run build
```

## Contribuição

Consulte [CONTRIBUTING.md](./CONTRIBUTING.md) para o fluxo de desenvolvimento, as expectativas de testes e as orientações para pull requests.
