import type {
  CostDiff,
  CostSummary,
  DecisionEngineReport,
  ExecutiveSummary,
  IdleResource,
  InactionCost,
  OwnershipReport,
  Recommendation,
  RemediationPlan,
  WafScorecard,
} from '@/models';

export type StaticReportData = {
  generatedAt: string;
  subscriptionId: string;
  costs: CostSummary;
  idleResources: IdleResource[];
  recommendations: Recommendation[];
  warnings?: string[];
  executiveSummary?: ExecutiveSummary;
  ownership?: OwnershipReport;
  diff?: CostDiff | undefined;
  remediationPlans?: RemediationPlan[];
  waf?: WafScorecard | undefined;
  inaction?: InactionCost | undefined;
  decisionEngine?: DecisionEngineReport | undefined;
};

/**
 * Escapes JSON so it can be safely embedded inside an inline `<script>` tag.
 */
const toEmbeddedJson = (value: unknown): string =>
  JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');

/**
 * Client-side script embedded in the report. Kept as a standalone constant so it
 * can be compiled and asserted on directly in tests, without parsing the HTML.
 */
export const REPORT_CLIENT_SCRIPT = `
      const REPORT = JSON.parse(document.getElementById('report-data').textContent);
      const idleData = REPORT.idleResources;
      const recsData = REPORT.recommendations;

      const CURRENCY = (REPORT.summary && REPORT.summary.currency) || 'USD';

      // Usa o formatador nativo da moeda retornada pelo Azure. Se o código não for
      // reconhecido pelo runtime, cai para o número puro prefixado com o código.
      function currencyFormatter(digits) {
        try {
          return new Intl.NumberFormat('pt-BR', {
            style: 'currency',
            currency: CURRENCY,
            minimumFractionDigits: digits,
            maximumFractionDigits: digits,
          });
        } catch (err) {
          return {
            format: (n) => CURRENCY + ' ' + n.toLocaleString('pt-BR', {
              minimumFractionDigits: digits,
              maximumFractionDigits: digits,
            }),
          };
        }
      }

      const compactFormatter = currencyFormatter(0);
      const fullFormatter = currencyFormatter(2);

      const fmt = (n) => typeof n === 'number' ? compactFormatter.format(n) : '—';
      const fmtFull = (n) => typeof n === 'number' ? fullFormatter.format(n) : '—';

      // Rótulos traduzidos para valores enumerados. Nomes de recursos, serviços e
      // demais dados vindos do Azure permanecem no idioma original.
      const LEVEL_LABELS = { low: 'baixo', medium: 'médio', high: 'alto' };
      const ACTION_LABELS = {
        DELETE: 'Excluir',
        DOWNSIZE: 'Reduzir porte',
        CHANGE_SKU: 'Alterar SKU',
        SCHEDULE: 'Agendar',
        MIGRATE: 'Migrar',
        CLEANUP: 'Limpar',
      };
      const STATUS_LABELS = {
        new: 'novo',
        planned: 'planejado',
        'in-progress': 'em andamento',
        completed: 'concluído',
        dismissed: 'descartado',
      };

      // All Azure-provided strings are untrusted (resource names/tags); escape before innerHTML use.
      const esc = (value) => {
        const str = value == null ? '' : String(value);
        return str
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      };

      function renderKPI(id, value, sub) {
        document.getElementById(id).textContent = value;
        const subEl = document.getElementById(id + '-sub');
        if (subEl && sub != null) subEl.textContent = sub;
      }

      function renderIdleTable() {
        const filter = document.getElementById('idle-filter').value.toLowerCase();
        const [sortField, sortDir] = document.getElementById('idle-sort').value.split('-');
        const container = document.getElementById('idle-table-container');

        let rows = idleData.filter(r => {
          const name = (r.resource?.name || '').toLowerCase();
          const rg = (r.resource?.resourceGroup || '').toLowerCase();
          return !filter || name.includes(filter) || rg.includes(filter);
        });

        rows.sort((a, b) => {
          const aVal = a[sortField] ?? 0;
          const bVal = b[sortField] ?? 0;
          return sortDir === 'asc' ? aVal - bVal : bVal - aVal;
        });

        if (!rows.length) {
          container.innerHTML = '<div class="empty">Nenhum recurso ocioso encontrado.</div>';
          return;
        }

        const thead = '<thead><tr><th>Nome</th><th>Tipo</th><th>Resource Group</th><th>Location</th><th>Score de ociosidade</th><th>Economia mensal</th><th>Motivo e evidência</th></tr></thead>';
        const tbody = rows.map(r => {
          const res = r.resource || {};
          const type = (res.type || '').split('/').pop() || '—';
          const score = r.idleScore ?? 0;
          return '<tr>'
            + '<td><strong>' + esc(res.name || '—') + '</strong></td>'
            + '<td><span class="badge new">' + esc(type) + '</span></td>'
            + '<td>' + esc(res.resourceGroup || '—') + '</td>'
            + '<td>' + esc(res.location || '—') + '</td>'
            + '<td><div class="score-bar"><div class="score-bar-inner" style="width:' + Math.max(0, Math.min(80, Number(score) || 0)) + 'px"></div><span>' + esc(score) + '</span></div></td>'
            + '<td style="color:var(--green)">' + fmtFull(r.estimatedMonthlySavings) + '</td>'
            + '<td style="color:var(--muted);font-size:0.8rem">' + esc(r.reason || '—') + renderEvidence(r.evidence) + '</td>'
            + '</tr>';
        }).join('');
        container.innerHTML = '<div class="table-scroll"><table>' + thead + '<tbody>' + tbody + '</tbody></table></div>';
      }

      function renderRecs() {
        const container = document.getElementById('recs-container');
        if (!recsData.length) {
          container.innerHTML = '<div class="empty">Nenhuma recomendação disponível.</div>';
          return;
        }
        const items = recsData.map(r => {
          const risk = (r.risk || 'medium').toLowerCase();
          const effort = (r.effort || 'medium').toLowerCase();
          return '<div class="rec-item">'
            + '<div>'
            + '<div class="rec-title">' + esc(r.title || '—') + '</div>'
            + '<div class="rec-desc">' + esc(r.description || '') + '</div>'
            + renderEvidence(r.evidence)
            + renderRationale(r.billingRationale)
            + '<div class="rec-meta">'
            + '<span class="badge ' + esc(risk) + '">Risco: ' + esc(LEVEL_LABELS[risk] || risk) + '</span>'
            + '<span class="badge ' + esc(effort) + '">Esforço: ' + esc(LEVEL_LABELS[effort] || effort) + '</span>'
            + '<span class="badge new">' + esc(ACTION_LABELS[r.actionType] || r.actionType || '—') + '</span>'
            + '<span class="badge new">' + esc(STATUS_LABELS[r.status] || r.status || '—') + '</span>'
            + '</div>'
            + '</div>'
            + '<div class="rec-stats">'
            + '<div class="rec-savings">' + fmt(r.annualSavings) + '/ano</div>'
            + '<div class="rec-roi">ROI: ' + (r.roi != null ? Number(r.roi).toFixed(1) + 'x' : '—') + '</div>'
            + '<div style="font-size:0.75rem;color:var(--muted);margin-top:2px">' + fmtFull(r.monthlySavings) + '/mês</div>'
            + '</div>'
            + '</div>';
        }).join('');
        container.innerHTML = '<div class="rec-list">' + items + '</div>';
      }

      function renderBarChart(containerId, data) {
        const container = document.getElementById(containerId);
        if (!data || !Object.keys(data).length) {
          container.innerHTML = '<div class="empty">Sem dados.</div>';
          return;
        }
        const entries = Object.entries(data).sort((a, b) => b[1] - a[1]);
        const max = entries[0][1] || 1;
        const bars = entries.map(([label, value]) => {
          const pct = Math.round((value / max) * 100);
          return '<div class="bar-row">'
            + '<div class="bar-label" title="' + esc(label) + '">' + esc(label) + '</div>'
            + '<div class="bar-track"><div class="bar-fill" style="width:' + pct + '%"></div></div>'
            + '<div class="bar-val">' + fmt(value) + '</div>'
            + '</div>';
        }).join('');
        container.innerHTML = bars;
      }

      const WAF_STATUS = {
        pass: { label: 'Conforme', cls: 'waf-pass' },
        partial: { label: 'Parcial', cls: 'waf-partial' },
        fail: { label: 'Não atendido', cls: 'waf-fail' },
        'not-applicable': { label: 'Não aplicável', cls: 'waf-na' },
      };

      const BASIS_LABELS = {
        'retail-price': 'Preço de lista Azure',
        'observed-cost': 'Custo observado',
        heuristic: 'Estimativa aproximada',
      };

      const CONFIDENCE_LABELS = { high: 'alta', medium: 'média', low: 'baixa' };

      const DECISION_CATEGORY = {
        EXECUTAVEL_AGORA: { label: 'Executável agora', cls: 'waf-pass' },
        VALIDAR_ANTES: { label: 'Validar antes', cls: 'waf-partial' },
        SOMENTE_HISTORICO: { label: 'Somente histórico', cls: 'waf-na' },
        INVESTIGAR: { label: 'Investigar', cls: 'waf-fail' },
      };

      const SAVINGS_STATUS_LABELS = {
        confirmada: 'Confirmada pela fatura',
        provavel: 'Provável (preço de lista)',
        'nao-confirmada': 'Não confirmada',
      };

      function renderDecisionEngine() {
        const data = REPORT.decisionEngine;
        if (!data || !(data.decisions || []).length) return;
        document.getElementById('decision-section').hidden = false;

        const rows = data.decisions.map(function (decision) {
          const meta = DECISION_CATEGORY[decision.category] || DECISION_CATEGORY.INVESTIGAR;
          return '<tr>'
            + '<td><strong>' + esc(decision.resourceName) + '</strong></td>'
            + '<td><span class="badge ' + meta.cls + '">' + esc(meta.label) + '</span></td>'
            + '<td>' + esc(SAVINGS_STATUS_LABELS[decision.savingsStatus] || decision.savingsStatus) + '</td>'
            + '<td>' + fmtFull(decision.monthlySavings) + '</td>'
            + '<td class="muted">' + esc(decision.reasoning) + '</td>'
            + '</tr>';
        }).join('');

        document.getElementById('decision-body').innerHTML =
          '<div class="inaction-kpis">'
          + '<div class="inaction-kpi"><span>' + data.executableNowCount + '</span><small>prontas para executar agora</small></div>'
          + '<div class="inaction-kpi"><span>' + fmtFull(data.confirmedMonthlySavings) + '</span><small>confirmada pela fatura / mês</small></div>'
          + '<div class="inaction-kpi"><span>' + fmtFull(data.probableMonthlySavings) + '</span><small>provável (preço de lista) / mês</small></div>'
          + '<div class="inaction-kpi"><span>' + fmtFull(data.unconfirmedMonthlySavings) + '</span><small>não confirmada / mês</small></div>'
          + '</div>'
          + '<p class="muted">' + esc(data.summary) + '</p>'
          + '<div class="table-scroll"><table><thead><tr><th>Recurso</th><th>Categoria</th><th>Status da economia</th><th>Economia/mês</th><th>Motivo</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
      }

      function renderWaf() {
        const waf = REPORT.waf;
        if (!waf) return;
        document.getElementById('waf-section').hidden = false;

        const rows = (waf.checks || []).map(function (check) {
          const status = WAF_STATUS[check.status] || WAF_STATUS.fail;
          return '<tr>'
            + '<td><code>' + esc(check.code) + '</code></td>'
            + '<td><strong>' + esc(check.title) + '</strong><div class="muted">' + esc(check.evidence) + '</div></td>'
            + '<td><span class="badge ' + status.cls + '">' + esc(status.label) + '</span></td>'
            + '<td>' + esc(LEVEL_LABELS[check.impact] || check.impact) + '</td>'
            + '<td>' + esc(check.recommendation) + '</td>'
            + '</tr>';
        }).join('');

        document.getElementById('waf-body').innerHTML =
          '<div class="waf-header">'
          + '<div class="waf-score waf-grade-' + esc(waf.grade) + '">'
          + '<span class="waf-grade">' + esc(waf.grade) + '</span>'
          + '<span class="waf-number">' + Number(waf.score).toFixed(0) + '<small>/100</small></span>'
          + '</div>'
          + '<p class="waf-summary">' + esc(waf.summary) + '</p>'
          + '</div>'
          + '<div class="table-scroll"><table><thead><tr><th>Código</th><th>Controle</th><th>Situação</th><th>Impacto</th><th>Recomendação</th></tr></thead>'
          + '<tbody>' + rows + '</tbody></table></div>';
      }

      function renderInaction() {
        const data = REPORT.inaction;
        if (!data) return;
        document.getElementById('inaction-section').hidden = false;

        const rows = (data.stale || []).map(function (item) {
          return '<tr>'
            + '<td><strong>' + esc(item.resourceName) + '</strong><div class="muted">' + esc(item.title) + '</div></td>'
            + '<td>' + item.daysOpen + ' dias</td>'
            + '<td>' + fmtFull(item.monthlySavings) + '</td>'
            + '<td class="delta-up">' + fmtFull(item.wastedSoFar) + '</td>'
            + '</tr>';
        }).join('');

        const table = rows
          ? '<div class="table-scroll"><table><thead><tr><th>Recurso</th><th>Em aberto</th><th>Desperdício mensal</th><th>Já desperdiçado</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
          : '<div class="empty">Nenhuma recomendação ficou pendente desde a análise anterior.</div>';

        document.getElementById('inaction-body').innerHTML =
          '<div class="inaction-kpis">'
          + '<div class="inaction-kpi"><span>' + fmtFull(data.totalWasted) + '</span><small>já desperdiçado</small></div>'
          + '<div class="inaction-kpi"><span>' + fmtFull(data.projectedAnnualWaste) + '</span><small>projeção em 12 meses</small></div>'
          + '<div class="inaction-kpi"><span>' + (data.stale || []).length + '</span><small>ainda em aberto</small></div>'
          + '<div class="inaction-kpi"><span>' + data.resolved + '</span><small>resolvidas</small></div>'
          + '</div>'
          + '<p class="muted">' + esc(data.summary) + '</p>'
          + table;
      }

      /**
       * Renders the audit trail of a finding. Showing the measurements and the price
       * basis is what lets a reader challenge or accept the number.
       */
      function renderEvidence(evidence) {
        if (!evidence) return '';

        const metrics = (evidence.metrics || []).map(function (metric) {
          const threshold = metric.threshold == null
            ? ''
            : ' (limite: ' + esc(metric.comparison === 'below' ? '<' : metric.comparison === 'above' ? '>' : '=') + ' ' + metric.threshold + ' ' + esc(metric.unit) + ')';
          return '<li><strong>' + esc(metric.label) + ':</strong> ' + esc(metric.value) + ' ' + esc(metric.unit) + threshold + '</li>';
        }).join('');

        const conf = CONFIDENCE_LABELS[evidence.confidence] || evidence.confidence;
        const basis = BASIS_LABELS[evidence.savingsBasis] || evidence.savingsBasis;

        return '<details class="evidence">'
          + '<summary>Evidência · confiança ' + esc(conf) + '</summary>'
          + (metrics ? '<ul>' + metrics + '</ul>' : '')
          + '<p class="muted"><strong>Base do cálculo:</strong> ' + esc(basis) + '. ' + esc(evidence.savingsBasisDetail) + '</p>'
          + (evidence.observationWindowDays > 0
              ? '<p class="muted">Janela observada: ' + evidence.observationWindowDays + ' dias · ' + evidence.dataPoints + ' pontos de telemetria.</p>'
              : '')
          + renderBilled(evidence.billed)
          + (evidence.caveat ? '<p class="caveat">' + esc(evidence.caveat) + '</p>' : '')
          + '</details>';
      }

      const MONTH_NAMES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
        'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

      /** Converte AAAA-MM no nome do mês, que é o formato esperado por leitor executivo. */
      function monthLabel(month) {
        const parts = String(month).split('-');
        const name = MONTH_NAMES[Number(parts[1]) - 1];
        return name ? name + ' de ' + parts[0] : month;
      }

      /**
       * Mostra o que o recurso realmente custou, mês a mês. Um número estimado por
       * preço de lista é uma projeção; isto é a fatura, e é o que sustenta a
       * recomendação diante da área financeira.
       */
      function renderBilled(billed) {
        if (!billed) return '';

        const months = Object.keys(billed.monthly || {}).sort();
        if (months.length === 0) return '';

        const cells = months.map(function (month) {
          const value = billed.monthly[month] || 0;
          const zero = value < 0.01;
          return '<li' + (zero ? ' class="caveat"' : '') + '><strong>' + esc(monthLabel(month)) + ':</strong> '
            + esc(fmtFull(value)) + (zero ? ' (sem cobrança)' : '') + '</li>';
        }).join('');

        const note = billed.billingStopped
          ? '<p class="caveat">O recurso deixou de gerar custo durante o período analisado'
            + (billed.lastMonthWithCost ? ', a última cobrança foi em ' + esc(monthLabel(billed.lastMonthWithCost)) : '')
            + '. Não há economia futura a capturar.</p>'
          : '';

        return '<p class="muted"><strong>Custo realmente faturado:</strong> ' + esc(fmtFull(billed.observedTotal))
          + ' no período.</p><ul>' + cells + '</ul>' + note;
      }

      /**
       * Explica por que a ação reduz a fatura daquele serviço, com o link da
       * documentação oficial. Sugestão sem base documental não entra no relatório.
       */
      function renderRationale(rationale) {
        if (!rationale) return '';

        return '<details class="evidence rationale">'
          + '<summary>Base documental da recomendação</summary>'
          + '<p class="muted"><strong>Como é cobrado:</strong> ' + esc(rationale.billingModel) + '</p>'
          + '<p class="muted"><strong>Por que gera economia:</strong> ' + esc(rationale.whySaves) + '</p>'
          + (rationale.notApplicable
              ? '<p class="caveat"><strong>Não se aplica:</strong> ' + esc(rationale.notApplicable) + '</p>'
              : '')
          + '<p class="muted"><a href="' + esc(rationale.documentationUrl) + '" target="_blank" rel="noopener noreferrer">Documentação oficial do Azure</a></p>'
          + '</details>';
      }

      function renderExecutiveSummary() {
        const data = REPORT.executiveSummary;
        if (!data) return;

        const chips = (data.highlights || []).map(function (item) {
          return '<div class="exec-chip ' + esc(item.tone || 'neutral') + '">'
            + '<span class="chip-label">' + esc(item.label) + '</span>'
            + '<span class="chip-value">' + esc(item.value) + '</span>'
            + '</div>';
        }).join('');

        const paragraphs = (data.paragraphs || []).map(function (text) {
          return '<p>' + esc(text) + '</p>';
        }).join('');

        const actions = (data.topActions || []).length
          ? '<ul class="exec-actions">' + data.topActions.map(function (action) {
              return '<li>' + esc(action) + '</li>';
            }).join('') + '</ul>'
          : '';

        document.getElementById('exec-summary').innerHTML =
          '<div class="exec-summary">'
          + '<span class="exec-tag">Sumário executivo</span>'
          + '<div class="exec-headline">' + esc(data.headline) + '</div>'
          + (chips ? '<div class="exec-highlights">' + chips + '</div>' : '')
          + paragraphs
          + actions
          + '</div>';
      }

      function renderDeltaRows(rows) {
        if (!rows || !rows.length) {
          return '<div class="empty">Sem variações relevantes.</div>';
        }
        const body = rows.map(function (row) {
          const cls = row.delta > 0 ? 'delta-up' : 'delta-down';
          const sign = row.delta > 0 ? '+' : '';
          const pct = row.percentChange == null
            ? '—'
            : (row.percentChange > 0 ? '+' : '') + Number(row.percentChange).toFixed(1) + '%';
          return '<tr>'
            + '<td><strong>' + esc(row.key) + '</strong></td>'
            + '<td>' + fmtFull(row.previous) + '</td>'
            + '<td>' + fmtFull(row.current) + '</td>'
            + '<td class="' + cls + '">' + sign + fmtFull(row.delta) + '</td>'
            + '<td class="' + cls + '">' + esc(pct) + '</td>'
            + '</tr>';
        }).join('');
        return '<div class="table-scroll"><table><thead><tr><th>Item</th><th>Anterior</th><th>Atual</th><th>Variação</th><th>%</th></tr></thead>'
          + '<tbody>' + body + '</tbody></table></div>';
      }

      function renderDiff() {
        const diff = REPORT.diff;
        if (!diff) return;
        document.getElementById('diff-section').hidden = false;

        const cls = diff.totalDelta > 0 ? 'up' : diff.totalDelta < 0 ? 'down' : '';
        const sign = diff.totalDelta > 0 ? '+' : '';
        const pct = diff.totalPercentChange == null
          ? ''
          : ' (' + (diff.totalPercentChange > 0 ? '+' : '') + Number(diff.totalPercentChange).toFixed(1) + '%)';

        const lists = '<div class="diff-lists">'
          + '<div><h4>Novos recursos ociosos (' + diff.newIdleResources.length + ')</h4><ul>'
          + (diff.newIdleResources.length
              ? diff.newIdleResources.slice(0, 10).map(function (name) { return '<li>' + esc(name) + '</li>'; }).join('')
              : '<li class="diff-note">Nenhum.</li>')
          + '</ul></div>'
          + '<div><h4>Ociosidade resolvida (' + diff.resolvedIdleResources.length + ')</h4><ul>'
          + (diff.resolvedIdleResources.length
              ? diff.resolvedIdleResources.slice(0, 10).map(function (name) { return '<li>' + esc(name) + '</li>'; }).join('')
              : '<li class="diff-note">Nenhum.</li>')
          + '</ul></div>'
          + '</div>';

        document.getElementById('diff-container').innerHTML =
          '<div class="diff-summary">'
          + '<div class="diff-total ' + cls + '">' + sign + fmtFull(diff.totalDelta) + esc(pct) + '</div>'
          + '<div class="diff-note">'
          + esc(fmtFull(diff.totalPrevious) + ' → ' + fmtFull(diff.totalCurrent))
          + ' · relatório anterior de ' + esc(new Date(diff.previousGeneratedAt).toLocaleString('pt-BR'))
          + ' · ' + esc(diff.previousPeriod) + ' vs ' + esc(diff.currentPeriod)
          + '</div>'
          + '</div>'
          + '<h4 style="font-size:0.78rem;text-transform:uppercase;letter-spacing:0.06em;color:var(--muted);margin-bottom:0.5rem">Por Service</h4>'
          + renderDeltaRows(diff.byService)
          + '<h4 style="font-size:0.78rem;text-transform:uppercase;letter-spacing:0.06em;color:var(--muted);margin:1.2rem 0 0.5rem">Por Resource Group</h4>'
          + renderDeltaRows(diff.byResourceGroup)
          + lists;
      }

      function renderOwnership() {
        const ownership = REPORT.ownership;
        if (!ownership || !ownership.owners.length) return;
        document.getElementById('ownership-section').hidden = false;

        const coverage = Math.round((ownership.tagCoverage || 0) * 100);
        const rows = ownership.owners.map(function (owner) {
          const share = Math.round((owner.shareOfTotal || 0) * 100);
          const badge = owner.attribution === 'tag'
            ? '<span class="badge low">tag ' + esc(owner.attributionKey) + '</span>'
            : owner.attribution === 'resource-group'
              ? '<span class="badge medium">resource group</span>'
              : '<span class="badge high">sem tag</span>';
          const top = owner.topResources.map(function (resource) {
            return esc(resource.name) + ' (' + fmtFull(resource.monthlySavings) + ')';
          }).join(', ');
          return '<tr>'
            + '<td><strong>' + esc(owner.owner) + '</strong></td>'
            + '<td>' + badge + '</td>'
            + '<td>' + esc(owner.resourceCount) + '</td>'
            + '<td style="color:var(--green)">' + fmtFull(owner.monthlyWaste) + '</td>'
            + '<td style="color:var(--green)">' + fmtFull(owner.annualWaste) + '</td>'
            + '<td>' + share + '%</td>'
            + '<td class="owner-resources">' + top + '</td>'
            + '</tr>';
        }).join('');

        document.getElementById('ownership-container').innerHTML =
          '<div class="diff-note">Cobertura de tag de responsável: <strong>' + coverage + '%</strong> ('
          + ownership.taggedResourceCount + ' com tag, ' + ownership.untaggedResourceCount + ' sem tag)</div>'
          + '<div class="coverage-bar"><div class="coverage-fill" style="width:' + coverage + '%"></div></div>'
          + '<div class="table-scroll"><table><thead><tr><th>Responsável</th><th>Origem</th><th>Recursos</th><th>Desperdício mensal</th>'
          + '<th>Desperdício anual</th><th>Participação</th><th>Principais recursos</th></tr></thead>'
          + '<tbody>' + rows + '</tbody></table></div>';
      }

      function renderSteps(steps) {
        if (!steps || !steps.length) {
          return '<div class="diff-note">Nenhum comando necessário.</div>';
        }
        return steps.map(function (item) {
          return '<div class="rem-step">'
            + '<div class="step-desc">' + esc(item.description) + '</div>'
            + '<pre class="code">' + esc(item.command) + '</pre>'
            + '</div>';
        }).join('');
      }

      function renderRemediation() {
        const plans = REPORT.remediationPlans || [];
        if (!plans.length) return;
        document.getElementById('remediation-section').hidden = false;

        const items = plans.map(function (plan, index) {
          const risk = (plan.risk || 'medium').toLowerCase();
          const downtime = plan.requiresDowntime
            ? '<span class="downtime-flag">⚠ causa indisponibilidade</span>'
            : '';
          return '<details class="rem-item">'
            + '<summary>'
            + '<strong>' + esc(plan.resourceName) + '</strong>'
            + '<span class="badge new">' + esc(ACTION_LABELS[plan.actionType] || plan.actionType) + '</span>'
            + '<span class="badge ' + esc(risk) + '">Risco: ' + esc(LEVEL_LABELS[risk] || risk) + '</span>'
            + '<span style="color:var(--green)">' + fmtFull(plan.monthlySavings) + '/mês</span>'
            + downtime
            + '</summary>'
            + '<div class="rem-body">'
            + '<p class="section-hint">' + esc(plan.summary) + '</p>'
            + '<h4>1. Verificações prévias</h4>' + renderSteps(plan.preChecks)
            + '<h4>2. Aplicação</h4>' + renderSteps(plan.apply)
            + '<h4>3. Rollback</h4>' + renderSteps(plan.rollback)
            + '<h4>4. Infrastructure as Code</h4>'
            + '<div class="rem-tabs">'
            + '<button class="active" onclick="switchIac(' + index + ', \\'terraform\\', this)">Terraform</button>'
            + '<button onclick="switchIac(' + index + ', \\'bicep\\', this)">Bicep</button>'
            + '</div>'
            + '<pre class="code" id="iac-' + index + '">' + esc(plan.iac.terraform) + '</pre>'
            + '</div>'
            + '</details>';
        }).join('');

        document.getElementById('remediation-container').innerHTML = items;
      }

      function switchIac(index, flavor, button) {
        const plan = (REPORT.remediationPlans || [])[index];
        if (!plan) return;
        document.getElementById('iac-' + index).textContent = plan.iac[flavor] || '';
        const buttons = button.parentElement.querySelectorAll('button');
        for (const item of buttons) item.classList.remove('active');
        button.classList.add('active');
      }

      document.getElementById('report-meta').textContent =
        'Subscription ' + REPORT.subscriptionId + ' · Gerado em ' + new Date(REPORT.generatedAt).toLocaleString('pt-BR');

      const warnings = REPORT.warnings || [];
      if (warnings.length) {
        document.getElementById('report-warnings').innerHTML =
          '<div class="warning-banner"><h3>Dados parciais</h3><ul>'
          + warnings.map(function (warning) { return '<li>' + esc(warning) + '</li>'; }).join('')
          + '</ul></div>';
      }

      renderKPI('kpi-cost', fmt(REPORT.summary.totalCost), REPORT.costs.period + ' (' + REPORT.summary.currency + ')');
      renderKPI('kpi-idle', String(REPORT.summary.idleResourceCount));
      renderKPI('kpi-recs', String(REPORT.summary.recommendationCount));
      renderKPI('kpi-savings', fmt(REPORT.summary.annualSavingsOpportunity));

      renderExecutiveSummary();
      renderDecisionEngine();
      renderWaf();
      renderInaction();
      renderDiff();
      renderOwnership();
      renderIdleTable();
      renderRecs();
      renderRemediation();
      renderBarChart('chart-service', REPORT.costs.byService);
      renderBarChart('chart-rg', REPORT.costs.byResourceGroup);
      // Location is only grouped when explicitly requested, so the card stays hidden
      // rather than showing an empty chart.
      if (Object.keys(REPORT.costs.byLocation || {}).length > 0) {
        document.getElementById('card-loc').hidden = false;
        renderBarChart('chart-loc', REPORT.costs.byLocation);
      }
`;

/**
 * Renders a fully static, self-contained HTML report (no server required) that mirrors
 * the live dashboard's layout. All Azure-provided strings are HTML-escaped client-side
 * before insertion, since the embedded data may contain untrusted resource names/tags.
 */
export const generateStaticReport = (data: StaticReportData): string => {
  const annualSavingsOpportunity = data.recommendations.reduce((sum, item) => sum + item.annualSavings, 0);
  const summary = {
    totalCost: data.costs.totalAmount,
    currency: data.costs.currency,
    idleResourceCount: data.idleResources.length,
    recommendationCount: data.recommendations.length,
    annualSavingsOpportunity,
  };

  const embeddedData = toEmbeddedJson({
    generatedAt: data.generatedAt,
    subscriptionId: data.subscriptionId,
    summary,
    costs: data.costs,
    idleResources: data.idleResources,
    recommendations: data.recommendations,
    warnings: data.warnings ?? [],
    executiveSummary: data.executiveSummary ?? null,
    ownership: data.ownership ?? null,
    diff: data.diff ?? null,
    waf: data.waf ?? null,
    inaction: data.inaction ?? null,
    decisionEngine: data.decisionEngine ?? null,
    remediationPlans: data.remediationPlans ?? [],
  });

  return `<!DOCTYPE html>
<html lang="pt-BR">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Relatório do Azure Cost Analyzer</title>
    <style>
      *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
      :root {
        --bg: #0b1220;
        --bg-accent: radial-gradient(1200px 600px at 15% -10%, rgba(56,189,248,0.10), transparent 60%);
        --surface: #131c2e;
        --surface2: #1b2740;
        --surface3: #223050;
        --border: #2a3a57;
        --border-strong: #3b5075;
        --text: #e8eefb;
        --muted: #93a4c0;
        --accent: #38bdf8;
        --accent-strong: #0ea5e9;
        --green: #4ade80;
        --yellow: #facc15;
        --amber: #f59e0b;
        --red: #f87171;
        --purple: #c084fc;
        --radius: 14px;
        --radius-sm: 9px;
        --shadow: 0 10px 30px rgba(2,6,23,0.55);
        --shadow-sm: 0 2px 10px rgba(2,6,23,0.35);
      }

      html { -webkit-text-size-adjust: 100%; }
      body {
        font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
        background: var(--bg-accent), var(--bg);
        background-attachment: fixed;
        color: var(--text);
        min-height: 100vh;
        line-height: 1.55;
        font-feature-settings: 'tnum' 1;
      }

      /* Long Azure resource IDs and service names must wrap instead of pushing
         the layout sideways, which used to clip content against the card edge. */
      h1, h2, h3, h4, p, li, td, th, span, div { overflow-wrap: break-word; }
      /* Identificadores do Azure nao possuem espacos e precisam quebrar em qualquer ponto. */
      .mono, .resource-id, code, pre { overflow-wrap: anywhere; }

      /* Grid and flex children default to min-width:auto, so a single long word
         forces the track wider than its container and the overflow is clipped. */
      .kpi-grid > *, .charts-grid > *, .diff-lists > *, .rec-item > *,
      .bar-row > *, .waf-header > *, .exec-highlights > *, .inaction-kpis > * { min-width: 0; }

      header {
        background: linear-gradient(180deg, rgba(19,28,46,0.96), rgba(19,28,46,0.86));
        backdrop-filter: blur(8px);
        border-bottom: 1px solid var(--border);
        padding: 1.1rem 2rem;
        display: flex;
        align-items: center;
        gap: 1rem;
        flex-wrap: wrap;
        position: sticky;
        top: 0;
        z-index: 20;
      }
      header h1 { font-size: 1.15rem; font-weight: 700; letter-spacing: -0.01em; color: var(--text); display: flex; align-items: center; gap: 0.6rem; }
      header h1::before { content: ''; width: 6px; height: 22px; border-radius: 3px; background: linear-gradient(180deg, var(--accent), var(--purple)); flex: none; }
      header span { font-size: 0.75rem; color: var(--muted); margin-left: auto; }

      main { max-width: 1360px; margin: 0 auto; padding: 2rem; display: flex; flex-direction: column; gap: 2.25rem; }

      /* KPIs */
      .kpi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 1.1rem; }
      .kpi-card {
        position: relative;
        background: linear-gradient(160deg, var(--surface), var(--surface2));
        border-radius: var(--radius);
        padding: 1.4rem 1.5rem;
        border: 1px solid var(--border);
        box-shadow: var(--shadow-sm);
        overflow: hidden;
      }
      .kpi-card::before { content: ''; position: absolute; inset: 0 auto 0 0; width: 3px; background: var(--accent); opacity: 0.85; }
      .kpi-card.idle::before { background: var(--yellow); }
      .kpi-card.recs::before { background: var(--purple); }
      .kpi-card.savings::before { background: var(--green); }
      .kpi-card .label { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.09em; color: var(--muted); margin-bottom: 0.55rem; font-weight: 600; }
      .kpi-card .value { font-size: 2rem; font-weight: 700; letter-spacing: -0.02em; line-height: 1.1; }
      .kpi-card .sub { font-size: 0.78rem; color: var(--muted); margin-top: 0.4rem; }
      .kpi-card.cost .value { color: var(--accent); }
      .kpi-card.idle .value { color: var(--yellow); }
      .kpi-card.recs .value { color: var(--purple); }
      .kpi-card.savings .value { color: var(--green); }

      /* Sections and cards */
      section h2 {
        font-size: 0.8rem;
        font-weight: 700;
        margin-bottom: 0.9rem;
        color: var(--muted);
        text-transform: uppercase;
        letter-spacing: 0.11em;
        display: flex;
        align-items: center;
        gap: 0.7rem;
      }
      section h2::after { content: ''; flex: 1; height: 1px; background: linear-gradient(90deg, var(--border), transparent); }
      .card {
        background: var(--surface);
        border-radius: var(--radius);
        border: 1px solid var(--border);
        box-shadow: var(--shadow-sm);
        overflow: hidden;
      }
      /* Padding lives on the inner blocks so tables can still span edge to edge. */
      .card > .section-hint, .card > #waf-body, .card > #inaction-body,
      .card > #diff-container, .card > #ownership-container, .card > #remediation-container { padding: 1.25rem 1.5rem; }
      .card > .section-hint { padding-bottom: 0; }
      .section-hint { font-size: 0.82rem; color: var(--muted); line-height: 1.65; }

      /* Tables: the scroll container is what prevents the clipping. */
      .table-controls { display: flex; gap: 0.75rem; padding: 1rem 1.25rem; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
      .table-controls input, .table-controls select {
        background: var(--surface2); border: 1px solid var(--border); border-radius: var(--radius-sm);
        padding: 0.45rem 0.8rem; color: var(--text); font-size: 0.85rem; outline: none; font-family: inherit;
      }
      .table-controls input { flex: 1; min-width: 200px; }
      .table-controls input:focus, .table-controls select:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(56,189,248,0.12); }
      .table-scroll { width: 100%; overflow-x: auto; -webkit-overflow-scrolling: touch; }
      table { width: 100%; border-collapse: collapse; font-size: 0.86rem; }
      th {
        background: var(--surface2); padding: 0.7rem 1.1rem; text-align: left; font-weight: 700;
        color: var(--muted); font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.07em;
        white-space: nowrap; position: sticky; top: 0; z-index: 1;
        border-bottom: 1px solid var(--border);
      }
      td { padding: 0.75rem 1.1rem; border-bottom: 1px solid var(--border); vertical-align: top; }
      td:first-child { font-weight: 600; }
      tr:last-child td { border-bottom: none; }
      tbody tr:hover td { background: var(--surface2); }

      /* Badges */
      .badge { display: inline-block; padding: 0.2rem 0.6rem; border-radius: 999px; font-size: 0.67rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; white-space: nowrap; }
      .badge.low { background: rgba(74,222,128,0.14); color: var(--green); }
      .badge.medium { background: rgba(250,204,21,0.14); color: var(--yellow); }
      .badge.high { background: rgba(248,113,113,0.14); color: var(--red); }
      .badge.new { background: rgba(56,189,248,0.14); color: var(--accent); }
      .badge.waf-pass { background: rgba(74,222,128,0.14); color: var(--green); }
      .badge.waf-partial { background: rgba(250,204,21,0.14); color: var(--yellow); }
      .badge.waf-fail { background: rgba(248,113,113,0.14); color: var(--red); }
      .badge.waf-na { background: var(--surface3); color: var(--muted); }

      .score-bar { display: flex; align-items: center; gap: 0.5rem; }
      .score-bar-inner { height: 6px; border-radius: 3px; background: linear-gradient(90deg, var(--accent), var(--purple)); min-width: 4px; }

      /* Recommendations */
      .rec-list { display: flex; flex-direction: column; }
      .rec-item { padding: 1.2rem 1.5rem; border-bottom: 1px solid var(--border); display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 1rem; align-items: start; }
      .rec-item:last-child { border-bottom: none; }
      .rec-item:hover { background: var(--surface2); }
      .rec-title { font-weight: 600; margin-bottom: 0.3rem; }
      .rec-desc { font-size: 0.82rem; color: var(--muted); line-height: 1.6; }
      .rec-meta { display: flex; gap: 0.45rem; margin-top: 0.6rem; flex-wrap: wrap; }
      .rec-stats { text-align: right; white-space: nowrap; }
      .rec-savings { font-size: 1.15rem; font-weight: 700; color: var(--green); letter-spacing: -0.01em; }
      .rec-roi { font-size: 0.73rem; color: var(--muted); }

      /* Charts */
      .charts-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 1.1rem; }
      .chart-card { background: var(--surface); border-radius: var(--radius); border: 1px solid var(--border); padding: 1.4rem; box-shadow: var(--shadow-sm); }
      .chart-card h3 { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.09em; color: var(--muted); margin-bottom: 1.1rem; font-weight: 700; }
      .bar-chart { display: flex; flex-direction: column; gap: 0.65rem; }
      .bar-row { display: grid; grid-template-columns: minmax(0, 130px) minmax(0, 1fr) auto; align-items: center; gap: 0.65rem; font-size: 0.79rem; }
      .bar-row .bar-label { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .bar-track { background: var(--surface3); border-radius: 999px; height: 7px; overflow: hidden; }
      .bar-fill { height: 100%; border-radius: 999px; background: linear-gradient(90deg, var(--accent-strong), var(--accent)); transition: width 0.5s ease; }
      .bar-row .bar-val { text-align: right; color: var(--text); font-weight: 600; white-space: nowrap; }

      .empty { padding: 2.5rem; text-align: center; color: var(--muted); font-size: 0.88rem; }

      /* Warnings */
      .warning-banner { background: rgba(245,158,11,0.08); border: 1px solid rgba(245,158,11,0.35); border-left: 3px solid var(--amber); border-radius: var(--radius-sm); padding: 0.9rem 1.1rem; margin-bottom: 1.5rem; }
      .warning-banner h3 { font-size: 0.8rem; color: var(--amber); margin-bottom: 0.5rem; font-weight: 700; }
      .warning-banner ul { list-style: disc; padding-left: 1.25rem; }
      .warning-banner li { font-size: 0.8rem; color: #fcd34d; line-height: 1.65; }

      /* Executive summary */
      .exec-summary {
        background: linear-gradient(140deg, var(--surface2) 0%, var(--surface) 55%, #16233d 100%);
        border: 1px solid var(--border-strong);
        border-radius: var(--radius);
        padding: 1.75rem;
        box-shadow: var(--shadow);
        position: relative;
        overflow: hidden;
      }
      .exec-summary::before { content: ''; position: absolute; inset: 0 auto 0 0; width: 4px; background: linear-gradient(180deg, var(--accent), var(--purple)); }
      .exec-summary .exec-tag {
        display: inline-block; font-size: 0.63rem; text-transform: uppercase; letter-spacing: 0.13em;
        color: var(--accent); background: rgba(56,189,248,0.1); border: 1px solid rgba(56,189,248,0.35);
        border-radius: 999px; padding: 0.2rem 0.7rem; margin-bottom: 0.95rem; font-weight: 700;
      }
      .exec-headline { font-size: 1.25rem; font-weight: 600; line-height: 1.45; margin-bottom: 1.15rem; letter-spacing: -0.015em; }
      .exec-highlights { display: flex; flex-wrap: wrap; gap: 0.65rem; margin-bottom: 1.2rem; }
      .exec-chip { background: rgba(255,255,255,0.03); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 0.55rem 0.9rem; }
      .exec-chip .chip-label { display: block; font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.07em; color: var(--muted); font-weight: 600; }
      .exec-chip .chip-value { font-size: 1.05rem; font-weight: 700; letter-spacing: -0.01em; }
      .exec-chip.positive .chip-value { color: var(--green); }
      .exec-chip.negative .chip-value { color: var(--red); }
      .exec-summary p { font-size: 0.88rem; line-height: 1.75; color: var(--text); margin-bottom: 0.7rem; }
      .exec-actions { list-style: none; margin-top: 0.6rem; border-top: 1px solid var(--border); padding-top: 1rem; }
      .exec-actions li { font-size: 0.85rem; line-height: 1.75; color: var(--muted); }

      /* Well-Architected scorecard */
      .waf-header { display: flex; align-items: center; gap: 1.3rem; margin-bottom: 1.2rem; flex-wrap: wrap; }
      .waf-score {
        display: flex; align-items: baseline; gap: 0.6rem; padding: 0.85rem 1.3rem;
        border-radius: var(--radius); border: 1px solid var(--border-strong);
        background: linear-gradient(150deg, var(--surface2), var(--surface3));
        box-shadow: var(--shadow-sm); flex: none;
      }
      .waf-grade { font-size: 2.4rem; font-weight: 800; line-height: 1; letter-spacing: -0.03em; }
      .waf-number { font-size: 1.05rem; color: var(--muted); font-weight: 600; }
      .waf-number small { font-size: 0.72rem; font-weight: 400; }
      .waf-grade-A .waf-grade { color: var(--green); }
      .waf-grade-B .waf-grade { color: var(--green); }
      .waf-grade-C .waf-grade { color: var(--yellow); }
      .waf-grade-D .waf-grade { color: var(--amber); }
      .waf-grade-E .waf-grade { color: var(--red); }
      .waf-summary { margin: 0; flex: 1 1 260px; color: var(--muted); font-size: 0.88rem; line-height: 1.7; }

      /* Cost of inaction */
      .inaction-kpis { display: flex; flex-wrap: wrap; gap: 0.8rem; margin-bottom: 1rem; }
      .inaction-kpi { background: var(--surface2); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 0.7rem 1rem; min-width: 140px; flex: 1 1 140px; }
      .inaction-kpi span { display: block; font-size: 1.2rem; font-weight: 700; letter-spacing: -0.01em; }
      .inaction-kpi small { color: var(--muted); font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; }

      /* Evidence disclosure */
      .evidence { margin-top: 0.6rem; font-size: 0.78rem; }
      .evidence summary { cursor: pointer; color: var(--muted); user-select: none; list-style: none; display: inline-flex; align-items: center; gap: 0.35rem; }
      .evidence summary::-webkit-details-marker { display: none; }
      .evidence summary::before { content: '▸'; font-size: 0.7rem; }
      .evidence[open] summary::before { content: '▾'; }
      .evidence summary:hover { color: var(--accent); }
      .evidence ul { margin: 0.55rem 0; padding-left: 1.15rem; }
      .evidence li { margin-bottom: 0.25rem; color: var(--muted); }
      .evidence p { margin: 0.35rem 0; color: var(--muted); }
      .evidence .caveat { color: var(--amber); }
      .evidence a { color: var(--accent); text-decoration: none; border-bottom: 1px solid rgba(96,165,250,0.35); }
      .evidence a:hover { border-bottom-color: var(--accent); }
      .rationale summary { color: var(--accent); }
      .muted { color: var(--muted); font-size: 0.78rem; }

      /* Run comparison */
      .diff-summary { display: flex; flex-wrap: wrap; gap: 1.5rem; align-items: baseline; margin-bottom: 1.15rem; }
      .diff-total { font-size: 1.7rem; font-weight: 700; letter-spacing: -0.02em; }
      .diff-total.up { color: var(--red); }
      .diff-total.down { color: var(--green); }
      .diff-note { font-size: 0.8rem; color: var(--muted); }
      .delta-up { color: var(--red); }
      .delta-down { color: var(--green); }
      .diff-lists { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 1.2rem; margin-top: 1.2rem; }
      .diff-lists h4 { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); margin-bottom: 0.55rem; font-weight: 700; }
      .diff-lists ul { list-style: none; }
      .diff-lists li { font-size: 0.82rem; padding: 0.28rem 0; color: var(--text); }

      /* Showback / chargeback */
      .coverage-bar { background: var(--surface3); border-radius: 999px; height: 8px; overflow: hidden; margin: 0.55rem 0 1.1rem; }
      .coverage-fill { height: 100%; background: linear-gradient(90deg, var(--green), #22c55e); border-radius: 999px; }
      .owner-resources { font-size: 0.78rem; color: var(--muted); }

      /* Remediation plan */
      .rem-item { border: 1px solid var(--border); border-radius: var(--radius-sm); margin-bottom: 0.6rem; overflow: hidden; }
      .rem-item > summary { cursor: pointer; padding: 0.85rem 1.1rem; background: var(--surface2); display: flex; flex-wrap: wrap; gap: 0.6rem; align-items: center; font-size: 0.87rem; list-style: none; }
      .rem-item > summary::-webkit-details-marker { display: none; }
      .rem-item > summary::before { content: '▸'; color: var(--muted); flex: none; }
      .rem-item[open] > summary::before { content: '▾'; }
      .rem-item > summary:hover { background: var(--surface3); }
      .rem-body { padding: 1.1rem; }
      .rem-body h4 { font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); margin: 1rem 0 0.45rem; font-weight: 700; }
      .rem-body h4:first-child { margin-top: 0; }
      .rem-step { margin-bottom: 0.55rem; }
      .rem-step .step-desc { font-size: 0.78rem; color: var(--muted); margin-bottom: 0.25rem; }
      pre.code {
        background: #080e1c; border: 1px solid var(--border); border-radius: var(--radius-sm);
        padding: 0.7rem 0.85rem; overflow-x: auto; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 0.76rem; line-height: 1.65; color: #cbd5e1; white-space: pre;
      }
      code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.86em; background: var(--surface3); padding: 0.1rem 0.35rem; border-radius: 4px; }
      .rem-tabs { display: flex; gap: 0.4rem; margin-bottom: 0.55rem; flex-wrap: wrap; }
      .rem-tabs button { background: var(--surface2); border: 1px solid var(--border); color: var(--muted); border-radius: 6px; padding: 0.3rem 0.75rem; font-size: 0.74rem; cursor: pointer; font-family: inherit; }
      .rem-tabs button:hover { color: var(--text); }
      .rem-tabs button.active { color: var(--text); border-color: var(--accent); background: rgba(56,189,248,0.1); }
      .downtime-flag { color: var(--amber); font-size: 0.75rem; }

      @media (max-width: 720px) {
        header { padding: 0.9rem 1.1rem; position: static; }
        header span { margin-left: 0; width: 100%; }
        main { padding: 1.1rem; gap: 1.6rem; }
        .exec-summary { padding: 1.2rem; }
        .exec-headline { font-size: 1.05rem; }
        .kpi-card .value { font-size: 1.6rem; }
        .bar-row { grid-template-columns: minmax(0, 90px) minmax(0, 1fr) auto; }
        .rec-item { grid-template-columns: minmax(0, 1fr); }
        .rec-stats { text-align: left; }
        .card > .section-hint, .card > #waf-body, .card > #inaction-body,
        .card > #diff-container, .card > #ownership-container, .card > #remediation-container { padding: 1rem; }
      }

      /* Executives read this as a PDF, so the dark theme is inverted for print
         and every collapsible block is expanded so nothing is lost on paper. */
      @media print {
        :root { --bg: #fff; --surface: #fff; --surface2: #f6f8fc; --surface3: #eef2f9; --border: #d3dced; --border-strong: #b9c6dd; --text: #101828; --muted: #5b6b85; --shadow: none; --shadow-sm: none; }
        body { background: #fff; }
        header { position: static; border-bottom: 2px solid var(--border-strong); }
        main { max-width: none; padding: 0 1rem; gap: 1.5rem; }
        section, .card, .kpi-card, .chart-card, .exec-summary { break-inside: avoid; box-shadow: none; }
        .table-controls, .rem-tabs { display: none; }
        .evidence[open] summary::before, .evidence summary::before { content: ''; }
        details { display: block; }
        details > summary { list-style: none; }
        pre.code { white-space: pre-wrap; }
      }
    </style>
  </head>
  <body>
    <header>
      <h1>Relatório do Azure Cost Analyzer</h1>
      <span id="report-meta"></span>
    </header>
    <main>
      <div id="report-warnings"></div>
      <div id="exec-summary"></div>
      <div class="kpi-grid">
        <div class="kpi-card cost">
          <div class="label">Custo Total</div>
          <div class="value" id="kpi-cost"></div>
          <div class="sub" id="kpi-cost-sub"></div>
        </div>
        <div class="kpi-card idle">
          <div class="label">Recursos Ociosos</div>
          <div class="value" id="kpi-idle"></div>
          <div class="sub">Recursos com baixa utilização</div>
        </div>
        <div class="kpi-card recs">
          <div class="label">Recomendações</div>
          <div class="value" id="kpi-recs"></div>
          <div class="sub">Oportunidades de otimização</div>
        </div>
        <div class="kpi-card savings">
          <div class="label">Economia Anual Potencial</div>
          <div class="value" id="kpi-savings"></div>
          <div class="sub">Economia estimada se todas as recomendações forem aplicadas</div>
        </div>
      </div>

      <section id="decision-section" hidden>
        <h2>FinOps Decision Engine</h2>
        <div class="card">
          <p class="section-hint">Cada recomendação classificada por prontidão de execução e pela confiabilidade da economia estimada, para separar o que já pode ser executado do que ainda precisa de validação ou de mais evidência.</p>
          <div id="decision-body"></div>
        </div>
      </section>

      <section>
        <h2>Recursos Ociosos</h2>
        <div class="card">
          <div class="table-controls">
            <input id="idle-filter" type="text" placeholder="Filtrar por nome ou resource group…" oninput="renderIdleTable()" />
            <select id="idle-sort" onchange="renderIdleTable()">
              <option value="idleScore-desc">Score de ociosidade ↓</option>
              <option value="idleScore-asc">Score de ociosidade ↑</option>
              <option value="estimatedMonthlySavings-desc">Economia ↓</option>
              <option value="estimatedMonthlySavings-asc">Economia ↑</option>
            </select>
          </div>
          <div id="idle-table-container"></div>
        </div>
      </section>

      <section id="waf-section" hidden>
        <h2>Well-Architected · Cost Optimization</h2>
        <div class="card">
          <p class="section-hint">Avaliação automática do pilar Cost Optimization do Azure Well-Architected Framework. Cada controle é respondido com evidência coletada do próprio tenant, e não por questionário manual.</p>
          <div id="waf-body"></div>
        </div>
      </section>

      <section id="inaction-section" hidden>
        <h2>Custo da Inação</h2>
        <div class="card">
          <p class="section-hint">Recomendações que já constavam no relatório anterior e continuam em aberto, com o valor que já deixou de ser economizado desde a primeira detecção.</p>
          <div id="inaction-body"></div>
        </div>
      </section>

      <section id="diff-section" hidden>
        <h2>Comparativo com a Execução Anterior</h2>
        <div class="card">
          <p class="section-hint">Mostra o que mudou desde o último relatório e qual service ou resource group causou a variação.</p>
          <div id="diff-container"></div>
        </div>
      </section>

      <section id="ownership-section" hidden>
        <h2>Desperdício por Responsável</h2>
        <div class="card">
          <p class="section-hint">Atribui o desperdício ao responsável identificado pelas tags de owner/team/cost center. Quando não há tag, o resource group é usado como fronteira de responsabilidade.</p>
          <div id="ownership-container"></div>
        </div>
      </section>

      <section>
        <h2>Recomendações</h2>
        <div class="card" id="recs-container"></div>
      </section>

      <section id="remediation-section" hidden>
        <h2>Plano de Remediação</h2>
        <div class="card">
          <p class="section-hint">Comandos prontos para executar, validar e reverter cada recomendação. O script <code>apply-remediation.sh</code> gerado ao lado deste relatório executa tudo em modo simulação por padrão.</p>
          <div id="remediation-container"></div>
        </div>
      </section>

      <section>
        <h2>Distribuição de Custos</h2>
        <div class="charts-grid">
          <div class="chart-card">
            <h3>Por Service</h3>
            <div id="chart-service" class="bar-chart"></div>
          </div>
          <div class="chart-card">
            <h3>Por Resource Group</h3>
            <div id="chart-rg" class="bar-chart"></div>
          </div>
          <div class="chart-card" id="card-loc" hidden>
            <h3>Por Location</h3>
            <div id="chart-loc" class="bar-chart"></div>
          </div>
        </div>
      </section>
    </main>

    <script id="report-data" type="application/json">${embeddedData}</script>
    <script>${REPORT_CLIENT_SCRIPT}
    </script>
  </body>
</html>
`;
};
