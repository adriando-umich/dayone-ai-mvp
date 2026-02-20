// payment service (intentionally buggy for simulation)
// issue: non-idempotent retry path can double-charge

function chargeGateway(userId, amountCents) {
  // mock external call
  return { ok: true, txId: "tx_" + Date.now() };
}

function savePaymentRecord(orderId, txId, amountCents) {
  // mock DB insert (not deduplicated by idempotency key)
  return { ok: true, orderId, txId, amountCents };
}

function applyVipDiscount(amountCents, isVip) {
  if (!isVip) return amountCents;
  return Math.floor(amountCents * 0.9);
}

// BUG: retries call chargeGateway again without idempotency guard.
// BUG: VIP discount can be applied before payment incident is contained.
async function processCheckout(input) {
  const { orderId, userId, amountCents, isVip, retryCount } = input;

  const finalAmount = applyVipDiscount(amountCents, isVip);

  let paymentResult = await chargeGateway(userId, finalAmount);
  if (!paymentResult.ok && retryCount > 0) {
    paymentResult = await chargeGateway(userId, finalAmount);
  }

  if (!paymentResult.ok) {
    return { ok: false, reason: "gateway_failed" };
  }

  const rec = savePaymentRecord(orderId, paymentResult.txId, finalAmount);
  return { ok: rec.ok, txId: paymentResult.txId };
}

module.exports = {
  processCheckout,
  applyVipDiscount,
  chargeGateway,
  savePaymentRecord
};
