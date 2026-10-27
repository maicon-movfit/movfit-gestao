import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { config } from './config.js';
import { documentsRouter } from './routes/documents.js';
import { healthRouter } from './routes/health.js';
import { monthlyClosuresRouter } from './routes/monthly-closures.js';
import { unitsRouter } from './routes/units.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(pinoHttp({
    level: config.LOG_LEVEL,
    redact: ['req.headers.authorization', 'req.headers.cookie']
  }));
  app.use(helmet());
  app.use(cors({
    credentials: false,
    origin(origin, callback) {
      if (!origin || config.corsOrigins.includes(origin)) return callback(null, true);
      return callback(new Error('Origem não autorizada por CORS.'));
    }
  }));
  app.use(express.json({ limit: '1mb' }));

  app.use('/api/v1/health', healthRouter);
  app.use('/api/v1/units', unitsRouter);
  app.use('/api/v1/documents', documentsRouter);
  app.use('/api/v1/monthly-closures', monthlyClosuresRouter);

  app.use((_request, response) => response.status(404).json({ error: 'route_not_found' }));
  app.use((error, request, response, _next) => {
    request.log?.error({ err: error }, 'Erro não tratado');
    response.status(500).json({ error: 'internal_server_error' });
  });
  return app;
}
