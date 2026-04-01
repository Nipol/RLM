import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';

import { cn } from '@/lib/utils.ts';

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full border px-[10px] py-[5px] font-serif text-[10px] font-bold uppercase tracking-[0.08em]',
  {
    defaultVariants: {
      variant: 'default',
    },
    variants: {
      variant: {
        brand: 'border-[color:var(--active-accent)] bg-[color:var(--active-accent-soft)] text-foreground',
        danger: 'border-destructive bg-[color:var(--error-surface)] text-foreground',
        outline: 'border-border bg-transparent text-foreground',
        secondary: 'border-border bg-secondary text-secondary-foreground',
        success: 'border-[color:var(--success)] bg-[color:var(--success-surface)] text-foreground',
        warning: 'border-transparent bg-[color:var(--warning)] text-[color:var(--dark-chocolate)]',
        default: 'border-border bg-card text-foreground',
      },
    },
  },
);

export interface BadgeProps extends HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ className, variant }))} {...props} />;
}
