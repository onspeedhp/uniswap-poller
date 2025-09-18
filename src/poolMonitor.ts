import { ethers } from 'ethers';
import { Pool, tickToPrice, nearestUsableTick } from '@uniswap/v3-sdk';
import IUniswapV3PoolABI from '@uniswap/v3-core/artifacts/contracts/interfaces/IUniswapV3Pool.sol/IUniswapV3Pool.json';
import { POOL_CONFIG, RPC_URL } from './config';
import { PoolData, FarmingMetrics } from './types';

export class PoolMonitor {
  private provider: ethers.providers.JsonRpcProvider;
  private poolContract: ethers.Contract;
  private poolAddress: string;

  constructor() {
    this.provider = new ethers.providers.JsonRpcProvider(RPC_URL);
    this.poolAddress = POOL_CONFIG.poolAddress;

    this.poolContract = new ethers.Contract(
      this.poolAddress,
      IUniswapV3PoolABI.abi,
      this.provider
    );
  }

  async getPoolData(): Promise<PoolData> {
    try {
      const [
        slot0,
        liquidity,
        feeGrowthGlobal0X128,
        feeGrowthGlobal1X128,
        tickSpacing,
      ] = await Promise.all([
        this.poolContract['slot0'](),
        this.poolContract['liquidity'](),
        this.poolContract['feeGrowthGlobal0X128'](),
        this.poolContract['feeGrowthGlobal1X128'](),
        this.poolContract['tickSpacing'](),
      ]);

      const pool = new Pool(
        POOL_CONFIG.tokenA,
        POOL_CONFIG.tokenB,
        POOL_CONFIG.fee,
        slot0.sqrtPriceX96,
        liquidity,
        slot0.tick
      );

      // Calculate comprehensive price data
      const price0to1 = pool.token0Price.toFixed(6);
      const price1to0 = pool.token1Price.toFixed(6);

      // Calculate tick-based prices for analysis (removed unused variables)

      // Calculate fee growth (indicator of trading activity)
      const feeGrowth0 =
        parseFloat(feeGrowthGlobal0X128.toString()) / Math.pow(2, 128);
      const feeGrowth1 =
        parseFloat(feeGrowthGlobal1X128.toString()) / Math.pow(2, 128);

      return {
        timestamp: Date.now(),
        poolAddress: this.poolAddress,
        currentPrice: price0to1,
        liquidity: liquidity.toString(),
        tick: slot0.tick,
        feeTier: POOL_CONFIG.fee,
        volume24h: '0', // Would need historical data
        fees24h: '0', // Would need historical data
        apr: 0, // Would need historical data
        tickSpacing: tickSpacing,
        feeGrowth0: feeGrowth0,
        feeGrowth1: feeGrowth1,
        price0to1: price0to1,
        price1to0: price1to0,
      };
    } catch (error) {
      console.error('Error fetching pool data:', error);
      throw error;
    }
  }

  async getFarmingMetrics(priceRange: {
    lower: number;
    upper: number;
  }): Promise<FarmingMetrics> {
    const poolData = await this.getPoolData();

    // Get detailed pool info for accurate calculations
    const [slot0, liquidity, tickSpacing] = await Promise.all([
      this.poolContract['slot0'](),
      this.poolContract['liquidity'](),
      this.poolContract['tickSpacing'](),
    ]);

    const pool = new Pool(
      POOL_CONFIG.tokenA,
      POOL_CONFIG.tokenB,
      POOL_CONFIG.fee,
      slot0.sqrtPriceX96,
      liquidity,
      slot0.tick
    );

    const currentPrice = parseFloat(poolData.currentPrice);
    const lowerPrice = priceRange.lower;
    const upperPrice = priceRange.upper;

    // Calculate ticks for the price range (simplified)
    const tickLower = Math.floor(Math.log(lowerPrice) / Math.log(1.0001));
    const tickUpper = Math.floor(Math.log(upperPrice) / Math.log(1.0001));

    // Calculate optimal range for farming
    const optimalRange = this.calculateOptimalRange(
      currentPrice,
      slot0.tick,
      tickSpacing
    );

    // More accurate IL calculation
    const priceRatio = currentPrice / ((lowerPrice + upperPrice) / 2);
    const impermanentLoss = this.calculateImpermanentLoss(priceRatio);

    // Calculate position value if we had liquidity in this range
    const positionValue = this.calculatePositionValue(
      pool,
      tickLower,
      tickUpper,
      currentPrice
    );

    return {
      timestamp: Date.now(),
      poolAddress: this.poolAddress,
      priceRange: {
        lower: lowerPrice.toString(),
        upper: upperPrice.toString(),
        current: currentPrice.toString(),
      },
      liquidity: poolData.liquidity,
      fees: '0', // Would need to calculate from historical data
      impermanentLoss,
      totalReturn: 0, // Would need historical data
      optimalRange,
      tickLower: tickLower,
      tickUpper: tickUpper,
      positionValue: positionValue,
      liquidityUtilization: 0, // Would need to calculate based on active liquidity
    };
  }

  private calculateOptimalRange(
    currentPrice: number,
    currentTick: number,
    tickSpacing: number
  ): {
    lower: string;
    upper: string;
    reason: string;
  } {
    // Calculate optimal range based on tick spacing and current position
    const tickRange = tickSpacing * 10; // 10 tick spacing for optimal range
    const lowerTick = nearestUsableTick(currentTick - tickRange, tickSpacing);
    const upperTick = nearestUsableTick(currentTick + tickRange, tickSpacing);

    const lowerPrice = parseFloat(
      tickToPrice(POOL_CONFIG.tokenA, POOL_CONFIG.tokenB, lowerTick).toFixed(6)
    );
    const upperPrice = parseFloat(
      tickToPrice(POOL_CONFIG.tokenA, POOL_CONFIG.tokenB, upperTick).toFixed(6)
    );

    return {
      lower: lowerPrice.toString(),
      upper: upperPrice.toString(),
      reason: `Optimal range: ±${tickRange} ticks from current position`,
    };
  }

  private calculateImpermanentLoss(priceRatio: number): number {
    // More accurate IL calculation
    if (priceRatio <= 0) return 0;

    const sqrtPriceRatio = Math.sqrt(priceRatio);
    const numerator = 2 * sqrtPriceRatio;
    const denominator = 1 + priceRatio;

    return Math.max(0, 1 - numerator / denominator);
  }

  private calculatePositionValue(
    pool: Pool,
    tickLower: number,
    tickUpper: number,
    currentPrice: number
  ): number {
    // Calculate theoretical position value (simplified)
    try {
      // Simple calculation based on price range
      const rangeWidth = tickUpper - tickLower;
      const positionValue = rangeWidth * currentPrice;
      return positionValue;
    } catch (error) {
      return 0;
    }
  }

  getPoolAddress(): string {
    return this.poolAddress;
  }
}
