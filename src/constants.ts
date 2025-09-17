// Shared constants and ABIs for Uniswap V3 pool monitoring

// Uniswap V3 Pool ABI (minimal required functions)
export const UNISWAP_V3_POOL_ABI = [
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee() view returns (uint24)',
  'function tickSpacing() view returns (int24)',
  'function liquidity() view returns (uint128)',
  'function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)',
  'function ticks(int24 tick) view returns (uint128 liquidityGross,int128 liquidityNet,uint256 feeGrowthOutside0X128,uint256 feeGrowthOutside1X128,int56 tickCumulativeOutside,uint160 secondsPerLiquidityOutsideX128,uint32 secondsOutside,bool initialized)',
  'function tickBitmap(int16 wordPosition) view returns (uint256)',
];

// ERC20 ABI for token metadata
export const ERC20_ABI = [
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
];

// Swap event ABI
export const SWAP_EVENT_ABI = [
  'event Swap(address sender,address recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)',
];

// Common error messages
export const ERROR_MESSAGES = {
  POOL_NOT_CONFIGURED:
    'Pool address not configured. Please update config.ts with the actual pool address for your target network.',
  TOKENS_NOT_CONFIGURED:
    'Token addresses not configured. Please update config.ts with the actual token addresses for your target network.',
  INVALID_POOL_ADDRESS:
    'Invalid pool address. Please check the pool address in your configuration.',
} as const;

// Configuration validation helpers
export function validateConfiguration(
  poolAddress: string,
  token0Address: string,
  token1Address: string
): void {
  if (poolAddress === '0x0000000000000000000000000000000000000000') {
    throw new Error(ERROR_MESSAGES.POOL_NOT_CONFIGURED);
  }

  if (
    token0Address === '0x0000000000000000000000000000000000000000' ||
    token1Address === '0x0000000000000000000000000000000000000000'
  ) {
    throw new Error(ERROR_MESSAGES.TOKENS_NOT_CONFIGURED);
  }
}

// Tick calculation helpers
export function tickToWord(tick: number, tickSpacing: number): number {
  let compressed = Math.floor(tick / tickSpacing);
  if (tick < 0 && tick % tickSpacing !== 0) {
    compressed -= 1;
  }
  return compressed >> 8;
}

// Common tick range constants
export const TICK_RANGE = {
  MIN_TICK: -887272,
  MAX_TICK: 887272,
} as const;
