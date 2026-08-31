import type { ActionType, IdleResource, Recommendation, RemediationPlan, RemediationStep } from '@/models';
import { RemediationPlanSchema } from '@/models';

/**
 * Parts extracted from a fully-qualified Azure resource id.
 */
type ResourceCoordinates = {
  subscriptionId: string;
  resourceGroup: string;
  provider: string;
  resourceType: string;
  name: string;
};

const UNKNOWN = 'unknown';

/**
 * Extracts subscription, resource group, provider and name from an ARM resource id.
 * Falls back to placeholders so the generated scripts stay readable even when the
 * detector produced a partial id.
 */
const parseResourceId = (resourceId: string): ResourceCoordinates => {
  const segments = resourceId.split('/').filter(Boolean);
  const read = (key: string): string | undefined => {
    const index = segments.findIndex((segment) => segment.toLowerCase() === key);
    return index >= 0 ? segments[index + 1] : undefined;
  };

  const providerIndex = segments.findIndex((segment) => segment.toLowerCase() === 'providers');
  const provider = providerIndex >= 0 ? (segments[providerIndex + 1] ?? UNKNOWN) : UNKNOWN;
  const resourceType = providerIndex >= 0 ? (segments[providerIndex + 2] ?? UNKNOWN) : UNKNOWN;

  return {
    subscriptionId: read('subscriptions') ?? UNKNOWN,
    resourceGroup: read('resourcegroups') ?? UNKNOWN,
    provider,
    resourceType,
    name: segments.at(-1) ?? UNKNOWN,
  };
};

/**
 * Quotes a value for safe interpolation inside the generated Bash scripts.
 */
const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

const step = (description: string, command: string): RemediationStep => ({ description, command });

/**
 * Turns recommendations into ready-to-run remediation plans: pre-checks that
 * validate the assumption, the apply commands themselves, a rollback path and
 * equivalent Terraform/Bicep snippets for teams that manage infra as code.
 *
 * Everything is generated offline from data already collected, so it works in
 * Azure Cloud Shell without extra permissions.
 */
export class RemediationService {
  /**
   * Builds a remediation plan for every recommendation that maps to a known resource.
   */
  public buildPlans(recommendations: Recommendation[], idleResources: IdleResource[]): RemediationPlan[] {
    const byResourceId = new Map(idleResources.map((idle) => [idle.resource.id, idle]));

    return recommendations.map((recommendation) => {
      const idle = byResourceId.get(recommendation.resourceId);
      const coordinates = parseResourceId(recommendation.resourceId);
      const name = idle?.resource.name ?? coordinates.name;
      const resourceGroup = idle?.resource.resourceGroup ?? coordinates.resourceGroup;

      return RemediationPlanSchema.parse({
        recommendationId: recommendation.id,
        resourceId: recommendation.resourceId,
        resourceName: name,
        resourceGroup,
        subscriptionId: coordinates.subscriptionId,
        actionType: recommendation.actionType,
        risk: recommendation.risk,
        summary: this.describe(recommendation.actionType, name),
        monthlySavings: recommendation.monthlySavings,
        requiresDowntime: this.requiresDowntime(recommendation.actionType),
        preChecks: this.buildPreChecks(recommendation, coordinates),
        apply: this.buildApplySteps(recommendation, coordinates),
        rollback: this.buildRollbackSteps(recommendation, coordinates),
        iac: {
          terraform: this.buildTerraform(recommendation, coordinates),
          bicep: this.buildBicep(recommendation, coordinates),
        },
        impactAnalysis: this.buildImpactAnalysis(recommendation, coordinates, name),
        successCriteria: this.buildSuccessCriteria(recommendation, coordinates, name),
        whenNotToRun: this.buildWhenNotToRun(recommendation, coordinates, name),
      });
    });
  }

  /**
   * Renders the plans as a single idempotent Bash script with dry-run by default.
   * The operator reviews it, then re-runs with APPLY=true to execute.
   */
  public buildApplyScript(plans: RemediationPlan[]): string {
    const header = [
      '#!/usr/bin/env bash',
      '# Plano de remediação gerado pelo Azure Cost Analyzer.',
      '# Revise cada bloco antes de executar. Nada é aplicado sem APPLY=true.',
      '#',
      '#   Simulação (padrão): ./apply-remediation.sh',
      '#   Execução real:      APPLY=true ./apply-remediation.sh',
      '#   Um recurso apenas:  APPLY=true ONLY=nome-do-recurso ./apply-remediation.sh',
      '',
      'set -Eeuo pipefail',
      '',
      'APPLY="${APPLY:-false}"',
      'ONLY="${ONLY:-}"',
      '',
      'run() {',
      '  if [[ "$APPLY" == "true" ]]; then',
      '    echo "  -> executando: $*"',
      '    "$@"',
      '  else',
      '    echo "  -> [simulação] $*"',
      '  fi',
      '}',
      '',
      'skip_resource() {',
      '  [[ -n "$ONLY" && "$ONLY" != "$1" ]]',
      '}',
      '',
      'if [[ "$APPLY" != "true" ]]; then',
      '  echo "=== MODO SIMULAÇÃO — nenhuma alteração será aplicada ==="',
      'fi',
      '',
    ].join('\n');

    const blocks = plans.map((plan) => this.renderScriptBlock(plan)).join('\n');
    const totalMonthly = plans.reduce((sum, plan) => sum + plan.monthlySavings, 0);
    const footer = [
      '',
      `echo "=== Concluído. Economia mensal potencial: ${totalMonthly.toFixed(2)} ==="`,
      'if [[ "$APPLY" != "true" ]]; then',
      '  echo "Nada foi alterado. Rode novamente com APPLY=true para aplicar."',
      'fi',
      '',
    ].join('\n');

    return `${header}${blocks}${footer}`;
  }

  private renderScriptBlock(plan: RemediationPlan): string {
    const lines: string[] = [
      `# ─────────────────────────────────────────────────────────────`,
      `# ${plan.resourceName} — ${plan.actionType} (risco: ${plan.risk})`,
      `# ${plan.summary}`,
      `# Economia mensal estimada: ${plan.monthlySavings.toFixed(2)}`,
      plan.requiresDowntime ? '# ATENÇÃO: esta ação causa indisponibilidade do recurso.' : '# Sem indisponibilidade esperada.',
      `if skip_resource ${shellQuote(plan.resourceName)}; then`,
      `  echo "-- pulando ${plan.resourceName}"`,
      'else',
      `  echo "== ${plan.resourceName} (${plan.actionType}) =="`,
    ];

    for (const preCheck of plan.preChecks) {
      lines.push(`  # verificação: ${preCheck.description}`, `  ${preCheck.command}`);
    }

    if (plan.risk === 'high') {
      lines.push(
        '  if [[ "$APPLY" == "true" ]]; then',
        `    read -r -p "  Ação de RISCO ALTO em ${plan.resourceName}. Digite CONFIRMO para continuar: " answer`,
        '    if [[ "$answer" != "CONFIRMO" ]]; then echo "  -> ignorado pelo operador"; answer=""; fi',
        '  fi',
      );
    }

    for (const applyStep of plan.apply) {
      lines.push(`  # ${applyStep.description}`, `  run ${applyStep.command}`);
    }

    lines.push('  # Rollback (execute manualmente se necessário):');
    for (const rollbackStep of plan.rollback) {
      lines.push(`  #   ${rollbackStep.description}: ${rollbackStep.command}`);
    }

    lines.push('fi', '');
    return `${lines.join('\n')}\n`;
  }

  private describe(actionType: ActionType, name: string): string {
    const templates: Record<ActionType, string> = {
      DELETE: `Excluir o recurso ${name}, que não apresenta utilização relevante.`,
      DOWNSIZE: `Reduzir o porte de ${name} para um SKU menor compatível com a demanda observada.`,
      CHANGE_SKU: `Migrar ${name} para um SKU/tier de menor custo.`,
      SCHEDULE: `Agendar a desalocação de ${name} fora do horário comercial, interrompendo a cobrança de computação.`,
      MIGRATE: `Migrar ${name} para uma opção de menor custo (tier serverless ou consumo).`,
      CLEANUP: `Remover ${name}, um recurso órfão que continua sendo cobrado.`,
    };
    return templates[actionType];
  }

  private requiresDowntime(actionType: ActionType): boolean {
    return actionType === 'DELETE' || actionType === 'DOWNSIZE' || actionType === 'MIGRATE' || actionType === 'SCHEDULE';
  }

  private buildPreChecks(recommendation: Recommendation, coordinates: ResourceCoordinates): RemediationStep[] {
    const scope = `--ids ${shellQuote(recommendation.resourceId)}`;
    const checks: RemediationStep[] = [
      step(
        'Confirma que o recurso ainda existe e mostra seu estado atual',
        `az resource show ${scope} --query "{nome:name, tipo:type, local:location, sku:sku}" -o jsonc || true`,
      ),
      step(
        'Lista bloqueios que impediriam a alteração',
        `az lock list ${scope} -o table || true`,
      ),
    ];

    if (recommendation.actionType === 'DELETE' || recommendation.actionType === 'CLEANUP') {
      checks.push(
        step(
          'Verifica dependências antes de excluir',
          `az resource show ${scope} --query "properties" -o jsonc || true`,
        ),
      );
    }

    if (coordinates.resourceType.toLowerCase() === 'virtualmachines') {
      checks.push(
        step(
          'Mostra a média de CPU dos últimos 7 dias para validar a ociosidade',
          `az monitor metrics list ${scope} --metric "Percentage CPU" --aggregation Average --interval PT1H --start-time "$(date -u -d '7 days ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-7d +%Y-%m-%dT%H:%M:%SZ)" --query "value[0].timeseries[0].data[-24:]" -o table || true`,
        ),
      );
    }

    if (coordinates.resourceType.toLowerCase() === 'serverfarms' && recommendation.actionType === 'DELETE') {
      checks.push(
        step(
          'Confirma que o plano continua sem nenhum aplicativo antes de excluí-lo: um valor diferente de 0 aqui significa que a recomendação está desatualizada',
          `az appservice plan show ${scope} --query "numberOfSites" -o tsv`,
        ),
      );
    }

    return checks;
  }

  private buildApplySteps(recommendation: Recommendation, coordinates: ResourceCoordinates): RemediationStep[] {
    const id = shellQuote(recommendation.resourceId);
    const group = shellQuote(coordinates.resourceGroup);
    const name = shellQuote(coordinates.name);
    const subscription = shellQuote(coordinates.subscriptionId);
    const isVirtualMachine = coordinates.resourceType.toLowerCase() === 'virtualmachines';
    const isAppService = coordinates.resourceType.toLowerCase() === 'sites';

    const backup = step(
      'Salva o estado atual do recurso para permitir rollback',
      `bash -c "az resource show --ids ${id} -o json > ${shellQuote(`backup-${coordinates.name}.json`)}"`,
    );

    switch (recommendation.actionType) {
      case 'DELETE':
      case 'CLEANUP':
        return [
          backup,
          step('Remove o recurso', `az resource delete --ids ${id} --verbose`),
        ];

      case 'DOWNSIZE':
        if (isVirtualMachine) {
          return [
            backup,
            step(
              'Lista os tamanhos compatíveis para escolher o novo SKU',
              `az vm list-vm-resize-options --ids ${id} --query "[].name" -o tsv | head -20`,
            ),
            step(
              'Aplica o novo tamanho (ajuste NOVO_SKU antes de executar)',
              `az vm resize --ids ${id} --size "\${NOVO_SKU:-Standard_B2s}"`,
            ),
          ];
        }

        // O custo do App Service está no App Service Plan, que reserva instâncias de VM.
        // Alterar o SKU do site não existe como operação e não reduziria a fatura: o
        // que precisa ser redimensionado é o plano ao qual o site pertence.
        if (isAppService) {
          return [
            backup,
            step(
              'Identifica o App Service Plan que gera a cobrança deste site',
              `az webapp show --subscription ${subscription} --resource-group ${group} --name ${name} --query serverFarmId -o tsv`,
            ),
            step(
              'Verifica quantos aplicativos compartilham o plano antes de redimensioná-lo',
              `az appservice plan show --ids "$(az webapp show --subscription ${subscription} --resource-group ${group} --name ${name} --query serverFarmId -o tsv)" --query "{sku:sku.name, apps:numberOfSites, workers:sku.capacity}" -o jsonc`,
            ),
            step(
              'Reduz o tier do plano (ajuste NOVO_SKU antes de executar)',
              `az appservice plan update --ids "$(az webapp show --subscription ${subscription} --resource-group ${group} --name ${name} --query serverFarmId -o tsv)" --sku "\${NOVO_SKU:-B1}"`,
            ),
          ];
        }

        return [
          backup,
          step(
            'Reduz a capacidade provisionada (ajuste NOVO_SKU antes de executar)',
            `az resource update --ids ${id} --set sku.name="\${NOVO_SKU:-B1}"`,
          ),
        ];

      case 'CHANGE_SKU':
        return [
          backup,
          step(
            'Altera o tier/SKU do recurso (ajuste NOVO_SKU antes de executar)',
            `az resource update --ids ${id} --set sku.name="\${NOVO_SKU:-Standard}"`,
          ),
        ];

      case 'SCHEDULE':
        // Agendamento só reduz custo onde parar o recurso interrompe a cobrança, o que
        // vale para a desalocação de uma VM. Para serviços cobrados por capacidade
        // reservada, como o App Service, parar o recurso não altera a fatura, então
        // nenhum comando é emitido em vez de sugerir uma ação sem efeito financeiro.
        return isVirtualMachine
          ? [
              step(
                'Cria o agendamento de desligamento automático às 19h',
                `az vm auto-shutdown --subscription ${subscription} --resource-group ${group} --name ${name} --time 1900`,
              ),
            ]
          : [
              step(
                'Revise o modelo de cobrança antes de agendar: parar este recurso não interrompe a cobrança de capacidade reservada',
                `az resource show --ids ${id} -o jsonc`,
              ),
            ];

      case 'MIGRATE':
      default:
        return [
          backup,
          step(
            'Exporta o template atual como ponto de partida da migração',
            `az group export --subscription ${subscription} --name ${group} --resource-ids ${id} > ${shellQuote(`migracao-${coordinates.name}.json`)}`,
          ),
          step(
            'Revise o template exportado e aplique o novo tier de menor custo',
            `echo "Edite ${shellQuote(`migracao-${coordinates.name}.json`)} e implante com: az deployment group create -g ${group} --template-file ${shellQuote(`migracao-${coordinates.name}.json`)}"`,
          ),
        ];
    }
  }

  private buildRollbackSteps(recommendation: Recommendation, coordinates: ResourceCoordinates): RemediationStep[] {
    const id = shellQuote(recommendation.resourceId);
    const group = shellQuote(coordinates.resourceGroup);
    const name = shellQuote(coordinates.name);
    const subscription = shellQuote(coordinates.subscriptionId);
    const backupFile = shellQuote(`backup-${coordinates.name}.json`);

    switch (recommendation.actionType) {
      case 'DELETE':
      case 'CLEANUP':
        return [
          step(
            'Recria o recurso a partir do backup gerado antes da exclusão',
            `az deployment group create --subscription ${subscription} --resource-group ${group} --template-file ${backupFile}`,
          ),
        ];

      case 'DOWNSIZE':
      case 'CHANGE_SKU':
        return [
          step(
            'Restaura o SKU original registrado no backup',
            `az resource update --ids ${id} --set sku.name="$(jq -r '.sku.name' ${backupFile})"`,
          ),
        ];

      case 'SCHEDULE':
        return [
          step(
            'Remove o agendamento e religa o recurso',
            `az vm auto-shutdown --subscription ${subscription} --resource-group ${group} --name ${name} --off`,
          ),
        ];

      case 'MIGRATE':
      default:
        return [
          step(
            'Mantenha o recurso original ativo até validar a migração; em caso de falha, redirecione o tráfego de volta',
            `az resource show --ids ${id} -o jsonc`,
          ),
        ];
    }
  }

  private buildTerraform(recommendation: Recommendation, coordinates: ResourceCoordinates): string {
    const address = coordinates.name.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase() || 'recurso';

    if (recommendation.actionType === 'DELETE' || recommendation.actionType === 'CLEANUP') {
      return [
        `# Remova o bloco do recurso "${coordinates.name}" do seu código e rode:`,
        `#   terraform plan -destroy -target=<tipo>.${address}`,
        `# Se o recurso ainda não está no state, importe antes de destruir:`,
        `#   terraform import <tipo>.${address} "${recommendation.resourceId}"`,
      ].join('\n');
    }

    if (coordinates.resourceType.toLowerCase() === 'virtualmachines') {
      return [
        `resource "azurerm_linux_virtual_machine" "${address}" {`,
        `  name                = "${coordinates.name}"`,
        `  resource_group_name = "${coordinates.resourceGroup}"`,
        '',
        '  # Antes: SKU superdimensionado para a carga observada.',
        '  size = var.novo_sku # ex.: "Standard_B2s"',
        '',
        '  # Demais atributos permanecem inalterados.',
        '}',
      ].join('\n');
    }

    return [
      `# Ajuste o SKU do recurso "${coordinates.name}" no seu módulo Terraform:`,
      `resource "<tipo>" "${address}" {`,
      `  name                = "${coordinates.name}"`,
      `  resource_group_name = "${coordinates.resourceGroup}"`,
      '',
      '  sku_name = var.novo_sku # tier de menor custo',
      '}',
    ].join('\n');
  }

  private buildBicep(recommendation: Recommendation, coordinates: ResourceCoordinates): string {
    const symbol = coordinates.name.replace(/[^a-zA-Z0-9]/g, '') || 'recurso';

    if (recommendation.actionType === 'DELETE' || recommendation.actionType === 'CLEANUP') {
      return [
        `// Remova a declaração de "${coordinates.name}" do template e implante em modo Complete:`,
        `//   az deployment group create -g ${coordinates.resourceGroup} --mode Complete --template-file main.bicep`,
        '// Atenção: o modo Complete remove tudo que não estiver declarado no template.',
      ].join('\n');
    }

    return [
      `param novoSku string = 'Standard_B2s'`,
      '',
      `resource ${symbol} '${coordinates.provider}/${coordinates.resourceType}@2023-07-01' existing = {`,
      `  name: '${coordinates.name}'`,
      '}',
      '',
      '// Declare o recurso com o novo SKU no template principal:',
      `//   sku: { name: novoSku }`,
    ].join('\n');
  }

  /**
   * Describes what breaks if the action goes wrong, so an operator reviewing the
   * playbook understands the blast radius before typing APPLY=true.
   */
  private buildImpactAnalysis(
    recommendation: Recommendation,
    coordinates: ResourceCoordinates,
    name: string,
  ): string {
    const downtimeNote = this.requiresDowntime(recommendation.actionType)
      ? 'Esta ação causa indisponibilidade do recurso durante a execução.'
      : 'Esta ação não interrompe o recurso, mas altera sua configuração de cobrança.';

    const templates: Record<ActionType, string> = {
      DELETE: `A exclusão de ${name} é destrutiva: dados e configuração são perdidos, exceto o que estiver salvo no backup gerado pelo script. Qualquer aplicação ou processo que ainda dependa deste recurso (mesmo sem tráfego visível na janela observada) para de funcionar imediatamente.`,
      DOWNSIZE: `Reduzir o porte de ${name} diminui a capacidade de CPU/memória/IOPS disponível. Se a ociosidade observada não cobrir picos sazonais (fechamento de mês, campanhas), o recurso pode ficar subdimensionado após a mudança.`,
      CHANGE_SKU: `A troca de SKU/tier de ${name} pode remover recursos do tier atual (SLA, redundância, features) que a aplicação dependa, mesmo que o custo caia.`,
      SCHEDULE: `Agendar o desligamento de ${name} interrompe qualquer processo em execução no horário programado, incluindo jobs, sessões de usuário ou integrações que rodem fora do horário comercial.`,
      MIGRATE: `Migrar ${name} exige revalidar strings de conexão, identidades gerenciadas e regras de rede; uma migração incompleta pode deixar aplicações apontando para o recurso antigo.`,
      CLEANUP: `${name} aparenta ser um recurso órfão (sem associação ativa). Removê-lo é seguro apenas se a checagem de dependências no pré-check não encontrar nenhuma referência ativa.`,
    };

    return `${templates[recommendation.actionType]} ${downtimeNote} Resource group: ${coordinates.resourceGroup}.`;
  }

  /**
   * States, in plain language, how to confirm the action actually worked —
   * without this, "ran the script" and "achieved the saving" are too easily
   * conflated.
   */
  private buildSuccessCriteria(
    _recommendation: Recommendation,
    coordinates: ResourceCoordinates,
    name: string,
  ): string {
    const scope = `az resource show --ids <resourceId> --query "properties.provisioningState"`;
    return `Sucesso confirmado quando: (1) o comando de aplicação retornar sem erro; (2) ${scope} não encontrar mais o recurso ${name} (ações DELETE/CLEANUP) ou mostrar o novo SKU/estado esperado (demais ações); (3) a próxima fatura do Cost Management para o resource group ${coordinates.resourceGroup} refletir a redução esperada — a economia só está confirmada quando aparecer na fatura seguinte, não no momento da execução.`;
  }

  /**
   * States, explicitly, when an operator should refuse to run this playbook
   * even though the recommendation exists — the guardrail a generic remediation
   * script never expresses.
   */
  private buildWhenNotToRun(
    recommendation: Recommendation,
    coordinates: ResourceCoordinates,
    name: string,
  ): string {
    const reasons: string[] = [
      `A checagem prévia (pré-check) mostrar bloqueios (locks) ativos no recurso.`,
      `Houver dependências ativas apontando para ${name} que a checagem prévia não conseguiu confirmar como seguras.`,
    ];

    if (recommendation.actionType === 'DELETE' || recommendation.actionType === 'CLEANUP') {
      reasons.push('Não houver um backup recente e validado do recurso ou dos dados que ele contém.');
    }

    if (recommendation.risk === 'high') {
      reasons.push('Não houver confirmação explícita do time responsável pelo recurso — risco classificado como alto exige validação humana, não apenas a leitura deste relatório.');
    }

    if (coordinates.resourceType.toLowerCase() === 'virtualmachines' || coordinates.resourceType.toLowerCase() === 'sites') {
      reasons.push('O recurso apresentar utilização recente acima do esperado na checagem prévia de métricas — a recomendação pode estar desatualizada.');
    }

    return `Não execute esta ação se: ${reasons.join(' ')}`;
  }
}
