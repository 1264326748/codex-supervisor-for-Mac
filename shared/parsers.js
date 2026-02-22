export function extractTaggedJson(text, tagName) {
  const all = extractAllTaggedJson(text, tagName);
  if (all.length === 0) {
    return null;
  }
  return all[all.length - 1];
}

export function safeParseJson(raw) {
  const source = String(raw || '').trim();
  try {
    return JSON.parse(source);
  } catch {
    const repaired = source
      .replace(/\r/g, '')
      .replace(/\n\s*/g, '')
      .trim();
    if (!repaired) {
      return null;
    }
    try {
      return JSON.parse(repaired);
    } catch {
      return null;
    }
  }
}

export function parseSupervisorPlanFromText(text) {
  const candidates = collectJsonCandidates(text, {
    tags: ['task_plan_json'],
    preferPlanLike: true,
  });

  const picked = pickBestPlanCandidate(candidates);
  if (!picked) {
    return { ok: false, error: '未解析到结构化计划块' };
  }

  return {
    ok: true,
    plan: {
      planSummary: picked.planSummary,
      tasks: picked.tasks,
    },
  };
}

export function parseDispatchInstructionFromText(text) {
  const candidates = collectJsonCandidates(text, {
    tags: ['dispatch_json'],
    preferPlanLike: false,
  });

  for (const candidate of candidates) {
    const dispatch = normalizeDispatchCandidate(candidate);
    if (dispatch) {
      return {
        ok: true,
        dispatch,
      };
    }
  }

  return { ok: false, error: '未解析到 dispatch_json' };
}

export function parseSupervisorDispatchActionsFromText(text, { workerIds = [] } = {}) {
  const knownWorkers = Array.isArray(workerIds)
    ? workerIds.map((item) => normalizeWorkerId(item)).filter(Boolean)
    : [];
  const actions = [];
  const seen = new Set();

  const pushAction = (workerId, instruction) => {
    const normalizedWorkerId = normalizeWorkerId(workerId);
    const normalizedInstruction = String(instruction || '').trim();
    if (!normalizedWorkerId || !normalizedInstruction) {
      return;
    }
    const key = `${normalizedWorkerId}::${normalizedInstruction}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    actions.push({
      workerId: normalizedWorkerId,
      instruction: normalizedInstruction,
    });
  };

  const singleDispatches = extractAllTaggedJson(text, 'dispatch_json');
  for (const payload of singleDispatches) {
    const dispatch = normalizeDispatchCandidate(payload);
    if (!dispatch) {
      continue;
    }
    pushAction(dispatch.workerId, dispatch.instruction);
  }

  const batchDispatches = extractAllTaggedJson(text, 'dispatch_batch_json');
  for (const payload of batchDispatches) {
    const list = pickFirstArray([
      payload.tasks,
      payload.dispatches,
      payload.items,
      payload.workers,
    ]);
    if (!Array.isArray(list)) {
      continue;
    }
    for (const item of list) {
      const dispatch = normalizeDispatchCandidate(item);
      if (!dispatch) {
        continue;
      }
      pushAction(dispatch.workerId, dispatch.instruction);
    }
  }

  const broadcastDispatches = extractAllTaggedJson(text, 'dispatch_all_json');
  for (const payload of broadcastDispatches) {
    const instruction = String(
      payload.instruction
      || payload.message
      || payload.task
      || ''
    ).trim();
    if (!instruction) {
      continue;
    }
    const targetWorkerIds = Array.isArray(payload.workerIds)
      ? payload.workerIds.map((item) => normalizeWorkerId(item)).filter(Boolean)
      : knownWorkers;
    for (const workerId of targetWorkerIds) {
      pushAction(workerId, instruction);
    }
  }

  if (actions.length === 0) {
    return {
      ok: false,
      error: '未解析到可执行下发动作',
    };
  }

  return {
    ok: true,
    actions,
  };
}


function normalizeInputText(text) {
  const source = String(text || '');
  return source
    .replace(/\r/g, '\n')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u0000/g, '');
}

function extractAllTaggedJson(text, tagName) {
  const source = normalizeInputText(text);
  const openTag = `<${tagName}>`;
  const closeTag = `</${tagName}>`;

  const parsed = [];
  let cursor = 0;
  while (cursor < source.length) {
    const start = source.indexOf(openTag, cursor);
    if (start < 0) {
      break;
    }
    const end = source.indexOf(closeTag, start + openTag.length);
    if (end < 0) {
      break;
    }
    const body = source.slice(start + openTag.length, end).trim();
    const payload = safeParseJson(body);
    if (payload && typeof payload === 'object') {
      parsed.push(payload);
    }
    cursor = end + closeTag.length;
  }

  return parsed;
}

function collectJsonCandidates(text, { tags = [], preferPlanLike = false } = {}) {
  const source = normalizeInputText(text);
  const parsed = [];
  const seen = new Set();

  const tryPush = (payload) => {
    if (!payload || typeof payload !== 'object') {
      return;
    }
    const key = JSON.stringify(payload);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    parsed.push(payload);
  };

  for (const tag of tags) {
    for (const payload of extractAllTaggedJson(source, tag)) {
      tryPush(payload);
    }
  }

  for (const raw of extractJsonFromFencedBlocks(source)) {
    tryPush(safeParseJson(raw));
  }

  for (const raw of extractBalancedJsonObjects(source)) {
    const payload = safeParseJson(raw);
    if (!payload || typeof payload !== 'object') {
      continue;
    }
    if (!preferPlanLike || looksLikePlan(payload)) {
      tryPush(payload);
    }
  }

  return parsed;
}

function extractJsonFromFencedBlocks(source) {
  const list = [];
  const regex = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match = regex.exec(source);
  while (match) {
    const body = String(match[1] || '').trim();
    if (body) {
      list.push(body);
    }
    match = regex.exec(source);
  }
  return list;
}

function extractBalancedJsonObjects(source) {
  const list = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '{') {
      if (depth === 0) {
        start = i;
      }
      depth += 1;
      continue;
    }

    if (ch === '}') {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        list.push(source.slice(start, i + 1));
        start = -1;
      }
      if (depth < 0) {
        depth = 0;
        start = -1;
      }
    }
  }

  return list;
}

function pickBestPlanCandidate(candidates) {
  let best = null;

  for (const candidate of candidates) {
    const normalized = normalizePlanCandidate(candidate);
    if (!normalized) {
      continue;
    }
    if (!best || normalized.score > best.score) {
      best = normalized;
    }
  }

  if (!best) {
    return null;
  }

  return {
    planSummary: best.planSummary,
    tasks: best.tasks,
  };
}

function normalizePlanCandidate(candidate) {
  const tasksRaw = pickFirstArray([
    candidate.tasks,
    candidate.subtasks,
    candidate.items,
    candidate.workers,
  ]);
  if (!tasksRaw || !Array.isArray(tasksRaw)) {
    return null;
  }

  const tasks = tasksRaw
    .map((task, index) => normalizeTask(task, index))
    .filter(Boolean)
    .sort((a, b) => a.workerIndex - b.workerIndex);

  if (tasks.length === 0) {
    return null;
  }

  const planSummary = String(
    candidate.planSummary
    || candidate.summary
    || candidate.overview
    || candidate.plan
    || ''
  ).trim();

  let score = tasks.length * 10;
  if (planSummary) {
    score += 3;
  }
  if (Array.isArray(candidate.tasks)) {
    score += 2;
  }

  return {
    planSummary,
    tasks,
    score,
  };
}

function normalizeTask(task, index) {
  if (!task || typeof task !== 'object') {
    return null;
  }
  const workerIndex = parseWorkerIndex(task.workerIndex ?? task.index ?? task.worker ?? task.workerId, index + 1);
  const title = String(task.title || task.name || `子任务 ${index + 1}`).trim();
  const instruction = String(
    task.instruction
    || task.prompt
    || task.task
    || task.description
    || ''
  ).trim();
  if (!instruction) {
    return null;
  }

  const dependsOnRaw = task.dependsOn ?? task.depends ?? task.deps ?? [];
  const dependsOn = normalizeDepends(dependsOnRaw);

  return {
    workerIndex,
    title,
    instruction,
    dependsOn,
  };
}

function normalizeDispatchCandidate(candidate) {
  if (!candidate || typeof candidate !== 'object') {
    return null;
  }

  const workerIdRaw = candidate.workerId || candidate.worker || candidate.target || candidate.targetWorker || '';
  const workerId = normalizeWorkerId(workerIdRaw);
  const instruction = String(
    candidate.instruction
    || candidate.prompt
    || candidate.message
    || candidate.task
    || ''
  ).trim();

  if (!workerId || !instruction) {
    return null;
  }

  return {
    workerId,
    instruction,
  };
}

function normalizeWorkerId(value) {
  const text = String(value || '').trim();
  if (!text) {
    return '';
  }
  if (/^worker-\d+$/i.test(text)) {
    return text.toLowerCase();
  }
  const parsed = parseWorkerIndex(text, NaN);
  if (Number.isFinite(parsed) && parsed > 0) {
    return `worker-${parsed}`;
  }
  return '';
}

function normalizeDepends(raw) {
  if (Array.isArray(raw)) {
    return raw
      .map((item) => parseWorkerIndex(item, NaN))
      .filter((item) => Number.isInteger(item) && item > 0);
  }

  if (typeof raw === 'string') {
    const matches = raw.match(/\d+/g) || [];
    return matches
      .map((item) => Number(item))
      .filter((item) => Number.isInteger(item) && item > 0);
  }

  return [];
}

function parseWorkerIndex(value, fallback) {
  if (Number.isInteger(value) && value > 0) {
    return Number(value);
  }

  const text = String(value ?? '').trim();
  if (!text) {
    return fallback;
  }

  const fromSuffix = text.match(/(\d+)$/);
  if (fromSuffix) {
    const number = Number(fromSuffix[1]);
    if (Number.isInteger(number) && number > 0) {
      return number;
    }
  }

  const parsed = Number(text);
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }

  return fallback;
}

function pickFirstArray(list) {
  for (const item of list) {
    if (Array.isArray(item)) {
      return item;
    }
  }
  return null;
}

function looksLikePlan(payload) {
  return !!pickFirstArray([payload.tasks, payload.subtasks, payload.items, payload.workers]);
}
