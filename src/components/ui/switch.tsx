import * as React from 'react';
import { cn } from '@/lib/utils';

interface SwitchProps extends React.InputHTMLAttributes<HTMLInputElement> {
  onCheckedChange?: (checked: boolean) => void;
}

const Switch = React.forwardRef<HTMLInputElement, SwitchProps>(
  ({ className, onCheckedChange, ...props }, ref) => {
    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      onCheckedChange?.(e.target.checked);
      props.onChange?.(e);
    };

    return (
      <label className={cn('relative inline-block w-10 h-6 cursor-pointer', className)}>
        <input
          type="checkbox"
          className="sr-only peer"
          ref={ref}
          onChange={handleChange}
          {...props}
        />
        <span
          className={cn(
            'absolute inset-0 rounded-full bg-muted transition-colors duration-200',
            'peer-checked:bg-primary',
            'peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2'
          )}
        />
        <span
          className={cn(
            'absolute left-1 top-1 h-4 w-4 rounded-full bg-white transition-transform duration-200',
            'peer-checked:translate-x-4'
          )}
        />
      </label>
    );
  }
);
Switch.displayName = 'Switch';

export { Switch };
