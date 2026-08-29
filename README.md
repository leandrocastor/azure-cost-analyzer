# Azure Cost Analyzer

[Português (Brasil)](./README.md) | [English](./README.en.md)

Azure Cost Analyzer de nível empresarial com uma CLI em TypeScript e um dashboard baseado em Express para visibilidade de custos, detecção de anomalias, descoberta de recursos ociosos e recomendações de otimização.

## Funcionalidades

- Agregação via Azure Cost Management por serviço, grupo de recursos, localização ou tags
- Análise de tendência de custos, detecção de anomalias e previsão simples
- Detecção de recursos ociosos para VMs, App Services, Storage, SQL, discos, IPs públicos e load balancers
- Recomendações de otimização priorizadas com pontuação de ROI, risco e esforço
- **Sumário executivo automático** em linguagem natural, no topo do relatório
- **Plano de remediação executável**: comandos `az` prontos, com verificação prévia, rollback e trechos equivalentes em Terraform e Bicep, mais um script `apply-remediation.sh` que roda em modo simulação por padrão
- **Comparativo entre execuções** (cost diff): o que mudou desde o último relatório e qual service ou resource group causou a variação
- **Desperdício por responsável** (showback/chargeback): atribuição do desperdício via tags de owner/team/cost center, com indicador de cobertura de tags
- **Economia calculada com preço real do Azure**: as estimativas vêm da Retail Prices API na moeda de faturamento, e não de médias fixas por tipo de recurso
- **Evidência auditável em cada achado**: janela de observação, número de pontos coletados, métricas usadas, origem do preço e nível de confiança
- **Scorecard do Well-Architected Framework** (pilar Cost Optimization): nota de 0 a 100, conceito de A a E e oito controles avaliados individualmente
- **Custo da inação**: ao comparar com um relatório anterior, mostra quanto cada recomendação ignorada já custou e quanto custará em 12 meses
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

#### Cota de consultas do Cost Management (QPU)

A API de Cost Management do Azure cobra cada consulta em **QPU (Query Processing Units)**: aproximadamente **1 QPU por mês de dados solicitado**. Os limites são **por tenant**:

| Janela | Limite |
| --- | --- |
| 10 segundos | 12 QPU |
| 1 minuto | 60 QPU |
| 1 hora | 600 QPU |

Ou seja, 4 assinaturas com `--period 3` consomem 12 QPU e estouram a janela de 10 segundos. O comando **respeita essa cota automaticamente**, pausando entre as consultas e aguardando o tempo indicado pelo próprio Azure quando recebe um HTTP 429 — por isso execuções com muitas assinaturas podem levar alguns minutos. O spinner informa quando a espera é por cota.

Se preferir acelerar, reduza o `--period` ou limite as assinaturas com `--subscription`.

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

O arquivo gerado já contém os dados incorporados (custos, recursos ociosos, recomendações, sumário executivo, desperdício por responsável e plano de remediação) e pode ser aberto diretamente no navegador ou hospedado em qualquer site estático (Azure Storage Static Website, App Service, etc.).

Sem `--subscription`, todas as assinaturas habilitadas visíveis à identidade autenticada são analisadas e consolidadas no relatório. Para restringir a uma única assinatura, use `--subscription <id>`.

#### Flags

| Flag | Descrição |
| --- | --- |
| `--period`, `-p` | Meses retroativos a analisar (1 a 12, padrão 1) |
| `--output`, `-o` | Caminho do arquivo HTML de saída |
| `--subscription`, `-s` | Restringe a análise a uma única assinatura |
| `--compare`, `-c` | Caminho de um relatório anterior (HTML ou JSON) para gerar o comparativo |
| `--owner-tags` | Tags usadas para atribuir o desperdício a um responsável, separadas por vírgula |
| `--no-remediation` | Não gera o plano de remediação nem o script `apply-remediation.sh` |
| `--currency` | Moeda usada na consulta de preços de lista (padrão: a moeda de faturamento da assinatura) |

#### Plano de remediação

Junto ao HTML é gravado um `apply-remediation.sh` no mesmo diretório. Ele **não altera nada por padrão**: roda em modo simulação e apenas imprime os comandos.

```bash
# 1. Revise o que seria executado
./apply-remediation.sh

# 2. Execute de verdade
APPLY=true ./apply-remediation.sh

# 3. Ou aplique em um único recurso
APPLY=true ONLY=vm-web01 ./apply-remediation.sh
```

Ações classificadas como risco alto exigem que o operador digite `CONFIRMO` antes de prosseguir. Cada bloco inclui os comandos de rollback como comentário.

#### Comparativo entre execuções

Guarde os relatórios gerados e compare-os para ver a evolução do ambiente:

```bash
cost-analyzer export --period 1 --output ./relatorio-agosto.html
# ... um mês depois ...
cost-analyzer export --period 1 --output ./relatorio-setembro.html --compare ./relatorio-agosto.html
```

O relatório passa a exibir a variação total, os maiores movimentos por service e por resource group, além dos recursos ociosos que surgiram ou foram resolvidos.

#### Desperdício por responsável

O desperdício é atribuído ao responsável a partir das tags do recurso (`owner`, `team`, `costCenter`, entre outras, sem diferenciar maiúsculas de minúsculas). Quando não há tag, o resource group é usado como fronteira de responsabilidade. Para usar uma convenção própria:

```bash
cost-analyzer export --owner-tags responsavel,centro-de-custo
```

O relatório também mostra a cobertura de tags de responsável, que é o principal indicador de maturidade para viabilizar cobrança interna.

#### Preço real e evidência

A economia estimada de cada achado é resolvida na [Azure Retail Prices API](https://learn.microsoft.com/rest/api/cost-management/retail-prices/azure-retail-prices), que é pública, não exige autenticação e não consome a cota do tenant. Um disco Premium de 128 GB é cobrado pelo tier P10, e uma VM `Standard_D2s_v3` custa muito mais do que uma `Standard_B1s` — a diferença aparece no relatório em vez de ser achatada em uma média.

Cada achado carrega a evidência que o sustenta:

| Campo | Significado |
| --- | --- |
| Janela de observação | Por quantos dias o recurso foi observado |
| Pontos coletados | Quantas amostras de métrica embasam a conclusão |
| Métricas | Os valores medidos, com unidade |
| Base do cálculo | `retail-price` (preço de lista) ou `heuristic` (média aproximada) |
| Confiança | `high`, `medium` ou `low` |

> Os valores são **preços de lista públicos**. Descontos de Enterprise Agreement, CSP, reservas e Savings Plans não são refletidos, então a economia real tende a ser menor do que a exibida. Quando a SKU ou a região não tem meter correspondente, o relatório cai para a média aproximada e marca o achado com base `heuristic` e confiança reduzida.

#### Precisão da detecção

Um relatório de FinOps só é útil se cada achado resistir ao contraditório do time de infraestrutura. Estas regras existem para eliminar falsos positivos:

| Situação | Como é tratada |
| --- | --- |
| Disco anexado a uma VM desligada | **Não** é órfão. O Azure marca esse disco como `Reserved`, e apenas `Unattached` é considerado órfão |
| VM desligada (`deallocated`) | Não é sugerida para desligar (o compute já custa zero). Vira o achado "VM desligada com discos ainda cobrados", com economia calculada pelo preço real dos discos |
| Recurso sem amostras de métrica | Ignorado. Uma série vazia significa "nunca medido" — recurso recém-criado, tier que não emite a métrica ou falta de Monitoring Reader — e não "ocioso". São exigidas ao menos 3 amostras |
| Public IP Basic dinâmico | Ignorado: não é cobrado |
| Load Balancer Basic | Ignorado: não é cobrado |
| App Service em tier Free, Shared, Dynamic ou FlexConsumption | Ignorado: não há custo fixo a economizar |
| Banco `master` do Azure SQL | Ignorado: é um banco de sistema |
| Public IP associado a NAT Gateway ou Prefix | Não é órfão, mesmo sem `ipConfiguration` |

A economia exibida também é fiel: quando o preço de lista é resolvido, ele é usado **literalmente**, sem multiplicadores ou pisos artificiais que inflavam os valores.

#### Scorecard do Well-Architected Framework

O relatório atribui uma nota de 0 a 100 ao pilar **Cost Optimization**, avaliando oito controles: proporção de desperdício, recursos órfãos, tags de responsável, tags de ambiente, rightsizing, visibilidade de custos, concentração de gasto e acionabilidade das recomendações. Controles que não podem ser medidos no ambiente são excluídos do cálculo em vez de baixarem a nota silenciosamente.

#### Custo da inação

Quando o relatório é gerado com `--compare`, as recomendações que continuam em aberto deixam de ser sugestões e passam a ser dívida quantificada: "este disco está ocioso há 90 dias e já custou R$ 524,79". O relatório mostra também quantas recomendações foram resolvidas no período e a projeção de desperdício para 12 meses caso nada mude.

```bash
cost-analyzer export --period 1 --output ./relatorio-setembro.html --compare ./relatorio-agosto.html
```

## Roadmap

Próximos diferenciais planejados:

- [ ] **GitHub Action de custo em Pull Request** — comenta no PR o impacto estimado das mudanças de IaC antes do merge
- [ ] **Unit economics** — custo por cliente, por requisição ou por ambiente, a partir de tags e métricas de aplicação
- [ ] **Visão multi-tenant consolidada** — um único relatório cobrindo vários tenants, para CSPs e MSPs
- [ ] **Digest agendado no Teams e no Slack** — resumo periódico com histórico publicado em site estático
- [ ] **Detecção de anomalias com causa raiz** — identifica qual recurso ou resource group provocou o pico de gasto
- [ ] **Simulador de compromissos** — compara Reserved Instances, Savings Plans e Spot, com cálculo de payback
- [ ] **Score de maturidade FinOps** — nota de 0 a 100 para o tenant, com comparação entre execuções
- [ ] **MCP Server** — expõe os achados como ferramentas para agentes de IA, permitindo perguntar "por que meu custo subiu?" direto no GitHub Copilot ou no Claude. Exige instalação local com um cliente MCP (VS Code, Claude Desktop) e, por isso, **não funciona na execução pontual via Azure Cloud Shell**

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
