import path from 'node:path';

import request from 'supertest';

import { createDashboardApp, startDashboardServer } from '@/dashboard/server';
import { resetConfig } from '@/config';
import {
  mockCostSummary,
  mockIdleResources,
  mockRecommendations,
  validEnv,
} from '../fixtures/mock-data';

describe('dashboard routes', () => {
  const app = createDashboardApp({
    publicDir: path.resolve(__dirname, '../../src/dashboard/public'),
    subscriptionId: 'sub-id',
    costAnalyzer: {
      queryCosts: vi.fn(async () => mockCostSummary),
    } as never,
    resourceDetector: {
      detectAll: vi.fn(async () => mockIdleResources),
    } as never,
    optimizer: {
      generateRecommendations: vi.fn(async () => mockRecommendations),
    } as never,
  });

  it.each(['/health', '/api/health'])('returns health status for %s', async (route) => {
    const response = await request(app).get(route);
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
  });

  it('returns cost summary', async () => {
    const response = await request(app).get('/api/costs?period=3&groupBy=service');
    expect(response.status).toBe(200);
    expect(response.body.totalAmount).toBe(1105);
  });

  it('returns idle resources', async () => {
    const response = await request(app).get('/api/resources/idle');
    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(2);
  });

  it('returns recommendations', async () => {
    const response = await request(app).get('/api/recommendations');
    expect(response.status).toBe(200);
    expect(response.body[0].id).toBe('rec-1');
  });

  it('returns summary statistics', async () => {
    const response = await request(app).get('/api/summary');
    expect(response.status).toBe(200);
    expect(response.body.idleResourceCount).toBe(2);
  });

  it('serves the dashboard spa shell', async () => {
    const response = await request(app).get('/');
    expect(response.status).toBe(200);
    expect(response.text).toContain('Azure Cost Analyzer Dashboard');
    expect(response.text).toContain('Idle Resources');
    expect(response.text).toContain('function escapeHtml');
    expect(response.text).toContain('/api/health');
    expect(response.text).not.toContain('Replace this placeholder');
  });

  it('validates invalid costs query parameters', async () => {
    const response = await request(app).get('/api/costs?period=99');
    expect(response.status).toBe(500);
  });

  it.each(['/dashboard', '/reports'])('falls back to index html for %s', async (route) => {
    const response = await request(app).get(route);
    expect(response.status).toBe(200);
    expect(response.text).toContain('Recommendations');
    expect(response.text).toContain('/api/recommendations');
  });

  it('starts the dashboard server with graceful shutdown hooks', async () => {
    process.env = { ...process.env, ...validEnv };
    resetConfig();
    const server = await startDashboardServer({
      port: 0,
      subscriptionId: 'sub-id',
      publicDir: path.resolve(__dirname, '../../src/dashboard/public'),
      costAnalyzer: {
        queryCosts: vi.fn(async () => mockCostSummary),
      } as never,
      resourceDetector: {
        detectAll: vi.fn(async () => mockIdleResources),
      } as never,
      optimizer: {
        generateRecommendations: vi.fn(async () => mockRecommendations),
      } as never,
    });
    expect(server.listening).toBe(true);
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  });
});
