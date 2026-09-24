import { useEffect, useRef, useState } from 'react';

/**
 * Accumulates real observed values of a changing number into a capped rolling window,
 * for feeding a sparkline. Never fabricates data — it only ever records what the value
 * actually was at each point this hook re-ran, starting from a single flat point and
 * genuinely filling in as the session goes on (e.g. as the dashboard's 15s cloud-count
 * poll ticks, or as `leads` changes).
 */
export function useLiveHistory(value: number, maxPoints = 20): number[] {
  // Seeded with two identical points (a flat baseline, not a fabricated trend) so the
  // sparkline renders immediately instead of staying blank until the value changes twice.
  const historyRef = useRef<number[]>([value, value]);
  const [, forceTick] = useState(0);

  useEffect(() => {
    const last = historyRef.current[historyRef.current.length - 1];
    if (last === value) return;
    historyRef.current = [...historyRef.current, value].slice(-maxPoints);
    forceTick((t) => t + 1);
  }, [value, maxPoints]);

  return historyRef.current;
}
