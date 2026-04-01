import * as LabelPrimitive from '@radix-ui/react-label';

import { cn } from '@/lib/utils.ts';

export function Label({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      className={cn('text-[12px] font-medium leading-[1.45] tracking-[0.01em] text-[color:var(--ledger)]', className)}
      {...props}
    />
  );
}
