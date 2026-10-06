import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { ProductsModule } from './products/products.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    ProductsModule,
  ],
})
export class AppModule {}
