import React, { useState, useRef, useEffect } from 'react';
import { OpenAI } from 'openai';
import { loadCSVFromRepo, formatCSVForPrompt, getCSVSummary } from '../utils/csvLoader';
import '../styles/DataChatbot.css';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

interface DataChatbotProps {
  csvFiles: string[];
  title?: string;
  systemPrompt?: string;
}

export const DataChatbot: React.FC<DataChatbotProps> = ({
  csvFiles,
  title = 'Data Insights Assistant',
  systemPrompt,
}) => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [allData, setAllData] = useState<{ [key: string]: any[] }>({});
  const [csvLoaded, setCSVLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadedFiles, setLoadedFiles] = useState<string[]>([]);
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

  // Load all CSV files
  useEffect(() => {
    const loadData = async () => {
      try {
        setError(null);
        const dataMap: { [key: string]: any[] } = {};
        const successful: string[] = [];

        for (const file of csvFiles) {
          try {
            const data = await loadCSVFromRepo(file);
            if (data && data.length > 0) {
              dataMap[file] = data;
              successful.push(file);
            }
          } catch (err) {
            console.error(`Failed to load ${file}:`, err);
            // Continue loading other files even if one fails
          }
        }

        if (successful.length === 0) {
          setError(`Could not load any CSV files. Attempted: ${csvFiles.join(', ')}`);
          setCSVLoaded(false);
        } else {
          setAllData(dataMap);
          setLoadedFiles(successful);
          setCSVLoaded(true);

          if (successful.length < csvFiles.length) {
            const failed = csvFiles.filter((f) => !successful.includes(f));
            setError(
              `Loaded ${successful.length}/${csvFiles.length} files. Failed: ${failed.join(', ')}`
            );
          }
        }
      } catch (err) {
        setError(`Error loading CSVs: ${err instanceof Error ? err.message : 'Unknown error'}`);
        setCSVLoaded(false);
      }
    };
    loadData();
  }, [csvFiles]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  /**
   * Format all loaded CSV data into a single context string for the LLM
   */
  const formatAllDataForPrompt = (): string => {
    if (Object.keys(allData).length === 0) return 'No data available.';

    let combined = '\n=== DATASETS ===\n';

    for (const [filename, data] of Object.entries(allData)) {
      combined += `\n--- Dataset: ${filename} ---\n`;
      combined += `Total rows: ${data.length}\n`;
      combined += `Columns: ${Object.keys(data[0]).join(', ')}\n`;
      combined += `Sample (first 3 rows):\n${JSON.stringify(data.slice(0, 3), null, 2)}\n`;
    }

    combined +=
      '\n\nYou have access to the full datasets above. Use them to answer questions and provide cross-dataset insights.';
    return combined;
  };

  /**
   * Get summary of all loaded datasets
   */
  const getAllDataSummary = (): string => {
    if (Object.keys(allData).length === 0) return 'No data loaded';

    const summaries = Object.entries(allData).map(
      ([filename, data]) =>
        `${filename}: ${data.length} rows, ${Object.keys(data[0]).length} columns`
    );

    return summaries.join(' | ');
  };

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
      // Format all CSV data for context
      const allDataContext = formatAllDataForPrompt();
      const dataSummary = getAllDataSummary();

      // Build system prompt
      const defaultSystemPrompt = `You are a data insights assistant for a dashboard with multiple interconnected datasets.

Available Datasets:
${dataSummary}

${allDataContext}

Guidelines:
- Provide specific insights based on the data provided
- When possible, draw correlations and insights across multiple datasets
- Be concise and actionable
- When making calculations or references, cite specific data points and which dataset they come from
- If you don't have enough data to answer a question, say so clearly
- Ask clarifying questions if needed
- Identify patterns, trends, and anomalies in the data`;

      const finalSystemPrompt = systemPrompt || defaultSystemPrompt;

      // Call OpenAI with all CSV contexts
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
        max_tokens: 800,
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
        <div className="chatbot-loading">Loading {csvFiles.length} dataset(s)...</div>
      </div>
    );
  }

  return (
    <div className="chatbot-container">
      <div className="chatbot-header">
        <h2>{title}</h2>
        {csvLoaded && (
          <span className="data-status">✓ {loadedFiles.length} dataset(s) loaded</span>
        )}
      </div>

      {error && (
        <div className="chatbot-error">
          <strong>⚠️ Warning:</strong> {error}
        </div>
      )}

      {/* Chat Messages */}
      <div className="chatbot-messages">
        {messages.length === 0 && csvLoaded && (
          /*
          <div className="chatbot-welcome">
            <p>👋 Welcome! I can analyze data across {loadedFiles.length} datasets.</p>
            <p>Loaded datasets: {loadedFiles.join(', ')}</p>
            <p>Try asking questions like:</p>
            <ul>
              <li>"What patterns do you see across all datasets?"</li>
              <li>"Compare [column] from [dataset1] with [dataset2]"</li>
              <li>"What are the key insights across all data?"</li>
              <li>"Which dataset has the highest [metric]?"</li>
            </ul>
          </div>
          */
          <div className="chatbot-welcome">
            <p>👋 Welcome! I can analyze data across {loadedFiles.length} datasets.</p>
            <p>Loaded datasets: {loadedFiles.join(', ')}</p>
            <p>This feature is currently inactive!</p>
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
          placeholder={
            csvLoaded ? 'Ask questions about your data...' : 'Waiting for data...'
          }
          disabled={loading || !csvLoaded}
          className="chatbot-input"
        />
        <button type="submit" disabled={loading || !csvLoaded} className="chatbot-send-btn">
          {loading ? '⏳' : '📤'}
        </button>
      </form>
    </div>
  );
};

export default DataChatbot;
