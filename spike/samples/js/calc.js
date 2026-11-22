function classify(n) {
  if (n < 0) {
    return 'negative';
  } else if (n === 0) {
    return 'zero';
  }
  let total = 0;
  for (let i = 0; i < n; i++) {
    if (i % 2) total += i;
  }
  return total > 10 ? 'big' : 'small';
}

async function slowDouble(x) {
  return x * 2;
}

function neverTested(x) {
  const y = x * 2;
  return y + 1;
}

module.exports = { classify, slowDouble, neverTested };
