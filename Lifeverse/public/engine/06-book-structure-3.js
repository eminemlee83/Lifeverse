/**
 * LIFEVERSE Story Engine — Layer 6: Book Structure Engine (v3)
 * ============================================================
 * "낱장의 페이지를 어떻게 장(챕터)과 권(볼륨)으로 묶을지"를 담당한다.
 * v14의 ChapterEngine + LifeBookEngine에 대응.
 *
 * v14 원본은 EventBus(bus.on/bus.emit)로 구현되어 있었으나, 여기서는
 * 이벤트 의존을 제거하고 "현재 상태 + 새 레코드"를 받아 "다음 상태"를
 * 반환하는 순수 함수로 재구성했다 — Dart/Deno 포팅 시 이벤트 시스템을
 * 별도로 만들 필요 없이 그대로 옮길 수 있다.
 *
 * v2: 챕터 확정 시 기본 제목(title) 자동 부여 + buildChapterTitle() /
 * summarizeChapter()로 세계관 단계 결합 제목과 목차 요약 생성.
 *
 * v3 확장 (엔진 최대 업그레이드):
 * - summarizeChapter가 "걸었다"로 하드코딩돼 있어 모든 카테고리에서
 *   똑같이 "걸었다"가 나오던 문제 수정. categoryId를 받아 카테고리별
 *   동사("걸었다/공부했다/읽었다/…")로 요약한다. Layer 1을 import하지
 *   않고 자체 소형 동사맵을 두는 이유는, 이 계층이 "묶기"만 담당하고
 *   세계관 사전에 의존하지 않는다는 계층 방향(1→6 의존 없음)을 지키기
 *   위해서다. 동사맵이 없으면 중립 표현("채웠다")으로 폴백한다.
 * - buildChapterSubtitle 신규: "7일 중 6일, 활동 6 · 휴식 1" 같은
 *   한 줄 배지 텍스트. 서재 UI가 챕터를 카드로 보여줄 때 쓴다.
 * - buildVolumeTitle 신규: "제1권 — 첫 번째 계절" 형태의 권 제목.
 * - completeVolume의 목차 항목에 chapterNo뿐 아니라 주차 라벨을 붙여
 *   365일 목차가 "1주차·2주차…"로 읽히게 했다.
 * ============================================================
 */

const DAYS_PER_CHAPTER = 7;
const DAYS_PER_VOLUME = 365;

/**
 * 카테고리별 요약 동사 (v3). Layer 1에 의존하지 않기 위한 자체 소형 맵.
 * 없는 카테고리는 중립 동사로 폴백한다.
 */
const CHAPTER_VERBS = {
  exercise: '걸었다',
  health: '몸을 돌봤다',
  study: '공부했다',
  certificate: '파고들었다',
  language: '익혔다',
  reading: '읽었다',
  hobby: '만들었다',
  freegoal: '나아갔다',
};

function chapterVerb(categoryId) {
  return CHAPTER_VERBS[categoryId] || '채웠다';
}

/**
 * 챕터 버퍼에 오늘의 기록을 추가한다. 7일이 차면 챕터를 확정하고 버퍼를 비운다.
 *
 * @param {object} state - { buffer: Array, chapters: Array }
 * @param {object} dayRecord - { dateIso, tokens: Array<{type,value}>, isRestDay? }
 * @returns {object} 새 상태 (원본은 변경하지 않음, 불변 갱신)
 */
function appendDayToChapterBuffer(state, dayRecord) {
  const buffer = state.buffer.concat([dayRecord]);
  if (buffer.length < DAYS_PER_CHAPTER) {
    return { buffer, chapters: state.chapters };
  }
  const chapter = closeChapter(buffer, state.chapters.length + 1);
  return { buffer: [], chapters: state.chapters.concat([chapter]) };
}

/** 7일 버퍼로부터 챕터를 확정한다 — 날짜 범위 + 토큰 빈도 요약 + 기본 제목. */
function closeChapter(days, chapterNo) {
  const tokenFreq = {};
  days.forEach((d) => {
    (d.tokens || []).forEach((t) => {
      const key = t.type + ':' + (typeof t.value === 'object' ? JSON.stringify(t.value) : t.value);
      tokenFreq[key] = (tokenFreq[key] || 0) + 1;
    });
  });
  return {
    chapterNo,
    title: '제' + chapterNo + '장',
    startDate: days[0].dateIso,
    endDate: days[days.length - 1].dateIso,
    dayCount: days.length,
    tokenFrequency: tokenFreq,
    days,
  };
}

/** 7일이 안 찼어도 지금까지의 버퍼로 강제 마감한다 (예: 완결 시점에 남은 버퍼 정리). */
function forceCloseChapter(state) {
  if (state.buffer.length === 0) return state;
  const chapter = closeChapter(state.buffer, state.chapters.length + 1);
  return { buffer: [], chapters: state.chapters.concat([chapter]) };
}

/**
 * 세계관 단계를 결합한 챕터 제목을 만든다 (v2).
 * Layer 1의 getStage(categoryId, 챕터 첫날의 dayNo)로 얻은 단계 라벨을
 * 넘기면 "제2장 · 숨이 가빠지는 능선" 형태가 된다. 단계 라벨이 없으면
 * 기본 제목("제2장")을 그대로 돌려준다 — 이 함수는 순수 조합만 하고
 * Layer 1을 직접 import하지 않는다 (계층 방향: 1→3은 있어도 1→6은 없다.
 * 어떤 세계관 단계를 붙일지는 호스트가 결정할 문제다).
 */
function buildChapterTitle(chapter, stageLabel) {
  if (!stageLabel) return chapter.title || '제' + chapter.chapterNo + '장';
  return '제' + chapter.chapterNo + '장 · ' + stageLabel;
}

/**
 * 목차에 붙일 챕터 요약 한 줄을 만든다 (v2 도입, v3에서 카테고리 동사화).
 * dayRecord에 isRestDay가 있으면 활동/휴식을 구분해 세고, 없으면(구버전
 * 데이터) 전부 활동일로 취급한다 — 하위호환.
 * 예(exercise): "3.1 ~ 3.7 — 7일을 하루도 빠짐없이 걸었다"
 * 예(study):    "3.1 ~ 3.7 — 7일 중 6일을 공부했다"
 *
 * @param {object} chapter
 * @param {string} [categoryId] - 없으면 중립 동사("채웠다")로 폴백
 */
function summarizeChapter(chapter, categoryId) {
  const verb = chapterVerb(categoryId);
  const activeDays = chapter.days.filter((d) => !d.isRestDay).length;
  const fmt = (iso) => {
    const [, m, d] = iso.split('-');
    return parseInt(m, 10) + '.' + parseInt(d, 10);
  };
  const range = fmt(chapter.startDate) + ' ~ ' + fmt(chapter.endDate);
  if (activeDays === chapter.dayCount) {
    return range + ' — ' + chapter.dayCount + '일을 하루도 빠짐없이 ' + verb;
  }
  return range + ' — ' + chapter.dayCount + '일 중 ' + activeDays + '일을 ' + verb;
}

/**
 * 챕터 카드용 한 줄 배지 텍스트를 만든다 (v3 신규).
 * 예: "활동 6 · 휴식 1"
 */
function buildChapterSubtitle(chapter) {
  const activeDays = chapter.days.filter((d) => !d.isRestDay).length;
  const restDays = chapter.dayCount - activeDays;
  return '활동 ' + activeDays + ' · 휴식 ' + restDays;
}

/**
 * 인생책(LifeBook) 상태에 오늘 기록을 추가한다. 365일이 쌓일 때마다
 * 새 권(volume)의 목차(manifest)를 확정한다. 진짜 엔딩은 없다 — 계속 이어진다.
 *
 * @param {object} state - { allDays: Array, volumes: Array }
 * @param {object} dayRecord - { dateIso, tokens }
 */
function appendDayToLifeBook(state, dayRecord) {
  const allDays = state.allDays.concat([dayRecord]);
  const totalDays = allDays.length;
  if (totalDays === 0 || totalDays % DAYS_PER_VOLUME !== 0) {
    return { allDays, volumes: state.volumes };
  }
  const volumeNo = totalDays / DAYS_PER_VOLUME;
  const manifest = completeVolume(allDays, volumeNo);
  return { allDays, volumes: state.volumes.concat([manifest]) };
}

function completeVolume(allDays, volumeNo) {
  const start = (volumeNo - 1) * DAYS_PER_VOLUME;
  const days = allDays.slice(start, start + DAYS_PER_VOLUME);
  return {
    volumeNo,
    startDate: days[0].dateIso,
    endDate: days[days.length - 1].dateIso,
    dayCount: days.length,
    tableOfContents: days.map((d, i) => ({
      chapterNo: i + 1,
      weekLabel: Math.floor(i / DAYS_PER_CHAPTER) + 1 + '주차', // v3: 주차 라벨
      dateIso: d.dateIso,
    })),
  };
}

/**
 * 권(volume) 제목을 만든다 (v3 신규). "제1권 — 첫 번째 계절" 형태.
 * 순수 조합 함수. 계절 라벨은 호스트가 넘기거나, 없으면 권 번호만 쓴다.
 */
function buildVolumeTitle(volumeNo, seasonLabel) {
  if (!seasonLabel) return '제' + volumeNo + '권';
  return '제' + volumeNo + '권 — ' + seasonLabel;
}

/** 지금이 몇 권째, 그 권의 몇 일째인지 계산한다 (표지의 "제N권" 표시에 쓰임).
 *
 * ⚠️ 버그 수정 이력: v14 원본은 `total % DAYS_PER_VOLUME`으로 나머지가 0일 때
 * (정확히 365일, 730일 등 권이 막 끝난 시점) "다음 권 0일차"로 계산해버렸다.
 * 실제로는 365일째는 아직 1권의 마지막 날이어야 하는데 "2권 0일차"로 나오는
 * 경계값 버그였다 — 365일을 정확히 채우는 사용자가 드물어 지금까지 발견되지
 * 않았을 뿐, 이번에 챕터/볼륨 계층을 테스트하며 경계값을 직접 넣어보다가 발견했다.
 * `(total - 1) % DAYS_PER_VOLUME + 1` 형태로 1-based 계산으로 바꿔 수정했다. */
function getCurrentVolumeProgress(allDaysCount) {
  if (allDaysCount === 0) {
    return { currentVolumeNo: 1, daysIntoVolume: 0, daysRemaining: DAYS_PER_VOLUME, totalStoriesEver: 0 };
  }
  const daysIntoVolume = ((allDaysCount - 1) % DAYS_PER_VOLUME) + 1;
  const currentVolumeNo = Math.floor((allDaysCount - 1) / DAYS_PER_VOLUME) + 1;
  return {
    currentVolumeNo,
    daysIntoVolume,
    daysRemaining: DAYS_PER_VOLUME - daysIntoVolume,
    totalStoriesEver: allDaysCount,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    DAYS_PER_CHAPTER, DAYS_PER_VOLUME, CHAPTER_VERBS, chapterVerb,
    appendDayToChapterBuffer, closeChapter, forceCloseChapter,
    buildChapterTitle, summarizeChapter, buildChapterSubtitle,
    appendDayToLifeBook, completeVolume, buildVolumeTitle, getCurrentVolumeProgress,
  };
}
