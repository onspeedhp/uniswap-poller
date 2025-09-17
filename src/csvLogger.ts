import { writeFileSync, existsSync, mkdirSync, appendFileSync } from 'fs';
import { join } from 'path';
import { config } from './config.js';
import type {
  BinEdgeAnalysis,
  APRCalculation,
  ImpermanentLossAnalysis,
} from './mathUtils.js';

// ==================== DATA INTERFACES ====================

export interface BinChangeData {
  timestamp: string;
  blockNumber: number;
  transactionHash?: string;

  // Price & Tick Data
  tick: number;
  sqrtPriceX96: string;
  price: number;
  liquidity: string;

  // Bin Change Details
  fromBin: number;
  toBin: number;
  binChangeDirection: 'up' | 'down';
  ticksChanged: number;
  priceChangePercentage: number;

  // Timing Analysis
  timeSinceLastBinChange: number; // seconds
  binDuration: number; // how long price stayed in previous bin

  // Market Context
  volume?: number;
  gasPrice?: number;
  blockTimestamp: number;
}

export interface LPOpportunityData {
  timestamp: string;
  blockNumber: number;

  // Current State
  currentTick: number;
  currentPrice: number;
  currentBin: number;

  // Edge Analysis
  distanceToLowerEdgePct: number;
  distanceToUpperEdgePct: number;
  nearestEdgeSide: 'lower' | 'upper';
  nearestEdgeDistancePct: number;

  // Risk Assessment
  riskLevel: 'danger' | 'warning' | 'safe' | 'optimal';
  riskDescription: string;
  lpRecommendation: 'avoid' | 'caution' | 'add' | 'excellent';

  // Price Ranges
  binLowerPrice: number;
  binUpperPrice: number;

  // Market Conditions
  liquidity: string;
  volume24h?: number;
  fees24h?: number;

  // Opportunity Score (0-100)
  opportunityScore: number;
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

  // Complete Bin Analysis
  binAnalysis: BinEdgeAnalysis;

  // APR Analysis
  aprAnalysis?: APRCalculation;

  // IL Analysis
  impermanentLoss?: ImpermanentLossAnalysis;

  // Additional Context
  eventType?: string; // 'bin_change', 'lp_opportunity', 'price_alert', etc.
  severity?: 'info' | 'warning' | 'critical';
}

// ==================== MULTI-CSV LOGGER CLASS ====================

export class LPFarmingLogger {
  private outputDir: string;
  private binChangesPath: string;
  private lpOpportunitiesPath: string;
  private aprTrackingPath: string;
  private detailedDataPath: string;

  // Headers for each CSV file
  private binChangesHeaders = [
    'timestamp',
    'blockNumber',
    'transactionHash',
    'tick',
    'sqrtPriceX96',
    'price',
    'liquidity',
    'fromBin',
    'toBin',
    'binChangeDirection',
    'ticksChanged',
    'priceChangePercentage',
    'timeSinceLastBinChange',
    'binDuration',
    'volume',
    'gasPrice',
    'blockTimestamp',
  ];

  private lpOpportunitiesHeaders = [
    'timestamp',
    'blockNumber',
    'currentTick',
    'currentPrice',
    'currentBin',
    'distanceToLowerEdgePct',
    'distanceToUpperEdgePct',
    'nearestEdgeSide',
    'nearestEdgeDistancePct',
    'riskLevel',
    'riskDescription',
    'lpRecommendation',
    'binLowerPrice',
    'binUpperPrice',
    'liquidity',
    'volume24h',
    'fees24h',
    'opportunityScore',
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
    'currentBin',
    'binLowerTick',
    'binUpperTick',
    'priceAtBinLower',
    'priceAtBinUpper',
    'distanceToLowerEdgePct',
    'distanceToUpperEdgePct',
    'nearestEdgeSide',
    'nearestEdgeDistancePct',
    'riskLevel',
    'riskDescription',
    'lpRecommendation',
    'eventType',
    'severity',
  ];

  constructor() {
    this.outputDir = config.CSV_OUTPUT_DIR;
    this.ensureOutputDirectory();

    // Initialize file paths
    this.binChangesPath = join(this.outputDir, config.BIN_CHANGES_CSV);
    this.lpOpportunitiesPath = join(
      this.outputDir,
      config.LP_OPPORTUNITIES_CSV
    );
    this.aprTrackingPath = join(this.outputDir, config.APR_TRACKING_CSV);
    this.detailedDataPath = join(this.outputDir, 'detailed_pool_data.csv');

    // Initialize all CSV files
    this.initializeCSVFiles();
  }

  private ensureOutputDirectory(): void {
    if (!existsSync(this.outputDir)) {
      mkdirSync(this.outputDir, { recursive: true });
      console.log(`📁 Created output directory: ${this.outputDir}`);
    }
  }

  private initializeCSVFiles(): void {
    this.initializeCSV(
      this.binChangesPath,
      this.binChangesHeaders,
      'Bin Changes'
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
    if (!existsSync(filePath)) {
      const headerRow = headers.join(',') + '\n';
      writeFileSync(filePath, headerRow);
      console.log(`📊 ${name} CSV initialized: ${filePath}`);
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
    const row = headers
      .map((header) => this.formatValue(data[header]))
      .join(',');

    appendFileSync(filePath, row + '\n');
  }

  // ==================== LOGGING METHODS ====================

  /**
   * Log bin change event
   */
  public logBinChange(data: BinChangeData): void {
    this.writeCSVRow(this.binChangesPath, this.binChangesHeaders, data);

    const direction = data.binChangeDirection === 'up' ? '📈' : '📉';
    console.log(
      `🔄 BIN CHANGE: ${data.fromBin} → ${data.toBin} ${direction} | ` +
        `Price: ${data.price.toFixed(6)} | Duration: ${data.binDuration}s`
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

    console.log(
      `${emoji} LP OPPORTUNITY: ${data.riskLevel.toUpperCase()} | ` +
        `Score: ${score}/100 | Distance to edge: ${(
          data.nearestEdgeDistancePct * 100
        ).toFixed(1)}%`
    );
    console.log(`   💡 ${data.riskDescription}`);
  }

  /**
   * Log APR tracking data
   */
  public logAPRTracking(data: APRTrackingData): void {
    this.writeCSVRow(this.aprTrackingPath, this.aprTrackingHeaders, data);

    console.log(
      `💰 APR UPDATE: Current ${data.currentAPR.toFixed(2)}% | ` +
        `Projected ${data.projectedAPR.toFixed(2)}% | ` +
        `Confidence: ${data.aprConfidence.toUpperCase()}`
    );
  }

  /**
   * Log detailed pool data (for comprehensive analysis)
   */
  public logDetailedData(data: DetailedPoolData): void {
    // Flatten nested objects for CSV
    const flatData = {
      ...data,
      // Flatten bin analysis
      currentBin: data.binAnalysis.currentBin,
      binLowerTick: data.binAnalysis.binLowerTick,
      binUpperTick: data.binAnalysis.binUpperTick,
      priceAtBinLower: data.binAnalysis.priceAtBinLower,
      priceAtBinUpper: data.binAnalysis.priceAtBinUpper,
      distanceToLowerEdgePct: data.binAnalysis.distanceToLowerEdgePct,
      distanceToUpperEdgePct: data.binAnalysis.distanceToUpperEdgePct,
      nearestEdgeSide: data.binAnalysis.nearestEdgeSide,
      nearestEdgeDistancePct: data.binAnalysis.nearestEdgeDistancePct,
      riskLevel: data.binAnalysis.riskLevel,
      riskDescription: data.binAnalysis.riskDescription,
      lpRecommendation: data.binAnalysis.lpRecommendation,
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
    console.log(`   🔄 Bin Changes: ${this.binChangesPath}`);
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
    volatility: number = 0
  ): number {
    let score = 0;

    // Edge distance score (0-40 points)
    if (edgeDistancePct <= 0.1) {
      score += 0; // Too risky
    } else if (edgeDistancePct <= 0.2) {
      score += 10; // Risky
    } else if (edgeDistancePct <= 0.35) {
      score += 30; // Good
    } else {
      score += 40; // Excellent
    }

    // APR score (0-30 points)
    if (aprData) {
      if (aprData.currentAPR >= 100) score += 30;
      else if (aprData.currentAPR >= 50) score += 25;
      else if (aprData.currentAPR >= 20) score += 20;
      else if (aprData.currentAPR >= 10) score += 15;
      else score += 5;
    }

    // Volume score (0-20 points)
    if (volume24h >= 1000000) score += 20; // $1M+
    else if (volume24h >= 100000) score += 15; // $100K+
    else if (volume24h >= 10000) score += 10; // $10K+
    else score += 5;

    // Volatility penalty (0-10 points deduction)
    if (volatility > 0.5) score -= 10; // Very volatile
    else if (volatility > 0.3) score -= 5; // Moderately volatile

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
