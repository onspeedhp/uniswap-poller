import {
  writeFileSync,
  existsSync,
  mkdirSync,
  appendFileSync,
  accessSync,
  chmodSync,
  readFileSync,
  constants,
} from 'fs';
import { join } from 'path';
import { config } from './config.js';
import type {
  TickRangeAnalysis,
  APRCalculation,
  ImpermanentLossAnalysis,
} from './mathUtils.js';

// ==================== DATA INTERFACES ====================

export interface TickChangeData {
  timestamp: string;
  blockNumber: number;
  transactionHash?: string;

  // Price & Tick Data
  tick: number;
  sqrtPriceX96: string;
  price: number;
  liquidity: string;

  // Tick Change Details
  fromTick: number;
  toTick: number;
  tickChangeDirection: 'up' | 'down';
  ticksChanged: number;
  priceChangePercentage: number;

  // Timing Analysis
  timeSinceLastTickChange: number; // seconds
  tickRangeDuration: number; // how long price stayed in previous tick range

  // Market Context
  volume?: number;
  gasPrice?: number;
  blockTimestamp: number;

  // Additional metrics
  tickRange: number; // Price range of the tick range
  currentPriceInRange: number; // Position within tick range (0-1)
}

export interface LPOpportunityData {
  timestamp: string;
  blockNumber: number;

  // Current State
  currentTick: number;
  currentPrice: number;
  currentTickRange: number;

  // Tick Range Analysis
  distanceToLowerTickPct: number;
  distanceToUpperTickPct: number;
  nearestTickSide: 'lower' | 'upper';
  nearestTickDistancePct: number;

  // Risk Assessment
  riskLevel: 'danger' | 'warning' | 'safe' | 'optimal';
  riskDescription: string;
  lpRecommendation: 'avoid' | 'caution' | 'add' | 'excellent';

  // Price Ranges
  tickLowerPrice: number;
  tickUpperPrice: number;
  tickRange: number;
  currentPriceInRange: number;

  // Market Conditions
  liquidity: string;
  volume24h?: number;
  fees24h?: number;
  totalValueLocked?: number;

  // Opportunity Score (0-100)
  opportunityScore: number;

  // Additional metrics
  priceVolatility?: number;
  tickRangeDuration?: number;
}

export interface APRTrackingData {
  timestamp: string;
  date: string; // YYYY-MM-DD for daily tracking

  // APR Metrics
  currentAPR: number;
  projectedAPR: number;
  feeAPR: number;
  averageAPR7d?: number;
  averageAPR30d?: number;

  // Volume & Fees
  volume24h: number;
  fees24h: number;
  totalValueLocked: number;
  volumeToTVLRatio: number;

  // Confidence & Market
  aprConfidence: 'low' | 'medium' | 'high';
  priceVolatility?: number;
  dailyFeeRate: number;
  annualFeeRate: number;

  // Notes
  notes?: string;
}

export interface DetailedPoolData {
  timestamp: string;
  blockNumber: number;

  // Basic Pool State
  tick: number;
  sqrtPriceX96: string;
  price: number;
  liquidity: string;

  // Token Info
  token0Symbol: string;
  token1Symbol: string;
  token0Address: string;
  token1Address: string;

  // Complete Tick Range Analysis
  tickRangeAnalysis: TickRangeAnalysis;

  // APR Analysis
  aprAnalysis?: APRCalculation;

  // IL Analysis
  impermanentLoss?: ImpermanentLossAnalysis;

  // Additional Context
  eventType?: string; // 'tick_change', 'lp_opportunity', 'price_alert', etc.
  severity?: 'info' | 'warning' | 'critical';

  // Market metrics
  volume24h?: number;
  fees24h?: number;
  totalValueLocked?: number;
  priceVolatility?: number;
}

// ==================== MULTI-CSV LOGGER CLASS ====================

export class LPFarmingLogger {
  private outputDir: string;
  private tickChangesPath: string;
  private lpOpportunitiesPath: string;
  private aprTrackingPath: string;
  private detailedDataPath: string;

  // Headers for each CSV file
  private tickChangesHeaders = [
    'timestamp',
    'blockNumber',
    'transactionHash',
    'tick',
    'sqrtPriceX96',
    'price',
    'liquidity',
    'fromTick',
    'toTick',
    'tickChangeDirection',
    'ticksChanged',
    'priceChangePercentage',
    'timeSinceLastTickChange',
    'tickRangeDuration',
    'volume',
    'gasPrice',
    'blockTimestamp',
    'tickRange',
    'currentPriceInRange',
  ];

  private lpOpportunitiesHeaders = [
    'timestamp',
    'blockNumber',
    'currentTick',
    'currentPrice',
    'currentTickRange',
    'distanceToLowerTickPct',
    'distanceToUpperTickPct',
    'nearestTickSide',
    'nearestTickDistancePct',
    'riskLevel',
    'riskDescription',
    'lpRecommendation',
    'tickLowerPrice',
    'tickUpperPrice',
    'tickRange',
    'currentPriceInRange',
    'liquidity',
    'volume24h',
    'fees24h',
    'totalValueLocked',
    'opportunityScore',
    'priceVolatility',
    'tickRangeDuration',
  ];

  private aprTrackingHeaders = [
    'timestamp',
    'date',
    'currentAPR',
    'projectedAPR',
    'feeAPR',
    'averageAPR7d',
    'averageAPR30d',
    'volume24h',
    'fees24h',
    'totalValueLocked',
    'volumeToTVLRatio',
    'aprConfidence',
    'priceVolatility',
    'dailyFeeRate',
    'annualFeeRate',
    'notes',
  ];

  private detailedDataHeaders = [
    'timestamp',
    'blockNumber',
    'tick',
    'sqrtPriceX96',
    'price',
    'liquidity',
    'token0Symbol',
    'token1Symbol',
    'token0Address',
    'token1Address',
    'currentTick',
    'activeTickLower',
    'activeTickUpper',
    'priceAtTickLower',
    'priceAtTickUpper',
    'distanceToLowerTickPct',
    'distanceToUpperTickPct',
    'nearestTickSide',
    'nearestTickDistancePct',
    'riskLevel',
    'riskDescription',
    'lpRecommendation',
    'tickRange',
    'currentPriceInRange',
    'eventType',
    'severity',
    'volume24h',
    'fees24h',
    'totalValueLocked',
    'priceVolatility',
  ];

  constructor() {
    this.outputDir = config.DATA_DIR;
    this.ensureOutputDirectory();

    // Initialize file paths
    this.tickChangesPath = join(this.outputDir, config.TICK_CHANGES_CSV);
    this.lpOpportunitiesPath = join(
      this.outputDir,
      config.LP_OPPORTUNITIES_CSV
    );
    this.aprTrackingPath = join(this.outputDir, config.APR_TRACKING_CSV);
    this.detailedDataPath = join(this.outputDir, config.DETAILED_POOL_DATA_CSV);

    // Initialize all CSV files
    this.initializeCSVFiles();

    // Verify all files are accessible
    this.verifyCSVFiles();
  }

  private ensureOutputDirectory(): void {
    if (!existsSync(this.outputDir)) {
      mkdirSync(this.outputDir, { recursive: true });
      console.log(`📁 Created output directory: ${this.outputDir}`);
    }
  }

  private verifyCSVFiles(): void {
    const files = [
      { path: this.tickChangesPath, name: 'Tick Changes' },
      { path: this.lpOpportunitiesPath, name: 'LP Opportunities' },
      { path: this.aprTrackingPath, name: 'APR Tracking' },
      { path: this.detailedDataPath, name: 'Detailed Pool Data' },
    ];

    for (const file of files) {
      try {
        if (!existsSync(file.path)) {
          console.log(
            `⚠️ ${file.name} CSV file missing, creating: ${file.path}`
          );
          // Recreate the file
          const headers = this.getHeadersForFile(file.path);
          const headerRow = headers.join(',') + '\n';
          writeFileSync(file.path, headerRow);
        } else {
          // Test if file is writable
          try {
            accessSync(file.path, constants.W_OK);
          } catch (accessError) {
            console.log(
              `⚠️ ${file.name} CSV file not writable, fixing permissions: ${file.path}`
            );
            // Try to fix permissions
            try {
              chmodSync(file.path, 0o644);
            } catch (chmodError) {
              console.error(
                `❌ Could not fix permissions for ${file.path}:`,
                chmodError
              );
            }
          }
        }
      } catch (error) {
        console.error(`❌ Error verifying ${file.name} CSV file:`, error);
      }
    }
  }

  private getHeadersForFile(filePath: string): string[] {
    if (filePath === this.tickChangesPath) return this.tickChangesHeaders;
    if (filePath === this.lpOpportunitiesPath)
      return this.lpOpportunitiesHeaders;
    if (filePath === this.aprTrackingPath) return this.aprTrackingHeaders;
    if (filePath === this.detailedDataPath) return this.detailedDataHeaders;
    return [];
  }

  private initializeCSVFiles(): void {
    this.initializeCSV(
      this.tickChangesPath,
      this.tickChangesHeaders,
      'Tick Changes'
    );
    this.initializeCSV(
      this.lpOpportunitiesPath,
      this.lpOpportunitiesHeaders,
      'LP Opportunities'
    );
    this.initializeCSV(
      this.aprTrackingPath,
      this.aprTrackingHeaders,
      'APR Tracking'
    );
    this.initializeCSV(
      this.detailedDataPath,
      this.detailedDataHeaders,
      'Detailed Pool Data'
    );
  }

  private initializeCSV(
    filePath: string,
    headers: string[],
    name: string
  ): void {
    try {
      if (!existsSync(filePath)) {
        const headerRow = headers.join(',') + '\n';
        writeFileSync(filePath, headerRow);
        console.log(`📊 ${name} CSV initialized: ${filePath}`);
      } else {
        // Verify the file is readable and has proper headers
        try {
          const content = readFileSync(filePath, 'utf8');
          if (!content.trim()) {
            // File exists but is empty, add headers
            const headerRow = headers.join(',') + '\n';
            writeFileSync(filePath, headerRow);
            console.log(
              `📊 ${name} CSV headers added to empty file: ${filePath}`
            );
          }
        } catch (readError) {
          // File might be corrupted, recreate it
          console.log(
            `⚠️ ${name} CSV file appears corrupted, recreating: ${filePath}`
          );
          const headerRow = headers.join(',') + '\n';
          writeFileSync(filePath, headerRow);
          console.log(`📊 ${name} CSV recreated: ${filePath}`);
        }
      }
    } catch (error) {
      console.error(
        `❌ Failed to initialize ${name} CSV file ${filePath}:`,
        error
      );
      // Try to create with a different approach
      try {
        const headerRow = headers.join(',') + '\n';
        writeFileSync(filePath, headerRow, { mode: 0o644 });
        console.log(`📊 ${name} CSV created with fallback method: ${filePath}`);
      } catch (fallbackError) {
        console.error(
          `❌ Complete failure to create ${name} CSV file:`,
          fallbackError
        );
      }
    }
  }

  private formatValue(value: any): string {
    if (value === undefined || value === null) {
      return '';
    }

    // Handle objects (convert to JSON string)
    if (typeof value === 'object') {
      value = JSON.stringify(value);
    }

    // Escape commas and quotes in string values
    const stringValue = String(value);
    if (
      stringValue.includes(',') ||
      stringValue.includes('"') ||
      stringValue.includes('\n')
    ) {
      return `"${stringValue.replace(/"/g, '""')}"`;
    }
    return stringValue;
  }

  private writeCSVRow(filePath: string, headers: string[], data: any): void {
    try {
      // Ensure the file exists before trying to append
      if (!existsSync(filePath)) {
        const headerRow = headers.join(',') + '\n';
        writeFileSync(filePath, headerRow);
        console.log(`📊 CSV file created: ${filePath}`);
      }

      const row = headers
        .map((header) => this.formatValue(data[header]))
        .join(',');

      appendFileSync(filePath, row + '\n');
    } catch (error) {
      console.error(`❌ Error writing to CSV file ${filePath}:`, error);
      // Try to recreate the file if it's corrupted
      try {
        const headerRow = headers.join(',') + '\n';
        writeFileSync(filePath, headerRow);
        console.log(`📊 Recreated CSV file: ${filePath}`);

        // Retry writing the data
        const row = headers
          .map((header) => this.formatValue(data[header]))
          .join(',');
        appendFileSync(filePath, row + '\n');
      } catch (retryError) {
        console.error(
          `❌ Failed to recreate CSV file ${filePath}:`,
          retryError
        );
      }
    }
  }

  // ==================== LOGGING METHODS ====================

  /**
   * Log tick change event
   */
  public logTickChange(data: TickChangeData): void {
    this.writeCSVRow(this.tickChangesPath, this.tickChangesHeaders, data);

    const direction = data.tickChangeDirection === 'up' ? '📈' : '📉';
    const duration =
      data.tickRangeDuration > 0 ? `${data.tickRangeDuration}s` : 'N/A';
    console.log(
      `🔄 TICK CHANGE: ${data.fromTick} → ${data.toTick} ${direction} | ` +
        `Price: ${data.price.toFixed(6)} | Duration: ${duration} | ` +
        `Tick Range: ${data.tickRange.toFixed(6)} | Position: ${(
          data.currentPriceInRange * 100
        ).toFixed(1)}%`
    );
  }

  /**
   * Log LP opportunity
   */
  public logLPOpportunity(data: LPOpportunityData): void {
    this.writeCSVRow(
      this.lpOpportunitiesPath,
      this.lpOpportunitiesHeaders,
      data
    );

    const emoji = this.getRiskEmoji(data.riskLevel);
    const score = data.opportunityScore;
    const distance = (data.nearestTickDistancePct * 100).toFixed(1);
    const position = (data.currentPriceInRange * 100).toFixed(1);

    console.log(
      `${emoji} LP OPPORTUNITY: ${data.riskLevel.toUpperCase()} | ` +
        `Score: ${score}/100 | Distance to tick boundary: ${distance}% | ` +
        `Position in tick range: ${position}%`
    );
    console.log(`   💡 ${data.riskDescription}`);

    if (data.priceVolatility !== undefined) {
      console.log(
        `   📊 Price Volatility: ${(data.priceVolatility * 100).toFixed(2)}%`
      );
    }
    if (data.tickRangeDuration !== undefined) {
      console.log(`   ⏱️  Tick Range Duration: ${data.tickRangeDuration}s`);
    }
  }

  /**
   * Log APR tracking data
   */
  public logAPRTracking(data: APRTrackingData): void {
    this.writeCSVRow(this.aprTrackingPath, this.aprTrackingHeaders, data);

    console.log(
      `💰 APR UPDATE: Current ${data.currentAPR.toFixed(2)}% | ` +
        `Projected ${data.projectedAPR.toFixed(2)}% | ` +
        `Confidence: ${data.aprConfidence.toUpperCase()} | ` +
        `Volume/TVL: ${(data.volumeToTVLRatio * 100).toFixed(2)}%`
    );

    if (data.priceVolatility !== undefined) {
      console.log(
        `   📊 Price Volatility: ${(data.priceVolatility * 100).toFixed(2)}%`
      );
    }
  }

  /**
   * Log detailed pool data (for comprehensive analysis)
   */
  public logDetailedData(data: DetailedPoolData): void {
    // Flatten nested objects for CSV
    const flatData = {
      ...data,
      // Flatten tick range analysis
      currentTick: data.tickRangeAnalysis.currentTick,
      activeTickLower: data.tickRangeAnalysis.activeTickLower,
      activeTickUpper: data.tickRangeAnalysis.activeTickUpper,
      priceAtTickLower: data.tickRangeAnalysis.priceAtTickLower,
      priceAtTickUpper: data.tickRangeAnalysis.priceAtTickUpper,
      distanceToLowerTickPct: data.tickRangeAnalysis.distanceToLowerTickPct,
      distanceToUpperTickPct: data.tickRangeAnalysis.distanceToUpperTickPct,
      nearestTickSide: data.tickRangeAnalysis.nearestTickSide,
      nearestTickDistancePct: data.tickRangeAnalysis.nearestTickDistancePct,
      riskLevel: data.tickRangeAnalysis.riskLevel,
      riskDescription: data.tickRangeAnalysis.riskDescription,
      lpRecommendation: data.tickRangeAnalysis.lpRecommendation,
      tickRange: data.tickRangeAnalysis.tickRange,
      currentPriceInRange: data.tickRangeAnalysis.currentPriceInRange,
    };

    this.writeCSVRow(this.detailedDataPath, this.detailedDataHeaders, flatData);
  }

  /**
   * Log general event with timestamp
   */
  public logEvent(eventType: string, message: string, data?: any): void {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${eventType}: ${message}`);

    if (data) {
      console.log('   Data:', JSON.stringify(data, null, 2));
    }
  }

  // ==================== UTILITY METHODS ====================

  private getRiskEmoji(riskLevel: string): string {
    switch (riskLevel) {
      case 'danger':
        return '🚨';
      case 'warning':
        return '⚠️';
      case 'safe':
        return '✅';
      case 'optimal':
        return '🎯';
      default:
        return 'ℹ️';
    }
  }

  /**
   * Get summary of all logged data
   */
  public getLogSummary(): void {
    console.log('\n📊 LP Farming Data Summary:');
    console.log(`   📁 Output Directory: ${this.outputDir}`);
    console.log(`   🔄 Tick Changes: ${this.tickChangesPath}`);
    console.log(`   💰 LP Opportunities: ${this.lpOpportunitiesPath}`);
    console.log(`   📈 APR Tracking: ${this.aprTrackingPath}`);
    console.log(`   📋 Detailed Data: ${this.detailedDataPath}`);
  }

  /**
   * Calculate opportunity score based on multiple factors
   */
  public static calculateOpportunityScore(
    edgeDistancePct: number,
    aprData?: APRCalculation,
    volume24h: number = 0,
    volatility: number = 0,
    tickRangeDuration?: number
  ): number {
    let score = 0;

    // Edge distance score (0-40 points) - Most important factor
    if (edgeDistancePct <= 0.1) {
      score += 0; // DANGEROUS - Too risky
    } else if (edgeDistancePct <= 0.2) {
      score += 10; // WARNING - Risky
    } else if (edgeDistancePct <= 0.3) {
      score += 25; // SAFE - Good
    } else {
      score += 40; // OPTIMAL - Excellent
    }

    // APR score (0-25 points)
    if (aprData) {
      if (aprData.currentAPR >= 100) score += 25;
      else if (aprData.currentAPR >= 50) score += 20;
      else if (aprData.currentAPR >= 20) score += 15;
      else if (aprData.currentAPR >= 10) score += 10;
      else if (aprData.currentAPR >= 5) score += 5;
      else score += 0;
    }

    // Volume score (0-20 points)
    if (volume24h >= 1000000) score += 20; // $1M+ - Very high volume
    else if (volume24h >= 100000) score += 15; // $100K+ - High volume
    else if (volume24h >= 10000) score += 10; // $10K+ - Medium volume
    else if (volume24h >= 1000) score += 5; // $1K+ - Low volume
    else score += 0; // Very low volume

    // Tick range duration bonus (0-10 points)
    if (tickRangeDuration !== undefined) {
      if (tickRangeDuration >= 3600) score += 10; // 1+ hours - Very stable
      else if (tickRangeDuration >= 1800) score += 7; // 30+ minutes - Stable
      else if (tickRangeDuration >= 600)
        score += 5; // 10+ minutes - Somewhat stable
      else if (tickRangeDuration >= 60)
        score += 2; // 1+ minute - Basic stability
      else score += 0; // Very unstable
    }

    // Volatility penalty (0-15 points deduction)
    if (volatility > 0.1) score -= 15; // Very volatile (>10%)
    else if (volatility > 0.05) score -= 10; // High volatility (5-10%)
    else if (volatility > 0.02) score -= 5; // Medium volatility (2-5%)
    // Low volatility (<2%) - no penalty

    return Math.max(0, Math.min(100, score));
  }
}

// Export legacy interface for compatibility
export class CSVLogger extends LPFarmingLogger {
  public log(data: any): void {
    // Convert old format to new detailed data format if needed
    console.log(
      '⚠️ Using legacy CSVLogger.log() - consider using specific logging methods'
    );
  }
}
