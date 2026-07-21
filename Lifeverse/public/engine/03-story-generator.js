/**
 * LIFEVERSE Story Engine — Layer 3: Story Generator (v4)
 * ============================================================
 * Layer 1(세계관) + Layer 2(분기 규칙)을 입력받아 최종 문장을 만든다.
 * AI 미사용 경로(폴백)와 AI 프롬프트 구성 양쪽에서 공유하는 계층이다.
 *
 * 톤 원칙 (v12에서 확정, 되돌리지 말 것):
 * "노을은 아름다웠다" 같은 감상이 아니라 "오늘의 선택으로 문이 조금 열렸다"처럼
 * 구체적으로 뭔가 열렸고, 그 너머가 아직 안 밝혀졌다는 "기대감" 구조로 통일한다.
 * 감동이 아니라 기대감이 목적이다.
 *
 * v2 — 훅 시스템: closer가 teaser를 심으면 다음 날 opener가 reveal로 회수.
 * v3 — 앰비언트/동행 인물/3막 톤/다문단.
 * v3.1 — essence 번역(라벨 비노출) + bridge 연결.
 *
 * v4 대개편 (소설감 강화 — 사용자 피드백 "진짜 소설 느낌이 없다"):
 *   1. 주인공 이름(heroName). "주인공은"이라는 3인칭 대명사가 몰입을 가장
 *      크게 깨뜨렸다. 이제 호스트가 넘긴 이름을 H()로 문장 전체에서 쓴다.
 *      이름이 없으면 "그"로 폴백한다("주인공"은 더 이상 쓰지 않는다).
 *      한국어 특성상 이름 뒤 주격조사가 필요하므로 Hsub()(은/는),
 *      Hga()(이/가)를 별도로 둔다.
 *   2. 장면(scene)화. "오늘의 돌 하나를 제자리에 얹었다" 같은 관념적 요약을
 *      감각·소품·짧은 동작이 있는 장면 묘사로 바꿨다. 카테고리별 openScene /
 *      actScene 풀(Layer 1의 sensoryBeats)을 끌어와, "무엇을 했다"가 아니라
 *      "그 순간 무엇이 보였고 만져졌는가"를 그린다.
 *   3. 문장 리듬. 짧은 문장과 긴 문장을 섞고, opener→행동→여운이 한 호흡으로
 *      읽히도록 연결한다. bridge는 유지하되 장면과 자연스럽게 붙도록 다듬었다.
 *
 * 하위호환: heroName은 옵션이다. 안 넘기면 "그"로 나온다. 기존 반환 필드
 * (body/dayNo/branch/act/stageIndex/hook)는 그대로다.
 *
 * 시드 설계 원칙(Layer 5의 XOR 교훈): 선택마다 별도 salt를 XOR로 섞은
 * 독립 시드를 쓴다. 같은 시드 + 다른 나눗셈 금지.
 * ============================================================
 */

var getVocab, getMotifs, getStageIndex, getActEssence, withObjectParticle, withSubjectParticle, withConnectiveParticle, hashStr;
var resolveNarrativeState, resolveBranch;
if (typeof require === 'function') {
  ({ getVocab, getMotifs, getStageIndex, getActEssence, withObjectParticle, withSubjectParticle, withConnectiveParticle, hashStr } = require('./01-world-vocab.js'));
  ({ resolveNarrativeState, resolveBranch } = require('./02-narrative-rules.js'));
}

const RESERVED_MAX_QUOTE_LEN = 60;

const HOOK_ALWAYS_BRANCHES = ['firstDay'];
const HOOK_ELIGIBLE_BRANCHES = ['ordinary', 'milestone', 'comeback', 'personalBest', 'finalStretch'];

/** 독립 시드 — 날짜/카테고리/용도(salt)를 XOR로 섞는다. */
function seedFor(dateIso, categoryId, salt) {
  return ((hashStr(dateIso || '') ^ hashStr(categoryId || '') ^ hashStr(salt)) >>> 0);
}

/* ------------------------------------------------------------------
 * 주인공 이름 처리 (v4)
 * ------------------------------------------------------------------
 * heroName이 있으면 그 이름을, 없으면 "그"를 쓴다. 한국어 주격조사를
 * 이름 받침에 맞춰 붙인다. 이름이 한글이 아니거나(영문 등) 빈 값이면
 * 안전하게 "그" + 기본조사로 폴백한다.
 */
function heroBase(heroName) {
  const n = (heroName || '').trim();
  return n || '그';
}
/** "이름은/그는" — 주제 조사(은/는) */
function heroTopic(heroName) {
  const n = (heroName || '').trim();
  if (!n) return '그는';
  const last = n.charCodeAt(n.length - 1);
  if (last < 0xac00 || last > 0xd7a3) return n + '는';
  const hasBatchim = (last - 0xac00) % 28 !== 0;
  return n + (hasBatchim ? '은' : '는');
}
/** "이름이/그가" — 주격 조사(이/가) */
function heroSubj(heroName) {
  const n = (heroName || '').trim();
  if (!n) return '그가';
  const last = n.charCodeAt(n.length - 1);
  if (last < 0xac00 || last > 0xd7a3) return n + '가';
  const hasBatchim = (last - 0xac00) % 28 !== 0;
  return n + (hasBatchim ? '이' : '가');
}
/** "이름의/그의" — 관형격(의). 받침 무관하게 '의'. */
function heroPoss(heroName) {
  return heroBase(heroName) + '의';
}

/* ------------------------------------------------------------------
 * 훅 시스템 (v2~v3, 로직 불변)
 * ------------------------------------------------------------------ */
function collectUsedHookIds(archive) {
  const used = [];
  (archive || []).forEach((e) => { if (e && e.hook && e.hook.objectId) used.push(e.hook.objectId); });
  return used;
}

function pickHookObject({ categoryId, dateIso, archive, branch }) {
  const always = HOOK_ALWAYS_BRANCHES.includes(branch);
  const eligible = always || HOOK_ELIGIBLE_BRANCHES.includes(branch);
  if (!eligible) return null;
  const motifs = getMotifs(categoryId);
  const used = collectUsedHookIds(archive);
  const remaining = motifs.objects.filter((o) => !used.includes(o.id));
  if (remaining.length === 0) return null;
  if (!always && seedFor(dateIso, categoryId, 'hook-on') % 3 !== 0) return null;
  const idx = seedFor(dateIso, categoryId, 'hook-obj') % remaining.length;
  const obj = remaining[idx];
  return { objectId: obj.id, teaser: obj.teaser, reveal: obj.reveal };
}

function buildHookReveal({ priorEntry, gapDays, categoryId, heroName }) {
  if (!priorEntry || !priorEntry.hook || !priorEntry.hook.objectId) return null;
  const motifs = getMotifs(categoryId);
  const obj = motifs.objects.find((o) => o.id === priorEntry.hook.objectId);
  if (!obj) return null;
  // Layer 1의 reveal 텍스트에도 "주인공"이 들어있을 수 있으므로 이름으로 치환.
  const reveal = obj.reveal.replace(/주인공/g, heroBase(heroName));
  if (gapDays === 1) {
    return '어제 멀리 보였던 ' + withSubjectParticle(obj.teaser) + ' 오늘 손 닿는 곳까지 다가와 있었다. ' + reveal;
  }
  return '며칠 전 아득히 보였던 ' + obj.teaser + ' — 그것은 아직 그 자리에서 기다리고 있었다. ' + reveal;
}

function buildHookCloser({ hookObject, dateIso, categoryId }) {
  const t = hookObject.teaser;
  const FRAMES = [
    '걸음을 멈춘 자리 저편, ' + withSubjectParticle(t) + ' 눈에 들어왔다. 내일 조금만 더 가면 그 정체를 알 수 있을 것이다.',
    '오늘의 마지막 모퉁이에서 ' + withSubjectParticle(t) + ' 시야에 걸렸다. 아직은 멀다. 그러나 내일이면 닿는다.',
    '저만치 앞에 ' + withSubjectParticle(t) + ' 보였다. 오늘은 여기까지 — 그 정체는 내일의 몫으로 남겨 두었다.',
    '하루를 접으려는 순간, ' + withSubjectParticle(t) + ' 시선 끝에 걸렸다. 오늘의 마지막 발견이자, 내일의 첫 목적지였다.',
  ];
  return FRAMES[seedFor(dateIso, categoryId, 'hook-frame') % FRAMES.length];
}

/* ------------------------------------------------------------------
 * 휴식일 (v3, v4에서 이름 반영)
 * ------------------------------------------------------------------ */
function buildRestDayLine({ categoryId, stage, setting, dateIso, memo, priorWasRest, heroName }) {
  const H = heroBase(heroName);
  const Ht = heroTopic(heroName);
  const firstRestLines = [
    '오늘, ' + Ht + ' ' + stage + '에서 걸음을 멈추고 잠시 숨을 골랐다. ' + setting + '은 멈춘 것이 아니라, 그를 기다리며 잠시 조용해졌을 뿐이다.',
    '오늘은 ' + stage + '에 머물렀다. 다시 걷기 시작하면, 이야기는 꼭 이 자리에서 이어질 것이다.',
    '오늘, ' + setting + '의 한 페이지가 조용히 비어 있었다. 그래도 이 책은 여전히 ' + heroPoss(heroName) + ' 것이었다.',
    '짐을 내려놓은 하루였다. ' + Ht + ' 불을 지피지 않았지만, ' + setting + '의 밤은 그를 말없이 품어 주었다.',
    '쉼표 하나. 문장이 끝난 게 아니라, 다음 문장을 위해 숨을 고른 것이다. ' + stage + '는 그대로 그 자리에 있었다.',
    '걷지 않는 날에도 발은 길을 기억했다. 눈을 감으면 ' + stage + '의 지형이 그려졌다 — 내일 다시 그 위를 걷게 될 것이다.',
    '오늘 ' + H + '는 멀리서 자기 길을 바라보기만 했다. 그것으로 충분한 날도 있다.',
  ];
  const streakRestLines = [
    '쉼이 하루 더 이어졌다. ' + setting + '은 서두르지 않았다 — 오래 남을 이야기는 원래 느리게 흐른다.',
    '이틀째의 고요. 그래도 ' + stage + ' 어딘가에서, 이야기는 ' + heroPoss(heroName) + ' 자리를 비워 둔 채 기다리고 있었다.',
    '연이은 쉼표 뒤에는 대개 긴 문장이 온다. ' + setting + '도 그것을 아는 듯 잠잠했다.',
    '오늘도 페이지는 비었다. 다만 빈 페이지가 늘수록, 다음에 적힐 첫 문장의 무게가 조금씩 커지고 있었다.',
  ];
  const pool = priorWasRest ? streakRestLines : firstRestLines;
  const idx = Math.abs(hashStr((dateIso || '') + 'rest')) % pool.length;
  let body = pool[idx];
  if (memo) body += ' 그리고 ' + H + '는 이 한 마디를 남겼다 — "' + memo + '"';
  return body;
}

/* ------------------------------------------------------------------
 * 행동의 장면화 (v4 핵심)
 * ------------------------------------------------------------------
 * v3.1의 essence("오늘의 돌 하나를 제자리에 얹었다")는 관념적 요약이라
 * 소설처럼 읽히지 않았다. v4는 Layer 1의 sensoryBeats(카테고리별 장면
 * 묘사 문장)를 끌어와, 행동을 "그 순간의 장면"으로 그린다. 라벨은 여전히
 * 노출하지 않되(essence 원칙 유지), 표현이 감각적이고 구체적이다.
 *
 * questCount는 문장 밀도로만 반영한다. 라벨 자체는 절대 노출하지 않는다.
 */
function buildActScene(questLabels, dateIso, categoryId, dayNo, heroName) {
  const count = questLabels ? questLabels.length : 0;
  const vocab = getVocab(categoryId);
  const beats = vocab.sensoryBeats || null;
  const Ht = heroTopic(heroName);

  // sensoryBeats가 있으면 장면체, 없으면 essence로 폴백(하위호환)
  if (!beats || beats.length === 0) {
    const essence = getActEssence(categoryId, seedFor(dateIso, categoryId, 'essence') + (dayNo || 1));
    return { scene: Ht + ' ' + essence, hasDensityPrefix: false };
  }

  const beat = beats[(seedFor(dateIso, categoryId, 'beat') + (dayNo || 1)) % beats.length];

  // 밀도 접두 — 여러 행동을 한 날은 "쉼 없이/차례로" 뉘앙스를 얹는다.
  // 접두가 붙으면 그 자체가 도입 문장이 되므로 hasDensityPrefix=true를 알려
  // assembleCore가 bridge를 생략하게 한다(이중 도입 방지).
  if (count >= 3) {
    const PRE = ['쉼 없이 몸을 놀린 하루였다. ', '해야 할 것들을 차례로 지나며, ', '하나에 또 하나를 더해 가며, '];
    return { scene: PRE[seedFor(dateIso, categoryId, 'p3') % PRE.length] + beat, hasDensityPrefix: true };
  }
  if (count === 2) {
    const PRE = ['두 가지를 나란히 해내는 사이, ', '하나를 끝내고 다음으로 넘어가며, '];
    return { scene: PRE[seedFor(dateIso, categoryId, 'p2') % PRE.length] + beat, hasDensityPrefix: true };
  }
  return { scene: beat, hasDensityPrefix: false };
}

/** 감각/앰비언트/동행 인물 곁들임 (v3, 로직 유지) */
function pickSenseLine({ categoryId, dateIso, dayNo }) {
  if (seedFor(dateIso, categoryId, 'sense-on') % 2 !== 0) return null;
  const senses = getMotifs(categoryId).senses;
  return senses[(seedFor(dateIso, categoryId, 'sense-idx') + dayNo) % senses.length];
}
function pickAmbientLine({ categoryId, dateIso, dayNo }) {
  if (seedFor(dateIso, categoryId, 'amb-on') % 2 !== 0) return null;
  const ambients = getMotifs(categoryId).ambients;
  if (!ambients || ambients.length === 0) return null;
  return ambients[(seedFor(dateIso, categoryId, 'amb-idx') + dayNo) % ambients.length];
}
function pickCompanionLine({ categoryId, dateIso, archive, heroName }) {
  if (seedFor(dateIso, categoryId, 'comp-on') % 5 !== 0) return null;
  const companion = getMotifs(categoryId).companion;
  if (!companion || !companion.lines || companion.lines.length === 0) return null;
  const seen = (archive || []).map((e) => e.body || '').join('\n');
  const remaining = companion.lines.filter((l) => !seen.includes(l));
  if (remaining.length === 0) return null;
  const line = remaining[seedFor(dateIso, categoryId, 'comp-idx') % remaining.length];
  // Layer 1의 companion 대사는 "주인공"으로 작성돼 있다(이름을 모르므로).
  // 여기서 호스트가 넘긴 이름으로 치환한다. 이름이 없으면 "그"로.
  return line.replace(/주인공/g, heroBase(heroName));
}

function buildMemoLine(memo, dateIso, categoryId, heroName) {
  const H = heroBase(heroName);
  const FRAMES = [
    '그날의 페이지 끝, ' + H + '는 이렇게 적었다 — "' + memo + '"',
    '여백에는 이런 한 줄이 남아 있었다 — "' + memo + '"',
    '하루의 마지막 문장으로, ' + H + '는 이 말을 남겼다. "' + memo + '"',
  ];
  return FRAMES[seedFor(dateIso, categoryId, 'memo-frame') % FRAMES.length];
}

/* ------------------------------------------------------------------
 * opener/closer — 장면체 + 이름 (v4 전면 재작성)
 * ------------------------------------------------------------------ */
function buildOpenerCloser({
  branch, stage, prevStage, setting, dateIso, categoryId, questLabels,
  gapDays, streak, daysLeft, hookObject, revealUsed, act, activeDaysTotal, heroName,
}) {
  const pick = (salt, arr) => arr[seedFor(dateIso, categoryId, salt) % arr.length];
  const H = heroBase(heroName);
  const Ht = heroTopic(heroName);
  const Hs = heroSubj(heroName);
  const hookCloser = hookObject ? buildHookCloser({ hookObject, dateIso, categoryId }) : null;

  if (branch === 'firstDay') {
    const openers = [
      '모든 것의 첫날이었다. ' + Ht + ' ' + setting + '의 입구에 섰다. 눈앞에 펼쳐진 것은 ' + stage + ' — 이 이야기의 첫 무대였다.',
      '이 책의 첫 문장이 오늘 쓰였다. 무대는 ' + setting + ', 그 시작점은 ' + stage + '. ' + Ht + ' 짧게 숨을 들이쉬고 첫 걸음을 옮겼다.',
      '펼쳐진 적 없던 책의 첫 장이 넘어갔다. ' + setting + ' — 여기가 무대였고, ' + withSubjectParticle(stage) + ' 그 첫 페이지였다. ' + Ht + ' 천천히 걸음을 뗐다.',
    ];
    const closers = [
      '등 뒤에서 문이 닫히는 소리 대신, 앞쪽 어딘가에서 길이 열리는 소리가 났다.',
      '첫 페이지는 언제나 가장 얇지만, 가장 무겁다. 그리고 오늘, 그 페이지가 넘어갔다.',
    ];
    const base = pick('fd-open', openers);
    const tail = hookCloser ? pick('fd-close', closers) + ' ' + hookCloser : pick('fd-close', closers);
    return { opener: base, closer: tail };
  }

  if (branch === 'finalDay') {
    const openers = [
      '마지막 날이 밝았다. ' + stage + '에 선 ' + H + '는, 처음 이 길에 들어서던 날의 자신을 잠시 떠올렸다.',
      '이 책의 마지막 하루. ' + withObjectParticle(stage) + ' 딛는 ' + heroPoss(heroName) + ' 발걸음은, 첫날과는 전혀 다른 소리를 냈다.',
    ];
    const closers = [
      '이 책의 마지막 장이 넘어갔다. 그러나 책장을 덮는 소리 너머로, 다음 이야기의 첫 페이지가 벌써 바스락거렸다.',
      setting + '의 끝에서 ' + Ht + ' 뒤를 돌아봤다. 걸어온 만큼의 길이 지도에 없던 선 하나로 남아 있었다. 다음 지도는 백지다 — 그리고 백지는 그를 기다린다.',
    ];
    if (activeDaysTotal && activeDaysTotal > 1) {
      closers.push('책장을 덮기 전, ' + Ht + ' 페이지를 헤아렸다. ' + activeDaysTotal + '일의 걸음이 이 책을 채우고 있었다. 마지막 장 뒤에는, 아직 아무것도 적히지 않은 다음 권의 표지가 겹쳐져 있었다.');
    }
    return { opener: pick('fn-open', openers), closer: pick('fn-close', closers) };
  }

  if (branch === 'comeback') {
    const openers = [
      gapDays + '일의 공백 끝에, ' + Ht + ' ' + stage + '에 다시 섰다.',
      gapDays + '일 동안 비어 있던 자리로 ' + Hs + ' 돌아왔다. ' + stage + '는 떠날 때 그 모습 그대로 기다리고 있었다.',
      '공백은 ' + gapDays + '일이었다. 그러나 이야기는 끊긴 게 아니라, 숨을 참고 있었을 뿐이다.',
    ];
    const closers = [
      setting + ' 저편에서 낯선 표지판 하나가 희미하게 보였다. 내일 조금 더 다가가면 무엇이라 적혔는지 읽을 수 있을 것이다.',
      '떠났다 돌아온 걸음은 같은 길도 다르게 읽는다. 오늘 그 다른 눈이, 여태 못 보던 갈림길 하나를 찾아냈다.',
    ];
    return {
      opener: revealUsed ? pick('cb-open2', [
        '그것을 확인한 ' + Ht + ', 멈췄던 걸음을 다시 이었다.',
        '오래 자리를 지킨 그 발견 앞에서, ' + Ht + ' 다시 걷기로 했다.',
      ]) : pick('cb-open', openers),
      closer: hookCloser || pick('cb-close', closers),
    };
  }

  if (branch === 'personalBest') {
    const openers = [
      '오늘로 ' + streak + '일. 여태의 자신을 넘어선 날이었다. ' + stage + '의 공기가 어제와 다르게 느껴졌다.',
      streak + '일째. 이 숫자는 ' + H + '가 처음 와 보는 높이였다. 여기서부터는 지도에 없는 기록이다.',
    ];
    const closers = [
      '기록의 저편은 늘 미지였다. 그리고 오늘부터, ' + Ht + ' 그 미지를 걷는 사람이 되었다.',
      '어제까지의 최고점이 오늘 발밑에 있었다. 내일의 한 걸음이 다시 새 지도를 그릴 것이다.',
    ];
    return {
      opener: revealUsed ? '그 발견을 품은 채, ' + Ht + ' 오늘 한 번도 가보지 못한 숫자에 닿았다.' : pick('pb-open', openers),
      closer: hookCloser || pick('pb-close', closers),
    };
  }

  if (branch === 'milestone') {
    const openers = [
      streak + '일째 되는 날, ' + stage + '에서 ' + Ht + ' 문득 스스로에게 놀랐다.',
      streak + '일. 누구의 강요도 없이 쌓인 숫자가, 오늘 ' + stage + ' 위에서 조용히 빛났다.',
      '연속 ' + streak + '일 — 이 숫자를 만든 건 대단한 결심이 아니라, 오늘 같은 평범한 반복이었다.',
    ];
    const closers = [
      setting + ' 저 멀리, 처음 보는 불빛 하나가 돋았다. 내일 몇 걸음이면 닿을 듯했다.',
      '쌓인 날들은 어느새 계단이 되어 있었다. 그 끝에 무엇이 있는지는, 다음 마디에서 조금 더 드러날 것이다.',
    ];
    return {
      opener: revealUsed ? '그 발견에 더해, 오늘은 ' + streak + '일째라는 숫자까지 겹친 날이었다.' : pick('ms-open', openers),
      closer: hookCloser || pick('ms-close', closers),
    };
  }

  if (branch === 'stageTransition') {
    const openers = [
      '오늘, ' + Ht + ' ' + (prevStage ? withObjectParticle(prevStage) + ' 지나 ' : '') + stage + '에 들어섰다. 발밑의 지형이 바뀌어 있었다.',
      '경계를 넘는 날이었다. ' + (prevStage || '지난 구간') + '의 끝에서, ' + withSubjectParticle(stage) + ' 시작되고 있었다.',
    ];
    const closers = [
      '새 구간의 공기는 달랐다. 이곳이 무엇을 준비해 두었는지는, 이제부터 하루씩 밝혀질 것이다.',
      '지나온 구간의 지도는 완성됐다. 그 가장자리 너머가, 오늘부터 그려지기 시작한다.',
    ];
    return { opener: pick('tr-open', openers), closer: pick('tr-close', closers) };
  }

  if (branch === 'halfway') {
    const openers = [
      '여정의 한가운데. ' + Ht + ' ' + stage + '에서 걸음을 멈추고, 지나온 길과 남은 길을 번갈아 바라봤다.',
      '오늘은 정확히 절반이 접히는 날이었다. 책의 한가운데 페이지가 ' + stage + ' 위에서 펼쳐졌다.',
    ];
    const closers = [
      '지나온 절반이 남은 절반에게 조용히 말을 걸었다. 후반부의 첫 장이 내일 열린다.',
      '반환점의 표석에는 아무것도 적혀 있지 않았다 — 뒷면만 빼고. 뒷면 글씨는 돌아가는 길이 아니라 나아가는 길에서만 읽힌다.',
    ];
    return { opener: pick('hw-open', openers), closer: pick('hw-close', closers) };
  }

  if (branch === 'finalStretch') {
    const openers = [
      '끝이 보이기 시작했다. ' + stage + '에서 ' + Ht + ' 남은 ' + daysLeft + '일의 거리를 눈으로 가늠했다.',
      '남은 날은 ' + daysLeft + '일. ' + setting + '의 끝자락이 처음으로 시야에 들어왔다.',
    ];
    const closers = [
      '마지막 며칠이 이 이야기의 결을 정할 것이다. 결말 너머에 무엇이 있는지는, 끝까지 간 사람만 본다.',
      '끝이 가까울수록 걸음은 이상하게 가벼워졌다. 마지막 장 뒤에 무엇이 접혀 있는지, 이제 며칠이면 안다.',
    ];
    return {
      opener: revealUsed ? '그 발견을 확인하고 나니, 남은 ' + daysLeft + '일이 달리 보였다.' : pick('fs-open', openers),
      closer: hookCloser || pick('fs-close', closers),
    };
  }

  // ordinary
  const OPENERS = [
    '오늘도 ' + Ht + ' ' + stage + '에서 발걸음을 내디뎠다.',
    '작은 결심 하나가 ' + withObjectParticle(heroBase(heroName)) + ' 다시 ' + stage + ' 안쪽으로 이끌었다.',
    '누가 시키지 않아도, ' + Ht + ' 오늘도 ' + stage + '에 서 있었다.',
    '하루의 소란을 지나 ' + Ht + ' 결국 ' + stage + '으로 돌아왔다. 이야기가 이어지는 자리는 늘 여기였다.',
    setting + '의 하루가 또 한 장 넘어갔다. 그 페이지 위에 ' + heroPoss(heroName) + ' 오늘이 적혔다.',
    '어제의 걸음이 끝난 바로 그 자리에서, 오늘의 이야기가 이어졌다.',
    '특별할 것 없는 하루였다. 그러나 ' + setting + '에서는, 바로 그런 하루가 길이 된다.',
  ];
  if (act === 1) {
    OPENERS.push(
      '아직 낯선 ' + stage + '의 공기 속에서, ' + Ht + ' 오늘의 걸음을 시작했다.',
      '이 세계의 결이 조금씩 손에 익어 갔다. 오늘도 ' + Ht + ' ' + stage + '에 발을 들였다.'
    );
  } else if (act === 3) {
    OPENERS.push(
      '이제 ' + stage + '의 지형은 눈감고도 그려졌다. 익숙해진 길 위에서 오늘의 걸음이 이어졌다.',
      '끝이 멀지 않은 ' + stage + '. ' + heroPoss(heroName) + ' 발걸음에는 처음에 없던 확신이 실려 있었다.'
    );
  }
  const LINK_OPENERS = [
    '그 발견을 등 뒤에 두고, ' + Ht + ' 다시 걸음을 옮겼다.',
    '발견의 여운이 채 가시기 전에, 오늘의 몫이 앞에 놓였다.',
    '방금 알게 된 것을 마음에 담고, ' + Ht + ' 계속 나아갔다.',
  ];
  const CLOSERS = [
    '오늘의 선택으로, ' + setting + '에 오래 잠겨 있던 문 하나가 조금 열렸다. 안쪽에서 희미한 발소리가 들렸다.',
    setting + ' 끝에서 낯선 갈림길 하나를 보았다. 어느 쪽으로 이어질지는, 내일 가봐야 안다.',
    '멀리서 무언가 반짝였다. 아직은 무엇인지 몰라도, 분명 가까워지고 있었다.',
    '오늘 지나온 자리에 여태 없던 흔적 하나가 새로 생겼다. 다음에 이 길을 지나면 그 의미를 알 것이다.',
    '오늘 열어 둔 것이 무엇이었는지는, 내일의 걸음이 대답해 줄 것이다.',
    '길은 오늘만큼 짧아졌고, 그만큼 무언가에 가까워졌다. 그 윤곽이 곧 드러날 참이었다.',
    setting + '의 저편에서 낮은 울림 하나가 건너왔다. 무엇의 소리인지는, 더 가까워진 날에 안다.',
    '걸음을 멈춘 자리 바로 앞에서 길이 살짝 방향을 틀고 있었다. 그 모퉁이 너머는 내일의 장면이다.',
  ];
  if (act === 3) {
    CLOSERS.push(
      '끝이 가까워질수록, 지나온 문장들이 하나둘 서로 이어지기 시작했다. 내일은 그 매듭의 다음이 드러날 것이다.',
      '이야기의 끝자락에서만 보이는 것들이 있다. 오늘 그중 하나가 처음으로 윤곽을 드러냈다 — 전부는 아직 아니다.'
    );
  }
  const seed = seedFor(dateIso, categoryId, 'ord-open') + Math.abs(hashStr((questLabels || []).join(',')));
  return {
    opener: revealUsed
      ? LINK_OPENERS[seedFor(dateIso, categoryId, 'ord-link') % LINK_OPENERS.length]
      : OPENERS[seed % OPENERS.length],
    closer: hookCloser || CLOSERS[seedFor(dateIso, categoryId, 'ord-close') % CLOSERS.length],
  };
}

/* ------------------------------------------------------------------
 * 코어 조립 (v3.1 bridge → v4 장면 연결)
 * ------------------------------------------------------------------ */
function assembleCore({ opener, actScene, extraLine, dateIso, categoryId, hasDensityPrefix }) {
  // opener(마침표로 끝남) 다음에 장면을 자연스럽게 잇는 연결 부사구.
  const BRIDGES = ['그렇게 오늘도, ', '그 걸음 속에서, ', '그리고 그 자리에서, ', '하루의 한복판에서, ', '그 여정의 한 조각으로, '];

  // actScene이 이미 밀도 접두("쉼 없이 몸을 놀린 하루였다. …")로 시작하면
  // 그 자체가 새 도입 역할을 하므로 bridge를 붙이면 "부사구 + 완결문장"으로
  // 어색해진다. 이 경우 bridge를 생략하고 문단만 나눠 자연스럽게 잇는다.
  if (hasDensityPrefix) {
    let core = opener + ' ' + actScene;
    if (!/[.!?…]$/.test(core.trim())) core += '.';
    if (extraLine) core += ' ' + extraLine;
    return core;
  }

  const bridge = BRIDGES[seedFor(dateIso || '', categoryId || '', 'bridge') % BRIDGES.length];
  let core = opener + ' ' + bridge + actScene;
  if (!/[.!?…]$/.test(core.trim())) core += '.';
  if (extraLine) core += ' ' + extraLine;
  return core;
}

/* ------------------------------------------------------------------
 * 메인 생성기
 * ------------------------------------------------------------------ */
function generateTodayStory(input) {
  const {
    categoryId, dateIso, goalStartDateIso, targetDateIso, questLabels,
    archive, currentStreak, previousBestStreak, memo, recallEntry, heroName,
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

  // 휴식일
  if (!questLabels || questLabels.length === 0) {
    const priorWasRest = !!(narrativeState.priorEntry && narrativeState.priorEntry.isRestDay);
    const body = buildRestDayLine({
      categoryId, stage, setting: vocab.setting, dateIso, memo: trimmedMemo, priorWasRest, heroName,
    });
    return { body, dayNo: narrativeState.dayNo, branch: 'rest', act: narrativeState.act, stageIndex, hook: null };
  }

  // 1) 훅 회수
  const revealText = buildHookReveal({
    priorEntry: narrativeState.priorEntry, gapDays: narrativeState.gapDays, categoryId, heroName,
  });
  // 2) 오늘의 훅
  const hookObject = pickHookObject({ categoryId, dateIso, archive, branch });
  // 3) 곁들임 (동행 인물 > 감각 > 앰비언트, 상호 배타)
  let extraLine = null;
  if (branch === 'ordinary' && !revealText) extraLine = pickCompanionLine({ categoryId, dateIso, archive, heroName });
  if (!extraLine) extraLine = pickSenseLine({ categoryId, dateIso, dayNo: narrativeState.dayNo });
  if (!extraLine) extraLine = pickAmbientLine({ categoryId, dateIso, dayNo: narrativeState.dayNo });
  // 4) 마지막 날 활동일 합계
  const activeDaysTotal = branch === 'finalDay'
    ? (archive || []).filter((e) => !e.isRestDay).length + 1 : null;

  // 5) 조립
  const actResult = buildActScene(questLabels, dateIso, categoryId, narrativeState.dayNo, heroName);
  const { opener, closer } = buildOpenerCloser({
    branch, stage, prevStage, setting: vocab.setting, dateIso, categoryId,
    questLabels, gapDays: narrativeState.gapDays, streak: narrativeState.streak,
    daysLeft: narrativeState.daysLeft, hookObject, revealUsed: !!revealText,
    act: narrativeState.act, activeDaysTotal, heroName,
  });
  const core = assembleCore({
    opener, actScene: actResult.scene, extraLine, dateIso, categoryId,
    hasDensityPrefix: actResult.hasDensityPrefix,
  });

  const paragraphs = [];
  if (revealText) paragraphs.push(revealText);
  paragraphs.push(core);
  paragraphs.push(closer + ' (' + narrativeState.dayNo + '일째)');
  let body = paragraphs.join('\n\n');

  if (trimmedMemo) body += '\n\n' + buildMemoLine(trimmedMemo, dateIso, categoryId, heroName);
  if (recallEntry && recallEntry.memo) {
    body += '\n\n그리고 문득, 예전의 한 줄이 떠올랐다 — "' + recallEntry.memo + '"';
  }

  return {
    body, dayNo: narrativeState.dayNo, branch, act: narrativeState.act, stageIndex,
    hook: hookObject ? { objectId: hookObject.objectId, teaser: hookObject.teaser } : null,
  };
}

/* ------------------------------------------------------------------
 * AI 프롬프트 (v3, v4에서 이름 반영)
 * ------------------------------------------------------------------ */
function buildGenreFlavor(p) {
  const { categoryId, dayNo, branch, gapDays, streak, act, priorHook, hookToPlant, heroName } = p;
  const vocab = getVocab(categoryId);
  const motifs = getMotifs(categoryId);
  const stage = vocab.stages[getStageIndex(vocab, dayNo)];
  const who = heroBase(heroName);

  let flavor =
    '현실의 행동을 다음 세계관으로 번역해서 써라: 배경은 "' + vocab.setting + '", 주인공(이름: ' + who + ')은 지금 "' + stage + '" 단계에 있다. ' +
    '주인공을 부를 때 "주인공"이라는 말 대신 반드시 이름("' + who + '")이나 "그/그녀"를 써라. ' +
    '주인공의 변화 방향은 "' + vocab.identityShift + '"이다. 이 변화를 훈계가 아니라 행동과 장면으로 은은하게 드러내라. ' +
    '행동을 하지 않았다고 비난하거나 벌하지 마라 — 그저 이야기의 결이 조금 다르게 흐를 뿐이다. ';

  flavor += '이 세계의 감각 어휘를 참고하되 그대로 베끼지는 마라: ' + motifs.senses.slice(0, 3).join(' / ') + ' ';
  if (motifs.ambients && motifs.ambients.length) {
    flavor += '시간·날씨 질감도 참고하라: ' + motifs.ambients.slice(0, 2).join(' / ') + ' ';
  }
  if (motifs.companion && motifs.companion.name) {
    flavor += '이 세계에는 "' + motifs.companion.name + '"라는 인물이 산다. 아주 가끔만, 훈계 없이 스쳐 지나가는 존재로 쓸 수 있다. ';
  }
  if (act === 1) flavor += '지금은 도입부(1막)다. 세계가 낯설고, 걸음에 탐색의 긴장이 있다. ';
  else if (act === 2) flavor += '지금은 전개부(2막)다. 세계가 손에 익기 시작했고, 반복이 실력이 되어 간다. ';
  else if (act === 3) flavor += '지금은 절정부(3막)다. 결말이 가깝고, 지나온 장면들이 서로 이어진다. ';

  if (branch === 'firstDay') flavor += '오늘은 이 책의 첫날이다. 시작의 무게와 설렘을, 거창한 선언 대신 첫걸음의 구체적 감각으로 써라. ';
  else if (branch === 'finalDay') flavor += '오늘은 마지막 날이다. 첫날의 자신과 오늘의 자신을 대비시키되, 끝맺음이 아니라 다음 이야기의 예감으로 닫아라. ';
  else if (branch === 'comeback' && gapDays) flavor += who + '은(는) ' + gapDays + '일의 공백 끝에 돌아왔다. 공백을 실패로 그리지 말고, 이야기가 숨을 참고 기다린 것으로 그려라. ';
  else if (branch === 'personalBest' && streak) flavor += '오늘 ' + who + '은(는) 자신의 최고 기록(' + streak + '일)을 처음 넘어섰다. 지도 밖에 들어선 감각으로 써라. ';
  else if (branch === 'milestone' && streak) flavor += '오늘은 연속 ' + streak + '일째 마일스톤이다. 숫자를 자랑하지 말고, 반복이 쌓아 올린 것을 장면으로 보여라. ';
  else if (branch === 'stageTransition') flavor += '오늘 ' + who + '은(는) 새 구간("' + stage + '")에 들어섰다. 지형과 공기가 달라졌음을 감각으로 드러내라. ';
  else if (branch === 'halfway') flavor += '오늘은 여정의 정확한 중간이다. 지나온 절반과 남은 절반을 한 장면에서 마주 보게 하라. ';
  else if (branch === 'finalStretch') flavor += '끝이 며칠 남지 않았다. 결말이 가까운 긴장과 가벼워진 걸음을 함께 담아라. ';

  if (priorHook && priorHook.objectId) {
    const obj = motifs.objects.find((o) => o.id === priorHook.objectId);
    if (obj) flavor += '중요: 어제 이야기 끝에 "' + obj.teaser + '"가 멀리 보였다. 오늘 초반에 ' + who + '이(가) 거기 도달해 정체를 확인하는 장면을 반드시 넣어라. 정체: "' + obj.reveal + '" ';
  }
  if (hookToPlant && hookToPlant.teaser) {
    flavor += '중요: 이야기 마지막을 "' + hookToPlant.teaser + '"가 멀리서 눈에 들어오는 장면으로 끝내라. 정체는 절대 밝히지 말고, 내일 확인하게 될 거라는 기대만 남겨라. ';
  }

  flavor += '형식: 3~6문장을 2~3개의 짧은 문단으로 나눠 써라. 마지막 문장은 좋은 글이 아니라 행동을 부르는 글이어야 한다: 감상("노을은 아름다웠다")이 아니라, 오늘의 행동이 무언가를 구체적으로 열어젖혔고 그 너머에 아직 확인 안 된 무언가가 있어 "내일 또 하면 저게 뭔지 알 것 같다"는 기대를 남겨라.';
  return flavor;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    generateTodayStory, buildGenreFlavor,
    buildRestDayLine, buildActScene, buildMemoLine, buildOpenerCloser, assembleCore,
    pickHookObject, pickSenseLine, pickAmbientLine, pickCompanionLine,
    buildHookReveal, buildHookCloser, collectUsedHookIds,
    heroTopic, heroSubj, heroBase,
  };
}
