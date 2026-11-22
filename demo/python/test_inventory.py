from inventory import restock_needed, reserve, allocate_orders, order_value


def test_restock_below_threshold():
    assert restock_needed({"qty": 2})


def test_restock_at_threshold():
    assert restock_needed({"qty": 5})


def test_reserve_takes_stock():
    stock = {"A1": 10}
    assert reserve(stock, "A1", 3)
    assert stock["A1"] == 7


def test_reserve_refuses_when_short():
    stock = {"A1": 2}
    assert not reserve(stock, "A1", 3)
    assert stock["A1"] == 2


def test_priority_order_uses_local_warehouse():
    stock = {"north": {"A1": 5}}
    warehouses = [{"name": "north", "region": "N"}]
    orders = [{"id": 1, "priority": True, "region": "N", "lines": [{"sku": "A1", "qty": 2}]}]
    assert allocate_orders(orders, stock, warehouses) == {1: ["north"]}
    assert stock["north"]["A1"] == 3


def test_normal_orders_wait_in_backlog():
    orders = [{"id": 2, "lines": []}]
    assert allocate_orders(orders, {}, []) == {2: ["backlog"]}


def test_order_value():
    order = {"lines": [{"sku": "A1", "qty": 4}]}
    assert order_value(order, {"A1": 2.5}) == 10.0
