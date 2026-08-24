/**
 * Customer billing is based on cost points plus a 100% markup.
 * A 2x selling-price multiplier equals a 50% gross margin.
 */
export const AI_COST_MARKUP_MULTIPLIER = 2;

export function billablePointsFromCost(costPoints: number) {
  const safeCost = Math.max(0, Number(costPoints) || 0);
  return safeCost > 0 ? Math.ceil(safeCost * AI_COST_MARKUP_MULTIPLIER) : 0;
}

export function costPointsFromBillable(billablePoints: number) {
  return Math.max(0, (Number(billablePoints) || 0) / AI_COST_MARKUP_MULTIPLIER);
}
