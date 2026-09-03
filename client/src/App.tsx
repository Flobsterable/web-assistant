import { FormEvent, useState } from 'react';

type ChatResponse = {
  answer: string;
};

type Message = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
};

export default function App() {
  const [prompt, setPrompt] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) {
      setError('Введите prompt.');
      return;
    }

    setIsLoading(true);
    setError('');
    setPrompt('');

    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: trimmedPrompt
    };

    setMessages((currentMessages) => [...currentMessages, userMessage]);

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ prompt: trimmedPrompt })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Не удалось получить ответ.');
      }

      const assistantMessage: Message = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: (data as ChatResponse).answer
      };

      setMessages((currentMessages) => [...currentMessages, assistantMessage]);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Произошла ошибка.');
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <main className="page">
      <section className="chat">
        <header className="chat-header">
          <div>
            <p className="eyebrow">DeepSeek API</p>
            <h1>Web Assistant</h1>
          </div>
          <span className="status">Online</span>
        </header>

        <section className="messages" aria-live="polite">
          {messages.length === 0 && (
            <div className="empty-state">
              <h2>Чем помочь?</h2>
              <p>Напишите вопрос, идею или задачу. Ответ появится прямо в этом чате.</p>
            </div>
          )}

          {messages.map((message) => (
            <article key={message.id} className={`message ${message.role}`}>
              <div className="avatar">{message.role === 'user' ? 'Вы' : 'AI'}</div>
              <div className="bubble">{message.content}</div>
            </article>
          ))}

          {isLoading && (
            <article className="message assistant">
              <div className="avatar">AI</div>
              <div className="bubble muted">Печатает...</div>
            </article>
          )}

          {error && <p className="error">{error}</p>}
        </section>

        <form onSubmit={handleSubmit} className="composer">
          <textarea
            id="prompt"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="Спросите что-нибудь..."
            rows={2}
          />

          <button type="submit" disabled={isLoading}>
            {isLoading ? '...' : 'Отправить'}
          </button>
        </form>
      </section>
    </main>
  );
}
