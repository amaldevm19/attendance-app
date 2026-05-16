/**
 * attendance-api/src/routes/aiRoutes.js
 *
 * AI Assistant routes — provider management, Ollama discovery, chat with
 * streaming (SSE) and tool call loop.
 *
 * Mount in server.js:
 *   import aiRoutes from './routes/aiRoutes.js';
 *   app.use('/api/ai', aiRoutes);
 *
 * Endpoints:
 *   GET    /api/ai/providers                — list providers (no keys returned)
 *   PUT    /api/ai/providers/:key           — save key + settings
 *   DELETE /api/ai/providers/:key/key       — clear stored key
 *   GET    /api/ai/ollama/models?url=...    — list pulled Ollama models
 *   GET    /api/ai/sessions?admin_emp_id=   — session list for sidebar
 *   POST   /api/ai/sessions                 — create new session
 *   DELETE /api/ai/sessions/:id             — delete session + messages
 *   GET    /api/ai/sessions/:id/messages    — full message history
 *   POST   /api/ai/sessions/:id/chat        — send message → SSE stream
 *
 * SSE event types (POST chat):
 *   token       { text }           — streaming text token
 *   tool_call   { name, input }    — tool being invoked
 *   tool_result { name, result }   — tool result returned to LLM
 *   done        { session_id, title? }
 *   error       { message }
 *
 * Provider SDKs (install only what you use):
 *   npm install @anthropic-ai/sdk openai @google/generative-ai groq-sdk
 * Native fetch is used for Ollama (Node 18+, no extra package needed).
 * OpenRouter uses the OpenAI SDK — no extra install needed if openai is already installed.
 *
 * OpenRouter DB seed (run once):
 *   INSERT INTO ai_providers (provider_key, display_name, base_url, is_enabled)
 *   VALUES ('openrouter', 'OpenRouter', 'https://openrouter.ai/api/v1', FALSE)
 *   ON CONFLICT (provider_key) DO NOTHING;
 */

import { Router }              from 'express';
import pool                    from '../config/db.js';
import { encrypt, decrypt, decryptOrNull, isEncrypted } from '../utils/encryption.js';

const router = Router();

// ---------------------------------------------------------------------------
// SDK imports — each wrapped so server starts even if SDK not yet installed.
// The chat route returns a clear error message if a missing SDK is called.
// ---------------------------------------------------------------------------

let Anthropic            = null;
let OpenAI               = null;
let GoogleGenerativeAI   = null;
let Groq                 = null;

try { ({ default: Anthropic }          = await import('@anthropic-ai/sdk'));           } catch { /**/ }
try { ({ default: OpenAI }             = await import('openai'));                      } catch { /**/ }
try { ({ GoogleGenerativeAI }          = await import('@google/generative-ai'));       } catch { /**/ }
try { ({ default: Groq }               = await import('groq-sdk'));                   } catch { /**/ }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sendError = (res, status, message) => res.status(status).json({ error: message });

/** Write one SSE event */
function sseWrite(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** Auto-title from first message */
function makeTitle(text, max = 120) {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

// ---------------------------------------------------------------------------
// Tool definitions (Anthropic schema — converted for other providers below)
// ---------------------------------------------------------------------------

const TOOL_DEFINITIONS = [
  {
    name: 'query_products',
    description:
      'Search the BTD product database. Always call this before insert_product ' +
      'to check for duplicates. Also use to answer questions about the catalog.',
    input_schema: {
      type: 'object',
      properties: {
        search:         { type: 'string', description: 'Free-text across manufacturer, brand, model' },
        manufacturer:   { type: 'string', description: 'Filter by exact manufacturer e.g. "Hikvision"' }, // ← ADD
        system_name:    { type: 'string', description: 'Filter by system e.g. "CCTV"' },
        portfolio_name: { type: 'string', description: 'Filter by portfolio e.g. "ELV"' },
        limit:          { type: 'integer', description: 'Max results (default 20, max 100)' },
      },
      required: [],
    },
  },
  {
    name: 'insert_product',
    description:
      'Insert a single product. Call query_products first to avoid duplicates. ' +
      'After inserting, always call record_price.',
    input_schema: {
      type: 'object',
      properties: {
        manufacturer:   { type: 'string', description: 'e.g. "Hikvision"' },
        brand:          { type: 'string', description: 'Brand if different from manufacturer' },
        model:          { type: 'string', description: 'Model number e.g. "DS-2CD2143G2-I"' },
        description:    { type: 'string', description: 'Short product description' },
        system_name:    { type: 'string', description: 'System to link to e.g. "CCTV"' },
        portfolio_name: { type: 'string', description: 'Portfolio e.g. "ELV"' },
        image_url:      { type: 'string', description: 'Product image URL' },
        source_url:     { type: 'string', description: 'Product page URL used as reference' },
        specs:          { type: 'object', description: 'Key-value specs e.g. {"resolution":"4MP"}' },
      },
      required: ['manufacturer', 'model'],
    },
  },
  {
    name: 'record_price',
    description: 'Save a price data point. Call after every insert_product, and to refresh prices for existing products.',
    input_schema: {
      type: 'object',
      properties: {
        product_id:    { type: 'integer', description: 'From insert_product or query_products' },
        model:         { type: 'string',  description: 'Model name to resolve product_id if unknown' },
        lowest_price:  { type: 'number',  description: 'Lowest price found (AED)' },
        average_price: { type: 'number',  description: 'Average market price (AED)' },
        currency:      { type: 'string',  description: 'Currency code, default AED' },
        source_notes:  { type: 'string',  description: 'Sources e.g. "noon.com · tradeling.com"' },
      },
      required: [],
    },
  },
  {
    name: 'get_price_history',
    description: 'Get historical price records for a product (trend analysis).',
    input_schema: {
      type: 'object',
      properties: {
        product_id: { type: 'integer', description: 'Product ID' },
        model:      { type: 'string',  description: 'Model name to resolve product_id' },
        limit:      { type: 'integer', description: 'Records to return (default 10, max 50)' },
      },
      required: [],
    },
  },
];

/** Convert Anthropic tool defs → OpenAI / Groq function-calling format */
function toOpenAITools(defs) {
  return defs.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}

/** Convert Anthropic tool defs → Gemini function declarations */
function toGeminiTools(defs) {
  return [{ functionDeclarations: defs.map(t => ({ name: t.name, description: t.description, parameters: t.input_schema })) }];
}

// ---------------------------------------------------------------------------
// Tool executor
// ---------------------------------------------------------------------------

async function executeTool(toolName, toolInput) {
  switch (toolName) {

    case 'query_products': {
      const { search, manufacturer, system_name, portfolio_name, limit = 20 } = toolInput;
      let q = `
        SELECT p.id, p.manufacturer, p.brand, p.model, p.description,
               p.image_url, p.source_url,
               s.name AS system_name, po.name AS portfolio_name,
               pp.lowest_price, pp.average_price, pp.currency, pp.created_at AS price_as_of
        FROM products p
        LEFT JOIN systems   s  ON p.system_id    = s.id
        LEFT JOIN portfolios po ON s.portfolio_id = po.id
        LEFT JOIN product_price_current pp ON pp.product_id = p.id
        WHERE 1=1
      `;
      const params = [];
      if (search) {
        params.push(`%${search}%`);
        q += ` AND (p.manufacturer ILIKE $${params.length} OR p.brand ILIKE $${params.length} OR p.model ILIKE $${params.length})`;
      }
      if (system_name)    { params.push(`%${system_name}%`);    q += ` AND s.name ILIKE $${params.length}`; }
      if (portfolio_name) { params.push(`%${portfolio_name}%`); q += ` AND po.name ILIKE $${params.length}`; }
      if (manufacturer) { 
        params.push(`%${manufacturer}%`); 
        q += ` AND p.manufacturer ILIKE $${params.length}`; 
      }
      params.push(Math.min(Number(limit) || 20, 100));
      q += ` ORDER BY p.manufacturer, p.model LIMIT $${params.length}`;
      const r = await pool.query(q, params);
      return JSON.stringify({ count: r.rows.length, products: r.rows });
    }

    case 'insert_product': {
      const { manufacturer, brand, model, description, system_name, portfolio_name, image_url, source_url, specs } = toolInput;
      if (!manufacturer || !model) return JSON.stringify({ error: 'manufacturer and model are required.' });
      let system_id = null;
      if (system_name) {
        const sr = await pool.query(
          `SELECT s.id FROM systems s LEFT JOIN portfolios po ON s.portfolio_id = po.id
           WHERE s.name ILIKE $1 ${portfolio_name ? 'AND po.name ILIKE $2' : ''} LIMIT 1`,
          portfolio_name ? [`%${system_name}%`, `%${portfolio_name}%`] : [`%${system_name}%`]
        );
        if (sr.rows.length) system_id = sr.rows[0].id;
      }
      const ir = await pool.query(
        `INSERT INTO products (system_id, manufacturer, brand, model, description, image_url, source_url, specs)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING id`,
        [system_id, manufacturer, brand || manufacturer, model, description || null,
         image_url || null, source_url || null, specs ? JSON.stringify(specs) : null]
      );
      if (!ir.rows.length) return JSON.stringify({ skipped: true, reason: 'Possible duplicate.' });
      return JSON.stringify({ inserted: true, product_id: ir.rows[0].id });
    }

    case 'record_price': {
      let { product_id, model, lowest_price, average_price, currency = 'AED', source = 'ai_search', source_notes, fetched_by } = toolInput;
      if (!product_id && model) {
        const pr = await pool.query('SELECT id FROM products WHERE model ILIKE $1 LIMIT 1', [`%${model}%`]);
        if (pr.rows.length) product_id = pr.rows[0].id;
      }
      if (!product_id) return JSON.stringify({ error: 'Could not resolve product_id.' });
      await pool.query(
        `INSERT INTO product_prices (product_id, lowest_price, average_price, currency, source, source_notes, fetched_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [product_id, lowest_price || null, average_price || null, currency, source, source_notes || null, fetched_by || null]
      );
      return JSON.stringify({ recorded: true, product_id });
    }

    case 'get_price_history': {
      let { product_id, model, limit = 10 } = toolInput;
      if (!product_id && model) {
        const pr = await pool.query('SELECT id FROM products WHERE model ILIKE $1 LIMIT 1', [`%${model}%`]);
        if (pr.rows.length) product_id = pr.rows[0].id;
      }
      if (!product_id) return JSON.stringify({ error: 'Could not resolve product_id.' });
      const h = await pool.query(
        `SELECT lowest_price, average_price, currency, source, source_notes, created_at
         FROM product_prices WHERE product_id = $1 ORDER BY id DESC LIMIT $2`,
        [product_id, Math.min(Number(limit) || 10, 50)]
      );
      return JSON.stringify({ product_id, history: h.rows });
    }

    default:
      return JSON.stringify({ error: `Unknown tool: ${toolName}` });
  }
}

// ---------------------------------------------------------------------------
// Context builder — DB rows → LLM messages array
// ---------------------------------------------------------------------------

function buildMessages(dbRows, newUserMessage) {
  const messages = [];
  for (const row of dbRows) {
    switch (row.role) {
      case 'user':
        messages.push({ role: 'user', content: row.content });
        break;
      case 'assistant':
        messages.push({ role: 'assistant', content: row.content });
        break;
      case 'tool_use':
        messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: row.tool_use_id, name: row.tool_name, input: row.tool_input }] });
        break;
      case 'tool_result':
        messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: row.tool_use_id, content: row.content }] });
        break;
    }
  }
  messages.push({ role: 'user', content: newUserMessage });
  return messages;
}

// ---------------------------------------------------------------------------
// System prompt (shared across providers)
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT =
  'You are the BTD AI Assistant for Scientechnic LLC, UAE — a building technologies System Integrator. ' +
  'You help admins manage the product database, find UAE market prices, and answer questions about products and pricing. ' +
  'When asked to find and add products: ' +
  '1. FIRST use the web_search tool to search the internet for real product information and UAE market prices. ' +
  '2. Then call query_products to check if the product already exists in the database. ' +
  '3. If not found, call insert_product to add it. ' +
  '4. Always call record_price immediately after insert_product. ' +
  'When checking for duplicate products, always pass both the manufacturer ' +
  'name AND system_name to query_products — never search by system_name alone. ' +
  'Never loop query_products more than once for the same search. ' +
  'If query_products returns count 0, proceed to insert — do not call it again. ' +
  'Be concise. Default currency is AED. If prices are unavailable, estimate from known UAE market data.';

// ---------------------------------------------------------------------------
// LLM caller — streams via SSE, handles tool call loop
// ---------------------------------------------------------------------------

async function callLLM({ providerKey, model, apiKey, baseUrl, messages, supportsTools = true, res, sessionId, adminEmpId }) {
  let loopMessages = [...messages];
  const MAX_ROUNDS = 20; // enough for web_search + multiple inserts

  // Track last tool call signature to detect infinite loops
  // If same tool+args called 3 times in a row → break
  let lastToolSig  = null;
  let repeatCount  = 0;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    let assistantText = '';
    let toolCalls     = []; // { id, name, input }

    // ── ANTHROPIC ────────────────────────────────────────────────────────────
    if (providerKey === 'anthropic') {
      if (!Anthropic) throw new Error('Anthropic SDK not installed. Run: npm install @anthropic-ai/sdk');

      const client = new Anthropic({ apiKey });
      const stream = client.messages.stream({
        model, max_tokens: 4096, system: SYSTEM_PROMPT,
        ...(supportsTools ? { tools: TOOL_DEFINITIONS } : {}),
        messages: loopMessages,
      });

      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          assistantText += event.delta.text;
          sseWrite(res, 'token', { text: event.delta.text });
        }
      }

      const final = await stream.finalMessage();
      if (supportsTools) {
        for (const block of final.content) {
          if (block.type === 'tool_use') toolCalls.push({ id: block.id, name: block.name, input: block.input });
        }
      }

      if (assistantText) {
        await pool.query(
          `INSERT INTO ai_chat_messages (session_id, role, content) VALUES ($1, 'assistant', $2)`,
          [sessionId, assistantText]
        );
      }
    }

    // ── OPENAI / GROQ / OPENROUTER ───────────────────────────────────────────
    // OpenRouter is fully OpenAI-SDK compatible — same streaming format, same
    // tool calling schema. Only difference: baseURL points to openrouter.ai,
    // we add HTTP-Referer + X-Title headers, and we include the
    // openrouter:web_search server tool so the model can search the web.
    else if (providerKey === 'openai' || providerKey === 'groq' || providerKey === 'openrouter') {
      const SdkClass = providerKey === 'groq' ? Groq : OpenAI;
      if (!SdkClass) throw new Error(`${providerKey} SDK not installed. Run: npm install ${providerKey === 'groq' ? 'groq-sdk' : 'openai'}`);

      const defaultHeaders = providerKey === 'openrouter' ? {
        'HTTP-Referer': 'https://btdadmin.technodevenv.dpdns.org',
        'X-Title':      'BTD Attendance App',
      } : {};

      const client  = new SdkClass({
        apiKey,
        ...(baseUrl ? { baseURL: baseUrl } : {}),
        defaultHeaders,
      });
      const oaiMsgs = [{ role: 'system', content: SYSTEM_PROMPT }, ...loopMessages];

      // Build tools array:
      // - For OpenRouter: add web_search server tool first so model can search
      //   the internet, then our DB tools. Web search costs ~$0.02 per request.
      // - For OpenAI/Groq: only our DB tools.
      const toolsArray = supportsTools ? [
        ...(providerKey === 'openrouter' ? [{ type: 'openrouter:web_search' }] : []),
        ...toOpenAITools(TOOL_DEFINITIONS),
      ] : [];

      const stream  = await client.chat.completions.create({
        model,
        messages: oaiMsgs,
        ...(supportsTools ? { tools: toolsArray, tool_choice: 'auto' } : {}),
        stream: true,
      });

      const tcAccum = {};
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;
        if (delta.content) { assistantText += delta.content; sseWrite(res, 'token', { text: delta.content }); }
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (!tcAccum[tc.index]) tcAccum[tc.index] = { id: tc.id || '', name: tc.function?.name || '', args: '' };
            if (tc.id)                     tcAccum[tc.index].id   = tc.id;
            if (tc.function?.name)         tcAccum[tc.index].name = tc.function.name;
            if (tc.function?.arguments)    tcAccum[tc.index].args += tc.function.arguments;
          }
        }
      }
      for (const tc of Object.values(tcAccum)) {
        try { toolCalls.push({ id: tc.id, name: tc.name, input: JSON.parse(tc.args || '{}') }); }
        catch { toolCalls.push({ id: tc.id, name: tc.name, input: {} }); }
      }

      if (assistantText) await pool.query(
        `INSERT INTO ai_chat_messages (session_id, role, content) VALUES ($1, 'assistant', $2)`,
        [sessionId, assistantText]
      );
    }

    // ── OLLAMA ───────────────────────────────────────────────────────────────
    else if (providerKey === 'ollama') {
      const base    = baseUrl || 'http://localhost:11434';
      const olaMsgs = [{ role: 'system', content: SYSTEM_PROMPT }, ...loopMessages];

      const response = await fetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: olaMsgs,
          ...(supportsTools ? { tools: toOpenAITools(TOOL_DEFINITIONS) } : {}),
          stream: true,
        }),
        signal: AbortSignal.timeout(60_000),
      });

      if (!response.ok) throw new Error(`Ollama ${response.status}: ${await response.text()}`);

      const tcAccum = {};
      let   buffer  = '';

      for await (const chunk of response.body) {
        buffer += Buffer.from(chunk).toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const obj   = JSON.parse(line);
            const delta = obj.message;
            if (!delta) continue;
            if (delta.content) { assistantText += delta.content; sseWrite(res, 'token', { text: delta.content }); }
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const i = tc.index ?? 0;
                if (!tcAccum[i]) tcAccum[i] = { id: tc.id || `tc_${i}`, name: tc.function?.name || '', args: '' };
                if (tc.function?.arguments) tcAccum[i].args += tc.function.arguments;
              }
            }
          } catch { /* skip malformed lines */ }
        }
      }
      for (const tc of Object.values(tcAccum)) {
        try { toolCalls.push({ id: tc.id, name: tc.name, input: JSON.parse(tc.args || '{}') }); }
        catch { toolCalls.push({ id: tc.id, name: tc.name, input: {} }); }
      }

      if (assistantText) await pool.query(
        `INSERT INTO ai_chat_messages (session_id, role, content) VALUES ($1, 'assistant', $2)`,
        [sessionId, assistantText]
      );
    }

    // ── GOOGLE GEMINI ────────────────────────────────────────────────────────
    else if (providerKey === 'google') {
      if (!GoogleGenerativeAI) throw new Error('Google AI SDK not installed. Run: npm install @google/generative-ai');

      const genAI     = new GoogleGenerativeAI(apiKey);
      const gemModel  = genAI.getGenerativeModel({
        model,
        ...(supportsTools ? { tools: toGeminiTools(TOOL_DEFINITIONS) } : {}),
        systemInstruction: SYSTEM_PROMPT,
      });
      const history   = loopMessages.slice(0, -1).map(m => ({
        role:  m.role === 'user' ? 'user' : 'model',
        parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }],
      }));
      const chat      = gemModel.startChat({ history });
      const lastMsg   = loopMessages.at(-1);
      const result    = await chat.sendMessageStream(
        typeof lastMsg.content === 'string' ? lastMsg.content : JSON.stringify(lastMsg.content)
      );

      for await (const chunk of result.stream) {
        const text  = chunk.text?.();
        if (text) { assistantText += text; sseWrite(res, 'token', { text }); }
        const parts = chunk.candidates?.[0]?.content?.parts?.filter(p => p.functionCall) || [];
        for (const p of parts) {
          toolCalls.push({ id: `gem_${Date.now()}_${Math.random().toString(36).slice(2)}`, name: p.functionCall.name, input: p.functionCall.args || {} });
        }
      }

      if (assistantText) await pool.query(
        `INSERT INTO ai_chat_messages (session_id, role, content) VALUES ($1, 'assistant', $2)`,
        [sessionId, assistantText]
      );
    }

    else {
      throw new Error(`Unsupported provider: ${providerKey}`);
    }

    // ── No tool calls, or tools not supported → done ─────────────────────────
    if (!toolCalls.length || !supportsTools) break;

    // ── Detect infinite loop — same tool+args 3 times in a row → break ───────
    const currentSig = JSON.stringify(toolCalls.map(t => ({ n: t.name, i: t.input })));
    if (currentSig === lastToolSig) {
      repeatCount++;
      if (repeatCount >= 3) {
        sseWrite(res, 'token', { text: '\n\n⚠ Agent loop detected — stopping to prevent infinite repetition.' });
        break;
      }
    } else {
      lastToolSig = currentSig;
      repeatCount = 0;
    }

    // ── Execute tools, save to DB, loop back ─────────────────────────────────
    const toolResultMsgs  = [];
    // Collect tool_use blocks for the assistant message (OpenAI format requires
    // the assistant turn to list ALL tool calls before any tool results follow)
    const assistantToolBlocks = toolCalls.map(tc => ({
      type:      'function',
      id:        tc.id,
      function:  { name: tc.name, arguments: JSON.stringify(tc.input) },
    }));

    // Add assistant turn with all tool calls — required by OpenAI API format
    // so the next round has a valid assistant → tool_result sequence
    if (assistantToolBlocks.length && (providerKey === 'openai' || providerKey === 'groq' || providerKey === 'openrouter')) {
      loopMessages = [...loopMessages, {
        role:       'assistant',
        content:    assistantText || null,
        tool_calls: assistantToolBlocks,
      }];
    }

    for (const tc of toolCalls) {
      // openrouter:web_search / search / web_search are server-side tools
      // executed by OpenRouter before the response arrives. The model already
      // has the search result in its context — we must NOT call executeTool.
      // BUT we DO need to add a tool_result message to keep the history valid,
      // otherwise the next round gets an unmatched tool_use and loops forever.
      if (tc.name === 'openrouter:web_search' || tc.name === 'search' || tc.name === 'web_search') {
        sseWrite(res, 'tool_call', { name: '🌐 web_search', input: tc.input });

        // Save tool_use to DB for history display
        await pool.query(
          `INSERT INTO ai_chat_messages (session_id, role, tool_name, tool_input, tool_use_id)
           VALUES ($1, 'tool_use', $2, $3, $4)`,
          [sessionId, 'web_search', JSON.stringify(tc.input), tc.id]
        );

        // Add synthetic tool_result so message history stays valid
        // OpenRouter already gave the model the real result — this just
        // satisfies the API's requirement for a matching tool_result turn.
        const syntheticResult = JSON.stringify({ status: 'completed', note: 'Web search executed by OpenRouter server-side.' });
        toolResultMsgs.push({
          role:         'tool',
          tool_call_id: tc.id,
          content:      syntheticResult,
        });
        continue;
      }

      sseWrite(res, 'tool_call', { name: tc.name, input: tc.input });

      if (tc.name === 'record_price' && adminEmpId) tc.input.fetched_by = adminEmpId;

      const resultStr = await executeTool(tc.name, tc.input);
      let   resultObj;
      try { resultObj = JSON.parse(resultStr); } catch { resultObj = { raw: resultStr }; }

      sseWrite(res, 'tool_result', { name: tc.name, result: resultObj });

      await pool.query(
        `INSERT INTO ai_chat_messages (session_id, role, tool_name, tool_input, tool_use_id)
         VALUES ($1, 'tool_use', $2, $3, $4)`,
        [sessionId, tc.name, JSON.stringify(tc.input), tc.id]
      );
      await pool.query(
        `INSERT INTO ai_chat_messages (session_id, role, content, tool_use_id)
         VALUES ($1, 'tool_result', $2, $3)`,
        [sessionId, resultStr, tc.id]
      );

      // OpenAI format: tool results use role:'tool' + tool_call_id
      toolResultMsgs.push({
        role:         'tool',
        tool_call_id: tc.id,
        content:      resultStr,
      });
    }

    loopMessages = [...loopMessages, ...toolResultMsgs];
  }
}

// ===========================================================================
// ROUTES
// ===========================================================================

// GET /api/ai/providers
router.get('/providers', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT id, provider_key, display_name, base_url, is_enabled,
             key_updated_at, key_updated_by,
             (api_key_encrypted IS NOT NULL) AS has_key
      FROM ai_providers ORDER BY id
    `);
    res.json(r.rows);
  } catch (e) {
    console.error('[aiRoutes] GET /providers:', e.message);
    sendError(res, 500, 'Failed to load providers.');
  }
});

// PUT /api/ai/providers/:key
router.put('/providers/:key', async (req, res) => {
  const { key }                    = req.params;
  const { api_key, base_url, is_enabled } = req.body;
  const adminEmpId                 = req.body.admin_emp_id || null;

  try {
    const pr = await pool.query('SELECT id, api_key_encrypted FROM ai_providers WHERE provider_key = $1', [key]);
    if (!pr.rows.length) return sendError(res, 404, `Provider '${key}' not found.`);

    let encryptedKey = pr.rows[0].api_key_encrypted;
    let keyUpdatedAt = null;

    if (api_key?.trim()) {
      if (isEncrypted(api_key)) return sendError(res, 400, 'Send the raw API key, not an already-encrypted value.');
      encryptedKey = encrypt(api_key.trim());
      keyUpdatedAt = new Date();
    }

    const sets   = [];
    const params = [];

    params.push(encryptedKey); sets.push(`api_key_encrypted = $${params.length}`);
    params.push(is_enabled ?? false); sets.push(`is_enabled = $${params.length}`);
    if (base_url !== undefined) { params.push(base_url || null); sets.push(`base_url = $${params.length}`); }
    if (keyUpdatedAt)           { params.push(keyUpdatedAt); sets.push(`key_updated_at = $${params.length}`); params.push(adminEmpId); sets.push(`key_updated_by = $${params.length}`); }

    params.push(pr.rows[0].id);
    await pool.query(`UPDATE ai_providers SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    res.json({ saved: true, provider_key: key });
  } catch (e) {
    console.error('[aiRoutes] PUT /providers/:key:', e.message);
    sendError(res, 500, 'Failed to save provider.');
  }
});

// DELETE /api/ai/providers/:key/key
router.delete('/providers/:key/key', async (req, res) => {
  const { key } = req.params;
  try {
    const r = await pool.query(
      `UPDATE ai_providers SET api_key_encrypted = NULL, is_enabled = FALSE,
       key_updated_at = NOW(), key_updated_by = $1 WHERE provider_key = $2`,
      [req.body?.admin_emp_id || null, key]
    );
    if (!r.rowCount) return sendError(res, 404, `Provider '${key}' not found.`);
    res.json({ cleared: true, provider_key: key });
  } catch (e) {
    console.error('[aiRoutes] DELETE /providers/:key/key:', e.message);
    sendError(res, 500, 'Failed to clear key.');
  }
});

// GET /api/ai/ollama/models?url=...
router.get('/ollama/models', async (req, res) => {
  const url = req.query.url || 'http://localhost:11434';
  try {
    const response = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return sendError(res, 502, `Ollama returned ${response.status}.`);
    const data   = await response.json();
    const models = (data.models || []).map(m => ({ name: m.name, size: m.size, modified_at: m.modified_at }));
    res.json({ reachable: true, models });
  } catch (e) {
    if (['AbortError', 'ECONNREFUSED', 'ENOTFOUND'].some(c => e.name === c || e.code === c)) {
      return res.json({ reachable: false, models: [], hint: `Could not reach Ollama at ${url}. Ensure OLLAMA_HOST=0.0.0.0 is set on the Ollama machine.` });
    }
    console.error('[aiRoutes] GET /ollama/models:', e.message);
    sendError(res, 500, 'Ollama model fetch failed.');
  }
});

// GET /api/ai/openrouter/models?filter=all|free|paid&limit=50
// Fetches live model list from OpenRouter public API.
// No auth required for the OpenRouter models endpoint.
// Returns models sorted by: free first, then by context size descending.
// Pricing fields: prompt_price and completion_price in USD per million tokens.
// A price of "0" means the model is free.
router.get('/openrouter/models', async (req, res) => {
  const filter = req.query.filter || 'all';   // 'all' | 'free' | 'paid'
  const limit  = Math.min(parseInt(req.query.limit || '80', 10), 200);

  try {
    const response = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(8000),
    });

    if (!response.ok) {
      return sendError(res, 502, `OpenRouter models API returned ${response.status}.`);
    }

    const data = await response.json();
    let models  = data.data || [];

    // Normalise pricing — OpenRouter returns USD per token, convert to per million
    models = models.map(m => {
      const promptPerM      = m.pricing?.prompt      ? parseFloat(m.pricing.prompt)      * 1_000_000 : 0;
      const completionPerM  = m.pricing?.completion  ? parseFloat(m.pricing.completion)  * 1_000_000 : 0;
      const isFree          = promptPerM === 0 && completionPerM === 0;
      const supportsTools   = m.supported_parameters?.includes('tools') ?? false;

      return {
        id:              m.id,
        name:            m.name,
        description:     m.description || '',
        context_length:  m.context_length || 0,
        is_free:         isFree,
        supports_tools:  supportsTools,
        prompt_price:    promptPerM,      // USD per 1M input tokens
        completion_price: completionPerM, // USD per 1M output tokens
        top_provider:    m.top_provider?.max_completion_tokens || null,
      };
    });

    // Apply filter
    if (filter === 'free') models = models.filter(m => m.is_free);
    if (filter === 'paid') models = models.filter(m => !m.is_free);

    // Sort: free first, then by context length descending within each group
    models.sort((a, b) => {
      if (a.is_free !== b.is_free) return a.is_free ? -1 : 1;
      return b.context_length - a.context_length;
    });

    res.json({
      total:  models.length,
      models: models.slice(0, limit),
    });
  } catch (e) {
    if (e.name === 'AbortError') {
      return sendError(res, 504, 'OpenRouter models API timed out.');
    }
    console.error('[aiRoutes] GET /openrouter/models:', e.message);
    sendError(res, 500, 'Failed to fetch OpenRouter models.');
  }
});

// GET /api/ai/sessions
router.get('/sessions', async (req, res) => {
  const adminEmpId = req.query.admin_emp_id;
  if (!adminEmpId) return sendError(res, 400, 'admin_emp_id required.');
  try {
    const r = await pool.query(`
      SELECT s.id, s.title, s.model, s.ollama_url, s.created_at, s.updated_at,
             p.provider_key, p.display_name AS provider_name
      FROM ai_chat_sessions s
      JOIN ai_providers p ON s.provider_id = p.id
      WHERE s.admin_emp_id = $1 ORDER BY s.updated_at DESC LIMIT 50
    `, [adminEmpId]);
    res.json(r.rows);
  } catch (e) {
    console.error('[aiRoutes] GET /sessions:', e.message);
    sendError(res, 500, 'Failed to load sessions.');
  }
});

// POST /api/ai/sessions
router.post('/sessions', async (req, res) => {
  const { admin_emp_id, provider_key, model, ollama_url, supports_tools } = req.body;
  if (!admin_emp_id) return sendError(res, 400, 'admin_emp_id required.');
  if (!provider_key) return sendError(res, 400, 'provider_key required.');
  if (!model)        return sendError(res, 400, 'model required.');
  try {
    const pr = await pool.query('SELECT id, is_enabled FROM ai_providers WHERE provider_key = $1', [provider_key]);
    if (!pr.rows.length)     return sendError(res, 404, `Provider '${provider_key}' not found.`);
    if (!pr.rows[0].is_enabled) return sendError(res, 400, `Provider '${provider_key}' is not enabled. Add an API key in AI Settings.`);

    // supports_tools: use value from frontend if explicitly provided,
    // otherwise default TRUE for providers that always support tools
    // (anthropic, openai, google, groq), FALSE only if explicitly passed as false.
    const toolsSupported = supports_tools !== undefined ? Boolean(supports_tools) : true;

    const r = await pool.query(
      `INSERT INTO ai_chat_sessions (admin_emp_id, provider_id, model, ollama_url, supports_tools)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`,
      [admin_emp_id, pr.rows[0].id, model, ollama_url || null, toolsSupported]
    );
    res.status(201).json({
      session_id:    r.rows[0].id,
      created_at:    r.rows[0].created_at,
      provider_key,
      model,
      supports_tools: toolsSupported,
    });
  } catch (e) {
    console.error('[aiRoutes] POST /sessions:', e.message);
    sendError(res, 500, 'Failed to create session.');
  }
});

// DELETE /api/ai/sessions/:id
router.delete('/sessions/:id', async (req, res) => {
  const adminEmpId = req.query.admin_emp_id || req.body?.admin_emp_id;
  try {
    const r = await pool.query(
      'DELETE FROM ai_chat_sessions WHERE id = $1 AND admin_emp_id = $2',
      [req.params.id, adminEmpId]
    );
    if (!r.rowCount) return sendError(res, 404, 'Session not found or not yours.');
    res.json({ deleted: true, session_id: req.params.id });
  } catch (e) {
    console.error('[aiRoutes] DELETE /sessions/:id:', e.message);
    sendError(res, 500, 'Failed to delete session.');
  }
});

// GET /api/ai/sessions/:id/messages
router.get('/sessions/:id/messages', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, role, content, tool_name, tool_input, tool_use_id, created_at
       FROM ai_chat_messages WHERE session_id = $1 ORDER BY id ASC`,
      [req.params.id]
    );
    res.json(r.rows);
  } catch (e) {
    console.error('[aiRoutes] GET /sessions/:id/messages:', e.message);
    sendError(res, 500, 'Failed to load messages.');
  }
});

// POST /api/ai/sessions/:id/chat  — SSE streaming
router.post('/sessions/:id/chat', async (req, res) => {
  const sessionId  = parseInt(req.params.id, 10);
  const { message, admin_emp_id } = req.body;

  if (!message?.trim()) return sendError(res, 400, 'message required.');
  if (!admin_emp_id)    return sendError(res, 400, 'admin_emp_id required.');

  // Open SSE stream
  res.setHeader('Content-Type',      'text/event-stream');
  res.setHeader('Cache-Control',     'no-cache');
  res.setHeader('Connection',        'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable Nginx response buffering
  res.flushHeaders();

  try {
    // Load session + provider
    const sr = await pool.query(`
      SELECT s.id, s.title, s.model, s.ollama_url, s.supports_tools,
             p.provider_key, p.api_key_encrypted, p.base_url
      FROM ai_chat_sessions s
      JOIN ai_providers p ON s.provider_id = p.id
      WHERE s.id = $1
    `, [sessionId]);

    if (!sr.rows.length) { sseWrite(res, 'error', { message: 'Session not found.' }); return res.end(); }

    const session     = sr.rows[0];
    const providerKey = session.provider_key;
    const apiKey      = decryptOrNull(session.api_key_encrypted);

    if (providerKey !== 'ollama' && !apiKey) {
      sseWrite(res, 'error', { message: `Cannot decrypt ${providerKey} API key. Check AI_ENCRYPTION_KEY env var.` });
      return res.end();
    }

    // Load history
    const hr = await pool.query(
      `SELECT role, content, tool_name, tool_input, tool_use_id
       FROM ai_chat_messages WHERE session_id = $1 ORDER BY id ASC`,
      [sessionId]
    );

    // Save user message
    await pool.query(
      `INSERT INTO ai_chat_messages (session_id, role, content) VALUES ($1, 'user', $2)`,
      [sessionId, message.trim()]
    );

    // Set title on first message
    const isFirst = !hr.rows.length && !session.title;
    if (isFirst) {
      await pool.query('UPDATE ai_chat_sessions SET title = $1 WHERE id = $2', [makeTitle(message.trim()), sessionId]);
    }

    await callLLM({
      providerKey,
      model:         session.model,
      apiKey,
      baseUrl:       session.ollama_url || session.base_url,
      messages:      buildMessages(hr.rows, message.trim()),
      supportsTools: session.supports_tools !== false, // default true if NULL (old sessions)
      res,
      sessionId,
      adminEmpId:    admin_emp_id,
    });

    sseWrite(res, 'done', { session_id: sessionId, ...(isFirst ? { title: makeTitle(message.trim()) } : {}) });

  } catch (e) {
    console.error('[aiRoutes] POST /sessions/:id/chat:', e.message);
    sseWrite(res, 'error', { message: e.message || 'LLM call failed.' });
  } finally {
    res.end();
  }
});

export default router;