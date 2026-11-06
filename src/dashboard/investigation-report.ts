import type { CostInvestigation, InvestigationDriver } from '@/services/cost-investigation';

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const money = (currency: string, value: string): string => escapeHtml(`${currency} ${value}`);
const list = (items: string[]): string =>
  `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;

const driverLabel = (driver: InvestigationDriver): string =>
  Object.entries(driver.dimensions)
    .map(([key, value]) => `${key}: ${value || '(não informado)'}`)
    .join(' · ');

const evidenceLinks = (ids: string[]): string =>
  ids.map((id) => `<a href="#${escapeHtml(id)}">${escapeHtml(id)}</a>`).join(', ') || 'Sem linhas';

const renderDrivers = (drivers: InvestigationDriver[], currency: string): string =>
  `<div class="scroll"><table>
    <thead><tr><th>Grupo observado</th><th>Base</th><th>Atual</th><th>Variação</th><th>Evidência</th></tr></thead>
    <tbody>${drivers
      .map(
        (driver) => `<tr>
      <td>${escapeHtml(driverLabel(driver))}${driver.presence === 'both' ? '' : `<br><strong>${driver.presence === 'current-only' ? 'Só no período atual' : 'Só na base'}; ausência não prova custo zero.</strong>`}</td>
      <td>${money(currency, driver.baselineCost)}</td>
      <td>${money(currency, driver.currentCost)}</td>
      <td>${money(currency, driver.delta)}</td>
      <td><details><summary>Linhas de origem</summary><p>Base: ${evidenceLinks(driver.evidence.baseline)}</p><p>Atual: ${evidenceLinks(driver.evidence.current)}</p></details></td>
    </tr>`,
      )
      .join('')}</tbody>
  </table></div>`;

export const generateInvestigationReport = (
  investigation: CostInvestigation,
  demo = false,
): string => {
  const sections = investigation.currencies
    .map(
      (result) => `<section>
    <h2>${escapeHtml(result.currency)} · Variação observada: ${money(result.currency, result.delta)}</h2>
    <p>Base (${escapeHtml(investigation.baseline)}): <strong>${money(result.currency, result.baselineCost)}</strong>
    → Atual (${escapeHtml(investigation.current)}): <strong>${money(result.currency, result.currentCost)}</strong>.</p>
    ${result.hasBothPeriods ? '' : '<p class="notice">Comparação incompleta: esta moeda tem linhas em apenas um período. O saldo não comprova aumento ou economia.</p>'}
    <p>O que mudou nas cobranças está abaixo. A causa técnica precisa de investigação adicional.</p>
    <h3>De onde vem a variação?</h3>
    <p>Esta ponte separa uso, créditos, compras e correções sem assumir que toda alta é consumo.</p>
    <div class="scroll"><table><thead><tr><th>Tipo</th><th>Base</th><th>Atual</th><th>Variação</th><th>Interpretação e evidência</th></tr></thead><tbody>${result.billingBridge
      .map(
        (item) => `<tr>
      <td>${escapeHtml(item.chargeCategory)} ${escapeHtml(item.chargeClass)}</td>
      <td>${money(result.currency, item.baselineCost)}</td><td>${money(result.currency, item.currentCost)}</td><td>${money(result.currency, item.delta)}</td>
      <td>${escapeHtml(item.interpretation)}<details><summary>Conferir linhas</summary>Base: ${evidenceLinks(item.evidence.baseline)}<br>Atual: ${evidenceLinks(item.evidence.current)}</details></td>
    </tr>`,
      )
      .join('')}</tbody></table></div>
    <h3>Quantidade ou custo unitário observado?</h3>
    <p>Somente grupos com escopo, SKU, medidor e unidade identificados nos dois períodos são decompostos. Custo unitário observado não é tarifa: pode refletir descontos, câmbio ou composição. Os efeitos abaixo detalham apenas cobranças Usage; não devem ser somados novamente à ponte acima.</p>
    ${
      result.usageExplanations
        .map(
          (item) => `<details${item.status === 'decomposed' ? ' open' : ''}>
      <summary>${escapeHtml(
        Object.entries(item.dimensions)
          .map(([key, value]) => `${key}: ${value || '(não informado)'}`)
          .join(' · '),
      )} — ${money(result.currency, item.delta)}</summary>
      ${item.status === 'decomposed' ? `<p>Quantidade: ${escapeHtml(item.baselineQuantity!)} → ${escapeHtml(item.currentQuantity!)} ${escapeHtml(item.dimensions.pricingUnit!)}.</p><p>Efeito quantidade: <strong>${money(result.currency, item.quantityEffect!)}</strong>. Efeito custo unitário observado: <strong>${money(result.currency, item.observedUnitCostEffect!)}</strong>.</p>` : '<p><strong>Evidência insuficiente para separar os efeitos.</strong></p>'}
      <p>${escapeHtml(item.reason)}</p><p>Base: ${evidenceLinks(item.evidence.baseline)}<br>Atual: ${evidenceLinks(item.evidence.current)}</p>
    </details>`,
        )
        .join('') || '<p>Sem cobranças Usage neste recorte.</p>'
    }
    <details open><summary>Por serviço</summary>${renderDrivers(result.breakdowns.service, result.currency)}</details>
    <details><summary>Por recurso, incluindo cobranças sem ResourceId</summary>${renderDrivers(result.breakdowns.resource, result.currency)}</details>
    <details><summary>Por categoria de cobrança — uso, crédito, compra e outras</summary>${renderDrivers(result.breakdowns.chargeCategory, result.currency)}</details>
  </section>`,
    )
    .join('');
  const sourceRows = investigation.sources
    .map(
      (source) => `<tr>
    <td>${escapeHtml(source.id)}<br>${escapeHtml(source.name)}</td>
    <td><code>${escapeHtml(source.sha256)}</code></td>
    <td>${source.selectedRowCount} de ${source.rowCount}</td>
  </tr>`,
    )
    .join('');
  const evidenceRows = investigation.evidence
    .map(
      (row) => `<tr id="${escapeHtml(row.id)}">
    <td><strong>${escapeHtml(row.id)}</strong><br>Registro ${row.record}; linhas ${row.startLine}–${row.endLine}</td>
    <td>${escapeHtml(row.billingPeriodStart)}<br>até ${escapeHtml(row.billingPeriodEnd)} (exclusivo)</td>
    <td>${money(row.currency, row.billedCost)}</td>
    <td>${escapeHtml(row.serviceName)}<br>${escapeHtml(row.chargeCategory)}</td>
    <td>${escapeHtml(row.providerName || '(provedor não informado)')}<br>${escapeHtml(row.billingAccountId || '(conta não informada)')}<br>${escapeHtml(row.subAccountId || '(assinatura não informada)')}</td>
    <td>${escapeHtml(row.resourceName)}<br>${escapeHtml(row.resourceId || '(sem ResourceId)')}</td>
  </tr>`,
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
  <title>Investigação de fatura · Azure Cost Analyzer</title>
  <style>
    :root { color-scheme: dark; font-family: system-ui, sans-serif; background: #0b1220; color: #e8eefb; }
    body { max-width: 1200px; margin: auto; padding: 2rem; line-height: 1.5; }
    h1, h2, a { color: #7dd3fc; }
    section { background: #131c2e; border: 1px solid #334155; border-radius: 12px; margin: 1.5rem 0; padding: 1.5rem; }
    .notice { border-left: 4px solid #facc15; padding: 1rem; background: #263248; }
    .scroll { overflow-x: auto; }
    table { border-collapse: collapse; width: 100%; font-size: .85rem; }
    th, td { padding: .8rem; border-bottom: 1px solid #334155; text-align: left; vertical-align: top; overflow-wrap: anywhere; min-width: 100px; }
    th { color: #93a4c0; }
    summary { cursor: pointer; font-weight: 600; padding: .75rem 0; }
    code { overflow-wrap: anywhere; }
    tr:target { background: #263248; outline: 2px solid #7dd3fc; }
    @media print { :root { color-scheme: light; background: white; color: black; } section, .notice { background: white; } h1, h2, a { color: black; } }
    @media (max-width: 640px) { body { padding: .75rem; } section { padding: .75rem; } }
  </style>
</head>
<body>
  <header><h1>O que mudou na fatura?</h1>
    <p>Azure Cost Analyzer · Investigação local e reproduzível · BilledCost por competência de faturamento.</p>
    ${demo ? '<p class="notice"><strong>DEMONSTRAÇÃO — dados inteiramente sintéticos.</strong> BRL: +450 em VM, −20 em Storage, +100 por menor crédito e +300 em compra de reserva = +830. USD: +2, separado. Uma compra antecipada não é aumento de consumo.</p>' : ''}
    <p>Sem chamadas ao Azure, envio de dados, JavaScript ou comandos de remediação. Este arquivo pode conter identificadores e valores confidenciais; compartilhe apenas após revisão.</p>
  </header>
  ${investigation.warnings.length > 0 ? `<section class="notice"><h2>Limites da evidência fornecida</h2>${list(investigation.warnings)}</section>` : ''}
  ${sections}
  <section><h2>O que verificar antes de concluir</h2>
    <p>Confira se os dois períodos incluem as mesmas contas, assinaturas e todos os arquivos/partições da exportação. Uma linha ausente pode ser dado faltante, não uma redução real.</p>
    <p>Comece pelos maiores movimentos em valor absoluto. Abra as linhas de origem e confira categoria, período, conta e recurso. Valide alterações técnicas, compromissos e créditos com os responsáveis antes de atribuir uma causa ou executar uma mudança.</p>
    ${list(investigation.limitations)}
  </section>
  <section><h2>Fontes verificáveis</h2>
    <p>SHA-256 do conteúdo UTF-8 de cada arquivo; nenhuma linha inválida é descartada silenciosamente. Valores decimais exatos, sem soma entre moedas.</p>
    <div class="scroll"><table><thead><tr><th>Fonte</th><th>SHA-256</th><th>Linhas selecionadas</th></tr></thead><tbody>${sourceRows}</tbody></table></div>
  </section>
  <section><h2>Linhas de evidência</h2>
    <p>Localização física no CSV original, com cabeçalho contado na numeração. Campos não utilizados, como tags e contatos, não são copiados para este relatório.</p>
    <div class="scroll"><table><thead><tr><th>Origem</th><th>Período de faturamento</th><th>BilledCost</th><th>Cobrança</th><th>Escopo</th><th>Recurso</th></tr></thead><tbody>${evidenceRows}</tbody></table></div>
  </section>
</body>
</html>`;
};
