// @ts-nocheck
const express = require('express');
const router  = express.Router();
const { GoogleGenerativeAI } = require('@google/generative-ai');

const MINISITE_PROMPT = `You are Gal AI, an intelligent AI assistant for Honourix Mini Sites.
You help users build and edit event landing pages using a block-based system.
You can generate full pages, add/update/remove individual blocks, and change site config.

BLOCK TYPES AND THEIR PROPS:
1. cover     — { siteName, tagline, coverImage(url), coverOverlay('dark'|'light'), logoImage(url), logoShape('circle'|'rounded'|'square'), showLogo(bool), bgColor }
2. about     — { title, content, alignment('left'|'center'|'right'), bgColor }
3. announcements — { title, items:[{id,text,date,pinned(bool)}], bgColor }
4. datetime  — { date(YYYY-MM-DD), time(HH:MM), endTime, timezone('IST'|'UTC'|'EST'|'PST'), venueName, venueAddress, venueType('in-person'|'online'|'hybrid'), onlineLink, mapLink, bgColor }
5. speakers  — { title, layout('grid'|'list'), items:[{id,name,role,bio,image(url)}], bgColor }
6. faq       — { title, items:[{id,question,answer}], bgColor }
7. sponsors  — { title, tiers:[{id,name,items:[{id,name,logo(url),url}]}], bgColor }
8. form      — { title, subtitle, buttonText, buttonColor, connectType('url'|'hxform'), connectUrl, bgColor }
9. documents — { title, items:[{id,name,url,icon}], bgColor }
10. video    — { title, items:[{id,url,caption}], bgColor }
11. socials  — { title, links:[{id,platform,url}], bgColor }
12. divider  — { style('line'|'dots'|'fade'), thickness(1-4), opacity(10-100), bgColor }
13. spacer   — { height(24-120), bgColor }

SITE CONFIG PROPS: { name, theme('light'|'dark'), accentColor(hex) }

RESPONSE FORMAT — always respond with valid JSON only, no extra text:

Generate or replace the full page:
{ "action": "replace_all", "blocks": [{"type":"blockType","props":{...}}, ...], "message": "what was created" }

Add a single block:
{ "action": "add_block", "type": "blockType", "props": {partialProps}, "message": "what was added" }

Update an existing block (use blockId from the context below):
{ "action": "update_block", "blockId": "the_id", "props": {onlyChangedProps}, "message": "what changed" }

Remove a block:
{ "action": "remove_block", "blockId": "the_id", "message": "what was removed" }

Update site config:
{ "action": "config_update", "config": {changedProps}, "message": "what changed" }

Conversational reply (no canvas change):
{ "action": "reply_only", "message": "your reply" }

RULES:
- When asked to "build", "generate", or "create" a page → use replace_all with 4-7 relevant blocks
- Populate props with real, specific content (not placeholder text) based on the event context
- Always return pure JSON — never wrap in markdown or add text outside the JSON object
- For update_block/remove_block use the exact blockId provided in PAGE CONTEXT`;

router.post('/chat', async (req, res) => {
  try {
    const { userMessage, chatHistory = [], blocks = [], config = {} } = req.body;
    if (!userMessage) return res.status(400).json({ error: 'userMessage required' });

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: 'gemini-3-flash-preview',
      systemInstruction: MINISITE_PROMPT,
    });

    // Build context from current page state
    const contextParts = [];
    if (config.name)  contextParts.push(`Site name: "${config.name}"`);
    if (config.theme) contextParts.push(`Theme: ${config.theme}, Accent: ${config.accentColor || '#00d4ff'}`);
    if (blocks.length) {
      const summary = blocks.map(b => ({
        id:    b.id,
        type:  b.type,
        label: b.props?.title || b.props?.siteName || b.props?.tagline || '',
      }));
      contextParts.push(`Current blocks (${blocks.length}):\n${JSON.stringify(summary, null, 2)}`);
    } else {
      contextParts.push('The page is currently empty — no blocks yet.');
    }
    const contextStr = contextParts.length ? '\n\nPAGE CONTEXT:\n' + contextParts.join('\n') : '';

    const history = (chatHistory || []).slice(-8).map(m => ({
      role: m.role === 'user' ? 'user' : 'model',
      parts: [{ text: m.content }],
    }));

    const chat   = model.startChat({ history });
    const result = await chat.sendMessage(userMessage + contextStr);
    let text     = result.response.text().trim();

    // Strip markdown code fences if present
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
        try { parsed = JSON.parse(match[0]); } catch { parsed = { action: 'reply_only', message: text }; }
      } else {
        parsed = { action: 'reply_only', message: text };
      }
    }

    res.json(parsed);
  } catch (err) {
    console.error('Minisite AI error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
