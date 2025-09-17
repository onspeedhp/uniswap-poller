// Configuration for Uniswap V3 LP Farming Optimizer on Katana Network
// Optimized for USDC/ETH pool analysis and LP farming

export const config = {
  // Katana Network Configuration (Ronin) với fallback
  RPC_HTTP: process.env.RPC_HTTP || 'https://api.roninchain.com/rpc', // Primary Katana RPC
  RPC_FALLBACK_HTTP:
    process.env.RPC_FALLBACK_HTTP || 'https://eth.llamarpc.com', // Better fallback RPC
  RPC_WS: process.env.RPC_WS, // Optional WebSocket

  // Network Config - Start with Ethereum Mainnet for reliability
  CHAIN_ID: parseInt(process.env.CHAIN_ID || '1'), // Start with Ethereum mainnet
  CHAIN_NAME: process.env.CHAIN_NAME || 'Ethereum', // Start with Ethereum

  // Pool Configuration - Start with Ethereum Mainnet USDC/WETH
  // Katana pool: https://www.sushi.com/katana/pool/v3/0x2a2c512beaa8eb15495726c235472d82effb7a6b
  POOL:
    (process.env.POOL as `0x${string}`) ||
    '0x2A2C512beAA8eB15495726C235472D82EFFB7A6B', // Ethereum Mainnet USDC/WETH

  // Token Addresses on Katana - need to fetch full addresses
  // USDC appears to be 0x203a...fd36, ETH appears to be 0xee7d...ab62
  USDC_ADDRESS:
    (process.env.USDC_ADDRESS as `0x${string}`) ||
    '0x203afd362f05d5cf77a34badb4351768c4de8f36', // Placeholder - need verification
  ETH_ADDRESS:
    (process.env.ETH_ADDRESS as `0x${string}`) ||
    '0xee7d375bcb50c26d52dcc0b5f31e6e949837ab62', // Placeholder - need verification

  // LP Farming Risk Thresholds
  DANGER_ZONE_THRESHOLD: parseFloat(
    process.env.DANGER_ZONE_THRESHOLD || '0.10'
  ), // 10% - Vùng nguy hiểm
  WARNING_ZONE_THRESHOLD: parseFloat(
    process.env.WARNING_ZONE_THRESHOLD || '0.20'
  ), // 20% - Vùng cảnh báo
  SAFE_ZONE_THRESHOLD: parseFloat(process.env.SAFE_ZONE_THRESHOLD || '0.30'), // 30% - Vùng an toàn cho LP

  // Monitoring Configuration
  POLL_INTERVAL_MS: parseInt(process.env.POLL_INTERVAL_MS || '5000'), // 5s polling
  BIN_CHANGE_HISTORY_LIMIT: parseInt(
    process.env.BIN_CHANGE_HISTORY_LIMIT || '1000'
  ),

  // APR Calculation Settings
  APR_CALCULATION_PERIOD_HOURS: parseInt(
    process.env.APR_CALCULATION_PERIOD_HOURS || '24'
  ),
  MIN_VOLUME_FOR_APR: parseFloat(process.env.MIN_VOLUME_FOR_APR || '1000'), // Minimum volume to calculate APR

  // CSV Logging Configuration
  CSV_OUTPUT_DIR: process.env.CSV_OUTPUT_DIR || './data',
  BIN_CHANGES_CSV: process.env.BIN_CHANGES_CSV || 'bin_changes.csv',
  LP_OPPORTUNITIES_CSV:
    process.env.LP_OPPORTUNITIES_CSV || 'lp_opportunities.csv',
  APR_TRACKING_CSV: process.env.APR_TRACKING_CSV || 'apr_tracking.csv',

  // Advanced LP Strategy Settings
  OPTIMAL_LP_RANGE_MULTIPLIER: parseFloat(
    process.env.OPTIMAL_LP_RANGE_MULTIPLIER || '2.0'
  ), // Range multiplier for LP positions
  REBALANCE_THRESHOLD: parseFloat(process.env.REBALANCE_THRESHOLD || '0.05'), // 5% threshold to suggest rebalancing
} as const;
