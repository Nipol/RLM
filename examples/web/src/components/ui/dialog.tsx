import { X } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { cn } from '@/lib/utils.ts';

import { Button } from './button.tsx';

export function Dialog({
  children,
  className,
  description,
  onOpenChange,
  open,
  title,
}: {
  children: ReactNode;
  className?: string;
  description?: string;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  title: string;
}) {
  useEffect(() => {
    if (!open) {
      return;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onOpenChange(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [onOpenChange, open]);

  if (!open) {
    return null;
  }

  return createPortal(
    <div
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-[rgba(48,47,45,0.18)] px-4 py-8 md:px-6 md:py-10 dark:bg-[rgba(0,0,0,0.32)]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onOpenChange(false);
        }
      }}
      role="dialog"
    >
      <div
        className={cn(
          'w-full max-w-[840px] rounded-[32px] border-[1.5px] border-border bg-card text-card-foreground',
          className,
        )}
      >
        <div className="flex items-start justify-between gap-4 border-b border-[color:var(--soft-border)] px-6 py-5 md:px-7">
          <div className="space-y-2">
            <p className="editorial-kicker">Modal / settings editor</p>
            <h2 className="font-serif text-[26px] leading-[1.24] tracking-[-0.01em]">{title}</h2>
            {description !== undefined && (
              <p className="max-w-[40rem] text-sm leading-7 text-muted-foreground">{description}</p>
            )}
          </div>
          <Button onClick={() => onOpenChange(false)} size="sm" type="button" variant="ghost">
            <X className="size-4" />
            닫기
          </Button>
        </div>
        <div className="px-6 py-6 md:px-7 md:py-7">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
