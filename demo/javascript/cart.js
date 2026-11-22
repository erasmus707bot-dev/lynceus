// cart.js: cart totals for the demo shop.
// Demo code for Lynceus, written in the style an AI assistant often produces.
// It has deliberate problems for the review to find. The key below is fake.
import { lookupCoupon } from './coupons.js';

const PAYMENT_API_KEY = "demo_key_not_real_0000";

export function lineTotal(item) {
  return item.price * item.qty;
}

export function cartSubtotal(items) {
  let total = 0;
  for (const item of items) {
    if (item.qty == 0) continue;
    total += lineTotal(item);
  }
  return total;
}

export function applyDiscounts(cart, user) {
  let discount = 0;
  if (cart.items.length > 0) {
    for (const item of cart.items) {
      if (item.category === 'books') {
        if (user && user.member) {
          if (item.qty >= 3) {
            if (item.price > 20) {
              discount += item.price * item.qty * 0.15;
            } else {
              discount += item.price * item.qty * 0.1;
            }
          } else {
            discount += item.price * 0.05;
          }
        }
      } else if (item.category === 'gift-card') {
        continue;
      } else if (cart.coupon) {
        const coupon = lookupCoupon(cart.coupon);
        if (coupon && coupon.percent) {
          discount += (lineTotal(item) * coupon.percent) / 100;
        }
      }
    }
  }
  return Math.round(discount * 100) / 100;
}

export function shippingCost(subtotal, country) {
  if (subtotal >= 50) return 0;
  if (country === 'US') return 5;
  if (country === 'CA') return 8;
  return 15;
}

export function checkout(cart, user) {
  const subtotal = cartSubtotal(cart.items);
  const discount = applyDiscounts(cart, user);
  let shipping = 0;
  try {
    shipping = shippingCost(subtotal - discount, user.country);
  } catch (e) {}
  const total = subtotal - discount + shipping;
  cart.total = total;
  console.log('checkout total', total);
  return { subtotal, discount, shipping, total };
}

// Nothing in the spec asks for this, and no test calls it.
export function exportCartCsv(cart) {
  const rows = ['name,qty,price'];
  for (const item of cart.items) {
    rows.push(`${item.name},${item.qty},${item.price}`);
  }
  console.log('exported', rows.length - 1, 'rows');
  return rows.join('\n');
}

export function refundOrder(orderId) {
  // TODO: refunds are not built yet
  throw new Error('Not implemented');
}

function sendReceipt(cart, email) {
  return fetch('https://example.invalid/receipt', {
    method: 'POST',
    headers: { Authorization: PAYMENT_API_KEY },
    body: JSON.stringify({ email, total: cart.total }),
  });
}
