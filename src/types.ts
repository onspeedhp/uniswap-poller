// types.ts — Type definitions for Uniswap V3 LP Manager

// Removed unused SimEvent type

export interface Position {
  id: string;
  lower: number;
  upper: number;
  enteredAt: string;
  entryTick: number;
  entryPrice: number;
  amountUsd: number;
  status: 'active' | 'closed';
  feesEarned: number;
  lastRebalanceAt?: string;
  rebalanceCount: number;
  // Enhanced fields
  liquidity: number;
  token0Amount: number;
  token1Amount: number;
  currentValue: number;
  impermanentLoss: number;
  totalReturn: number;
  lastUpdateAt: string;
}

export interface SimState {
  positions: Position[];
  totalUsdInvested: number;
  maxPositions: number;
  maxUsdPerPosition: number;
  totalUsdLimit: number;
  // Enhanced analytics
  totalFeesEarned: number;
  totalImpermanentLoss: number;
  totalReturn: number;
  winRate: number;
  averagePositionDuration: number;
  lastUpdateAt: string;
  // Enhanced simulation parameters
  simulationStartTime: string;
  totalTrades: number;
  successfulTrades: number;
  maxDrawdown: number;
  sharpeRatio: number;
  // Gas costs
  totalGasSpent: number;
  gasCostPerTransaction: number;
}

export interface PoolData {
  tick: number;
  sqrtPriceX96: string;
  price: number;
  liquidity: string;
  fee: number;
  spacing: number;
  obCard: number;
  leftTick: number | null;
  rightTick: number | null;
  initDistLeft: number | undefined;
  initDistRight: number | undefined;
  twap5mTick: number | undefined;
  twap1hTick: number | undefined;
  sigma: number;
  oracleQuality: string;
}

export interface PositionDecision {
  timestamp: string;
  positionId: string;
  action: string;
  reason: string;
  tick: number;
  price: string;
  positionRange: string;
  distance: number;
  entryPrice: string;
  amountUsd: number;
  currentValue: string;
  feesEarned: string;
  impermanentLoss: string;
  totalReturn: string;
  timeHeld: string;
  rebalanceCount: number;
}
