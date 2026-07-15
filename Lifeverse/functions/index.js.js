/**
 * LIFEVERSE — TossPayments 결제 승인 서버 함수
 * ============================================================
 * 결제 승인은 반드시 서버에서만 일어나야 한다. SECRET_KEY가 여기 있고,
 * 이 파일은 절대 클라이언트(payment-toss-client.js, 호스트 HTML)에
 * 노출되지 않는다 — 환경변수로만 주입한다.
 *
 * 플로우:
 *  1. 클라이언트가 successUrl로 리다이렉트된 뒤 이 함수를 fetch로 호출한다.
 *  2. amount가 기대값(EXPECTED_AMOUNT)과 같은지 먼저 확인 — 다르면 즉시 거부.
 *     (결제 요청 시점에 클라이언트가 금액을 조작했을 가능성 방어 — 1차)
 *  3. 토스페이먼츠 결제 승인 API(POST /v1/payments/confirm)를 호출한다.
 *  4. 토스가 실제로 돌려준 승인 결과(totalAmount)가 EXPECTED_AMOUNT와
 *     같은지 다시 확인한다 — 2차. 이게 더 중요한 검증이다: 2번은 "클라이언트가
 *     보낸 숫자"를 걸러내지만, 4번은 "토스가 실제로 승인한 숫자"를 확인한다.
 *  5. 문제 없으면 확정된 결제 정보만 클라이언트에 돌려준다.
 *
 * ⚠️ 책이 여러 종류(가격이 여러 개)가 되면 EXPECTED_AMOUNT 하드코딩을
 * orderId나 상품 id로 가격을 조회하는 방식으로 바꿔야 한다. 지금은 9,900원
 * 하나뿐인 MVP 단계라 이 크기가 맞다 — 미리 다중 상품 구조를 만들지 않는다.
 *
 * Node 18+ 런타임 기준(전역 fetch 사용). 함수 런타임이 그보다 낮다면
 * node-fetch 등으로 교체하세요.
 * ============================================================
 */

const EXPECTED_AMOUNT = 9900; // 04-completion-engine.js / payment-toss-client.js와 반드시 동일하게 유지

/**
 * 플랫폼 무관 핵심 로직. Firebase가 아닌 다른 서버(Vercel, Cloudflare Workers,
 * 직접 띄운 Express 등)로 옮길 때 이 함수만 그대로 가져가면 된다 —
 * 아래 exports.confirmTossPayment는 이 함수를 감싸는 얇은 어댑터일 뿐이다.
 *
 * @param {{paymentKey, orderId, amount, secretKey}} input
 * @returns {Promise<{paymentKey, orderId, totalAmount, approvedAt, method}>}
 * @throws {Error} 금액 불일치 또는 토스페이먼츠 승인 실패 시
 */
async function verifyAndConfirmTossPayment({ paymentKey, orderId, amount, secretKey }) {
  if (amount !== EXPECTED_AMOUNT) {
    throw new Error('AMOUNT_MISMATCH: 요청 금액이 정가와 다릅니다');
  }

  // 시크릿 키 뒤에 ':'를 붙이고 base64 인코딩 — 토스페이먼츠 Basic 인증 규칙.
  const authHeader = 'Basic ' + Buffer.from(secretKey + ':').toString('base64');

  const response = await fetch('https://api.tosspayments.com/v1/payments/confirm', {
    method: 'POST',
    headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify({ paymentKey, orderId, amount }),
  });
  const payment = await response.json();

  if (!response.ok) {
    // 토스페이먼츠가 돌려주는 message를 그대로 노출해도 안전한 수준의 정보다
    // (카드 거절 사유 등) — 시크릿 키 자체가 노출되는 게 아니므로.
    throw new Error('TOSS_CONFIRM_FAILED: ' + (payment.message || response.status));
  }
  if (payment.totalAmount !== EXPECTED_AMOUNT) {
    // 여기 걸리면 절대 구매 확정 처리하면 안 된다 — 위조 시도 가능성.
    throw new Error('CONFIRMED_AMOUNT_MISMATCH');
  }

  return {
    paymentKey: payment.paymentKey,
    orderId: payment.orderId,
    totalAmount: payment.totalAmount,
    approvedAt: payment.approvedAt,
    method: payment.method,
  };
}

/**
 * Firebase Cloud Functions(2세대, HTTPS 요청 함수) 어댑터.
 * 배포: `firebase deploy --only functions:confirmTossPayment`
 * 시크릿 키 설정(코드에 절대 직접 쓰지 않는다):
 *   firebase functions:secrets:set TOSS_SECRET_KEY
 * (정확한 현재 CLI 문법은 Firebase 공식 문서에서 한 번 더 확인 권장 —
 * Secret Manager 연동 방식이 계속 다듬어지고 있는 영역이다)
 *
 * Firebase가 아니어도 되는 서버라면, 이 아래 블록만 그 플랫폼의 요청
 * 핸들러 형태로 바꾸면 된다 — 위 verifyAndConfirmTossPayment는 그대로 재사용.
 */
// firebase-functions가 없는 환경(로컬 유닛테스트, 다른 서버리스 플랫폼으로
// 포팅하는 중간 단계 등)에서도 이 파일을 require해서 핵심 로직만 쓸 수 있게
// 방어적으로 불러온다 — 없으면 조용히 건너뛰고 verifyAndConfirmTossPayment만 export.
let onRequest = null;
try {
  onRequest = require('firebase-functions/v2/https').onRequest;
} catch (e) {
  // firebase-functions 미설치 — 실제 Firebase 배포 환경에서는 항상 설치돼 있다.
}

if (onRequest) {
  exports.confirmTossPayment = onRequest(async (req, res) => {
    // MVP 단계라 전체 허용 — 실서비스 도메인이 정해지면 실제 도메인으로 좁힐 것.
    res.set('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Methods', 'POST');
      res.set('Access-Control-Allow-Headers', 'Content-Type');
      return res.status(204).send('');
    }

    try {
      const { paymentKey, orderId, amount } = req.body;
      const result = await verifyAndConfirmTossPayment({
        paymentKey, orderId, amount, secretKey: process.env.TOSS_SECRET_KEY,
      });
      res.status(200).json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });
}

exports.verifyAndConfirmTossPayment = verifyAndConfirmTossPayment; // 테스트/포팅용
