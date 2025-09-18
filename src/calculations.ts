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
  // currentPrice is vbETH/vbUSDC, so:
  // - token0Amount (vbUSDC) = halfAmount
  // - token1Amount (vbETH) = halfAmount / currentPrice
  const halfAmount = amountUsd / 2;
  const token0Amount = halfAmount; // vbUSDC amount
  const token1Amount = halfAmount / currentPrice; // vbETH amount

  // Calculate liquidity using correct Uniswap V3 formula
  let liquidity: number;
  let actualToken0Amount: number;
  let actualToken1Amount: number;

  if (currentPrice <= lowerPrice) {
    // All in token1 (vbETH) - price below range
    // L = amount1 / (sqrtP - sqrtPl) * Q96
    liquidity = (token1Amount * Q96) / (sqrtUpper - sqrtLower);
    actualToken0Amount = 0;
    actualToken1Amount = token1Amount;
  } else if (currentPrice >= upperPrice) {
    // All in token0 (vbUSDC) - price above range
    // L = amount0 * sqrtP * sqrtPl / (sqrtPu - sqrtPl) / Q96
    liquidity =
      (token0Amount * sqrtPrice * sqrtLower) / (Q96 * (sqrtUpper - sqrtLower));
    actualToken0Amount = token0Amount;
    actualToken1Amount = 0;
  } else {
    // Price in range - calculate liquidity for both tokens
    // L0 = amount0 * sqrtP * sqrtPl / (sqrtP - sqrtPl) / Q96
    // L1 = amount1 / (sqrtP - sqrtPl) * Q96
    const liquidity0 =
      (token0Amount * sqrtPrice * sqrtLower) / (Q96 * (sqrtPrice - sqrtLower));
    const liquidity1 = (token1Amount * Q96) / (sqrtUpper - sqrtPrice);
    liquidity = Math.min(liquidity0, liquidity1);

    // Recalculate actual token amounts based on liquidity
    // Token0 amount = L * (sqrtP - sqrtPl) / (sqrtP * sqrtPl) / Q96
    // Token1 amount = L * (sqrtPu - sqrtP) / Q96
    actualToken0Amount =
      (liquidity * (sqrtPrice - sqrtLower)) / ((sqrtPrice * sqrtLower) / Q96);
    actualToken1Amount = (liquidity * (sqrtUpper - sqrtPrice)) / Q96;
  }

  return {
    liquidity,
    token0Amount: actualToken0Amount,
    token1Amount: actualToken1Amount,
  };
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
    // Price below range - all in token1 (vbETH)
    // Value = vbETH amount * current vbETH price in USD
    return position.token1Amount * currentPrice;
  } else if (currentTick > position.upper) {
    // Price above range - all in token0 (vbUSDC)
    // Value = vbUSDC amount (already in USD)
    return position.token0Amount;
  } else {
    // Price in range - calculate based on current price vs entry price
    // For LP positions, value changes with square root of price ratio
    // This is a simplified approximation for simulation
    const priceRatio = currentPrice / position.entryPrice;
    const lpValue = position.amountUsd * Math.sqrt(priceRatio);

    // Ensure value doesn't go below 10% of original amount
    return Math.max(lpValue, position.amountUsd * 0.1);
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

  // More realistic volume estimation for vbUSDC/vbETH pair:
  // 1. Position size and liquidity share
  // 2. Market volatility (price change)
  // 3. Time held
  const priceChange =
    Math.abs(currentPrice - position.entryPrice) / position.entryPrice;

  // Base volume estimation - more conservative for vbUSDC/vbETH
  const baseVolume = position.amountUsd * 0.03; // 3% of position per day base
  const volatilityFactor = 1 + priceChange * 2; // Moderate volatility impact
  const timeFactor = Math.min(timeHeld / 24, 1); // Scale with time
  const liquidityFactor = Math.min(liquidityRatio * 50, 1); // Scale with our liquidity share

  // Our share of fees based on liquidity provided
  const dailyVolume = baseVolume * volatilityFactor * timeFactor;
  const ourShare = liquidityFactor; // Direct proportion to liquidity share

  // Calculate fees earned (only when in range)
  const newFees = dailyVolume * poolFeeRate * ourShare;

  // Add some randomness to simulate real market conditions
  const randomFactor = 0.7 + Math.random() * 0.6; // 0.7 to 1.3 multiplier

  return position.feesEarned + Math.max(0, newFees * randomFactor);
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
  if (distance < D && timeHeld > 12) {
    // At least 12 hours for vbUSDC/vbETH pair/
    return true;
  }

  // Close if position is losing money significantly (stop loss)
  if (position.totalReturn < -25) {
    // Stop loss at -25% for vbUSDC/vbETH pair
    return true;
  }

  // Close if position is very profitable but price is moving away from center
  if (position.totalReturn > 40 && distance < D && timeHeld > 24) {
    // Take profit at 40% if price moving away
    return true;
  }

  // Close if position has been held too long without significant profit
  if (timeHeld > 120 && position.totalReturn < 5) {
    // 5 days without 5% profit
    return true;
  }

  // Close if impermanent loss is too high
  if (position.impermanentLoss > 15) {
    return true;
  }

  return false;
}

export function shouldHoldPosition(
  tick: number,
  position: Position,
  B: number
): boolean {
  return true; // Always hold for now
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

  // Don't rebalance too frequently
  if (position.lastRebalanceAt) {
    const timeSinceRebalance = calculateTimeHeld(position.lastRebalanceAt);
    if (timeSinceRebalance < 24) {
      // At least 24 hours between rebalances for vbUSDC/vbETH
      return false;
    }
  }

  // Don't rebalance if position is losing money significantly
  if (position.totalReturn < -15) {
    return false;
  }

  // Rebalance if price is getting very close to edge AND position is profitable
  if (distance < B / 3 && position.totalReturn > 3) {
    return true;
  }

  // Rebalance if position is very profitable and getting close to edge
  if (position.totalReturn > 15 && distance < B / 2) {
    return true;
  }

  // Rebalance if position has been profitable for a while and price is moving away from center
  if (position.totalReturn > 20 && distance < B / 2 && timeHeld > 48) {
    // 2 days
    return true;
  }

  // Rebalance if fees earned are significant but position is getting close to edge
  if (position.feesEarned > position.amountUsd * 0.05 && distance < B / 2) {
    return true;
  }

  return false;
}

// New signal analysis functions
export function analyzeMarketTrend(
  currentPrice: number,
  twap1h: number | undefined,
  twap5m: number | undefined,
  sigma: number
): {
  trend: 'bullish' | 'bearish' | 'neutral';
  strength: number;
  volatility: 'low' | 'medium' | 'high';
  recommendation: 'add' | 'hold' | 'avoid';
} {
  let trend: 'bullish' | 'bearish' | 'neutral' = 'neutral';
  let strength = 0;
  let volatility: 'low' | 'medium' | 'high' = 'low';
  let recommendation: 'add' | 'hold' | 'avoid' = 'hold';

  // Analyze trend based on price vs TWAP
  if (twap1h && twap5m) {
    const priceVsTwap1h = (currentPrice - twap1h) / twap1h;
    const twap5mVsTwap1h = (twap5m - twap1h) / twap1h;

    if (priceVsTwap1h > 0.015 && twap5mVsTwap1h > 0.005) {
      trend = 'bullish';
      strength = Math.min(Math.abs(priceVsTwap1h) * 100, 100);
    } else if (priceVsTwap1h < -0.015 && twap5mVsTwap1h < -0.005) {
      trend = 'bearish';
      strength = Math.min(Math.abs(priceVsTwap1h) * 100, 100);
    }
  }

  // Analyze volatility based on sigma
  if (sigma > 0.03) {
    volatility = 'high';
  } else if (sigma > 0.015) {
    volatility = 'medium';
  }

  // Generate recommendation based on trend and volatility
  if (volatility === 'high' && sigma > 0.05) {
    recommendation = 'avoid';
  } else if (trend !== 'neutral' && strength > 20 && volatility !== 'high') {
    recommendation = 'add';
  } else if (trend === 'neutral' && volatility === 'low') {
    recommendation = 'add';
  } else {
    recommendation = 'hold';
  }

  return { trend, strength, volatility, recommendation };
}

export function calculateOptimalPositionSize(
  currentPrice: number,
  sigma: number,
  totalUsdLimit: number,
  maxUsdPerPosition: number,
  activePositionsCount: number,
  maxPositions: number
): { size: number; reason: string } {
  // Base position size for vbUSDC/vbETH pair
  let baseSize = Math.min(maxUsdPerPosition, totalUsdLimit / maxPositions);

  // Adjust based on volatility - more conservative for vbUSDC/vbETH
  if (sigma > 0.03) {
    // High volatility - reduce position size significantly
    baseSize *= 0.5;
  } else if (sigma > 0.015) {
    // Medium volatility - reduce position size moderately
    baseSize *= 0.7;
  } else {
    // Low volatility - can use full size
    baseSize *= 0.9;
  }

  // Adjust based on number of active positions
  const remainingSlots = maxPositions - activePositionsCount;
  if (remainingSlots <= 1) {
    // Last position - be more conservative
    baseSize *= 0.6;
  } else if (remainingSlots <= 2) {
    // Second to last position - slightly conservative
    baseSize *= 0.8;
  }

  // Ensure minimum viable position size for vbUSDC/vbETH
  const minSize = Math.min(300, totalUsdLimit * 0.03);
  const finalSize = Math.max(minSize, baseSize);

  return {
    size: finalSize,
    reason: `Volatility: ${
      sigma > 0.03 ? 'High' : sigma > 0.015 ? 'Medium' : 'Low'
    }, Remaining slots: ${remainingSlots}`,
  };
}

export function shouldAddNewPosition(
  currentTick: number,
  currentPrice: number,
  twap1h: number | undefined,
  sigma: number,
  activePositions: any[],
  maxPositions: number,
  totalUsdLimit: number,
  maxUsdPerPosition: number
): {
  shouldAdd: boolean;
  reason: string;
  confidence: number;
  recommendedSize?: number;
} {
  // Don't add if at max capacity
  if (activePositions.length >= maxPositions) {
    return { shouldAdd: false, reason: 'Max positions reached', confidence: 0 };
  }

  // Analyze market conditions
  const { trend, strength, volatility, recommendation } = analyzeMarketTrend(
    currentPrice,
    twap1h,
    undefined,
    sigma
  );

  // Don't add if recommendation is to avoid
  if (recommendation === 'avoid') {
    return {
      shouldAdd: false,
      reason: 'Market conditions unfavorable',
      confidence: 0.1,
    };
  }

  // Don't add in extremely high volatility
  if (volatility === 'high' && sigma > 0.05) {
    return {
      shouldAdd: false,
      reason: 'Extremely high volatility',
      confidence: 0.1,
    };
  }

  // Don't add if there are overlapping positions
  const hasOverlap = activePositions.some(
    (pos) => currentTick >= pos.lower && currentTick <= pos.upper
  );

  if (hasOverlap) {
    return {
      shouldAdd: false,
      reason: 'Overlapping position exists',
      confidence: 0.1,
    };
  }

  // Calculate optimal position size
  const positionSizing = calculateOptimalPositionSize(
    currentPrice,
    sigma,
    totalUsdLimit,
    maxUsdPerPosition,
    activePositions.length,
    maxPositions
  );

  // Check if we have enough capital for the recommended size
  const availableAmount =
    totalUsdLimit -
    activePositions.reduce((sum, pos) => sum + pos.amountUsd, 0);
  if (availableAmount < positionSizing.size * 0.5) {
    return {
      shouldAdd: false,
      reason: 'Insufficient capital',
      confidence: 0.2,
    };
  }

  // Prefer adding based on recommendation and market conditions
  let confidence = 0.5;
  if (recommendation === 'add' && trend !== 'neutral' && strength > 20) {
    confidence = 0.9;
  } else if (recommendation === 'add' && volatility === 'low') {
    confidence = 0.8;
  } else if (recommendation === 'add') {
    confidence = 0.7;
  } else if (recommendation === 'hold' && volatility === 'low') {
    confidence = 0.6;
  } else {
    confidence = 0.4;
  }

  return {
    shouldAdd: true,
    reason: `Market trend: ${trend}, volatility: ${volatility}, ${positionSizing.reason}`,
    confidence,
    recommendedSize: positionSizing.size,
  };
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

  // Only calculate return if we have positions
  if (state.positions.length > 0) {
    state.totalReturn = (totalPnL / totalInvested) * 100;
  } else {
    state.totalReturn = 0;
  }

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

  // Calculate additional metrics
  state.totalTrades = state.positions.length;
  state.successfulTrades = profitablePositions;

  // Calculate max drawdown
  let maxValue = 0;
  let maxDrawdown = 0;
  let currentValue = 0;

  for (const position of state.positions) {
    if (position.status === 'closed') {
      currentValue +=
        safeNumber(position.currentValue) + safeNumber(position.feesEarned);
    } else {
      currentValue += safeNumber(position.currentValue);
    }

    if (currentValue > maxValue) {
      maxValue = currentValue;
    }

    const drawdown = ((maxValue - currentValue) / maxValue) * 100;
    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown;
    }
  }

  state.maxDrawdown = maxDrawdown;

  // Calculate Sharpe ratio (simplified)
  const simulationDuration =
    (Date.now() - new Date(state.simulationStartTime).getTime()) /
    (1000 * 60 * 60 * 24); // days
  const dailyReturn =
    simulationDuration > 0 ? state.totalReturn / simulationDuration : 0;
  const volatility = Math.sqrt(
    state.totalImpermanentLoss / Math.max(1, state.positions.length)
  );
  state.sharpeRatio = volatility > 0 ? dailyReturn / volatility : 0;

  state.lastUpdateAt = new Date().toISOString();
}
