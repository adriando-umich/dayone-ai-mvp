// retry_policy.js (checkout retry behavior)
// intentionally flawed retry strategy

async function withRetry(operation, retryCount) {
  let lastError = null;
  for (let i = 0; i <= retryCount; i++) {
    try {
      return await operation(i + 1);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error("retry_failed");
}

async function chargeWithRetry(chargeFn, retryCount) {
  // BUG: retries may trigger multiple successful charges if gateway timeouts are ambiguous.
  return withRetry(async () => {
    const result = await chargeFn();
    if (!result.ok) throw new Error("charge_failed");
    return result;
  }, retryCount);
}

module.exports = {
  withRetry,
  chargeWithRetry
};
