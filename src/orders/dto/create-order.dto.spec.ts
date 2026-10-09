import { BadRequestException, ValidationPipe } from '@nestjs/common';

import { CreateOrderDto } from './create-order.dto.js';

describe('CreateOrderDto', () => {
  const pipe = new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    expectedType: CreateOrderDto,
  });
  const valid = {
    customerName: ' Saïd ',
    customerEmail: ' CLIENT@example.com ',
    items: [{ productId: 1, quantity: 2 }],
  };
  const validate = (body: unknown) => pipe.transform(body, { type: 'body' });

  it('normalizes customer details and validates nested lines', async () => {
    const dto = await validate(valid);
    expect(dto).toBeInstanceOf(CreateOrderDto);
    expect(dto.customerName).toBe('Saïd');
    expect(dto.customerEmail).toBe('client@example.com');
  });

  it.each([
    null,
    {},
    { ...valid, customerName: ' ' },
    { ...valid, customerEmail: 'invalid' },
    { ...valid, items: [] },
    { ...valid, items: [null] },
    { ...valid, items: [{ productId: 0, quantity: 1 }] },
    { ...valid, items: [{ productId: 1, quantity: 0 }] },
    { ...valid, items: [{ productId: 1, quantity: -1 }] },
    { ...valid, items: [{ productId: 1, quantity: 1.5 }] },
    { ...valid, items: [{ productId: 1, quantity: '2' }] },
    { ...valid, items: [{ productId: 1, quantity: 11 }] },
    { ...valid, items: [{ productId: 1, quantity: 2, unitPrice: 1 }] },
    { ...valid, total: 1 },
  ])('rejects malformed input or client-supplied prices: %j', async (body) => {
    await expect(validate(body)).rejects.toBeInstanceOf(BadRequestException);
  });
});
