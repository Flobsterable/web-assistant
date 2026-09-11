# Simple LLM Agent

Минимальное fullstack-приложение: React + TypeScript + Vite на frontend, Node.js + Express + TypeScript на backend.

## Что делает приложение

Пользователь вводит запрос в чат. Backend принимает сообщение, передает его отдельной сущности `SimpleAgent`, агент вызывает LLM через HTTP API и возвращает ответ в интерфейс.

Главное требование выполнено: логика запроса и ответа инкапсулирована в агенте, а endpoint `/api/agent` только валидирует входные данные, создает агента и запускает его.

Текстовое описание агента лежит отдельно в Markdown-файле:

```text
server/agents/simple-agent.md
```

## Модель агента

Агент работает через DeepSeek Flash:

```text
MODEL_FLASH_NAME=deepseek-v4-flash
MODEL_FLASH_BASE_URL=https://api.deepseek.com
```

Вызов выполняется через OpenAI-compatible endpoint:

```text
POST https://api.deepseek.com/chat/completions
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

Заполните ключ:

```bash
DEEPSEEK_API_KEY=your_deepseek_api_key_here
```

`DEFAULT_TASK` задает запрос, который появится в форме по умолчанию.

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
