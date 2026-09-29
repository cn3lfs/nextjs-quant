/** Poll an active job fast while it is young, then at 4 Hz; stop when done. */
export function activeJobPoll(
  job: { status: string; createdAt: number } | null | undefined,
) {
  if (!job || !["queued", "running"].includes(job.status)) return false;
  // Keep short cached runs responsive without polling long scans at 10 Hz.
  const age = Date.now() - job.createdAt;
  return age >= 0 && age < 5000 ? 100 : 250;
}
