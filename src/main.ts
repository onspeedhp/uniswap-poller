// main.ts — Katana USDC/WETH, human logs + signals + simulated LP (clean, TS-safe)
import 'dotenv/config';
import { BigNumber, ethers } from 'ethers';
import fs from 'fs';

/** ===== Uniswap V3 ABIs (tối giản) ===== */
const UNISWAP_V3_POOL_ABI = [
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee() view returns (uint24)',
  'function tickSpacing() view returns (int24)',
  'function liquidity() view returns (uint128)',
  // slot0: sqrtPriceX96, tick, observationIndex, observationCardinality, observationCardinalityNext, feeProtocol, unlocked
  'function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)',
  // ticks(), tickBitmap()
  'function ticks(int24) view returns (uint128,int128,uint256,uint256,int56,uint160,uint32,bool)',
  'function tickBitmap(int16) view returns (uint256)',
  // TWAP
  'function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)',
] as const;

const ERC20_ABI = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
] as const;

/** ===== Helpers ===== */
const LOG_1P0001 = Math.log(1.0001);

function priceFromSqrtX96(
  sqrtPriceX96: BigNumber,
  dec0: number,
  dec1: number
): number {
  // price of 1 token1 in token0  (sqrtPriceX96^2 / 2^192) * 10^(dec0-dec1)
  const num = sqrtPriceX96.mul(sqrtPriceX96);
  const Q192 = BigNumber.from(2).pow(192);
  const ratio = Number(num.toString()) / Number(Q192.toString());
  return ratio * Math.pow(10, dec0 - dec1);
}

function tickToPrice(tick: number, dec0: number, dec1: number): number {
  return Math.pow(1.0001, tick) * Math.pow(10, dec0 - dec1);
}

function roundDownToSpacing(tick: number, spacing: number) {
  let t = Math.floor(tick / spacing) * spacing;
  if (tick < 0 && tick % spacing !== 0) t -= spacing; // floorDiv cho tick âm
  return t;
}

function widthFromSigma(
  sigma: number,
  T_hours: number,
  z: number,
  tickSpacing: number
) {
  const T_days = Math.max(1e-9, T_hours / 24);
  const halfWidth = (z * sigma * Math.sqrt(T_days)) / LOG_1P0001;
  let W = Math.ceil(2 * halfWidth);
  W = Math.ceil(W / tickSpacing) * tickSpacing;
  return Math.max(W, 2 * tickSpacing);
}
function bufferB(W: number, tickSpacing: number) {
  return Math.max(2 * tickSpacing, Math.floor(0.1 * W));
}
function dangerD(W: number, tickSpacing: number) {
  return Math.max(1 * tickSpacing, Math.floor(0.05 * W));
}

/** TickBitmap utils (chuẩn V3: 256 tick/word) */
function wordOfTick(tick: number, tickSpacing: number) {
  let compressed = Math.floor(tick / tickSpacing);
  if (tick < 0 && tick % tickSpacing !== 0) compressed -= 1;
  return compressed >> 8;
}
function bitPosOfTick(tick: number, tickSpacing: number) {
  let compressed = Math.floor(tick / tickSpacing);
  if (tick < 0 && tick % tickSpacing !== 0) compressed -= 1;
  return compressed & 255;
}
function isBitSet(bm: BigNumber, bit: number) {
  return !bm.and(BigNumber.from(1).shl(bit)).isZero();
}

const fmt = (n: number | undefined, d = 4) =>
  n === undefined || !Number.isFinite(n) ? String(n) : n.toFixed(d);

/** ===== Config (Katana defaults) ===== */
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

const OUT_SNAPSHOTS = process.env.OUT_SNAPSHOTS || './data/snapshots.csv';
const OUT_DECISIONS = process.env.OUT_DECISIONS || './data/decisions.csv';
const OUT_SIGNALS = process.env.OUT_SIGNALS || './data/signals.csv';
const OUT_EVENTS = process.env.OUT_EVENTS || './data/events.csv';
const STATE_FILE = process.env.STATE_FILE || './data/state.json';

const INTERVAL_SEC = Number(process.env.INTERVAL_SEC ?? 0); // 0 = run once
const T_HOURS = Number(process.env.T_HOURS ?? 24);
const Z_CONF = Number(process.env.Z_CONF ?? 1.28); // ~80%
const SEARCH_WORDS = Number(process.env.SEARCH_WORDS ?? 8);

const SIM_MODE = (process.env.SIM_MODE ?? '1') !== '0';
const HUMAN_LOG = (process.env.HUMAN_LOG ?? '1') !== '0';

/** ===== Sim types & state ===== */
type SimEvent = 'SIM_ADD' | 'SIM_HOLD' | 'SIM_REMOVE' | 'SIM_REBALANCE';
type Position = {
  id: string;
  lower: number;
  upper: number;
  enteredAt: string;
  entryTick: number;
  entryPrice: number;
  amountUsd: number;
  status: 'active' | 'closed';
  feesEarned: number;
  lastRebalanceAt?: string;
  rebalanceCount: number;
};

type SimState = {
  positions: Position[];
  totalUsdInvested: number;
  maxPositions: number;
  maxUsdPerPosition: number;
  totalUsdLimit: number;
};

const DEFAULT_STATE: SimState = {
  positions: [],
  totalUsdInvested: 0,
  maxPositions: 5,
  maxUsdPerPosition: 10000,
  totalUsdLimit: 50000, // 5 positions * 10k each
};

function loadState(): SimState {
  try {
    const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    return { ...DEFAULT_STATE, ...data };
  } catch {
    return DEFAULT_STATE;
  }
}

function saveState(s: SimState) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

function generatePositionId(): string {
  return `pos_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/** ===== Position Management Functions ===== */
function canAddPosition(state: SimState, amountUsd: number): boolean {
  return (
    state.positions.filter((p) => p.status === 'active').length <
      state.maxPositions &&
    state.totalUsdInvested + amountUsd <= state.totalUsdLimit &&
    amountUsd <= state.maxUsdPerPosition
  );
}

function getActivePositions(state: SimState): Position[] {
  return state.positions.filter((p) => p.status === 'active');
}

function calculatePositionDistance(tick: number, position: Position): number {
  if (tick < position.lower || tick > position.upper) {
    return -1; // Out of range
  }
  return Math.min(tick - position.lower, position.upper - tick);
}

function shouldClosePosition(
  tick: number,
  position: Position,
  D: number
): boolean {
  const distance = calculatePositionDistance(tick, position);
  return distance === -1 || distance < D;
}

function shouldHoldPosition(
  tick: number,
  position: Position,
  B: number
): boolean {
  const distance = calculatePositionDistance(tick, position);
  return distance >= B;
}

function calculateFeesEarned(
  position: Position,
  currentTick: number,
  currentPrice: number
): number {
  // Simplified fee calculation - in reality this would be more complex
  // For simulation, we'll estimate based on time held and price movement
  const timeHeld =
    (Date.now() - new Date(position.enteredAt).getTime()) / (1000 * 60 * 60); // hours
  const priceChange =
    Math.abs(currentPrice - position.entryPrice) / position.entryPrice;
  return position.amountUsd * 0.001 * timeHeld * (1 + priceChange); // 0.1% per hour base + volatility bonus
}

function logPositionDecision(
  position: Position,
  action: string,
  reason: string,
  tick: number,
  price: number,
  distance: number,
  feesEarned: number
) {
  const logData = {
    timestamp: new Date().toISOString(),
    positionId: position.id,
    action,
    reason,
    tick,
    price: price.toFixed(6),
    positionRange: `[${position.lower}, ${position.upper}]`,
    distance,
    entryPrice: position.entryPrice.toFixed(6),
    amountUsd: position.amountUsd,
    feesEarned: feesEarned.toFixed(2),
    timeHeld:
      Math.round(
        (Date.now() - new Date(position.enteredAt).getTime()) / (1000 * 60)
      ) + 'min',
  };

  console.log(`\n🎯 POSITION DECISION:`, logData);

  // Also write to CSV
  const csvRow =
    [
      logData.timestamp,
      logData.positionId,
      logData.action,
      logData.reason,
      logData.tick,
      logData.price,
      logData.positionRange,
      logData.distance,
      logData.entryPrice,
      logData.amountUsd,
      logData.feesEarned,
      logData.timeHeld,
    ].join(',') + '\n';

  fs.appendFileSync(OUT_EVENTS, csvRow);
}

/** ===== Find nearest initialized ticks around current tick ===== */
async function findNearestInitializedTicks(
  pool: ethers.Contract,
  activeTick: number,
  tickSpacing: number,
  searchWordsEachSide: number
) {
  const activeWord = wordOfTick(activeTick, tickSpacing);
  const activeBit = bitPosOfTick(activeTick, tickSpacing);

  const wordPositions: number[] = [];
  for (
    let w = activeWord - searchWordsEachSide;
    w <= activeWord + searchWordsEachSide;
    w++
  )
    wordPositions.push(w);
  const bitmaps: Record<number, BigNumber> = {};
  const res = await Promise.all(wordPositions.map((w) => pool.tickBitmap(w)));
  res.forEach((bm, i) => {
    bitmaps[wordPositions[i]] = bm as BigNumber;
  });

  // scan right
  let rightTick: number | null = null;
  {
    let w = activeWord,
      start = activeBit + 1;
    for (; w <= activeWord + searchWordsEachSide; w++) {
      const bm = bitmaps[w] ?? BigNumber.from(0);
      if (!bm.isZero())
        for (let b = start; b <= 255; b++)
          if (isBitSet(bm, b)) {
            rightTick = ((w << 8) | b) * tickSpacing;
            w = 1e9;
            break;
          }
      start = 0;
    }
  }
  // scan left
  let leftTick: number | null = null;
  {
    let w = activeWord,
      start = activeBit - 1;
    for (; w >= activeWord - searchWordsEachSide; w--) {
      const bm = bitmaps[w] ?? BigNumber.from(0);
      if (!bm.isZero())
        for (let b = start; b >= 0; b--)
          if (isBitSet(bm, b)) {
            leftTick = ((w << 8) | b) * tickSpacing;
            w = -1e9;
            break;
          }
      start = 255;
    }
  }
  return { leftTick, rightTick };
}

/** ===== Main ===== */
async function main() {
  const provider = new ethers.providers.JsonRpcProvider(RPC_HTTP, {
    name: CHAIN_NAME,
    chainId: CHAIN_ID,
  });
  const pool = new ethers.Contract(POOL, UNISWAP_V3_POOL_ABI, provider);
  const erc0 = new ethers.Contract(TOKEN0, ERC20_ABI, provider);
  const erc1 = new ethers.Contract(TOKEN1, ERC20_ABI, provider);

  // CSV headers
  if (!fs.existsSync(OUT_SNAPSHOTS))
    fs.writeFileSync(
      OUT_SNAPSHOTS,
      'timestamp,block,tick,sqrtPriceX96,price_1per0,liquidity,fee,spacing,obCard,leftInitTick,rightInitTick,initDistLeft,initDistRight,twap5m,twap1h,sigma,oracle_quality_flag\n'
    );
  if (!fs.existsSync(OUT_DECISIONS))
    fs.writeFileSync(
      OUT_DECISIONS,
      'timestamp,action,reason,tick,twap1h,tickLower,tickUpper,W,B,D,initDistMin\n'
    );
  if (!fs.existsSync(OUT_SIGNALS))
    fs.writeFileSync(
      OUT_SIGNALS,
      'timestamp,signal,reason,tick,price,twapDriftTicks,trend,posDistMin,W,B,D,lowerReco,upperReco\n'
    );
  if (!fs.existsSync(OUT_EVENTS))
    fs.writeFileSync(
      OUT_EVENTS,
      'timestamp,positionId,action,reason,tick,price,positionRange,distance,entryPrice,amountUsd,feesEarned,timeHeld\n'
    );

  // Ensure data directory exists
  if (!fs.existsSync('./data')) {
    fs.mkdirSync('./data', { recursive: true });
  }

  const dec0 = await erc0.decimals(),
    dec1 = await erc1.decimals();
  const sym0 = await erc0.symbol(),
    sym1 = await erc1.symbol();

  async function once() {
    const block = await provider.getBlock('latest');

    // core reads
    const [slot0, L_global, fee, spacing] = await Promise.all([
      pool.slot0(),
      pool.liquidity(),
      pool.fee(),
      pool.tickSpacing(),
    ]);
    const tick: number = slot0[1]; // slot0.tick
    const sqrtPriceX96: BigNumber = slot0[0]; // slot0.sqrtPriceX96
    const price = priceFromSqrtX96(sqrtPriceX96, dec0, dec1);
    const obCard: number = slot0[3]; // observationCardinality

    // TWAP & sigma (proxy)
    let twap5mTick: number | undefined,
      twap1hTick: number | undefined,
      sigma = 0;
    let twapDrift: number | undefined = undefined;
    try {
      const ob = await pool.observe([0, 300, 3600]);
      const tCum = ob[0] as BigNumber[];
      const tick5m = tCum[0].sub(tCum[1]).div(300).toNumber();
      const tick1h = tCum[0].sub(tCum[2]).div(3600).toNumber();
      twap5mTick = tick5m;
      twap1hTick = tick1h;
      twapDrift = Math.abs(tick5m - tick1h);
      sigma = twapDrift * LOG_1P0001; // log-vol proxy
    } catch {
      /* oracle có thể chưa đủ quan sát */
    }

    // nearest initialized ticks (mật độ LP)
    const { leftTick, rightTick } = await findNearestInitializedTicks(
      pool,
      tick,
      spacing,
      SEARCH_WORDS
    );
    const initDistLeft = leftTick !== null ? tick - leftTick : undefined;
    const initDistRight = rightTick !== null ? rightTick - tick : undefined;
    const initDistMin = Math.min(
      initDistLeft ?? Infinity,
      initDistRight ?? Infinity
    );

    // band đề xuất quanh TWAP1h (fallback current tick)
    const center = typeof twap1hTick === 'number' ? twap1hTick : tick;
    const W = widthFromSigma(sigma, T_HOURS, Z_CONF, spacing);
    const B = bufferB(W, spacing);
    const D = dangerD(W, spacing);
    const lowerReco = roundDownToSpacing(center - Math.floor(W / 2), spacing);
    const upperReco = lowerReco + W;

    // Trend theo W (ổn định hơn spacing)
    const TREND_THRESH = Math.max(spacing, Math.floor(0.2 * W));
    const trendLabel =
      twapDrift === undefined
        ? 'unknown'
        : twapDrift < TREND_THRESH
        ? 'sideways'
        : 'trending';

    // Action cơ học (nếu user set POSITION_LOWER/UPPER)
    let action = 'PROPOSE_MINT',
      reason = 'no current position; propose mint';
    let tickLowerOut = lowerReco,
      tickUpperOut = upperReco;
    if (POSITION_LOWER !== undefined && POSITION_UPPER !== undefined) {
      tickLowerOut = POSITION_LOWER;
      tickUpperOut = POSITION_UPPER;
      if (tick < POSITION_LOWER || tick > POSITION_UPPER) {
        action = 'REBUILD_AROUND_TWAP';
        reason = 'price left your range';
      } else {
        const dLow = tick - POSITION_LOWER,
          dUp = POSITION_UPPER - tick;
        const posDistMin = Math.min(dLow, dUp);
        if (posDistMin < D) {
          action = 'WITHDRAW_IF_FEES_MINUS_GAS<0';
          reason = `near edge (<D=${D})`;
        } else if (posDistMin >= B) {
          action = 'KEEP';
          reason = `distance >= B=${B}`;
        } else {
          action = 'NEUTRAL_HOLD';
          reason = 'between D and B';
        }
      }
    }

    // ===== Signals dựa STATE đang giữ (không "ADD luôn")
    const stNow = loadState();
    const activePositions = getActivePositions(stNow);
    let addGood = false,
      addWhy = '';
    let withdrawGood = false,
      withdrawWhy = '';
    let posDistMinForLog: number | '' = '';

    if (activePositions.length === 0) {
      addGood = true;
      addWhy = 'Chưa có vị thế — mở dải quanh TWAP đề xuất';
    } else {
      // Check if any position needs attention
      let minDistance = Infinity;
      for (const pos of activePositions) {
        const distance = calculatePositionDistance(tick, pos);
        if (distance === -1) {
          withdrawGood = true;
          withdrawWhy = 'Giá đã ra khỏi dải — nên đóng/reposition';
          break;
        } else if (distance < D) {
          withdrawGood = true;
          withdrawWhy = `Giá sát biên (dist < D=${D}) — nên đóng để tránh IL`;
          break;
        } else if (distance >= B && trendLabel === 'sideways') {
          addGood = true;
          addWhy = 'Vị thế an toàn (≥B) & sideways — có thể bổ sung';
        }
        minDistance = Math.min(minDistance, distance);
      }
      posDistMinForLog = minDistance === Infinity ? '' : minDistance;
    }
    const writeSignal = (signal: string, why: string) => {
      const row =
        [
          new Date(block.timestamp * 1000).toISOString(),
          signal,
          why,
          tick,
          price,
          twapDrift ?? '',
          trendLabel,
          posDistMinForLog,
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

    // ===== Advanced Position Management System =====
    if (SIM_MODE) {
      const state = loadState();
      const activePositions = getActivePositions(state);

      console.log(
        `\n📊 PORTFOLIO STATUS: ${activePositions.length}/${
          state.maxPositions
        } positions, $${state.totalUsdInvested.toFixed(0)}/${
          state.totalUsdLimit
        } invested`
      );

      // 1. Check existing positions for close/hold decisions
      for (const position of activePositions) {
        const distance = calculatePositionDistance(tick, position);
        const feesEarned = calculateFeesEarned(position, tick, price);

        if (shouldClosePosition(tick, position, D)) {
          // Close position
          position.status = 'closed';
          position.feesEarned = feesEarned;
          state.totalUsdInvested -= position.amountUsd;

          const reason =
            distance === -1
              ? 'Giá ra khỏi dải — đóng vị thế'
              : `Giá sát biên (dist=${distance} < D=${D}) — đóng để tránh IL`;

          logPositionDecision(
            position,
            'CLOSE',
            reason,
            tick,
            price,
            distance,
            feesEarned
          );
        } else if (shouldHoldPosition(tick, position, B)) {
          // Hold position
          position.feesEarned = feesEarned;
          logPositionDecision(
            position,
            'HOLD',
            `An toàn (dist=${distance} >= B=${B}) — tiếp tục giữ`,
            tick,
            price,
            distance,
            feesEarned
          );
        } else {
          // Neutral zone - monitor closely
          position.feesEarned = feesEarned;
          logPositionDecision(
            position,
            'MONITOR',
            `Vùng trung tính (${distance} tick) — theo dõi`,
            tick,
            price,
            distance,
            feesEarned
          );
        }
      }

      // 2. Check if we can add new position
      const amountUsd = Math.min(
        state.maxUsdPerPosition,
        state.totalUsdLimit - state.totalUsdInvested
      );

      if (canAddPosition(state, amountUsd) && addGood) {
        // Add new position
        const newPosition: Position = {
          id: generatePositionId(),
          lower: lowerReco,
          upper: upperReco,
          enteredAt: new Date(block.timestamp * 1000).toISOString(),
          entryTick: tick,
          entryPrice: price,
          amountUsd: amountUsd,
          status: 'active',
          feesEarned: 0,
          rebalanceCount: 0,
        };

        state.positions.push(newPosition);
        state.totalUsdInvested += amountUsd;

        logPositionDecision(newPosition, 'ADD', addWhy, tick, price, 0, 0);
      }

      // 3. Save updated state
      saveState(state);

      // 4. Portfolio summary
      const totalFees = state.positions.reduce(
        (sum, p) => sum + p.feesEarned,
        0
      );
      const activeCount = getActivePositions(state).length;

      console.log(`💰 PORTFOLIO SUMMARY:`);
      console.log(
        `   • Active positions: ${activeCount}/${state.maxPositions}`
      );
      console.log(
        `   • Total invested: $${state.totalUsdInvested.toFixed(0)}/${
          state.totalUsdLimit
        }`
      );
      console.log(`   • Total fees earned: $${totalFees.toFixed(2)}`);
      console.log(
        `   • Available capacity: $${(
          state.totalUsdLimit - state.totalUsdInvested
        ).toFixed(0)}`
      );
    }

    // ===== CSV snapshots & decisions
    const oracleQuality = obCard >= 8 ? 'ok' : 'low';
    const snap =
      [
        new Date(block.timestamp * 1000).toISOString(),
        block.number,
        tick,
        sqrtPriceX96.toString(),
        price,
        (await pool.liquidity()).toString(),
        fee,
        spacing,
        obCard,
        leftTick ?? '',
        rightTick ?? '',
        initDistLeft ?? '',
        initDistRight ?? '',
        twap5mTick ?? '',
        twap1hTick ?? '',
        sigma,
        oracleQuality,
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
        initDistMin,
      ].join(',') + '\n';
    fs.appendFileSync(OUT_DECISIONS, decision);

    // ===== Console logs
    console.log(
      `[${new Date().toISOString()}] ${sym0}/${sym1} fee=${
        fee / 10000
      }% spacing=${spacing} | tick=${tick} price=${price.toFixed(
        6
      )} | reco=[${lowerReco},${upperReco}] W=${W} B=${B} D=${D} | trend=${trendLabel}`
    );

    if (HUMAN_LOG) {
      const priceLine = `• Giá hiện tại: 1 ${sym1} ≈ ${fmt(price, 6)} ${sym0}`;
      const twapLine =
        twap5mTick !== undefined && twap1hTick !== undefined
          ? `• TWAP 5m vs 1h (tick): ${twap5mTick} vs ${twap1hTick} → chênh: ${twapDrift} tick (${trendLabel})`
          : '• TWAP: chưa đủ dữ liệu';
      const edgesLine = `• Tick đã khởi tạo gần nhất: trái=${
        leftTick ?? 'không có'
      } | phải=${rightTick ?? 'không có'}; khoảng cách: trái=${
        initDistLeft ?? '-'
      } | phải=${initDistRight ?? '-'}`;
      const bandLine = `• Dải đề xuất quanh TWAP1h: [${lowerReco}, ${upperReco}] (W=${W} tick)`;
      const safetyLine = `• Vùng an toàn (B): ${B} | Ngưỡng cảnh báo (D): ${D} | Oracle: ${oracleQuality}`;
      const st = loadState();
      const activePositions = getActivePositions(st);
      const simLine = SIM_MODE
        ? activePositions.length > 0
          ? `• Mô phỏng: ${
              activePositions.length
            } vị thế đang hoạt động ($${st.totalUsdInvested.toFixed(0)}/${
              st.totalUsdLimit
            })`
          : '• Mô phỏng: CHƯA CÓ VỊ THẾ'
        : '• Mô phỏng: tắt';
      const concl = `→ Kết luận: ${action} — ${reason}`;
      console.log(
        [
          '\n================= Gợi ý dễ hiểu =================',
          `Cặp: ${sym0}/${sym1} | Fee: ${
            fee / 10000
          }% | spacing: ${spacing} tick`,
          priceLine,
          twapLine,
          edgesLine,
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
