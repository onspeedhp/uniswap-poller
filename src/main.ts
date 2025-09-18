// main.ts — Optimized Uniswap V3 LP Manager
import 'dotenv/config';
import fs from 'fs';
import { CONFIG } from './constants.js';
import { PoolService } from './poolService.js';
import { PortfolioManager } from './portfolioManager.js';
import { widthFromSigma, roundDownToSpacing } from './utils.js';

class UniswapV3LPManager {
  private poolService: PoolService;
  private portfolioManager: PortfolioManager;

  constructor() {
    this.poolService = new PoolService();
    this.portfolioManager = new PortfolioManager();
  }

  async initialize(): Promise<void> {
    await this.poolService.initialize();
    this.initializeCSVFiles();
  }

  private initializeCSVFiles(): void {
    const csvHeaders = {
      snapshots:
        'timestamp,block,tick,sqrtPriceX96,price_1per0,liquidity,fee,spacing,twap5m,twap1h,sigma\n',
      events:
        'timestamp,positionId,action,reason,tick,price,positionRange,distance,entryPrice,amountUsd,currentValue,feesEarned,impermanentLoss,totalReturn,timeHeld,rebalanceCount\n',
    };

    Object.entries(csvHeaders).forEach(([key, header]) => {
      const filePath = CONFIG[
        `OUT_${key.toUpperCase()}` as keyof typeof CONFIG
      ] as string;
      if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, header);
      }
    });

    if (!fs.existsSync('./data')) {
      fs.mkdirSync('./data', { recursive: true });
    }
  }

  async processOnce(): Promise<void> {
    try {
      const poolData = await this.poolService.getPoolData();
      const tokenInfo = this.poolService.getTokenInfo();

      // Calculate strategy parameters
      const center = poolData.twap1hTick ?? poolData.tick;
      const W = widthFromSigma(
        poolData.sigma,
        CONFIG.T_HOURS,
        CONFIG.Z_CONF,
        poolData.spacing
      );
      const lowerReco = roundDownToSpacing(
        center - Math.floor(W / 2),
        poolData.spacing
      );
      const upperReco = lowerReco + W;

      // Process portfolio decisions
      await this.portfolioManager.processPositions(
        poolData.tick,
        poolData.price,
        tokenInfo.dec0,
        tokenInfo.dec1,
        Number(poolData.liquidity),
        poolData.fee,
        poolData.spacing,
        lowerReco,
        upperReco,
        poolData.twap1hTick,
        poolData.sigma
      );

      // Log pool data
      this.logPoolData(poolData, tokenInfo, lowerReco, upperReco);

      // Write CSV data
      this.writeCSVData(poolData);

      // Display enhanced simulation summary
      this.displaySimulationSummary();
    } catch (error) {
      console.error('Error processing pool data:', error);
    }
  }

  private logPoolData(
    poolData: any,
    tokenInfo: any,
    lowerReco: number,
    upperReco: number
  ): void {
    console.log(
      `\n🔄 POOL: ${tokenInfo.sym0}/${
        tokenInfo.sym1
      } | Price: ${poolData.price.toFixed(
        6
      )} | Range: [${lowerReco},${upperReco}] | Tick: ${poolData.tick}`
    );
    console.log(
      `   📊 Volatility: ${poolData.sigma.toFixed(4)} | TWAP1h: ${poolData.twap1hTick || 'N/A'} | Liquidity: ${(Number(poolData.liquidity) / 1e18).toFixed(2)}`
    );
  }

  private writeCSVData(poolData: any): void {
    const timestamp = new Date().toISOString();

    // Write snapshot data
    const snapData =
      [
        timestamp,
        Date.now(), // block number placeholder
        poolData.tick,
        poolData.sqrtPriceX96,
        poolData.price,
        poolData.liquidity,
        poolData.fee,
        poolData.spacing,
        poolData.twap5mTick ?? '',
        poolData.twap1hTick ?? '',
        poolData.sigma,
      ].join(',') + '\n';

    fs.appendFileSync(CONFIG.OUT_SNAPSHOTS, snapData);
  }

  private displaySimulationSummary(): void {
    const summary = this.portfolioManager.getPortfolioSummary();

    console.log(`\n📊 PORTFOLIO SUMMARY (vbUSDC/vbETH):`);
    console.log(
      `   💰 Positions: ${summary.activePositions}/${
        summary.maxPositions
      } | Invested: $${summary.totalInvested.toFixed(0)}/${
        summary.totalUsdLimit
      } | Available: $${(summary.totalUsdLimit - summary.totalInvested).toFixed(0)}`
    );
    console.log(
      `   📈 Return: ${summary.totalReturn.toFixed(
        1
      )}% | Win Rate: ${summary.winRate.toFixed(
        1
      )}% | Fees Earned: $${summary.totalFeesEarned.toFixed(2)}`
    );
    console.log(
      `   ⚠️  Max Drawdown: ${summary.maxDrawdown.toFixed(
        1
      )}% | Sharpe: ${summary.sharpeRatio.toFixed(
        2
      )} | Avg Duration: ${summary.averagePositionDuration.toFixed(1)}h`
    );
    console.log(
      `   🔄 Total Trades: ${summary.totalTrades} | Successful: ${summary.successfulTrades} | Gas Spent: $${summary.totalGasSpent}`
    );
    
    // Add position recommendations
    if (summary.activePositions > 0) {
      console.log(`\n🎯 POSITION RECOMMENDATIONS:`);
      console.log(`   • Monitor all positions for range proximity`);
      console.log(`   • Consider rebalancing if price approaches range edges`);
      console.log(`   • Watch for stop-loss triggers at -25% return`);
      console.log(`   • Take profit opportunities at +40% return`);
    }
  }

  async run(): Promise<void> {
    await this.initialize();

    if (CONFIG.INTERVAL_SEC > 0) {
      await this.processOnce();
      setInterval(() => this.processOnce(), CONFIG.INTERVAL_SEC * 1000);
    } else {
      await this.processOnce();
      process.exit(0);
    }
  }
}

// Main execution
const manager = new UniswapV3LPManager();
manager.run().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
