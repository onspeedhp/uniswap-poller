// main.ts — Optimized Uniswap V3 LP Manager
import 'dotenv/config';
import fs from 'fs';
import { CONFIG } from './constants.js';
import { PoolService } from './poolService.js';
import { PortfolioManager } from './portfolioManager.js';
import {
  fmt,
  widthFromSigma,
  bufferB,
  dangerD,
  roundDownToSpacing,
} from './utils.js';

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
        'timestamp,block,tick,sqrtPriceX96,price_1per0,liquidity,fee,spacing,obCard,leftInitTick,rightInitTick,initDistLeft,initDistRight,twap5m,twap1h,sigma,oracle_quality_flag\n',
      decisions:
        'timestamp,action,reason,tick,twap1h,tickLower,tickUpper,W,B,D,initDistMin\n',
      signals:
        'timestamp,signal,reason,tick,price,twapDriftTicks,trend,posDistMin,W,B,D,lowerReco,upperReco\n',
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
      const B = bufferB(W, poolData.spacing);
      const D = dangerD(W, poolData.spacing);
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
        W,
        B,
        D,
        poolData.spacing,
        lowerReco,
        upperReco
      );

      // Log pool data
      this.logPoolData(poolData, tokenInfo, W, B, D, lowerReco, upperReco);

      // Write CSV data
      this.writeCSVData(poolData, W, B, D, lowerReco, upperReco);

      // Display enhanced simulation summary
      this.displaySimulationSummary();
    } catch (error) {
      console.error('Error processing pool data:', error);
    }
  }

  private logPoolData(
    poolData: any,
    tokenInfo: any,
    W: number,
    B: number,
    D: number,
    lowerReco: number,
    upperReco: number
  ): void {
    const twapDrift =
      poolData.twap5mTick !== undefined && poolData.twap1hTick !== undefined
        ? Math.abs(poolData.twap5mTick - poolData.twap1hTick)
        : undefined;

    const trendLabel =
      twapDrift === undefined
        ? 'unknown'
        : twapDrift < Math.max(poolData.spacing, Math.floor(0.2 * W))
        ? 'sideways'
        : 'trending';

    console.log(
      `\n🔄 [${new Date().toISOString()}] POOL UPDATE: ${tokenInfo.sym0}/${
        tokenInfo.sym1
      }`
    );
    console.log(
      `   • Fee: ${poolData.fee / 10000}% | Spacing: ${poolData.spacing} tick`
    );
    console.log(
      `   • Current: tick=${poolData.tick} | price=${poolData.price.toFixed(6)}`
    );
    console.log(
      `   • Strategy: W=${W} | B=${B} | D=${D} | Range=[${lowerReco},${upperReco}]`
    );
    console.log(`   • Trend: ${trendLabel} (drift=${twapDrift || 'N/A'} tick)`);

    if (CONFIG.HUMAN_LOG) {
      this.displayHumanReadableLog(
        poolData,
        tokenInfo,
        W,
        B,
        D,
        lowerReco,
        upperReco,
        twapDrift,
        trendLabel
      );
    }
  }

  private displayHumanReadableLog(
    poolData: any,
    tokenInfo: any,
    W: number,
    B: number,
    D: number,
    lowerReco: number,
    upperReco: number,
    twapDrift: number | undefined,
    trendLabel: string
  ): void {
    const priceLine = `• Giá hiện tại: 1 ${tokenInfo.sym0} = ${fmt(
      poolData.price,
      6
    )} ${tokenInfo.sym1}`;
    const twapLine =
      poolData.twap5mTick !== undefined && poolData.twap1hTick !== undefined
        ? `• TWAP 5m vs 1h (tick): ${poolData.twap5mTick} vs ${poolData.twap1hTick} → chênh: ${twapDrift} tick (${trendLabel})`
        : '• TWAP: chưa đủ dữ liệu';
    const edgesLine = `• Tick đã khởi tạo gần nhất: trái=${
      poolData.leftTick ?? 'không có'
    } | phải=${poolData.rightTick ?? 'không có'}; khoảng cách: trái=${
      poolData.initDistLeft ?? '-'
    } | phải=${poolData.initDistRight ?? '-'}`;
    const bandLine = `• Dải đề xuất quanh TWAP1h: [${lowerReco}, ${upperReco}] (W=${W} tick)`;
    const safetyLine = `• Vùng an toàn (B): ${B} | Ngưỡng cảnh báo (D): ${D} | Oracle: ${poolData.oracleQuality}`;

    // Add simulation status
    const activePositions = this.portfolioManager.getActivePositionsCount();
    const totalInvested = this.portfolioManager.getTotalInvested();
    const simulationLine = `• Simulation: ${activePositions}/5 positions, $${totalInvested.toFixed(
      0
    )}/10k$ invested`;

    console.log(
      [
        '\n================= Gợi ý dễ hiểu =================',
        `Cặp: ${tokenInfo.sym0}/${tokenInfo.sym1} | Fee: ${
          poolData.fee / 10000
        }% | spacing: ${poolData.spacing} tick`,
        priceLine,
        twapLine,
        edgesLine,
        bandLine,
        safetyLine,
        simulationLine,
        '=================================================\n',
      ].join('\n')
    );
  }

  private writeCSVData(
    poolData: any,
    W: number,
    B: number,
    D: number,
    lowerReco: number,
    upperReco: number
  ): void {
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
        poolData.obCard,
        poolData.leftTick ?? '',
        poolData.rightTick ?? '',
        poolData.initDistLeft ?? '',
        poolData.initDistRight ?? '',
        poolData.twap5mTick ?? '',
        poolData.twap1hTick ?? '',
        poolData.sigma,
        poolData.oracleQuality,
      ].join(',') + '\n';

    fs.appendFileSync(CONFIG.OUT_SNAPSHOTS, snapData);
  }

  private displaySimulationSummary(): void {
    const summary = this.portfolioManager.getPortfolioSummary();

    console.log(`\n🎯 SIMULATION SUMMARY:`);
    console.log(
      `   • Active Positions: ${summary.activePositions}/${summary.maxPositions}`
    );
    console.log(
      `   • Total Invested: $${summary.totalInvested.toFixed(0)}/${
        summary.totalUsdLimit
      }`
    );
    console.log(
      `   • Total Fees Earned: $${summary.totalFeesEarned.toFixed(2)}`
    );
    console.log(`   • Total Return: ${summary.totalReturn.toFixed(2)}%`);
    console.log(`   • Win Rate: ${summary.winRate.toFixed(1)}%`);
    console.log(
      `   • Available Capacity: $${(
        summary.totalUsdLimit - summary.totalInvested
      ).toFixed(0)}`
    );

    // Calculate portfolio health
    const portfolioHealth = this.calculatePortfolioHealth(summary);
    const healthStatus =
      portfolioHealth > 0.8 ? '🟢' : portfolioHealth > 0.6 ? '🟡' : '🔴';

    console.log(
      `   • Portfolio Health: ${healthStatus} ${(portfolioHealth * 100).toFixed(
        1
      )}%`
    );

    if (summary.activePositions === 0 && summary.totalInvested === 0) {
      console.log(`   • Status: 🟡 Waiting for first position opportunity`);
    } else if (summary.activePositions === summary.maxPositions) {
      console.log(`   • Status: 🔴 Portfolio at maximum capacity`);
    } else if (summary.totalReturn > 15) {
      console.log(`   • Status: 🟢 Portfolio performing excellently`);
    } else if (summary.totalReturn > 5) {
      console.log(`   • Status: 🟢 Portfolio performing well`);
    } else if (summary.totalReturn < -10) {
      console.log(`   • Status: 🔴 Portfolio underperforming significantly`);
    } else if (summary.totalReturn < -5) {
      console.log(`   • Status: 🔴 Portfolio underperforming`);
    } else {
      console.log(`   • Status: 🟡 Portfolio stable`);
    }

    // Show next action recommendation
    this.showNextActionRecommendation(summary);
  }

  private calculatePortfolioHealth(summary: any): number {
    if (summary.activePositions === 0) return 1;

    const healthFactors = [];

    // Factor 1: Return performance
    if (summary.totalReturn > 10) healthFactors.push(1);
    else if (summary.totalReturn > 0) healthFactors.push(0.8);
    else if (summary.totalReturn > -5) healthFactors.push(0.6);
    else healthFactors.push(0.2);

    // Factor 2: Win rate
    if (summary.winRate > 70) healthFactors.push(1);
    else if (summary.winRate > 50) healthFactors.push(0.8);
    else if (summary.winRate > 30) healthFactors.push(0.6);
    else healthFactors.push(0.3);

    // Factor 3: Capacity utilization
    const utilization = summary.totalInvested / summary.totalUsdLimit;
    if (utilization > 0.8) healthFactors.push(0.9);
    else if (utilization > 0.5) healthFactors.push(1);
    else if (utilization > 0.2) healthFactors.push(0.8);
    else healthFactors.push(0.6);

    return (
      healthFactors.reduce((sum, factor) => sum + factor, 0) /
      healthFactors.length
    );
  }

  private showNextActionRecommendation(summary: any): void {
    console.log(`\n💡 NEXT ACTION RECOMMENDATION:`);

    if (summary.activePositions === 0) {
      console.log(
        `   • 🟢 Ready to add first position - monitoring market conditions`
      );
    } else if (
      summary.activePositions < summary.maxPositions &&
      summary.totalInvested < summary.totalUsdLimit * 0.8
    ) {
      console.log(
        `   • 🟡 Consider adding more positions - ${
          summary.maxPositions - summary.activePositions
        } slots available`
      );
    } else if (summary.activePositions === summary.maxPositions) {
      console.log(
        `   • 🔴 Portfolio at capacity - focus on managing existing positions`
      );
    } else if (summary.totalReturn < -5) {
      console.log(
        `   • 🔴 Portfolio struggling - consider closing underperforming positions`
      );
    } else if (summary.totalReturn > 10) {
      console.log(
        `   • 🟢 Portfolio performing well - maintain current strategy`
      );
    } else {
      console.log(
        `   • 🟡 Portfolio stable - continue monitoring and rebalancing as needed`
      );
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
