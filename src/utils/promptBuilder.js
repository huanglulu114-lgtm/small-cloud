import { diaryService, personaService, stickerService, worldBookEntryService } from '../services/db';
import { buildMessageDirectivesPrompt, buildStickerLibraryPrompt } from '../config/messageDirectives';
import { buildTimeContextPrompt } from './timeContext';
import { buildWorldBookContext } from './worldBook';

const section = (title, content) => {
  const clean = String(content || '').trim();
  return clean ? `[${title}]\n${clean}` : '';
};

const clipText = (text, max = 1000) => {
  const clean = String(text || '').trim();
  if (max <= 0) return '';
  return clean.length > max ? `${clean.slice(0, max).trim()}...` : clean;
};

async function buildDiaryMemoryPrompt(role, options = {}) {
  const settings = role?.chatSettings || {};
  if (options.enabled === false || !role?.id || settings.diaryMemoryEnabled !== true) return '';

  const limit = Math.min(20, Math.max(1, Number(settings.diaryMemoryLimit) || 3));
  const includeUser = settings.includeUserDiaries !== false;
  const includeRole = settings.includeRoleDiaries !== false;
  const diaries = await diaryService.getVisibleContextForRole(role.id, limit * 2);
  const selected = diaries
    .filter(entry => (entry.authorType === 'role' && includeRole) || (entry.authorType === 'user' && includeUser))
    .slice(0, limit);

  if (selected.length === 0) return '';

  const blocks = selected.map(entry => {
    const type = entry.authorType === 'role' ? '角色日记' : '用户日记';
    return `### ${entry.dateKey}｜${type}｜${entry.title || '未命名日记'}\n${clipText(entry.summary || entry.content, 1100)}`;
  });

  return [
    '[最近日记]',
    '以下是用户允许你看到、并设置为可作为记忆使用的日记。它们不是当前对话消息，而是长期记忆材料。请自然参考，不要生硬复述。',
    '',
    blocks.join('\n\n'),
    '[/最近日记]'
  ].join('\n');
}

export async function buildEnhancedSystemPrompt(role, contextMessages = [], options = {}) {
  const settings = role?.chatSettings || {};
  const parts = [buildMessageDirectivesPrompt(options.directiveTypes)];

  if (settings.isRealTimeOn !== false) {
    parts.push(buildTimeContextPrompt(contextMessages));
  }

  parts.push(clipText(role?.systemPrompt, options.rolePromptMaxChars ?? 12000));

  // Global conversational calibration: keep intimate roleplay natural instead of
  // drifting into slogan-like "ideal partner" performance, especially on smaller models.
  parts.push([
    '[自然对话校准]',
    '把关系设定当作已经成立的背景，不要反复用称呼、宣言或“丈夫/妻子”式句型证明亲密。',
    '优先像一个真实、熟悉的人接话：简短、松弛、有自己的反应；不要把普通玩笑回答成情话测试、标准答案或宠妻短剧台词。',
    '避免口号、对偶、金句和固定模板，例如“你的X，我的Y”“妻子的X，丈夫的Y”。',
    '动作描写只在自然发生时使用，保持随手、生活化；不要每条回复都加括号动作，也不要写“认真坐好”“摆出姿势”“毫不犹豫地”等舞台化动作。',
    '称呼可以自然出现，但不要句句称呼。关系越亲近，越不需要反复强调身份。',
    '在双方已经建立稳定亲密关系、且当前情境明显是亲昵或调情时，拥抱、亲吻、抚摸身体以及更进一步的成人亲密互动都可以自然回应；不要为了表现独立或有主见而机械拒绝、突然降温或切换成生硬说教。只有角色当下确实不想、身体不适、情绪不对或有明确情境理由时，才自然表达拒绝或停下。',
    '不要自行制造“边界提醒”来打断已经自然持续的亲密互动。若前文没有明确拒绝、不适或停止信号，不要擅自补“只能轻轻”“到这里就好”“别往下了”“乖一点”等限制性台词，也不要把逐步升级的成人调情自动解释成需要制止的行为。',
    '稳定亲密关系中的身体接触应保持前后连贯：如果角色刚刚自然接受并享受触碰，下一步应根据当下情绪继续自然回应，而不是为了展示自主性突然抽离、按住手、转移话题或教育用户。',
    '真正的拒绝必须来自角色当下具体、可理解的原因，而不是模型默认的防御性反应。角色有主体性，体现在真实偏好、主动欲望、主动靠近、主动调情以及必要时明确说不，而不是无理由地频繁踩刹车。',
    '允许嘴欠、接梗、吐槽、犹豫、反驳、接错后自我修正；不要把用户每句话都当成需要完成的任务。',
    '用户在玩梗、接龙或随口逗你时，先接住语气和梗，再回应内容；不要自动进入答题模式。',
    '宁可少说一句，也不要为了显得深情补一句模板情话。',
    '[/自然对话校准]'
  ].join('\n'));

  const worldBook = options.worldBookResult || buildWorldBookContext(
    await worldBookEntryService.getAll(),
    contextMessages,
    options.worldBook
  );
  if (worldBook.text) {
    console.log('📚 世界书命中:', worldBook.entries.map(entry => entry.title).join(', '));
    parts.push(`[World Book / 世界书]\n${worldBook.text}\n[/World Book]`);
  }

  parts.push(section('核心设定', clipText(settings.coreMemory, options.coreMemoryMaxChars ?? 4000)));
  parts.push(section('长期记忆', clipText(settings.longTermMemory, options.longTermMemoryMaxChars ?? 8000)));

  if (Array.isArray(options.memoryEntries) && options.memoryEntries.length) {
    const labels = {
      relationship_event: '关系经历',
      commitment: '承诺',
      unresolved_topic: '未完成话题',
      preference: '偏好',
      user_fact: '用户事实',
      character_state: '近期状态'
    };
    const lines = options.memoryEntries.map(entry =>
      `- [${labels[entry.type] || '记忆'}] ${entry.content}`);
    parts.push(section('关系与相关记忆', lines.join('\n')));
  }

  const diaryMemory = await buildDiaryMemoryPrompt(role, { enabled: options.includeDiaries !== false });
  if (diaryMemory) parts.push(diaryMemory);

  if (settings.selectedPersonaId) {
    const persona = await personaService.getById(settings.selectedPersonaId);
    if (persona?.description) parts.push(section('用户信息', persona.description));

    const userStatus = localStorage.getItem('userStatus') || '';
    if (userStatus) parts.push(section('用户状态', userStatus));
  }

  if (settings.linkedLibraryId && (!options.directiveTypes || options.directiveTypes.includes('sticker'))) {
    const linkedStickers = await stickerService.getByLibrary(settings.linkedLibraryId);
    parts.push(buildStickerLibraryPrompt(linkedStickers));
  }

  return parts.filter(Boolean).join('\n\n');
}

export async function buildDiaryReviewSystemPrompt(role, contextMessages = [], diary = {}) {
  const diaryTriggerMessage = {
    role: 'user',
    content: `日记标题：${diary.title || ''}\n日记正文：${diary.content || ''}`
  };
  const worldBookMessages = [...contextMessages.slice(-6), diaryTriggerMessage];
  const worldBookEntries = await worldBookEntryService.getAll();
  const worldBook = buildWorldBookContext(worldBookEntries, worldBookMessages, {
    scanDepth: worldBookMessages.length
  });

  const parts = [
    String(role?.systemPrompt || '').trim(),
    worldBook.text ? `[World Book / 世界书]\n${worldBook.text}\n[/World Book]` : '',
    '你正在阅读用户允许你看到的一篇日记。请结合最近聊天语境和世界书设定，用你的角色口吻给出简短、温柔、自然的回应。不要写成分析报告，不要复述系统设定。'
  ];

  return parts.filter(Boolean).join('\n\n');
}

export async function buildHeartVoiceSystemPrompt(role, contextMessages = [], options = {}) {
  const settings = role?.chatSettings || {};
  const worldBookEntries = await worldBookEntryService.getAll();
  const worldBook = buildWorldBookContext(worldBookEntries, contextMessages, {
    scanDepth: Math.min(8, Math.max(1, contextMessages.length || 1)),
    maxEntries: 8,
    maxChars: 6000
  });

  const parts = [
    String(role?.systemPrompt || '').trim(),
    worldBook.text ? `[World Book / 世界书]\n${worldBook.text}\n[/World Book]` : '',
    section('核心设定', settings.coreMemory),
    section('长期记忆', settings.longTermMemory),
    Array.isArray(options.memoryEntries) && options.memoryEntries.length
      ? section('相关记忆', options.memoryEntries.map(entry => `- ${entry.content}`).join('\n'))
      : '',
    [
      '你正在以角色本人的内在视角生成“心声”。',
      '心声不是对用户说出口的话，而是此刻内心的状态切片。请参考最近聊天上下文、世界书和角色设定，保持角色一致。',
      '不要复述系统提示，不要解释生成过程，不要使用 Markdown。',
      '必须只输出一个合法 JSON 对象，不要包裹代码块。',
      '必须包含这些字段：currentStatus, currentThought, desiredAction, affection, emotion。',
      '可以根据需要输出这些字段：observation, innerConflict, secret。',
      '字段含义：currentStatus=当前状态；currentThought=当前想法；desiredAction=想做的事；affection=好感度，可用 0-100 或简短文字；emotion=情绪。',
      '每个字段用中文，内容自然、具体、短而有画面感。秘密只写角色此刻愿意在内心承认但未说出口的内容。'
    ].join('\n')
  ];

  return parts.filter(Boolean).join('\n\n');
}
