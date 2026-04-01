import type { InputHTMLAttributes } from 'react';

import { cn } from '@/lib/utils.ts';

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'flex h-11 w-full rounded-xl border-[1.5px] border-border bg-input px-[14px] py-2 text-sm text-foreground outline-none transition-[border-color,background-color,color,box-shadow] placeholder:text-[color:var(--metadata)] hover:border-[color:var(--field-hover-border)] focus-visible:border-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:border-[color:var(--soft-border)] disabled:bg-[color:var(--soft-surface)] disabled:text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
}
