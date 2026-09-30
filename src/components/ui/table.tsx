import * as React from 'react';
import { cn } from '@/lib/utils';
import { ArrowUp, ArrowDown, ArrowUpDown } from 'lucide-react';

const Table = React.forwardRef<
  HTMLTableElement,
  React.HTMLAttributes<HTMLTableElement>
>(({ className, ...props }, ref) => (
  <div className="w-full h-full overflow-auto border border-border rounded-xl">
    <table
      ref={ref}
      className={cn('w-full caption-bottom text-sm', className)}
      {...props}
    />
  </div>
));
Table.displayName = 'Table';

const TableHeader = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <thead
    ref={ref}
    className={cn('sticky top-0 bg-secondary z-10 shadow-sm', className)}
    {...props}
  />
));
TableHeader.displayName = 'TableHeader';

const TableBody = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tbody
    ref={ref}
    className={cn('[&_tr:last-child]:border-0', className)}
    {...props}
  />
));
TableBody.displayName = 'TableBody';

const TableFooter = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tfoot
    ref={ref}
    className={cn(
      'border-t bg-muted/50 font-medium [&>tr]:last:border-b-0',
      className
    )}
    {...props}
  />
));
TableFooter.displayName = 'TableFooter';

const TableRow = React.forwardRef<
  HTMLTableRowElement,
  React.HTMLAttributes<HTMLTableRowElement> & { active?: boolean }
>(({ className, active, ...props }, ref) => (
  <tr
    ref={ref}
    className={cn(
      'border-b transition-colors hover:bg-accent/[0.08] data-[state=selected]:bg-muted',
      active && 'bg-accent/[0.12]',
      className
    )}
    {...props}
  />
));
TableRow.displayName = 'TableRow';

const TableHead = React.forwardRef<
  HTMLTableCellElement,
  React.ThHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
  <th
    ref={ref}
    className={cn(
      'h-12 px-3 text-left align-middle font-semibold text-muted-foreground [&:has([role=checkbox])]:pr-0',
      className
    )}
    {...props}
  />
));
TableHead.displayName = 'TableHead';

const TableCell = React.forwardRef<
  HTMLTableCellElement,
  React.TdHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
  <td
    ref={ref}
    className={cn(
      'p-3 align-middle [&:has([role=checkbox])]:pr-0',
      className
    )}
    {...props}
  />
));
TableCell.displayName = 'TableCell';

const TableCaption = React.forwardRef<
  HTMLTableCaptionElement,
  React.HTMLAttributes<HTMLTableCaptionElement>
>(({ className, ...props }, ref) => (
  <caption
    ref={ref}
    className={cn('mt-4 text-sm text-muted-foreground', className)}
    {...props}
  />
));
TableCaption.displayName = 'TableCaption';

// Sortable header component
interface SortableHeaderProps {
  children: React.ReactNode;
  sorted?: 'asc' | 'desc' | false;
  onClick?: () => void;
  ariaLabel?: string;
  title?: string;
  /**
   * Optional smaller, muted second line rendered under the primary label
   * (e.g. a parameter's full descriptive name beneath its symbol). Keeps
   * dense column headers readable without packing everything onto one
   * wrapping line.
   */
  subLabel?: React.ReactNode;
  /** Horizontal alignment of the stacked label. Defaults to left. */
  align?: 'left' | 'right';
}

const SortableHeader = ({
  children,
  sorted,
  onClick,
  ariaLabel,
  title,
  subLabel,
  align = 'left',
}: SortableHeaderProps) => {
  const indicator =
    sorted === 'asc' ? (
      <ArrowUp className="h-4 w-4 text-primary" />
    ) : sorted === 'desc' ? (
      <ArrowDown className="h-4 w-4 text-primary" />
    ) : (
      <ArrowUpDown className="h-4 w-4 opacity-50" />
    );

  return (
    <button
      onClick={onClick}
      aria-label={ariaLabel}
      title={title}
      className={cn(
        'flex w-full flex-col gap-0.5 hover:text-foreground transition-colors select-none',
        align === 'right' ? 'items-end text-right' : 'items-start text-left'
      )}
    >
      <span className="flex items-center gap-1.5 whitespace-nowrap">
        {children}
        <span className="shrink-0">{indicator}</span>
      </span>
      {subLabel != null && (
        <span className="text-[11px] font-normal leading-tight text-muted-foreground/60">
          {subLabel}
        </span>
      )}
    </button>
  );
};

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
  SortableHeader,
};
