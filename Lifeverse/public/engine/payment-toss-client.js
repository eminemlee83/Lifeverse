/**
 * LIFEVERSE — TossPayments 클라이언트 연동 (결제창 방식)
 * ============================================================
 * Layer 4(04-completion-engine.js)의 buildPurchaseInfo가 시뮬레이션으로
 * 비워뒀던 자리를 실제 PG 연동으로 채운다.
 *
 * "결제위젯"이 아니라 "결제창(Payment Window)"을 고른 이유:
 * 상품이 "완결한 책 1권 = 9,900원" 하나뿐인 지금 단계에서는, 위젯의 강점인
 * 노코드 UI 커스터마이징이 필요 없다. 결제창 쪽이 붙일 코드가 더 적고
 * 구조가 단순하다 — MVP에 맞는 선택. 나중에 상품이 다양해지고 결제
 * UI를 코드 없이 바꾸고 싶어지면, SDK v2는 위젯/결제창이 한 SDK
 * 안에 있어서 마이그레이션이 크지 않다.
 *
 * 이 파일은 브라우저 전역 함수로만 동작한다 — 04의 require()나 특정 버전의
 * Firebase 클라이언트 SDK를 가정하지 않는다(서버 호출은 순수 fetch).
 * orderId도 이 파일이 만들지 않는다 — 04-completion-engine.js의
 * generateOrderId(todayIso)를 호출하는 쪽(호스트)이 만들어서 넘긴다.
 *
 * host HTML에 이 파일보다 먼저 로드되어야 하는 것:
 *   <script src="https://js.tosspayments.com/v2/standard"></script>
 *
 * 테스트는 회원가입/사업자등록 없이 바로 가능하다(토스페이먼츠 공식 안내).
 * 테스트 키로는 실제 카드번호를 넣어도 절대 출금되지 않는다 — 테스트 전용
 * 가짜 카드번호 같은 건 없고, 그냥 아무 카드나 넣어보면 된다.
 * ============================================================
 */

// TODO: https://app.tosspayments.com/signup 에서 무료 가입(사업자등록 불필요,
// 테스트 키 발급만 목적) 후, 개발자센터 > API 키 메뉴에서 "결제창 연동 키 >
// 클라이언트 키"를 복사해 넣으세요. (test_ck_ 로 시작하는 문자열)
const TOSS_CLIENT_KEY = 'test_ck_YOUR_CLIENT_KEY';

// TODO: payment-toss-confirm-function.js를 배포한 뒤 실제 URL로 교체하세요.
// Firebase Functions(2세대)라면 배포 로그에 뜨는 https://REGION-PROJECT.
// cloudfunctions.net/confirmTossPayment 형태입니다.
const CONFIRM_ENDPOINT_URL = 'https://REGION-PROJECT.cloudfunctions.net/confirmTossPayment';

// 04-completion-engine.js의 buildPurchaseInfo 기본값(9900), 그리고 서버 쪽
// payment-toss-confirm-function.js의 EXPECTED_AMOUNT와 반드시 같은 값을
// 유지할 것 — 세 군데 중 하나라도 어긋나면 결제 승인이 거부된다.
const BOOK_PRICE = 9900;

/**
 * 결제를 시작한다. "구매하기" 버튼의 onclick에 연결하면 된다.
 * 성공/실패 여부와 무관하게, 호출 즉시 브라우저가 결제창으로 이동한다
 * (현재 페이지는 여기서 끝 — 결과는 successUrl/failUrl 페이지가 받는다).
 *
 * @param {string} bookTitle - 결제창에 표시할 상품명 (goal.bookTitle)
 * @param {string} orderId - 04의 generateOrderId(todayIso)로 미리 만들어 온 값
 */
async function startTossCheckout(bookTitle, orderId) {
  // 성공 페이지가 새로고침 등으로 컨텍스트를 잃어도 "어떤 책을 결제하려던
  // 것인지" 복원할 수 있게 남겨 둔다. v10 재구매 원칙(여러 goal이 각자
  // 결제 기회를 가짐) 때문에 orderId로 정확히 짚어야 한다.
  sessionStorage.setItem('lv_pending_order', JSON.stringify({ orderId, bookTitle }));

  const tossPayments = TossPayments(TOSS_CLIENT_KEY);
  const payment = tossPayments.payment({ customerKey: TossPayments.ANONYMOUS });

  await payment.requestPayment({
    method: 'CARD',
    amount: { currency: 'KRW', value: BOOK_PRICE },
    orderId,
    orderName: bookTitle,
    successUrl: window.location.origin + '/index.html?tosspay=success',
    failUrl: window.location.origin + '/index.html?tosspay=fail',
  });
}

/**
 * successUrl(index.html?tosspay=success)로 돌아왔을 때, index.html의 로드
 * 스크립트가 이 함수를 호출한다. 리다이렉트로 돌아온 쿼리 파라미터를 읽어
 * 서버(Cloud Function)에 승인을 요청하고, 승인이 실제로 끝난 결제 정보만
 * 돌려준다. (별도의 success/fail 페이지를 두지 않고 index.html 하나가
 * ?tosspay= 값으로 분기하는 구조 — 파일 수를 늘리지 않기 위한 선택.)
 *
 * ⚠️ 이 함수가 호출됐다는 것, 즉 successUrl로 왔다는 것 자체는 "카드사 인증"만
 * 끝났다는 뜻이지 결제 승인이 아니다. 아래에서 서버 응답을 받기 전까지는
 * 절대 책을 잠금 해제하면 안 된다 — 그래서 이 함수는 실패 시 반드시 던진다.
 *
 * @returns {Promise<{paymentKey, orderId, totalAmount, approvedAt, bookTitle}>}
 */
async function handleTossSuccessRedirect() {
  const params = new URLSearchParams(window.location.search);
  const paymentKey = params.get('paymentKey');
  const orderId = params.get('orderId');
  const amount = Number(params.get('amount'));

  const pending = JSON.parse(sessionStorage.getItem('lv_pending_order') || 'null');
  if (!pending || pending.orderId !== orderId) {
    throw new Error('주문 정보를 찾을 수 없습니다 (다른 기기/세션에서 결제가 진행됐을 수 있습니다)');
  }

  // 실제 승인은 여기서만 일어난다 — secret key는 서버(Cloud Function)에만 있다.
  // successUrl 도달 후 10분 안에 이 호출까지 끝나야 한다(토스페이먼츠 정책).
  const res = await fetch(CONFIRM_ENDPOINT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paymentKey, orderId, amount }),
  });
  const result = await res.json();
  if (!res.ok) {
    throw new Error(result.error || '결제 승인에 실패했습니다');
  }

  sessionStorage.removeItem('lv_pending_order');
  return { ...result, bookTitle: pending.bookTitle };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { startTossCheckout, handleTossSuccessRedirect, BOOK_PRICE };
}
