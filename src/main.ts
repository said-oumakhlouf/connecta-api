import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { configureCors } from './configure-cors.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  configureCors(app);
  await app.listen(process.env.PORT ?? 3001);
}
await bootstrap();
