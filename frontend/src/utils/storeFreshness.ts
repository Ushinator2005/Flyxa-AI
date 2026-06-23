export function shouldPreferLocalStore(
  localSavedAt: string | null,
  remoteUpdatedAt: string | null | undefined,
): boolean {
  if (!localSavedAt) return false;

  const localTime = Number(localSavedAt);
  const remoteTime = remoteUpdatedAt ? Date.parse(remoteUpdatedAt) : Number.NaN;
  if (!Number.isFinite(localTime)) return false;
  if (!Number.isFinite(remoteTime)) return true;

  return localTime > remoteTime;
}
