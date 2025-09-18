// constants.ts — Configuration and constants

export const UNISWAP_V3_POOL_ABI = [
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee() view returns (uint24)',
  'function tickSpacing() view returns (int24)',
  'function liquidity() view returns (uint128)',
  'function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)',
  'function ticks(int24) view returns (uint128,int128,uint256,uint256,int56,uint160,uint32,bool)',
  'function tickBitmap(int16) view returns (uint256)',
  'function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)',
] as const;

export const ERC20_ABI = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
] as const;

export const LOG_1P0001 = Math.log(1.0001);

export const DEFAULT_STATE = {
  positions: [],
  totalUsdInvested: 0,
  maxPositions: 5,
  maxUsdPerPosition: 2000, // Max 2k per position
  totalUsdLimit: 10000, // Max 10k total
  totalFeesEarned: 0,
  totalImpermanentLoss: 0,
  totalReturn: 0,
  winRate: 0,
  averagePositionDuration: 0,
  lastUpdateAt: new Date().toISOString(),
  // Enhanced simulation parameters
  simulationStartTime: new Date().toISOString(),
  totalTrades: 0,
  successfulTrades: 0,
  maxDrawdown: 0,
  sharpeRatio: 0,
  // Gas costs
  totalGasSpent: 0,
  gasCostPerTransaction: 50, // $50 per transaction (add/remove/rebalance)
};

export const CONFIG = {
  RPC_HTTP: process.env.RPC_HTTP ?? 'https://rpc.katana.network',
  CHAIN_ID: Number(process.env.CHAIN_ID ?? 747474),
  CHAIN_NAME: process.env.CHAIN_NAME ?? 'Katana',
  POOL: process.env.POOL ?? '0x2A2C512beAA8eB15495726C235472D82EFFB7A6B',
  TOKEN0:
    process.env.TOKEN0_ADDRESS ?? '0x203A662b0BD271A6ed5a60EdFbd04bFce608FD36',
  TOKEN1:
    process.env.TOKEN1_ADDRESS ?? '0xEE7D8BCFb72bC1880D0Cf19822eB0A2e6577aB62',
  OUT_SNAPSHOTS: process.env.OUT_SNAPSHOTS || './data/snapshots.csv',
  OUT_EVENTS: process.env.OUT_EVENTS || './data/events.csv',
  STATE_FILE: process.env.STATE_FILE || './data/state.json',
  INTERVAL_SEC: Number(process.env.INTERVAL_SEC ?? 0),
  T_HOURS: Number(process.env.T_HOURS ?? 24),
  Z_CONF: Number(process.env.Z_CONF ?? 1.28),
} as const;
