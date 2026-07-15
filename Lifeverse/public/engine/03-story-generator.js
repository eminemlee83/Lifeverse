/**
 * LIFEVERSE Story Engine — Layer 3: Story Generator (v2)
 * ============================================================
 * Layer 1(세계관) + Layer 2(분기 규칙)을 입력받아 최종 문장을 만든다.
 * AI 미사용 경로(폴백)와 AI 프롬프트 구성 양쪽에서 공유하는 계층이다.
 *
 * 톤 원칙 (v12에서 확정, 되돌리지 말 것):
 * "노을은 아름다웠다" 같은 감상이 아니라 "오늘의 선택으로 문이 조금 열렸다"처럼
 * 구체적으로 뭔가 열렸고, 그 너머가 아직 안 밝혀졌다는 "기대감" 구조로 통일한다.
 * 감동이 아니라 기대감이 목적이다.
 *
 * v2 확장 — 훅 시스템 (이 버전의 핵심):
 * 지금까지 closer는 기대감을 "만들기만" 했다 — "낯선 표지판이 보였다"고
 * 해놓고 다음 날 이야기는 그것을 전혀 이어받지 않았다. 기대를 만들고
 * 회수하지 않으면 그 약속은 사기가 된다. v2에서는:
 *   1. closer가 카테고리 모티프에서 오브젝트를 뽑아 teaser를 남기고,
 *      반환값에 hook: { objectId }를 포함한다.
 *   2. 호스트는 hook을 storyPage와 함께 저장한다 (archive entry에 포함).
 *   3. 다음 날 generateTodayStory가 priorEntry.hook을 발견하면,
 *      이야기 첫머리에서 그 오브젝트의 reveal로 실제로 회수한다.
 *   4. reveal 자체가 또 다른 미확인을 남기므로 (Layer 1 작성 원칙),
 *      회수가 곧 다음 기대의 시작이 된다.
 * 오브젝트는 archive에 기록된 과거 hook들을 제외하고 뽑으므로 한 목표
 * 안에서 같은 teaser가 두 번 등장하지 않는다 (풀 소진 시 훅 없는
 * closer로 자연 전환). 상태 저장소 없이 archive만으로 판정하므로
 * 결정론성과 순수 함수 원칙이 그대로 유지된다.
 *
 * 시드 설계 원칙 (Layer 5의 XOR 교훈을 여기에도 적용):
 * 다항식 해시는 문자열 뒷부분만 바꾸면 해시가 거의 선형 이동한다.
 * 여러 독립 선택(오프너/감각/훅 여부/오브젝트)에 "같은 시드 + 다른
 * 나눗셈"을 쓰면 선택들이 서로 상관돼 조합 다양성이 죽는다. 그래서
 * 선택마다 별도 salt를 XOR로 섞은 독립 시드를 쓴다.
 *
 * 하위호환: generateTodayStory의 기존 입력만 넘기면 기존과 같은 방식으로
 * 동작한다 (targetDateIso 없으면 기간 분기 미발동, archive entry에 hook이
 * 없으면 회수 없음). 반환값에 hook 필드가 추가됐다 — 호스트는 이것을
 * storyPage에 저장해줘야 훅 체인이 이어진다.
 * ============================================================
 */

// 브라우저에서는 01/02번 파일이 이미 <script>로 먼저 로드되어 아래 이름들이
// 전역에 있다. Node.js 환경에서만 require로 명시적으로 가져온다.
// (02-narrative-rules.js의 동일한 가드 패턴 참고 — 이유도 동일)
var getVocab, getMotifs, getStageIndex, withObjectParticle, withSubjectParticle, hashStr;
var resolveNarrativeState, resolveBranch;
if (typeof require === 'function') {
  ({ getVocab, getMotifs, getStageIndex, withObjectParticle, withSubjectParticle, hashStr } = require('./01-world-vocab.js'));
  ({ resolveNarrativeState, resolveBranch } = require('./02-narrative-rules.js'));
}

const RESERVED_MAX_QUOTE_LEN = 60; // 발췌 인용 시 자르는 길이 (소설 미리보기용, Layer 4에서 사용)

/** 훅이 걸릴 수 있는 분기. firstDay는 항상 훅(첫날의 기대가 다음 날의
 *  방문 이유가 된다), finalDay는 절대 훅 금지(내일이 없는 날에 내일을
 *  약속하면 안 된다). stageTransition/halfway는 자체 closer의 메시지가
 *  강해서 훅 없이 둔다. */
const HOOK_ALWAYS_BRANCHES = ['firstDay'];
const HOOK_ELIGIBLE_BRANCHES = ['ordinary', 'milestone', 'comeback', 'personalBest', 'finalStretch'];

/** 독립 시드 — 날짜/카테고리/용도(salt)를 XOR로 섞는다. */
function seedFor(dateIso, categoryId, salt) {
  return ((hashStr(dateIso || '') ^ hashStr(categoryId || '') ^ hashStr(salt)) >>> 0);
}

/* ------------------------------------------------------------------
 * 훅 시스템
 * ------------------------------------------------------------------ */

/** archive에서 이미 teaser로 등장했던 오브젝트 id 목록을 뽑는다. */
function collectUsedHookIds(archive) {
  const used = [];
  (archive || []).forEach((e) => {
    if (e && e.hook && e.hook.objectId) used.push(e.hook.objectId);
  });
  return used;
}

/**
 * 오늘 심을 훅 오브젝트를 결정한다. 폴백 경로와 AI 경로가 이 함수 하나를
 * 공유해야 훅 체인이 어긋나지 않는다.
 * @returns {{objectId, teaser, reveal}|null} 훅 없음이면 null
 */
function pickHookObject({ categoryId, dateIso, archive, branch }) {
  const always = HOOK_ALWAYS_BRANCHES.includes(branch);
  const eligible = always || HOOK_ELIGIBLE_BRANCHES.includes(branch);
  if (!eligible) return null;

  const motifs = getMotifs(categoryId);
  const used = collectUsedHookIds(archive);
  const remaining = motifs.objects.filter((o) => !used.includes(o.id));
  if (remaining.length === 0) return null; // 풀 소진 — 훅 없는 closer로 자연 전환

  // 훅 발동 여부: firstDay는 항상, 그 외에는 약 1/3 확률(결정론적).
  // 매일 훅이면 "회수→새 티저" 패턴 자체가 반복으로 느껴진다. 훅은 희소해야 훅이다.
  if (!always && seedFor(dateIso, categoryId, 'hook-on') % 3 !== 0) return null;

  const idx = seedFor(dateIso, categoryId, 'hook-obj') % remaining.length;
  const obj = remaining[idx];
  return { objectId: obj.id, teaser: obj.teaser, reveal: obj.reveal };
}

/**
 * 어제(또는 며칠 전) 심어둔 훅을 회수하는 문장을 만든다.
 * @returns {string|null} 회수할 훅이 없으면 null
 */
function buildHookReveal({ priorEntry, gapDays, categoryId }) {
  if (!priorEntry || !priorEntry.hook || !priorEntry.hook.objectId) return null;
  const motifs = getMotifs(categoryId);
  const obj = motifs.objects.find((o) => o.id === priorEntry.hook.objectId);
  if (!obj) return null;

  if (gapDays === 1) {
    return '어제 멀리 보였던 ' + withSubjectParticle(obj.teaser) + ' 오늘 손에 닿는 거리까지 다가왔다. ' + obj.reveal;
  }
  // 공백 후 복귀 — 떠나 있던 동안에도 그것은 기다리고 있었다.
  return '며칠 전 멀리 보였던 ' + obj.teaser + ' — 놀랍게도 그것은 아직 그 자리에서 기다리고 있었다. ' + obj.reveal;
}

/** 훅을 심는 closer. teaser를 문장 틀에 끼운다 (틀 3종, 결정론적). */
function buildHookCloser({ hookObject, dateIso, categoryId }) {
  const t = hookObject.teaser;
  const FRAMES = [
    '그리고 걸음이 멈춘 자리에서, ' + withSubjectParticle(t) + ' 눈에 들어왔다. 내일 조금만 더 가면, 그것이 무엇인지 알 수 있을 것이다.',
    '오늘의 마지막 모퉁이에서 ' + withSubjectParticle(t) + ' 시야에 걸렸다. 아직은 멀다. 하지만 내일이면 닿을 수 있는 거리다.',
    '저만치 앞에 ' + withSubjectParticle(t) + ' 보였다. 오늘은 여기까지 — 저것의 정체는 내일의 몫으로 남겨 두었다.',
  ];
  return FRAMES[seedFor(dateIso, categoryId, 'hook-frame') % FRAMES.length];
}

/* ------------------------------------------------------------------
 * 휴식일
 * ------------------------------------------------------------------ */

/** 휴식일(장면 완료 0개) 문장 5종 — 결정론적 선택. */
function buildRestDayLine({ categoryId, stage, setting, dateIso, memo }) {
  const restLines = [
    '오늘, 주인공은 ' + stage + '에서 걸음을 멈추고 잠시 숨을 골랐다. ' + setting + '은 잠시 멈췄을 뿐, 사라지지 않았다.',
    '오늘은 ' + stage + '에 머물렀다. 다시 걷기 시작하면, 이야기는 그 자리에서 이어질 것이다.',
    '오늘, ' + setting + '의 한 페이지가 조용히 비어 있었다. 하지만 책은 여전히 그의 것이었다.',
    '오늘, ' + setting + '의 시간은 주인공 없이도 천천히 흘렀다. 자리는 비운 것이 아니라 맡겨 둔 것이었다.',
    '쉼표 하나. 문장이 끝난 것이 아니라, 다음 문장을 위해 숨을 고른 것이다. ' + stage + '는 그대로 그 자리에 있었다.',
  ];
  const idx = Math.abs(hashStr((dateIso || '') + 'rest')) % restLines.length;
  let body = restLines[idx];
  if (memo) body += ' 그리고 이 한 마디를 남겼다 — "' + memo + '"';
  return body;
}

/* ------------------------------------------------------------------
 * 본문 조각들
 * ------------------------------------------------------------------ */

/** 완료한 장면 라벨들을 하나의 "middle" 문장 조각으로 합친다. */
function buildMiddleClause(questLabels) {
  if (questLabels.length === 1) {
    return withObjectParticle(questLabels[0]) + ' 해냈다';
  }
  if (questLabels.length === 2) {
    return questLabels[0] + '와(과) ' + withObjectParticle(questLabels[1]) + ' 모두 해냈다';
  }
  const lastLabel = questLabels[questLabels.length - 1];
  return questLabels.slice(0, -1).join(', ') + ', 그리고 ' + withObjectParticle(lastLabel) + ' 해냈다';
}

/** 감각 문장 — 약 절반의 날에만 결정론적으로 삽입된다. 매일 넣으면
 *  그것대로 패턴이 되므로, 리듬을 위해 절반만. */
function pickSenseLine({ categoryId, dateIso, dayNo }) {
  if (seedFor(dateIso, categoryId, 'sense-on') % 2 !== 0) return null;
  const senses = getMotifs(categoryId).senses;
  return senses[(seedFor(dateIso, categoryId, 'sense-idx') + dayNo) % senses.length];
}

/**
 * 분기별 opener/closer를 만든다. hookObject가 주어지면 closer는 훅 심는
 * 문장이 되고, revealUsed가 참이면 opener는 회수 뒤에 자연스럽게 이어지는
 * 연결형으로 바뀐다.
 */
function buildOpenerCloser({
  branch, stage, prevStage, setting, dateIso, categoryId, questLabels,
  gapDays, streak, daysLeft, hookObject, revealUsed,
}) {
  const pick = (salt, arr) => arr[seedFor(dateIso, categoryId, salt) % arr.length];
  const hookCloser = hookObject
    ? buildHookCloser({ hookObject, dateIso, categoryId })
    : null;

  if (branch === 'firstDay') {
    // ⚠️ stage는 "~ 앞"으로 끝나는 값이 있어서(독서/자격증/건강) 뒤에
    // "앞에", "에" 같은 후치를 붙이면 "서가 앞 앞에"처럼 중복된다 — 8개
    // 카테고리 전수 스모크에서 실제로 발견. firstDay에서는 stage를 조사
    // 없는 명사구로만 제시한다.
    const openers = [
      '모든 것의 첫날이었다. 주인공은 ' + setting + '의 입구에 섰다. 눈앞에 펼쳐진 것은 ' + stage + ' — 이 이야기의 첫 무대였다.',
      '이 책의 첫 문장이 오늘 쓰였다. 무대는 ' + setting + ', 그 시작점은 ' + stage + '. 주인공은 짧게 숨을 들이쉬고 걸음을 옮겼다.',
    ];
    const closers = [
      '등 뒤에서 문이 닫히는 소리 대신, 앞쪽 어딘가에서 길이 열리는 소리가 났다.',
      '첫 페이지는 언제나 가장 얇지만, 가장 무겁다. 그리고 오늘, 그 페이지가 넘어갔다.',
    ];
    // firstDay는 훅이 항상 걸린다 — 첫날의 기대가 이틀째의 방문 이유가 된다.
    const base = pick('fd-open', openers);
    const tail = hookCloser ? pick('fd-close', closers) + ' ' + hookCloser : pick('fd-close', closers);
    return { opener: base, closer: tail };
  }

  if (branch === 'finalDay') {
    const openers = [
      '마지막 날이 밝았다. 주인공은 ' + stage + '에서, 처음 이 길에 들어서던 날의 자신을 잠시 떠올렸다.',
      '이 책의 마지막 하루. ' + stage + '에 선 주인공의 발걸음은, 첫날과는 완전히 다른 소리를 냈다.',
    ];
    const closers = [
      '이 책의 마지막 장이 넘어갔다. 하지만 책장을 덮는 소리 너머로, 다음 이야기의 첫 페이지가 벌써 바스락거리고 있었다.',
      setting + '의 끝에서 주인공은 뒤를 돌아봤다. 걸어온 만큼의 길이, 이제 지도에 없던 선 하나로 남아 있었다. 다음 지도는 백지다 — 그리고 백지는 그를 기다리고 있다.',
    ];
    return { opener: pick('fn-open', openers), closer: pick('fn-close', closers) };
  }

  if (branch === 'comeback') {
    const openers = [
      gapDays + '일의 공백 끝에, 주인공은 ' + stage + '에 다시 섰다.',
      gapDays + '일 동안 비어 있던 자리로, 주인공이 돌아왔다. ' + stage + '는 떠난 그 모습 그대로 기다리고 있었다.',
      '공백은 ' + gapDays + '일이었다. 그러나 이야기는 끊긴 것이 아니라, 숨을 참고 있었을 뿐이다.',
    ];
    const closers = [
      setting + ' 저편에서 낯선 표지판 하나가 희미하게 보였다. 내일 조금 더 다가가면 무엇이라 적혀 있는지 알 수 있을 것이다.',
      '돌아온 사람에게만 보이는 것이 있다. 오늘 그것의 첫 조각이 저 앞에서 어른거렸다.',
    ];
    return {
      opener: revealUsed ? pick('cb-open2', [
        '그것을 확인한 주인공은, 멈췄던 걸음을 다시 잇기 시작했다.',
        '오래 자리를 지킨 그 발견 앞에서, 주인공은 다시 걷기로 했다.',
      ]) : pick('cb-open', openers),
      closer: hookCloser || pick('cb-close', closers),
    };
  }

  if (branch === 'personalBest') {
    const openers = [
      '오늘로 ' + streak + '일 — 지금까지의 자신을 넘어선 날이다. ' + stage + '의 공기가 어제와 다르게 느껴졌다.',
      streak + '일째. 이 숫자는 처음 와 보는 높이였다. 여기서부터는 지도에 없는 기록이다.',
    ];
    const closers = [
      '기록의 저편은 언제나 미지였다. 그리고 오늘부터, 주인공은 그 미지를 걷는 사람이 되었다.',
      '어제까지의 최고점이 오늘 발밑에 있었다. 내일의 한 걸음이 다시 새 지도를 그릴 것이다.',
    ];
    return {
      opener: revealUsed ? '그 발견을 품은 채, 주인공은 오늘 한 번도 가보지 못한 숫자에 도달했다.' : pick('pb-open', openers),
      closer: hookCloser || pick('pb-close', closers),
    };
  }

  if (branch === 'milestone') {
    const openers = [
      streak + '일째 되는 날, ' + stage + '에서 주인공은 스스로도 놀랐다.',
      streak + '일. 누구의 강요도 없이 쌓인 숫자가, 오늘 ' + stage + ' 위에서 조용히 빛났다.',
      '연속 ' + streak + '일 — 이 숫자를 만든 것은 대단한 결심이 아니라, 오늘 같은 평범한 반복이었다.',
    ];
    const closers = [
      setting + ' 저 멀리, 처음 보는 불빛 하나가 나타났다. 내일 몇 걸음만 더 가면 닿을 수 있을 것 같았다.',
      '이 숫자가 다음 숫자로 이어지는 동안, ' + setting + '의 어딘가에서 또 하나의 문이 준비되고 있을 것이다.',
    ];
    return {
      opener: revealUsed ? '그 발견과 함께, 오늘은 ' + streak + '일째라는 숫자까지 겹친 날이었다.' : pick('ms-open', openers),
      closer: hookCloser || pick('ms-close', closers),
    };
  }

  if (branch === 'stageTransition') {
    const openers = [
      '오늘, 주인공은 ' + (prevStage ? withObjectParticle(prevStage) + ' 지나 ' : '') + stage + '에 들어섰다. 지형이 바뀌었다.',
      '경계를 넘는 날이었다. ' + (prevStage || '지난 구간') + '의 끝에서, ' + withSubjectParticle(stage) + ' 시작되고 있었다.',
    ];
    const closers = [
      '새 구간의 공기는 달랐다. 이 구간이 무엇을 준비해 두었는지는, 이제부터 하루씩 밝혀질 것이다.',
      '지나온 구간의 지도는 완성됐다. 그리고 그 지도의 가장자리 너머가, 오늘부터 그려지기 시작한다.',
    ];
    return { opener: pick('tr-open', openers), closer: pick('tr-close', closers) };
  }

  if (branch === 'halfway') {
    const openers = [
      '여정의 한가운데. 주인공은 ' + stage + '에서 걸음을 멈추고, 지나온 길과 남은 길을 번갈아 바라봤다.',
      '오늘은 정확히 절반이 접히는 날이었다. 책의 한가운데 페이지가 ' + stage + ' 위에서 펼쳐져 있었다.',
    ];
    const closers = [
      '지나온 절반이 남은 절반에게 조용히 말을 걸고 있었다. 후반부의 첫 장이 내일 열린다.',
      '반환점의 표석에는 아무것도 적혀 있지 않았다 — 뒷면만 빼고. 뒷면의 글씨는 돌아가는 길이 아니라 나아가는 길에서만 읽힌다.',
    ];
    return { opener: pick('hw-open', openers), closer: pick('hw-close', closers) };
  }

  if (branch === 'finalStretch') {
    const openers = [
      '끝이 보이기 시작했다. ' + stage + '에서, 주인공은 남은 ' + daysLeft + '일의 거리를 가늠했다.',
      '남은 날은 ' + daysLeft + '일. ' + setting + '의 끝자락이 처음으로 시야에 들어와 있었다.',
    ];
    const closers = [
      '마지막 며칠이 이 이야기의 결을 정할 것이다. 그리고 결말 너머에 무엇이 있는지는, 완주한 사람만 보게 된다.',
      '끝이 가까울수록 걸음은 이상하게 가벼워졌다. 마지막 페이지 뒤에 무엇이 접혀 있는지, 이제 며칠이면 알 수 있다.',
    ];
    return {
      opener: revealUsed ? '그 발견을 확인하고 나니, 남은 ' + daysLeft + '일이 다르게 보였다.' : pick('fs-open', openers),
      closer: hookCloser || pick('fs-close', closers),
    };
  }

  // ordinary — opener 6종(+회수 후 연결형 3종), closer는 훅/일반 이원화.
  const OPENERS = [
    '오늘, 주인공은 ' + stage + '에서 다시 발걸음을 내디뎠다.',
    '작은 결심 하나가, ' + withObjectParticle(stage) + ' 조금 더 앞으로 이끌었다.',
    '오늘도 주인공은 스스로와의 약속을 향해 ' + withObjectParticle(stage) + ' 지났다.',
    '눈에 띄지 않아도, 오늘의 발걸음은 분명 ' + setting + '의 일부였다.',
    '어제의 걸음이 끝난 바로 그 자리에서, 오늘의 이야기가 이어졌다.',
    '누가 시키지 않아도, 주인공은 오늘 ' + stage + '에 다시 서 있었다.',
  ];
  const LINK_OPENERS = [
    '그 발견을 등 뒤에 두고, 주인공은 다시 걸음을 옮겼다.',
    '발견의 여운이 채 가시기 전에, 오늘의 몫이 앞에 놓여 있었다.',
    '방금 알게 된 것을 마음에 넣고, 주인공은 계속 나아갔다.',
  ];
  const CLOSERS = [
    '오늘의 선택으로, ' + setting + '에 오래 잠겨 있던 문 하나가 조금 열렸다. 안쪽에서 희미하게 발자국 소리가 들렸다.',
    setting + ' 끝에서 낯선 갈림길 하나를 발견했다. 어느 쪽으로 이어질지는, 내일 가봐야 알 수 있을 것이다.',
    '멀리서 무언가 반짝였다. 아직은 무엇인지 알 수 없지만, 분명 가까워지고 있었다.',
    '오늘 지나온 자리에, 지금까지 없던 흔적 하나가 새로 생겼다. 다음에 이 길을 지나면 그 의미를 알게 될 것이다.',
    '오늘 열어 둔 것이 무엇이었는지는, 내일의 걸음이 대답해 줄 것이다.',
    '길은 오늘만큼 짧아졌고, 그만큼 무언가에 가까워졌다. 그 무언가의 윤곽이 곧 드러날 참이었다.',
  ];
  const seed = seedFor(dateIso, categoryId, 'ord-open') + Math.abs(hashStr(questLabels.join(',')));
  return {
    opener: revealUsed
      ? LINK_OPENERS[seedFor(dateIso, categoryId, 'ord-link') % LINK_OPENERS.length]
      : OPENERS[seed % OPENERS.length],
    closer: hookCloser || CLOSERS[seedFor(dateIso, categoryId, 'ord-close') % CLOSERS.length],
  };
}

/* ------------------------------------------------------------------
 * 메인 생성기
 * ------------------------------------------------------------------ */

/**
 * 오늘의 이야기 본문을 생성한다 (AI 미사용 경로, 즉 폴백 템플릿).
 *
 * @param {object} input
 * @param {string} input.categoryId - 목표 카테고리
 * @param {string} input.dateIso - 오늘 날짜
 * @param {string} input.goalStartDateIso - 목표 시작일
 * @param {string} [input.targetDateIso] - 목표 종료일 (기간 분기용, 옵션)
 * @param {Array<string>} input.questLabels - 오늘 완료한 장면 라벨들 (0개면 휴식일)
 * @param {Array}  input.archive - 정렬된 과거 storyPage 배열 (entry에 hook이
 *                 저장되어 있으면 훅 회수/중복 방지에 사용된다)
 * @param {number} input.currentStreak - 오늘자 스트릭
 * @param {number} [input.previousBestStreak] - 이전 최고 스트릭 (personalBest 분기용, 옵션)
 * @param {string} [input.memo] - 오늘 남긴 메모
 * @param {object} [input.recallEntry] - 회상 토큰이 있으면 { memo }
 * @returns {{ body: string, dayNo: number, branch: string, hook: {objectId, teaser}|null }}
 *          hook은 호스트가 storyPage에 저장해야 다음 날 회수된다.
 */
function generateTodayStory(input) {
  const {
    categoryId, dateIso, goalStartDateIso, targetDateIso, questLabels,
    archive, currentStreak, previousBestStreak, memo, recallEntry,
  } = input;

  const vocab = getVocab(categoryId);
  const narrativeState = resolveNarrativeState({
    dateIso, goalStartDateIso, targetDateIso, archive,
    currentStreak, previousBestStreak, stagesCount: vocab.stages.length,
  });
  const branch = resolveBranch(narrativeState);
  const stageIndex = getStageIndex(vocab, narrativeState.dayNo);
  const stage = vocab.stages[stageIndex];
  const prevStage = stageIndex > 0 ? vocab.stages[stageIndex - 1] : null;
  const trimmedMemo = (memo || '').trim();

  // --- 휴식일: 훅을 심지도, 회수하지도 않는다. (쉬는 동안 발견의 실마리는
  //     흐려지는 게 자연스럽다 — 단, 다음 활동일의 comeback 회수는 archive의
  //     마지막 "훅 있는" entry가 아니라 마지막 entry만 보므로, 휴식일이 끼면
  //     체인이 조용히 끊긴다. 이것은 버그가 아니라 의도된 리듬이다.)
  if (!questLabels || questLabels.length === 0) {
    const body = buildRestDayLine({ categoryId, stage, setting: vocab.setting, dateIso, memo: trimmedMemo });
    return { body, dayNo: narrativeState.dayNo, branch: 'rest', hook: null };
  }

  // --- 1) 어제의 훅 회수 ---
  const revealText = buildHookReveal({
    priorEntry: narrativeState.priorEntry,
    gapDays: narrativeState.gapDays,
    categoryId,
  });

  // --- 2) 오늘의 훅 결정 (회수와 독립 — 회수한 날에도 새 훅이 심길 수 있다) ---
  const hookObject = pickHookObject({ categoryId, dateIso, archive, branch });

  // --- 3) 조립 ---
  const middle = buildMiddleClause(questLabels);
  const sense = pickSenseLine({ categoryId, dateIso, dayNo: narrativeState.dayNo });
  const { opener, closer } = buildOpenerCloser({
    branch, stage, prevStage, setting: vocab.setting, dateIso, categoryId,
    questLabels, gapDays: narrativeState.gapDays, streak: narrativeState.streak,
    daysLeft: narrativeState.daysLeft, hookObject, revealUsed: !!revealText,
  });

  const parts = [];
  if (revealText) parts.push(revealText);
  parts.push(opener);
  parts.push(middle + '.');
  if (sense) parts.push(sense);
  parts.push(closer);
  let body = parts.join(' ') + ' (' + narrativeState.dayNo + '일째)';

  if (trimmedMemo) body += '\n\n오늘 남긴 한 문장: "' + trimmedMemo + '"';
  if (recallEntry && recallEntry.memo) {
    body += '\n\n그리고 문득, 예전의 기록이 떠올랐다 — "' + recallEntry.memo + '"';
  }

  return {
    body,
    dayNo: narrativeState.dayNo,
    branch,
    hook: hookObject ? { objectId: hookObject.objectId, teaser: hookObject.teaser } : null,
  };
}

/* ------------------------------------------------------------------
 * AI 프롬프트 구성
 * ------------------------------------------------------------------ */

/**
 * AI 프롬프트(genreFlavor)를 구성한다. 폴백과 같은 세계관/분기/훅 데이터를
 * 쓰되, 실제 문장은 AI가 생성한다. Edge Function에서 이 함수를 그대로
 * 포팅해 쓴다.
 *
 * v2: 분기/훅 정보를 옵션으로 받아 AI 경로에서도 훅 체인이 유지되게 한다.
 * 호스트는 pickHookObject()로 오늘의 훅을 먼저 결정한 뒤 hookToPlant로
 * 넘기고, AI 응답과 무관하게 그 hook을 storyPage에 저장하면 된다 —
 * 이렇게 하면 AI 문장이 어떻게 나오든 다음 날 회수 로직은 동일하게 돈다.
 *
 * @param {object} p
 * @param {string} p.categoryId
 * @param {number} p.dayNo
 * @param {string} [p.branch] - Layer 2의 분기 결과 (없으면 분기 지시 생략)
 * @param {number} [p.gapDays] - comeback일 때 공백 일수
 * @param {number} [p.streak] - milestone/personalBest일 때 스트릭
 * @param {object} [p.priorHook] - 어제 심은 훅 {objectId} — 회수 지시가 붙는다
 * @param {object} [p.hookToPlant] - 오늘 심을 훅 {teaser} — 티저 지시가 붙는다
 */
function buildGenreFlavor(p) {
  const { categoryId, dayNo, branch, gapDays, streak, priorHook, hookToPlant } = p;
  const vocab = getVocab(categoryId);
  const motifs = getMotifs(categoryId);
  const stage = vocab.stages[getStageIndex(vocab, dayNo)];

  let flavor =
    '현실의 행동을 다음 세계관으로 번역해서 써라: 배경은 "' + vocab.setting + '", 주인공은 지금 "' + stage + '" 단계에 있다. ' +
    '주인공(사용자)의 변화 방향은 "' + vocab.identityShift + '"이다. 이 정체성 변화를 직접적인 훈계가 아니라 행동과 장면으로 은은하게 드러내라. ' +
    '다만 행동을 하지 않았다고 사용자를 비난하지 말고, 벌을 주지 마라 — 그저 이야기의 분위기나 전개가 조금 다르게 흘러갈 뿐이다. ';

  // 세계관 감각 어휘 — AI가 임의의 이미지 대신 이 세계의 질감을 쓰게 한다.
  flavor += '이 세계의 감각 어휘를 참고하되 그대로 베끼지는 마라: ' + motifs.senses.slice(0, 3).join(' / ') + ' ';

  // 분기 지시
  if (branch === 'firstDay') {
    flavor += '오늘은 이 책의 첫날이다. 시작의 무게와 설렘을 담되, 거창한 선언 대신 첫걸음의 구체적 감각으로 써라. ';
  } else if (branch === 'finalDay') {
    flavor += '오늘은 이 책의 마지막 날이다. 첫날의 자신과 오늘의 자신을 대비시키되, 끝맺음이 아니라 다음 이야기의 예감으로 닫아라. ';
  } else if (branch === 'comeback' && gapDays) {
    flavor += '주인공은 ' + gapDays + '일의 공백 끝에 돌아왔다. 공백을 실패로 그리지 말고, 이야기가 숨을 참고 기다렸던 것으로 그려라. ';
  } else if (branch === 'personalBest' && streak) {
    flavor += '오늘 주인공은 자신의 최고 기록(' + streak + '일)을 처음으로 넘어섰다. 지도 밖의 영역에 들어선 감각으로 써라. ';
  } else if (branch === 'milestone' && streak) {
    flavor += '오늘은 연속 ' + streak + '일째의 마일스톤이다. 숫자를 자랑하지 말고, 반복이 쌓아 올린 것을 장면으로 보여줘라. ';
  } else if (branch === 'stageTransition') {
    flavor += '오늘 주인공은 세계관의 새 구간("' + stage + '")에 들어섰다. 지형과 공기가 달라졌음을 감각으로 드러내라. ';
  } else if (branch === 'halfway') {
    flavor += '오늘은 여정의 정확한 중간 지점이다. 지나온 절반과 남은 절반을 한 장면 안에서 마주 보게 하라. ';
  } else if (branch === 'finalStretch') {
    flavor += '이제 끝이 며칠 남지 않았다. 결말이 가까워진 긴장과 가벼워진 걸음을 함께 담아라. ';
  }

  // 훅 회수 지시 — 어제의 약속은 반드시 지켜져야 한다.
  if (priorHook && priorHook.objectId) {
    const obj = motifs.objects.find((o) => o.id === priorHook.objectId);
    if (obj) {
      flavor += '중요: 어제 이야기 끝에 "' + obj.teaser + '"가 멀리 보이는 장면이 있었다. 오늘 이야기 초반에 주인공이 거기에 도달해 정체를 확인하는 장면을 반드시 넣어라. 정체는 이 내용을 바탕으로 하라: "' + obj.reveal + '" ';
    }
  }

  // 훅 심기 지시 — 오늘의 마지막은 내일의 이유가 되어야 한다.
  if (hookToPlant && hookToPlant.teaser) {
    flavor += '중요: 이야기의 마지막에 "' + hookToPlant.teaser + '"가 멀리서 눈에 들어오는 장면으로 끝내라. 정체는 절대 밝히지 마라 — 내일 확인하게 될 것이라는 기대만 남겨라. ';
  }

  flavor +=
    '마지막 문장은 좋은 글이 아니라 행동을 만드는 글이어야 한다: "노을은 아름다웠다" 같은 감상이 아니라, "오늘의 선택으로 오래 잠겨 있던 문이 조금 열렸다"처럼 오늘의 행동이 무언가를 구체적으로 열어젖혔다는 여운을 남기고, 그 너머에 아직 확인되지 않은 무언가를 살짝 등장시켜 "내일 또 하면 저게 무엇인지 알 수 있을 것 같다"는 기대감을 만들어라. 감동이 아니라 기대감이 목적이다.';

  return flavor;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    generateTodayStory,
    buildGenreFlavor,
    buildRestDayLine,
    buildMiddleClause,
    buildOpenerCloser,
    pickHookObject,
    buildHookReveal,
    buildHookCloser,
    collectUsedHookIds,
  };
}
