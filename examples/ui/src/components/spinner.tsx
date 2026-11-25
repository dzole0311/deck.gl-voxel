import { Loader2Icon } from 'lucide-react';
import type { ComponentProps } from 'react';
import { cn } from '../lib/utils.js';

/** Loading indicator; set aria-hidden when nearby status text already announces loading. */
function Spinner({ className, ...props }: ComponentProps<'svg'>) {
  return (
    <Loader2Icon
      role="status"
      aria-label="Loading"
      className={cn('size-4 animate-spin', className)}
      {...props}
    />
  );
}

export { Spinner };
