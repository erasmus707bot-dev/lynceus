import { lineTotal, cartSubtotal, applyDiscounts, shippingCost, checkout } from './cart.js';

describe('cart', () => {
  test('line total is price times quantity', () => {
    expect(lineTotal({ price: 4, qty: 3 })).toBe(12);
  });

  test('subtotal adds up the lines', () => {
    expect(cartSubtotal([{ price: 4, qty: 3 }, { price: 1, qty: 2 }])).toBe(14);
  });

  test('members get 15% off 3 or more books over $20', () => {
    const cart = { items: [{ category: 'books', price: 30, qty: 3 }] };
    expect(applyDiscounts(cart, { member: true })).toBe(13.5);
  });

  test('members get 5% off fewer than 3 books', () => {
    const cart = { items: [{ category: 'books', price: 10, qty: 2 }] };
    expect(applyDiscounts(cart, { member: true })).toBe(1);
  });

  test('coupon SAVE10 takes 10% off other items', () => {
    const cart = { items: [{ category: 'toys', price: 20, qty: 1 }], coupon: 'save10' };
    expect(applyDiscounts(cart, null)).toBe(2);
  });

  test('shipping is free from $50', () => {
    expect(shippingCost(50, 'US')).toBe(0);
  });

  test('US shipping is $5 under $50', () => {
    expect(shippingCost(20, 'US')).toBe(5);
  });

  test('checkout total includes shipping', () => {
    const cart = { items: [{ category: 'toys', price: 10, qty: 2 }] };
    expect(checkout(cart, { country: 'US' }).total).toBe(25);
  });
});
