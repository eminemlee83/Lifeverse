/**
 * LIFEVERSE Story Engine — Layer 4: Completion Engine
 * ============================================================
 * 기간 종료 판정, 완결한 책 아카이브, 결제 상태 관리를 담당한다.
 *
 * 핵심 원칙 (명세서 4.7에서 정정된 것, 절대 되돌리지 말 것):
 * 완결 판정은 "페이지를 몇 개 채웠는가"가 아니라 "오늘이 목표 종료일을
 * 지났는가"만 본다. 하루라도 빼먹으면 영원히 완결에 도달할 수 없는
 * 설계는 명세서 원문에 있던 로직 오류였고, 이번 재구성에서 정정됐다.
 *
 * 재구매 원칙 (v10 도입, 냉정한 사업성 평가에서 지적된 문제 해결):
 * goal 하나가 완결되는 것으로 끝나지 않는다. 완결 시점(novelGenerated=true,
 * 결제 여부와 무관)에 항상 completedBooks에 스냅샷을 남겨서, 사용자가
 * 여러 목표를 연달아 만들 수 있고 그때마다 결제 기회가 다시 생긴다.
 * ============================================================
 */

// 브라우저에서는 02-narrative-rules.js가 이미 <script>로 먼저 로드되어
// daysBetween이 전역에 있다. Node.js 환경에서만 require로 가져온다.
var daysBetween;
if (typeof require === 'function') {
  daysBetween = require('./02-narrative-rules.js').daysBetween;
}

/**
 * 목표의 기간이 끝났는지 판정한다. 날짜만 본다 — 페이지 수는 절대 보지 않는다.
 */
function isPeriodEnded(goal, todayIso) {
  if (!goal.targetDateIso) return false;
  return todayIso >= goal.targetDateIso;
}

/**
 * 목표를 "달성"했는지 판정한다. 이건 완결 여부(isPeriodEnded)와는 완전히
 * 별개의 값이다 — 기간은 끝났지만(완결) 달성은 못 했을 수 있다(미달성).
 * 이 값은 오직 M5/M6의 문구 분기("당신은 끝까지 해냈습니다" vs
 * "완주하지 못했어도, 여정은 남았습니다")에만 쓰인다.
 */
function isAchieved(goal, archive) {
  if (!goal.targetDateIso) return false;
  const expectedTotal = daysBetween(goal.startDateIso, goal.targetDateIso) + 1;
  return archive.length >= expectedTotal;
}

/**
 * 완결 안내(M5)에 표시할 통계를 계산한다.
 */
function buildCompletionStats(goal, archive) {
  const activeDays = archive.filter((e) => !e.isRestDay).length;
  const restDays = archive.length - activeDays;
  return {
    totalStories: archive.length,
    activeDays,
    restDays,
    achieved: isAchieved(goal, archive),
  };
}

/**
 * 완결된 목표를 completedBooks에 아카이브할 스냅샷을 만든다.
 * 결제 여부와 무관하게 항상 호출되어야 한다 (무료로도 여러 권 완결 가능해야
 * 재구매 기회가 목표 개수만큼 생긴다는 원칙).
 */
function buildCompletedBookSnapshot(goal, archive) {
  const stats = buildCompletionStats(goal, archive);
  return {
    text: goal.text,
    categoryId: goal.categoryId,
    bookTitle: goal.bookTitle,
    startDateIso: goal.startDateIso,
    targetDateIso: goal.targetDateIso,
    durationDays: goal.durationDays,
    pastMsg: goal.pastMsg || null,
    achieved: stats.achieved,
    totalPages: stats.totalStories,
    activeDays: stats.activeDays,
    restDays: stats.restDays,
    purchase: goal.purchase || null,
    archivedAt: new Date().toISOString(),
  };
}

/**
 * 같은 목표가 중복 아카이브되지 않도록 확인한다.
 * (goalStartDateIso + text 조합으로 동일 목표 판정 — 실제 서비스에서는
 * goal_id UNIQUE 제약으로 대체됨, 5.10 참조)
 */
function isAlreadyArchived(completedBooks, goal) {
  return completedBooks.some((b) => b.text === goal.text && b.startDateIso === goal.startDateIso);
}

/** 주문번호를 생성한다 (프로토타입 시뮬레이션 형식, 실 PG 연동 전 임시). */
function generateOrderId(todayIso) {
  const datePart = todayIso.replace(/-/g, '');
  const randomPart = Math.random().toString(36).slice(2, 7).toUpperCase();
  return 'LV-' + datePart + '-' + randomPart;
}

/**
 * 결제 완료 정보를 만든다. ⚠️ 이건 시뮬레이션이다 — 실제 승인을 거치지 않고
 * 성공했다고 가정한다. 명세서 9.1이 요구하던 실 PG 연동은 이제
 * payment-toss-client.js + payment-toss-confirm-function.js에 있다.
 * 이 함수는 그 두 파일을 아직 안 붙였을 때(개발 중, 오프라인 데모 등)만
 * 쓰는 폴백으로 남겨둔다 — 지우지 않는다, 하위호환.
 */
function buildPurchaseInfo(bookTitle, todayIso, amount) {
  return {
    orderId: generateOrderId(todayIso),
    purchasedAt: new Date().toISOString(),
    amount: amount || 9900,
    bookTitle,
  };
}

/**
 * 실제 결제 완료 정보를 만든다 (v2 신규). payment-toss-confirm-function.js의
 * verifyAndConfirmTossPayment가 돌려준, 토스페이먼츠가 실제로 승인한 결과를
 * 넣으면 된다. buildPurchaseInfo(시뮬레이션)와 반환 모양을 똑같이 맞춰서,
 * 호출하는 쪽(호스트)이 goal.purchase에 저장하는 로직을 바꿀 필요가 없게 했다.
 *
 * @param {{paymentKey, orderId, totalAmount, approvedAt}} confirmedPayment
 */
function buildPurchaseInfoFromToss(confirmedPayment, bookTitle) {
  return {
    orderId: confirmedPayment.orderId,
    purchasedAt: confirmedPayment.approvedAt,
    amount: confirmedPayment.totalAmount,
    bookTitle,
    paymentKey: confirmedPayment.paymentKey, // 환불/CS 문의 시 필요 — 시뮬레이션엔 없던 필드
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    isPeriodEnded,
    isAchieved,
    buildCompletionStats,
    buildCompletedBookSnapshot,
    isAlreadyArchived,
    generateOrderId,
    buildPurchaseInfo,
    buildPurchaseInfoFromToss,
  };
}
