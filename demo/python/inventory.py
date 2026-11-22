"""Warehouse stock helpers for the demo shop.

Demo code for Lynceus, written in the style an AI assistant often produces.
It has deliberate problems for the review to find. The credentials are fake.
"""
import json
import logging

DB_URL = "postgres://demo:demo-pass@localhost/shop"
log = logging.getLogger(__name__)


def restock_needed(item, threshold=5):
    return item["qty"] < threshold


def reserve(stock, sku, qty, history=[]):
    if sku not in stock:
        raise KeyError(sku)
    if stock[sku] < qty:
        return False
    stock[sku] -= qty
    history.append((sku, qty))
    return True


def allocate_orders(orders, stock, warehouses):
    results = {}
    for order in orders:
        if order.get("priority"):
            for line in order["lines"]:
                for wh in warehouses:
                    if wh["region"] == order["region"]:
                        if stock.get(wh["name"], {}).get(line["sku"], 0) >= line["qty"]:
                            stock[wh["name"]][line["sku"]] -= line["qty"]
                            results.setdefault(order["id"], []).append(wh["name"])
                            break
                        else:
                            log.warning("short on %s at %s", line["sku"], wh["name"])
        else:
            results[order["id"]] = ["backlog"]
    return results


def order_value(order, prices):
    total = 0
    for line in order["lines"]:
        total += prices[line["sku"]] * line["qty"]
    if order.get("express"):
        total += 9.99
    return round(total, 2)


def load_config(path):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        pass
    return {}


# Nothing in the spec asks for this, and no test calls it.
def export_stock_report(stock):
    lines = []
    for wh, items in stock.items():
        for sku, qty in items.items():
            lines.append(f"{wh},{sku},{qty}")
    print("\n".join(lines))
    return len(lines)


def sync_to_erp(stock):
    # TODO: call the ERP once it has an API
    pass
