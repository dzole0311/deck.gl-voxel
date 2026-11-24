import { Card } from '@deck.gl-voxel/example-ui/components/card';
import { useLayoutEffect, useRef } from 'react';
import type { HoverSample } from './viewer.js';

const VIEWPORT_PADDING = 8;
const POINTER_GAP = 12;

/** Measures the rendered readout before paint so wrapping and dataset labels cannot push it offscreen. */
export function HoverTooltip({ sample }: { readonly sample: HoverSample }) {
  const tooltip = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = tooltip.current;
    if (!element) {
      return;
    }
    const { width, height } = element.getBoundingClientRect();
    element.style.left = `${Math.max(VIEWPORT_PADDING, Math.min(sample.x + POINTER_GAP, window.innerWidth - width - VIEWPORT_PADDING))}px`;
    element.style.top = `${Math.max(VIEWPORT_PADDING, Math.min(sample.y + POINTER_GAP, window.innerHeight - height - VIEWPORT_PADDING))}px`;
  }, [sample]);
  return (
    <Card
      ref={tooltip}
      id="tooltip"
      role="tooltip"
      className="pointer-events-none fixed z-40 max-h-[calc(100dvh-1rem)] max-w-[min(16rem,calc(100vw-1rem))] gap-0 overflow-hidden px-3 py-2 text-xs break-words"
    >
      {sample.text}
    </Card>
  );
}
