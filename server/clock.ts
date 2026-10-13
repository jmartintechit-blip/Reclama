import type { Clock } from './domain/dates.ts';

// The one place that reads the real time. Everything else receives a Clock, so tests can fix "now".
export const systemClock: Clock = { now: () => new Date() };
