// poolService.ts — Pool data fetching and processing

import { ethers } from 'ethers';
import { UNISWAP_V3_POOL_ABI, ERC20_ABI, CONFIG } from './constants.js';
import { PoolData } from './types.js';
import { priceFromSqrtX96 } from './utils.js';

export class PoolService {
  private provider: ethers.providers.JsonRpcProvider;
  private pool: ethers.Contract;
  private erc0: ethers.Contract;
  private erc1: ethers.Contract;
  private dec0: number = 0;
  private dec1: number = 0;
  private sym0: string = '';
  private sym1: string = '';

  constructor() {
    this.provider = new ethers.providers.JsonRpcProvider(CONFIG.RPC_HTTP, {
      name: CONFIG.CHAIN_NAME,
      chainId: CONFIG.CHAIN_ID,
    });
    this.pool = new ethers.Contract(
      CONFIG.POOL,
      UNISWAP_V3_POOL_ABI,
      this.provider
    );
    this.erc0 = new ethers.Contract(CONFIG.TOKEN0, ERC20_ABI, this.provider);
    this.erc1 = new ethers.Contract(CONFIG.TOKEN1, ERC20_ABI, this.provider);
  }

  async initialize(): Promise<void> {
    const [dec0, dec1, sym0, sym1] = await Promise.all([
      this.erc0.decimals(),
      this.erc1.decimals(),
      this.erc0.symbol(),
      this.erc1.symbol(),
    ]);

    this.dec0 = dec0;
    this.dec1 = dec1;
    this.sym0 = sym0;
    this.sym1 = sym1;
  }

  async getPoolData(): Promise<PoolData> {
    const block = await this.provider.getBlock('latest');

    const [slot0, L_global, fee, spacing] = await Promise.all([
      this.pool.slot0(),
      this.pool.liquidity(),
      this.pool.fee(),
      this.pool.tickSpacing(),
    ]);

    const tick: number = slot0[1];
    const sqrtPriceX96 = slot0[0];
    const price = priceFromSqrtX96(sqrtPriceX96, this.dec0, this.dec1);

    // TWAP & sigma calculation
    let twap5mTick: number | undefined;
    let twap1hTick: number | undefined;
    let sigma = 0;

    try {
      const ob = await this.pool.observe([0, 300, 3600]);
      const tCum = ob[0] as ethers.BigNumber[];
      const tick5m = tCum[0].sub(tCum[1]).div(300).toNumber();
      const tick1h = tCum[0].sub(tCum[2]).div(3600).toNumber();
      twap5mTick = tick5m;
      twap1hTick = tick1h;
      const twapDrift = Math.abs(tick5m - tick1h);
      sigma = twapDrift * Math.log(1.0001);
    } catch {
      // Oracle may not have enough observations
    }

    return {
      tick,
      sqrtPriceX96: sqrtPriceX96.toString(),
      price,
      liquidity: L_global.toString(),
      fee,
      spacing,
      twap5mTick,
      twap1hTick,
      sigma,
    };
  }

  getTokenInfo() {
    return {
      sym0: this.sym0,
      sym1: this.sym1,
      dec0: this.dec0,
      dec1: this.dec1,
    };
  }
}
