import fs from 'fs/promises';
import path from 'path';
import { PoolData, FarmingMetrics } from './types';

export class DataLogger {
  private dataDir: string;

  constructor() {
    this.dataDir = path.join(process.cwd(), 'data');
    this.ensureDataDir();
  }

  private async ensureDataDir() {
    try {
      await fs.access(this.dataDir);
    } catch {
      await fs.mkdir(this.dataDir, { recursive: true });
    }
  }

  async logPoolData(data: PoolData) {
    const filename = `pool-data-${new Date().toISOString().split('T')[0]}.json`;
    const filepath = path.join(this.dataDir, filename);

    try {
      let existingData: PoolData[] = [];
      try {
        const fileContent = await fs.readFile(filepath, 'utf-8');
        existingData = JSON.parse(fileContent);
      } catch {
        // File doesn't exist, start with empty array
      }

      existingData.push(data);
      await fs.writeFile(filepath, JSON.stringify(existingData, null, 2));

      console.log(
        `📊 Pool data logged: Price=${data.currentPrice}, Liquidity=${data.liquidity}`
      );
    } catch (error) {
      console.error('Error logging pool data:', error);
    }
  }

  async logFarmingMetrics(metrics: FarmingMetrics) {
    const filename = `farming-metrics-${
      new Date().toISOString().split('T')[0]
    }.json`;
    const filepath = path.join(this.dataDir, filename);

    try {
      let existingData: FarmingMetrics[] = [];
      try {
        const fileContent = await fs.readFile(filepath, 'utf-8');
        existingData = JSON.parse(fileContent);
      } catch {
        // File doesn't exist, start with empty array
      }

      existingData.push(metrics);
      await fs.writeFile(filepath, JSON.stringify(existingData, null, 2));

      console.log(
        `🌾 Farming metrics logged: IL=${(
          metrics.impermanentLoss * 100
        ).toFixed(2)}%`
      );
    } catch (error) {
      console.error('Error logging farming metrics:', error);
    }
  }

  async getLatestData(): Promise<{
    poolData: PoolData[];
    farmingMetrics: FarmingMetrics[];
  }> {
    const today = new Date().toISOString().split('T')[0];
    const poolFile = path.join(this.dataDir, `pool-data-${today}.json`);
    const farmingFile = path.join(
      this.dataDir,
      `farming-metrics-${today}.json`
    );

    let poolData: PoolData[] = [];
    let farmingMetrics: FarmingMetrics[] = [];

    try {
      const poolContent = await fs.readFile(poolFile, 'utf-8');
      poolData = JSON.parse(poolContent);
    } catch {
      // File doesn't exist
    }

    try {
      const farmingContent = await fs.readFile(farmingFile, 'utf-8');
      farmingMetrics = JSON.parse(farmingContent);
    } catch {
      // File doesn't exist
    }

    return { poolData, farmingMetrics };
  }

  async exportToCSV() {
    const today = new Date().toISOString().split('T')[0];
    const { poolData, farmingMetrics } = await this.getLatestData();

    // Export pool data to CSV
    if (poolData.length > 0) {
      const poolCsvPath = path.join(this.dataDir, `pool-data-${today}.csv`);
      const poolCsvHeader =
        'timestamp,datetime,poolAddress,currentPrice,liquidity,tick,feeTier,tickSpacing,feeGrowth0,feeGrowth1,price0to1,price1to0\n';
      const poolCsvRows = poolData
        .map((data) => {
          const datetime = new Date(data.timestamp).toISOString();
          return `${data.timestamp},${datetime},${data.poolAddress},${
            data.currentPrice
          },${data.liquidity},${data.tick},${data.feeTier},${
            data.tickSpacing || ''
          },${data.feeGrowth0 || ''},${data.feeGrowth1 || ''},${
            data.price0to1 || ''
          },${data.price1to0 || ''}`;
        })
        .join('\n');

      await fs.writeFile(poolCsvPath, poolCsvHeader + poolCsvRows);
      console.log(`📊 Pool data exported to CSV: ${poolCsvPath}`);
    }

    // Export farming metrics to CSV
    if (farmingMetrics.length > 0) {
      const farmingCsvPath = path.join(
        this.dataDir,
        `farming-metrics-${today}.csv`
      );
      const farmingCsvHeader =
        'timestamp,datetime,poolAddress,currentPrice,lowerPrice,upperPrice,liquidity,fees,impermanentLoss,totalReturn,optimalLower,optimalUpper,optimalReason,tickLower,tickUpper,positionValue,liquidityUtilization\n';
      const farmingCsvRows = farmingMetrics
        .map((metrics) => {
          const datetime = new Date(metrics.timestamp).toISOString();
          return `${metrics.timestamp},${datetime},${metrics.poolAddress},${
            metrics.priceRange.current
          },${metrics.priceRange.lower},${metrics.priceRange.upper},${
            metrics.liquidity
          },${metrics.fees},${metrics.impermanentLoss},${metrics.totalReturn},${
            metrics.optimalRange?.lower || ''
          },${metrics.optimalRange?.upper || ''},${
            metrics.optimalRange?.reason || ''
          },${metrics.tickLower || ''},${metrics.tickUpper || ''},${
            metrics.positionValue || ''
          },${metrics.liquidityUtilization || ''}`;
        })
        .join('\n');

      await fs.writeFile(farmingCsvPath, farmingCsvHeader + farmingCsvRows);
      console.log(`🌾 Farming metrics exported to CSV: ${farmingCsvPath}`);
    }
  }
}
