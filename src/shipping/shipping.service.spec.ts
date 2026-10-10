import { ConfigService } from '@nestjs/config';
import { ShippingService } from './shipping.service.js';
import { ShippingAddressDto } from './shipping.dto.js';
import { CheckoutDto } from '../payments/checkout.dto.js';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
const address: ShippingAddressDto = { line1: '12 rue du Test', line2: '', city: 'Paris', postalCode: '75001', country: 'FR', region: '' };
const service = (values = {}) => new ShippingService(new ConfigService(values));

describe('Shipping rates and address boundaries', () => {
  it('exposes provisional EUR rates, rejects disabled countries and invalid configuration', () => {
    expect(service().options()).toMatchObject({ currency: 'eur', provisional: true });
    expect(service().fee('BE')).toBe(990);
    expect(() => service({ SHIPPING_CA_ENABLED: 'false' }).fee('CA')).toThrow();
    for (const value of ['-1', '', '1.5', 'NaN', '100001'])
      expect(() => service({ SHIPPING_FR_CENTS: value }).options()).toThrow();
    expect(() => service({ NODE_ENV: 'production' }).options()).toThrow();
    expect(() => service({ NODE_ENV: 'production', SHIPPING_RATES_CONFIRMED: 'true' }).options()).toThrow();
    expect(service({ NODE_ENV: 'production', SHIPPING_RATES_CONFIRMED: 'true', SHIPPING_FR_CENTS: '700', SHIPPING_BE_ENABLED: 'false', SHIPPING_CA_ENABLED: 'false' }).fee('FR')).toBe(700);
  });
  it('normalizes Canadian postcodes and requires a province; rejects overseas at mainland prices', () => {
    expect(service().address({ ...address, country: 'CA', postalCode: 'h2x1y4', region: 'qc' })).toMatchObject({ postalCode: 'H2X 1Y4', region: 'QC' });
    for (const value of [
      { ...address, postalCode: '97100' }, { ...address, postalCode: '00000' },
      { ...address, country: 'BE' as const, postalCode: '0000' },
      { ...address, country: 'CA' as const, postalCode: 'H2X 1Y4', region: '' },
      { ...address, country: 'CA' as const, postalCode: '123456', region: 'QC' },
    ]) expect(() => service().address(value)).toThrow();
  });
  it('requires an address, fee acknowledgment and rejects unexpected nested fields', async () => {
    const dto = { customerName: 'Test Client', customerEmail: 'test@example.com', items: [{ productId: 1, quantity: 1 }], checkoutKey: 'f1be1f77-b7c7-4cf3-bd8a-cc9745537161', shippingAddress: address, expectedShippingFee: 590 };
    const check = (value: unknown) => validate(plainToInstance(CheckoutDto, value), { whitelist: true, forbidNonWhitelisted: true });
    expect(await check(dto)).toHaveLength(0);
    for (const changes of [{ shippingAddress: null }, { expectedShippingFee: undefined }, { shippingAddress: { ...address, line1: '  ' } }, { shippingAddress: { ...address, fee: 0 } }])
      expect((await check({ ...dto, ...changes })).length).toBeGreaterThan(0);
  });
});
