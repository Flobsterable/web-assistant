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
  temperature: number;
};

type CompareResponse = {
  temperatureZero: MethodResult;
  temperatureBalanced: MethodResult;
  temperatureHigh: MethodResult;
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

async function requestCompletion(
  messages: Array<{ role: 'user'; content: string }>,
  options?: { temperature?: number }
): Promise<CompletionResult> {
  const deepseekResponse = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${deepseekApiKey}`
    },
    body: JSON.stringify({
      model: appConfig.model,
      messages,
      thinking: { type: 'disabled' },
      ...(typeof options?.temperature === 'number' ? { temperature: options.temperature } : {})
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

  const sharedPrompt = [
    request.task,
    '',
    'Ответь на русском языке. Сначала дай сам ответ, затем коротко поясни ход решения.'
  ].join('\n');
  const temperatures = {
    temperatureZero: 0,
    temperatureBalanced: 0.7,
    temperatureHigh: 1.2
  } as const;

  try {
    const [temperatureZeroCompletion, temperatureBalancedCompletion, temperatureHighCompletion] = await Promise.all([
      requestCompletion([{ role: 'user', content: sharedPrompt }], {
        temperature: temperatures.temperatureZero
      }),
      requestCompletion([{ role: 'user', content: sharedPrompt }], {
        temperature: temperatures.temperatureBalanced
      }),
      requestCompletion([{ role: 'user', content: sharedPrompt }], {
        temperature: temperatures.temperatureHigh
      })
    ]);

    const response: Omit<CompareResponse, 'comparison'> = {
      temperatureZero: {
        ...temperatureZeroCompletion,
        prompt: sharedPrompt,
        temperature: temperatures.temperatureZero
      },
      temperatureBalanced: {
        ...temperatureBalancedCompletion,
        prompt: sharedPrompt,
        temperature: temperatures.temperatureBalanced
      },
      temperatureHigh: {
        ...temperatureHighCompletion,
        prompt: sharedPrompt,
        temperature: temperatures.temperatureHigh
      }
    };

    const comparisonPrompt = [
      'Сравни три ответа на один и тот же запрос, полученные с разными temperature.',
      'Оцени каждый вариант по точности, креативности и разнообразию.',
      'Сформулируй вывод: для каких задач лучше подходит temperature = 0, temperature = 0.7 и temperature = 1.2.',
      'Ответ дай на русском языке. Используй короткие абзацы или маркированный список.',
      '',
      `Задача: ${request.task}`,
      '',
      `1. temperature = 0:\n${response.temperatureZero.answer}`,
      '',
      `2. temperature = 0.7:\n${response.temperatureBalanced.answer}`,
      '',
      `3. temperature = 1.2:\n${response.temperatureHigh.answer}`
    ].join('\n');
    const comparison = await requestCompletion([{ role: 'user', content: comparisonPrompt }], {
      temperature: 0
    });

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
