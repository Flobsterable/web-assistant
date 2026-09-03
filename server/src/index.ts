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

function readRequiredIntegerEnv(name: string) {
  const value = Number(process.env[name]);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function readRequiredTextEnv(name: string) {
  const value = process.env[name]?.replace(/\\n/g, '\n').trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function readConstraintEnv() {
  const enabled = new Set(readRequiredTextEnv('DEFAULT_CONSTRAINTS').split(',').map((value) => value.trim()));
  return {
    format: enabled.has('format'),
    length: enabled.has('length'),
    stop: enabled.has('stop')
  };
}

const appConfig = {
  model: readRequiredTextEnv('DEEPSEEK_MODEL'),
  minAllowedTokens: readRequiredIntegerEnv('MIN_ALLOWED_TOKENS'),
  maxAllowedTokens: readRequiredIntegerEnv('MAX_ALLOWED_TOKENS'),
  maxStopSequenceLength: readRequiredIntegerEnv('MAX_STOP_SEQUENCE_LENGTH'),
  defaults: {
    prompt: readRequiredTextEnv('DEFAULT_PROMPT'),
    format: readRequiredTextEnv('DEFAULT_FORMAT'),
    maxTokens: readRequiredIntegerEnv('DEFAULT_MAX_TOKENS'),
    stopSequence: readRequiredTextEnv('DEFAULT_STOP_SEQUENCE'),
    responseFormat: readRequiredTextEnv('DEFAULT_RESPONSE_FORMAT') as ResponseFormat,
    constraints: readConstraintEnv()
  }
};

if (!['text', 'json_object'].includes(appConfig.defaults.responseFormat)) {
  throw new Error('DEFAULT_RESPONSE_FORMAT must be either text or json_object.');
}

if (
  appConfig.minAllowedTokens > appConfig.maxAllowedTokens ||
  appConfig.defaults.maxTokens < appConfig.minAllowedTokens ||
  appConfig.defaults.maxTokens > appConfig.maxAllowedTokens
) {
  throw new Error('Token limits are inconsistent.');
}

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

type ResponseFormat = 'text' | 'json_object';

type CompareRequest = {
  prompt: string;
  format: string;
  maxTokens: number | null;
  stopSequence: string;
  responseFormat: ResponseFormat;
  constraints: {
    format: boolean;
    length: boolean;
    stop: boolean;
  };
};

function readCompareRequest(body: unknown): CompareRequest | string {
  if (!body || typeof body !== 'object') return 'Request body is required.';

  const candidate = body as Record<string, unknown>;
  const prompt = typeof candidate.prompt === 'string' ? candidate.prompt.trim() : '';
  const format = typeof candidate.format === 'string' ? candidate.format.trim() : '';
  const maxTokens = candidate.maxTokens;
  const stopSequence = typeof candidate.stopSequence === 'string' ? candidate.stopSequence.trim() : '';
  const responseFormat: ResponseFormat = candidate.responseFormat === 'json_object' ? 'json_object' : 'text';
  const candidateConstraints =
    candidate.constraints && typeof candidate.constraints === 'object'
      ? (candidate.constraints as Record<string, unknown>)
      : {};
  const constraints = {
    format:
      typeof candidateConstraints.format === 'boolean'
        ? candidateConstraints.format
        : appConfig.defaults.constraints.format,
    length:
      typeof candidateConstraints.length === 'boolean'
        ? candidateConstraints.length
        : appConfig.defaults.constraints.length,
    stop:
      typeof candidateConstraints.stop === 'boolean' ? candidateConstraints.stop : appConfig.defaults.constraints.stop
  };

  if (!prompt) return 'Prompt is required.';
  if (constraints.format && !format) return 'Response format is required.';
  if (constraints.length) {
    if (
      !Number.isInteger(maxTokens) ||
      (maxTokens as number) < appConfig.minAllowedTokens ||
      (maxTokens as number) > appConfig.maxAllowedTokens
    ) {
      return `maxTokens must be an integer between ${appConfig.minAllowedTokens} and ${appConfig.maxAllowedTokens}.`;
    }
  }
  if (constraints.stop && !stopSequence) return 'Stop sequence is required.';
  if (constraints.stop && stopSequence.length > appConfig.maxStopSequenceLength) {
    return `Stop sequence must be ${appConfig.maxStopSequenceLength} characters or fewer.`;
  }

  return {
    prompt,
    format,
    maxTokens: constraints.length ? (maxTokens as number) : null,
    stopSequence,
    responseFormat,
    constraints
  };
}

async function requestCompletion(
  messages: Array<{ role: 'user'; content: string }>,
  options?: { maxTokens?: number; stopSequence?: string; responseFormat?: ResponseFormat }
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
      ...(options?.maxTokens ? { max_tokens: options.maxTokens } : {}),
      ...(options?.stopSequence ? { stop: options.stopSequence } : {}),
      ...(options?.responseFormat === 'json_object' ? { response_format: { type: 'json_object' } } : {})
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
    minAllowedTokens: appConfig.minAllowedTokens,
    maxAllowedTokens: appConfig.maxAllowedTokens,
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

  const controlledInstructions = [
    ...(request.constraints.format
      ? [
          request.format,
          ...(request.responseFormat === 'json_object'
            ? ['Верни только валидный JSON без markdown-обёртки и дополнительного текста.']
            : [])
        ]
      : []),
    ...(request.constraints.length && request.maxTokens
      ? [`Не используй больше ${request.maxTokens} токенов.`]
      : []),
    ...(request.constraints.stop
      ? [`Заверши ответ, когда достигнешь логического конца или перед последовательностью «${request.stopSequence}».`]
      : [])
  ];
  const controlledPrompt = controlledInstructions.length
    ? [request.prompt, '', 'Требования к ответу:', ...controlledInstructions].join('\n')
    : request.prompt;

  try {
    const [unrestricted, controlled] = await Promise.all([
      requestCompletion([{ role: 'user', content: request.prompt }]),
      requestCompletion(
        [{ role: 'user', content: controlledPrompt }],
        {
          ...(request.constraints.length && request.maxTokens ? { maxTokens: request.maxTokens } : {}),
          ...(request.constraints.stop ? { stopSequence: request.stopSequence } : {}),
          ...(request.constraints.format ? { responseFormat: request.responseFormat } : {})
        }
      )
    ]);

    return res.json({ unrestricted, controlled });
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
