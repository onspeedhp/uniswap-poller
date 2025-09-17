import 'dotenv/config';
import {
  createPublicClient,
  http,
  webSocket,
  parseAbi,
  type Address,
  type PublicClient,
  type Log,
} from 'viem';
import { config } from './config.js';
import {
  LPFarmingLogger,
  type BinChangeData,
  type LPOpportunityData,
  type APRTrackingData,
  type DetailedPoolData,
} from './csvLogger.js';
import {
  price1Per0FromSqrt,
  price1Per0FromSqrtPrecise,
  analyzeBinEdges,
  calculateAPR,
  calculateImpermanentLoss,
  calculateMedian,
  calculateOptimalLPRange,
  isPriceInRange,
  type BinEdgeAnalysis,
  type APRCalculation,
} from './mathUtils.js';

// Network Configuration với automatic fallback
const createChainConfig = (useKatana: boolean = true) => {
  if (useKatana && process.env.FORCE_MAINNET !== 'true') {
    // Katana Network (Ronin) Configuration
    return {
      id: 2020,
      name: 'Katana',
      nativeCurrency: { name: 'Ronin', symbol: 'RON', decimals: 18 },
      rpcUrls: {
        default: {
          http: ['https://api.roninchain.com/rpc'],
          webSocket: config.RPC_WS ? [config.RPC_WS] : undefined,
        },
      },
    } as const;
  } else {
    // Ethereum Mainnet Fallback với multiple RPC endpoints
    return {
  id: 1,
  name: 'Ethereum',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: {
          http: [
            'https://ethereum.publicnode.com', // Reliable, supports all methods
            'https://ethereum-rpc.publicnode.com', // Good, supports all methods
            'https://eth.drpc.org', // Fast, supports all methods
            'https://rpc.flashbots.net', // Good, supports all methods
            'https://eth.merkle.io', // Reliable, supports all methods
            config.RPC_FALLBACK_HTTP || 'https://cloudflare-eth.com',
          ],
      webSocket: config.RPC_WS ? [config.RPC_WS] : undefined,
    },
  },
} as const;
  }
};

// Default chain configuration
let CHAIN_CONFIG = createChainConfig(true);

// Essential ABIs
const poolAbi = parseAbi([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee() view returns (uint24)',
  'function tickSpacing() view returns (int24)',
  'function liquidity() view returns (uint128)',
  'function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)',
]);

const erc20Abi = parseAbi([
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]);

const swapEventAbi = parseAbi([
  'event Swap(address sender,address recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)',
]);

// ==================== LP FARMING MONITOR CLASS ====================

class LPFarmingMonitor {
  private client: any; // Use any type to avoid strict typing issues with chain configs
  private logger: LPFarmingLogger;
  private poolAddress: Address;

  // Pool configuration
  private token0Address?: Address;
  private token1Address?: Address;
  private fee?: number;
  private tickSpacing?: number;
  private token0Decimals?: number;
  private token1Decimals?: number;
  private token0Symbol?: string;
  private token1Symbol?: string;

  // Bin tracking state
  private currentBin?: number;
  private previousBin?: number;
  private lastBinChangeTimestamp?: number;
  private currentPrecisePrice?: string;
  private currentEdgeAnalysis?: BinEdgeAnalysis;
  private binHistory: Array<{ bin: number; timestamp: number; price: number }> =
    [];
  private binDurations: number[] = [];

  // Market data tracking
  private priceHistory: Array<{ price: number; timestamp: number }> = [];
  private volumeHistory: Array<{ volume: number; timestamp: number }> = [];
  private feesCollected: number = 0;
  private totalValueLocked: number = 0;

  // Performance tracking
  private monitorStartTime: number;
  private lastAPRUpdate: number = 0;
  private consecutiveSafeOpportunities: number = 0;

  // Dashboard state
  private dashboardInterval?: NodeJS.Timeout;

  constructor() {
    // Initialize with first chain config attempt
    this.client = this.createClientWithConfig(CHAIN_CONFIG);
    this.logger = new LPFarmingLogger();
    this.poolAddress = config.POOL;
    this.monitorStartTime = Date.now();
  }

  private createClientWithConfig(chainConfig: any): any {
    const rpcUrls = Array.isArray(chainConfig.rpcUrls.default.http)
      ? chainConfig.rpcUrls.default.http
      : [chainConfig.rpcUrls.default.http];

    // Use first RPC URL for now, we'll implement fallback in testConnection
    const primaryRpc = rpcUrls[0];

    return createPublicClient({
      chain: chainConfig,
      transport: config.RPC_WS
        ? webSocket(config.RPC_WS, {
            timeout: 15000,
            retryCount: 3,
          })
        : http(primaryRpc, {
            timeout: 15000,
            retryCount: 3,
          }),
    });
  }

  private async testConnection(): Promise<boolean> {
    const rpcUrls = Array.isArray(CHAIN_CONFIG.rpcUrls.default.http)
      ? CHAIN_CONFIG.rpcUrls.default.http
      : [CHAIN_CONFIG.rpcUrls.default.http];

    for (let i = 0; i < rpcUrls.length; i++) {
      try {
        console.log(
          `🔗 Testing connection to ${CHAIN_CONFIG.name} (${i + 1}/${
            rpcUrls.length
          })...`
        );

        // Create temporary client with this RPC
        const tempClient = createPublicClient({
          chain: CHAIN_CONFIG,
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
            `❌ All ${rpcUrls.length} RPC endpoints failed for ${CHAIN_CONFIG.name}`
          );
        }
      }
    }
    return false;
  }

  async initialize(): Promise<void> {
    console.log('🎯 Khởi tạo LP Farming Monitor...');

    // Test connection và fallback nếu cần
    let connectionSuccessful = await this.testConnection();

    if (!connectionSuccessful) {
      console.log(
        '🔄 Katana connection failed, falling back to Ethereum mainnet...'
      );

      // Update chain config to mainnet
      CHAIN_CONFIG = createChainConfig(false);
      this.client = this.createClientWithConfig(CHAIN_CONFIG);

      // Update pool address to mainnet USDC/WETH pool for testing
      this.poolAddress =
        '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640' as `0x${string}`;
      console.log(`📍 Using Mainnet Pool: ${this.poolAddress}`);

      // Test mainnet connection
      connectionSuccessful = await this.testConnection();

      if (!connectionSuccessful) {
        throw new Error('❌ Both Katana and Mainnet connections failed!');
      }
    } else {
      console.log(`📍 Using ${CHAIN_CONFIG.name} Pool: ${this.poolAddress}`);
    }

    try {
      await this.loadPoolConfiguration();
      await this.initializeHistoricalData();
      this.logger.getLogSummary();

      console.log('✅ LP Farming Monitor đã sẵn sàng!');
      console.log(`🌐 Network: ${CHAIN_CONFIG.name}`);
      console.log(`🎯 Target Pool: ${this.token0Symbol}/${this.token1Symbol}`);
      console.log(`💰 Fee Tier: ${this.fee ? this.fee / 10000 : 'Unknown'}%`);
      console.log(`📏 Tick Spacing: ${this.tickSpacing}`);
    } catch (error) {
      console.error('❌ Pool configuration failed on', CHAIN_CONFIG.name);

      // If we're still on Katana and pool doesn't work, fallback to mainnet
      if (CHAIN_CONFIG.name === 'Katana') {
        console.log(
          '🔄 Pool not compatible with Katana, falling back to Ethereum mainnet...'
        );

        // Update chain config to mainnet
        CHAIN_CONFIG = createChainConfig(false);
        this.client = this.createClientWithConfig(CHAIN_CONFIG);

        // Update pool address to mainnet USDC/WETH pool
        this.poolAddress =
          '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640' as `0x${string}`;
        console.log(`📍 Using Mainnet USDC/WETH Pool: ${this.poolAddress}`);

        // Test mainnet connection with retry
        let mainnetConnection = false;
        for (let attempt = 1; attempt <= 3; attempt++) {
          console.log(`🔄 Mainnet connection attempt ${attempt}/3...`);
          mainnetConnection = await this.testConnection();
          if (mainnetConnection) break;
          if (attempt < 3) {
            console.log('⏳ Waiting 2 seconds before retry...');
            await new Promise((resolve) => setTimeout(resolve, 2000));
          }
        }

        if (!mainnetConnection) {
          throw new Error('❌ All mainnet RPC endpoints failed!');
        }

        // Retry with mainnet pool
        try {
          await this.loadPoolConfiguration();
          await this.initializeHistoricalData();
          this.logger.getLogSummary();

          console.log('✅ LP Farming Monitor ready on Ethereum Mainnet!');
          console.log(`🌐 Network: ${CHAIN_CONFIG.name}`);
          console.log(
            `🎯 Target Pool: ${this.token0Symbol}/${this.token1Symbol}`
          );
          console.log(
            `💰 Fee Tier: ${this.fee ? this.fee / 10000 : 'Unknown'}%`
          );
          console.log(`📏 Tick Spacing: ${this.tickSpacing}`);
        } catch (mainnetError) {
          console.error('❌ Mainnet initialization also failed:', mainnetError);
          throw mainnetError;
        }
      } else {
        throw error;
      }
    }
  }

  private async loadPoolConfiguration(): Promise<void> {
    console.log(`🔍 Loading pool configuration...`);

    try {
      // Load basic pool info
      const [token0, token1, slot0] = await Promise.all([
        this.client.readContract({
          address: this.poolAddress,
          abi: poolAbi,
          functionName: 'token0',
        }) as Promise<Address>,
        this.client.readContract({
          address: this.poolAddress,
          abi: poolAbi,
          functionName: 'token1',
        }) as Promise<Address>,
        this.client.readContract({
          address: this.poolAddress,
          abi: poolAbi,
          functionName: 'slot0',
        }) as Promise<any>,
      ]);

      // Load pool parameters with fallbacks
      let fee = 500n; // 0.05% default for USDC/ETH
      let tickSpacing = 10n; // Default spacing

      try {
        fee = BigInt(
          (await this.client.readContract({
          address: this.poolAddress,
          abi: poolAbi,
          functionName: 'fee',
          })) as number
        );
      } catch {
        console.warn('⚠️ Using default fee: 0.05%');
      }

      try {
        tickSpacing = BigInt(
          (await this.client.readContract({
          address: this.poolAddress,
          abi: poolAbi,
          functionName: 'tickSpacing',
          })) as number
        );
      } catch {
        console.warn('⚠️ Using default tick spacing: 10');
      }

      // Load token information
      const [decimals0, decimals1, symbol0, symbol1] = await Promise.all([
        this.client.readContract({
          address: token0,
          abi: erc20Abi,
          functionName: 'decimals',
        }) as Promise<number>,
        this.client.readContract({
          address: token1,
          abi: erc20Abi,
          functionName: 'decimals',
        }) as Promise<number>,
        this.client.readContract({
          address: token0,
          abi: erc20Abi,
          functionName: 'symbol',
        }) as Promise<string>,
        this.client.readContract({
          address: token1,
          abi: erc20Abi,
          functionName: 'symbol',
        }) as Promise<string>,
      ]);

      // Store configuration
      this.token0Address = token0;
      this.token1Address = token1;
      this.fee = Number(fee);
      this.tickSpacing = Number(tickSpacing);
      this.token0Decimals = decimals0;
      this.token1Decimals = decimals1;
      this.token0Symbol = symbol0;
      this.token1Symbol = symbol1;

      console.log(`✅ Pool loaded: ${symbol0}/${symbol1}`);
      console.log(`   💰 Fee: ${Number(fee) / 10000}%`);
      console.log(`   📏 Tick Spacing: ${Number(tickSpacing)}`);
      console.log(`   🔗 Token0: ${token0} (${decimals0} decimals)`);
      console.log(`   🔗 Token1: ${token1} (${decimals1} decimals)`);
    } catch (error) {
      console.error('❌ Failed to load pool configuration:', error);
      throw error;
    }
  }

  private async initializeHistoricalData(): Promise<void> {
    console.log('📊 Initializing historical data...');

    try {
      // Get current pool state
      const slot0 = (await this.client.readContract({
        address: this.poolAddress,
        abi: poolAbi,
        functionName: 'slot0',
      })) as any;

      const currentTick = Number(slot0[1]);
      const sqrtPriceX96 = slot0[0] as bigint;
      const currentPrice = price1Per0FromSqrt(
        sqrtPriceX96,
        this.token0Decimals!,
        this.token1Decimals!
      );

      // Calculate current bin
      const currentBin = Math.floor(currentTick / this.tickSpacing!);

      // Initialize tracking
      this.currentBin = currentBin;
      this.lastBinChangeTimestamp = Math.floor(Date.now() / 1000);

      // Add to history
      const timestamp = Date.now();
      this.binHistory.push({ bin: currentBin, timestamp, price: currentPrice });
      this.priceHistory.push({ price: currentPrice, timestamp });

      console.log(
        `✅ Initialized at bin ${currentBin}, price ${currentPrice.toFixed(6)}`
      );
    } catch (error) {
      console.error('❌ Failed to initialize historical data:', error);
      // Continue without historical data
    }
  }

  startMonitoring(): void {
    console.log('\n🎯 Starting Advanced LP Farming Monitor...');
    console.log('📊 Data collection includes:');
    console.log('   🔄 Chi tiết bin changes (từ bin nào sang bin nào)');
    console.log('   📏 Khoảng cách đến edge trái và phải của bin');
    console.log('   💰 APR calculation và tracking');
    console.log('   🎯 LP opportunity scoring (0-100)');
    console.log('   📈 Impermanent loss monitoring');
    console.log('   🚨 Real-time alerts cho farming opportunities');

    console.log('\n🎨 Risk Zones:');
    console.log('   🚨 DANGER (≤10%): Tránh add LP - rất gần edge');
    console.log('   ⚠️  WARNING (10-20%): Cần cẩn thận - khá gần edge');
    console.log('   ✅ SAFE (20-35%): An toàn để add LP');
    console.log('   🎯 OPTIMAL (>35%): Tuyệt vời cho LP farming!');

    this.startSwapEventListener();
    this.startPeriodicAnalysis();
    this.startDashboard();

    console.log('\n🚀 LP Farming Monitor is now LIVE!');
  }

  private startSwapEventListener(): void {
    console.log('👂 Starting swap event listener...');

    // Try to start event listener, but fallback to polling if it fails
    try {
    this.client.watchEvent({
      address: this.poolAddress,
      event: swapEventAbi[0],
        onLogs: async (logs: any[]) => {
        for (const log of logs) {
            try {
              await this.processSwapEvent(log);
            } catch (error) {
              console.error('❌ Error processing swap event:', error);
            }
          }
        },
        onError: (error: any) => {
          console.error('❌ Swap event listener error:', error);
          console.log('🔄 Event listening failed, using polling-only mode...');
          // Don't restart - just use polling
        },
      });
    } catch (error) {
            console.log(
        '❌ Failed to start event listener, using polling-only mode...'
      );
    }
  }

  private async processSwapEvent(log: Log): Promise<void> {
    const args = (log as any).args;
    if (!args) return;

    const tick = Number(args[6]);
    const sqrtPriceX96 = args[4] as bigint;
    const liquidity = args[5] as bigint;

    // Calculate bin and price
    const bin = Math.floor(tick / this.tickSpacing!);
    const price = price1Per0FromSqrt(
      sqrtPriceX96,
      this.token0Decimals!,
      this.token1Decimals!
    );

    // Get block info
    const block = await this.client.getBlock({ blockHash: log.blockHash! });
    const timestamp = Number(block.timestamp);
    const blockNumber = Number(block.number);

    // Check for bin change
    if (this.currentBin !== undefined && bin !== this.currentBin) {
      console.log(`🔄 BIN CHANGE: ${this.currentBin} → ${bin} (Tick: ${tick})`);
      await this.handleBinChange({
        fromBin: this.currentBin,
        toBin: bin,
        tick,
        price,
        sqrtPriceX96,
        liquidity: liquidity.toString(),
        blockNumber,
        blockTimestamp: timestamp,
        transactionHash: log.transactionHash || undefined,
      });
    }

    // Update current state
    this.currentBin = bin;
    this.previousBin = this.currentBin;

    // Update price history
    this.priceHistory.push({ price, timestamp: Date.now() });
    if (this.priceHistory.length > 1000) {
      this.priceHistory = this.priceHistory.slice(-500); // Keep last 500 records
    }
  }

  private async handleBinChange(data: {
    fromBin: number;
    toBin: number;
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

    // Calculate bin change metrics
    const binDirection = data.toBin > data.fromBin ? 'up' : 'down';
    const ticksChanged =
      Math.abs(data.toBin - data.fromBin) * this.tickSpacing!;

    // Calculate timing metrics
    let timeSinceLastBinChange = 0;
    let binDuration = 0;

    if (this.lastBinChangeTimestamp) {
      timeSinceLastBinChange = currentTimestamp - this.lastBinChangeTimestamp;
      binDuration = timeSinceLastBinChange;
    }

    // Calculate price change
    const lastPrice =
      this.priceHistory.length > 0
        ? this.priceHistory[this.priceHistory.length - 1].price
        : data.price;
    const priceChangePercentage = ((data.price - lastPrice) / lastPrice) * 100;

    // Create bin change data
    const binChangeData: BinChangeData = {
      timestamp: new Date().toISOString(),
      blockNumber: data.blockNumber,
      transactionHash: data.transactionHash,
      tick: data.tick,
      sqrtPriceX96: data.sqrtPriceX96.toString(),
      price: data.price,
      liquidity: data.liquidity,
      fromBin: data.fromBin,
      toBin: data.toBin,
      binChangeDirection: binDirection,
      ticksChanged,
      priceChangePercentage,
      timeSinceLastBinChange,
      binDuration,
      blockTimestamp: data.blockTimestamp,
    };

    // Log bin change
    this.logger.logBinChange(binChangeData);

    // Update bin durations for statistics
    if (binDuration > 0) {
      this.binDurations.push(binDuration);
      if (this.binDurations.length > 100) {
        this.binDurations = this.binDurations.slice(-50);
      }
    }

    // Update tracking
    this.lastBinChangeTimestamp = currentTimestamp;
    this.binHistory.push({
      bin: data.toBin,
      timestamp: now,
      price: data.price,
    });

    // Immediately analyze LP opportunity after bin change
    await this.analyzeLPOpportunity(data.tick, data.price, data.liquidity);
  }

  private startPeriodicAnalysis(): void {
    console.log('⏰ Starting periodic analysis...');

    // Main analysis loop
    setInterval(async () => {
      try {
        await this.performPeriodicAnalysis();
      } catch (error) {
        console.error('❌ Periodic analysis error:', error);
      }
    }, 10000); // 10 seconds - less frequent logging

    // APR tracking (every 2 minutes for testing)
    setInterval(async () => {
      try {
        await this.updateAPRTracking();
    } catch (error) {
        console.error('❌ APR tracking error:', error);
      }
    }, 2 * 60 * 1000);
    }

  private async performPeriodicAnalysis(): Promise<void> {
    // Get current pool state
    const slot0 = (await this.client.readContract({
      address: this.poolAddress,
      abi: poolAbi,
      functionName: 'slot0',
    })) as any;

    let liquidity = '0';
    try {
      const liquidityResult = (await this.client.readContract({
        address: this.poolAddress,
        abi: poolAbi,
        functionName: 'liquidity',
      })) as bigint;
      liquidity = liquidityResult.toString();
    } catch {
      // Use fallback liquidity
    }

    const tick = Number(slot0[1]);
    const sqrtPriceX96 = slot0[0] as bigint;
    const price = price1Per0FromSqrt(
      sqrtPriceX96,
      this.token0Decimals!,
      this.token1Decimals!
    );

    // Get high precision price
    const precisePrice = price1Per0FromSqrtPrecise(
      sqrtPriceX96,
      this.token0Decimals!,
      this.token1Decimals!,
      18 // 18 decimal precision
    );

    const blockNumber = await this.client.getBlockNumber();

    // Store precise price for dashboard display
    this.currentPrecisePrice = precisePrice;

    // Check for bin change in periodic analysis
    const bin = Math.floor(tick / this.tickSpacing!);
    if (this.currentBin !== undefined && bin !== this.currentBin) {
      console.log(`🔄 BIN CHANGE: ${this.currentBin} → ${bin} (Tick: ${tick})`);
      await this.handleBinChange({
        fromBin: this.currentBin,
        toBin: bin,
        tick,
        price,
        sqrtPriceX96,
        liquidity,
        blockNumber: Number(blockNumber),
        blockTimestamp: Math.floor(Date.now() / 1000),
        transactionHash: undefined, // No transaction hash for periodic analysis
      });
    }

    // Update current bin
    this.currentBin = bin;

    // Analyze LP opportunity and store edge analysis
    const edgeAnalysis = await this.analyzeLPOpportunity(
      tick,
      price,
      liquidity,
      Number(blockNumber)
    );
    
    // Store edge analysis for dashboard display
    this.currentEdgeAnalysis = edgeAnalysis;
  }

  private async analyzeLPOpportunity(
    tick: number,
    price: number,
    liquidity: string,
    blockNumber?: number
  ): Promise<BinEdgeAnalysis> {
    // Perform bin edge analysis
    const binAnalysis = analyzeBinEdges(
      tick,
      this.tickSpacing!,
      price,
      this.token0Decimals!,
      this.token1Decimals!
    );

    // Calculate opportunity score
    const volume24h =
      this.volumeHistory.length > 0
        ? this.volumeHistory.reduce((sum, v) => sum + v.volume, 0)
        : 0;
    const volatility = this.calculatePriceVolatility();

    const opportunityScore = LPFarmingLogger.calculateOpportunityScore(
      binAnalysis.nearestEdgeDistancePct,
      undefined, // APR data will be added later
      volume24h,
      volatility
    );

    // Create LP opportunity data
    const opportunityData: LPOpportunityData = {
      timestamp: new Date().toISOString(),
      blockNumber: blockNumber || 0,
      currentTick: tick,
      currentPrice: price,
      currentBin: binAnalysis.currentBin,
      distanceToLowerEdgePct: binAnalysis.distanceToLowerEdgePct,
      distanceToUpperEdgePct: binAnalysis.distanceToUpperEdgePct,
      nearestEdgeSide: binAnalysis.nearestEdgeSide,
      nearestEdgeDistancePct: binAnalysis.nearestEdgeDistancePct,
      riskLevel: binAnalysis.riskLevel,
      riskDescription: binAnalysis.riskDescription,
      lpRecommendation: binAnalysis.lpRecommendation,
      binLowerPrice: binAnalysis.priceAtBinLower,
      binUpperPrice: binAnalysis.priceAtBinUpper,
      liquidity,
      volume24h,
      opportunityScore,
    };

    // Log significant LP opportunities only when risk level changes
    if (
      binAnalysis.riskLevel === 'optimal' ||
      binAnalysis.riskLevel === 'danger' ||
      binAnalysis.riskLevel === 'warning'
    ) {
      this.logger.logLPOpportunity(opportunityData);
    }

    // Track consecutive safe opportunities
    if (
      binAnalysis.lpRecommendation === 'add' ||
      binAnalysis.lpRecommendation === 'excellent'
    ) {
      this.consecutiveSafeOpportunities++;
    } else {
      this.consecutiveSafeOpportunities = 0;
    }

    // Log detailed data
    const detailedData: DetailedPoolData = {
      timestamp: new Date().toISOString(),
      blockNumber: blockNumber || 0,
      tick,
      sqrtPriceX96: BigInt(0).toString(), // Will be populated with actual value
      price,
      liquidity,
      token0Symbol: this.token0Symbol!,
      token1Symbol: this.token1Symbol!,
      token0Address: this.token0Address!,
      token1Address: this.token1Address!,
      binAnalysis,
      eventType: 'periodic_analysis',
      severity:
        binAnalysis.riskLevel === 'danger'
          ? 'critical'
          : binAnalysis.riskLevel === 'warning'
          ? 'warning'
          : 'info',
    };

    this.logger.logDetailedData(detailedData);
    
    // Return the bin analysis for dashboard display
    return binAnalysis;
  }

  private async updateAPRTracking(): Promise<void> {
    const now = Date.now();

    // Skip if updated recently
    if (now - this.lastAPRUpdate < 1 * 60 * 1000) {
      // 1 minute minimum interval
      return;
    }

    try {
      // Calculate mock APR based on fees and activity
      // In real implementation, you'd fetch actual volume and fees data
      const mockVolume24h = 50000; // $50K daily volume estimate
      const mockFees24h = mockVolume24h * (this.fee! / 10000); // Fee percentage
      const mockTVL = 1000000; // $1M TVL estimate

      const aprCalculation = calculateAPR(
        mockVolume24h,
        mockFees24h,
        mockTVL,
        this.fee! / 10000
      );

      const aprData: APRTrackingData = {
        timestamp: new Date().toISOString(),
        date: new Date().toISOString().split('T')[0], // YYYY-MM-DD
        currentAPR: aprCalculation.currentAPR,
        projectedAPR: aprCalculation.projectedAPR,
        feeAPR: aprCalculation.feeAPR,
        volume24h: mockVolume24h,
        fees24h: mockFees24h,
        totalValueLocked: mockTVL,
        volumeToTVLRatio: aprCalculation.volumeToTVLRatio,
        aprConfidence: aprCalculation.aprConfidence,
        priceVolatility: this.calculatePriceVolatility(),
        notes: `Consecutive safe opportunities: ${this.consecutiveSafeOpportunities}`,
      };

      this.logger.logAPRTracking(aprData);
      this.lastAPRUpdate = now;
      console.log(`📈 APR Updated: ${aprCalculation.currentAPR.toFixed(2)}% | Volume: $${mockVolume24h.toLocaleString()}`);
    } catch (error) {
      console.error('❌ Failed to update APR tracking:', error);
    }
  }

  private calculatePriceVolatility(): number {
    if (this.priceHistory.length < 10) return 0;

    const recentPrices = this.priceHistory.slice(-20).map((p) => p.price);
    const mean =
      recentPrices.reduce((sum, price) => sum + price, 0) / recentPrices.length;
    const variance =
      recentPrices.reduce((sum, price) => sum + Math.pow(price - mean, 2), 0) /
      recentPrices.length;
    const volatility = Math.sqrt(variance) / mean; // Coefficient of variation

    return volatility;
  }

  // ==================== REAL-TIME DASHBOARD ====================

  private startDashboard(): void {
    console.log('🖥️ Starting real-time dashboard...');

    this.dashboardInterval = setInterval(() => {
      this.displayDashboard();
    }, 30000); // Update dashboard every 30 seconds (less frequent)
  }

  private displayDashboard(): void {
    const uptime = Math.floor((Date.now() - this.monitorStartTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);

    console.clear();
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║                   🎯 LP FARMING DASHBOARD 🎯                    ║');
    console.log('╠══════════════════════════════════════════════════════════════╣');
    console.log(`║ Pool: ${this.token0Symbol}/${this.token1Symbol} | Network: ${CHAIN_CONFIG.name} | Uptime: ${hours}h ${minutes}m ║`);
    console.log('╠══════════════════════════════════════════════════════════════╣');

    if (this.currentBin !== undefined && this.currentPrecisePrice) {
      console.log(`║ 📍 Current Bin: ${this.currentBin} | Price: ${this.currentPrecisePrice} ║`);
      
        // Display edge distances if available
        if (this.currentEdgeAnalysis) {
          const lowerDistance = (this.currentEdgeAnalysis.distanceToLowerEdgePct * 100).toFixed(6);
          const upperDistance = (this.currentEdgeAnalysis.distanceToUpperEdgePct * 100).toFixed(6);
          const riskLevel = this.currentEdgeAnalysis.riskLevel.toUpperCase();
          console.log(`║ 📏 Edge Distances: Lower ${lowerDistance}% | Upper ${upperDistance}% ║`);
          console.log(`║ 🎯 Risk Level: ${riskLevel} | Recommendation: ${this.currentEdgeAnalysis.lpRecommendation} ║`);
        }

      console.log(`║ 📊 Bin Changes: ${this.binHistory.length} | Safe Opportunities: ${this.consecutiveSafeOpportunities} ║`);
    }

    console.log('╠══════════════════════════════════════════════════════════════╣');
    console.log('║ 🎯 LP FARMING TIPS:                                           ║');
    console.log('║ • Đợi bin ở vị trí SAFE/OPTIMAL trước khi add LP              ║');
    console.log('║ • Theo dõi edge distances để tối ưu timing                    ║');
    console.log('║ • Rebalance khi distance đến edge < 15%                       ║');
    console.log('╚══════════════════════════════════════════════════════════════╝');
    console.log('\n💡 Press Ctrl+C to stop monitoring...\n');
  }

  // ==================== CLEANUP ====================

  public cleanup(): void {
    if (this.dashboardInterval) {
      clearInterval(this.dashboardInterval);
    }
    console.log('🧹 LP Farming Monitor cleanup completed');
  }

  /**
   * Get current high precision price
   * Returns exact price like "0.00022828235"
   */
  public async getCurrentPrecisePrice(): Promise<string> {
    try {
      const slot0 = (await this.client.readContract({
        address: this.poolAddress,
        abi: poolAbi,
        functionName: 'slot0',
      })) as any;

      const sqrtPriceX96 = slot0[0] as bigint;
      const precisePrice = price1Per0FromSqrtPrecise(
        sqrtPriceX96,
        this.token0Decimals!,
        this.token1Decimals!,
        18 // 18 decimal precision
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
  console.log('║           Multi-Network Smart Edition          ║');
  console.log('╠════════════════════════════════════════════════╣');
  console.log('║  📊 Advanced Bin Tracking & Analysis          ║');
  console.log('║  💰 APR Calculation & Optimization            ║');
  console.log('║  🎯 LP Opportunity Scoring                     ║');
  console.log('║  📈 Impermanent Loss Monitoring               ║');
  console.log('║  🚨 Real-time Farming Alerts                  ║');
  console.log('║  🔄 Auto Katana/Mainnet Fallback              ║');
  console.log('╚════════════════════════════════════════════════╝');
  console.log('');
  console.log(
    '🌐 Attempting connection: Katana Network → Ethereum Mainnet fallback'
  );
  console.log('');

  try {
    // Initialize monitor
    await monitor.initialize();

    // Start monitoring
    monitor.startMonitoring();

    console.log('\n🎯 LP Farming Monitor started successfully!');
    console.log('📊 Data được ghi vào multiple CSV files:');
    console.log(`   🔄 Bin Changes: ./data/${config.BIN_CHANGES_CSV}`);
    console.log(
      `   💰 LP Opportunities: ./data/${config.LP_OPPORTUNITIES_CSV}`
    );
    console.log(`   📈 APR Tracking: ./data/${config.APR_TRACKING_CSV}`);
    console.log('\n🖥️ Real-time dashboard sẽ hiển thị sau 10 giây...');

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
    console.error('   1. Check your network connection to Katana/Ronin');
    console.error('   2. Verify the pool address is correct');
    console.error('   3. Ensure you have proper RPC access');
    console.error('   4. Check if the pool contract exists on Katana');
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
