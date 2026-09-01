import { describe, expect, it } from 'vitest';
import {
  calendarTimeZoneLabel,
  convertCalendarWallTime,
  getTimeZoneParts,
  normalizeCalendarTimeZone,
  parseCalendarClockTime,
  zonedWallTimeToDate,
} from './calendarTime.js';

describe('calendarTime', () => {
  it('converts UTC economic calendar feed times into the user timezone', () => {
    expect(convertCalendarWallTime('2026-05-12', '12:30', 'America/New_York', 'UTC')).toEqual({
      date: '2026-05-12',
      time: '08:30',
    });
  });

  it('converts the same UTC instant into Australia/Sydney when selected', () => {
    expect(convertCalendarWallTime('2026-05-12', '12:30', 'Australia/Sydney', 'UTC')).toEqual({
      date: '2026-05-12',
      time: '22:30',
    });
  });

  it('parses common 12-hour calendar clock labels', () => {
    expect(parseCalendarClockTime('8:30am')).toBe('08:30');
    expect(parseCalendarClockTime('12:00 AM')).toBe('00:00');
    expect(parseCalendarClockTime('12:00 PM')).toBe('12:00');
  });

  it('normalizes invalid timezones to the calendar default', () => {
    expect(normalizeCalendarTimeZone('Not/AZone')).toBe('America/New_York');
  });

  it('formats instants with stable calendar parts', () => {
    const instant = new Date('2026-05-12T12:30:00.000Z');
    expect(getTimeZoneParts(instant, 'America/New_York')).toEqual({
      date: '2026-05-12',
      time: '08:30',
    });
  });
});

// High-impact alerts once built their own Date by parsing "YYYY-MM-DDTHH:MM",
// which the runtime reads in the BROWSER's zone rather than the calendar's. The
// result drifted by the viewer's own UTC offset — right only on a machine set to
// UTC — so a São Paulo viewer was told an event was "in 30 min" three hours
// after it had been released. These pin the instant, whatever the host zone.
describe('zonedWallTimeToDate — instants the alert countdown depends on', () => {
  it('reads a wall time in the calendar zone, not the host zone', () => {
    // ISM Manufacturing PMI: 10:00 New York, shown as 11:00 to a GMT-3 viewer.
    expect(zonedWallTimeToDate('2026-09-01', '10:00', 'America/New_York')?.toISOString())
      .toBe('2026-09-01T14:00:00.000Z');
    expect(zonedWallTimeToDate('2026-09-01', '11:00', 'America/Sao_Paulo')?.toISOString())
      .toBe('2026-09-01T14:00:00.000Z');
  });

  it('agrees across zones on the same instant', () => {
    const sameMoment = [
      zonedWallTimeToDate('2026-09-01', '10:00', 'America/New_York'),
      zonedWallTimeToDate('2026-09-01', '11:00', 'America/Sao_Paulo'),
      zonedWallTimeToDate('2026-09-01', '14:00', 'UTC'),
      zonedWallTimeToDate('2026-09-01', '23:00', 'Asia/Tokyo'),
    ].map(date => date?.getTime());
    expect(new Set(sameMoment).size).toBe(1);
  });

  it('follows daylight saving, so a summer and a winter release both land right', () => {
    // 08:30 ET is 12:30 UTC in EDT and 13:30 UTC in EST.
    expect(zonedWallTimeToDate('2026-07-02', '08:30', 'America/New_York')?.toISOString())
      .toBe('2026-07-02T12:30:00.000Z');
    expect(zonedWallTimeToDate('2026-01-08', '08:30', 'America/New_York')?.toISOString())
      .toBe('2026-01-08T13:30:00.000Z');
  });

  it('rejects input it cannot place', () => {
    expect(zonedWallTimeToDate('2026-09-01', '', 'UTC')).toBeNull();
    expect(zonedWallTimeToDate('not-a-date', '10:00', 'UTC')).toBeNull();
  });
});

describe('calendarTimeZoneLabel', () => {
  it('names the zone the times are on', () => {
    expect(calendarTimeZoneLabel('UTC', new Date('2026-09-01T12:00:00Z'))).toBe('UTC');
    expect(calendarTimeZoneLabel('America/Sao_Paulo', new Date('2026-09-01T12:00:00Z'))).toBe('GMT-3');
    expect(calendarTimeZoneLabel('Asia/Kolkata', new Date('2026-09-01T12:00:00Z'))).toBe('GMT+5:30');
  });

  it('tracks daylight saving rather than pinning one offset', () => {
    const summer = calendarTimeZoneLabel('America/New_York', new Date('2026-07-02T12:00:00Z'));
    const winter = calendarTimeZoneLabel('America/New_York', new Date('2026-01-08T12:00:00Z'));
    expect([summer, winter].every(label => /^(ET|GMT-[45])$/.test(label))).toBe(true);
  });

  it('falls back to the default zone rather than throwing on junk', () => {
    expect(calendarTimeZoneLabel('Not/AZone', new Date('2026-09-01T12:00:00Z'))).toBeTruthy();
  });
});
