import type { CostSummary, Resource } from '@/models';
import type { ResourceCostLedger } from '@/services/cost-analyzer';

const reviewFor = (service: string): string => {
  if (/storage/i.test(service)) return 'Separar capacidade, operações, versões e snapshots; simular tier com recuperação e exclusão antecipada antes de alterar retenção.';
  if (/network|bandwidth|load balancer/i.test(service)) return 'Separar IP, gateway, NAT, Private Link e tráfego; confirmar dependências e rotas antes de remover ou consolidar.';
  if (/sql|database/i.test(service)) return 'Confirmar DTU/vCore, pool e picos; precificar o destino e os compromissos antes de reduzir capacidade.';
  if (/app service|virtual machines|functions/i.test(service)) return 'Relacionar plano/VM às cargas; medir CPU, memória e picos e precificar destino, discos e disponibilidade.';
  if (/foundry|openai|cognitive/i.test(service)) return 'Separar modelo, entrada/saída e modalidade; comparar custo por operação útil com qualidade e residência de dados aprovadas.';
  if (/monitor|analytics|sentinel/i.test(service)) return 'Identificar tabelas e fontes de ingestão; ajustar duplicação e retenção preservando auditoria e detecção.';
  if (/backup/i.test(service)) return 'Relacionar instâncias protegidas, retenção e armazenamento; validar RPO/RTO e política antes de expirar cópias.';
  return 'Abrir o detalhamento por recurso e meter; confirmar responsável, necessidade e unidade cobrada antes de propor mudança.';
};

export type SpendWorklist = {
  period: string;
  currency: string;
  queriedResourceCost: number;
  resourceDetailAvailable: boolean;
  services: { service: string; cost: number; share: number | undefined; nextStep: string }[];
  resources: {
    id: string;
    name: string;
    resourceGroup: string;
    owner: string;
    inventoryMatched: boolean;
    cost: number;
    monthly: Record<string, number>;
  }[];
};

/**
 * Prioritizes billed spend, not claimed savings. Historical resource IDs remain
 * visible even when the management-plane inventory no longer contains them.
 */
export const buildSpendWorklist = (
  costs: CostSummary,
  ledgers: ResourceCostLedger[] = [],
  inventory: Resource[] = [],
): SpendWorklist => {
  const known = new Map(inventory.map((resource) => [resource.id.toLowerCase(), resource]));
  const monthlyByResource = new Map<string, Record<string, number>>();
  for (const ledger of ledgers) {
    if (ledger.currency !== costs.currency) continue;
    for (const [id, monthly] of Object.entries(ledger.resources)) {
      const merged = monthlyByResource.get(id.toLowerCase()) ?? {};
      for (const [month, amount] of Object.entries(monthly)) {
        if (Number.isFinite(amount)) merged[month] = (merged[month] ?? 0) + amount;
      }
      monthlyByResource.set(id.toLowerCase(), merged);
    }
  }
  const resources = [...monthlyByResource].map(([id, monthly]) => {
    const resource = known.get(id);
    return {
      id,
      name: resource?.name ?? id.split('/').filter(Boolean).at(-1) ?? id,
      resourceGroup: resource?.resourceGroup ?? /\/resourcegroups\/([^/]+)/i.exec(id)?.[1] ?? 'Não informado na cobrança',
      owner: resource?.tags?.owner ?? 'Responsável não confirmado',
      inventoryMatched: Boolean(resource),
      cost: Object.values(monthly).reduce((sum, amount) => sum + amount, 0),
      monthly,
    };
  }).sort((a, b) => b.cost - a.cost || a.id.localeCompare(b.id));
  return {
    period: costs.period,
    currency: costs.currency,
    queriedResourceCost: resources.reduce((sum, resource) => sum + resource.cost, 0),
    resourceDetailAvailable: ledgers.some((ledger) => ledger.currency === costs.currency),
    services: Object.entries(costs.byService).sort((a, b) => b[1] - a[1]).map(([service, cost]) => ({
      service,
      cost,
      share: costs.totalAmount > 0 ? cost / costs.totalAmount : undefined,
      nextStep: reviewFor(service),
    })),
    resources,
  };
};
