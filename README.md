# Azure Cost Analyzer

O **Azure Cost Analyzer** é uma solução em **TypeScript** para análise de custos no Azure, com:

- **CLI** para análises e exportação de relatórios
- **dashboard** via **Express** para visualização rápida de KPIs
- foco em qualidade com **ESLint**, **Prettier**, **Vitest**, **TypeScript** e **GitHub Actions**

## Visão geral

O projeto permite:

- analisar custos por período e dimensão
- detectar recursos ociosos
- gerar sugestões de otimização
- exportar resultados em formatos úteis para operação

Principais comandos da CLI:

- `costs` (alias: `analyze`)
- `detect` (alias: `idle-resources`)
- `recommend` (alias: `optimize-suggestions`)
- `export` (atalho para exportar análise de custos)
- `dashboard`

## Pré-requisitos

- **Node.js** `>= 20`
- **npm**
- acesso ao Azure (somente para `DATA_MODE=azure`)

## Instalação

```bash
npm install
```

## Configuração (`.env.example`)

Copie o arquivo de exemplo e ajuste os valores:

```bash
cp .env.example .env
```

Variáveis principais:

- `DATA_MODE`: `mock` ou `azure`
- `AUTH_METHOD`: `cli`, `service-principal` ou `managed-identity`
- `AZURE_SUBSCRIPTION_ID`: obrigatório quando `DATA_MODE=azure`
- `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`: obrigatórias para `AUTH_METHOD=service-principal`
- `DASHBOARD_PORT`: porta do dashboard

## Execução em desenvolvimento

```bash
npm run dev
```

O script compila e inicia o comando `dashboard` na porta `3000`.

## Build e produção

Gerar artefatos:

```bash
npm run build
```

Executar a CLI compilada:

```bash
npm start
```

Exemplo em produção (CLI compilada):

```bash
node dist/cli/index.js analyze --period 3 --group-by service
```

## Qualidade e testes

Lint:

```bash
npm run lint
```

Formatação:

```bash
npm run format
```

Type safety:

```bash
npm run typecheck
```

Testes unitários/integrados:

```bash
npm test
```

Modo watch:

```bash
npm run test:watch
```

Cobertura:

```bash
npm run test:coverage
```

## Uso da CLI

### Análise de custos

```bash
cost-analyzer analyze --period 3 --group-by service --format table
```

### Recursos ociosos

```bash
cost-analyzer idle-resources --resource-type all --threshold 75 --format table
```

### Sugestões de otimização

```bash
cost-analyzer optimize-suggestions --min-savings 50 --max-risk medium --limit 10
```

### Exportação

```bash
cost-analyzer export --period 3 --group-by service --output ./reports/costs.csv
```

> O comando `export` exige `--output`. Se `--format` não for informado, o padrão é `csv`.

### Dashboard

```bash
cost-analyzer dashboard --port 3000 --open
```

## Uso do dashboard

Após iniciar o dashboard, abra `http://localhost:3000`.

KPIs básicos exibidos:

- custo total
- variação de custo
- top recursos
- recursos ociosos

APIs principais:

- `GET /health`
- `GET /api/costs?period=3&groupBy=service`
- `GET /api/resources/idle`
- `GET /api/recommendations`
- `GET /api/summary`

## Modo mock vs Azure real

### `DATA_MODE=mock`

- não exige conta Azure
- usa dados locais simulados para análise, recursos ociosos e dashboard
- ideal para desenvolvimento local e validação rápida

### `DATA_MODE=azure`

- usa APIs reais do Azure
- exige configuração correta de autenticação e `AZURE_SUBSCRIPTION_ID`

## CI com GitHub Actions

O workflow em `.github/workflows/ci.yml` executa em `push` e `pull_request`:

1. `npm install`
2. `npm run lint`
3. `npm run typecheck`
4. `npm test`
5. `npm run build`

## Troubleshooting

### `Unknown command`

Use:

```bash
cost-analyzer --help
```

### `The export command requires --output <path>`

Informe um arquivo de saída:

```bash
cost-analyzer export --output ./reports/costs.csv
```

### Erro de configuração Azure

- verifique `DATA_MODE`
- para `DATA_MODE=azure`, confirme `AZURE_SUBSCRIPTION_ID`
- para `AUTH_METHOD=service-principal`, confirme `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` e `AZURE_CLIENT_SECRET`

### Dashboard não inicia

- confira se a porta está livre
- altere com `--port` ou `DASHBOARD_PORT`

## Contribuição

Consulte [`CONTRIBUTING.md`](./CONTRIBUTING.md).
