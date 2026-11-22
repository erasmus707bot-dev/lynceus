def classify(n):
    if n < 0:
        return "negative"
    elif n == 0:
        return "zero"
    total = 0
    for i in range(n):
        if i % 2:
            total += i
    return "big" if total > 10 else "small"


def divide(a, b):
    if b == 0:
        raise ZeroDivisionError("b is zero")
    return a / b


def never_tested(x):
    y = x * 2
    return y + 1
