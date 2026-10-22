import { createApp } from './app.js';
import { config } from './config.js';
import { pool } from './db/pool.js';

const server = createApp().listen(config.PORT, () => {
  console.log(`MOV FIT API disponível na porta ${config.PORT}`);
});

async function shutdown(signal) {
  console.log(`${signal} recebido; encerrando API.`);
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
