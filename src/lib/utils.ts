import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { groupThousands } from './rangeUtils';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function round(num: number, precision = 6): number | string {
  if (!isFinite(num)) return '';
  return Math.round(num * Math.pow(10, precision)) / Math.pow(10, precision);
}

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !isFinite(value)) return '';
  return groupThousands(round(value).toString());
}
