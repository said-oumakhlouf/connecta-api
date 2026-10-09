import type { INestApplication } from '@nestjs/common';

export function configureCors(
  app: INestApplication,
  origins = process.env.CORS_ORIGINS ??
    'http://localhost:3000,http://127.0.0.1:3000',
) {
  app.enableCors({
    origin: origins
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    credentials: true,
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    maxAge: 600,
  });
}
