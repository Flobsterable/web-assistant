# Приватный LLM API на Windows без VPN

Ollama остаётся доступной только на Windows через `127.0.0.1:11434`. Небольшой шлюз добавляет API-ключ, rate limit, ограничение контекста, ограничение параллельных запросов и очередь. Caddy публикует шлюз по HTTPS.

## Схема

```text
Mac agent -> HTTPS :443 -> router -> Caddy -> gateway :8080 -> Ollama :11434
```

Порты `8080` и `11434` в роутере открывать не нужно.

## 1. Подготовка Windows

Установите Node.js 20+ и Caddy. Убедитесь, что Ollama отвечает локально:

```powershell
curl.exe http://127.0.0.1:11434/api/tags
```

Скопируйте пример настроек и создайте случайный ключ:

```powershell
cd gateway
Copy-Item .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Вставьте результат в `LLM_API_KEY` файла `.env`. Проверьте `TEST_MODEL` командой `ollama list`.

Запустите шлюз:

```powershell
npm start
```

Локальная проверка:

```powershell
curl.exe -H "Authorization: Bearer ВАШ_КЛЮЧ" http://127.0.0.1:8080/health
```

## 2. Домен, HTTPS и роутер

Создайте DNS-запись `A`, например `llm.example.com`, указывающую на публичный IP сети Windows. При динамическом IP используйте DDNS.

В PowerShell перед запуском Caddy задайте домен:

```powershell
$env:LLM_DOMAIN = "llm.example.com"
caddy run --config .\Caddyfile
```

Caddy автоматически получает TLS-сертификат. Для этого домен должен указывать на публичный IP, а входящие порты `80` и `443` должны доходить до Windows.

На роутере настройте перенаправление:

- внешний TCP `80` -> Windows TCP `80`;
- внешний TCP `443` -> Windows TCP `443`.

В Windows Firewall разрешите Caddy входящие TCP `80` и `443`. Не создавайте публичные правила для `8080` и `11434`.

## 3. Настройка агента на Mac

В корневом `.env` проекта:

```dotenv
MODEL_LOCAL_BASE_URL=https://llm.example.com/v1
MODEL_LOCAL_API_KEY=тот-же-случайный-ключ
MODEL_LOCAL_NAME=qwen3.5:9b
MODEL_LOCAL_MAX_CONTEXT_TOKENS=8192
MODEL_LOCAL_CONTEXT_WINDOW=8192
MODEL_LOCAL_MAX_OUTPUT_TOKENS=600
```

Перезапустите приложение. Проверка:

```bash
curl http://localhost:3001/api/ollama/status
```

## 4. Проверка сети и параллельных запросов

На Mac скопируйте `gateway/.env.example` в `gateway/.env`, заполните `PUBLIC_LLM_BASE_URL`, `LLM_API_KEY` и `TEST_MODEL`, затем выполните:

```bash
npm run smoke --workspace gateway
```

Тест проверяет `/health` и отправляет четыре параллельных запроса. Ответ `/health` показывает активные ограничения. При переполнении очереди шлюз возвращает `503`, а при превышении лимита — `429`.

## Если соединение не устанавливается

Сравните публичный IP в панели роутера с IP, который показывает внешний сервис проверки адреса. Если они различаются, вероятен CGNAT: обычный port forwarding работать не будет. В таком случае без VPN потребуется VPS с reverse proxy/reverse SSH tunnel либо публичный tunnel-провайдер.
