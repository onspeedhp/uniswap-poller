import { Token } from '@uniswap/sdk-core';
import { FeeAmount } from '@uniswap/v3-sdk';

// Katana Network Configuration
export const KATANA_CHAIN_ID = 747474;

// Token definitions for Katana network
export const VBUSDC_TOKEN = new Token(
  KATANA_CHAIN_ID,
  '0x203A662b0BD271A6ed5a60EdFbd04bFce608FD36', // vbUSDC contract address on Katana
  6,
  'vbUSDC',
  'Venus Bridge USDC'
);

export const VBETH_TOKEN = new Token(
  KATANA_CHAIN_ID,
  '0xEE7D8BCFb72bC1880D0Cf19822eB0A2e6577aB62', // vbETH contract address on Katana
  18,
  'vbETH',
  'Venus Bridge ETH'
);

// Pool configuration
export const POOL_CONFIG = {
  poolAddress: '0x2A2C512beAA8eB15495726C235472D82EFFB7A6B',
  tokenA: VBUSDC_TOKEN,
  tokenB: VBETH_TOKEN,
  fee: FeeAmount.MEDIUM, // 0.3%
};

// RPC Configuration
export const RPC_URL =
  process.env['KATANA_RPC_URL'] || 'https://rpc.katana.network';

// Monitoring intervals
export const MONITOR_INTERVAL = 10000; // 10 seconds for better farming data
