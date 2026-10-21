import { networkInterfaces } from 'node:os';
import { createServer } from './app.ts';
import { ConfigError, loadConfig } from './config.ts';
import { createLogger } from './logger.ts';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(2);
    }
    throw err;
  }

  const logger = createLogger(config.logLevel);
  const server = await createServer(config, logger);
  await server.app.listen({ host: config.host, port: config.port });
  logger.info(
    {
      evt: 'listening',
      host: config.host,
      port: config.port,
      allowedOrigins: config.allowedOrigins,
      allowSameOrigin: config.allowSameOrigin,
      serveStatic: config.staticDir !== '',
    },
    'LanDrop signaling server listening',
  );

  if (config.host === '0.0.0.0' || config.host === '::') {
    // Help operators find the address other devices should open. Addresses are logged
    // only at startup, never per client.
    const urls: string[] = [];
    for (const list of Object.values(networkInterfaces())) {
      for (const a of list ?? []) {
        if (!a.internal && a.family === 'IPv4') urls.push(`http://${a.address}:${config.port}`);
      }
    }
    logger.info({ evt: 'lan_urls', urls, publicOrigin: config.publicOrigin }, 'reachable on these LAN addresses (if not behind a proxy)');
  }

  let signalled = false;
  const onSignal = (sig: string) => {
    if (signalled) {
      logger.warn({ evt: 'shutdown_forced', sig }, 'second signal, exiting now');
      process.exit(1);
    }
    signalled = true;
    server
      .stop()
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        logger.error({ evt: 'shutdown_error', err: String(err) }, 'shutdown failed');
        process.exit(1);
      });
  };
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('SIGINT', () => onSignal('SIGINT'));
}

main().catch((err: unknown) => {
  console.error('Fatal startup error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
