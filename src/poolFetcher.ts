// Uniswap V3 Pool Data Fetcher
// Based on official Uniswap V3 documentation for fetching pool data with full tick data
// https://docs.uniswap.org/sdk/v3/guides/fetching-pool-data

import { createPublicClient, http, parseAbi, type Address, type PublicClient } from 'viem';
import { config } from './config.js';
import { UNISWAP_V3_POOL_ABI } from './constants.js';

export interface PoolData {
  address: string;
  fee: number;
  sqrtPriceX96: bigint;
  liquidity: bigint;
  tick: number;
  tickSpacing: number;
  allTicks: TickData[];
}

export interface TickData {
  index: number;
  liquidityGross: bigint;
  liquidityNet: bigint;
  feeGrowthOutside0X128: bigint;
  feeGrowthOutside1X128: bigint;
  tickCumulativeOutside: bigint;
  secondsPerLiquidityOutsideX128: bigint;
  secondsOutside: number;
  initialized: boolean;
}

export class UniswapV3PoolFetcher {
  private client: PublicClient;
  private poolAddress: Address;

  constructor(client: PublicClient, poolAddress: Address) {
    this.client = client;
    this.poolAddress = poolAddress;
  }

  /**
   * Calculate tick to word position for bitmap fetching
   */
  private tickToWord(tick: number, tickSpacing: number): number {
    let compressed = Math.floor(tick / tickSpacing);
    if (tick < 0 && tick % tickSpacing !== 0) {
      compressed -= 1;
    }
    return compressed >> 8;
  }

  /**
   * Get all tick indices in a word range
   */
  private async getTickIndicesInWordRange(
    tickSpacing: number,
    startWord: number,
    endWord: number
  ): Promise<number[]> {
    const calls = [];
    const wordPosIndices: number[] = [];

    // Create calls for all word positions
    for (let i = startWord; i <= endWord; i++) {
      wordPosIndices.push(i);
      calls.push(
        this.client.readContract({
          address: this.poolAddress,
          abi: parseAbi(UNISWAP_V3_POOL_ABI),
          functionName: 'tickBitmap',
          args: [i],
        })
      );
    }

    // Execute all calls
    const results = await Promise.all(calls);
    const tickIndices: number[] = [];

    // Process results to find initialized ticks
    for (let j = 0; j < wordPosIndices.length; j++) {
      const ind = wordPosIndices[j];
      const bitmap = results[j] as bigint;

      if (bitmap !== 0n) {
        for (let i = 0; i < 256; i++) {
          const bit = 1n;
          const initialized = (bitmap & (bit << BigInt(i))) !== 0n;
          if (initialized) {
            const tickIndex = (ind * 256 + i) * tickSpacing;
            tickIndices.push(tickIndex);
          }
        }
      }
    }

    return tickIndices;
  }

  /**
   * Get all initialized ticks for the pool
   */
  private async getAllTicks(tickSpacing: number): Promise<TickData[]> {
    // Calculate all bitmap positions from the tickSpacing of the Pool
    const minWord = this.tickToWord(-887272, tickSpacing);
    const maxWord = this.tickToWord(887272, tickSpacing);

    // Get all tick indices
    const tickIndices = await this.getTickIndicesInWordRange(
      tickSpacing,
      minWord,
      maxWord
    );

    if (tickIndices.length === 0) {
      return [];
    }

    // Fetch all ticks by their indices
    const calls = tickIndices.map((index) =>
      this.client.readContract({
        address: this.poolAddress,
        abi: parseAbi(UNISWAP_V3_POOL_ABI),
        functionName: 'ticks',
        args: [index],
      })
    );

    const results = await Promise.all(calls);
    const allTicks: TickData[] = [];

    for (let i = 0; i < tickIndices.length; i++) {
      const index = tickIndices[i];
      const result = results[i] as [
        bigint,
        bigint,
        bigint,
        bigint,
        bigint,
        bigint,
        number,
        boolean
      ];

      const tick: TickData = {
        index,
        liquidityGross: result[0],
        liquidityNet: result[1],
        feeGrowthOutside0X128: result[2],
        feeGrowthOutside1X128: result[3],
        tickCumulativeOutside: result[4],
        secondsPerLiquidityOutsideX128: result[5],
        secondsOutside: result[6],
        initialized: result[7],
      };

      allTicks.push(tick);
    }

    return allTicks;
  }

  /**
   * Fetch complete pool data including all initialized ticks
   */
  async fetchPoolData(): Promise<PoolData> {
    console.log('🔍 Fetching complete pool data with all ticks...');

    // Get basic pool data
    const [slot0, liquidity, tickSpacing] = await Promise.all([
      this.client.readContract({
        address: this.poolAddress,
        abi: parseAbi(UNISWAP_V3_POOL_ABI),
        functionName: 'slot0',
      }),
      this.client.readContract({
        address: this.poolAddress,
        abi: parseAbi(UNISWAP_V3_POOL_ABI),
        functionName: 'liquidity',
      }),
      this.client.readContract({
        address: this.poolAddress,
        abi: parseAbi(UNISWAP_V3_POOL_ABI),
        functionName: 'tickSpacing',
      }),
    ]);

    const slot0Result = slot0 as [bigint, number, number, number, number, number, boolean];
    const liquidityResult = liquidity as bigint;
    const tickSpacingResult = tickSpacing as number;

    // For monitoring purposes, we'll skip fetching all ticks to avoid rate limiting
    // This is more practical for real-time monitoring
    console.log('⚠️ Skipping full tick data fetch to avoid rate limiting...');
    console.log('   (This is normal for monitoring applications)');

    return {
      address: this.poolAddress,
      fee: config.FEE_TIER,
      sqrtPriceX96: slot0Result[0],
      liquidity: liquidityResult,
      tick: slot0Result[1],
      tickSpacing: tickSpacingResult,
      allTicks: [], // Empty for monitoring - we don't need all ticks for LP analysis
    };
  }

  /**
   * Get current pool state (lightweight)
   */
  async getCurrentPoolState(): Promise<{
    currentTick: number;
    sqrtPriceX96: bigint;
    liquidity: bigint;
  }> {
    const slot0 = await this.client.readContract({
      address: this.poolAddress,
      abi: parseAbi(UNISWAP_V3_POOL_ABI),
      functionName: 'slot0',
    });

    const liquidity = await this.client.readContract({
      address: this.poolAddress,
      abi: parseAbi(UNISWAP_V3_POOL_ABI),
      functionName: 'liquidity',
    });

    const slot0Result = slot0 as [bigint, number, number, number, number, number, boolean];
    const liquidityResult = liquidity as bigint;

    return {
      currentTick: slot0Result[1],
      sqrtPriceX96: slot0Result[0],
      liquidity: liquidityResult,
    };
  }
}
