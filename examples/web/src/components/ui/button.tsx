import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ButtonHTMLAttributes } from 'react';

import { cn } from '@/lib/utils.ts';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full border text-[15px] font-semibold tracking-[-0.01em] transition-[transform,background-color,color,border-color,opacity] duration-150 disabled:pointer-events-none disabled:opacity-45 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0',
  {
    defaultVariants: {
      size: 'default',
      variant: 'default',
    },
    variants: {
      size: {
        default: 'h-10 px-[18px]',
        icon: 'size-10',
        lg: 'h-12 px-6 text-[15px]',
        sm: 'h-8 px-[14px] text-[13px]',
      },
      variant: {
        default:
          'border-foreground bg-foreground text-background hover:-translate-y-px active:translate-y-0',
        borderless: 'border-transparent bg-transparent text-foreground hover:bg-[color:var(--outline-hover)]',
        brand:
          'border-[color:var(--active-accent)] bg-[color:var(--active-accent)] text-[color:var(--active-accent-foreground)] hover:-translate-y-px hover:bg-[color:var(--active-accent-hover)] active:translate-y-0',
        danger:
          'border-destructive bg-destructive text-destructive-foreground hover:-translate-y-px hover:bg-[color:var(--danger-hover)] active:translate-y-0',
        ghost: 'border-transparent bg-transparent text-foreground hover:bg-[color:var(--outline-hover)]',
        outline: 'border-border bg-transparent text-foreground hover:-translate-y-px hover:bg-[color:var(--outline-hover)] active:translate-y-0',
        secondary: 'border-border bg-secondary text-secondary-foreground hover:-translate-y-px hover:bg-[color:var(--outline-hover)] active:translate-y-0',
        success:
          'border-[color:var(--success)] bg-[color:var(--success-surface)] text-[color:var(--dark-chocolate)] hover:-translate-y-px hover:bg-[color:var(--success-hover)] active:translate-y-0',
      },
    },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export function Button({
  asChild = false,
  className,
  size,
  variant,
  ...props
}: ButtonProps) {
  const Component = asChild ? Slot : 'button';
  return <Component className={cn(buttonVariants({ className, size, variant }))} {...props} />;
}

export { buttonVariants };
