// utils.ts — Utility functions

import { BigNumber } from 'ethers';
import { LOG_1P0001 } from './constants.js';

export function priceFromSqrtX96(
  sqrtPriceX96: BigNumber,
  dec0: number,
  dec1: number
): number {
  // sqrtPriceX96 = sqrt(price) * 2^96
  // For vbUSDC/vbETH pair: price = token1/token0 = vbETH/vbUSDC
  const num = sqrtPriceX96.mul(sqrtPriceX96);
  const Q192 = BigNumber.from(2).pow(192);
  const ratio = Number(num.toString()) / Number(Q192.toString());
  // Adjust for token decimals: dec1 - dec0 (vbETH decimals - vbUSDC decimals)
  return ratio * Math.pow(10, dec1 - dec0);
}

export function tickToPrice(tick: number, dec0: number, dec1: number): number {
  // For vbUSDC/vbETH pair: price = token1/token0 = vbETH/vbUSDC
  return Math.pow(1.0001, tick) * Math.pow(10, dec1 - dec0);
}

export function roundDownToSpacing(tick: number, spacing: number): number {
  let t = Math.floor(tick / spacing) * spacing;
  if (tick < 0 && tick % spacing !== 0) t -= spacing;
  return t;
}

export function widthFromSigma(
  sigma: number,
  T_hours: number,
  z: number,
  tickSpacing: number
): number {
  const T_days = Math.max(1e-9, T_hours / 24);
  const halfWidth = (z * sigma * Math.sqrt(T_days)) / LOG_1P0001;
  let W = Math.ceil(2 * halfWidth);
  W = Math.ceil(W / tickSpacing) * tickSpacing;
  
  // Ensure appropriate width for vbUSDC/vbETH pair
  // More conservative range for better capital efficiency
  const minWidth = 4 * tickSpacing; // At least 40 ticks for stability
  const maxWidth = 20 * tickSpacing; // Maximum 200 ticks to avoid too wide ranges
  
  return Math.max(minWidth, Math.min(W, maxWidth));
}


export function generatePositionId(): string {
  return `pos_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

export function safeNumber(
  value: number | undefined,
  defaultValue = 0
): number {
  return Number.isFinite(value) && value ? value : defaultValue;
}

export function calculateTimeHeld(enteredAt: string): number {
  return (Date.now() - new Date(enteredAt).getTime()) / (1000 * 60 * 60);
}
