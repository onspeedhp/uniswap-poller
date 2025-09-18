# Katana vbUSDC/vbETH Pool Monitor

Monitor vbUSDC/vbETH pool on Katana network for liquidity farming optimization.

## Features

- Real-time pool data monitoring with v3-sdk integration
- Advanced farming metrics calculation
- Impermanent loss tracking
- Optimal range suggestions based on tick spacing
- Data logging and CSV export
- Pool activity detection

## Setup

1. Install dependencies:
```bash
npm install
```

2. Configure environment:
```bash
cp env.example .env
# Edit .env with your RPC URL
```

3. Start monitoring:
```bash
npm start
```

## Usage

- `npm start` - Start monitoring
- `npm run build` - Build TypeScript
- `npm run dev` - Development mode

## Data Files

- `data/pool-data-YYYY-MM-DD.json` - Pool data logs
- `data/farming-metrics-YYYY-MM-DD.json` - Farming metrics
- `data/pool-data-YYYY-MM-DD.csv` - Pool data CSV export
- `data/farming-metrics-YYYY-MM-DD.csv` - Farming metrics CSV export

## Configuration

Edit `src/config.ts` to:
- Change pool address
- Adjust monitoring interval
- Update token addresses

## Data Quality

The monitor now provides:
- **Tick-based calculations**: Uses Uniswap v3-sdk for accurate tick and price calculations
- **Fee growth tracking**: Monitors trading activity through fee growth
- **Optimal range suggestions**: Based on tick spacing and current position
- **Comprehensive metrics**: Including position value and liquidity utilization

## Analysis Results

Based on current data:
- **Price**: 0.000218 - 0.000219 (0.46% volatility)
- **Liquidity**: Variable (pool is active)
- **Recommendation**: Low volatility pool - good for stable farming with tighter ranges