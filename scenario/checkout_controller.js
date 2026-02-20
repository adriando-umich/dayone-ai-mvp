// checkout_controller.js (entry point for checkout flow)

const { processPayment } = require("./payment_service");
const { chargeWithRetry } = require("./retry_policy");

function applyVipDiscount(amountCents, isVip) {
  if (!isVip) return amountCents;
  return Math.floor(amountCents * 0.9);
}

async function checkout(input) {
  const { orderId, userId, amountCents, isVip, retryCount = 1, idempotencyKey } = input;
  const finalAmount = applyVipDiscount(amountCents, isVip);

  const chargeResult = await chargeWithRetry(
    async () => processPayment({ orderId, userId, amountCents: finalAmount, idempotencyKey }),
    retryCount
  );

  return {
    ok: true,
    txId: chargeResult.txId,
    finalAmount
  };
}

module.exports = {
  checkout,
  applyVipDiscount
};
