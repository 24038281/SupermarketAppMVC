function pointsToDollars(points) {
  const numeric = Number(points) || 0;
  return numeric * 0.05; // 100 points = $5
}

module.exports = { pointsToDollars };
