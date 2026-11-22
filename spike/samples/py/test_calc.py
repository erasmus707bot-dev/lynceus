import pytest
from calc import classify, divide


def test_negative():
    assert classify(-5) == "negative"


def test_loop():
    assert classify(10) == "big"


def test_divide_fails_on_purpose():
    assert divide(1, 2) == 0.25  # wrong on purpose: shows a failing test


def test_divide_zero():
    with pytest.raises(ZeroDivisionError):
        divide(1, 0)
