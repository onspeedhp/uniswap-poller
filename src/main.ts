// main.ts
import 'dotenv/config';
import { BigNumber, ethers } from 'ethers';
import fs from 'fs';

/**
 * Minimal Uniswap V3 Pool ABI pieces we need
 */
const UNISWAP_V3_POOL_ABI = [
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee() view returns (uint24)',
  'function tickSpacing() view returns (int24)',
  'function liquidity() view returns (uint128)',
  'function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)',
  'function ticks(int24) view returns (uint128 liquidityGross,int128 liquidityNet,uint256 feeGrowthOutside0X128,uint256 feeGrowthOutside1X128,int56 tickCumulativeOutside,uint160 secondsPerLiquidityOutsideX128,uint32 secondsOutside,bool initialized)',
  'function tickBitmap(int16 wordPosition) view returns (uint256)',
  'function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives,uint160[] secondsPerLiquidityCumulativeX128s)',
] as const;

// Minimal ERC20
const ERC20_ABI = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
] as const;

/** ===== Math & utility helpers ===== */
const LOG_1P0001 = Math.log(1.0001);

function tickToPrice(tick: number, dec0: number, dec1: number): number {
  // price of 1 token1 in token0 (i.e., TOKEN0 per TOKEN1)
  const scale = Math.pow(10, dec0 - dec1);
  return Math.pow(1.0001, tick) * scale;
}

function roundDownToSpacing(tick: number, spacing: number) {
  let t = Math.floor(tick / spacing) * spacing;
  // handle negatives like solidity's floorDiv
  if (tick < 0 && tick % spacing !== 0) t -= spacing;
  return t;
}

function widthFromSigma(
  sigma: number, // log-vol proxy per 1h (rough)
  T_hours: number, // projection hours
  z: number, // confidence multiplier (≈1.28 for ~80%)
  tickSpacing: number
) {
  const T_days = Math.max(1e-9, T_hours / 24);
  const halfWidth = (z * sigma * Math.sqrt(T_days)) / LOG_1P0001;
  let W = Math.ceil(2 * halfWidth);
  W = Math.ceil(W / tickSpacing) * tickSpacing;
  return Math.max(W, 2 * tickSpacing);
}

// “Buffer” and “Danger” thresholds in ticks (simple heuristics)
function bufferB(W: number, tickSpacing: number) {
  return Math.max(2 * tickSpacing, Math.floor(0.1 * W));
}
function dangerD(W: number, tickSpacing: number) {
  return Math.max(1 * tickSpacing, Math.floor(0.05 * W));
}

// Tick bitmap utilities
function wordOfTick(tick: number, tickSpacing: number) {
  let compressed = Math.floor(tick / tickSpacing);
  if (tick < 0 && tick % tickSpacing !== 0) compressed -= 1;
  return compressed >> 8; // each word covers 256 compressed ticks
}
function bitPosOfTick(tick: number, tickSpacing: number) {
  let compressed = Math.floor(tick / tickSpacing);
  if (tick < 0 && tick % tickSpacing !== 0) compressed -= 1;
  return compressed & 255;
}
function isBitSet(bm: BigNumber, bit: number) {
  const mask = BigNumber.from(1).shl(bit);
  return !bm.and(mask).isZero();
}

/** ===== Human-friendly strings ===== */
function friendlyAction(a: string): string {
  switch (a) {
    case 'PROPOSE_MINT':
      return 'NÊN cung cấp thanh khoản (đề xuất mở vị thế)';
    case 'REBUILD_AROUND_TWAP':
      return 'NÊN dời dải về quanh giá trung bình (TWAP)';
    case 'WITHDRAW_IF_FEES_MINUS_GAS<0':
      return 'CÂN NHẮC RÚT nếu phí tích luỹ < chi phí gas';
    case 'KEEP':
      return 'Giữ nguyên vị thế (ổn)';
    case 'NEUTRAL_HOLD':
      return 'Giữ trung lập (chưa cần hành động)';
    default:
      return a;
  }
}
function friendlyReason(r: string): string {
  return r
    .replace('near edge', 'Giá đang gần sát biên dải')
    .replace('distance >= B', 'Khoảng cách an toàn tới biên đủ lớn (≥ B)')
    .replace('between D and B', 'Khoảng cách ở mức trung gian (chưa nguy hiểm)')
    .replace('price left your range', 'Giá đã ra khỏi dải hiện tại')
    .replace(
      'no current position; propose mint',
      'Chưa có vị thế — đề xuất mở dải'
    );
}
const fmt = (n: number | undefined, d = 4) =>
  n === undefined || !Number.isFinite(n) ? String(n) : n.toFixed(d);

/** ====== Config (defaults set to your Katana USDC/WETH) ====== */
const RPC_HTTP = process.env.RPC_HTTP ?? 'https://rpc.katana.network';
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 747474);
const CHAIN_NAME = process.env.CHAIN_NAME ?? 'Katana';

const POOL = process.env.POOL ?? '0x2A2C512beAA8eB15495726C235472D82EFFB7A6B';
const TOKEN0 =
  process.env.TOKEN0_ADDRESS ?? '0x203A662b0BD271A6ed5a60EdFbd04bFce608FD36';
const TOKEN1 =
  process.env.TOKEN1_ADDRESS ?? '0xEE7D8BCFb72bC1880D0Cf19822eB0A2e6577aB62';

const POSITION_LOWER = process.env.POSITION_LOWER
  ? Number(process.env.POSITION_LOWER)
  : undefined;
const POSITION_UPPER = process.env.POSITION_UPPER
  ? Number(process.env.POSITION_UPPER)
  : undefined;

const OUT_SNAPSHOTS = process.env.OUT_SNAPSHOTS || './snapshots.csv';
const OUT_DECISIONS = process.env.OUT_DECISIONS || './decisions.csv';
const OUT_SIGNALS = process.env.OUT_SIGNALS || './signals.csv';
const OUT_EVENTS = process.env.OUT_EVENTS || './events.csv';
const STATE_FILE = process.env.STATE_FILE || './state.json';

const INTERVAL_SEC = Number(process.env.INTERVAL_SEC ?? 0); // 0 = run once
const T_HOURS = Number(process.env.T_HOURS ?? 24);
const Z_CONF = Number(process.env.Z_CONF ?? 1.28); // ~80%
const SEARCH_WORDS = Number(process.env.SEARCH_WORDS ?? 8);

const SIM_MODE = (process.env.SIM_MODE ?? '1') !== '0'; // simulate add/hold/remove
const HUMAN_LOG = (process.env.HUMAN_LOG ?? '1') !== '0'; // print friendly text

// Simulation configuration
const SIM_TOTAL_CAPITAL = Number(process.env.SIM_TOTAL_CAPITAL ?? 10000); // total simulation capital
const SIM_MIN_POSITION_SIZE = Number(process.env.SIM_MIN_POSITION_SIZE ?? 1000); // minimum position size
const SIM_MAX_POSITIONS = Number(process.env.SIM_MAX_POSITIONS ?? 5); // maximum concurrent positions
const SIM_FEE_RATE = Number(process.env.SIM_FEE_RATE ?? 0.001); // hourly fee rate (0.1%)

/** ===== Simulated position state (persisted) ===== */
type SimPosition = {
  id: string;
  lower: number;
  upper: number;
  enteredAt: string;
  enteredTick: number;
  enteredPrice: number;
  liquidity: number; // simulated liquidity amount
  feesEarned: number; // accumulated fees
  isActive: boolean;
  closedAt?: string;
  closedTick?: number;
  closedPrice?: number;
  pnl?: number; // realized PnL when closed
};

type SimState = {
  positions: SimPosition[];
  totalCapital: number; // total capital available for simulation
  usedCapital: number; // capital currently in positions
  nextPositionId: number;
  minPositionSize: number; // minimum size for new positions
  maxPositions: number; // maximum concurrent positions
};

type SimEvent = 'SIM_ADD' | 'SIM_HOLD' | 'SIM_REMOVE' | 'SIM_PARTIAL_REMOVE' | 'SIM_ADD_MORE';

function loadState(): SimState {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf-8');
    const obj = JSON.parse(raw);
    return {
      positions: obj.positions || [],
      totalCapital: obj.totalCapital || SIM_TOTAL_CAPITAL,
      usedCapital: obj.usedCapital || 0,
      nextPositionId: obj.nextPositionId || 1,
      minPositionSize: obj.minPositionSize || SIM_MIN_POSITION_SIZE,
      maxPositions: obj.maxPositions || SIM_MAX_POSITIONS,
    };
  } catch {
    return { 
      positions: [],
      totalCapital: SIM_TOTAL_CAPITAL,
      usedCapital: 0,
      nextPositionId: 1,
      minPositionSize: SIM_MIN_POSITION_SIZE,
      maxPositions: SIM_MAX_POSITIONS
    };
  }
}
function saveState(s: SimState) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

// Helper functions for position management
function calculatePositionPnL(position: SimPosition, currentTick: number, currentPrice: number): number {
  if (!position.isActive) return position.pnl || 0;
  
  // Simple PnL calculation based on price movement
  const priceChange = (currentPrice - position.enteredPrice) / position.enteredPrice;
  const positionValue = position.liquidity * (1 + priceChange);
  return positionValue - position.liquidity;
}

function calculateFeesEarned(position: SimPosition, currentTick: number): number {
  if (!position.isActive) return position.feesEarned;
  
  // Simple fee calculation based on time and liquidity
  const timeElapsed = (Date.now() - new Date(position.enteredAt).getTime()) / (1000 * 60 * 60); // hours
  return position.feesEarned + (position.liquidity * SIM_FEE_RATE * timeElapsed);
}

function canAddNewPosition(state: SimState): boolean {
  const activePositions = state.positions.filter(p => p.isActive);
  return activePositions.length < state.maxPositions && 
         (state.totalCapital - state.usedCapital) >= state.minPositionSize;
}

function getAvailableCapital(state: SimState): number {
  return state.totalCapital - state.usedCapital;
}

function shouldClosePosition(position: SimPosition, currentTick: number, D: number): boolean {
  if (!position.isActive) return false;
  
  const distToLower = currentTick - position.lower;
  const distToUpper = position.upper - currentTick;
  const minDist = Math.min(distToLower, distToUpper);
  
  return minDist < D || currentTick < position.lower || currentTick > position.upper;
}

function shouldAddMoreToPosition(position: SimPosition, currentTick: number, B: number): boolean {
  if (!position.isActive) return false;
  
  const distToLower = currentTick - position.lower;
  const distToUpper = position.upper - currentTick;
  const minDist = Math.min(distToLower, distToUpper);
  
  return minDist >= B; // safe distance, can add more
}

/** ===== Tick scanning: nearest initialized ticks around current price ===== */
async function findNearestInitializedTicks(
  pool: ethers.Contract,
  activeTick: number,
  tickSpacing: number,
  searchWordsEachSide: number
) {
  const activeWord = wordOfTick(activeTick, tickSpacing);
  const activeBit = bitPosOfTick(activeTick, tickSpacing);

  // prefetch bitmaps in a window of words
  const wordPositions: number[] = [];
  for (
    let w = activeWord - searchWordsEachSide;
    w <= activeWord + searchWordsEachSide;
    w++
  ) {
    wordPositions.push(w);
  }
  const bitmaps: Record<number, BigNumber> = {};
  const results = await Promise.all(
    wordPositions.map((w) => pool.tickBitmap(w))
  );
  results.forEach((bm, i) => {
    bitmaps[wordPositions[i]] = bm as BigNumber;
  });

  // scan right (above)
  let rightTick: number | null = null;
  {
    let w = activeWord;
    let startBit = activeBit + 1;
    for (; w <= activeWord + searchWordsEachSide; w++) {
      const bm = bitmaps[w] ?? BigNumber.from(0);
      if (!bm.isZero()) {
        for (let b = startBit; b <= 255; b++) {
          if (isBitSet(bm, b)) {
            const compressed = (w << 8) | b;
            rightTick = compressed * tickSpacing;
            w = activeWord + searchWordsEachSide + 1; // exit
            break;
          }
        }
      }
      startBit = 0;
    }
  }

  // scan left (below)
  let leftTick: number | null = null;
  {
    let w = activeWord;
    let startBit = activeBit - 1;
    for (; w >= activeWord - searchWordsEachSide; w--) {
      const bm = bitmaps[w] ?? BigNumber.from(0);
      if (!bm.isZero()) {
        for (let b = startBit; b >= 0; b--) {
          if (isBitSet(bm, b)) {
            const compressed = (w << 8) | b;
            leftTick = compressed * tickSpacing;
            w = activeWord - searchWordsEachSide - 1; // exit
            break;
          }
        }
      }
      startBit = 255;
    }
  }

  return { leftTick, rightTick };
}

/** ===== Main runner ===== */
async function main() {
  if (!RPC_HTTP || !POOL || !TOKEN0 || !TOKEN1) {
    console.error('Missing required env. See .env');
    process.exit(1);
  }

  // init provider & contracts
  const provider = new ethers.providers.JsonRpcProvider(RPC_HTTP, {
    name: CHAIN_NAME,
    chainId: CHAIN_ID,
  });
  const pool = new ethers.Contract(POOL, UNISWAP_V3_POOL_ABI, provider);
  const erc0 = new ethers.Contract(TOKEN0, ERC20_ABI, provider);
  const erc1 = new ethers.Contract(TOKEN1, ERC20_ABI, provider);

  // write CSV headers if files are new
  if (!fs.existsSync(OUT_SNAPSHOTS))
    fs.writeFileSync(
      OUT_SNAPSHOTS,
      'timestamp,block,tick,price0per1,liquidity,fee,spacing,obCard,leftInitTick,rightInitTick,distToLeft,distToRight,twap5m,twap1h,sigma\n'
    );
  if (!fs.existsSync(OUT_DECISIONS))
    fs.writeFileSync(
      OUT_DECISIONS,
      'timestamp,action,reason,tick,twap1h,tickLower,tickUpper,W,B,D,distMin\n'
    );
  if (!fs.existsSync(OUT_SIGNALS))
    fs.writeFileSync(
      OUT_SIGNALS,
      'timestamp,signal,reason,tick,price,twapDriftTicks,trend,distMin,W,B,D,lowerReco,upperReco\n'
    );
  if (!fs.existsSync(OUT_EVENTS))
    fs.writeFileSync(
      OUT_EVENTS,
      'timestamp,event,reason,tick,price,positionId,activePositions,totalValue,totalFees,availableCapital,trend,W,B,D\n'
    );

  const dec0 = await erc0.decimals();
  const dec1 = await erc1.decimals();
  const sym0 = await erc0.symbol();
  const sym1 = await erc1.symbol();

  async function once() {
    const block = await provider.getBlock('latest');

    // basic reads
    const [slot0, L_global, fee, spacing] = await Promise.all([
      pool.slot0(),
      pool.liquidity(),
      pool.fee(),
      pool.tickSpacing(),
    ]);

    const tick: number = slot0.tick;
    const price = tickToPrice(tick, dec0, dec1);

    // TWAP & crude sigma (proxy from 5m vs 1h drift)
    let twap5mTick: number | undefined,
      twap1hTick: number | undefined,
      sigma = 0;
    let trendTickDeltaShared: number | undefined = undefined;
    try {
      const secs = [0, 300, 3600]; // now, 5m, 1h
      const ob = await pool.observe(secs);
      const tCum = ob.tickCumulatives as BigNumber[];
      const tick5m = tCum[0].sub(tCum[1]).div(300).toNumber();
      const tick1h = tCum[0].sub(tCum[2]).div(3600).toNumber();
      twap5mTick = tick5m;
      twap1hTick = tick1h;
      const dtick = Math.abs(tick5m - tick1h);
      trendTickDeltaShared = dtick;
      sigma = dtick * LOG_1P0001; // rough log-vol proxy
    } catch {
      // lack of observations -> leave twap/sigma undefined/0
    }

    // nearest initialized ticks around active tick
    const { leftTick, rightTick } = await findNearestInitializedTicks(
      pool,
      tick,
      spacing,
      SEARCH_WORDS
    );
    const distToLeft = leftTick !== null ? tick - leftTick : undefined;
    const distToRight = rightTick !== null ? rightTick - tick : undefined;

    // choose center (prefer 1h TWAP, else current tick)
    const center = typeof twap1hTick === 'number' ? twap1hTick : tick;
    const W = widthFromSigma(sigma, T_HOURS, Z_CONF, spacing);
    const B = bufferB(W, spacing);
    const D = dangerD(W, spacing);

    const lowerReco = roundDownToSpacing(center - Math.floor(W / 2), spacing);
    const upperReco = lowerReco + W;

    // decision (if user supplied a current position via env)
    let action = 'PROPOSE_MINT';
    let reason = 'no current position; propose mint';
    let tickLowerOut = lowerReco;
    let tickUpperOut = upperReco;
    let distMin = Math.min(distToLeft ?? Infinity, distToRight ?? Infinity);

    if (POSITION_LOWER !== undefined && POSITION_UPPER !== undefined) {
      tickLowerOut = POSITION_LOWER;
      tickUpperOut = POSITION_UPPER;
      if (tick < POSITION_LOWER || tick > POSITION_UPPER) {
        action = 'REBUILD_AROUND_TWAP';
        reason = 'price left your range';
      } else {
        const dLow = tick - POSITION_LOWER;
        const dUp = POSITION_UPPER - tick;
        distMin = Math.min(dLow, dUp);
        if (distMin < D) {
          action = 'WITHDRAW_IF_FEES_MINUS_GAS<0';
          reason = `near edge (<D=${D})`;
        } else if (distMin >= B) {
          action = 'KEEP';
          reason = `distance >= B=${B}`;
        } else {
          action = 'NEUTRAL_HOLD';
          reason = `between D and B`;
        }
      }
    }

    // Signals (ADD_GOOD / WITHDRAW_GOOD) for reference
    const trendLabel =
      trendTickDeltaShared === undefined
        ? 'unknown'
        : trendTickDeltaShared < 2 * spacing
        ? 'sideways'
        : 'trending';

    let addGood = false;
    let addWhy = '';
    if (tickLowerOut === lowerReco && tickUpperOut === upperReco) {
      addGood = true;
      addWhy = 'Chưa có vị thế hoặc đang đề xuất dải mới quanh TWAP';
    } else if (
      Number.isFinite(distMin) &&
      (distMin as number) >= D &&
      trendLabel === 'sideways'
    ) {
      addGood = true;
      addWhy = 'Trong dải và thị trường sideways — có thể bổ sung vốn';
    }

    let withdrawGood = false;
    let withdrawWhy = '';
    if (POSITION_LOWER !== undefined && POSITION_UPPER !== undefined) {
      if (tick < POSITION_LOWER || tick > POSITION_UPPER) {
        withdrawGood = true;
        withdrawWhy = 'Giá đã ra khỏi dải — nên đóng vị thế hiện tại';
      } else if (Number.isFinite(distMin) && (distMin as number) < D) {
        withdrawGood = true;
        withdrawWhy = 'Giá gần biên (dist < D) — nên đóng để tránh IL';
      }
    }

    // Write signals.csv
    const writeSignal = (signal: string, why: string) => {
      const row =
        [
          new Date(block.timestamp * 1000).toISOString(),
          signal,
          why,
          tick,
          price,
          trendTickDeltaShared ?? '',
          trendLabel,
          Number.isFinite(distMin) ? distMin : '',
          W,
          B,
          D,
          lowerReco,
          upperReco,
        ].join(',') + '\n';
      fs.appendFileSync(OUT_SIGNALS, row);
    };
    if (addGood) writeSignal('ADD_GOOD', addWhy);
    if (withdrawGood) writeSignal('WITHDRAW_GOOD', withdrawWhy);

    // ===== Enhanced Simulated LP state machine =====
    if (SIM_MODE) {
      const st = loadState();
      const events: Array<{event: SimEvent, reason: string, positionId?: string}> = [];
      
      // Update existing positions
      for (const position of st.positions) {
        if (position.isActive) {
          // Update fees earned
          position.feesEarned = calculateFeesEarned(position, tick);
          
          // Check if should close position
          if (shouldClosePosition(position, tick, D)) {
            position.isActive = false;
            position.closedAt = new Date(block.timestamp * 1000).toISOString();
            position.closedTick = tick;
            position.closedPrice = price;
            position.pnl = calculatePositionPnL(position, tick, price);
            
            // Return capital
            st.usedCapital -= position.liquidity;
            
            events.push({
              event: 'SIM_REMOVE',
              reason: `Đóng vị thế ${position.id} - ${tick < position.lower || tick > position.upper ? 'ra khỏi dải' : 'gần biên nguy hiểm'}`,
              positionId: position.id
            });
          } else if (shouldAddMoreToPosition(position, tick, B) && addGood) {
            // Add more to existing position if good signal and safe distance
            const additionalLiquidity = Math.min(
              getAvailableCapital(st) * 0.3, // max 30% of available capital
              position.liquidity * 0.5 // max 50% of current position size
            );
            
            if (additionalLiquidity >= st.minPositionSize * 0.1) { // at least 10% of min position
              position.liquidity += additionalLiquidity;
              st.usedCapital += additionalLiquidity;
              
              events.push({
                event: 'SIM_ADD_MORE',
                reason: `Bổ sung vốn vào vị thế ${position.id} - tín hiệu tốt và an toàn`,
                positionId: position.id
              });
            }
          } else {
            events.push({
              event: 'SIM_HOLD',
              reason: `Giữ vị thế ${position.id} - ${position.feesEarned.toFixed(2)} fees earned`,
              positionId: position.id
            });
          }
        }
      }
      
      // Add new position if good signal and can add
      if (addGood && canAddNewPosition(st)) {
        const positionSize = Math.min(
          getAvailableCapital(st) * 0.4, // use 40% of available capital
          st.minPositionSize * 2 // or 2x minimum size
        );
        
        const newPosition: SimPosition = {
          id: `pos_${st.nextPositionId}`,
          lower: lowerReco,
          upper: upperReco,
          enteredAt: new Date(block.timestamp * 1000).toISOString(),
          enteredTick: tick,
          enteredPrice: price,
          liquidity: positionSize,
          feesEarned: 0,
          isActive: true
        };
        
        st.positions.push(newPosition);
        st.usedCapital += positionSize;
        st.nextPositionId++;
        
        events.push({
          event: 'SIM_ADD',
          reason: `Mở vị thế mới ${newPosition.id} - tín hiệu ADD_GOOD`,
          positionId: newPosition.id
        });
      }
      
      // If no events, log hold for active positions
      if (events.length === 0) {
        const activePositions = st.positions.filter(p => p.isActive);
        if (activePositions.length > 0) {
          events.push({
            event: 'SIM_HOLD',
            reason: `Giữ ${activePositions.length} vị thế - chưa có tín hiệu rõ ràng`
          });
        }
      }
      
      // Save updated state
      saveState(st);
      
      // Log all events
      const trendLabelSm =
        trendTickDeltaShared === undefined
          ? 'unknown'
          : trendTickDeltaShared < 2 * spacing
          ? 'sideways'
          : 'trending';
      
      for (const evt of events) {
        const activePositions = st.positions.filter(p => p.isActive);
        const totalValue = activePositions.reduce((sum, pos) => {
          return sum + pos.liquidity + calculatePositionPnL(pos, tick, price);
        }, 0);
        const totalFees = activePositions.reduce((sum, pos) => sum + pos.feesEarned, 0);
        
        const ev =
          [
            new Date(block.timestamp * 1000).toISOString(),
            evt.event,
            evt.reason,
            tick,
            price,
            evt.positionId || '',
            activePositions.length,
            totalValue.toFixed(2),
            totalFees.toFixed(2),
            getAvailableCapital(st).toFixed(2),
            trendLabelSm,
            W,
            B,
            D,
          ].join(',') + '\n';
        fs.appendFileSync(OUT_EVENTS, ev);
      }
    }

    // CSV logs (snapshots & decisions)
    const snap =
      [
        new Date(block.timestamp * 1000).toISOString(),
        block.number,
        tick,
        price,
        L_global.toString(),
        fee,
        spacing,
        slot0.observationCardinality,
        leftTick ?? '',
        rightTick ?? '',
        distToLeft ?? '',
        distToRight ?? '',
        twap5mTick ?? '',
        twap1hTick ?? '',
        sigma,
      ].join(',') + '\n';
    fs.appendFileSync(OUT_SNAPSHOTS, snap);

    const decision =
      [
        new Date(block.timestamp * 1000).toISOString(),
        action,
        reason,
        tick,
        twap1hTick ?? '',
        tickLowerOut,
        tickUpperOut,
        W,
        B,
        D,
        Number.isFinite(distMin) ? distMin : '',
      ].join(',') + '\n';
    fs.appendFileSync(OUT_DECISIONS, decision);

    // One-line techy
    console.log(
      `[${new Date().toISOString()}] ${sym0}/${sym1} tick=${tick} spacing=${spacing} fee=${fee} | action=${action} (${reason}) | reco=[${lowerReco},${upperReco}] W=${W} B=${B} D=${D}`
    );

    // Human-friendly section
    if (HUMAN_LOG) {
      const trendTickDelta = trendTickDeltaShared;
      const trendLabelText =
        trendTickDelta === undefined
          ? 'chưa đủ dữ liệu'
          : trendTickDelta < 2 * spacing
          ? 'dao động (sideways)'
          : 'có xu hướng (trending)';
      const priceLine = `• Giá hiện tại: 1 ${sym0} ≈ ${fmt(price, 6)} ${sym1}`;
      const twapLine =
        typeof twap5mTick === 'number' && typeof twap1hTick === 'number'
          ? `• TWAP 5m vs 1h (tick): ${twap5mTick} vs ${twap1hTick} → chênh: ${trendTickDelta} tick (${trendLabelText})`
          : '• TWAP: chưa đủ dữ liệu quan sát';
      const edgesLine = `• Biên tick đã khởi tạo gần nhất: trái=${
        leftTick ?? 'không có'
      } | phải=${rightTick ?? 'không có'}; khoảng cách: trái=${
        distToLeft ?? '-'
      } tick, phải=${distToRight ?? '-'} tick`;
      const volLine = `• Ước lượng biến động σ(1h): ${fmt(sigma * 100, 2)}%`;
      const bandLine = `• Dải đề xuất quanh TWAP1h: [${lowerReco}, ${upperReco}] (độ rộng W=${W} tick)`;
      const safetyLine = `• Vùng an toàn (B): ${B} tick | Ngưỡng cảnh báo (D): ${D} tick`;
      const concl = `→ Kết luận: ${friendlyAction(action)} — ${friendlyReason(
        reason
      )}`;
      const stNow = loadState();
      const activePositions = stNow.positions.filter(p => p.isActive);
      const totalValue = activePositions.reduce((sum, pos) => {
        return sum + pos.liquidity + calculatePositionPnL(pos, tick, price);
      }, 0);
      const totalFees = activePositions.reduce((sum, pos) => sum + pos.feesEarned, 0);
      
      const simLine = SIM_MODE
        ? activePositions.length > 0
          ? `• Mô phỏng: ${activePositions.length} vị thế active | Tổng giá trị: $${totalValue.toFixed(2)} | Fees: $${totalFees.toFixed(2)} | Vốn còn lại: $${getAvailableCapital(stNow).toFixed(2)}`
          : '• Mô phỏng: Chưa có vị thế active'
        : '• Mô phỏng: tắt';

      console.log(
        [
          '\n================= Gợi ý dễ hiểu =================',
          `Cặp: ${sym0}/${sym1} | Fee: ${
            fee / 10000
          }% | spacing: ${spacing} tick`,
          priceLine,
          twapLine,
          edgesLine,
          volLine,
          bandLine,
          safetyLine,
          simLine,
          concl,
          '=================================================\n',
        ].join('\n')
      );
    }
  }

  if (INTERVAL_SEC > 0) {
    await once();
    setInterval(once, INTERVAL_SEC * 1000);
  } else {
    await once();
    process.exit(0);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
