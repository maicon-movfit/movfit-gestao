import { createApp } from './app.js';
import { config } from './config.js';
import { pool } from './db/pool.js';

const server = createApp().listen(config.PORT, () => {
  console.log(`MOV FIT API disponível na porta ${config.PORT}`);
});

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} recebido; encerrando API.`);

  const forcedExit = setTimeout(() => process.exit(1), 10_000);
  forcedExit.unref();

  server.close(async () => {
    await pool.end();
    clearTimeout(forcedExit);
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
