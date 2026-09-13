# Simple LLM Agent

Минимальное fullstack-приложение: React + TypeScript + Vite на frontend, Node.js + Express + TypeScript на backend.

## Что делает приложение

Пользователь вводит запрос в чат. Backend принимает сообщение, передает его отдельной сущности `SimpleAgent`, агент вызывает LLM через HTTP API и возвращает ответ в интерфейс.

Агент сохраняет историю диалога в JSON-файл `server/data/agent-history.json`, загружает ее при каждом запуске и отправляет прошлые сообщения в следующий LLM-вызов. Поэтому после перезапуска backend продолжает диалог с тем же контекстом.

Главное требование выполнено: логика запроса, ответа и восстановления контекста инкапсулирована в агенте, а endpoint `/api/agent` только валидирует входные данные, создает агента и запускает его.

Хранилище использует атомарную запись через временный файл, хранит завершенные пары `user`/`assistant`, ограничивает размер сохраненной истории и формирует отдельное контекстное окно для LLM, чтобы старые диалоги не раздували каждый prompt бесконечно.

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

Параметры памяти агента:

```bash
AGENT_MAX_CONTEXT_MESSAGES=40
AGENT_MAX_CONTEXT_CHARACTERS=24000
```

Первый лимит ограничивает количество последних сообщений, которые агент подставляет в следующий LLM-вызов. Второй лимит защищает prompt от слишком длинной истории. Полная сохраненная история хранится на backend, а кнопка «Сбросить» очищает и экран, и JSON-файл.

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
