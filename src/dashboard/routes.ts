import path from 'node:path';

import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';

import { CostAnalyzerService } from '@/services/cost-analyzer';
import { OptimizerService } from '@/services/optimizer';
import { ResourceDetectorService } from '@/services/resource-detector';

const costsQuerySchema = z.object({
  period: z.coerce.number().int().min(1).max(12).default(3),
  groupBy: z.enum(['service', 'resource-group', 'location', 'tags']).default('service'),
});

export type DashboardDependencies = {
  costAnalyzer: CostAnalyzerService;
  resourceDetector: ResourceDetectorService;
  optimizer: OptimizerService;
  subscriptionId: string;
  publicDir: string;
};

const staticWindowMs = 60_000;
const staticMaxRequests = 120;
const staticRequestCounts = new Map<string, { count: number; resetAt: number }>();

const consumeStaticRequestAllowance = (request: Request): boolean => {
  const key = request.ip || request.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const entry = staticRequestCounts.get(key);

  if (!entry || now >= entry.resetAt) {
    staticRequestCounts.set(key, { count: 1, resetAt: now + staticWindowMs });
    return true;
  }

  if (entry.count >= staticMaxRequests) {
    return false;
  }

  entry.count += 1;
  return true;
};

const staticRateLimit = (request: Request, response: Response, next: NextFunction): void => {
  if (!consumeStaticRequestAllowance(request)) {
    response.status(429).json({ error: 'Too many requests for dashboard assets' });
    return;
  }
  next();
};

/**
 * Creates the HTTP routes used by the dashboard API and static frontend.
 */
export const createDashboardRouter = (dependencies: DashboardDependencies): Router => {
  const router = Router();

  router.get('/api/costs', async (request, response, next) => {
    try {
      const query = costsQuerySchema.parse(request.query);
      const endDate = new Date();
      const startDate = new Date(Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth() - (query.period - 1), 1));
      const summary = await dependencies.costAnalyzer.queryCosts(
        dependencies.subscriptionId,
        startDate.toISOString().slice(0, 10),
        endDate.toISOString().slice(0, 10),
        query.groupBy,
      );
      response.json(summary);
    } catch (error: unknown) {
      next(error);
    }
  });

  router.get('/api/resources/idle', async (_request, response, next) => {
    try {
      response.json(await dependencies.resourceDetector.detectAll());
    } catch (error: unknown) {
      next(error);
    }
  });

  router.get('/api/recommendations', async (_request, response, next) => {
    try {
      const idleResources = await dependencies.resourceDetector.detectAll();
      response.json(await dependencies.optimizer.generateRecommendations(idleResources));
    } catch (error: unknown) {
      next(error);
    }
  });

  router.get('/api/summary', async (_request, response, next) => {
    try {
      const [costs, idleResources] = await Promise.all([
        dependencies.costAnalyzer.queryCosts(
          dependencies.subscriptionId,
          new Date(new Date().setUTCDate(1)).toISOString().slice(0, 10),
          new Date().toISOString().slice(0, 10),
          'service',
        ),
        dependencies.resourceDetector.detectAll(),
      ]);
      const recommendations = await dependencies.optimizer.generateRecommendations(idleResources);
      response.json({
        totalCost: costs.totalAmount,
        idleResourceCount: idleResources.length,
        recommendationCount: recommendations.length,
        annualSavingsOpportunity: recommendations.reduce((sum, item) => sum + item.annualSavings, 0),
      });
    } catch (error: unknown) {
      next(error);
    }
  });

  router.get('*', staticRateLimit, (_request, response) => {
    response.sendFile(path.join(dependencies.publicDir, 'index.html'));
  });

  return router;
};
