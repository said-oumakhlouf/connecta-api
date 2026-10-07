import { calculateLinePrice } from './order-pricing.js';

describe('Duo pricing', () => {
  it.each([
    [1, 3500, 0],
    [2, 6000, 1000],
    [3, 9500, 1000],
    [4, 12000, 2000],
    [5, 15500, 2000],
    [100, 300000, 50000],
  ])('prices %i units at %i cents', (quantity, lineTotal, discount) => {
    expect(calculateLinePrice(3500, quantity, 6000)).toEqual({
      lineTotal,
      discount,
    });
  });

  it('uses regular pricing for a product without the offer', () => {
    expect(calculateLinePrice(1000, 3, null)).toEqual({
      lineTotal: 3000,
      discount: 0,
    });
  });

  it('never charges more than the regular price', () => {
    expect(calculateLinePrice(2500, 3, 6000)).toEqual({
      lineTotal: 7500,
      discount: 0,
    });
  });

  it('uses the current regular price for an unpaired unit', () => {
    expect(calculateLinePrice(4000, 3, 6000)).toEqual({
      lineTotal: 10000,
      discount: 2000,
    });
  });
});
