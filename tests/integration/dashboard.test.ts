import path from 'node:path';
import { createServer } from 'node:http';

import request from 'supertest';

import { createDashboardApp, errorToMessage, startDashboardServer } from '@/dashboard/server';
import { resetConfig } from '@/config';
import {
  mockCostSummary,
  mockIdleResources,
  mockRecommendations,
  validEnv,
} from '../fixtures/mock-data';

import type { Express } from 'express';

const makeApp = (): Express =>
  createDashboardApp({
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

describe('dashboard routes', () => {
  const app = makeApp();

  it('returns health status', async () => {
    const response = await request(app).get('/health');
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
  });

  it('returns health response with ISO timestamp', async () => {
    const before = Date.now();
    const response = await request(app).get('/health');
    const after = Date.now();
    expect(response.status).toBe(200);
    expect(response.body.timestamp).toBeDefined();
    const ts = new Date(response.body.timestamp as string).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
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

  it('serves the dashboard frontend', async () => {
    const response = await request(app).get('/');
    expect(response.status).toBe(200);
    expect(response.text).toContain('Azure Cost Analyzer Dashboard');
  });

  it('validates invalid costs query parameters', async () => {
    const response = await request(app).get('/api/costs?period=99');
    expect(response.status).toBe(500);
    expect(response.body.error).toContain('"period"');
  });

  it('normalizes non-Error values with errorToMessage', () => {
    const nonErrorValue = [{ code: 'invalid_period', path: ['period'] }];
    expect(errorToMessage(nonErrorValue)).toBe(JSON.stringify(nonErrorValue));
    expect(errorToMessage('plain error')).toBe('plain error');
    expect(errorToMessage(null)).toBe('Unknown error');
  });

  it('returns JSON error body from the error handler', async () => {
    const response = await request(app).get('/api/costs?period=99');
    expect(response.status).toBe(500);
    expect(response.headers['content-type']).toMatch(/json/);
    expect(response.body).toHaveProperty('error');
  });

  it.each(['/dashboard', '/reports'])('falls back to index html for %s', async (route) => {
    const response = await request(app).get(route);
    expect(response.status).toBe(200);
    expect(response.text).toContain('Azure Cost Analyzer Dashboard');
  });

  it('includes CORS headers in API responses', async () => {
    const response = await request(app)
      .get('/api/summary')
      .set('Origin', 'http://localhost:3001');
    expect(response.headers['access-control-allow-origin']).toBeDefined();
  });

  it('rate-limits the static asset fallback after 120 requests', async () => {
    const isolatedApp = makeApp();
    const promises = Array.from({ length: 122 }, () =>
      request(isolatedApp).get('/some-spa-route'),
    );
    const responses = await Promise.all(promises);
    const limited = responses.filter((r) => r.status === 429);
    expect(limited.length).toBeGreaterThan(0);
  });

  it('rate-limits API endpoints after 300 requests from the same source', async () => {
    const isolatedApp = makeApp();
    const promises = Array.from({ length: 302 }, () =>
      request(isolatedApp).get('/api/summary'),
    );
    const responses = await Promise.all(promises);
    const limited = responses.filter((r) => r.status === 429);
    expect(limited.length).toBeGreaterThan(0);
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

  it('rejects a second server binding on an already occupied port', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, resolve));
    const address = blocker.address();
    const occupiedPort = typeof address === 'object' && address ? address.port : 0;

    process.env = { ...process.env, ...validEnv };
    resetConfig();

    await expect(
      startDashboardServer({
        port: occupiedPort,
        subscriptionId: 'sub-id',
        publicDir: path.resolve(__dirname, '../../src/dashboard/public'),
        costAnalyzer: { queryCosts: vi.fn(async () => mockCostSummary) } as never,
        resourceDetector: { detectAll: vi.fn(async () => mockIdleResources) } as never,
        optimizer: { generateRecommendations: vi.fn(async () => mockRecommendations) } as never,
      }),
    ).rejects.toThrow();

    await new Promise<void>((resolve, reject) => blocker.close((e) => (e ? reject(e) : resolve())));
  });
});
