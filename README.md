# DeepSeek Temperature Comparison

Минимальное fullstack-приложение: React + TypeScript + Vite на frontend, Node.js + Express + TypeScript на backend, DeepSeek API как LLM.

## Что делает приложение

Пользователь вводит один запрос. Backend выполняет один и тот же запрос через API с тремя настройками:

1. `temperature = 0`.
2. `temperature = 0.7`.
3. `temperature = 1.2`.

После этого backend отправляет ещё один API-запрос, который сравнивает три результата по точности, креативности и разнообразию, а также формулирует, для каких задач лучше подходит каждая настройка.

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

Заполните `DEEPSEEK_API_KEY` в `.env`. Задача по умолчанию настраивается через `DEFAULT_TASK`.

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
