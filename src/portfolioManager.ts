// portfolioManager.ts — Portfolio management and decision logic

import { Position, SimState } from './types.js';
import {
  calculateLiquidity,
  calculateCurrentPositionValue,
  calculateFeesEarned,
  calculateImpermanentLoss,
  calculatePositionDistance,
  shouldClosePosition,
  shouldHoldPosition,
  shouldRebalancePosition,
  calculatePortfolioMetrics,
} from './calculations.js';
import { calculateTimeHeld } from './utils.js';
import {
  loadState,
  saveState,
  canAddPosition,
  getActivePositions,
  createNewPosition,
  logPositionDecision,
} from './stateManager.js';
import { roundDownToSpacing } from './utils.js';

export class PortfolioManager {
  private state: SimState;

  constructor() {
    this.state = loadState();
  }

  async processPositions(
    tick: number,
    price: number,
    dec0: number,
    dec1: number,
    globalLiquidity: number,
    fee: number,
    W: number,
    B: number,
    D: number,
    spacing: number,
    lowerReco: number,
    upperReco: number
  ): Promise<void> {
    const activePositions = getActivePositions(this.state);

    console.log(
      `\n📊 PORTFOLIO STATUS: ${activePositions.length}/${
        this.state.maxPositions
      } positions, $${this.state.totalUsdInvested.toFixed(0)}/${
        this.state.totalUsdLimit
      } invested`
    );

    // Log detailed position analysis
    if (activePositions.length > 0) {
      console.log(`\n🔍 POSITION ANALYSIS:`);
      activePositions.forEach((pos, i) => {
        const distance = calculatePositionDistance(tick, pos);
        const inRange = distance !== -1;
        const status = inRange
          ? distance >= B
            ? '🟢 SAFE'
            : distance >= D
            ? '🟡 WARNING'
            : '🔴 DANGER'
          : '❌ OUT_OF_RANGE';

        console.log(
          `   ${i + 1}. ${pos.id.slice(
            -8
          )} | ${status} | Dist: ${distance} | Value: $${pos.currentValue.toFixed(
            0
          )} | Return: ${pos.totalReturn.toFixed(2)}%`
        );
      });
    }

    // Process existing positions
    for (const position of activePositions) {
      await this.processExistingPosition(
        position,
        tick,
        price,
        dec0,
        dec1,
        globalLiquidity,
        fee,
        W,
        B,
        D,
        spacing
      );
    }

    // Check if we can add new position
    await this.checkForNewPosition(
      tick,
      price,
      dec0,
      dec1,
      W,
      B,
      lowerReco,
      upperReco
    );

    // Calculate and save metrics
    calculatePortfolioMetrics(this.state);
    saveState(this.state);

    // Display portfolio summary
    this.displayPortfolioSummary();
  }

  private async processExistingPosition(
    position: Position,
    tick: number,
    price: number,
    dec0: number,
    dec1: number,
    globalLiquidity: number,
    fee: number,
    W: number,
    B: number,
    D: number,
    spacing: number
  ): Promise<void> {
    const distance = calculatePositionDistance(tick, position);
    const feesEarned = calculateFeesEarned(
      position,
      tick,
      price,
      globalLiquidity,
      fee
    );
    const currentValue = calculateCurrentPositionValue(
      position,
      price,
      tick,
      dec0,
      dec1
    );
    const impermanentLoss = calculateImpermanentLoss(
      position.entryPrice,
      price
    );
    const totalReturn =
      ((currentValue + feesEarned - position.amountUsd) / position.amountUsd) *
      100;

    // Update position metrics
    position.feesEarned = feesEarned;
    position.currentValue = currentValue;
    position.impermanentLoss = impermanentLoss;
    position.totalReturn = totalReturn;
    position.lastUpdateAt = new Date().toISOString();

    if (shouldClosePosition(tick, position, D)) {
      console.log(`\n🚨 CLOSING POSITION: ${position.id.slice(-8)}`);
      console.log(
        `   • Reason: ${
          distance === -1
            ? 'Price out of range'
            : `Distance ${distance} < D ${D}`
        }`
      );
      console.log(
        `   • Value: $${currentValue.toFixed(
          2
        )} | Return: ${totalReturn.toFixed(2)}% | Fees: $${feesEarned.toFixed(
          2
        )}`
      );

      await this.closePosition(
        position,
        tick,
        price,
        distance,
        feesEarned,
        currentValue,
        impermanentLoss,
        totalReturn
      );
    } else if (shouldRebalancePosition(position, tick, price, W, B)) {
      console.log(`\n🔄 REBALANCING POSITION: ${position.id.slice(-8)}`);
      console.log(
        `   • Reason: Distance ${distance} < B/2 ${Math.floor(
          B / 2
        )} or significant price change`
      );
      console.log(`   • Current range: [${position.lower}, ${position.upper}]`);

      await this.rebalancePosition(
        position,
        tick,
        price,
        dec0,
        dec1,
        spacing,
        W,
        distance,
        feesEarned,
        currentValue,
        impermanentLoss,
        totalReturn
      );
    } else if (shouldHoldPosition(tick, position, B)) {
      console.log(`\n✅ HOLDING POSITION: ${position.id.slice(-8)}`);
      console.log(`   • Reason: Safe distance ${distance} >= B ${B}`);
      console.log(
        `   • Value: $${currentValue.toFixed(
          2
        )} | Return: ${totalReturn.toFixed(2)}% | Fees: $${feesEarned.toFixed(
          2
        )}`
      );

      logPositionDecision(
        position,
        'HOLD',
        `An toàn (dist=${distance} >= B=${B}) — tiếp tục giữ`,
        tick,
        price,
        distance,
        feesEarned,
        currentValue,
        impermanentLoss,
        totalReturn
      );
    } else {
      console.log(`\n👀 MONITORING POSITION: ${position.id.slice(-8)}`);
      console.log(
        `   • Reason: Neutral zone (${distance} tick) - watching closely`
      );
      console.log(
        `   • Value: $${currentValue.toFixed(
          2
        )} | Return: ${totalReturn.toFixed(2)}% | Fees: $${feesEarned.toFixed(
          2
        )}`
      );

      logPositionDecision(
        position,
        'MONITOR',
        `Vùng trung tính (${distance} tick) — theo dõi`,
        tick,
        price,
        distance,
        feesEarned,
        currentValue,
        impermanentLoss,
        totalReturn
      );
    }
  }

  private async closePosition(
    position: Position,
    tick: number,
    price: number,
    distance: number,
    feesEarned: number,
    currentValue: number,
    impermanentLoss: number,
    totalReturn: number
  ): Promise<void> {
    position.status = 'closed';
    position.lastUpdateAt = new Date().toISOString();

    // Update final values
    position.currentValue = currentValue;
    position.feesEarned = feesEarned;
    position.impermanentLoss = impermanentLoss;
    position.totalReturn = totalReturn;

    // Calculate final P&L
    const finalValue = currentValue + feesEarned;
    const pnl = finalValue - position.amountUsd;
    const pnlPercent = (pnl / position.amountUsd) * 100;

    // Update total invested (subtract original amount)
    this.state.totalUsdInvested -= position.amountUsd;

    // Add to total fees earned
    this.state.totalFeesEarned += feesEarned;

    // Add gas cost for closing position
    this.state.totalGasSpent += this.state.gasCostPerTransaction;

    // Calculate time held
    const timeHeld = calculateTimeHeld(position.enteredAt);

    const reason =
      distance === -1
        ? 'Giá ra khỏi dải — đóng vị thế'
        : `Giá sát biên (dist=${distance}) — đóng để tránh IL`;

    console.log(`\n🚨 CLOSING POSITION: ${position.id.slice(-8)}`);
    console.log(`   • Reason: ${reason}`);
    console.log(`   • Original: $${position.amountUsd.toFixed(2)}`);
    console.log(
      `   • Final Value: $${finalValue.toFixed(2)} (${pnlPercent.toFixed(2)}%)`
    );
    console.log(`   • Fees Earned: $${feesEarned.toFixed(2)}`);
    console.log(`   • Impermanent Loss: ${impermanentLoss.toFixed(2)}%`);
    console.log(`   • Time Held: ${timeHeld.toFixed(1)} hours`);
    console.log(`   • Rebalances: ${position.rebalanceCount}`);

    logPositionDecision(
      position,
      'CLOSE',
      reason,
      tick,
      price,
      distance,
      feesEarned,
      currentValue,
      impermanentLoss,
      totalReturn
    );
  }

  private async rebalancePosition(
    position: Position,
    tick: number,
    price: number,
    dec0: number,
    dec1: number,
    spacing: number,
    W: number,
    distance: number,
    feesEarned: number,
    currentValue: number,
    impermanentLoss: number,
    totalReturn: number
  ): Promise<void> {
    position.rebalanceCount++;
    position.lastRebalanceAt = new Date().toISOString();

    // Calculate new range around current price
    const newLower = roundDownToSpacing(tick - Math.floor(W / 2), spacing);
    const newUpper = newLower + W;

    // Calculate current position value to determine new allocation
    const currentPositionValue = calculateCurrentPositionValue(
      position,
      price,
      tick,
      dec0,
      dec1
    );

    // Use current value + fees earned as new amount for rebalancing
    const newAmountUsd = Math.max(
      currentPositionValue + feesEarned,
      position.amountUsd * 0.8 // At least 80% of original amount
    );

    // Update position range around current price
    position.lower = newLower;
    position.upper = newUpper;
    position.entryTick = tick;
    position.entryPrice = price;
    position.amountUsd = newAmountUsd;

    // Recalculate liquidity for new range
    const { liquidity, token0Amount, token1Amount } = calculateLiquidity(
      newAmountUsd,
      price,
      newLower,
      newUpper,
      dec0,
      dec1
    );
    position.liquidity = liquidity;
    position.token0Amount = token0Amount;
    position.token1Amount = token1Amount;

    // Reset fees earned after rebalancing
    position.feesEarned = 0;

    // Add gas cost for rebalancing
    this.state.totalGasSpent += this.state.gasCostPerTransaction;

    console.log(`\n🔄 REBALANCING POSITION: ${position.id.slice(-8)}`);
    console.log(`   • Old range: [${position.lower}, ${position.upper}]`);
    console.log(`   • New range: [${newLower}, ${newUpper}]`);
    console.log(
      `   • New amount: $${newAmountUsd.toFixed(
        2
      )} (was $${position.amountUsd.toFixed(2)})`
    );
    console.log(`   • New liquidity: ${liquidity.toFixed(2)}`);
    console.log(
      `   • Token0: ${token0Amount.toFixed(2)} | Token1: ${token1Amount.toFixed(
        6
      )}`
    );

    logPositionDecision(
      position,
      'REBALANCE',
      `Rebalance vị thế (lần ${
        position.rebalanceCount
      }) — cập nhật dải [${newLower}, ${newUpper}] với $${newAmountUsd.toFixed(
        2
      )}`,
      tick,
      price,
      distance,
      feesEarned,
      currentValue,
      impermanentLoss,
      totalReturn
    );
  }

  private async checkForNewPosition(
    tick: number,
    price: number,
    dec0: number,
    dec1: number,
    W: number,
    B: number,
    lowerReco: number,
    upperReco: number
  ): Promise<void> {
    const activePositions = getActivePositions(this.state);

    // Don't add new position if we're at max capacity
    if (activePositions.length >= this.state.maxPositions) {
      console.log(
        `\n🚫 MAX POSITIONS REACHED: ${activePositions.length}/${this.state.maxPositions}`
      );
      return;
    }

    // Calculate available amount (max 2k per position, max 5 positions = 10k total)
    const availableAmount =
      this.state.totalUsdLimit - this.state.totalUsdInvested;
    const amountUsd = Math.min(this.state.maxUsdPerPosition, availableAmount);

    if (amountUsd < 500) {
      // Minimum 500$ to add position
      console.log(
        `\n💰 INSUFFICIENT FUNDS: $${availableAmount.toFixed(
          0
        )} available, need at least $500`
      );
      return;
    }

    // Check if we should add a new position
    let shouldAdd = false;
    let addReason = '';

    // Check if we recently closed a position (within last 10 minutes)
    // Only check if we have existing positions
    if (activePositions.length > 0) {
      const recentCloseTime = Date.now() - 10 * 60 * 1000; // 10 minutes ago
      let recentlyClosed = false;
      for (const pos of this.state.positions) {
        if (
          pos.status === 'closed' &&
          new Date(pos.lastUpdateAt).getTime() > recentCloseTime
        ) {
          recentlyClosed = true;
          break;
        }
      }

      // Don't add if we recently closed a position
      if (recentlyClosed) {
        console.log(`\n⏸️  SKIPPING NEW POSITION:`);
        console.log(
          `   • Reason: Recently closed position - waiting for better opportunity`
        );
        return;
      }
    }

    if (activePositions.length === 0) {
      // No positions yet - always add first position
      shouldAdd = true;
      addReason = 'Chưa có vị thế — mở dải quanh TWAP đề xuất';
    } else {
      // Check if current price is in a good position to add
      let allPositionsSafe = true;
      let minDistance = Infinity;
      let overlappingPositions = 0;
      let totalRisk = 0;

      for (const pos of activePositions) {
        const distance = calculatePositionDistance(tick, pos);
        if (distance === -1) {
          // Price out of range for any position - don't add
          console.log(`\n⏸️  SKIPPING NEW POSITION:`);
          console.log(`   • Reason: Price out of range for existing position`);
          return;
        } else if (distance < B) {
          allPositionsSafe = false;
          totalRisk += (B - distance) / B; // Risk score
        }
        minDistance = Math.min(minDistance, distance);

        // Check for overlapping ranges
        if (tick >= pos.lower && tick <= pos.upper) {
          overlappingPositions++;
        }
      }

      // Calculate market conditions
      const marketVolatility = this.calculateMarketVolatility(activePositions);
      const portfolioHealth = this.calculatePortfolioHealth(activePositions);

      // Only add if:
      // 1. All existing positions are safe (distance >= B) OR low risk
      // 2. No overlapping positions at current price
      // 3. We have enough distance from existing positions
      // 4. Market conditions are favorable
      if (
        (allPositionsSafe || totalRisk < 0.3) &&
        overlappingPositions === 0 &&
        minDistance >= B * 2 && // Need more distance
        marketVolatility < 0.2 && // Very low volatility
        portfolioHealth > 0.8 // Very good portfolio health
      ) {
        shouldAdd = true;
        addReason = `Điều kiện tốt (min dist=${minDistance} >= ${
          B * 2
        }, vol=${marketVolatility.toFixed(2)}, health=${portfolioHealth.toFixed(
          2
        )}) — có thể bổ sung`;
      } else {
        console.log(`\n⏸️  SKIPPING NEW POSITION:`);
        console.log(`   • Reason: Conditions not met:`);
        console.log(
          `     - All safe: ${allPositionsSafe} (risk: ${totalRisk.toFixed(2)})`
        );
        console.log(
          `     - No overlap: ${
            overlappingPositions === 0
          } (overlaps: ${overlappingPositions})`
        );
        console.log(
          `     - Distance: ${minDistance} >= ${B * 2} (${
            minDistance >= B * 2
          })`
        );
        console.log(
          `     - Volatility: ${marketVolatility.toFixed(2)} < 0.2 (${
            marketVolatility < 0.2
          })`
        );
        console.log(
          `     - Health: ${portfolioHealth.toFixed(2)} > 0.8 (${
            portfolioHealth > 0.8
          })`
        );
      }
    }

    if (shouldAdd && canAddPosition(this.state, amountUsd)) {
      console.log(`\n➕ ADDING NEW POSITION:`);
      console.log(
        `   • Amount: $${amountUsd} | Range: [${lowerReco}, ${upperReco}]`
      );
      console.log(`   • Reason: ${addReason}`);

      const { liquidity, token0Amount, token1Amount } = calculateLiquidity(
        amountUsd,
        price,
        lowerReco,
        upperReco,
        dec0,
        dec1
      );

      const newPosition = createNewPosition(
        lowerReco,
        upperReco,
        tick,
        price,
        amountUsd,
        liquidity,
        token0Amount,
        token1Amount,
        Date.now() / 1000
      );

      this.state.positions.push(newPosition);
      this.state.totalUsdInvested += amountUsd;
      this.state.totalGasSpent += this.state.gasCostPerTransaction;

      console.log(
        `   • Token0 (USDC): ${token0Amount.toFixed(
          2
        )} | Token1 (ETH): ${token1Amount.toFixed(6)}`
      );
      console.log(
        `   • Liquidity: ${liquidity.toFixed(
          2
        )} | Position ID: ${newPosition.id.slice(-8)}`
      );
      console.log(`   • Gas Cost: $${this.state.gasCostPerTransaction}`);

      logPositionDecision(
        newPosition,
        'ADD',
        addReason,
        tick,
        price,
        0,
        0,
        amountUsd,
        0,
        0
      );
    } else if (activePositions.length < this.state.maxPositions) {
      console.log(`\n⏸️  SKIPPING NEW POSITION:`);
      console.log(
        `   • Reason: ${
          !shouldAdd ? 'Conditions not met for adding' : 'Insufficient funds'
        }`
      );
      console.log(
        `   • Available: $${availableAmount.toFixed(
          0
        )} | Required: $${amountUsd}`
      );
    }
  }

  private displayPortfolioSummary(): void {
    const activeCount = getActivePositions(this.state).length;
    const totalCurrentValue = this.state.positions
      .filter((p) => p.status === 'active')
      .reduce((sum, p) => sum + (p.currentValue || 0), 0);
    const totalUnrealizedPnL = totalCurrentValue - this.state.totalUsdInvested;
    const totalRealizedPnL = this.state.positions
      .filter((p) => p.status === 'closed')
      .reduce(
        (sum, p) => {
          const finalValue = (p.currentValue || 0) + (p.feesEarned || 0);
          return sum + (finalValue - p.amountUsd);
        },
        0
      );

    const unrealizedPnLPercent =
      this.state.totalUsdInvested > 0
        ? (totalUnrealizedPnL / this.state.totalUsdInvested) * 100
        : 0;

    console.log(`\n💰 PORTFOLIO SUMMARY:`);
    console.log(
      `   • Active positions: ${activeCount}/${this.state.maxPositions}`
    );
    console.log(
      `   • Total invested: $${this.state.totalUsdInvested.toFixed(0)}/${
        this.state.totalUsdLimit
      }`
    );
    console.log(`   • Current value: $${totalCurrentValue.toFixed(0)}`);
    console.log(
      `   • Unrealized P&L: $${totalUnrealizedPnL.toFixed(
        2
      )} (${unrealizedPnLPercent.toFixed(2)}%)`
    );
    console.log(`   • Realized P&L: $${totalRealizedPnL.toFixed(2)}`);
    console.log(
      `   • Total fees earned: $${this.state.totalFeesEarned.toFixed(2)}`
    );
    console.log(
      `   • Total gas spent: $${this.state.totalGasSpent.toFixed(2)}`
    );
    console.log(
      `   • Net fees (after gas): $${(
        this.state.totalFeesEarned - this.state.totalGasSpent
      ).toFixed(2)}`
    );
    console.log(
      `   • Total impermanent loss: ${this.state.totalImpermanentLoss.toFixed(
        2
      )}%`
    );
    console.log(`   • Win rate: ${this.state.winRate.toFixed(1)}%`);
    console.log(
      `   • Avg position duration: ${this.state.averagePositionDuration.toFixed(
        1
      )}h`
    );
    console.log(
      `   • Available capacity: $${(
        this.state.totalUsdLimit - this.state.totalUsdInvested
      ).toFixed(0)}`
    );

    // Detailed position breakdown
    if (activeCount > 0) {
      console.log(`\n📊 ACTIVE POSITIONS:`);
      this.state.positions
        .filter((p) => p.status === 'active')
        .forEach((pos, i) => {
          const timeHeld = Math.round(
            (Date.now() - new Date(pos.enteredAt).getTime()) / (1000 * 60 * 60)
          );
          const status =
            pos.totalReturn > 5 ? '🟢' : pos.totalReturn > 0 ? '🟡' : '🔴';
          console.log(
            `   ${i + 1}. ${pos.id.slice(-8)} | Range: [${pos.lower}, ${
              pos.upper
            }] | Value: $${pos.currentValue.toFixed(
              0
            )} | Return: ${pos.totalReturn.toFixed(
              2
            )}% ${status} | IL: ${pos.impermanentLoss.toFixed(
              2
            )}% | Fees: $${pos.feesEarned.toFixed(2)} | Held: ${timeHeld}h`
          );
        });
    }
  }

  private calculateMarketVolatility(positions: Position[]): number {
    if (positions.length < 2) return 0;

    const returns = positions.map((p) => p.totalReturn);
    const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;
    const variance =
      returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) /
      returns.length;
    return Math.sqrt(variance) / 100; // Convert to decimal
  }

  private calculatePortfolioHealth(positions: Position[]): number {
    if (positions.length === 0) return 1;

    const healthyPositions = positions.filter((p) => p.totalReturn > -5).length;
    return healthyPositions / positions.length;
  }

  // Public methods for main.ts
  getActivePositionsCount(): number {
    return getActivePositions(this.state).length;
  }

  getTotalInvested(): number {
    return this.state.totalUsdInvested;
  }

  getPortfolioSummary() {
    return {
      activePositions: this.getActivePositionsCount(),
      totalInvested: this.getTotalInvested(),
      totalUsdLimit: this.state.totalUsdLimit,
      maxPositions: this.state.maxPositions,
      totalFeesEarned: this.state.totalFeesEarned,
      totalReturn: this.state.totalReturn,
      winRate: this.state.winRate,
    };
  }
}
