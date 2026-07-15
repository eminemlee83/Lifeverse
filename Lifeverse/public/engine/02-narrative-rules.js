/**
 * LIFEVERSE Story Engine — Layer 2: Narrative Rule Engine (v2)
 * ============================================================
 * "지금이 어떤 순간인가"를 판정하는 순수 규칙. 문장을 만들지 않는다 —
 * 오직 오늘이 어떤 서사적 순간인지만 판정한다.
 * 판정 결과를 Layer 3(Story Generator)에 넘기면 실제 문장이 나온다.
 *
 * 검증 이력:
 * - v11에서 "스트릭이 갱신될 때마다 마일스톤"으로 만들었다가, 7일 연속
 *   시뮬레이션에서 "연속 기록 중엔 매일이 신기록이라 오히려 매일 반복되는"
 *   버그를 발견. "정확히 이 목록에 있을 때만"으로 수정해서 해결.
 *   이 교훈이 이 모듈의 핵심 설계 원칙이다: 조건은 "갱신마다"가 아니라
 *   "의미 있는 지점에서만" 특별해야 한다.
 *
 * v2 확장 (엔진 풍부화) — 분기 3종 → 9종:
 *   firstDay        여정의 첫날 (dayNo === 1)
 *   finalDay        목표 마지막 날 (남은 날 0)
 *   comeback        2일 이상 공백 후 복귀 (기존)
 *   personalBest    자기 최고 스트릭을 "처음 넘어선" 바로 그 날
 *   milestone       스트릭이 정확히 목록의 값에 도달 (기존)
 *   stageTransition 세계관 단계가 바뀌는 날 (8일째, 15일째)
 *   halfway         여정의 정확한 중간 날 (10일 이상 목표만)
 *   finalStretch    남은 날 1~2일
 *   ordinary        평범한 날 (기존)
 *
 * 모든 신규 분기는 v11 교훈을 지킨다 — "구간 내내"가 아니라 "정확히 그
 * 지점에서만" 발동한다. 특히 personalBest는 previousBestStreak + 1이 되는
 * 단 하루만 참이다. "현재 스트릭 > 최고 기록"으로 만들면 기록 경신 후
 * 매일이 personalBest가 되는 v11 버그가 그대로 재발하므로 절대 그렇게
 * 바꾸지 말 것.
 * ============================================================
 */

// 브라우저에서는 이 파일보다 먼저 <script>로 로드된 01-world-vocab.js가
// 이미 전역에 hashStr를 정의해 두므로 별도 import가 필요 없다. Node.js
// 환경(테스트, Edge Function 등)에서만 require로 명시적으로 가져온다.
// ⚠️ 이 가드 없이 무조건 const로 require하면, 브라우저에서 01이 이미
// hashStr를 선언해 둔 상태이기 때문에 "Identifier has already been
// declared" 에러가 나서 이 파일 전체가 실행되지 않는다 (실제 브라우저
// 테스트에서 발견된 버그 — Node 테스트만으로는 안 드러난다).
var hashStr;
if (typeof require === 'function') {
  hashStr = require('./01-world-vocab.js').hashStr;
}

/** 스트릭이 이 값들에 도달했을 때만 "마일스톤"으로 특별하게 취급한다.
 *  매번 갱신될 때마다가 아니라, 정확히 이 목록에 있을 때만. */
const STREAK_MILESTONES = [3, 7, 14, 21, 30, 45, 60, 90];

/** personalBest가 의미를 갖는 최소 이전 기록. 이전 최고가 1~2일이면
 *  "기록 경신"이 매주 발동해서 특별함이 사라지므로 3일 이상일 때만. */
const PERSONAL_BEST_MIN_PRIOR = 3;

/** halfway 분기가 발동하는 최소 목표 기간. 짧은 목표에서는 중간 지점이
 *  첫날/마지막날과 너무 가까워서 서사적 밀도만 떨어뜨린다. */
const HALFWAY_MIN_TOTAL_DAYS = 10;

/**
 * 날짜 차이(일수)를 계산한다. dateA, dateB는 'YYYY-MM-DD' 형식 문자열.
 */
function daysBetween(dateA, dateB) {
  const a = new Date(dateA + 'T00:00:00Z');
  const b = new Date(dateB + 'T00:00:00Z');
  return Math.round((b - a) / 86400000);
}

/**
 * 오늘의 "서사적 상태"를 판정한다. 문장은 만들지 않고 상태만 반환한다.
 *
 * @param {object} input
 * @param {string} input.dateIso - 오늘 날짜
 * @param {string} input.goalStartDateIso - 목표 시작일
 * @param {string} [input.targetDateIso] - 목표 종료일 (없으면 기간 기반
 *                 분기 — finalDay/halfway/finalStretch — 는 발동하지 않는다.
 *                 기존 호출부와의 하위호환을 위해 옵션이다)
 * @param {Array}  input.archive - 정렬된(과거→현재) storyPage 배열,
 *                 각 {dateIso, body, isRestDay, hook?}
 * @param {number} input.currentStreak - 오늘 기록 반영 후의 스트릭 값
 * @param {number} [input.previousBestStreak] - "이미 끊어진 과거 스트릭들"
 *                 중 최고값. 넘기지 않으면 personalBest 분기는 발동하지 않는다.
 *                 ⚠️ 여기에 "어제까지의 최고(현재 진행 중인 스트릭 포함)"를
 *                 넘기면 안 된다 — 연속 성장 구간에서는 매일이 어제의 기록
 *                 +1이라, 매일 personalBest가 발동하는 v11 버그가 그대로
 *                 재발한다. 이 함정은 21일 시뮬레이션에서 실제로 밟아서
 *                 확인했다 (day4~8이 전부 personalBest로 잡혀 milestone과
 *                 stageTransition을 가려버렸다). 진행 중인 런은 아직 기록이
 *                 아니다 — 끊긴 뒤에야 기록이 된다.
 * @param {number} [input.stagesCount=3] - 세계관 단계 수 (stageTransition 판정용)
 * @returns {object} 서사 상태 — 아래 필드들 참조
 */
function resolveNarrativeState(input) {
  const {
    dateIso, goalStartDateIso, targetDateIso,
    archive, currentStreak, previousBestStreak,
    stagesCount = 3,
  } = input;

  const dayNo = daysBetween(goalStartDateIso, dateIso) + 1;
  const priorEntry = archive.length > 0 ? archive[archive.length - 1] : null;
  const gapDays = priorEntry ? daysBetween(priorEntry.dateIso, dateIso) : null;

  // --- 기간 기반 계산 (targetDateIso가 있을 때만) ---
  const daysTotal = targetDateIso ? daysBetween(goalStartDateIso, targetDateIso) + 1 : null;
  const daysLeft = targetDateIso ? daysBetween(dateIso, targetDateIso) : null;

  // --- 분기 조건들 (각각 "정확히 그 지점"에서만 참) ---
  const isFirstDay = dayNo === 1;
  const isFinalDay = daysLeft === 0;
  const isComeback = gapDays !== null && gapDays >= 2;
  const isStreakMilestone = STREAK_MILESTONES.includes(currentStreak);

  // personalBest: 이전 최고 기록을 "처음 넘어서는" 딱 그 날만.
  // (currentStreak > best 로 바꾸면 v11 버그 재발 — 절대 금지)
  const isPersonalBest =
    previousBestStreak != null &&
    previousBestStreak >= PERSONAL_BEST_MIN_PRIOR &&
    currentStreak === previousBestStreak + 1;

  // stageTransition: 단계가 실제로 바뀌는 날 = 8일째, 15일째 (7일 주기,
  // 마지막 단계 진입일까지만). 22일째 이후는 단계가 더 없으므로 발동 안 함.
  const stageIndexToday = Math.min(stagesCount - 1, Math.floor((dayNo - 1) / 7));
  const isStageTransition =
    dayNo > 1 &&
    (dayNo - 1) % 7 === 0 &&
    Math.floor((dayNo - 1) / 7) <= stagesCount - 1 &&
    stageIndexToday > 0;

  // halfway: 정확한 중간 날 하루만, 그리고 충분히 긴 목표만.
  const isHalfway =
    daysTotal !== null &&
    daysTotal >= HALFWAY_MIN_TOTAL_DAYS &&
    dayNo === Math.ceil(daysTotal / 2);

  // finalStretch: 남은 날이 정확히 1일 또는 2일.
  const isFinalStretch = daysLeft !== null && daysLeft >= 1 && daysLeft <= 2;

  return {
    dayNo,
    daysTotal,
    daysLeft,
    stageIndexToday,
    isFirstDay,
    isFinalDay,
    isComeback,
    gapDays,
    isPersonalBest,
    isStreakMilestone,
    isStageTransition,
    isHalfway,
    isFinalStretch,
    streak: currentStreak,
    priorEntry,
  };
}

/**
 * 우선순위대로 하나의 "분기 타입"을 결정한다.
 *
 * 우선순위 설계 근거:
 * 1. firstDay / finalDay — 시작과 끝은 다른 무엇과 겹쳐도 그 자체가 사건이다.
 * 2. comeback — 공백 후 복귀가 마일스톤 도달보다 서사적으로 더 중요하다
 *    (v11에서 검증된 기존 원칙, 그대로 유지).
 * 3. personalBest > milestone — 정해진 숫자(7일, 14일...)보다 "자기 자신의
 *    기록을 넘어선 날"이 더 희귀하고 더 개인적인 사건이므로.
 * 4. stageTransition > halfway > finalStretch — 세계관의 지형 변화가
 *    달력상의 위치보다 이야기에 더 큰 영향을 준다.
 * 5. ordinary — 나머지 모든 날.
 *
 * 겹칠 때 낮은 순위 정보가 사라지는 것은 아니다 — Layer 3은 state 전체를
 * 받으므로, 예컨대 finalDay 문장 안에서 gapDays를 언급할 수 있다.
 */
function resolveBranch(narrativeState) {
  const s = narrativeState;
  if (s.isFirstDay) return 'firstDay';
  if (s.isFinalDay) return 'finalDay';
  if (s.isComeback) return 'comeback';
  if (s.isPersonalBest) return 'personalBest';
  if (s.isStreakMilestone) return 'milestone';
  if (s.isStageTransition) return 'stageTransition';
  if (s.isHalfway) return 'halfway';
  if (s.isFinalStretch) return 'finalStretch';
  return 'ordinary';
}

/**
 * 결정론적 선택 — 같은 시드는 항상 같은 인덱스를 반환한다 (재현 가능성).
 * opener/closer 조합 선택, 폴백 제목 선택 등에 공통으로 쓰인다.
 */
function pickDeterministic(seedString, poolLength) {
  return Math.abs(hashStr(seedString)) % poolLength;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    STREAK_MILESTONES,
    PERSONAL_BEST_MIN_PRIOR,
    HALFWAY_MIN_TOTAL_DAYS,
    daysBetween,
    resolveNarrativeState,
    resolveBranch,
    pickDeterministic,
  };
}
