import OpenAI from 'openai';
import { isDatabaseConfigured, isSchemaMissingError } from './_lib/db.js';
import { listProjects } from './_lib/project-store.js';
import {
  buildChatContext,
  buildSystemPrompt,
  buildUserPrompt,
  getChatRouteConfig,
  getProjectQueryOptions,
  sanitizeChatMessages,
  sanitizeQuestion,
} from './_lib/chatbot.js';

const getModel = () => String(process.env.OPENAI_MODEL || 'gpt-4o-mini').trim();
const getClient = () => {
  const apiKey = String(process.env.OPENAI_API_KEY || '').trim();
  if (!apiKey) return null;
  const baseURL = String(process.env.OPENAI_BASE_URL || '').trim();
  return new OpenAI({
    apiKey,
    ...(baseURL ? { baseURL } : {}),
  });
};

const jsonError = (res, status, errorCode, message, extra = {}) => res.status(status).json({
  ok: false,
  errorCode,
  message,
  ...extra,
});

export default async function handler(req, res) {
  if (req.method && req.method !== 'POST') {
    return jsonError(res, 405, 'method_not_allowed', 'Method not allowed');
  }

  const question = sanitizeQuestion(req.body?.question);
  const routeConfig = getChatRouteConfig(req.body?.routeKey);
  const history = sanitizeChatMessages(req.body?.messages);

  if (!question) {
    return jsonError(res, 400, 'invalid_request', 'A non-empty question is required.');
  }

  if (!routeConfig) {
    return jsonError(res, 400, 'invalid_route', 'An unsupported dashboard route was provided.');
  }

  if (!isDatabaseConfigured()) {
    return jsonError(
      res,
      503,
      'database_not_configured',
      'The chatbot is not available because DATABASE_URL is not configured on the server.',
      { configured: false }
    );
  }

  const client = getClient();
  if (!client) {
    return jsonError(
      res,
      503,
      'llm_not_configured',
      'The chatbot is not available because OPENAI_API_KEY is not configured on the server.',
      { configured: false }
    );
  }

  try {
    const projects = await listProjects(getProjectQueryOptions(routeConfig));

    if (!Array.isArray(projects) || projects.length === 0) {
      return res.status(200).json({
        ok: true,
        configured: true,
        routeKey: routeConfig.routeKey,
        dataAvailable: false,
        answer: `I couldn't find any database-backed records for the ${routeConfig.title} scope right now.`,
        contextSummary: {
          totalProjects: 0,
        },
      });
    }

    const chatContext = buildChatContext({ routeConfig, projects, question });
    const response = await client.chat.completions.create({
      model: getModel(),
      temperature: 0.2,
      max_tokens: 700,
      messages: [
        { role: 'system', content: buildSystemPrompt(chatContext) },
        ...history,
        { role: 'user', content: buildUserPrompt({ question, context: chatContext }) },
      ],
    });

    const answer = response.choices?.[0]?.message?.content?.trim();
    if (!answer) {
      return jsonError(res, 502, 'llm_empty_response', 'The language model returned an empty response.');
    }

    return res.status(200).json({
      ok: true,
      configured: true,
      routeKey: routeConfig.routeKey,
      dataAvailable: true,
      answer,
      model: getModel(),
      contextSummary: chatContext.summary,
    });
  } catch (error) {
    if (isSchemaMissingError(error)) {
      return jsonError(
        res,
        503,
        'database_schema_missing',
        'The chatbot database schema is not ready yet. Run the project import/migration before using chat.',
        { configured: false }
      );
    }

    console.error('api/chat error:', error);
    return jsonError(
      res,
      500,
      'chat_failed',
      error instanceof Error ? error.message : 'Chat request failed.'
    );
  }
}
