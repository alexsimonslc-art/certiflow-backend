// @ts-nocheck
const express = require('express');
const router = express.Router();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const SYSTEM_PROMPT = `You are an expert email designer AI assistant for Honourix, a certificate and bulk mail platform.
You help users create beautiful, professional HTML email templates using a block-based system.

BLOCK TYPES AND THEIR PROPERTIES:
Each block is a JSON object with "type" and "props" fields.

1. logo: { text, tagline, bgColor, color, fontSize, fontWeight, align, paddingV, paddingH }
2. header: { text, fontSize, fontWeight, color, bgColor, align, paddingV, paddingH }
3. text: { text, fontSize, color, bgColor, align, paddingV, paddingH, lineHeight, fontWeight, fontStyle }
4. button: { text, link, btnBg, btnColor, bgColor, align, paddingV, paddingH, borderRadius, fontSize, fontWeight }
5. image: { src, alt, width, bgColor, paddingV, paddingH, borderRadius }
6. divider: { color, bgColor, paddingV, thickness }
7. spacer: { height, bgColor }
8. footer: { text, bgColor, color, fontSize, align, paddingV, paddingH }
9. social: { platforms:[{name,url,icon}], bgColor, align, paddingV, paddingH, iconSize, style, color }
   - style: "plain" | "circle" | "square"
   - platform names: LinkedIn, Twitter/X, Instagram, Facebook, YouTube, TikTok, Pinterest, GitHub, WhatsApp, Telegram, Discord, Website
10. table: { rows, cols, data:[[]], headerRow, borderWidth, borderColor, headerBg, headerColor, cellBg, cellColor, cellPadding, fontSize, bgColor, paddingV, paddingH, width }

DESIGN PRINCIPLES YOU MUST FOLLOW:
- Use modern, beautiful color palettes (not just white backgrounds)
- Apply proper typographic hierarchy (large headers, readable body text)
- Use consistent padding (paddingV: 24-40, paddingH: 40)
- Buttons should use gradient backgrounds like "linear-gradient(135deg,#6366f1,#8b5cf6)" or brand colors
- For professional emails: use #1e293b for dark text, #475569 for body text, #f8fafc for light backgrounds
- For dark branded emails: use deep navy (#0d1728) or rich purple (#1a0533) for headers
- Always end with a footer block
- Use merge tags like {{name}}, {{email}}, {{course}}, {{date}} where appropriate
- Create visually impressive, agency-quality email designs
- Logo/banner blocks should use bold brand colors, NOT plain white

RESPONSE FORMAT:
You MUST always respond with valid JSON only. No markdown, no explanations outside JSON.

For generating/replacing email content:
{
  "action": "replace_blocks",
  "blocks": [ array of block objects ],
  "message": "Brief friendly explanation of what was created/changed"
}

For updating a single block:
{
  "action": "update_block",
  "blockId": "the block id",
  "props": { only the changed props },
  "message": "What was changed"
}

For subject line suggestions:
{
  "action": "subject_suggestions",
  "suggestions": ["Subject 1", "Subject 2", "Subject 3", "Subject 4", "Subject 5"],
  "message": "Here are 5 subject line suggestions"
}

For parsing/importing HTML:
{
  "action": "replace_blocks",
  "blocks": [ parsed block objects ],
  "message": "Imported and converted to editable blocks"
}

For conversational replies that don't change the canvas:
{
  "action": "reply_only",
  "message": "Your conversational reply here"
}

IMPORTANT RULES:
- When asked to generate an email, always return full blocks array (replace_blocks)
- When asked to change specific property of selected block, use update_block
- When asked for subject lines, use subject_suggestions
- Block IDs in update_block should match what the user provides in context
- Never return partial JSON or explanatory text outside the JSON object
- Generate at least 5-7 blocks for a complete email
- Make designs look PREMIUM and MODERN — not generic`;

router.post('/generate-email', async (req, res) => {
  try {
    const { userMessage, currentBlocks = [], headers = [], chatHistory = [], selectedBlockId = null, mode = 'visual', htmlModeText = '' } = req.body;

    if (!userMessage) return res.status(400).json({ error: 'userMessage required' });

    // Plan gate — free users cannot use AI
    const { data: userRow } = await supabase
      .from('users')
      .select('plan, plan_expires_at')
      .eq('google_id', req.user.googleId)
      .single();
    const isPro = userRow?.plan === 'pro'
      && (!userRow.plan_expires_at || new Date(userRow.plan_expires_at) > new Date());
    if (!isPro) return res.status(403).json({ error: 'AI_LOCKED' });

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });

    const genAI = new GoogleGenerativeAI(apiKey);

    // Choose behavior based on mode
    let instructionToUse = SYSTEM_PROMPT;
    if (mode === 'code') {
      instructionToUse = `You are an expert email graphic designer and HTML/CSS coder assistant.
You help users write and modify highly effective, valid, responsive pure HTML email code directly.
There is NO block editor constraint here. You can use valid <style> blocks, tables, gradients, rounded corners, and any advanced email HTML techniques.
IMPORTANT RULES:
- Never exceed 40px for font sizes under any circumstance.
- The user is editing raw HTML. Ensure any code provided in "html" is a complete, working HTML string or the updated raw HTML snippet depending on their request.
- Make designs MUST look PREMIUM and MODERN.

RESPONSE FORMAT:
You MUST always respond with valid JSON only. No markdown, no explanations outside JSON.
{
  "action": "replace_html",
  "html": "The full working raw HTML code snippet based on the user's request",
  "message": "Brief friendly explanation of what you updated/created"
}
For conversational replies that don't change the html canvas:
{
  "action": "reply_only",
  "message": "Your conversational reply here"
}
`;
    } else {
      // Modifying the standard visual mode prompt minimally in-flight to add the size rule.
      instructionToUse += "\n- Maximum allowed font size for any block property is 40px. Do not use anything larger than 40px (e.g. 72px is forbidden).";
    }

    const model = genAI.getGenerativeModel({
      model: 'gemini-3-flash-preview',
      systemInstruction: instructionToUse,
    });

    // Build context for the AI
    const contextParts = [];
    if (headers.length) {
      contextParts.push(`Available merge tags from the user's data: ${headers.map(h => '{{' + h.toLowerCase().replace(/\s+/g, '_') + '}}').join(', ')}`);
    }

    if (mode === 'code') {
      contextParts.push(`Current HTML canvas content:\n\`\`\`html\n${htmlModeText.slice(0, 3000)}\n\`\`\``);
    } else {
      if (currentBlocks.length) {
        contextParts.push(`Current canvas has ${currentBlocks.length} blocks: ${JSON.stringify(currentBlocks.slice(0, 3))}...`);
      }
      if (selectedBlockId) {
        const sel = currentBlocks.find(b => b.id === selectedBlockId);
        if (sel) contextParts.push(`User has selected block: ${JSON.stringify(sel)}`);
      }
    }

    const contextString = contextParts.length ? '\n\nCONTEXT:\n' + contextParts.join('\n') : '';

    // Build chat history for multi-turn
    const history = (chatHistory || []).slice(-10).map(m => ({
      role: m.role === 'user' ? 'user' : 'model',
      parts: [{ text: m.content }],
    }));

    const chat = model.startChat({ history });

    const result = await chat.sendMessage(userMessage + contextString);
    let text = result.response.text().trim();

    // Strip markdown code fences if AI wraps in ```json
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      // Try to extract JSON from response
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
      } else {
        parsed = { action: 'reply_only', message: text };
      }
    }

    // Assign unique IDs to any blocks that lack them
    if (parsed.blocks) {
      let nextId = Date.now();
      parsed.blocks = parsed.blocks.map(b => ({
        ...b,
        id: b.id || ('ai_' + (nextId++)),
      }));
    }

    // Track token usage
    try {
      const usage = result.response.usageMetadata || {};
      const tokIn = usage.promptTokenCount || 0;
      const tokOut = usage.candidatesTokenCount || 0;
      if (tokIn || tokOut) {
        const { data: cur } = await supabase
          .from('users')
          .select('ai_tokens_input, ai_tokens_output')
          .eq('google_id', req.user.googleId)
          .single();
        await supabase.from('users').update({
          ai_tokens_input: (cur?.ai_tokens_input || 0) + tokIn,
          ai_tokens_output: (cur?.ai_tokens_output || 0) + tokOut,
        }).eq('google_id', req.user.googleId);
      }
    } catch (_) { }

    res.json(parsed);
  } catch (err) {
    console.error('AI route error:', err.message);
    res.status(500).json({ error: err.message });
  }
});


module.exports = router;
