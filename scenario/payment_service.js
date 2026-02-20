// payment_service.js (core payment logic)
// intentionally imperfect for interview simulation

function chargeGateway(userId, amountCents) {
  return { ok: true, txId: "tx_" + Date.now() };
}

function savePaymentRecord(orderId, txId, amountCents) {
  return { ok: true, orderId, txId, amountCents };
}

function processPayment({ orderId, userId, amountCents, idempotencyKey }) {
  // BUG: idempotencyKey exists but is not enforced before charging gateway.
  const paymentResult = chargeGateway(userId, amountCents);
  if (!paymentResult.ok) {
    return { ok: false, reason: "gateway_failed" };
  }
  const rec = savePaymentRecord(orderId, paymentResult.txId, amountCents);
  return { ok: rec.ok, txId: paymentResult.txId, idempotencyKey };
}

module.exports = {
  processPayment,
  chargeGateway,
  savePaymentRecord
};
