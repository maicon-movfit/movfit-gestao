import 'dotenv/config';
import { z } from 'zod';

const booleanFromString = z.enum(['true', 'false']).transform(value => value === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1).optional(),
  DB_HOST: z.string().min(1).default('localhost'),
  DB_PORT: z.coerce.number().int().positive().default(5432),
  DB_NAME: z.string().min(1).default('movfit_gestao'),
  DB_USER: z.string().min(1).default('movfit'),
  DB_PASSWORD: z.string().default(''),
  DATABASE_SSL: booleanFromString.default('false'),
  CORS_ORIGINS: z.string().default('http://localhost:5500'),
  AUTH_MODE: z.enum(['firebase']).default('firebase'),
  FIREBASE_PROJECT_ID: z.string().min(1),
  FIREBASE_SERVICE_ACCOUNT_BASE64: z.string().optional(),
  LOG_LEVEL: z.string().default('info')
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Configuração inválida:', parsed.error.flatten().fieldErrors);
  throw new Error('Variáveis de ambiente obrigatórias ausentes ou inválidas.');
}

export const config = {
  ...parsed.data,
  corsOrigins: parsed.data.CORS_ORIGINS.split(',').map(value => value.trim()).filter(Boolean)
};
