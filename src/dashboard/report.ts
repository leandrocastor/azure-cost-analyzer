import type {
  CostDiff,
  CostSummary,
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

      const fmt = (n) => typeof n === 'number' ? '$' + n.toLocaleString('pt-BR', { maximumFractionDigits: 0 }) : '—';
      const fmtFull = (n) => typeof n === 'number' ? '$' + n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';

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
        container.innerHTML = '<table>' + thead + '<tbody>' + tbody + '</tbody></table>';
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
          + '<table><thead><tr><th>Código</th><th>Controle</th><th>Situação</th><th>Impacto</th><th>Recomendação</th></tr></thead>'
          + '<tbody>' + rows + '</tbody></table>';
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
          ? '<table><thead><tr><th>Recurso</th><th>Em aberto</th><th>Desperdício mensal</th><th>Já desperdiçado</th></tr></thead><tbody>' + rows + '</tbody></table>'
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
          + (evidence.caveat ? '<p class="caveat">' + esc(evidence.caveat) + '</p>' : '')
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
        return '<table><thead><tr><th>Item</th><th>Anterior</th><th>Atual</th><th>Variação</th><th>%</th></tr></thead>'
          + '<tbody>' + body + '</tbody></table>';
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
          + '<table><thead><tr><th>Responsável</th><th>Origem</th><th>Recursos</th><th>Desperdício mensal</th>'
          + '<th>Desperdício anual</th><th>Participação</th><th>Principais recursos</th></tr></thead>'
          + '<tbody>' + rows + '</tbody></table>';
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
        --bg: #0f172a;
        --surface: #1e293b;
        --surface2: #263248;
        --border: #334155;
        --text: #e2e8f0;
        --muted: #94a3b8;
        --accent: #38bdf8;
        --green: #4ade80;
        --yellow: #facc15;
        --red: #f87171;
        --purple: #c084fc;
        --radius: 12px;
        --shadow: 0 4px 24px rgba(0,0,0,0.4);
      }
      body { font-family: system-ui, -apple-system, sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; }
      header { background: var(--surface); border-bottom: 1px solid var(--border); padding: 1rem 2rem; display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; }
      header h1 { font-size: 1.25rem; font-weight: 700; color: var(--accent); }
      header span { font-size: 0.75rem; color: var(--muted); margin-left: auto; }
      main { max-width: 1400px; margin: 0 auto; padding: 2rem; display: flex; flex-direction: column; gap: 2rem; }
      .kpi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1.25rem; }
      .kpi-card { background: var(--surface); border-radius: var(--radius); padding: 1.5rem; border: 1px solid var(--border); box-shadow: var(--shadow); }
      .kpi-card .label { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); margin-bottom: 0.5rem; }
      .kpi-card .value { font-size: 2rem; font-weight: 700; }
      .kpi-card .sub { font-size: 0.8rem; color: var(--muted); margin-top: 0.25rem; }
      .kpi-card.cost .value { color: var(--accent); }
      .kpi-card.idle .value { color: var(--yellow); }
      .kpi-card.recs .value { color: var(--purple); }
      .kpi-card.savings .value { color: var(--green); }
      section h2 { font-size: 1rem; font-weight: 600; margin-bottom: 1rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; }
      .card { background: var(--surface); border-radius: var(--radius); border: 1px solid var(--border); box-shadow: var(--shadow); overflow: hidden; }
      .table-controls { display: flex; gap: 0.75rem; padding: 1rem; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
      .table-controls input, .table-controls select { background: var(--surface2); border: 1px solid var(--border); border-radius: 8px; padding: 0.4rem 0.75rem; color: var(--text); font-size: 0.85rem; outline: none; }
      .table-controls input:focus, .table-controls select:focus { border-color: var(--accent); }
      table { width: 100%; border-collapse: collapse; font-size: 0.875rem; }
      th { background: var(--surface2); padding: 0.75rem 1rem; text-align: left; font-weight: 600; color: var(--muted); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; white-space: nowrap; }
      td { padding: 0.75rem 1rem; border-bottom: 1px solid var(--border); }
      tr:last-child td { border-bottom: none; }
      tr:hover td { background: var(--surface2); }
      .badge { display: inline-block; padding: 0.2rem 0.6rem; border-radius: 999px; font-size: 0.7rem; font-weight: 600; text-transform: uppercase; }
      .badge.low { background: #14532d; color: var(--green); }
      .badge.medium { background: #713f12; color: var(--yellow); }
      .badge.high { background: #7f1d1d; color: var(--red); }
      .badge.new { background: #1e3a5f; color: var(--accent); }
      .score-bar { display: flex; align-items: center; gap: 0.5rem; }
      .score-bar-inner { height: 6px; border-radius: 3px; background: var(--accent); min-width: 4px; }
      .rec-list { display: flex; flex-direction: column; gap: 0; }
      .rec-item { padding: 1.25rem; border-bottom: 1px solid var(--border); display: grid; grid-template-columns: 1fr auto; gap: 0.5rem; align-items: start; }
      .rec-item:last-child { border-bottom: none; }
      .rec-item:hover { background: var(--surface2); }
      .rec-title { font-weight: 600; margin-bottom: 0.25rem; }
      .rec-desc { font-size: 0.8rem; color: var(--muted); }
      .rec-meta { display: flex; gap: 0.5rem; margin-top: 0.5rem; flex-wrap: wrap; }
      .rec-stats { text-align: right; }
      .rec-savings { font-size: 1.1rem; font-weight: 700; color: var(--green); }
      .rec-roi { font-size: 0.75rem; color: var(--muted); }
      .charts-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 1.25rem; }
      .chart-card { background: var(--surface); border-radius: var(--radius); border: 1px solid var(--border); padding: 1.25rem; }
      .chart-card h3 { font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin-bottom: 1rem; }
      .bar-chart { display: flex; flex-direction: column; gap: 0.6rem; }
      .bar-row { display: grid; grid-template-columns: 120px 1fr 70px; align-items: center; gap: 0.5rem; font-size: 0.8rem; }
      .bar-row .bar-label { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .bar-track { background: var(--surface2); border-radius: 4px; height: 8px; overflow: hidden; }
      .bar-fill { height: 100%; border-radius: 4px; background: var(--accent); transition: width 0.4s ease; }
      .bar-row .bar-val { text-align: right; color: var(--text); font-weight: 500; }
      .empty { padding: 2rem; text-align: center; color: var(--muted); font-size: 0.9rem; }
      @media (max-width: 640px) {
        main { padding: 1rem; }
        .bar-row { grid-template-columns: 80px 1fr 55px; }
        .rec-item { grid-template-columns: 1fr; }
      }
      .warning-banner { background: #3a2a12; border: 1px solid #a16207; border-radius: 8px; padding: 0.85rem 1rem; margin-bottom: 1.5rem; }
      .warning-banner h3 { font-size: 0.85rem; color: #fbbf24; margin-bottom: 0.5rem; }
      .warning-banner ul { list-style: disc; padding-left: 1.25rem; }
      .warning-banner li { font-size: 0.8rem; color: #fcd34d; line-height: 1.6; }

      /* Sumário executivo */
      .exec-summary { background: linear-gradient(135deg, #1e293b, #1a2744); border: 1px solid var(--border); border-left: 4px solid var(--accent); border-radius: var(--radius); padding: 1.5rem; margin-bottom: 1.75rem; }
      .exec-summary .exec-tag { display: inline-block; font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.1em; color: var(--accent); border: 1px solid var(--accent); border-radius: 999px; padding: 0.15rem 0.6rem; margin-bottom: 0.85rem; }
      .exec-headline { font-size: 1.15rem; font-weight: 600; line-height: 1.5; margin-bottom: 1rem; }
      .exec-highlights { display: flex; flex-wrap: wrap; gap: 0.6rem; margin-bottom: 1.1rem; }
      /* Well-Architected scorecard */
      .waf-header { display: flex; align-items: center; gap: 1.2rem; margin-bottom: 1rem; flex-wrap: wrap; }
      .waf-score { display: flex; align-items: baseline; gap: 0.6rem; padding: 0.7rem 1.1rem; border-radius: 12px; border: 1px solid var(--border); background: var(--surface2); }
      .waf-grade { font-size: 2.1rem; font-weight: 700; line-height: 1; }
      .waf-number { font-size: 1.1rem; color: var(--muted); }
      .waf-number small { font-size: 0.75rem; }
      .waf-grade-A .waf-grade { color: var(--green); }
      .waf-grade-B .waf-grade { color: var(--green); }
      .waf-grade-C .waf-grade { color: #d29922; }
      .waf-grade-D .waf-grade { color: #f0883e; }
      .waf-grade-E .waf-grade { color: var(--red); }
      .waf-summary { margin: 0; flex: 1; min-width: 260px; color: var(--muted); }
      .badge.waf-pass { background: rgba(63,185,80,0.15); color: var(--green); }
      .badge.waf-partial { background: rgba(210,153,34,0.15); color: #d29922; }
      .badge.waf-fail { background: rgba(248,81,73,0.15); color: var(--red); }
      .badge.waf-na { background: var(--surface2); color: var(--muted); }

      /* Cost of inaction */
      .inaction-kpis { display: flex; flex-wrap: wrap; gap: 0.8rem; margin-bottom: 0.9rem; }
      .inaction-kpi { background: var(--surface2); border: 1px solid var(--border); border-radius: 8px; padding: 0.6rem 0.9rem; min-width: 130px; }
      .inaction-kpi span { display: block; font-size: 1.15rem; font-weight: 600; }
      .inaction-kpi small { color: var(--muted); font-size: 0.72rem; }

      /* Evidence disclosure */
      .evidence { margin-top: 0.5rem; font-size: 0.78rem; }
      .evidence summary { cursor: pointer; color: var(--muted); user-select: none; }
      .evidence summary:hover { color: var(--fg); }
      .evidence ul { margin: 0.5rem 0; padding-left: 1.1rem; }
      .evidence li { margin-bottom: 0.2rem; }
      .evidence p { margin: 0.3rem 0; }
      .evidence .caveat { color: #d29922; }
      .muted { color: var(--muted); font-size: 0.78rem; }

      .exec-chip { background: var(--surface2); border: 1px solid var(--border); border-radius: 8px; padding: 0.5rem 0.8rem; }
      .exec-chip .chip-label { display: block; font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); }
      .exec-chip .chip-value { font-size: 1rem; font-weight: 600; }
      .exec-chip.positive .chip-value { color: var(--green); }
      .exec-chip.negative .chip-value { color: #f87171; }
      .exec-summary p { font-size: 0.88rem; line-height: 1.7; color: var(--text); margin-bottom: 0.7rem; }
      .exec-actions { list-style: none; margin-top: 0.5rem; border-top: 1px solid var(--border); padding-top: 0.9rem; }
      .exec-actions li { font-size: 0.85rem; line-height: 1.7; color: var(--muted); }

      /* Comparativo entre execuções */
      .diff-summary { display: flex; flex-wrap: wrap; gap: 1.5rem; align-items: baseline; margin-bottom: 1.1rem; }
      .diff-total { font-size: 1.6rem; font-weight: 700; }
      .diff-total.up { color: #f87171; }
      .diff-total.down { color: var(--green); }
      .diff-note { font-size: 0.8rem; color: var(--muted); }
      .delta-up { color: #f87171; }
      .delta-down { color: var(--green); }
      .diff-lists { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 1rem; margin-top: 1rem; }
      .diff-lists h4 { font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin-bottom: 0.5rem; }
      .diff-lists ul { list-style: none; }
      .diff-lists li { font-size: 0.82rem; padding: 0.25rem 0; color: var(--text); }

      /* Responsáveis (showback/chargeback) */
      .coverage-bar { background: var(--surface2); border-radius: 999px; height: 8px; overflow: hidden; margin: 0.5rem 0 1rem; }
      .coverage-fill { height: 100%; background: var(--green); border-radius: 999px; }
      .owner-resources { font-size: 0.78rem; color: var(--muted); }

      /* Plano de remediação */
      .rem-item { border: 1px solid var(--border); border-radius: 8px; margin-bottom: 0.6rem; overflow: hidden; }
      .rem-item > summary { cursor: pointer; padding: 0.8rem 1rem; background: var(--surface2); display: flex; flex-wrap: wrap; gap: 0.6rem; align-items: center; font-size: 0.88rem; }
      .rem-item > summary::-webkit-details-marker { display: none; }
      .rem-item > summary::before { content: '▸'; color: var(--muted); }
      .rem-item[open] > summary::before { content: '▾'; }
      .rem-body { padding: 1rem; }
      .rem-body h4 { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin: 0.9rem 0 0.4rem; }
      .rem-body h4:first-child { margin-top: 0; }
      .rem-step { margin-bottom: 0.5rem; }
      .rem-step .step-desc { font-size: 0.78rem; color: var(--muted); margin-bottom: 0.2rem; }
      pre.code { background: #0b1120; border: 1px solid var(--border); border-radius: 6px; padding: 0.65rem 0.8rem; overflow-x: auto; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.76rem; line-height: 1.6; color: #cbd5e1; white-space: pre; }
      .rem-tabs { display: flex; gap: 0.4rem; margin-bottom: 0.5rem; }
      .rem-tabs button { background: var(--surface2); border: 1px solid var(--border); color: var(--muted); border-radius: 6px; padding: 0.3rem 0.7rem; font-size: 0.75rem; cursor: pointer; font-family: inherit; }
      .rem-tabs button.active { color: var(--text); border-color: var(--accent); }
      .downtime-flag { color: #fbbf24; font-size: 0.75rem; }
      .section-hint { font-size: 0.82rem; color: var(--muted); margin-bottom: 0.9rem; line-height: 1.6; }
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
