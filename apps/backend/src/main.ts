import 'reflect-metadata';
import { setDefaultAutoSelectFamilyAttemptTimeout } from 'net';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadConfig } from './config';

// Node gives each server address only 250 ms to connect by default. On slow links
// (e.g. Pakistan to US servers such as ntfy.sh) every attempt times out, so allow 2 s.
setDefaultAutoSelectFamilyAttemptTimeout(2000);

async function bootstrap() {
  const cfg = loadConfig(); // fail fast with a readable message
  const app = await NestFactory.create(AppModule, { logger: ['log', 'warn', 'error'] });
  app.enableShutdownHooks();
  await app.listen(cfg.PORT, '0.0.0.0');
  Logger.log(`Backend listening on port ${cfg.PORT}`, 'Bootstrap');
}

bootstrap().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(`\nStartup failed: ${(e as Error).message}\n`);
  process.exit(1);
});
