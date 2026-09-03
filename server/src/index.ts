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
const deepseekModel = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';

app.use(cors());
app.use(express.json());

type DeepSeekResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  error?: {
    message?: string;
  };
};

app.post('/api/chat', async (req: Request, res: Response) => {
  const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';

  if (!prompt) {
    return res.status(400).json({ error: 'Prompt is required.' });
  }

  if (!deepseekApiKey) {
    return res.status(500).json({ error: 'DEEPSEEK_API_KEY is not configured.' });
  }

  try {
    const deepseekResponse = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${deepseekApiKey}`
      },
      body: JSON.stringify({
        model: deepseekModel,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = (await deepseekResponse.json()) as DeepSeekResponse;

    if (!deepseekResponse.ok) {
      return res.status(deepseekResponse.status).json({
        error: data.error?.message || 'DeepSeek API request failed.'
      });
    }

    const answer = data.choices?.[0]?.message?.content;

    if (!answer) {
      return res.status(502).json({ error: 'DeepSeek API returned an empty response.' });
    }

    return res.json({ answer });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to contact DeepSeek API.' });
  }
});

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
