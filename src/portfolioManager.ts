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
  analyzeMarketTrend,
  shouldAddNewPosition,
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
    spacing: number,
    lowerReco: number,
    upperReco: number,
    twap1h?: number,
    sigma?: number
  ): Promise<void> {
    const activePositions = getActivePositions(this.state);

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
        spacing
      );
    }

    // Check if we can add new position
    await this.checkForNewPosition(
      tick,
      price,
      dec0,
      dec1,
      lowerReco,
      upperReco,
      twap1h,
      sigma
    );

    // Calculate and save metrics
    calculatePortfolioMetrics(this.state);
    saveState(this.state);
  }

  private async processExistingPosition(
    position: Position,
    tick: number,
    price: number,
    dec0: number,
    dec1: number,
    globalLiquidity: number,
    fee: number,
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

    // Determine position recommendation
    let recommendation = 'HOLD';
    let reason = `Safe distance ${distance}`;
    
    if (shouldClosePosition(tick, position, 0)) {
      recommendation = 'WITHDRAW';
      if (distance === -1) {
        reason = 'Price out of range - immediate withdrawal';
      } else if (position.totalReturn < -25) {
        reason = `Stop loss triggered (${totalReturn.toFixed(1)}%)`;
      } else if (position.totalReturn > 40) {
        reason = `Take profit (${totalReturn.toFixed(1)}%)`;
      } else if (position.impermanentLoss > 15) {
        reason = `High impermanent loss (${impermanentLoss.toFixed(1)}%)`;
      } else {
        reason = `Price near edge (${distance} ticks)`;
      }
      
      console.log(
        `\n🚨 WITHDRAW: ${position.id.slice(-8)} | ${reason} | Return: ${totalReturn.toFixed(
          1
        )}% | Value: $${currentValue.toFixed(0)}`
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
    } else if (shouldRebalancePosition(position, tick, price, 0, 0)) {
      recommendation = 'REBALANCE';
      reason = `Price approaching edge (${distance} ticks) - rebalancing needed`;
      
      console.log(
        `\n🔄 REBALANCE: ${position.id.slice(-8)} | Range: [${
          position.lower
        },${position.upper}] | ${reason}`
      );
      await this.rebalancePosition(
        position,
        tick,
        price,
        dec0,
        dec1,
        spacing,
        distance,
        feesEarned,
        currentValue,
        impermanentLoss,
        totalReturn
      );
    } else {
      // Determine hold reason
      if (distance > 20) {
        reason = `Safe distance (${distance} ticks) - strong hold`;
      } else if (distance > 10) {
        reason = `Good distance (${distance} ticks) - hold`;
      } else if (distance > 5) {
        reason = `Moderate distance (${distance} ticks) - monitor closely`;
      } else {
        reason = `Close to edge (${distance} ticks) - watch carefully`;
      }
      
      // Add performance context
      if (totalReturn > 20) {
        reason += ` | Strong performance (${totalReturn.toFixed(1)}%)`;
      } else if (totalReturn > 5) {
        reason += ` | Good performance (${totalReturn.toFixed(1)}%)`;
      } else if (totalReturn < -10) {
        reason += ` | Underperforming (${totalReturn.toFixed(1)}%)`;
      }
      
      console.log(
        `\n✅ HOLD: ${position.id.slice(-8)} | ${reason} | Return: ${totalReturn.toFixed(1)}% | Value: $${currentValue.toFixed(0)}`
      );
      
      logPositionDecision(
        position,
        recommendation,
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

    // Don't subtract from totalUsdInvested when closing - we want to track total capital deployed

    // Add to total fees earned
    this.state.totalFeesEarned += feesEarned;

    // Add gas cost for closing position
    this.state.totalGasSpent += this.state.gasCostPerTransaction;

    // Calculate time held
    const timeHeld = calculateTimeHeld(position.enteredAt);

    const reason =
      distance === -1
        ? 'Price out of range'
        : `Price near edge (dist=${distance})`;

    console.log(
      `   • Final: $${finalValue.toFixed(0)} (${pnlPercent.toFixed(
        1
      )}%) | Fees: $${feesEarned.toFixed(0)} | Time: ${timeHeld.toFixed(0)}h`
    );

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
    distance: number,
    feesEarned: number,
    currentValue: number,
    impermanentLoss: number,
    totalReturn: number
  ): Promise<void> {
    position.rebalanceCount++;
    position.lastRebalanceAt = new Date().toISOString();

    // Calculate new range around current price for vbUSDC/vbETH
    // Use dynamic range width based on volatility and position performance
    let rangeWidth = 40; // Base range width
    
    // Adjust range based on position performance
    if (totalReturn > 20) {
      rangeWidth = 30; // Tighter range for profitable positions
    } else if (totalReturn < -10) {
      rangeWidth = 60; // Wider range for losing positions
    }
    
    // Ensure range is aligned with tick spacing
    rangeWidth = Math.ceil(rangeWidth / spacing) * spacing;
    
    const newLower = roundDownToSpacing(
      tick - Math.floor(rangeWidth / 2),
      spacing
    );
    const newUpper = newLower + rangeWidth;

    // Use current value + fees earned as new amount for rebalancing
    const newAmountUsd = Math.max(
      currentValue + feesEarned,
      position.amountUsd * 0.8 // At least 80% of original amount
    );

    // Recalculate liquidity for new range
    const { liquidity, token0Amount, token1Amount } = calculateLiquidity(
      newAmountUsd,
      price,
      newLower,
      newUpper,
      dec0,
      dec1
    );

    // Update position with new values
    const oldLower = position.lower;
    const oldUpper = position.upper;
    const oldAmount = position.amountUsd;

    position.lower = newLower;
    position.upper = newUpper;
    position.entryTick = tick;
    position.entryPrice = price;
    position.amountUsd = newAmountUsd;
    position.liquidity = liquidity;
    position.token0Amount = token0Amount;
    position.token1Amount = token1Amount;
    position.feesEarned = 0; // Reset fees after rebalancing

    // Add gas cost for rebalancing
    this.state.totalGasSpent += this.state.gasCostPerTransaction;

    console.log(
      `\n🔄 REBALANCING: ${position.id.slice(
        -8
      )} | Range: [${oldLower},${oldUpper}] → [${newLower},${newUpper}] | Amount: $${oldAmount.toFixed(
        0
      )} → $${newAmountUsd.toFixed(0)}`
    );

    logPositionDecision(
      position,
      'REBALANCE',
      `Rebalance position (${
        position.rebalanceCount
      }) - new range [${newLower}, ${newUpper}] with $${newAmountUsd.toFixed(
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
    lowerReco: number,
    upperReco: number,
    twap1h?: number,
    sigma?: number
  ): Promise<void> {
    const activePositions = getActivePositions(this.state);

    // Calculate available amount
    const currentInvested = this.getTotalInvested();
    const availableAmount = this.state.totalUsdLimit - currentInvested;
    const amountUsd = Math.min(this.state.maxUsdPerPosition, availableAmount);

    if (amountUsd < 500) {
      return;
    }

    // Use new signal analysis with risk management
    const signalAnalysis = shouldAddNewPosition(
      tick,
      price,
      twap1h,
      sigma || 0,
      activePositions,
      this.state.maxPositions,
      this.state.totalUsdLimit,
      this.state.maxUsdPerPosition
    );

    // Use recommended size if available, otherwise use calculated amount
    const finalAmount = signalAnalysis.recommendedSize || amountUsd;

    if (signalAnalysis.shouldAdd && canAddPosition(this.state, finalAmount)) {
      console.log(
        `\n➕ ADDING POSITION: $${finalAmount.toFixed(
          0
        )} | Range: [${lowerReco}, ${upperReco}] | ${
          signalAnalysis.reason
        } (Confidence: ${(signalAnalysis.confidence * 100).toFixed(0)}%)`
      );

      const { liquidity, token0Amount, token1Amount } = calculateLiquidity(
        finalAmount,
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
        finalAmount,
        liquidity,
        token0Amount,
        token1Amount,
        Date.now() / 1000
      );

      this.state.positions.push(newPosition);
      this.state.totalGasSpent += this.state.gasCostPerTransaction;

      logPositionDecision(
        newPosition,
        'ADD',
        signalAnalysis.reason,
        tick,
        price,
        0,
        0,
        finalAmount,
        0,
        0
      );
    } else if (!signalAnalysis.shouldAdd) {
      console.log(`\n⏸️  SKIPPING POSITION: ${signalAnalysis.reason}`);
    }
  }

  // Public methods for main.ts
  getActivePositionsCount(): number {
    return getActivePositions(this.state).length;
  }

  getTotalInvested(): number {
    // Only count active positions
    return this.state.positions
      .filter((p) => p.status === 'active')
      .reduce((sum, p) => sum + p.amountUsd, 0);
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
      averagePositionDuration: this.state.averagePositionDuration,
      totalTrades: this.state.totalTrades,
      successfulTrades: this.state.successfulTrades,
      maxDrawdown: this.state.maxDrawdown,
      sharpeRatio: this.state.sharpeRatio,
      totalGasSpent: this.state.totalGasSpent,
    };
  }
}
