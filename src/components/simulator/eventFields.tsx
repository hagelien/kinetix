import { useState, useEffect, useCallback } from 'react';
import { Input } from '@/components/ui/input';
import type { TimeFormat } from '@/types/simulator';
import {
  getAvailableConcentrationUnits,
  getAvailableDoseUnits,
} from '@/lib/unitConversion';
import {
  clockToHours,
  coerceClockTime,
  hoursToClockTime,
  isValidClockTime,
} from '@/lib/timeFormat';
import { parseLocaleNumber } from '@/lib/parseNumber';

export function Field({
  label,
  placeholder,
  value,
  onChange,
  unit,
}: {
  label: string;
  placeholder: string;
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  unit?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      <div className="flex items-center gap-1">
        <NumericInput
          placeholder={placeholder}
          value={value}
          onChange={onChange}
        />
        {unit && (
          <span className="text-xs text-muted-foreground whitespace-nowrap">
            {unit}
          </span>
        )}
      </div>
    </div>
  );
}

function NumericInput({
  placeholder,
  value,
  onChange,
}: {
  placeholder: string;
  value: number | undefined;
  onChange: (v: number | undefined) => void;
}) {
  const [text, setText] = useState(value == null ? '' : String(value));
  const [isEditing, setIsEditing] = useState(false);

  useEffect(() => {
    if (!isEditing) setText(value == null ? '' : String(value));
  }, [isEditing, value]);

  return (
    <Input
      type="text"
      inputMode="decimal"
      placeholder={placeholder}
      value={text}
      onFocus={() => setIsEditing(true)}
      onChange={(e) => {
        const next = e.target.value;
        setIsEditing(true);
        setText(next);
        if (next === '') {
          onChange(undefined);
          return;
        }
        const parsed = parseLocaleNumber(next);
        if (Number.isFinite(parsed)) onChange(parsed);
      }}
      onBlur={() => {
        setIsEditing(false);
        setText(value == null ? '' : String(value));
      }}
      className="bg-card h-8 text-sm"
    />
  );
}

export function ConcentrationField({
  label,
  placeholder,
  value,
  onChange,
  unit,
  onUnitChange,
  molecularWeight,
}: {
  label: string;
  placeholder: string;
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  unit: string;
  onUnitChange: (unit: string) => void;
  molecularWeight?: number;
}) {
  const units = getAvailableConcentrationUnits(
    !!molecularWeight && molecularWeight > 0,
  );
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      <div className="flex items-center gap-1">
        <NumericInput
          placeholder={placeholder}
          value={value}
          onChange={onChange}
        />
        <select
          value={unit}
          onChange={(e) => onUnitChange(e.target.value)}
          className="h-8 text-xs border rounded bg-card px-1 text-muted-foreground min-w-[60px]"
        >
          {units.map((u) => (
            <option key={u} value={u}>
              {u}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

export function DoseField({
  label,
  placeholder,
  value,
  onChange,
  unit,
  onUnitChange,
  hint,
}: {
  label: string;
  placeholder: string;
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  unit: string;
  onUnitChange: (unit: string) => void;
  hint?: string;
}) {
  const units = getAvailableDoseUnits();
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      <div className="flex items-center gap-1">
        <NumericInput
          placeholder={placeholder}
          value={value}
          onChange={onChange}
        />
        <select
          value={unit}
          onChange={(e) => onUnitChange(e.target.value)}
          className="h-8 text-xs border rounded bg-card px-1 text-muted-foreground min-w-[50px]"
        >
          {units.map((u) => (
            <option key={u} value={u}>
              {u}
            </option>
          ))}
        </select>
      </div>
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** Time field that supports both clock time (HH:MM) and decimal hours. */
export function TimeField({
  label,
  placeholder,
  value,
  onChange,
  timeFormat,
  referenceTime,
  preferRelative = false,
}: {
  label: string;
  placeholder: string;
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  timeFormat: TimeFormat;
  referenceTime: string;
  preferRelative?: boolean;
}) {
  const [clockText, setClockText] = useState('');
  const [isInvalid, setIsInvalid] = useState(false);

  useEffect(() => {
    if (timeFormat === 'clock' && value != null) {
      setClockText(
        preferRelative
          ? formatRelativeHours(value)
          : hoursToClockTime(value, referenceTime),
      );
      setIsInvalid(false);
    } else if (timeFormat === 'clock') {
      setClockText('');
      setIsInvalid(false);
    }
  }, [timeFormat, preferRelative, referenceTime, value]);

  const handleClockChange = useCallback(
    (text: string) => {
      setClockText(text);
      if (text === '') {
        onChange(undefined);
        setIsInvalid(false);
        return;
      }
      // In a relative field (prediction time) a bare number is read as
      // "+N hours", so typing "2" means +2:00 without needing the sign.
      const relativeHours = parseRelativeHours(text, preferRelative);
      if (relativeHours != null) {
        onChange(relativeHours);
        setIsInvalid(false);
        return;
      }
      if (isValidClockTime(text)) {
        const hours = clockToHours(text, referenceTime);
        if (hours != null) {
          onChange(hours);
          setIsInvalid(false);
        } else {
          setIsInvalid(true);
        }
      } else {
        setIsInvalid(true);
      }
    },
    [onChange, referenceTime, preferRelative],
  );

  if (timeFormat === 'clock') {
    return (
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-muted-foreground">
          {label}
        </label>
        <div className="flex items-center gap-1">
          <Input
            type="text"
            placeholder={preferRelative ? '+1:30' : 'HH:MM'}
            value={clockText}
            onChange={(e) => handleClockChange(e.target.value)}
            onBlur={(e) => {
              // Relative fields normalize themselves via parseRelativeHours on
              // change (and reformat to +H:MM), so never coerce them to a clock.
              if (preferRelative || /^[+-]/.test(e.target.value.trim())) return;
              const coerced = coerceClockTime(e.target.value);
              if (coerced !== clockText) handleClockChange(coerced);
            }}
            className={`bg-card h-8 text-sm ${isInvalid ? 'border-red-400' : ''}`}
          />
          <span className="text-xs text-muted-foreground whitespace-nowrap">
            hh:mm
          </span>
        </div>
      </div>
    );
  }

  return (
    <Field
      label={label}
      placeholder={placeholder}
      value={value}
      onChange={onChange}
      unit="h"
    />
  );
}

/**
 * Parse a relative time offset like "+2:30" / "-1:00" into signed decimal hours.
 * When `allowUnsigned` is set (relative-preferring fields, e.g. prediction time)
 * a bare "2" / "2:30" / "2.5" is accepted and treated as a positive offset, so
 * the user doesn't have to type the leading "+".
 */
function parseRelativeHours(
  text: string,
  allowUnsigned = false,
): number | null {
  const trimmed = text.trim();
  const match = /^([+-]?)\s*(\d+(?:[,.]\d+)?)(?::(\d{1,2}))?$/.exec(trimmed);
  if (!match) return null;
  if (!allowUnsigned && match[1] === '') return null;

  const hours = parseLocaleNumber(match[2] ?? '');
  if (!Number.isFinite(hours)) return null;
  const minutes = match[3] == null ? 0 : Number(match[3]);
  if (!Number.isInteger(minutes) || minutes >= 60) return null;

  const sign = match[1] === '-' ? -1 : 1;
  return sign * (hours + minutes / 60);
}

function formatRelativeHours(value: number): string {
  const sign = value < 0 ? '-' : '+';
  const totalMinutes = Math.round(Math.abs(value) * 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${sign}${hours}:${String(minutes).padStart(2, '0')}`;
}
