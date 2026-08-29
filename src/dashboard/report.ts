import type { CostSummary, IdleResource, Recommendation } from '@/models';

export type StaticReportData = {
  generatedAt: string;
  subscriptionId: string;
  costs: CostSummary;
  idleResources: IdleResource[];
  recommendations: Recommendation[];
  warnings?: string[];
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
    </style>
  </head>
  <body>
    <header>
      <h1>Relatório do Azure Cost Analyzer</h1>
      <span id="report-meta"></span>
    </header>
    <main>
      <div id="report-warnings"></div>
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

      <section>
        <h2>Recomendações</h2>
        <div class="card" id="recs-container"></div>
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
          <div class="chart-card">
            <h3>Por Location</h3>
            <div id="chart-loc" class="bar-chart"></div>
          </div>
        </div>
      </section>
    </main>

    <script id="report-data" type="application/json">${embeddedData}</script>
    <script>
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

        const thead = '<thead><tr><th>Nome</th><th>Tipo</th><th>Resource Group</th><th>Location</th><th>Score de ociosidade</th><th>Economia mensal</th><th>Motivo</th></tr></thead>';
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
            + '<td style="color:var(--muted);font-size:0.8rem">' + esc(r.reason || '—') + '</td>'
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

      renderIdleTable();
      renderRecs();
      renderBarChart('chart-service', REPORT.costs.byService);
      renderBarChart('chart-rg', REPORT.costs.byResourceGroup);
      renderBarChart('chart-loc', REPORT.costs.byLocation);
    </script>
  </body>
</html>
`;
};
