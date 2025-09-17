// Advanced Math Utilities for Uniswap V3 LP Farming Optimization
// Optimized for USDC/ETH pool on Katana Network

// Constants for price calculations
const Q192 = 2n ** 192n;
const Q96 = 2n ** 96n;

/**
 * Convert sqrtPriceX96 to human-readable price (token1/token0)
 * With proper decimal scaling for USDC/ETH
 * Returns high precision string for exact price tracking
 */
export function price1Per0FromSqrt(
  sqrtPriceX96: bigint,
  dec0: number,
  dec1: number
): number {
  // Calculate ratio = (sqrtPriceX96^2) / 2^192
  const ratio = (sqrtPriceX96 * sqrtPriceX96) / Q192;

  // Scale by decimals difference
  const decimalDiff = dec0 - dec1;
  const scaleFactor = Math.pow(10, Math.abs(decimalDiff));

  let price: number;
  if (decimalDiff >= 0) {
    price = Number(ratio) * scaleFactor;
  } else {
    price = Number(ratio) / scaleFactor;
  }

  return price;
}

/**
 * Convert sqrtPriceX96 to high precision price string
 * Returns exact price like "0.00022828235"
 */
export function price1Per0FromSqrtPrecise(
  sqrtPriceX96: bigint,
  dec0: number,
  dec1: number,
  precision: number = 18
): string {
  // Calculate price using the same method as regular calculation
  const sqrtPrice = Number(sqrtPriceX96) / Math.pow(2, 96);
  const price = sqrtPrice * sqrtPrice;
  
  // Scale by decimals difference
  const decimalDiff = dec0 - dec1;
  const scaleFactor = Math.pow(10, Math.abs(decimalDiff));
  
  let adjustedPrice: number;
  if (decimalDiff >= 0) {
    // token0 has more decimals, so multiply by scale factor
    adjustedPrice = price * scaleFactor;
  } else {
    // token1 has more decimals, so divide by scale factor
    adjustedPrice = price / scaleFactor;
  }
  
  // Return with specified precision
  return adjustedPrice.toFixed(precision);
}

/**
 * Convert human price back to sqrtPriceX96
 * Useful for range calculations
 */
export function priceToSqrtPriceX96(
  price: number,
  dec0: number,
  dec1: number
): bigint {
  const decimalDiff = dec0 - dec1;
  const scaleFactor = Math.pow(10, Math.abs(decimalDiff));

  let adjustedPrice: number;
  if (decimalDiff >= 0) {
    adjustedPrice = price / scaleFactor;
  } else {
    adjustedPrice = price * scaleFactor;
  }

  const sqrtPrice = Math.sqrt(adjustedPrice);
  return BigInt(Math.floor(sqrtPrice * Number(Q96)));
}

// ==================== TICK AND PRICE CALCULATIONS ====================

/**
 * Calculate price at specific tick (1.0001^tick) with decimal scaling
 */
export function priceAtTick(tick: number, dec0: number, dec1: number): number {
  const basePrice = Math.pow(1.0001, tick);
  const decimalDiff = dec0 - dec1;
  const scaleFactor = Math.pow(10, Math.abs(decimalDiff));

  if (decimalDiff >= 0) {
    return basePrice * scaleFactor;
  } else {
    return basePrice / scaleFactor;
  }
}

/**
 * Convert tick to sqrt price
 */
export function tickToSqrtPriceX96(tick: number): bigint {
  const price = Math.pow(1.0001, tick);
  const sqrtPrice = Math.sqrt(price);
  return BigInt(Math.floor(sqrtPrice * Number(Q96)));
}

// ==================== BIN EDGE ANALYSIS ====================

export interface BinEdgeAnalysis {
  currentBin: number;
  binLowerTick: number;
  binUpperTick: number;
  priceAtBinLower: number;
  priceAtBinUpper: number;

  // Distance analysis
  distanceToLowerEdgePct: number;
  distanceToUpperEdgePct: number;
  nearestEdgeSide: 'lower' | 'upper';
  nearestEdgeDistancePct: number;

  // LP Safety Assessment
  riskLevel: 'danger' | 'warning' | 'safe' | 'optimal';
  riskDescription: string;
  lpRecommendation: 'avoid' | 'caution' | 'add' | 'excellent';
}

/**
 * Advanced bin edge analysis cho LP farming
 */
export function analyzeBinEdges(
  currentTick: number,
  tickSpacing: number,
  currentPrice: number,
  dec0: number,
  dec1: number
): BinEdgeAnalysis {
  // Calculate current bin
  const currentBin = Math.floor(currentTick / tickSpacing);

  // Bin edges in ticks
  const binLowerTick = currentBin * tickSpacing;
  const binUpperTick = (currentBin + 1) * tickSpacing;

  // Prices at bin edges
  const priceAtBinLower = priceAtTick(binLowerTick, dec0, dec1);
  const priceAtBinUpper = priceAtTick(binUpperTick, dec0, dec1);

  // Calculate percentage distances to edges
  const tickRangeInBin = binUpperTick - binLowerTick;
  const ticksFromLower = currentTick - binLowerTick;
  const ticksFromUpper = binUpperTick - currentTick;

  const distanceToLowerEdgePct = ticksFromLower / tickRangeInBin;
  const distanceToUpperEdgePct = ticksFromUpper / tickRangeInBin;

  // Determine nearest edge
  const nearestEdgeSide: 'lower' | 'upper' =
    distanceToLowerEdgePct < distanceToUpperEdgePct ? 'lower' : 'upper';
  const nearestEdgeDistancePct = Math.min(
    distanceToLowerEdgePct,
    distanceToUpperEdgePct
  );

  // Assess risk and LP recommendation
  let riskLevel: 'danger' | 'warning' | 'safe' | 'optimal';
  let riskDescription: string;
  let lpRecommendation: 'avoid' | 'caution' | 'add' | 'excellent';

  if (nearestEdgeDistancePct <= 0.1) {
    // <= 10%
    riskLevel = 'danger';
    riskDescription = `Rất gần edge ${nearestEdgeSide} (${(
      nearestEdgeDistancePct * 100
    ).toFixed(1)}%) - có thể exit range bất cứ lúc nào`;
    lpRecommendation = 'avoid';
  } else if (nearestEdgeDistancePct <= 0.2) {
    // 10-20%
    riskLevel = 'warning';
    riskDescription = `Khá gần edge ${nearestEdgeSide} (${(
      nearestEdgeDistancePct * 100
    ).toFixed(1)}%) - cần theo dõi chặt`;
    lpRecommendation = 'caution';
  } else if (nearestEdgeDistancePct <= 0.35) {
    // 20-35%
    riskLevel = 'safe';
    riskDescription = `Vị trí an toàn, cách edge ${nearestEdgeSide} ${(
      nearestEdgeDistancePct * 100
    ).toFixed(1)}%`;
    lpRecommendation = 'add';
  } else {
    // > 35%
    riskLevel = 'optimal';
    riskDescription = `Vị trí tuyệt vời cho LP! Cách edge ${nearestEdgeSide} ${(
      nearestEdgeDistancePct * 100
    ).toFixed(1)}%`;
    lpRecommendation = 'excellent';
  }

  return {
    currentBin,
    binLowerTick,
    binUpperTick,
    priceAtBinLower,
    priceAtBinUpper,
    distanceToLowerEdgePct,
    distanceToUpperEdgePct,
    nearestEdgeSide,
    nearestEdgeDistancePct,
    riskLevel,
    riskDescription,
    lpRecommendation,
  };
}

// ==================== APR CALCULATION ====================

export interface APRCalculation {
  currentAPR: number;
  projectedAPR: number; // Based on recent activity
  feeAPR: number; // APR from fees only
  averageVolume24h: number;
  averageFees24h: number;
  volumeToTVLRatio: number;
  aprConfidence: 'low' | 'medium' | 'high';
}

/**
 * Calculate APR for LP position based on fees and volume
 */
export function calculateAPR(
  volume24h: number,
  fees24h: number,
  totalValueLocked: number,
  feePercentage: number = 0.0005 // 0.05%
): APRCalculation {
  const dailyFeeRate = fees24h / totalValueLocked || 0;
  const annualFeeRate = dailyFeeRate * 365;
  const feeAPR = annualFeeRate * 100;

  // Calculate projected APR based on volume
  const dailyVolumeRate = (volume24h * feePercentage) / totalValueLocked || 0;
  const projectedAPR = dailyVolumeRate * 365 * 100;

  const volumeToTVLRatio = volume24h / totalValueLocked || 0;

  // Determine confidence based on data consistency
  let aprConfidence: 'low' | 'medium' | 'high';
  if (volume24h > 0 && fees24h > 0 && totalValueLocked > 0) {
    if (volumeToTVLRatio > 0.1) {
      // High activity
      aprConfidence = 'high';
    } else if (volumeToTVLRatio > 0.01) {
      aprConfidence = 'medium';
    } else {
      aprConfidence = 'low';
    }
  } else {
    aprConfidence = 'low';
  }

  return {
    currentAPR: feeAPR,
    projectedAPR,
    feeAPR,
    averageVolume24h: volume24h,
    averageFees24h: fees24h,
    volumeToTVLRatio,
    aprConfidence,
  };
}

// ==================== IMPERMANENT LOSS CALCULATION ====================

export interface ImpermanentLossAnalysis {
  impermanentLossPercentage: number;
  priceChange: number; // % change từ lúc add LP
  hodlValue: number; // Giá trị nếu HODL
  lpValue: number; // Giá trị LP position
  netGainLoss: number; // Sau khi tính fees earned
  feesEarned: number;
  shouldRebalance: boolean;
}

/**
 * Calculate impermanent loss for LP position
 */
export function calculateImpermanentLoss(
  initialPrice: number,
  currentPrice: number,
  initialLiquidity: number,
  feesEarned: number = 0
): ImpermanentLossAnalysis {
  const priceRatio = currentPrice / initialPrice;
  const priceChange = ((currentPrice - initialPrice) / initialPrice) * 100;

  // IL calculation: IL = 2 * sqrt(price_ratio) / (1 + price_ratio) - 1
  const ilMultiplier = (2 * Math.sqrt(priceRatio)) / (1 + priceRatio) - 1;
  const impermanentLossPercentage = ilMultiplier * 100;

  // Value calculations
  const hodlValue = initialLiquidity * (1 + (priceChange / 100) * 0.5); // Simplified 50/50 hodl
  const lpValue = initialLiquidity * (1 + ilMultiplier);
  const netGainLoss = lpValue + feesEarned - hodlValue;

  // Rebalancing suggestion
  const shouldRebalance =
    Math.abs(impermanentLossPercentage) > 5 &&
    feesEarned < Math.abs(netGainLoss);

  return {
    impermanentLossPercentage,
    priceChange,
    hodlValue,
    lpValue,
    netGainLoss,
    feesEarned,
    shouldRebalance,
  };
}

// ==================== UTILITY FUNCTIONS ====================

/**
 * Calculate median of numbers array
 */
export function calculateMedian(numbers: number[]): number {
  if (numbers.length === 0) return 0;
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

/**
 * Check if price is in range
 */
export function isPriceInRange(
  currentPrice: number,
  lowerPrice: number,
  upperPrice: number
): boolean {
  return currentPrice >= lowerPrice && currentPrice <= upperPrice;
}

/**
 * Calculate optimal LP range based on volatility
 */
export function calculateOptimalLPRange(
  currentPrice: number,
  volatility: number, // Historical volatility
  multiplier: number = 2.0
): { lowerPrice: number; upperPrice: number; rangeWidth: number } {
  const rangeWidth = currentPrice * volatility * multiplier;
  const lowerPrice = currentPrice - rangeWidth / 2;
  const upperPrice = currentPrice + rangeWidth / 2;

  return {
    lowerPrice: Math.max(0, lowerPrice),
    upperPrice,
    rangeWidth,
  };
}
