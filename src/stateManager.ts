// stateManager.ts — State management functions

import fs from 'fs';
import { Position, SimState, PositionDecision } from './types.js';
import { DEFAULT_STATE, CONFIG } from './constants.js';
import { generatePositionId } from './utils.js';

export function loadState(): SimState {
  try {
    const data = JSON.parse(fs.readFileSync(CONFIG.STATE_FILE, 'utf-8'));
    return { ...DEFAULT_STATE, ...data };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export function saveState(state: SimState): void {
  fs.writeFileSync(CONFIG.STATE_FILE, JSON.stringify(state, null, 2));
}

export function canAddPosition(state: SimState, amountUsd: number): boolean {
  return (
    state.positions.filter((p) => p.status === 'active').length <
      state.maxPositions &&
    state.totalUsdInvested + amountUsd <= state.totalUsdLimit &&
    amountUsd <= state.maxUsdPerPosition
  );
}

export function getActivePositions(state: SimState): Position[] {
  return state.positions.filter((p) => p.status === 'active');
}

export function createNewPosition(
  lower: number,
  upper: number,
  tick: number,
  price: number,
  amountUsd: number,
  liquidity: number,
  token0Amount: number,
  token1Amount: number,
  timestamp: number
): Position {
  return {
    id: generatePositionId(),
    lower,
    upper,
    enteredAt: new Date(timestamp * 1000).toISOString(),
    entryTick: tick,
    entryPrice: price,
    amountUsd,
    status: 'active',
    feesEarned: 0,
    rebalanceCount: 0,
    liquidity,
    token0Amount,
    token1Amount,
    currentValue: amountUsd,
    impermanentLoss: 0,
    totalReturn: 0,
    lastUpdateAt: new Date(timestamp * 1000).toISOString(),
  };
}

export function logPositionDecision(
  position: Position,
  action: string,
  reason: string,
  tick: number,
  price: number,
  distance: number,
  feesEarned: number,
  currentValue?: number,
  impermanentLoss?: number,
  totalReturn?: number
): void {
  const timeHeld = Math.round(
    (Date.now() - new Date(position.enteredAt).getTime()) / (1000 * 60)
  );

  const logData: PositionDecision = {
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
    currentValue: currentValue?.toFixed(2) || 'N/A',
    feesEarned: feesEarned.toFixed(2),
    impermanentLoss: impermanentLoss?.toFixed(2) + '%' || 'N/A',
    totalReturn: totalReturn?.toFixed(2) + '%' || 'N/A',
    timeHeld: timeHeld + 'min',
    rebalanceCount: position.rebalanceCount,
  };

  console.log(`\n🎯 POSITION DECISION:`, logData);

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
      logData.currentValue,
      logData.feesEarned,
      logData.impermanentLoss,
      logData.totalReturn,
      logData.timeHeld,
      logData.rebalanceCount,
    ].join(',') + '\n';

  fs.appendFileSync(CONFIG.OUT_EVENTS, csvRow);
}
