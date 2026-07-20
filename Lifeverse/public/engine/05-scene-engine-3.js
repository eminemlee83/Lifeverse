/**
 * LIFEVERSE Story Engine — Layer 5: Scene Engine (v3)
 * ============================================================
 * "오늘 무엇을 할지"를 관리하는 계층. v14의 QuestEngine에 대응.
 *
 * v10 원칙: 하루 동안 고정, 재생성 불가 (장면 탭/재생성 버튼 삭제됨).
 * 이 원칙이 이 계층의 pickDailyScenes()에도 그대로 반영된다 — 같은 날짜는
 * 항상 같은 조합이 나온다(결정론적), 즉 "재생성"이라는 개념 자체가 없다.
 *
 * v2: FALLBACK_SCENES 도입 — 카테고리별 6개씩. AI 장면이 없어도
 * "6개 중 3개를 날짜 시드로 뽑는" 일일 조합이 항상 작동하게 했다.
 *
 * v3 확장 (엔진 최대 업그레이드):
 * 카테고리별 6개 → 12개로 배증. 조합 수가 6C3=20에서 12C3=220으로
 * 폭증한다 — 30일, 90일 목표에서도 매일 다른 3개 세트가 나올 만큼
 * 넉넉하다. v2에서는 20가지가 날짜 시드로 순환하면서 3~4주차에
 * 조합 반복이 눈에 띄었는데(장면 목록을 매일 보는 사용자에게는 티가
 * 난다), 12개로 늘리면서 이 문제가 사실상 사라진다.
 *
 * 추가된 6개는 기존 6개와 난이도·성격이 겹치지 않도록 배치했다:
 * 기존이 "핵심 실행"(걷기, 문제 풀기 등)에 몰려 있었다면, 추가분은
 * 준비/점검/회고/환경정비/작은승리 등 하루의 다른 국면을 담아서,
 * 3개가 뽑혔을 때 "준비-실행-마무리"처럼 자연스러운 하루가 되도록 했다.
 * 모든 라벨은 여전히 Layer 3의 buildMiddleClause에 끼워도 자연스러운
 * 명사형 행동("~하기")으로 통일 — "「30분 걷기」를 해냈다" 형태.
 * ============================================================
 */

// 브라우저에서는 01-world-vocab.js가 이미 <script>로 먼저 로드되어 hashStr가
// 전역에 있다. Node.js 환경에서만 require로 가져온다.
var hashStr;
if (typeof require === 'function') {
  hashStr = require('./01-world-vocab.js').hashStr;
}

/**
 * 두 32비트 해시(날짜, id)를 곱셈과 시프트로 충분히 확산시켜 하나의 시드로
 * 섞는다 (splitmix32 스타일 finalizer). XOR 단독으로는 "하루 차이(=dateHash가
 * 1만 증가)"가 낮은 비트만 바꿔서 정렬 상위 집합이 고정되던 문제(위 버그
 * 이력 참조)를, 이 믹서가 상위 비트까지 눈사태처럼 퍼뜨려 해결한다.
 * Math.imul은 32비트 곱셈의 하위 32비트를 정확히 주므로 오버플로 걱정이 없다.
 */
function mixSeed(a, b) {
  let h = (a ^ Math.imul(b, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h;
}

/**
 * 카테고리별 기본 장면 풀 (v3: 각 12개). pickDailyScenes(count=3)와
 * 조합하면 하루 3개 × 220가지 조합(12C3)이 날짜 시드로 순환한다.
 * id 규칙: 'fb-{카테고리 축약}-{번호}' (fallback의 fb).
 */
const FALLBACK_SCENES = [
  // 운동 — 산맥
  { id: 'fb-ex-1',  category: 'exercise', label: '몸 깨우는 스트레칭 5분' },
  { id: 'fb-ex-2',  category: 'exercise', label: '30분 이상 걷거나 달리기' },
  { id: 'fb-ex-3',  category: 'exercise', label: '근력 운동 한 세트' },
  { id: 'fb-ex-4',  category: 'exercise', label: '엘리베이터 대신 계단 오르기' },
  { id: 'fb-ex-5',  category: 'exercise', label: '운동 직후 몸 상태 한 줄 기록하기' },
  { id: 'fb-ex-6',  category: 'exercise', label: '자기 전 가벼운 마무리 스트레칭' },
  { id: 'fb-ex-7',  category: 'exercise', label: '오늘의 목표 거리·횟수 정하기' },
  { id: 'fb-ex-8',  category: 'exercise', label: '운동 전 관절 풀기 3분' },
  { id: 'fb-ex-9',  category: 'exercise', label: '어제보다 한 세트 또는 5분 더 하기' },
  { id: 'fb-ex-10', category: 'exercise', label: '물 한 컵 마시고 시작하기' },
  { id: 'fb-ex-11', category: 'exercise', label: '운동 사진이나 기록 남기기' },
  { id: 'fb-ex-12', category: 'exercise', label: '내일 운동할 시간 미리 정해두기' },
  // 공부 — 안개 도서관
  { id: 'fb-st-1',  category: 'study', label: '책상 정리하고 자리에 앉기' },
  { id: 'fb-st-2',  category: 'study', label: '핵심 개념 1개 정리하기' },
  { id: 'fb-st-3',  category: 'study', label: '문제 5개 풀기' },
  { id: 'fb-st-4',  category: 'study', label: '어제 배운 것 3분 복습하기' },
  { id: 'fb-st-5',  category: 'study', label: '모르는 것 1개 찾아서 해결하기' },
  { id: 'fb-st-6',  category: 'study', label: '오늘 배운 것 한 문장으로 요약하기' },
  { id: 'fb-st-7',  category: 'study', label: '오늘 공부할 범위 정하기' },
  { id: 'fb-st-8',  category: 'study', label: '25분 집중 타이머 한 번 돌리기' },
  { id: 'fb-st-9',  category: 'study', label: '헷갈린 개념 예시로 다시 설명해보기' },
  { id: 'fb-st-10', category: 'study', label: '휴대폰 멀리 두고 시작하기' },
  { id: 'fb-st-11', category: 'study', label: '오답 1개 다시 풀어보기' },
  { id: 'fb-st-12', category: 'study', label: '내일 공부할 것 한 줄 메모하기' },
  // 독서 — 기록보관소
  { id: 'fb-re-1',  category: 'reading', label: '10분 이상 읽기' },
  { id: 'fb-re-2',  category: 'reading', label: '인상 깊은 문장 1개 옮겨 적기' },
  { id: 'fb-re-3',  category: 'reading', label: '어제 읽은 내용 떠올려 보기' },
  { id: 'fb-re-4',  category: 'reading', label: '한 챕터 끝까지 읽기' },
  { id: 'fb-re-5',  category: 'reading', label: '읽으며 든 생각 한 줄 남기기' },
  { id: 'fb-re-6',  category: 'reading', label: '내일 읽을 부분 표시해 두기' },
  { id: 'fb-re-7',  category: 'reading', label: '읽을 자리 만들고 앉기' },
  { id: 'fb-re-8',  category: 'reading', label: '목차나 소제목 한 번 훑기' },
  { id: 'fb-re-9',  category: 'reading', label: '모르는 단어 1개 찾아보기' },
  { id: 'fb-re-10', category: 'reading', label: '읽은 쪽수 기록하기' },
  { id: 'fb-re-11', category: 'reading', label: '한 문단 소리 내어 읽기' },
  { id: 'fb-re-12', category: 'reading', label: '오늘 읽은 내용 누군가에게 말하듯 정리하기' },
  // 자격증 — 잠긴 탑
  { id: 'fb-ce-1',  category: 'certificate', label: '기출문제 5개 풀기' },
  { id: 'fb-ce-2',  category: 'certificate', label: '오답 1개 원인 분석하기' },
  { id: 'fb-ce-3',  category: 'certificate', label: '핵심 암기사항 10분 복습하기' },
  { id: 'fb-ce-4',  category: 'certificate', label: '강의 또는 교재 한 단원 나가기' },
  { id: 'fb-ce-5',  category: 'certificate', label: '요약 노트 반 페이지 정리하기' },
  { id: 'fb-ce-6',  category: 'certificate', label: '남은 기간 계획 점검하기' },
  { id: 'fb-ce-7',  category: 'certificate', label: '오늘 학습 목표 1개 정하기' },
  { id: 'fb-ce-8',  category: 'certificate', label: '자주 틀리는 유형 5분 집중 보기' },
  { id: 'fb-ce-9',  category: 'certificate', label: '암기 카드 10장 넘겨보기' },
  { id: 'fb-ce-10', category: 'certificate', label: '실전처럼 시간 재고 문제 풀기' },
  { id: 'fb-ce-11', category: 'certificate', label: '헷갈리는 개념 표로 비교하기' },
  { id: 'fb-ce-12', category: 'certificate', label: '내일 볼 범위 미리 표시하기' },
  // 외국어 — 항구
  { id: 'fb-la-1',  category: 'language', label: '새 단어 5개 외우기' },
  { id: 'fb-la-2',  category: 'language', label: '예문 3개 소리 내어 읽기' },
  { id: 'fb-la-3',  category: 'language', label: '10분 듣기 연습하기' },
  { id: 'fb-la-4',  category: 'language', label: '문장 3개 직접 만들어 보기' },
  { id: 'fb-la-5',  category: 'language', label: '어제 외운 단어 복습하기' },
  { id: 'fb-la-6',  category: 'language', label: '짧은 글 한 단락 읽기' },
  { id: 'fb-la-7',  category: 'language', label: '오늘 배울 주제 정하기' },
  { id: 'fb-la-8',  category: 'language', label: '원어민 발음 따라 말하기 5분' },
  { id: 'fb-la-9',  category: 'language', label: '배운 표현으로 혼잣말 해보기' },
  { id: 'fb-la-10', category: 'language', label: '자막 없이 1분 영상 보기' },
  { id: 'fb-la-11', category: 'language', label: '오늘 외운 단어 예문에 넣어보기' },
  { id: 'fb-la-12', category: 'language', label: '내일 외울 단어 미리 골라두기' },
  // 건강 — 성벽
  { id: 'fb-he-1',  category: 'health', label: '물 6잔 이상 마시기' },
  { id: 'fb-he-2',  category: 'health', label: '채소 들어간 식사 한 끼 챙기기' },
  { id: 'fb-he-3',  category: 'health', label: '정한 시간에 잠자리 들기' },
  { id: 'fb-he-4',  category: 'health', label: '10분 산책하기' },
  { id: 'fb-he-5',  category: 'health', label: '스트레칭이나 가벼운 요가 하기' },
  { id: 'fb-he-6',  category: 'health', label: '오늘 컨디션 한 줄 기록하기' },
  { id: 'fb-he-7',  category: 'health', label: '아침에 일어나 물 한 잔 마시기' },
  { id: 'fb-he-8',  category: 'health', label: '햇빛 5분 쐬기' },
  { id: 'fb-he-9',  category: 'health', label: '군것질 대신 과일 한 조각 먹기' },
  { id: 'fb-he-10', category: 'health', label: '자기 전 화면 30분 일찍 끄기' },
  { id: 'fb-he-11', category: 'health', label: '심호흡 열 번 하기' },
  { id: 'fb-he-12', category: 'health', label: '오늘 먹은 것 간단히 적어두기' },
  // 취미 — 창조의 정원
  { id: 'fb-ho-1',  category: 'hobby', label: '15분 이상 작업하기' },
  { id: 'fb-ho-2',  category: 'hobby', label: '새로운 기법 1개 시도해 보기' },
  { id: 'fb-ho-3',  category: 'hobby', label: '어제 작업물 다시 살펴보기' },
  { id: 'fb-ho-4',  category: 'hobby', label: '재료와 도구 정리하기' },
  { id: 'fb-ho-5',  category: 'hobby', label: '참고 자료 1개 찾아보기' },
  { id: 'fb-ho-6',  category: 'hobby', label: '오늘 만든 것 사진으로 남기기' },
  { id: 'fb-ho-7',  category: 'hobby', label: '오늘 만들 것 하나 정하기' },
  { id: 'fb-ho-8',  category: 'hobby', label: '마음에 드는 작품 하나 감상하기' },
  { id: 'fb-ho-9',  category: 'hobby', label: '작은 부분 하나 완성하기' },
  { id: 'fb-ho-10', category: 'hobby', label: '떠오른 아이디어 메모하기' },
  { id: 'fb-ho-11', category: 'hobby', label: '작업 공간 정돈하고 시작하기' },
  { id: 'fb-ho-12', category: 'hobby', label: '다음에 시도할 것 적어두기' },
  // 자유 목표 — 이름 없는 길
  { id: 'fb-fr-1',  category: 'freegoal', label: '목표 관련 행동 1개 실행하기' },
  { id: 'fb-fr-2',  category: 'freegoal', label: '15분 집중 시간 갖기' },
  { id: 'fb-fr-3',  category: 'freegoal', label: '진행 상황 한 줄 기록하기' },
  { id: 'fb-fr-4',  category: 'freegoal', label: '다음 단계 1개 정하기' },
  { id: 'fb-fr-5',  category: 'freegoal', label: '방해 요소 1개 치우기' },
  { id: 'fb-fr-6',  category: 'freegoal', label: '오늘의 가장 작은 한 걸음 내딛기' },
  { id: 'fb-fr-7',  category: 'freegoal', label: '오늘 할 일 한 가지 고르기' },
  { id: 'fb-fr-8',  category: 'freegoal', label: '5분만 먼저 시작해보기' },
  { id: 'fb-fr-9',  category: 'freegoal', label: '어제 한 것 이어서 하기' },
  { id: 'fb-fr-10', category: 'freegoal', label: '잘된 점 하나 적어두기' },
  { id: 'fb-fr-11', category: 'freegoal', label: '필요한 것 하나 미리 준비하기' },
  { id: 'fb-fr-12', category: 'freegoal', label: '내일 할 첫 번째 일 정해두기' },
];

/**
 * 장면 정의 저장소. goal.categoryId로 필터링해서 오늘의 3개를 뽑는 데 쓴다.
 * (실제 서비스에서는 AI가 생성하거나 FALLBACK_SCENES에서 오지만, 이 계층은
 * "이미 있는 정의들 중에서 어떻게 고정적으로 고를지"만 담당한다)
 */
class SceneRegistry {
  constructor(sceneDefs = []) {
    this.sceneDefs = new Map(sceneDefs.map((s) => [s.id, s]));
  }

  addSceneDef(sceneDef) {
    this.sceneDefs.set(sceneDef.id, sceneDef);
  }

  getSceneDef(sceneId) {
    return this.sceneDefs.get(sceneId) || null;
  }

  listSceneDefs() {
    return Array.from(this.sceneDefs.values());
  }

  getByCategory(categoryId) {
    return this.listSceneDefs().filter((s) => !s.category || s.category === categoryId);
  }

  /**
   * 오늘(dateIso)을 시드로 결정론적으로 count개를 뽑는다.
   * 같은 날짜엔 항상 같은 조합이 나와 재현 가능하다 — 이게 "재생성 불가" 원칙의
   * 실제 구현 근거다. 후보가 count보다 적으면 있는 만큼만 반환한다.
   *
   * ⚠️ 버그 수정 이력 (v3에서 근본 재수정):
   * v14 원본은 다항식 해시로 시드를 만들어 "상대 정렬 순서"가 날짜가 바뀌어도
   * 거의 유지되는 문제가 있었다. v2에서 dateHash ^ hashStr(id) 로 바꿨지만,
   * 이 XOR 단독 방식에도 같은 계열의 버그가 남아 있었다 — 연속된 날짜의
   * dateHash는 1씩만 증가하는데(하루 차이) XOR은 낮은 비트만 건드리므로,
   * id 해시가 가장 큰 몇 개가 매일 상위에 고정돼 뽑혔다. 후보가 6개일 때는
   * 티가 덜 났지만 v3에서 12개로 늘리며 30일 전체가 동일 조합으로 나오는 것을
   * 시뮬레이션에서 발견했다. splitmix 스타일 믹서(mixSeed)로 날짜·id를 곱셈과
   * 시프트로 충분히 확산시켜, 하루 차이의 입력도 완전히 다른 순열을 내도록
   * 근본 수정했다. 검증: exercise 30일 = 30가지 유니크 조합.
   */
  pickDailyScenes(categoryId, dateIso, count = 3) {
    const pool = this.getByCategory(categoryId);
    if (pool.length === 0) return [];
    const dateHash = hashStr(dateIso);
    const shuffled = pool
      .map((s) => ({ s, key: mixSeed(dateHash, hashStr(s.id)) }))
      .sort((a, b) => a.key - b.key)
      .map((x) => x.s);
    return shuffled.slice(0, Math.min(count, shuffled.length));
  }
}

/**
 * 기본 장면 풀이 미리 채워진 레지스트리를 만든다 (v2 신규).
 * 온보딩 직후 AI 장면이 아직 없는 상태에서도 하루가 시작될 수 있게 한다.
 * AI 생성 장면은 addSceneDef로 나중에 얹으면 되고, 같은 카테고리 안에서
 * 폴백과 AI 장면이 섞여도 pickDailyScenes의 결정론은 그대로 유지된다.
 */
function createDefaultRegistry() {
  return new SceneRegistry(FALLBACK_SCENES);
}

/**
 * 오늘 체크한 장면 id들로부터, 완료 기록(sceneLog)을 만든다.
 * 이 기록은 story_pages와 별개로 scene_logs 테이블에 저장되는 대상이며,
 * scene 정의가 나중에 바뀌어도(재배정 등) 로그 자체는 불변으로 남아야 한다
 * (명세서 5.4 — scene_labels_snapshot으로 라벨도 스냅샷 보존).
 */
function buildSceneLog({ dateIso, checkedSceneIds, sceneRegistry, memo }) {
  const labels = checkedSceneIds
    .map((id) => sceneRegistry.getSceneDef(id))
    .filter(Boolean)
    .map((def) => def.label);

  return {
    dateIso,
    sceneIds: checkedSceneIds.slice(),
    sceneLabelsSnapshot: labels,
    memo: (memo || '').trim() || null,
    isRestDay: checkedSceneIds.length === 0,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SceneRegistry, buildSceneLog, FALLBACK_SCENES, createDefaultRegistry };
}
