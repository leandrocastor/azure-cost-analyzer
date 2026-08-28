# Azure Cost Analyzer

Azure Cost Analyzer de nível corporativo com CLI em TypeScript e dashboard com Express para visibilidade de custos, detecção de anomalias, descoberta de recursos ociosos e recomendações de otimização.

## Funcionalidades

- Agregação do Azure Cost Management por serviço, grupo de recursos, localização ou tags
- Análise de tendência de custos, detecção de anomalias e previsão simples
- Detecção de recursos ociosos para VMs, App Services, Storage, SQL, discos, IPs públicos e load balancers
- Recomendações priorizadas de otimização com pontuação de ROI, risco e esforço
- API do dashboard com Express e frontend estático inicial
- TypeScript estrito, validação com Zod, logs com Winston, cobertura com Vitest, ESLint e Prettier

## Instalação

```bash
npm install
npm run build
npm install -g .
```

## Configuração

Copie `.env.example` para `.env` e atualize os valores.

| Variável | Obrigatória | Padrão | Descrição |
| --- | --- | --- | --- |
| `AZURE_SUBSCRIPTION_ID` | Sim | - | Assinatura Azure a ser analisada |
| `AZURE_TENANT_ID` | Somente service principal | - | Tenant do Microsoft Entra |
| `AZURE_CLIENT_ID` | Service principal ou managed identity opcional | - | ID do cliente/aplicação |
| `AZURE_CLIENT_SECRET` | Somente service principal | - | Segredo do cliente |
| `AUTH_METHOD` | Não | `cli` | `cli`, `service-principal` ou `managed-identity` |
| `CACHE_TTL_MINUTES` | Não | `15` | TTL do cache em memória |
| `LOG_LEVEL` | Não | `info` | `error`, `warn`, `info` ou `debug` |
| `LOG_FORMAT` | Não | `auto` | `auto`, `json` ou `text` |
| `DASHBOARD_PORT` | Não | `3000` | Porta do servidor do dashboard |

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
│ Serviço       │ Computação | $205.00 │
│ Serviço       │ Armazenamento | $130.00 │
│ Serviço       │ Banco de dados | $770.00 │
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

### 4. Comando de dashboard

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

_Espaço reservado: adicione aqui uma captura de tela do frontend conectado._

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
| Dashboard Express |-------------------+
| /api + UI estática|                   |
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

## Contribuição

Veja [CONTRIBUTING.md](./CONTRIBUTING.md) para fluxo de desenvolvimento, expectativas de test e orientações de pull request.
