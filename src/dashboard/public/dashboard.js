(function (global) {
  const SAFE_LEVELS = new Set(['low', 'medium', 'high']);

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function normalizeLevel(value) {
    const normalized = String(value ?? 'medium').toLowerCase();
    return SAFE_LEVELS.has(normalized) ? normalized : 'medium';
  }

  function formatCurrency(value) {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) {
      return '$0.00';
    }
    return `$${numericValue.toFixed(2)}`;
  }

  function buildRecsMarkup(recsData) {
    if (!Array.isArray(recsData) || recsData.length === 0) {
      return '<div class="rec-item">No recommendations found.</div>';
    }

    return recsData
      .map((item) => {
        const risk = normalizeLevel(item && item.risk);
        const effort = normalizeLevel(item && item.effort);
        const title = escapeHtml(item && item.title);
        const description = escapeHtml(item && item.description);
        const actionType = escapeHtml(item && item.actionType);
        const status = escapeHtml(item && item.status);

        return `<div class="rec-item">
          <strong>${title}</strong>
          <div>${description}</div>
          <div class="pills">
            <span class="pill">Action: ${actionType}</span>
            <span class="pill">Status: ${status}</span>
            <span class="pill risk-${risk}">Risk: ${risk}</span>
            <span class="pill effort-${effort}">Effort: ${effort}</span>
          </div>
        </div>`;
      })
      .join('');
  }

  function renderRecs(recsData, target) {
    const element = target || (global.document && global.document.getElementById('recs-list'));
    if (!element) {
      return;
    }
    element.innerHTML = buildRecsMarkup(recsData);
  }

  function buildBarChartMarkup(data) {
    const entries = Object.entries(data || {});
    if (entries.length === 0) {
      return '<div class="bar-row">No data available.</div>';
    }

    const max = Math.max(...entries.map(([, rawValue]) => Number(rawValue) || 0), 1);

    return entries
      .map(([label, rawValue]) => {
        const value = Number(rawValue) || 0;
        const pct = Math.max(0, Math.min(100, Math.round((value / max) * 100)));
        const safeLabel = escapeHtml(label);
        return `<div class="bar-row">
          <div class="bar-label" title="${safeLabel}">${safeLabel}</div>
          <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
          <div>${value}</div>
        </div>`;
      })
      .join('');
  }

  function renderBarChart(data, target) {
    const element = target;
    if (!element) {
      return;
    }
    element.innerHTML = buildBarChartMarkup(data);
  }

  async function loadDashboard() {
    try {
      const [summaryRes, costsRes, idleRes, recsRes] = await Promise.all([
        fetch('/api/summary'),
        fetch('/api/costs?period=3&groupBy=service'),
        fetch('/api/resources/idle'),
        fetch('/api/recommendations'),
      ]);
      const [summary, costs, idleResources, recommendations] = await Promise.all([
        summaryRes.json(),
        costsRes.json(),
        idleRes.json(),
        recsRes.json(),
      ]);

      if (global.document) {
        global.document.getElementById('kpi-cost').textContent = formatCurrency(summary.totalCost);
        global.document.getElementById('kpi-idle').textContent = String(summary.idleResourceCount ?? 0);
        global.document.getElementById('kpi-recs').textContent = String(summary.recommendationCount ?? 0);
        global.document.getElementById('kpi-savings').textContent = formatCurrency(summary.annualSavingsOpportunity);
      }

      const costsBreakdown = costs && costs.breakdown ? costs.breakdown : {};
      const idleBreakdown = Array.isArray(idleResources)
        ? idleResources.reduce((acc, item) => {
            const key = item && item.resource && item.resource.type ? String(item.resource.type) : 'unknown';
            acc[key] = (acc[key] || 0) + 1;
            return acc;
          }, {})
        : {};

      renderBarChart(costsBreakdown, global.document && global.document.getElementById('chart-costs'));
      renderBarChart(idleBreakdown, global.document && global.document.getElementById('chart-idle'));
      renderRecs(recommendations);
    } catch (_error) {
      if (global.document) {
        const recs = global.document.getElementById('recs-list');
        if (recs) {
          recs.innerHTML = '<div class="rec-item">Failed to load dashboard data.</div>';
        }
      }
    }
  }

  const dashboardUI = {
    escapeHtml,
    normalizeLevel,
    buildRecsMarkup,
    renderRecs,
    buildBarChartMarkup,
    renderBarChart,
    loadDashboard,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = dashboardUI;
  }

  global.dashboardUI = dashboardUI;

  if (global.document) {
    global.document.addEventListener('DOMContentLoaded', () => {
      void loadDashboard();
    });
  }
})(typeof window === 'undefined' ? globalThis : window);
