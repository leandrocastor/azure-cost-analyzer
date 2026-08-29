# Azure Cost Analyzer

[Português (Brasil)](./README.md) | [English](./README.en.md)

Azure Cost Analyzer de nível empresarial com uma CLI em TypeScript e um dashboard baseado em Express para visibilidade de custos, detecção de anomalias, descoberta de recursos ociosos e recomendações de otimização.

## Funcionalidades

- Agregação via Azure Cost Management por serviço, grupo de recursos, localização ou tags
- Análise de tendência de custos, detecção de anomalias e previsão simples
- Detecção de recursos ociosos para VMs, App Services, Storage, SQL, discos, IPs públicos e load balancers
- Recomendações de otimização priorizadas com pontuação de ROI, risco e esforço
- API do dashboard em Express com placeholder de frontend estático
- TypeScript estrito, validação com Zod, logging com Winston, cobertura com Vitest, ESLint e Prettier

## Instalação

Há duas formas de executar o Azure Cost Analyzer, dependendo do seu cenário.

### Opção 1 — Instalação padrão (uso recorrente)

Ideal para máquinas de desenvolvimento ou ambientes onde você vai rodar o CLI com frequência.

```bash
npm install
npm run build
npm install -g .
```

### Opção 2 — Execução pontual via Azure Cloud Shell (sem instalar)

Ideal para uma análise rápida direto no Azure Cloud Shell, sem precisar clonar ou instalar nada permanentemente.

> **Importante:** use o Cloud Shell no modo **Bash** (não PowerShell) para rodar o comando abaixo.

```bash
npx --yes github:leandrocastor/azure-cost-analyzer export \
  --period 3 \
  --output "$HOME/clouddrive/azure-cost-report.html"
```

O `npx` baixa o repositório, executa o build automaticamente (via script `prepare`) e roda o comando `export` uma única vez. Como o Cloud Shell já está autenticado (`az login` implícito), a análise usa a mesma identidade da sessão.

**Não é necessário configurar `AZURE_SUBSCRIPTION_ID` nem `.env`:** se nenhuma assinatura for informada via `--subscription`, o comando `export` descobre automaticamente e analisa **todas as assinaturas habilitadas** às quais a identidade autenticada tem acesso no tenant, consolidando os custos, recursos ociosos e recomendações de todas elas em um único relatório.

Qualquer outro comando (`costs`, `detect`, `recommend`, `dashboard`) também pode ser executado da mesma forma, bastando trocar `export` pelo comando desejado — porém esses comandos exigem uma única assinatura (via `--subscription` ou `AZURE_SUBSCRIPTION_ID`).

## Configuração

Copie `.env.example` para `.env` e atualize os valores.

| Variável | Obrigatório | Padrão | Descrição |
| --- | --- | --- | --- |
| `AZURE_SUBSCRIPTION_ID` | Não | - | Subscription do Azure a ser analisada. Se omitida, o comando `export` descobre e analisa todas as assinaturas acessíveis; os demais comandos exigem `--subscription` |
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

### 5. Comando export

Gera um relatório HTML estático, com o mesmo visual do dashboard, mas sem precisar de um servidor rodando — ideal para Azure Cloud Shell ou para hospedar como site estático.

```bash
cost-analyzer export --period 3 --output ./azure-cost-report.html
```

O arquivo gerado já contém os dados incorporados (custos, recursos ociosos e recomendações) e pode ser aberto diretamente no navegador ou hospedado em qualquer site estático (Azure Storage Static Website, App Service, etc.).

Sem `--subscription`, todas as assinaturas habilitadas visíveis à identidade autenticada são analisadas e consolidadas no relatório. Para restringir a uma única assinatura, use `--subscription <id>`.

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
