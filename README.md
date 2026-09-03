# DeepSeek Web Assistant

Минимальное fullstack-приложение: React + TypeScript + Vite на frontend, Node.js + Express + TypeScript на backend, DeepSeek API как LLM.

## Структура проекта

```text
.
├── client
│   ├── index.html
│   ├── package.json
│   ├── src
│   │   ├── App.tsx
│   │   ├── main.tsx
│   │   └── styles.css
│   ├── tsconfig.json
│   └── vite.config.ts
├── server
│   ├── package.json
│   ├── src
│   │   └── index.ts
│   └── tsconfig.json
├── .env.example
├── .gitignore
├── package.json
└── README.md
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

Заполните `DEEPSEEK_API_KEY` в `.env`.

Значения формы и ограничения также настраиваются через `.env`: `DEFAULT_PROMPT`, `DEFAULT_FORMAT`, `DEFAULT_MAX_TOKENS`, `DEFAULT_STOP_SEQUENCE`, `DEFAULT_RESPONSE_FORMAT`, `DEFAULT_CONSTRAINTS`, `MIN_ALLOWED_TOKENS`, `MAX_ALLOWED_TOKENS` и `MAX_STOP_SEQUENCE_LENGTH`. Backend отдаёт клиенту только безопасную конфигурацию через `GET /api/config`.

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

## Как работает сравнение

1. Пользователь задаёт исходный prompt и параметры контролируемого ответа.
2. React отправляет один `POST /api/compare` на backend.
3. Backend параллельно выполняет два запроса к DeepSeek: исходный и дополненный форматом, `max_tokens` и `stop`.
4. Frontend показывает ответы рядом, а также число токенов и причину завершения.

Переключатели в интерфейсе управляют ограничениями независимо: формат передаётся через `response_format` (для JSON), длина через `max_tokens`, а условие завершения через `stop`. Активные ограничения дополнительно описываются в инструкции контролируемого prompt.
