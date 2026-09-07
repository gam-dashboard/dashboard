import React, { useState, useRef, useEffect } from 'react';
import { OpenAI } from 'openai';
import { loadCSVFromRepo, formatCSVForPrompt, getCSVSummary } from '../utils/csvLoader';
import '../styles/DataChatbot.css';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

interface DataChatbotProps {
  csvFile: string;
  title?: string;
  systemPrompt?: string;
}

export const DataChatbot: React.FC<DataChatbotProps> = ({
  csvFile,
  title = 'Data Insights Assistant',
  systemPrompt,
}) => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [csvData, setCSVData] = useState<any[]>([]);
  const [csvLoaded, setCSVLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const clientRef = useRef<OpenAI | null>(null);

  // Initialize OpenAI client
  useEffect(() => {
    const apiKey = import.meta.env.VITE_OPENAI_API_KEY;
    if (!apiKey) {
      setError('OpenAI API key not configured. Please set VITE_OPENAI_API_KEY.');
      return;
    }

    clientRef.current = new OpenAI({
      apiKey,
      dangerouslyAllowBrowser: true, // ⚠️ For demo only; use backend proxy in production
    });
  }, []);

  // Load CSV on component mount or when csvFile changes
  useEffect(() => {
    const loadData = async () => {
      try {
        setError(null);
        const data = await loadCSVFromRepo(csvFile);
        if (data.length === 0) {
          setError(`Could not load CSV file: ${csvFile}`);
        } else {
          setCSVData(data);
          setCSVLoaded(true);
        }
      } catch (err) {
        setError(`Error loading CSV: ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
    };
    loadData();
  }, [csvFile]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || loading || !csvLoaded || !clientRef.current) return;

    // Add user message
    const userMessage: Message = { role: 'user', content: input };
    setMessages((prev) => [...prev, userMessage]);
    setInput('');
    setLoading(true);
    setError(null);

    try {
      // Format CSV data for context
      const csvContext = formatCSVForPrompt(csvData);
      const csvSummary = getCSVSummary(csvData);

      // Build system prompt
      const defaultSystemPrompt = `You are a data insights assistant for a dashboard. You help users understand and analyze their data.

Dataset Information:
${csvSummary}

${csvContext}

Guidelines:
- Provide specific insights based on the data provided
- Be concise and actionable
- When making calculations or references, cite specific data points
- If you don't have enough data to answer a question, say so clearly
- Ask clarifying questions if needed`;

      const finalSystemPrompt = systemPrompt || defaultSystemPrompt;

      // Call OpenAI with CSV context
      const response = await clientRef.current.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: finalSystemPrompt,
          },
          ...messages,
          userMessage,
        ],
        temperature: 0.7,
        max_tokens: 500,
      });

      const assistantMessage: Message = {
        role: 'assistant',
        content: response.choices[0].message.content || 'No response generated',
      };
      setMessages((prev) => [...prev, assistantMessage]);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      console.error('Error calling OpenAI:', err);
      setError(`Error: ${errorMsg}`);
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: `Sorry, I encountered an error: ${errorMsg}`,
        },
      ]);
    } finally {
      setLoading(false);
    }
  };

  if (!csvLoaded && !error) {
    return (
      <div className="chatbot-container">
        <div className="chatbot-header">
          <h2>{title}</h2>
        </div>
        <div className="chatbot-loading">Loading data...</div>
      </div>
    );
  }

  return (
    <div className="chatbot-container">
      <div className="chatbot-header">
        <h2>{title}</h2>
        {csvLoaded && <span className="data-status">✓ Data loaded</span>}
      </div>

      {error && (
        <div className="chatbot-error">
          <strong>Error:</strong> {error}
        </div>
      )}

      {/* Chat Messages */}
      <div className="chatbot-messages">
        {messages.length === 0 && csvLoaded && (
          <div className="chatbot-welcome">
            <p>👋 Welcome! I can help you analyze the loaded data.</p>
            <p>Try asking questions like:</p>
            <ul>
              <li>"What are the main trends in this data?"</li>
              <li>"What is the highest value and where does it occur?"</li>
              <li>"Summarize the key insights"</li>
            </ul>
          </div>
        )}

        {messages.map((msg, idx) => (
          <div
            key={idx}
            className={`chatbot-message ${msg.role === 'user' ? 'user' : 'assistant'}`}
          >
            <div className="message-content">{msg.content}</div>
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

      {/* Input Area */}
      <form onSubmit={handleSendMessage} className="chatbot-input-form">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={csvLoaded ? 'Ask me about your data...' : 'Waiting for data...'}
          disabled={loading || !csvLoaded}
          className="chatbot-input"
        />
        <button
          type="submit"
          disabled={loading || !csvLoaded}
          className="chatbot-send-btn"
        >
          {loading ? '⏳' : '📤'}
        </button>
      </form>
    </div>
  );
};

export default DataChatbot;
