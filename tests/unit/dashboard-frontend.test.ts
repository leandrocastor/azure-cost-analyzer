import path from 'node:path';
import fs from 'node:fs';
import vm from 'node:vm';

type DashboardUI = {
  escapeHtml: (value: unknown) => string;
  buildRecsMarkup: (data: unknown[]) => string;
  buildBarChartMarkup: (data: Record<string, unknown>) => string;
};

const loadDashboardUI = (): DashboardUI => {
  const scriptPath = path.resolve(__dirname, '../../src/dashboard/public/dashboard.js');
  const source = fs.readFileSync(scriptPath, 'utf8');
  const sandbox: {
    module: { exports?: DashboardUI };
    window: Record<string, unknown>;
    globalThis: Record<string, unknown>;
  } = {
    module: { exports: {} as DashboardUI },
    window: {},
    globalThis: {},
  };
  vm.runInNewContext(source, sandbox);
  if (!sandbox.module.exports) {
    throw new Error('dashboardUI module exports not found');
  }
  return sandbox.module.exports;
};

const dashboardUI = loadDashboardUI();

describe('dashboard frontend sanitization', () => {
  it('escapes HTML special characters', () => {
    expect(dashboardUI.escapeHtml(`<&>"'`)).toBe('&lt;&amp;&gt;&quot;&#39;');
  });

  it('sanitizes recommendation fields and clamps risk/effort classes', () => {
    const html = dashboardUI.buildRecsMarkup([
      {
        title: '<img src=x onerror=alert(1)>',
        description: 'desc<script>alert(1)</script>',
        actionType: '"DELETE"',
        status: "active' onclick='alert(1)",
        risk: 'critical',
        effort: 'unknown',
      },
    ]);

    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('desc&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&quot;DELETE&quot;');
    expect(html).toContain('active&#39; onclick=&#39;alert(1)');
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('risk-medium');
    expect(html).toContain('effort-medium');
  });

  it('sanitizes bar chart labels in title and text', () => {
    const html = dashboardUI.buildBarChartMarkup({
      '"><svg/onload=alert(1)>': 10,
    });

    expect(html).toContain('&quot;&gt;&lt;svg/onload=alert(1)&gt;');
    expect(html).toContain('title="&quot;&gt;&lt;svg/onload=alert(1)&gt;"');
    expect(html).not.toContain('<svg/onload=alert(1)>');
  });
});
