/**
 * Allow seven days for billing updates before using a closed month as a baseline.
 * This is a comparison window, not a guarantee that Azure finalized the invoice.
 */
export const latestSettledMonth = (generatedAt: string): string | undefined => {
  const generated = new Date(generatedAt);
  if (Number.isNaN(generated.getTime())) return undefined;
  const settledThrough = new Date(generated.getTime() - 7 * 24 * 60 * 60 * 1000);
  settledThrough.setUTCDate(1);
  settledThrough.setUTCMonth(settledThrough.getUTCMonth() - 1);
  return settledThrough.toISOString().slice(0, 7);
};
