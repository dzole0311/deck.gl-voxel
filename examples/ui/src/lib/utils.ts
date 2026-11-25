import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Combines shadcn component classes with caller overrides. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
