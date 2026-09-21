import React, { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import '../styles/DataChatbot.css';

type RouteKey = 'global' | 'wa' | 'syria';

type Message = {
  role: 'user' | 'assistant';
  content: string;
};

type ChatResponse = {
  ok?: boolean;
  message?: string;
  answer?: string;
  dataAvailable?: boolean;
  contextSummary?: {
    totalProjects?: number;
  };
};

interface DataChatbotProps {
  routeKey: RouteKey;
  title?: string;
}

const MAX_HISTORY_MESSAGES = 8;
const getApiBaseUrl = () => String(import.meta.env.VITE_API_BASE_URL || '').trim().replace(/\/+$/, '');

const welcomeExamples: Record<RouteKey, string[]> = {
  global: [
    'Which countries or regions appear most often in this dashboard?',
    'What goals show up most frequently in the visible projects?',
    'What recent themes stand out across the global projects?',
  ],
  wa: [
    'What data is currently available for this dashboard?',
    'Are there any database-backed records for this route yet?',
    'What should I ask once this dashboard data is available in the external database?',
  ],
  syria: [
    'What patterns stand out across the Syria projects?',
    'Which goals or categories appear most often in the Syria scope?',
    'What recent Syria projects should I look at first?',
  ],
};

const routeNotes: Record<RouteKey, string> = {
  global: 'Ask about the DB-backed projects visible on the main dashboard.',
  wa: 'This assistant only uses database-backed data. If this route has not been migrated yet, it may report that no records are available.',
  syria: 'Ask about the DB-backed projects visible on the Syria dashboard.',
};

export const DataChatbot: React.FC<DataChatbotProps> = ({ routeKey, title = 'Data Insights Assistant' }) => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dataStatus, setDataStatus] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const examples = useMemo(() => welcomeExamples[routeKey], [routeKey]);
  const routeNote = useMemo(() => routeNotes[routeKey], [routeKey]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    if (messages.length > 0) {
      scrollToBottom();
    }
  }, [messages, loading]);

  useEffect(() => {
    setMessages([]);
    setInput('');
    setError(null);
    setDataStatus(null);
  }, [routeKey]);

  const handleSendMessage = async (event: React.FormEvent) => {
    event.preventDefault();
    const question = input.trim();
    if (!question || loading) return;

    const history = messages.slice(-MAX_HISTORY_MESSAGES);
    const userMessage: Message = { role: 'user', content: question };
    setMessages((prev) => [...prev, userMessage]);
    setInput('');
    setLoading(true);
    setError(null);

    try {
      const response = await fetch(`${getApiBaseUrl()}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          routeKey,
          question,
          messages: history,
        }),
      });

      let payload: ChatResponse | null = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }

      if (!response.ok || !payload?.ok || !payload.answer) {
        const message = payload?.message
          || (response.status === 404
            ? 'The chat API endpoint is unavailable. Configure VITE_API_BASE_URL to a deployed API server.'
            : `The chatbot request failed with status ${response.status}.`);
        setError(message);
        setMessages((prev) => [
          ...prev,
          { role: 'assistant', content: `Sorry, I hit a server error: ${message}` },
        ]);
        return;
      }

      const totalProjects = payload.contextSummary?.totalProjects;
      if (payload.dataAvailable === false) {
        setDataStatus('No DB-backed records are currently available for this route.');
      } else if (typeof totalProjects === 'number') {
        setDataStatus(`DB-backed scope: ${totalProjects} project${totalProjects === 1 ? '' : 's'}`);
      } else {
        setDataStatus('Connected to the DB-backed chat scope.');
      }

      setMessages((prev) => [...prev, { role: 'assistant', content: payload.answer || 'No response generated.' }]);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      setError(message);
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: `Sorry, I couldn\'t reach the chat service: ${message}` },
      ]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="chatbot-container">
      <div className="chatbot-header">
        <h2>{title}</h2>
        {dataStatus && <span className="data-status">{dataStatus}</span>}
      </div>

      {error && (
        <div className="chatbot-error">
          <strong>⚠️ Chat issue:</strong> {error}
        </div>
      )}

      <div className="chatbot-messages">
        {messages.length === 0 && (
          <div className="chatbot-welcome">
            <p>What would you like to discover?</p>
            <p>
              Ask about project locations, common goals, organizations, categories,
              or recent activity across the {title} dashboard.
            </p>
          </div>
        )}

        {messages.map((message, index) => (
          <div
            key={`${message.role}-${index}`}
            className={`chatbot-message ${message.role === 'user' ? 'user' : 'assistant'}`}
          >
            <div className="message-content">
              {message.role === 'assistant' ? (
                <ReactMarkdown
                  components={{
                    a: ({ children, href }) => (
                      <a
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="markdown-link"
                      >
                        {children}
                      </a>
                    ),
                  }}
                >
                  {message.content}
                </ReactMarkdown>
              ) : (
                message.content
              )}
            </div>
          </div>
        ))}

        {loading && (
          <div className="chatbot-message assistant">
            <div className="message-content">
              <div className="typing-indicator">
                <span></span>
                <span></span>
                <span></span>
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      <form onSubmit={handleSendMessage} className="chatbot-input-form">
        <input
          type="text"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="Ask questions about this dashboard's DB-backed data..."
          disabled={loading}
          className="chatbot-input"
          maxLength={600}
        />
        <button type="submit" disabled={loading || !input.trim()} className="chatbot-send-btn">
          {loading ? '⏳' : '📤'}
        </button>
      </form>
    </div>
  );
};

export default DataChatbot;
