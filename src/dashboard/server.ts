import path from 'node:path';
import { createServer, type Server } from 'node:http';

import compression from 'compression';
import cors from 'cors';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';

import { getConfig } from '@/config';
import { CostAnalyzerService } from '@/services/cost-analyzer';
import { OptimizerService } from '@/services/optimizer';
import { ResourceDetectorService } from '@/services/resource-detector';
import { createDashboardRouter } from '@/dashboard/routes';
import { createLogger } from '@/utils/logger';

export type DashboardServerOptions = {
  port?: number;
  subscriptionId?: string;
  costAnalyzer?: CostAnalyzerService;
  resourceDetector?: ResourceDetectorService;
  optimizer?: OptimizerService;
  publicDir?: string;
};

const logger = createLogger({ service: 'dashboard-server' });
const apiRateLimit = rateLimit({
  windowMs: 60_000,
  limit: 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests' },
});

export const errorToMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && error !== null) {
    return JSON.stringify(error);
  }
  return 'Unknown error';
};

/**
 * Builds the Express application for the dashboard.
 */
export const createDashboardApp = (options: DashboardServerOptions = {}): Express => {
  const app = express();
  const publicDir = options.publicDir ?? path.join(__dirname, 'public');
  const config = options.subscriptionId ? null : getConfig();
  const subscriptionId = options.subscriptionId ?? config?.AZURE_SUBSCRIPTION_ID ?? 'unknown-subscription';
  const costAnalyzer = options.costAnalyzer ?? new CostAnalyzerService();
  const resourceDetector =
    options.resourceDetector ?? new ResourceDetectorService(undefined, subscriptionId);
  const optimizer = options.optimizer ?? new OptimizerService();

  app.use(helmet());
  app.use(cors());
  app.use(compression());
  app.use(express.json());
  app.use(apiRateLimit);
  app.get('/health', (_request, response) => {
    response.json({ status: 'ok', timestamp: new Date().toISOString() });
  });
  app.use(express.static(publicDir));
  app.use(
    createDashboardRouter({
      costAnalyzer,
      resourceDetector,
      optimizer,
      subscriptionId,
      publicDir,
    }),
  );
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const message = errorToMessage(error);
    logger.error('Dashboard request failed', { error: message });
    response.status(500).json({ error: message });
  });

  return app;
};

/**
 * Starts the dashboard HTTP server with graceful shutdown hooks.
 */
export const startDashboardServer = async (options: DashboardServerOptions = {}): Promise<Server> => {
  const config = getConfig();
  const port = options.port ?? config.DASHBOARD_PORT;
  const app = createDashboardApp(options);
  const server = createServer(app);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const shutdown = (signal: string): void => {
    logger.info('Shutting down dashboard server', { signal });
    server.close();
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  logger.info('Dashboard server started', { port });
  return server;
};
