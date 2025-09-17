// Configuration for Uniswap V3 LP Farming Optimizer
// Optimized for LP farming with proper tick tracking and APR calculation
// Adapted for Katana Network

export const config = {
  // Network Configuration
  RPC_HTTP: process.env.RPC_HTTP || 'https://rpc.katana.network',
  RPC_WS: process.env.RPC_WS, // Optional WebSocket for real-time events
  CHAIN_ID: parseInt(process.env.CHAIN_ID || '747474'), // Katana
  CHAIN_NAME: process.env.CHAIN_NAME || 'Katana',

  // Pool Configuration - Katana Network
  // Using a real Katana pool address (USDC/WETH 0.3% fee)
  POOL:
    (process.env.POOL as `0x${string}`) ||
    '0x2A2C512beAA8eB15495726C235472D82EFFB7A6B', // Real Katana pool address

  // Token Addresses on Katana Network
  // Real token addresses on Katana network
  TOKEN0_ADDRESS:
    (process.env.TOKEN0_ADDRESS as `0x${string}`) ||
    '0x203A662b0BD271A6ed5a60EdFbd04bFce608FD36', // USDC on Katana
  TOKEN1_ADDRESS:
    (process.env.TOKEN1_ADDRESS as `0x${string}`) ||
    '0xEE7D8BCFb72bC1880D0Cf19822eB0A2e6577aB62', // WETH on Katana

  // Fee Configuration
  FEE_TIER: parseInt(process.env.FEE_TIER || '3000'), // 0.3% fee in basis points
  TICK_SPACING: parseInt(process.env.TICK_SPACING || '60'), // 60 for 0.3% fee tier

  // LP Farming Risk Thresholds (as percentages)
  DANGER_ZONE_THRESHOLD: 0.1, // < 10% distance to tick boundary - DANGEROUS
  WARNING_ZONE_THRESHOLD: 0.2, // 10-20% distance to tick boundary - WARNING
  SAFE_ZONE_THRESHOLD: 0.3, // 20-30% distance to tick boundary - SAFE
  OPTIMAL_ZONE_THRESHOLD: 0.35, // > 35% distance to tick boundary - OPTIMAL

  // Monitoring Configuration
  POLL_INTERVAL_MS: parseInt(process.env.POLL_INTERVAL_MS || '3000'), // 3s polling for better responsiveness
  DASHBOARD_UPDATE_INTERVAL_MS: parseInt(
    process.env.DASHBOARD_UPDATE_INTERVAL_MS || '10000'
  ), // 10s dashboard updates
  TICK_CHANGE_HISTORY_LIMIT: parseInt(
    process.env.TICK_CHANGE_HISTORY_LIMIT || '2000'
  ),

  // APR Calculation Settings
  APR_CALCULATION_INTERVAL_MS: parseInt(
    process.env.APR_CALCULATION_INTERVAL_MS || '60000'
  ), // 1 minute
  APR_LOOKBACK_HOURS: parseInt(process.env.APR_LOOKBACK_HOURS || '24'), // 24 hours for APR calculation
  MIN_VOLUME_FOR_APR: parseFloat(process.env.MIN_VOLUME_FOR_APR || '1000'), // $1000 minimum volume

  // Data Storage Configuration
  DATA_DIR: process.env.DATA_DIR || './data',
  TICK_CHANGES_CSV: 'tick_changes.csv',
  LP_OPPORTUNITIES_CSV: 'lp_opportunities.csv',
  APR_TRACKING_CSV: 'apr_tracking.csv',
  DETAILED_POOL_DATA_CSV: 'detailed_pool_data.csv',

  // Server Configuration
  SERVER_PORT: parseInt(process.env.SERVER_PORT || '3000'),
  SERVER_HOST: process.env.SERVER_HOST || 'localhost',

  // Advanced LP Strategy Settings
  MIN_TICK_RANGE_DURATION_SECONDS: parseInt(
    process.env.MIN_TICK_RANGE_DURATION_SECONDS || '60'
  ), // Minimum 1 minute in tick range
  MAX_PRICE_VOLATILITY: parseFloat(process.env.MAX_PRICE_VOLATILITY || '0.05'), // 5% max volatility
  REBALANCE_THRESHOLD: parseFloat(process.env.REBALANCE_THRESHOLD || '0.15'), // 15% threshold for rebalancing

  // Logging Configuration
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  ENABLE_DETAILED_LOGGING: process.env.ENABLE_DETAILED_LOGGING === 'true',
} as const;
