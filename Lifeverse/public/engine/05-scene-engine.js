/**
 * LIFEVERSE Story Engine — Layer 5: Scene Engine (v2)
 * ============================================================
 * "오늘 무엇을 할지"를 관리하는 계층. v14의 QuestEngine에 대응.
 *
 * v10 원칙: 하루 동안 고정, 재생성 불가 (장면 탭/재생성 버튼 삭제됨).
 * 이 원칙이 이 계층의 pickDailyScenes()에도 그대로 반영된다 — 같은 날짜는
 * 항상 같은 조합이 나온다(결정론적), 즉 "재생성"이라는 개념 자체가 없다.
 *
 * v2 확장: FALLBACK_SCENES 추가 — 카테고리별 6개씩, 총 48개의 기본 장면
 * 정의. 지금까지 SceneRegistry는 빈 껍데기로 시작해서 AI 생성 장면이
 * 없으면 pickDailyScenes가 빈 배열을 돌려줬다. 이제 오프라인이거나 AI가
 * 실패해도 "6개 중 3개를 날짜 시드로 뽑는" 일일 조합이 항상 작동한다.
 * 라벨은 전부 Layer 3의 buildMiddleClause에 끼워도 자연스러운 명사형
 * 행동("~하기")으로 통일했다 — "「30분 걷기」를 해냈다" 형태가 되도록.
 * ============================================================
 */

// 브라우저에서는 01-world-vocab.js가 이미 <script>로 먼저 로드되어 hashStr가
// 전역에 있다. Node.js 환경에서만 require로 가져온다.
var hashStr;
if (typeof require === 'function') {
  hashStr = require('./01-world-vocab.js').hashStr;
}

/**
 * 카테고리별 기본 장면 풀 (v2 신규). 각 6개 — pickDailyScenes(count=3)와
 * 조합하면 하루 3개 × 20가지 조합(6C3)이 날짜 시드로 순환한다.
 * id 규칙: 'fb-{카테고리 축약}-{번호}' (fallback의 fb).
 */
const FALLBACK_SCENES = [
  // 운동 — 산맥
  { id: 'fb-ex-1', category: 'exercise', label: '몸 깨우는 스트레칭 5분' },
  { id: 'fb-ex-2', category: 'exercise', label: '30분 이상 걷거나 달리기' },
  { id: 'fb-ex-3', category: 'exercise', label: '근력 운동 한 세트' },
  { id: 'fb-ex-4', category: 'exercise', label: '엘리베이터 대신 계단 오르기' },
  { id: 'fb-ex-5', category: 'exercise', label: '운동 직후 몸 상태 한 줄 기록하기' },
  { id: 'fb-ex-6', category: 'exercise', label: '자기 전 가벼운 마무리 스트레칭' },
  // 공부 — 안개 도서관
  { id: 'fb-st-1', category: 'study', label: '책상 정리하고 자리에 앉기' },
  { id: 'fb-st-2', category: 'study', label: '핵심 개념 1개 정리하기' },
  { id: 'fb-st-3', category: 'study', label: '문제 5개 풀기' },
  { id: 'fb-st-4', category: 'study', label: '어제 배운 것 3분 복습하기' },
  { id: 'fb-st-5', category: 'study', label: '모르는 것 1개 찾아서 해결하기' },
  { id: 'fb-st-6', category: 'study', label: '오늘 배운 것 한 문장으로 요약하기' },
  // 독서 — 기록보관소
  { id: 'fb-re-1', category: 'reading', label: '10분 이상 읽기' },
  { id: 'fb-re-2', category: 'reading', label: '인상 깊은 문장 1개 옮겨 적기' },
  { id: 'fb-re-3', category: 'reading', label: '어제 읽은 내용 떠올려 보기' },
  { id: 'fb-re-4', category: 'reading', label: '한 챕터 끝까지 읽기' },
  { id: 'fb-re-5', category: 'reading', label: '읽으며 든 생각 한 줄 남기기' },
  { id: 'fb-re-6', category: 'reading', label: '내일 읽을 부분 표시해 두기' },
  // 자격증 — 잠긴 탑
  { id: 'fb-ce-1', category: 'certificate', label: '기출문제 5개 풀기' },
  { id: 'fb-ce-2', category: 'certificate', label: '오답 1개 원인 분석하기' },
  { id: 'fb-ce-3', category: 'certificate', label: '핵심 암기사항 10분 복습하기' },
  { id: 'fb-ce-4', category: 'certificate', label: '강의 또는 교재 한 단원 나가기' },
  { id: 'fb-ce-5', category: 'certificate', label: '요약 노트 반 페이지 정리하기' },
  { id: 'fb-ce-6', category: 'certificate', label: '남은 기간 계획 점검하기' },
  // 외국어 — 항구
  { id: 'fb-la-1', category: 'language', label: '새 단어 5개 외우기' },
  { id: 'fb-la-2', category: 'language', label: '예문 3개 소리 내어 읽기' },
  { id: 'fb-la-3', category: 'language', label: '10분 듣기 연습하기' },
  { id: 'fb-la-4', category: 'language', label: '문장 3개 직접 만들어 보기' },
  { id: 'fb-la-5', category: 'language', label: '어제 외운 단어 복습하기' },
  { id: 'fb-la-6', category: 'language', label: '짧은 글 한 단락 읽기' },
  // 건강 — 성벽
  { id: 'fb-he-1', category: 'health', label: '물 6잔 이상 마시기' },
  { id: 'fb-he-2', category: 'health', label: '채소 들어간 식사 한 끼 챙기기' },
  { id: 'fb-he-3', category: 'health', label: '정한 시간에 잠자리 들기' },
  { id: 'fb-he-4', category: 'health', label: '10분 산책하기' },
  { id: 'fb-he-5', category: 'health', label: '스트레칭이나 가벼운 요가 하기' },
  { id: 'fb-he-6', category: 'health', label: '오늘 컨디션 한 줄 기록하기' },
  // 취미 — 창조의 정원
  { id: 'fb-ho-1', category: 'hobby', label: '15분 이상 작업하기' },
  { id: 'fb-ho-2', category: 'hobby', label: '새로운 기법 1개 시도해 보기' },
  { id: 'fb-ho-3', category: 'hobby', label: '어제 작업물 다시 살펴보기' },
  { id: 'fb-ho-4', category: 'hobby', label: '재료와 도구 정리하기' },
  { id: 'fb-ho-5', category: 'hobby', label: '참고 자료 1개 찾아보기' },
  { id: 'fb-ho-6', category: 'hobby', label: '오늘 만든 것 사진으로 남기기' },
  // 자유 목표 — 이름 없는 길
  { id: 'fb-fr-1', category: 'freegoal', label: '목표 관련 행동 1개 실행하기' },
  { id: 'fb-fr-2', category: 'freegoal', label: '15분 집중 시간 갖기' },
  { id: 'fb-fr-3', category: 'freegoal', label: '진행 상황 한 줄 기록하기' },
  { id: 'fb-fr-4', category: 'freegoal', label: '다음 단계 1개 정하기' },
  { id: 'fb-fr-5', category: 'freegoal', label: '방해 요소 1개 치우기' },
  { id: 'fb-fr-6', category: 'freegoal', label: '오늘의 가장 작은 한 걸음 내딛기' },
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
   * ⚠️ 버그 수정 이력: 원래 v14 원본은 hashStr(dateIso + ':' + id + ':' + i) 형태로
   * 시드를 만들었는데, 이 함수가 다항식 해시(h = h*31 + charCode)라서 문자열
   * 뒷부분만 바뀌면 전체 해시값이 거의 선형적으로만 이동해 "상대 정렬 순서"가
   * 날짜가 바뀌어도 거의 그대로 유지되는 문제가 있었다. 후보가 3개뿐일 때는
   * (실제 서비스 대부분의 경우) 안 드러났지만, 후보 6개 중 3개를 뽑는 시나리오로
   * 이 엔진 계층을 검증하다가 실제로 재현되어 발견했다. 날짜 해시와 id 해시를
   * 따로 만들어 XOR로 섞는 방식으로 근본 수정했다.
   */
  pickDailyScenes(categoryId, dateIso, count = 3) {
    const pool = this.getByCategory(categoryId);
    if (pool.length === 0) return [];
    const dateHash = hashStr(dateIso);
    const shuffled = pool
      .map((s) => ({ s, key: (dateHash ^ hashStr(s.id)) >>> 0 }))
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
