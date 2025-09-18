// utils.ts — Utility functions

import { BigNumber } from 'ethers';
import { LOG_1P0001 } from './constants.js';

export const fmt = (n: number | undefined, d = 4) =>
  n === undefined || !Number.isFinite(n) ? String(n) : n.toFixed(d);

export function priceFromSqrtX96(
  sqrtPriceX96: BigNumber,
  dec0: number,
  dec1: number
): number {
  const num = sqrtPriceX96.mul(sqrtPriceX96);
  const Q192 = BigNumber.from(2).pow(192);
  const ratio = Number(num.toString()) / Number(Q192.toString());
  return ratio * Math.pow(10, dec0 - dec1);
}

export function tickToPrice(tick: number, dec0: number, dec1: number): number {
  return Math.pow(1.0001, tick) * Math.pow(10, dec0 - dec1);
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
  // Ensure minimum width for stability
  return Math.max(W, 6 * tickSpacing); // At least 60 ticks for stability
}

export function bufferB(W: number, tickSpacing: number): number {
  return Math.max(2 * tickSpacing, Math.floor(0.1 * W));
}

export function dangerD(W: number, tickSpacing: number): number {
  return Math.max(3 * tickSpacing, Math.floor(0.15 * W));
}

export function wordOfTick(tick: number, tickSpacing: number): number {
  let compressed = Math.floor(tick / tickSpacing);
  if (tick < 0 && tick % tickSpacing !== 0) compressed -= 1;
  return compressed >> 8;
}

export function bitPosOfTick(tick: number, tickSpacing: number): number {
  let compressed = Math.floor(tick / tickSpacing);
  if (tick < 0 && tick % tickSpacing !== 0) compressed -= 1;
  return compressed & 255;
}

export function isBitSet(bm: BigNumber, bit: number): boolean {
  return !bm.and(BigNumber.from(1).shl(bit)).isZero();
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
