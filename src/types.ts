export interface PoolData {
  timestamp: number;
  poolAddress: string;
  currentPrice: string;
  liquidity: string;
  tick: number;
  feeTier: number;
  volume24h?: string;
  fees24h?: string;
  apr?: number;
  tickSpacing?: number;
  feeGrowth0?: number;
  feeGrowth1?: number;
  price0to1?: string;
  price1to0?: string;
  // Enhanced data from Uniswap SDK
  sqrtPriceX96?: string;
  observationIndex?: number;
  observationCardinality?: number;
  observationCardinalityNext?: number;
  feeProtocol?: number;
  unlocked?: boolean;
  // Oracle data
  twap?: string;
  twal?: string;
  // Active liquidity data
  activeLiquidity?: string;
  liquidityDensity?: LiquidityDensity[];
}

export interface LiquidityDensity {
  tickIdx: number;
  liquidityActive: string;
  liquidityLockedToken0: string;
  liquidityLockedToken1: string;
  price0: string;
  price1: string;
  isCurrent: boolean;
}

export interface FarmingMetrics {
  timestamp: number;
  poolAddress: string;
  priceRange: {
    lower: string;
    upper: string;
    current: string;
  };
  liquidity: string;
  fees: string;
  impermanentLoss: number;
  totalReturn: number;
  optimalRange?: {
    lower: string;
    upper: string;
    reason: string;
  };
  tickLower?: number;
  tickUpper?: number;
  positionValue?: number;
  liquidityUtilization?: number;
  // Enhanced farming metrics
  rangeOrderAnalysis?: RangeOrderAnalysis;
  feeEfficiency?: number;
  capitalEfficiency?: number;
  riskScore?: number;
  recommendedStrategy?: string;
  // Position analysis
  positionAnalysis?: PositionAnalysis;
}

export interface RangeOrderAnalysis {
  singleSideLiquidity: boolean;
  optimalTickRange: {
    lower: number;
    upper: number;
  };
  expectedReturn: number;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  timeToExecute?: number; // Estimated time for price to cross range
}

export interface PositionAnalysis {
  currentPosition: {
    tickLower: number;
    tickUpper: number;
    liquidity: string;
  };
  isInRange: boolean;
  distanceFromCurrent: number; // Ticks away from current price
  feeAccumulation: string;
  impermanentLossRisk: number;
  rebalanceRecommendation?: {
    newTickLower: number;
    newTickUpper: number;
    reason: string;
  };
}

export interface MonitoringConfig {
  poolAddress: string;
  interval: number;
  logToFile: boolean;
}
