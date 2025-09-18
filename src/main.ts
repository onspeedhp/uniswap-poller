import dotenv from 'dotenv';
import { PoolMonitor } from './poolMonitor';
import { DataLogger } from './dataLogger';
import { MONITOR_INTERVAL } from './config';

dotenv.config();

class FarmingMonitor {
  private poolMonitor: PoolMonitor;
  private dataLogger: DataLogger;
  private isRunning: boolean = false;

  constructor() {
    this.poolMonitor = new PoolMonitor();
    this.dataLogger = new DataLogger();
  }

  async start() {
    console.log('🚀 Starting vbUSDC/vbETH Pool Monitor on Katana Network');
    console.log(`📍 Pool Address: ${this.poolMonitor.getPoolAddress()}`);
    console.log(`⏱️  Monitoring interval: ${MONITOR_INTERVAL / 1000}s`);
    console.log('---');

    this.isRunning = true;
    await this.monitorLoop();
  }

  private async monitorLoop() {
    let cycleCount = 0;
    while (this.isRunning) {
      try {
        // Get current pool data
        const poolData = await this.poolMonitor.getPoolData();
        await this.dataLogger.logPoolData(poolData);

        // Get farming metrics with optimal range
        const farmingMetrics = await this.poolMonitor.getFarmingMetrics({
          lower: parseFloat(poolData.currentPrice) * 0.95, // 5% below current
          upper: parseFloat(poolData.currentPrice) * 1.05, // 5% above current
        });
        await this.dataLogger.logFarmingMetrics(farmingMetrics);

        // Display current status
        this.displayStatus(poolData, farmingMetrics);

        // Export to CSV every 10 cycles (100 seconds)
        cycleCount++;
        if (cycleCount % 10 === 0) {
          await this.dataLogger.exportToCSV();
        }
      } catch (error) {
        console.error('❌ Monitoring error:', error);
      }

      // Wait for next interval
      await new Promise((resolve) => setTimeout(resolve, MONITOR_INTERVAL));
    }
  }

  private displayStatus(poolData: any, farmingMetrics: any) {
    const timestamp = new Date().toLocaleTimeString();
    console.log(
      `[${timestamp}] 💰 Price: ${poolData.currentPrice} | 💧 Liquidity: ${
        poolData.liquidity
      } | 📊 IL: ${(farmingMetrics.impermanentLoss * 100).toFixed(2)}%`
    );
    
    if (farmingMetrics.optimalRange) {
      console.log(
        `🎯 Optimal Range: ${farmingMetrics.optimalRange.lower} - ${farmingMetrics.optimalRange.upper} (${farmingMetrics.optimalRange.reason})`
      );
    }
  }

  stop() {
    this.isRunning = false;
    console.log('🛑 Monitoring stopped');
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n👋 Shutting down monitor...');
  process.exit(0);
});

// Start monitoring
const monitor = new FarmingMonitor();
monitor.start().catch(console.error);
