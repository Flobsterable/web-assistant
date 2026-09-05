# DeepSeek Web Assistant

Минимальное fullstack-приложение для выполнения задания 3: React + TypeScript + Vite на frontend, Node.js + Express + TypeScript на backend, DeepSeek API как LLM.

## Что делает приложение

Пользователь вводит одну логическую, алгоритмическую или аналитическую задачу. Backend решает её через API четырьмя способами:

1. Прямой ответ без дополнительных инструкций.
2. Ответ с добавленной инструкцией: «Решай пошагово».
3. Двухэтапный вариант: модель сначала составляет промпт для решения задачи, затем этот промпт используется в отдельном API-запросе.
4. Группа экспертов: аналитик, инженер и критик дают решение/проверку, после чего формируется общий ответ.

После этого backend отправляет ещё один API-запрос, который сравнивает четыре результата: отличаются ли ответы, есть ли ошибки, и какой способ дал наиболее точный результат.

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
