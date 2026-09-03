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

## Как работает поток

1. Пользователь вводит prompt в textarea на frontend.
2. React отправляет `POST /api/chat` на backend.
3. Express валидирует prompt и отправляет запрос в DeepSeek API.
4. DeepSeek возвращает ответ модели на backend.
5. Backend возвращает текст ответа на frontend.
6. Frontend показывает ответ, загрузку или ошибку на странице.
