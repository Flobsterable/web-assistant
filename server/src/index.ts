import cors from 'cors';
import dotenv from 'dotenv';
import express, { Request, Response } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config();

const app = express();
const port = Number(process.env.PORT) || 3001;
const deepseekApiKey = process.env.DEEPSEEK_API_KEY;

function readRequiredTextEnv(name: string) {
  const value = process.env[name]?.replace(/\\n/g, '\n').trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

const appConfig = {
  model: readRequiredTextEnv('DEEPSEEK_MODEL'),
  defaults: {
    task: readRequiredTextEnv('DEFAULT_TASK')
  }
};

app.use(cors());
app.use(express.json({ limit: '32kb' }));

type DeepSeekResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    completion_tokens?: number;
  };
  error?: {
    message?: string;
  };
};

type CompletionResult = {
  answer: string;
  completionTokens: number | null;
  finishReason: string | null;
};

type MethodResult = CompletionResult & {
  prompt: string;
};

type CompareResponse = {
  direct: MethodResult;
  stepByStep: MethodResult;
  generatedPrompt: MethodResult & {
    generatedPrompt: string;
  };
  experts: MethodResult;
  comparison: CompletionResult;
};

type CompareRequest = {
  task: string;
};

function readCompareRequest(body: unknown): CompareRequest | string {
  if (!body || typeof body !== 'object') return 'Request body is required.';

  const candidate = body as Record<string, unknown>;
  const task = typeof candidate.task === 'string' ? candidate.task.trim() : '';

  if (!task) return 'Task is required.';

  return { task };
}

async function requestCompletion(messages: Array<{ role: 'user'; content: string }>): Promise<CompletionResult> {
  const deepseekResponse = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${deepseekApiKey}`
    },
    body: JSON.stringify({
      model: appConfig.model,
      messages,
      thinking: { type: 'disabled' }
    })
  });

  const data = (await deepseekResponse.json()) as DeepSeekResponse;

  if (!deepseekResponse.ok) {
    throw new Error(data.error?.message || 'DeepSeek API request failed.');
  }

  const choice = data.choices?.[0];
  const answer = choice?.message?.content;
  const finishReason = choice?.finish_reason ?? null;

  if (!answer?.trim()) {
    throw new Error(
      `DeepSeek API returned no final text${finishReason ? ` (finish_reason: ${finishReason})` : ''}.`
    );
  }

  return {
    answer,
    completionTokens: data.usage?.completion_tokens ?? null,
    finishReason
  };
}

app.get('/api/config', (_req: Request, res: Response) => {
  return res.json({
    model: appConfig.model,
    defaults: appConfig.defaults,
    hasApiKey: Boolean(deepseekApiKey)
  });
});

app.post('/api/compare', async (req: Request, res: Response) => {
  const request = readCompareRequest(req.body);

  if (typeof request === 'string') {
    return res.status(400).json({ error: request });
  }

  if (!deepseekApiKey) {
    return res.status(500).json({ error: 'DEEPSEEK_API_KEY is not configured.' });
  }

  const directPrompt = request.task;
  const stepByStepPrompt = `${request.task}\n\nРешай пошагово.`;
  const promptBuilderPrompt = [
    'Составь один точный промпт для решения задачи ниже.',
    'Промпт должен требовать краткое, проверяемое решение и итоговый ответ.',
    'Верни только сам промпт без пояснений.',
    '',
    `Задача: ${request.task}`
  ].join('\n');
  const expertsPrompt = [
    request.task,
    '',
    'Создай группу экспертов: аналитик, инженер и критик.',
    'Пусть каждый эксперт даст своё решение или проверку.',
    'В конце дай общий финальный ответ.'
  ].join('\n');

  try {
    const [directCompletion, stepByStepCompletion, generatedPromptCompletion, expertsCompletion] = await Promise.all([
      requestCompletion([{ role: 'user', content: directPrompt }]),
      requestCompletion([{ role: 'user', content: stepByStepPrompt }]),
      requestCompletion([{ role: 'user', content: promptBuilderPrompt }]),
      requestCompletion([{ role: 'user', content: expertsPrompt }])
    ]);
    const improvedPrompt = generatedPromptCompletion.answer.trim();
    const generatedPromptSolution = await requestCompletion([{ role: 'user', content: improvedPrompt }]);

    const response: Omit<CompareResponse, 'comparison'> = {
      direct: {
        ...directCompletion,
        prompt: directPrompt
      },
      stepByStep: {
        ...stepByStepCompletion,
        prompt: stepByStepPrompt
      },
      generatedPrompt: {
        ...generatedPromptSolution,
        prompt: promptBuilderPrompt,
        generatedPrompt: improvedPrompt
      },
      experts: {
        ...expertsCompletion,
        prompt: expertsPrompt
      }
    };

    const comparisonPrompt = [
      'Сравни четыре ответа на одну задачу.',
      'Нужно кратко указать: отличаются ли ответы, есть ли ошибки, какой способ дал наиболее точный результат.',
      'Ответ дай на русском языке в 3-5 предложениях.',
      '',
      `Задача: ${request.task}`,
      '',
      `1. Прямой ответ:\n${response.direct.answer}`,
      '',
      `2. Решай пошагово:\n${response.stepByStep.answer}`,
      '',
      `3. Сначала составлен промпт, затем получено решение:\n${response.generatedPrompt.answer}`,
      '',
      `4. Группа экспертов:\n${response.experts.answer}`
    ].join('\n');
    const comparison = await requestCompletion([{ role: 'user', content: comparisonPrompt }]);

    return res.json({ ...response, comparison });
  } catch (error) {
    console.error(error);
    return res.status(502).json({
      error: error instanceof Error ? error.message : 'Failed to contact DeepSeek API.'
    });
  }
});

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
