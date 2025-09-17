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
  'function ticks(int24 tick) view returns (uint128 liquidityGross,int128 liquidityNet,uint256 feeGrowthOutside0X128,uint256 feeGrowthOutside1X128,int56 tickCumulativeOutside,uint160 secondsPerLiquidityOutsideX128,uint32 secondsOutside,bool initialized)',
  'function tickBitmap(int16 wordPosition) view returns (uint256)',
  'function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives,uint160[] secondsPerLiquidityCumulativeX128s)',
] as const;

// Minimal ERC20
const ERC20_ABI = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
] as const;

/** ===== Helpers for human-readable output ===== */
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

/** ===== Math helpers ===== */
const LOG_1P0001 = Math.log(1.0001);
function x96ToPrice(
  sqrtPriceX96: BigNumber,
  dec0: number,
  dec1: number
): number {
  // price of 1 token1 in token0 (i.e., TOKEN0 per TOKEN1)
  const num = sqrtPriceX96.mul(sqrtPriceX96); // Q192
  const Q192 = BigNumber.from(2).pow(192);
  const ratio = Number(num.toString()) / Number(Q192.toString()); // JS double – ok for logging
  const scale = 10 ** (dec0 - dec1);
  return ratio * scale;
}

function roundDownToSpacing(tick: number, spacing: number) {
  let t = Math.floor(tick / spacing) * spacing;
  // handle negatives like solidity's floorDiv
  if (tick < 0 && tick % spacing !== 0) t -= spacing;
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
  // bm is uint256
  const mask = BigNumber.from(1).shl(bit);
  return !bm.and(mask).isZero();
}

/** ====== Config ====== */
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

const INTERVAL_SEC = Number(process.env.INTERVAL_SEC ?? 0); // 0 = run once
const HUMAN_LOG = (process.env.HUMAN_LOG ?? '1') !== '0'; // default on

async function main() {
  if (!RPC_HTTP || !POOL || !TOKEN0 || !TOKEN1) {
    console.error('Missing required env. See .env');
    process.exit(1);
  }

  const provider = new ethers.providers.JsonRpcProvider(RPC_HTTP, {
    name: CHAIN_NAME,
    chainId: CHAIN_ID,
  });

  const pool = new ethers.Contract(POOL, UNISWAP_V3_POOL_ABI, provider);
  const erc0 = new ethers.Contract(TOKEN0, ERC20_ABI, provider);
  const erc1 = new ethers.Contract(TOKEN1, ERC20_ABI, provider);

  // headers
  if (!fs.existsSync(OUT_SNAPSHOTS)) {
    fs.writeFileSync(
      OUT_SNAPSHOTS,
      'timestamp,block,tick,sqrtPriceX96,price_1per0,liquidity,fee,spacing,obCard,leftInitTick,rightInitTick,distToLeft,distToRight,twap5m,twap1h,sigma\n'
    );
  }
  if (!fs.existsSync(OUT_DECISIONS)) {
    fs.writeFileSync(
      OUT_DECISIONS,
      'timestamp,action,reason,tick,twap1h,tickLower,tickUpper,W,B,D,distMin\n'
    );
  }
  if (!fs.existsSync(OUT_SIGNALS)) {
    fs.writeFileSync(
      OUT_SIGNALS,
      'timestamp,signal,reason,tick,price,twapDriftTicks,trend,distMin,W,B,D,lowerReco,upperReco\n'
    );
  }

  const dec0 = await erc0.decimals();
  const dec1 = await erc1.decimals();
  const sym0 = await erc0.symbol();
  const sym1 = await erc1.symbol();

  async function once() {
    const block = await provider.getBlock('latest');

    // read core data
    const [slot0, L_global, fee, spacing] = await Promise.all([
      pool.slot0(),
      pool.liquidity(),
      pool.fee(),
      pool.tickSpacing(),
    ]);
    const tick: number = slot0.tick;
    const sqrtPriceX96: BigNumber = slot0.sqrtPriceX96;
    const price = x96ToPrice(sqrtPriceX96, dec0, dec1);

    // TWAPs & simple sigma proxy
    let twap5mTick: number | undefined,
      twap1hTick: number | undefined,
      sigma = 0;
    try {
      const secs = [0, 300, 3600];
      const ob = await pool.observe(secs);
      const tCum = ob.tickCumulatives as BigNumber[];
      const tick5m = tCum[0].sub(tCum[1]).div(300).toNumber();
      const tick1h = tCum[0].sub(tCum[2]).div(3600).toNumber();
      twap5mTick = tick5m;
      twap1hTick = tick1h;
      // crude sigma (per 1h) from TWAP drift
      const dtick = Math.abs(tick5m - tick1h);
      sigma = dtick * LOG_1P0001; // convert ticks -> log-return proxy
      var trendTickDeltaShared: number | undefined = Math.abs(tick5m - tick1h);
    } catch (e) {
      var trendTickDeltaShared: number | undefined = undefined;
      // pool may lack enough observations
    }

    // find nearest initialized ticks around current tick
    const searchWordsEachSide = Number(process.env.SEARCH_WORDS || 8);
    const { leftTick, rightTick } = await findNearestInitializedTicks(
      pool,
      tick,
      spacing,
      searchWordsEachSide
    );
    const distToLeft = leftTick !== null ? tick - leftTick : undefined;
    const distToRight = rightTick !== null ? rightTick - tick : undefined;

    // strategy params & proposed band around 1h TWAP (fallback to current tick)
    const center = twap1hTick ?? tick;
    const Z_CONF = 1.28; // ~80% conf
    const T_HOURS = 24; // project over 1 day
    const W = widthFromSigma(sigma, T_HOURS, Z_CONF, spacing);
    const B = bufferB(W, spacing);
    const D = dangerD(W, spacing);

    const lowerReco = roundDownToSpacing(center - Math.floor(W / 2), spacing);
    const upperReco = lowerReco + W;

    // decision logic
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

    // Signals (when to ADD or WITHDRAW)
    const trendLabel =
      trendTickDeltaShared === undefined
        ? 'unknown'
        : trendTickDeltaShared < 2 * spacing
        ? 'sideways'
        : 'trending';

    let addGood = false;
    let addWhy = '';
    // Good to add liquidity if: (a) we currently have no range (propose mint), OR
    // (b) we are in-range with good buffer and market is sideways
    if (action === 'PROPOSE_MINT') {
      addGood = true;
      addWhy = 'Chưa có vị thế, đề xuất mở dải quanh TWAP';
    } else if (
      action === 'KEEP' &&
      Number.isFinite(distMin) &&
      (distMin as number) >= B &&
      trendLabel === 'sideways'
    ) {
      addGood = true;
      addWhy =
        'Vị thế đang an toàn (cách biên ≥ B) và thị trường đang dao động (sideways)';
    }

    let withdrawGood = false;
    let withdrawWhy = '';
    // Good to withdraw if: (a) out-of-range (cần reposition), OR
    // (b) ở sát biên (distMin < D) → rủi ro IL cao
    if (POSITION_LOWER !== undefined && POSITION_UPPER !== undefined) {
      if (tick < POSITION_LOWER || tick > POSITION_UPPER) {
        withdrawGood = true;
        withdrawWhy =
          'Giá đã ra khỏi dải hiện tại — nên rút và dựng dải mới quanh TWAP';
      } else if (Number.isFinite(distMin) && (distMin as number) < D) {
        withdrawGood = true;
        withdrawWhy =
          'Giá đang ở sát biên dải (dist < D) — cân nhắc rút để tránh IL';
      }
    }

    // Write signals
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

    // CSV logs
    const snap =
      [
        new Date(block.timestamp * 1000).toISOString(),
        block.number,
        tick,
        sqrtPriceX96.toString(),
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

    // Simple one-line log (techy)
    console.log(
      `[${new Date().toISOString()}] ${sym0}/${sym1} tick=${tick} spacing=${spacing} fee=${fee} | action=${action} (${reason}) | reco=[${lowerReco},${upperReco}] W=${W} B=${B} D=${D}`
    );

    // Human-friendly log
    if (HUMAN_LOG) {
      const trendTickDelta =
        typeof twap5mTick === 'number' && typeof twap1hTick === 'number'
          ? Math.abs(twap5mTick - twap1hTick)
          : undefined;
      const trendLabel =
        trendTickDelta === undefined
          ? 'chưa đủ dữ liệu'
          : trendTickDelta < 2 * spacing
          ? 'dao động (sideways)'
          : 'có xu hướng (trending)';
      const priceLine = `• Giá hiện tại: 1 ${sym0} ≈ ${fmt(price, 6)} ${sym1} (tick: ${tick})`;
      const twapLine =
        typeof twap5mTick === 'number' && typeof twap1hTick === 'number'
          ? `• TWAP 5m vs 1h (tick): ${twap5mTick} vs ${twap1hTick} → chênh: ${trendTickDelta} tick (${trendLabel})`
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
      const sigs = [] as string[];
      if (addGood) sigs.push('✓ Thời điểm TỐT để THÊM thanh khoản');
      if (withdrawGood) sigs.push('✓ Thời điểm TỐT để RÚT / REPOSITION');
      const sigLine = sigs.length
        ? '• Tín hiệu: ' + sigs.join(' | ')
        : '• Tín hiệu: (không đặc biệt)';
      console.log(
        [
          '\\n================= Gợi ý dễ hiểu =================',
          `Cặp: ${sym0}/${sym1} | Fee: ${
            fee / 10000
          }% | spacing: ${spacing} tick`,
          priceLine,
          twapLine,
          edgesLine,
          volLine,
          bandLine,
          safetyLine,
          concl,
          '=================================================\n',
        ].join('\n')
      );
    }
  }

  // Run once or loop
  if (INTERVAL_SEC > 0) {
    await once();
    setInterval(once, INTERVAL_SEC * 1000);
  } else {
    await once();
    process.exit(0);
  }
}

/** ===== Scan tickBitmap to find nearest initialized ticks ===== */
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
  const calls = wordPositions.map((w) => pool.tickBitmap(w));
  const results = await Promise.all(calls);
  results.forEach((bm, i) => {
    bitmaps[wordPositions[i]] = bm;
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

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

// Notes:
// • HUMAN_LOG=1 (mặc định) sẽ in "Gợi ý dễ hiểu". HUMAN_LOG=0 để tắt.
// • INTERVAL_SEC>0 để chạy lặp. Ví dụ INTERVAL_SEC=30 sẽ log mỗi 30 giây.
// • W (độ rộng đề xuất) dựa trên σ ước lượng thô từ TWAP 5m vs 1h (proxy). Bạn có thể thay bằng observe nhiều mốc để ước lượng σ tốt hơn.
// • Có thể mở rộng đọc feeGrowthGlobal/Outside để tính thêm APR phí trong dải.
