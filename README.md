# LLM Model Benchmark

Минимальное fullstack-приложение: React + TypeScript + Vite на frontend, Node.js + Express + TypeScript на backend.

## Что делает приложение

Пользователь вводит один запрос. Backend выполняет его параллельно на трёх моделях:

1. Слабая: `gemini-3.5-flash-lite`.
2. Средняя: `deepseek-v4-flash`.
3. Сильная: `deepseek-v4-pro`.

Для каждой модели приложение показывает:

- текст ответа;
- время ответа;
- input/output/total токены;
- источник подсчёта токенов: API или приблизительная оценка;
- стоимость запроса по тарифу из `.env`;
- ссылку на официальный прайс.

После трёх ответов сильная модель `deepseek-v4-pro` формирует короткий вывод о различиях по качеству, скорости, ресурсоёмкости и стоимости.

## Почему такая тройка

`gemini-3.5-flash-lite` используется как слабая бесплатная модель через Gemini API Free Tier. `deepseek-v4-flash` оставлен как средняя модель: она платная, но дешёвая и должна быть качественнее лёгкой Flash-Lite. `deepseek-v4-pro` оставлен как сильная DeepSeek-модель.

## API

DeepSeek использует OpenAI-compatible endpoint:

```text
POST https://api.deepseek.com/chat/completions
```

Gemini использует нативный endpoint:

```text
POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
```

## Установка

```bash
npm install
```

## Настройка

Создайте `.env` в корне проекта:

```bash
cp .env.example .env
```

Заполните ключи:

```bash
DEEPSEEK_API_KEY=your_deepseek_api_key_here
GEMINI_API_KEY=your_gemini_api_key_here
```

Цены в примере указаны в USD за 1M токенов:

- `deepseek-v4-flash`: 0.14 input cache miss / 0.28 output.
- `gemini-3.5-flash-lite`: 0 в Free Tier.
- `deepseek-v4-pro`: 0.435 input cache miss / 0.87 output.

`DEFAULT_TASK` задаёт запрос, который появится в форме по умолчанию.

## Запуск в режиме разработки

```bash
npm run dev
```

Frontend будет доступен на `http://localhost:5173`.
Backend будет доступен на `http://localhost:3001`.

## Production-сборка

```bash
npm run build
npm start
```
