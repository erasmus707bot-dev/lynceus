# Lynceus demo projects

Two tiny "AI-style" shop projects with deliberate problems. Both ship inside the app: press **Python demo** or **JavaScript demo** on the Input tab. You can also upload either folder by hand.

Every key and password in them is fake.

## What's planted

| Problem | `python/inventory.py` | `javascript/cart.js` |
|---|---|---|
| Deep nesting (depth 6) | `allocate_orders` | `applyDiscounts` |
| Branch no test runs | express fee in `order_value`, `raise` in `reserve` | Canada and "elsewhere" in `shippingCost`, the 10% book discount |
| Scaffolding (no test, no spec bullet) | `export_stock_report` | `exportCartCsv` |
| Broad catch | `except Exception: pass` in `load_config` | empty `catch (e) {}` in `checkout` |
| Fake secret | `DB_URL` with a password inside the URL | `PAYMENT_API_KEY` |
| A test that fails | `test_restock_at_threshold` (code uses `<`, spec says "at or below") | "members get 5% off fewer than 3 books" (code forgets the quantity) |
| Also | mutable default argument, `pass` placeholder, TODO | `==`, "not implemented" placeholder, TODO, unused private function |

Each folder also has `SPEC.md` (paste into the spec box) and `change.diff` (paste into the diff box).

The hand-computed top 5 for each, with the arithmetic, is in `docs/PHASE6_REPORT.md`.
