// calculations.ts — Core calculation functions

import { Position, SimState } from './types.js';
import { tickToPrice, calculateTimeHeld, safeNumber } from './utils.js';

export function calculateLiquidity(
  amountUsd: number,
  currentPrice: number,
  lowerTick: number,
  upperTick: number,
  dec0: number,
  dec1: number
): { liquidity: number; token0Amount: number; token1Amount: number } {
  const lowerPrice = tickToPrice(lowerTick, dec0, dec1);
  const upperPrice = tickToPrice(upperTick, dec0, dec1);

  // Convert prices to sqrt format (multiply by 2^96)
  const Q96 = Math.pow(2, 96);
  const sqrtPrice = Math.sqrt(currentPrice) * Q96;
  const sqrtLower = Math.sqrt(lowerPrice) * Q96;
  const sqrtUpper = Math.sqrt(upperPrice) * Q96;

  // For equal value distribution at current price
  const halfAmount = amountUsd / 2;

  // Calculate token amounts for equal value
  const token0Amount = halfAmount; // USDC amount
  const token1Amount = halfAmount / currentPrice; // ETH amount

  // Calculate liquidity using Uniswap V3 formula
  let liquidity: number;

  if (currentPrice <= lowerPrice) {
    // All in token1 (ETH) - price below range
    // L = amount1 / (sqrtP - sqrtPl)
    liquidity = token1Amount / ((sqrtUpper - sqrtLower) / Q96);
    return { liquidity, token0Amount: 0, token1Amount };
  } else if (currentPrice >= upperPrice) {
    // All in token0 (USDC) - price above range
    // L = amount0 * sqrtP * sqrtPl / (sqrtPu - sqrtPl)
    liquidity =
      (token0Amount * sqrtPrice * sqrtLower) / (Q96 * (sqrtUpper - sqrtLower));
    return { liquidity, token0Amount, token1Amount: 0 };
  } else {
    // Price in range - calculate liquidity for both tokens
    // L0 = amount0 * sqrtP * sqrtPl / (sqrtP - sqrtPl)
    // L1 = amount1 / (sqrtP - sqrtPl)
    const liquidity0 =
      (token0Amount * sqrtPrice * sqrtLower) / (Q96 * (sqrtPrice - sqrtLower));
    const liquidity1 = token1Amount / ((sqrtUpper - sqrtPrice) / Q96);
    liquidity = Math.min(liquidity0, liquidity1);

    // Recalculate actual token amounts based on liquidity
    const actualToken0Amount =
      (liquidity * (sqrtPrice - sqrtLower)) / ((sqrtPrice * sqrtLower) / Q96);
    const actualToken1Amount = liquidity * ((sqrtUpper - sqrtPrice) / Q96);

    return {
      liquidity,
      token0Amount: actualToken0Amount,
      token1Amount: actualToken1Amount,
    };
  }
}

export function calculateImpermanentLoss(
  entryPrice: number,
  currentPrice: number
): number {
  if (entryPrice === 0 || currentPrice === 0) return 0;

  const priceRatio = currentPrice / entryPrice;
  const sqrtRatio = Math.sqrt(priceRatio);
  const il = (2 * sqrtRatio) / (1 + priceRatio) - 1;
  return Math.abs(il) * 100;
}

export function calculateCurrentPositionValue(
  position: Position,
  currentPrice: number,
  currentTick: number,
  dec0: number,
  dec1: number
): number {
  const lowerPrice = tickToPrice(position.lower, dec0, dec1);
  const upperPrice = tickToPrice(position.upper, dec0, dec1);

  if (currentTick < position.lower) {
    // Price below range - all in token1 (ETH)
    return position.token1Amount * currentPrice;
  } else if (currentTick > position.upper) {
    // Price above range - all in token0 (USDC)
    return position.token0Amount;
  } else {
    // Price in range - calculate based on current liquidity
    const Q96 = Math.pow(2, 96);
    const sqrtPrice = Math.sqrt(currentPrice) * Q96;
    const sqrtLower = Math.sqrt(lowerPrice) * Q96;
    const sqrtUpper = Math.sqrt(upperPrice) * Q96;

    // Calculate current token amounts based on liquidity
    // Token0 amount = L * (sqrtP - sqrtPl) / (sqrtP * sqrtPl)
    // Token1 amount = L * (sqrtPu - sqrtP)
    const currentToken0Amount =
      (position.liquidity * (sqrtPrice - sqrtLower)) /
      ((sqrtPrice * sqrtLower) / Q96);
    const currentToken1Amount =
      position.liquidity * ((sqrtUpper - sqrtPrice) / Q96);

    // Convert to USD value
    const token0Value = currentToken0Amount; // USDC
    const token1Value = currentToken1Amount * currentPrice; // ETH to USD

    const totalValue = token0Value + token1Value;

    // Ensure we don't return negative or extremely low values
    return Math.max(totalValue, position.amountUsd * 0.05); // At least 5% of original amount
  }
}

export function calculateFeesEarned(
  position: Position,
  currentTick: number,
  currentPrice: number,
  globalLiquidity: number,
  feeRate: number
): number {
  const timeHeld = calculateTimeHeld(position.enteredAt);

  if (timeHeld <= 0 || position.entryPrice === 0) return position.feesEarned;

  // Check if position is in range
  const inRange =
    currentTick >= position.lower && currentTick <= position.upper;

  if (!inRange) return position.feesEarned; // No new fees if out of range

  // Base fee rate from pool (e.g., 0.3% = 0.003)
  const poolFeeRate = feeRate / 1000000; // Convert from basis points

  // Calculate our share of total liquidity
  const liquidityRatio =
    globalLiquidity > 0 ? position.liquidity / globalLiquidity : 0;

  // Estimate trading volume based on:
  // 1. Position size
  // 2. Market volatility (price change)
  // 3. Time held
  const priceChange =
    Math.abs(currentPrice - position.entryPrice) / position.entryPrice;

  // More realistic volume estimation
  const baseVolume = position.amountUsd * 0.1; // 10% of position per day base
  const volatilityFactor = 1 + priceChange * 2; // Higher volatility = more trading
  const timeFactor = Math.min(timeHeld / 24, 1); // Scale with time

  // Our share of fees based on liquidity provided
  const dailyVolume = baseVolume * volatilityFactor * timeFactor;
  const ourShare = Math.min(liquidityRatio * 10, 1); // Cap at 100%

  // Calculate fees earned (only when in range)
  const newFees = dailyVolume * poolFeeRate * ourShare;

  return position.feesEarned + Math.max(0, newFees);
}

export function calculatePositionDistance(
  tick: number,
  position: Position
): number {
  if (tick < position.lower || tick > position.upper) {
    return -1;
  }
  return Math.min(tick - position.lower, position.upper - tick);
}

export function shouldClosePosition(
  tick: number,
  position: Position,
  D: number
): boolean {
  const distance = calculatePositionDistance(tick, position);
  const timeHeld = calculateTimeHeld(position.enteredAt);

  // Close if price is out of range
  if (distance === -1) {
    return true;
  }

  // Close if price is too close to edge (danger zone) AND we've held for a while
  if (distance < D && timeHeld > 0.5) {
    // At least 30 minutes
    return true;
  }

  // Close if position has been held for too long without rebalancing
  if (timeHeld > 72 && position.rebalanceCount === 0) {
    // 3 days instead of 1 week
    return true;
  }

  // Close if position is losing money significantly and close to edge
  if (position.totalReturn < -20 && distance < D) {
    return true;
  }

  // Close if position is very profitable but price is moving away
  if (position.totalReturn > 25 && distance < D && timeHeld > 1) {
    return true;
  }

  // Close if position is losing money and has been held for a while
  if (position.totalReturn < -10 && timeHeld > 24) {
    return true;
  }

  return false;
}

export function shouldHoldPosition(
  tick: number,
  position: Position,
  B: number
): boolean {
  const distance = calculatePositionDistance(tick, position);
  return distance >= B;
}

export function shouldRebalancePosition(
  position: Position,
  currentTick: number,
  currentPrice: number,
  W: number,
  B: number
): boolean {
  const distance = calculatePositionDistance(currentTick, position);
  const timeHeld = calculateTimeHeld(position.enteredAt);
  const priceChange =
    Math.abs(currentPrice - position.entryPrice) / position.entryPrice;

  // Don't rebalance too frequently
  if (position.lastRebalanceAt) {
    const timeSinceRebalance = calculateTimeHeld(position.lastRebalanceAt);
    if (timeSinceRebalance < 4) {
      // At least 4 hours between rebalances
      return false;
    }
  }

  // Rebalance if price is getting close to edge
  if (distance < B / 2) {
    return true;
  }

  // Rebalance if significant price change after holding for a while
  if (timeHeld > 12 && priceChange > 0.1) {
    return true;
  }

  // Rebalance if position is profitable but getting close to edge
  if (position.totalReturn > 5 && distance < B) {
    return true;
  }

  // Rebalance if position is losing money and price is moving away
  if (position.totalReturn < -5 && distance < B && timeHeld > 6) {
    return true;
  }

  return false;
}

export function calculatePortfolioMetrics(state: SimState): void {
  const closedPositions = state.positions.filter((p) => p.status === 'closed');
  const activePositions = state.positions.filter((p) => p.status === 'active');

  // Calculate total fees earned
  state.totalFeesEarned = state.positions.reduce(
    (sum, p) => sum + safeNumber(p.feesEarned),
    0
  );

  // Calculate total impermanent loss
  state.totalImpermanentLoss = state.positions.reduce(
    (sum, p) => sum + safeNumber(p.impermanentLoss),
    0
  );

  // Calculate total return based on actual P&L
  const totalInvested = state.positions.reduce(
    (sum, p) => sum + p.amountUsd,
    0
  );
  const totalCurrentValue = activePositions.reduce(
    (sum, p) => sum + safeNumber(p.currentValue),
    0
  );
  const totalRealizedValue = closedPositions.reduce(
    (sum, p) => sum + safeNumber(p.currentValue) + safeNumber(p.feesEarned),
    0
  );

  const totalValue = totalCurrentValue + totalRealizedValue;
  const totalPnL = totalValue - totalInvested;

  state.totalReturn = totalInvested > 0 ? (totalPnL / totalInvested) * 100 : 0;

  // Calculate win rate
  const profitablePositions = closedPositions.filter((p) => {
    const finalValue = safeNumber(p.currentValue) + safeNumber(p.feesEarned);
    return finalValue > p.amountUsd;
  }).length;

  state.winRate =
    closedPositions.length > 0
      ? (profitablePositions / closedPositions.length) * 100
      : 0;

  // Calculate average position duration
  const totalDuration = state.positions.reduce((sum, p) => {
    const endTime =
      p.status === 'closed'
        ? new Date(p.lastUpdateAt || p.enteredAt).getTime()
        : Date.now();
    const duration =
      (endTime - new Date(p.enteredAt).getTime()) / (1000 * 60 * 60);
    return sum + duration;
  }, 0);

  state.averagePositionDuration =
    state.positions.length > 0 ? totalDuration / state.positions.length : 0;

  state.lastUpdateAt = new Date().toISOString();
}
