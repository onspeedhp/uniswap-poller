import 'dotenv/config';
import {
  createPublicClient,
  http,
  webSocket,
  parseAbi,
  type Address,
  type PublicClient,
  type Log,
  type Chain,
} from 'viem';
import { config } from './config.js';
import {
  LPFarmingLogger,
  type TickChangeData,
  type LPOpportunityData,
  type APRTrackingData,
  type DetailedPoolData,
} from './csvLogger.js';
import {
  price1Per0FromSqrt,
  price1Per0FromSqrtPrecise,
  analyzeTickRange,
  calculateAPRFromHistory,
  calculatePriceVolatility,
  calculateTickRangeDurationStats,
  formatDuration,
  type TickRangeAnalysis,
} from './mathUtils.js';
import { UNISWAP_V3_POOL_ABI, SWAP_EVENT_ABI } from './constants.js';
import { UniswapV3PoolFetcher, type PoolData } from './poolFetcher.js';

// ==================== KATANA NETWORK CONFIGURATION ====================

const KATANA_CHAIN: Chain = {
  id: config.CHAIN_ID,
  name: config.CHAIN_NAME,
  nativeCurrency: { name: 'Ethereum', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: {
      http: [config.RPC_HTTP],
      webSocket: config.RPC_WS ? [config.RPC_WS] : undefined,
    },
  },
  blockExplorers: {
    default: {
      name: 'Katana Explorer',
      url: 'https://explorer.katana.network',
    },
  },
  testnet: false,
} as const;

// ==================== UNISWAP V3 ABIS ====================
// Using shared ABIs from constants.ts

// ==================== LP FARMING MONITOR CLASS ====================

export class LPFarmingMonitor {
  private client: PublicClient;
  private logger: LPFarmingLogger;
  private poolFetcher: UniswapV3PoolFetcher;
  private poolAddress: Address;

  // Pool configuration
  private token0Address: Address;
  private token1Address: Address;
  private fee: number;
  private tickSpacing: number;
  private token0Decimals: number;
  private token1Decimals: number;
  private token0Symbol: string;
  private token1Symbol: string;
  private poolData?: PoolData;

  // Tick tracking state
  private currentTick?: number;
  private previousTick?: number;
  private lastTickChangeTimestamp?: number;
  private currentPrecisePrice?: string;
  private currentTickRangeAnalysis?: TickRangeAnalysis;
  private tickHistory: Array<{
    tick: number;
    timestamp: number;
    price: number;
  }> = [];
  private tickRangeDurations: number[] = [];

  // Market data tracking
  private priceHistory: Array<{ price: number; timestamp: number }> = [];
  private volumeHistory: Array<{ volume: number; timestamp: number }> = [];
  private totalValueLocked: number = 0;

  // Performance tracking
  private monitorStartTime: number;
  private lastAPRUpdate: number = 0;
  private consecutiveSafeOpportunities: number = 0;

  // Dashboard state
  private dashboardInterval?: NodeJS.Timeout;
  private analysisInterval?: NodeJS.Timeout;
  private aprInterval?: NodeJS.Timeout;

  constructor() {
    this.client = this.createClient();
    this.logger = new LPFarmingLogger();
    this.poolAddress = config.POOL;
    this.poolFetcher = new UniswapV3PoolFetcher(this.client, this.poolAddress);
    this.monitorStartTime = Date.now();

    // Initialize pool configuration
    this.token0Address = config.TOKEN0_ADDRESS;
    this.token1Address = config.TOKEN1_ADDRESS;
    this.fee = config.FEE_TIER;
    this.tickSpacing = config.TICK_SPACING;
    this.token0Decimals = 6; // USDC decimals
    this.token1Decimals = 18; // WETH decimals
    this.token0Symbol = 'USDC';
    this.token1Symbol = 'WETH';
  }

  private createClient(): PublicClient {
    return createPublicClient({
      chain: KATANA_CHAIN,
      transport: config.RPC_WS
        ? webSocket(config.RPC_WS, {
            timeout: 15000,
            retryCount: 3,
          })
        : http(config.RPC_HTTP, {
            timeout: 15000,
            retryCount: 3,
          }),
    });
  }

  private async testConnection(): Promise<boolean> {
    const rpcUrls = Array.isArray(KATANA_CHAIN.rpcUrls.default.http)
      ? KATANA_CHAIN.rpcUrls.default.http
      : [KATANA_CHAIN.rpcUrls.default.http];

    for (let i = 0; i < rpcUrls.length; i++) {
      try {
        console.log(
          `🔗 Testing connection to ${KATANA_CHAIN.name} (${i + 1}/${
            rpcUrls.length
          })...`
        );

        // Create temporary client with this RPC
        const tempClient = createPublicClient({
          chain: KATANA_CHAIN,
          transport: http(rpcUrls[i], {
            timeout: 10000,
            retryCount: 1,
          }),
        });

        const blockNumber = await tempClient.getBlockNumber();
        console.log(`✅ Connected successfully! Latest block: ${blockNumber}`);

        // Update main client to use working RPC
        this.client = tempClient;
        return true;
      } catch (error) {
        console.log(
          `❌ RPC ${i + 1} failed:`,
          error instanceof Error ? error.message : error
        );
        if (i === rpcUrls.length - 1) {
          console.log(
            `❌ All ${rpcUrls.length} RPC endpoints failed for ${KATANA_CHAIN.name}`
          );
        }
      }
    }
    return false;
  }

  async initialize(): Promise<void> {
    console.log('🎯 Initializing LP Farming Monitor for Katana Network...');

    // Test connection
    const connectionSuccessful = await this.testConnection();
    if (!connectionSuccessful) {
      throw new Error('❌ Failed to connect to Katana RPC');
    }

    try {
      // Test pool contract access
      await this.testPoolContract();

      // Load complete pool data with all ticks
      this.poolData = await this.poolFetcher.fetchPoolData();

      await this.initializeHistoricalData();
      this.logger.getLogSummary();

      console.log('✅ LP Farming Monitor initialized successfully!');
      console.log(`🌐 Network: ${KATANA_CHAIN.name}`);
      console.log(`🎯 Target Pool: ${this.token0Symbol}/${this.token1Symbol}`);
      console.log(`💰 Fee Tier: ${this.fee / 10000}%`);
      console.log(`📏 Tick Spacing: ${this.tickSpacing}`);
      console.log(`📍 Pool Address: ${this.poolAddress}`);
      console.log(`📊 Total Ticks: ${this.poolData.allTicks.length}`);
    } catch (error) {
      console.error('❌ Pool configuration failed:', error);
      throw error;
    }
  }

  private async testPoolContract(): Promise<void> {
    try {
      console.log('🔍 Testing pool contract access...');

      // Test slot0 function
      const slot0 = (await this.client.readContract({
        address: this.poolAddress,
        abi: parseAbi(UNISWAP_V3_POOL_ABI),
        functionName: 'slot0',
      })) as [bigint, number, number, number, number, number, boolean];

      console.log('✅ Pool contract accessible');
      console.log(`   Current tick: ${slot0[1]}`);
      console.log(`   Sqrt price: ${slot0[0].toString()}`);
    } catch (error) {
      console.error('❌ Pool contract test failed:', error);
      throw new Error(
        'Failed to access pool contract. Please check the pool address.'
      );
    }
  }

  private async initializeHistoricalData(): Promise<void> {
    console.log('📊 Initializing historical data...');

    try {
      // Get current pool state using pool fetcher
      const currentState = await this.poolFetcher.getCurrentPoolState();
      const currentPrice = price1Per0FromSqrt(
        currentState.sqrtPriceX96,
        this.token0Decimals,
        this.token1Decimals
      );

      // Initialize tracking with current tick
      this.currentTick = currentState.currentTick;
      this.lastTickChangeTimestamp = Math.floor(Date.now() / 1000);

      // Add to history
      const timestamp = Date.now();
      this.tickHistory.push({
        tick: currentState.currentTick,
        timestamp,
        price: currentPrice,
      });
      this.priceHistory.push({ price: currentPrice, timestamp });

      console.log(
        `✅ Initialized at tick ${
          currentState.currentTick
        }, price ${currentPrice.toFixed(6)}`
      );
    } catch (error) {
      console.error('❌ Failed to initialize historical data:', error);
      // Continue without historical data
    }
  }

  startMonitoring(): void {
    console.log('\n🎯 Starting Advanced LP Farming Monitor...');
    console.log('📊 Data collection includes:');
    console.log('   🔄 Detailed tick changes (from tick to tick)');
    console.log('   📏 Distance to left and right tick boundaries');
    console.log('   💰 APR calculation and tracking');
    console.log('   🎯 LP opportunity scoring (0-100)');
    console.log('   📈 Price volatility monitoring');
    console.log('   🚨 Real-time alerts for farming opportunities');

    console.log('\n🎨 Risk Zones:');
    console.log(
      '   🚨 DANGER (≤10%): Avoid adding LP - very close to tick boundary'
    );
    console.log(
      '   ⚠️  WARNING (10-20%): Be careful - quite close to tick boundary'
    );
    console.log('   ✅ SAFE (20-30%): Safe to add LP');
    console.log('   🎯 OPTIMAL (>30%): Excellent for LP farming!');

    this.startSwapEventListener();
    this.startPeriodicAnalysis();
    this.startAPRTracking();
    this.startDashboard();

    console.log('\n🚀 LP Farming Monitor is now LIVE!');
  }

  private startSwapEventListener(): void {
    console.log('👂 Starting swap event listener...');

    try {
      // Use a more compatible event listener approach
      this.client.watchEvent({
        address: this.poolAddress,
        event: parseAbi(SWAP_EVENT_ABI)[0] as any,
        onLogs: async (logs: Log[]) => {
          for (const log of logs) {
            try {
              // Validate log structure before processing
              if (!log || !log.blockHash || !log.transactionHash) {
                console.log('⚠️ Invalid log structure, skipping...', {
                  hasBlockHash: !!log?.blockHash,
                  hasTransactionHash: !!log?.transactionHash,
                  log: log,
                });
                continue;
              }

              await this.processSwapEvent(log);
            } catch (error) {
              console.error('❌ Error processing swap event:', error);
              console.error('   Log details:', {
                blockHash: log?.blockHash,
                transactionHash: log?.transactionHash,
                args: (log as any)?.args,
              });
            }
          }
        },
        onError: (error: any) => {
          console.error('❌ Swap event listener error:', error);
          console.log('🔄 Event listening failed, using polling-only mode...');
        },
      });

      console.log('✅ Swap event listener started successfully');
    } catch (error) {
      console.log(
        '❌ Failed to start event listener, using polling-only mode...'
      );
    }
  }

  private async processSwapEvent(log: Log): Promise<void> {
    const args = (log as any).args;
    if (!args) {
      console.log('⚠️ Swap event has no args, skipping...');
      return;
    }

    // Handle both array and object args structures
    let tick, sqrtPriceX96, liquidity, amount0, amount1;

    if (Array.isArray(args)) {
      // Array format: [sender, recipient, amount0, amount1, sqrtPriceX96, liquidity, tick]
      if (args.length < 7) {
        console.log('⚠️ Swap event args array too short, skipping...', {
          argsLength: args.length,
          args: args,
        });
        return;
      }
      tick = Number(args[6]);
      sqrtPriceX96 = args[4];
      liquidity = args[5];
      amount0 = args[2];
      amount1 = args[3];
    } else if (typeof args === 'object' && args !== null) {
      // Object format: {sender, recipient, amount0, amount1, sqrtPriceX96, liquidity, tick}
      tick = Number(args.tick);
      sqrtPriceX96 = args.sqrtPriceX96;
      liquidity = args.liquidity;
      amount0 = args.amount0;
      amount1 = args.amount1;
    } else {
      console.log('⚠️ Swap event args structure unexpected, skipping...', {
        argsType: typeof args,
        args: args,
      });
      return;
    }

    // Validate that we have valid values
    if (isNaN(tick) || !sqrtPriceX96 || !liquidity) {
      console.log('⚠️ Invalid swap event data, skipping...', {
        tick,
        sqrtPriceX96: typeof sqrtPriceX96,
        liquidity: typeof liquidity,
        args: args,
      });
      return;
    }

    // Convert to proper types
    const sqrtPriceX96BigInt = BigInt(sqrtPriceX96);
    const liquidityBigInt = BigInt(liquidity);

    // Calculate price
    const price = price1Per0FromSqrt(
      sqrtPriceX96BigInt,
      this.token0Decimals!,
      this.token1Decimals!
    );

    // Get block info
    const block = await this.client.getBlock({ blockHash: log.blockHash! });
    const timestamp = Number(block.timestamp);
    const blockNumber = Number(block.number);

    // Calculate swap volume in USD
    let swapVolume = 0;
    if (amount0 && amount1) {
      const amount0Num = Number(amount0);
      const amount1Num = Number(amount1);

      // Convert amounts to proper decimals
      const amount0Adjusted = amount0Num / Math.pow(10, this.token0Decimals!);
      const amount1Adjusted = amount1Num / Math.pow(10, this.token1Decimals!);

      // Calculate volume in USD (using current price)
      // For token0 (USDC), amount0 is already in USD
      // For token1 (ETH), convert using current price
      // Use absolute values since one will be positive and one negative
      if (Math.abs(amount0Adjusted) > Math.abs(amount1Adjusted)) {
        swapVolume = Math.abs(amount0Adjusted); // USDC amount (absolute value)
      } else {
        swapVolume = Math.abs(amount1Adjusted) * price; // ETH amount * ETH price (absolute value)
      }
    }

    // Update volume history
    if (swapVolume > 0) {
      this.volumeHistory.push({
        volume: swapVolume,
        timestamp: Date.now(),
      });

      // Keep only last 24 hours of data (assuming 1 entry per minute)
      const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
      this.volumeHistory = this.volumeHistory.filter(
        (v) => v.timestamp > oneDayAgo
      );
    }

    // Update total value locked (simplified calculation)
    if (liquidityBigInt > 0) {
      this.totalValueLocked =
        Number(liquidityBigInt) / Math.pow(10, this.token0Decimals!);
    }

    // Check for tick change
    if (this.currentTick !== undefined && tick !== this.currentTick) {
      console.log(`🔄 TICK CHANGE: ${this.currentTick} → ${tick}`);
      await this.handleTickChange({
        fromTick: this.currentTick,
        toTick: tick,
        tick,
        price,
        sqrtPriceX96: sqrtPriceX96BigInt,
        liquidity: liquidityBigInt.toString(),
        blockNumber,
        blockTimestamp: timestamp,
        transactionHash: log.transactionHash || undefined,
      });
    }

    // Update current state
    this.currentTick = tick;
    this.previousTick = this.currentTick;

    // Update price history
    this.priceHistory.push({ price, timestamp: Date.now() });
    if (this.priceHistory.length > 1000) {
      this.priceHistory = this.priceHistory.slice(-500);
    }
  }

  private async handleTickChange(data: {
    fromTick: number;
    toTick: number;
    tick: number;
    price: number;
    sqrtPriceX96: bigint;
    liquidity: string;
    blockNumber: number;
    blockTimestamp: number;
    transactionHash?: string;
  }): Promise<void> {
    const now = Date.now();
    const currentTimestamp = Math.floor(now / 1000);

    // Calculate tick change metrics
    const tickDirection = data.toTick > data.fromTick ? 'up' : 'down';
    const ticksChanged = Math.abs(data.toTick - data.fromTick);

    // Calculate timing metrics
    let timeSinceLastTickChange = 0;
    let tickRangeDuration = 0;

    if (this.lastTickChangeTimestamp) {
      timeSinceLastTickChange = currentTimestamp - this.lastTickChangeTimestamp;
      tickRangeDuration = timeSinceLastTickChange;
    }

    // Calculate price change
    const lastPrice =
      this.priceHistory.length > 0
        ? this.priceHistory[this.priceHistory.length - 1].price
        : data.price;
    const priceChangePercentage = ((data.price - lastPrice) / lastPrice) * 100;

    // Analyze tick range for additional metrics
    const tickRangeAnalysis = analyzeTickRange(
      data.tick,
      this.tickSpacing!,
      data.price,
      this.token0Decimals!,
      this.token1Decimals!
    );

    // Create tick change data
    const tickChangeData: TickChangeData = {
      timestamp: new Date().toISOString(),
      blockNumber: data.blockNumber,
      transactionHash: data.transactionHash,
      tick: data.tick,
      sqrtPriceX96: data.sqrtPriceX96.toString(),
      price: data.price,
      liquidity: data.liquidity,
      fromTick: data.fromTick,
      toTick: data.toTick,
      tickChangeDirection: tickDirection,
      ticksChanged,
      priceChangePercentage,
      timeSinceLastTickChange,
      tickRangeDuration,
      blockTimestamp: data.blockTimestamp,
      tickRange: tickRangeAnalysis.tickRange,
      currentPriceInRange: tickRangeAnalysis.currentPriceInRange,
    };

    // Log tick change
    this.logger.logTickChange(tickChangeData);

    // Update tick range durations for statistics
    if (tickRangeDuration > 0) {
      this.tickRangeDurations.push(tickRangeDuration);
      if (this.tickRangeDurations.length > 100) {
        this.tickRangeDurations = this.tickRangeDurations.slice(-50);
      }
    }

    // Update tracking
    this.lastTickChangeTimestamp = currentTimestamp;
    this.tickHistory.push({
      tick: data.toTick,
      timestamp: now,
      price: data.price,
    });

    // Immediately analyze LP opportunity after tick change
    await this.analyzeLPOpportunity(data.tick, data.price, data.liquidity);
  }

  private startPeriodicAnalysis(): void {
    console.log('⏰ Starting periodic analysis...');

    this.analysisInterval = setInterval(async () => {
      try {
        await this.performPeriodicAnalysis();
      } catch (error) {
        console.error('❌ Periodic analysis error:', error);
      }
    }, config.POLL_INTERVAL_MS);
  }

  private async performPeriodicAnalysis(): Promise<void> {
    // Get current pool state using pool fetcher
    const currentState = await this.poolFetcher.getCurrentPoolState();
    const tick = currentState.currentTick;
    const sqrtPriceX96 = currentState.sqrtPriceX96;
    const liquidity = currentState.liquidity.toString();

    const price = price1Per0FromSqrt(
      sqrtPriceX96,
      this.token0Decimals,
      this.token1Decimals
    );

    // Get high precision price
    const precisePrice = price1Per0FromSqrtPrecise(
      sqrtPriceX96,
      this.token0Decimals,
      this.token1Decimals,
      18
    );

    const blockNumber = await this.client.getBlockNumber();

    // Store precise price for dashboard display
    this.currentPrecisePrice = precisePrice;

    // Check for tick change in periodic analysis
    if (this.currentTick !== undefined && tick !== this.currentTick) {
      console.log(`🔄 TICK CHANGE DETECTED: ${this.currentTick} → ${tick}`);
      try {
        await this.handleTickChange({
          fromTick: this.currentTick,
          toTick: tick,
          tick,
          price,
          sqrtPriceX96,
          liquidity,
          blockNumber: Number(blockNumber),
          blockTimestamp: Math.floor(Date.now() / 1000),
          transactionHash: undefined,
        });
        console.log(`✅ Tick change logged successfully`);
      } catch (error) {
        console.error(`❌ Error logging tick change:`, error);
      }
    }

    // Update current tick
    this.currentTick = tick;

    // Analyze LP opportunity and store tick range analysis
    const tickRangeAnalysis = await this.analyzeLPOpportunity(
      tick,
      price,
      liquidity,
      Number(blockNumber)
    );

    // Store tick range analysis for dashboard display
    this.currentTickRangeAnalysis = tickRangeAnalysis;
  }

  private async analyzeLPOpportunity(
    tick: number,
    price: number,
    liquidity: string,
    blockNumber?: number
  ): Promise<TickRangeAnalysis> {
    // Perform tick range analysis
    const tickRangeAnalysis = analyzeTickRange(
      tick,
      this.tickSpacing,
      price,
      this.token0Decimals,
      this.token1Decimals
    );

    // Calculate opportunity score
    const volume24h =
      this.volumeHistory.length > 0
        ? this.volumeHistory.reduce((sum, v) => sum + v.volume, 0)
        : 0;
    const volatility = this.calculatePriceVolatility();

    // Get current tick range duration
    const currentTickRangeDuration = this.lastTickChangeTimestamp
      ? Math.floor(Date.now() / 1000) - this.lastTickChangeTimestamp
      : 0;

    const opportunityScore = LPFarmingLogger.calculateOpportunityScore(
      tickRangeAnalysis.nearestTickDistancePct,
      undefined, // APR data will be added later
      volume24h,
      volatility,
      currentTickRangeDuration
    );

    // Calculate fees from volume
    const opportunityFees24h = volume24h * (this.fee / 10000); // Convert fee from basis points to decimal

    // Create LP opportunity data
    const opportunityData: LPOpportunityData = {
      timestamp: new Date().toISOString(),
      blockNumber: blockNumber || 0,
      currentTick: tick,
      currentPrice: price,
      currentTickRange: tickRangeAnalysis.currentTick,
      distanceToLowerTickPct: tickRangeAnalysis.distanceToLowerTickPct,
      distanceToUpperTickPct: tickRangeAnalysis.distanceToUpperTickPct,
      nearestTickSide: tickRangeAnalysis.nearestTickSide,
      nearestTickDistancePct: tickRangeAnalysis.nearestTickDistancePct,
      riskLevel: tickRangeAnalysis.riskLevel,
      riskDescription: tickRangeAnalysis.riskDescription,
      lpRecommendation: tickRangeAnalysis.lpRecommendation,
      tickLowerPrice: tickRangeAnalysis.priceAtTickLower,
      tickUpperPrice: tickRangeAnalysis.priceAtTickUpper,
      tickRange: tickRangeAnalysis.tickRange,
      currentPriceInRange: tickRangeAnalysis.currentPriceInRange,
      liquidity,
      volume24h,
      fees24h: opportunityFees24h,
      totalValueLocked: this.totalValueLocked || 0,
      opportunityScore,
      priceVolatility: volatility,
      tickRangeDuration: currentTickRangeDuration,
    };

    // Log significant LP opportunities only when risk level changes
    if (
      tickRangeAnalysis.riskLevel === 'optimal' ||
      tickRangeAnalysis.riskLevel === 'danger' ||
      tickRangeAnalysis.riskLevel === 'warning'
    ) {
      this.logger.logLPOpportunity(opportunityData);
    }

    // Track consecutive safe opportunities
    if (
      tickRangeAnalysis.lpRecommendation === 'add' ||
      tickRangeAnalysis.lpRecommendation === 'excellent'
    ) {
      this.consecutiveSafeOpportunities++;
    } else {
      this.consecutiveSafeOpportunities = 0;
    }

    // Calculate fees from volume
    const detailedFees24h = volume24h * (this.fee / 10000); // Convert fee from basis points to decimal

    // Log detailed data
    const detailedData: DetailedPoolData = {
      timestamp: new Date().toISOString(),
      blockNumber: blockNumber || 0,
      tick,
      sqrtPriceX96: BigInt(0).toString(),
      price,
      liquidity,
      token0Symbol: this.token0Symbol,
      token1Symbol: this.token1Symbol,
      token0Address: this.token0Address,
      token1Address: this.token1Address,
      tickRangeAnalysis,
      eventType: 'periodic_analysis',
      severity:
        tickRangeAnalysis.riskLevel === 'danger'
          ? 'critical'
          : tickRangeAnalysis.riskLevel === 'warning'
          ? 'warning'
          : 'info',
      volume24h,
      fees24h: detailedFees24h,
      totalValueLocked: this.totalValueLocked,
      priceVolatility: volatility,
    };

    this.logger.logDetailedData(detailedData);

    // Return the tick range analysis for dashboard display
    return tickRangeAnalysis;
  }

  private startAPRTracking(): void {
    console.log('💰 Starting APR tracking...');

    this.aprInterval = setInterval(async () => {
      try {
        await this.updateAPRTracking();
      } catch (error) {
        console.error('❌ APR tracking error:', error);
      }
    }, config.APR_CALCULATION_INTERVAL_MS);
  }

  private async updateAPRTracking(): Promise<void> {
    const now = Date.now();

    // Skip if updated recently
    if (now - this.lastAPRUpdate < config.APR_CALCULATION_INTERVAL_MS) {
      return;
    }

    try {
      // Calculate real APR based on historical data
      const historicalData = this.volumeHistory.map((v, i) => ({
        volume: v.volume,
        fees: v.volume * (this.fee / 10000), // Calculate fees from volume
        tvl: this.totalValueLocked || 1000000, // Use actual TVL or estimate
        timestamp: v.timestamp,
      }));

      const aprCalculation = calculateAPRFromHistory(
        historicalData,
        this.fee / 10000
      );

      const aprData: APRTrackingData = {
        timestamp: new Date().toISOString(),
        date: new Date().toISOString().split('T')[0],
        currentAPR: aprCalculation.currentAPR,
        projectedAPR: aprCalculation.projectedAPR,
        feeAPR: aprCalculation.feeAPR,
        volume24h: aprCalculation.averageVolume24h,
        fees24h: aprCalculation.averageFees24h,
        totalValueLocked: aprCalculation.totalValueLocked,
        volumeToTVLRatio: aprCalculation.volumeToTVLRatio,
        aprConfidence: aprCalculation.aprConfidence,
        priceVolatility: this.calculatePriceVolatility(),
        dailyFeeRate: aprCalculation.dailyFeeRate,
        annualFeeRate: aprCalculation.annualFeeRate,
        notes: `Consecutive safe opportunities: ${this.consecutiveSafeOpportunities}`,
      };

      this.logger.logAPRTracking(aprData);
      this.lastAPRUpdate = now;
    } catch (error) {
      console.error('❌ Failed to update APR tracking:', error);
    }
  }

  private calculatePriceVolatility(): number {
    if (this.priceHistory.length < 10) return 0;

    const recentPrices = this.priceHistory.slice(-20).map((p) => p.price);
    return calculatePriceVolatility(recentPrices);
  }

  // ==================== REAL-TIME DASHBOARD ====================

  private startDashboard(): void {
    console.log('🖥️ Starting real-time dashboard...');

    this.dashboardInterval = setInterval(() => {
      this.displayDashboard();
    }, config.DASHBOARD_UPDATE_INTERVAL_MS);
  }

  private displayDashboard(): void {
    const uptime = Math.floor((Date.now() - this.monitorStartTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);

    console.clear();
    console.log(
      '╔══════════════════════════════════════════════════════════════╗'
    );
    console.log(
      '║                   🎯 LP FARMING DASHBOARD 🎯                    ║'
    );
    console.log(
      '╠══════════════════════════════════════════════════════════════╣'
    );
    console.log(
      `║ Pool: ${this.token0Symbol}/${this.token1Symbol} | Network: ${KATANA_CHAIN.name} | Uptime: ${hours}h ${minutes}m ║`
    );
    console.log(
      '╠══════════════════════════════════════════════════════════════╣'
    );

    if (this.currentTick !== undefined && this.currentPrecisePrice) {
      console.log(
        `║ 📍 Current Tick: ${this.currentTick} | Price: ${this.currentPrecisePrice} ║`
      );

      // Display tick boundary distances if available
      if (this.currentTickRangeAnalysis) {
        const lowerDistance = (
          this.currentTickRangeAnalysis.distanceToLowerTickPct * 100
        ).toFixed(1);
        const upperDistance = (
          this.currentTickRangeAnalysis.distanceToUpperTickPct * 100
        ).toFixed(1);
        const riskLevel = this.currentTickRangeAnalysis.riskLevel.toUpperCase();
        const position = (
          this.currentTickRangeAnalysis.currentPriceInRange * 100
        ).toFixed(1);

        console.log(
          `║ 📏 Tick Boundary Distances: Lower ${lowerDistance}% | Upper ${upperDistance}% ║`
        );
        console.log(
          `║ 🎯 Risk Level: ${riskLevel} | Position: ${position}% | Recommendation: ${this.currentTickRangeAnalysis.lpRecommendation} ║`
        );
      }

      // Display statistics
      const tickRangeStats = calculateTickRangeDurationStats(
        this.tickRangeDurations
      );
      console.log(
        `║ 📊 Tick Changes: ${this.tickHistory.length} | Safe Opportunities: ${this.consecutiveSafeOpportunities} ║`
      );
      console.log(
        `║ ⏱️  Avg Tick Range Duration: ${formatDuration(
          tickRangeStats.average
        )} | Volatility: ${(this.calculatePriceVolatility() * 100).toFixed(
          2
        )}% ║`
      );
    }

    console.log(
      '╠══════════════════════════════════════════════════════════════╣'
    );
    console.log(
      '║ 🎯 LP FARMING TIPS:                                           ║'
    );
    console.log(
      '║ • Wait for tick range in SAFE/OPTIMAL position before adding LP ║'
    );
    console.log(
      '║ • Monitor tick boundary distances to optimize timing          ║'
    );
    console.log(
      '║ • Rebalance when distance to tick boundary < 15%              ║'
    );
    console.log(
      '║ • Higher tick range duration = more stable price              ║'
    );
    console.log(
      '╚══════════════════════════════════════════════════════════════╝'
    );
    console.log('\n💡 Press Ctrl+C to stop monitoring...\n');
  }

  // ==================== CLEANUP ====================

  public cleanup(): void {
    if (this.dashboardInterval) {
      clearInterval(this.dashboardInterval);
    }
    if (this.analysisInterval) {
      clearInterval(this.analysisInterval);
    }
    if (this.aprInterval) {
      clearInterval(this.aprInterval);
    }
    console.log('🧹 LP Farming Monitor cleanup completed');
  }

  /**
   * Get current high precision price
   */
  public async getCurrentPrecisePrice(): Promise<string> {
    try {
      const currentState = await this.poolFetcher.getCurrentPoolState();
      const precisePrice = price1Per0FromSqrtPrecise(
        currentState.sqrtPriceX96,
        this.token0Decimals,
        this.token1Decimals,
        18
      );

      return precisePrice;
    } catch (error) {
      console.error('❌ Failed to get precise price:', error);
      return '0.000000000000000000';
    }
  }
}

// ==================== MAIN EXECUTION ====================

async function main() {
  const monitor = new LPFarmingMonitor();

  // Banner
  console.log('');
  console.log('╔════════════════════════════════════════════════╗');
  console.log('║          🎯 UNISWAP V3 LP FARMING MONITOR      ║');
  console.log('║              Katana Network                   ║');
  console.log('╠════════════════════════════════════════════════╣');
  console.log('║  📊 Advanced Tick Tracking & Analysis         ║');
  console.log('║  💰 APR Calculation & Optimization            ║');
  console.log('║  🎯 LP Opportunity Scoring                     ║');
  console.log('║  📈 Impermanent Loss Monitoring               ║');
  console.log('║  🚨 Real-time Farming Alerts                  ║');
  console.log('║  🔄 Katana Network Pool Monitoring            ║');
  console.log('╚════════════════════════════════════════════════╝');
  console.log('');
  console.log('🌐 Connecting to Katana Network...');
  console.log('');

  try {
    // Initialize monitor
    await monitor.initialize();

    // Start monitoring
    monitor.startMonitoring();

    console.log('\n🎯 LP Farming Monitor started successfully!');
    console.log('📊 Data is being logged to CSV files:');
    console.log(`   🔄 Tick Changes: ./data/${config.TICK_CHANGES_CSV}`);
    console.log(
      `   💰 LP Opportunities: ./data/${config.LP_OPPORTUNITIES_CSV}`
    );
    console.log(`   📈 APR Tracking: ./data/${config.APR_TRACKING_CSV}`);
    console.log(`   📋 Detailed Data: ./data/${config.DETAILED_POOL_DATA_CSV}`);
    console.log('\n🖥️ Real-time dashboard will display after 10 seconds...');

    // Graceful shutdown handling
    const gracefulShutdown = () => {
      console.log('\n🛑 Shutting down LP Farming Monitor...');
      monitor.cleanup();
      console.log('👋 Monitor stopped. All data saved to CSV files.');
      console.log('📊 Check the data folder for complete farming analytics.');
      process.exit(0);
    };

    process.on('SIGINT', gracefulShutdown);
    process.on('SIGTERM', gracefulShutdown);
    process.on('SIGHUP', gracefulShutdown);

    // Handle uncaught errors
    process.on('uncaughtException', (error) => {
      console.error('💥 Uncaught Exception:', error);
      monitor.cleanup();
      process.exit(1);
    });

    process.on('unhandledRejection', (reason, promise) => {
      console.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
      monitor.cleanup();
      process.exit(1);
    });
  } catch (error) {
    console.error('❌ Failed to start LP Farming Monitor:', error);
    console.error('');
    console.error('🔧 Troubleshooting:');
    console.error('   1. Check your network connection to Katana Network');
    console.error('   2. Verify the pool address is correct');
    console.error('   3. Ensure you have proper RPC access to Katana');
    console.error('   4. Check if the pool contract exists on Katana Network');
    console.error('');
    process.exit(1);
  }
}

// Start the application
console.log('🚀 Starting LP Farming Monitor...');
main().catch((error) => {
  console.error('💥 Critical error in main():', error);
  process.exit(1);
});
