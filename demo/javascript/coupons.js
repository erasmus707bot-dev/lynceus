// coupons.js: coupon codes for the demo shop.
const COUPONS = {
  SAVE10: { percent: 10 },
  HALF: { percent: 50 },
};

export function lookupCoupon(code) {
  if (!code) return null;
  const coupon = COUPONS[code.trim().toUpperCase()];
  return coupon ?? null;
}
