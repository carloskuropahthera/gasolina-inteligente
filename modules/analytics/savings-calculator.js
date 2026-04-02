// MODULE: savings-calculator
// PURPOSE: Fuel cost and savings calculations — foundation for B2B fleet portal
// DEPENDS ON: nothing (pure math)

/**
 * Calculate savings from filling at a cheaper station vs average
 * @param {number} cheapestPrice - price per liter at cheapest station
 * @param {number} avgPrice      - comparison price per liter
 * @param {number} tankLiters    - tank size in liters (default 40L)
 * @param {number} [mxnRate=17.5] - MXN/USD exchange rate
 * @returns {{ savedPesos: number, savedUSD: number, percentSaved: number }}
 */
export function calculateFillSavings(cheapestPrice, avgPrice, tankLiters = 40, mxnRate = 17.5) {
  const savedPesos   = Math.round((avgPrice - cheapestPrice) * tankLiters * 100) / 100;
  const savedUSD     = Math.round((savedPesos / mxnRate) * 100) / 100;
  const percentSaved = avgPrice > 0
    ? Math.round(((avgPrice - cheapestPrice) / avgPrice) * 100 * 10) / 10
    : 0;
  return { savedPesos, savedUSD, percentSaved };
}

/**
 * Project monthly and annual savings
 * @param {number} avgFillsPerMonth
 * @param {{ savedPesos: number, savedUSD: number }} savingsPerFill
 * @returns {{ monthly: { pesos, usd }, annual: { pesos, usd } }}
 */
export function calculateMonthlySavings(avgFillsPerMonth, savingsPerFill) {
  const mPesos = Math.round(savingsPerFill.savedPesos * avgFillsPerMonth * 100) / 100;
  const mUSD   = Math.round(savingsPerFill.savedUSD * avgFillsPerMonth * 100) / 100;
  return {
    monthly: { pesos: mPesos, usd: mUSD },
    annual:  { pesos: Math.round(mPesos * 12 * 100) / 100, usd: Math.round(mUSD * 12 * 100) / 100 },
  };
}

/**
 * Estimate fuel cost for a trip
 * @param {number} distanceKm
 * @param {number} consumptionLper100km - vehicle fuel efficiency (e.g. 10 L/100km)
 * @param {number} pricePerLiter
 * @returns {{ litersNeeded: number, totalCost: number }}
 */
export function estimateFuelCost(distanceKm, consumptionLper100km, pricePerLiter) {
  const litersNeeded = Math.round(distanceKm * consumptionLper100km / 100 * 100) / 100;
  const totalCost    = Math.round(litersNeeded * pricePerLiter * 100) / 100;
  return { litersNeeded, totalCost };
}

/**
 * Compare route options and rank by total fuel cost
 * @param {Array<{label: string, distanceKm: number, fuelPrice: number, consumptionLper100km?: number}>} options
 * @returns {Array<{...option, totalCost, litersNeeded, savingsVsWorst}>}
 */
export function compareRouteOptions(options) {
  const consumption = 10; // default 10 L/100km

  const results = options.map(opt => {
    const c = opt.consumptionLper100km ?? consumption;
    const { litersNeeded, totalCost } = estimateFuelCost(opt.distanceKm, c, opt.fuelPrice);
    return { ...opt, totalCost, litersNeeded };
  });

  const worstCost = Math.max(...results.map(r => r.totalCost));

  return results
    .map(r => ({
      ...r,
      savingsVsWorst: Math.round((worstCost - r.totalCost) * 100) / 100,
    }))
    .sort((a, b) => a.totalCost - b.totalCost);
}

/**
 * Calculate monthly fleet fuel costs
 * @param {number} vehicles       - number of vehicles
 * @param {number} avgKmPerDay    - average km driven per vehicle per day
 * @param {number} consumption    - L/100km
 * @param {number} price          - MXN per liter
 * @returns {{ dailyCost, monthlyCost, annualCost, totalLitersPerMonth }}
 */
export function calculateFleetMonthly(vehicles, avgKmPerDay, consumption, price) {
  const litersPerVehiclePerDay = avgKmPerDay * consumption / 100;
  const litersFleetPerDay      = litersPerVehiclePerDay * vehicles;
  const litersFleetPerMonth    = litersFleetPerDay * 30;

  const dailyCost   = Math.round(litersFleetPerDay * price * 100) / 100;
  const monthlyCost = Math.round(litersFleetPerMonth * price * 100) / 100;
  const annualCost  = Math.round(monthlyCost * 12 * 100) / 100;

  return {
    dailyCost,
    monthlyCost,
    annualCost,
    totalLitersPerMonth: Math.round(litersFleetPerMonth * 100) / 100,
  };
}
