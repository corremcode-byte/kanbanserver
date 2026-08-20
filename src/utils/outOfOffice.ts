export interface OutOfOfficePeriod {
  _id?: unknown;
  startDate: Date | string;
  endDate: Date | string;
  reason?: string;
  createdAt?: Date | string;
}

// Finds the period (if any) covering `at`. Periods are stored with startDate
// normalized to 00:00:00 and endDate to 23:59:59.999 (see authController's
// parseOutOfOfficeRange), so a simple range check is enough here.
export function getCurrentOutOfOfficePeriod(
  periods: OutOfOfficePeriod[] | undefined,
  at: Date = new Date()
): OutOfOfficePeriod | null {
  if (!periods || periods.length === 0) return null;
  const found = periods.find(p => new Date(p.startDate) <= at && new Date(p.endDate) >= at);
  return found || null;
}

// Shapes a user's outOfOfficePeriods + derived "currently out" status for API responses.
export function summarizeOutOfOffice(periods: OutOfOfficePeriod[] | undefined) {
  const current = getCurrentOutOfOfficePeriod(periods);
  return {
    isOutOfOffice: current !== null,
    currentPeriod: current,
    periods: periods || [],
  };
}
