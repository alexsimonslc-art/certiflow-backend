const express = require('express');
const router = express.Router();
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);
const { PDFDocument, rgb, StandardFonts, degrees } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const axios = require('axios');
// ── Font cache + dynamic Google Fonts fetcher ─────────────────────
const fontCache = {};

async function fetchGoogleFontBytes(family, bold, italic) {
  const weight = bold ? 700 : 400;
  const ital   = italic ? 1 : 0;
  const cacheKey = `${family}-${weight}-${ital}`;

  if (fontCache[cacheKey]) return fontCache[cacheKey];

  // Step 1: Hit Google Fonts CSS API with an old User-Agent to get TTF URLs
  const cssUrl = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:ital,wght@${ital},${weight}&display=swap`;

  const cssResp = await axios.get(cssUrl, {
    headers: {
      // Old Android UA → Google returns TTF format instead of woff2
      'User-Agent': 'Mozilla/5.0 (Linux; U; Android 4.0) AppleWebKit/534.30 (KHTML, like Gecko) Version/4.0 Mobile Safari/534.30',
    },
    timeout: 10000,
  });

  // Step 2: Extract the font file URL from the CSS response
  const match = cssResp.data.match(/src:\s*url\(([^)]+)\)\s*format\('truetype'\)/);
  if (!match) {
    // Fallback: try woff2 URL (won't work with pdf-lib but let's try)
    const woff2Match = cssResp.data.match(/src:\s*url\(([^)]+)\)/);
    if (!woff2Match) throw new Error(`No font URL found in CSS for ${family}`);
    // If only woff2 available, try it — pdf-lib + fontkit might handle it
    const fontResp = await axios.get(woff2Match[1], { responseType: 'arraybuffer', timeout: 15000 });
    fontCache[cacheKey] = fontResp.data;
    return fontResp.data;
  }

  // Step 3: Download the actual TTF file
  const fontResp = await axios.get(match[1], { responseType: 'arraybuffer', timeout: 15000 });
  fontCache[cacheKey] = fontResp.data;
  return fontResp.data;
}

// Server-side PDF Text Wrapper Engine
function wrapTextPdf(text, maxWidth, font, fontSize, letterSpacing) {
  if(!text) return [''];
  const words = String(text).split(' ');
  const lines = [];
  let currentLine = words[0] || '';
  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    const testLine = currentLine + ' ' + word;
    let testWidth = font.widthOfTextAtSize(testLine, fontSize);
    if (letterSpacing > 0 && testLine.length > 1) testWidth += letterSpacing * (testLine.length - 1);
    if (testWidth > maxWidth && currentLine !== '') {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = testLine;
    }
  }
  if (currentLine !== '') lines.push(currentLine);
  return lines.length ? lines : [''];
}

// Server-side PDF Text Wrapper Engine
function wrapTextPdf(text, maxWidth, font, fontSize, letterSpacing) {
  if(!text) return [''];
  const words = String(text).split(' ');
  const lines = [];
  let currentLine = words[0] || '';
  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    const testLine = currentLine + ' ' + word;
    let testWidth = font.widthOfTextAtSize(testLine, fontSize);
    if (letterSpacing > 0 && testLine.length > 1) testWidth += letterSpacing * (testLine.length - 1);
    if (testWidth > maxWidth && currentLine !== '') {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = testLine;
    }
  }
  if (currentLine !== '') lines.push(currentLine);
  return lines.length ? lines : [''];
}

function hexToRgb(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return { r, g, b };
}

// Auto-create a Drive folder and return its ID
async function getOrCreateFolder(drive, campaignName) {
  const folderName = `Honourix — ${campaignName}`;
  const existing = await drive.files.list({
    q: `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id, name)',
  });
  if (existing.data.files.length > 0) return existing.data.files[0].id;
  const folder = await drive.files.create({
    requestBody: {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
    },
    fields: 'id',
  });
  return folder.data.id;
}

// Generate certificates using Real-Time Chunked Streaming (ENTERPRISE BULK OPTIMIZED)
router.post('/generate', async (req, res) => {
  const { campaignName, eventName, template, participants, nameCol, emailCol, sheetId, writeBack } = req.body;

  if (!template || !participants?.length) {
    return res.status(400).json({ error: 'Missing template or participants' });
  }

  // ── 1. Initialize Real-Time Streaming Headers ──
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Transfer-Encoding', 'chunked');

  const sendEvent = (type, message, data = {}) => {
    res.write(JSON.stringify({ type, message, ...data }) + '\n');
  };

  const drive  = google.drive({ version: 'v3', auth: req.oauth2Client });
  const sheets = google.sheets({ version: 'v4', auth: req.oauth2Client });

  sendEvent('info', 'Connecting to Google Drive...');

  // ── 2. Auto-create Drive folder ──
  let folderId;
  try {
    folderId = await getOrCreateFolder(drive, campaignName || 'Certificates');
    sendEvent('info', `Folder ready: "Honourix — ${campaignName || 'Certificates'}"`);
  } catch (e) {
    sendEvent('error', 'Could not create Drive folder: ' + e.message);
    return res.end();
  }

  sendEvent('info', `Processing ${participants.length} certificates in bulk. Please hold on...`);

  const results = [];
  const bulkLinks = [['Certificate Link']]; // Header for our bulk Sheets update

  // ── 3. Live Batch Generation Loop ──
  for (let i = 0; i < participants.length; i++) {
    const row = participants[i];
    const name = row[nameCol] || `Person ${i + 1}`;

    try {
      const pdfDoc = await PDFDocument.create();
      pdfDoc.registerFontkit(fontkit);
      const page = pdfDoc.addPage([template.width, template.height]);

      if (template.backgroundBase64) {
        const match = template.backgroundBase64.match(/^data:image\/(png|jpeg|jpg|webp);base64,/);
        if (!match) throw new Error('Unsupported image format. Use PNG or JPEG.');
        const mimeType = match[1].toLowerCase();
        const base64Data = template.backgroundBase64.replace(/^data:image\/\w+;base64,/, '');
        const imgBytes = Buffer.from(base64Data, 'base64');

        let img = (mimeType === 'jpeg' || mimeType === 'jpg') ? await pdfDoc.embedJpg(imgBytes) : await pdfDoc.embedPng(imgBytes);
        page.drawImage(img, { x: 0, y: 0, width: template.width, height: template.height });
      } else {
        page.drawRectangle({ x: 0, y: 0, width: template.width, height: template.height, color: rgb(1, 1, 1) });
      }

      for (const field of template.fields) {
        let text = field.placeholder;
        Object.keys(row).forEach(col => {
          text = text.replace(new RegExp(`{{${col}}}`, 'gi'), row[col] || '');
        });
        if (field.column && row[field.column]) text = row[field.column];

        const STANDARD_FONTS = {
          'Helvetica': StandardFonts.Helvetica, 'Helvetica-Bold': StandardFonts.HelveticaBold,
          'Helvetica-Italic': StandardFonts.HelveticaOblique, 'Helvetica-BoldItalic': StandardFonts.HelveticaBoldOblique,
          'Times New Roman': StandardFonts.TimesRoman, 'Times New Roman-Bold': StandardFonts.TimesRomanBold,
          'Times New Roman-Italic': StandardFonts.TimesRomanItalic, 'Times New Roman-BoldItalic': StandardFonts.TimesRomanBoldItalic,
          'Courier New': StandardFonts.Courier, 'Courier New-Bold': StandardFonts.CourierBold,
          'Courier New-Italic': StandardFonts.CourierOblique, 'Courier New-BoldItalic': StandardFonts.CourierBoldOblique,
        };

        const GOOGLE_FONTS = ['Montserrat', 'Raleway', 'Plus Jakarta Sans', 'EB Garamond', 'Playfair Display', 'Cormorant Garamond', 'Dancing Script', 'Cinzel', 'JetBrains Mono'];

        let font;
        const isBold = !!field.bold; const isItalic = !!field.italic;
        const variantSuffix = (isBold && isItalic) ? '-BoldItalic' : isBold ? '-Bold' : isItalic ? '-Italic' : '';

        if (STANDARD_FONTS[field.fontFamily] || STANDARD_FONTS[field.fontFamily + variantSuffix]) {
          const stdKey = field.fontFamily + variantSuffix;
          font = await pdfDoc.embedFont(STANDARD_FONTS[stdKey] || STANDARD_FONTS[field.fontFamily]);
        } else if (GOOGLE_FONTS.includes(field.fontFamily)) {
            try {
              const fontBytes = await fetchGoogleFontBytes(field.fontFamily, isBold, isItalic);
              const useSubset = !['EB Garamond', 'Cormorant Garamond'].includes(field.fontFamily);
              font = await pdfDoc.embedFont(fontBytes, { subset: useSubset });
            } catch (e) {
              const fallbackKey = 'Helvetica' + variantSuffix;
              font = await pdfDoc.embedFont(STANDARD_FONTS[fallbackKey] || StandardFonts.Helvetica);
            }
        } else {
          const fallbackKey = 'Helvetica' + variantSuffix;
          font = await pdfDoc.embedFont(STANDARD_FONTS[fallbackKey] || StandardFonts.Helvetica);
        }

        const col  = hexToRgb(field.color || '#000000');
        const x = (field.x / 100) * template.width;
        const topY = (field.y / 100) * template.height;
        const letterSpacing = field.letterSpacing || 0;
        const fieldWidth = (field.width / 100) * template.width;

        // Apply Multi-Line Wrapping Math & Rotation
        const lines = wrapTextPdf(text, fieldWidth, font, field.fontSize, letterSpacing);
        const numLines = lines.length;

        const rotDeg = -(field.rotation || 0);
        const theta = rotDeg * Math.PI / 180;
        const cosT = Math.cos(theta); const sinT = Math.sin(theta);
        
        const pivotX = x + fieldWidth / 2;
        const pivotY = template.height - (topY + (field.fontSize * 1.3 * numLines) / 2);

        const getRotatedPoint = (px, py) => {
            return {
                x: pivotX + (px - pivotX) * cosT - (py - pivotY) * sinT,
                y: pivotY + (px - pivotX) * sinT + (py - pivotY) * cosT
            };
        };

        lines.forEach((line, idx) => {
            const lineBaseY = template.height - (topY + (idx * field.fontSize * 1.3)) - (field.fontSize * 0.81);
            let lineTotalWidth = font.widthOfTextAtSize(line, field.fontSize);
            if (letterSpacing > 0 && line.length > 1) lineTotalWidth += letterSpacing * (line.length - 1);
            
            let startX = x;
            if (field.align === 'center') startX = x + (fieldWidth - lineTotalWidth) / 2;
            else if (field.align === 'right') startX = x + fieldWidth - lineTotalWidth;

            if (letterSpacing > 0) {
                let cx = startX;
                for (const ch of line) {
                    const pt = getRotatedPoint(cx, lineBaseY);
                    page.drawText(ch, { x: pt.x, y: pt.y, size: field.fontSize, font, color: rgb(col.r, col.g, col.b), rotate: degrees(rotDeg) });
                    cx += font.widthOfTextAtSize(ch, field.fontSize) + letterSpacing;
                }
            } else {
                const pt = getRotatedPoint(startX, lineBaseY);
                page.drawText(line, { x: pt.x, y: pt.y, size: field.fontSize, font, color: rgb(col.r, col.g, col.b), rotate: degrees(rotDeg) });
            }
        });
      }

      const pdfBytes = await pdfDoc.save();

      // Build the exact file name: Name_EventName_01.pdf
      const sanitizedName = String(name).replace(/[^a-zA-Z0-9_\-\u0900-\u097F\u00C0-\u024F]/g, '_').replace(/_+/g,'_').replace(/^_|_$/g,'') || 'cert';
      const eventPart = eventName ? '_' + String(eventName).replace(/[^a-zA-Z0-9_\-\u0900-\u097F\u00C0-\u024F]/g, '_').replace(/_+/g,'_').replace(/^_|_$/g,'') : '';
      const numPart = String(i + 1).padStart(2, '0');
      const finalFileName = `${sanitizedName}${eventPart}_${numPart}.pdf`;

      // Upload PDF to Drive
      const { Readable } = require('stream');
      const stream = Readable.from(Buffer.from(pdfBytes));
      const uploaded = await drive.files.create({
        requestBody: { name: finalFileName, parents: [folderId] },
        media: { mimeType: 'application/pdf', body: stream },
        fields: 'id, webViewLink',
      });

      await drive.permissions.create({
        fileId: uploaded.data.id,
        requestBody: { role: 'reader', type: 'anyone' },
      });

      const link = uploaded.data.webViewLink;
      bulkLinks.push([link]); // Save for bulk write-back

      // THROTTLE: Pause for 300ms to protect Google Drive APIs from rate-limiting
      await new Promise(res => setTimeout(res, 300));

      const resultData = { name, email: row[emailCol] || '', link, status: 'success' };
      results.push(resultData);
      sendEvent('success', `✓ Generated & uploaded certificate for ${name}`, { result: resultData });

      // Increment lifetime cert count
      supabase.from('users')
        .select('certs_total')
        .eq('google_id', req.user.googleId)
        .single()
        .then(({ data: cur }) => supabase.from('users').update({
          certs_total: (cur?.certs_total || 0) + 1,
        }).eq('google_id', req.user.googleId))
        .catch(() => {});

    } catch (err) {
      console.error(`Failed for ${name}:`, err.message);
      bulkLinks.push([`Error: ${err.message}`]); // Still write something to the sheet to maintain row order
      const resultData = { name, email: row[emailCol] || '', link: '', status: 'failed', error: err.message };
      results.push(resultData);
      sendEvent('error', `✗ Failed for ${name} — ${err.message}`, { result: resultData });
    }
  }

  // ── 4. Bulk Write-Back to Google Sheets ──
  if (writeBack && sheetId) {
    sendEvent('info', 'Saving all links to your Google Sheet...');
    try {
      // Find how many columns the sheet currently has
      const sheetData = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: 'Sheet1!1:1' });
      const numCols = sheetData.data.values && sheetData.data.values[0] ? sheetData.data.values[0].length : 0;

      // Function to convert column number to letter (e.g. 1 -> A, 27 -> AA)
      const getColLetter = (colIndex) => {
          let letter = '';
          while (colIndex > 0) {
              let temp = (colIndex - 1) % 26;
              letter = String.fromCharCode(temp + 65) + letter;
              colIndex = (colIndex - temp - 1) / 26;
          }
          return letter;
      };
      
      const writeCol = getColLetter(numCols + 1);
      const range = `Sheet1!${writeCol}1:${writeCol}${bulkLinks.length}`;

      // Do ONE massive update instead of 500 individual ones
      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: range,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: bulkLinks }
      });
      
      sendEvent('info', `✓ Successfully added Certificate Links to Column ${writeCol}!`);
    } catch (err) {
      sendEvent('error', 'Could not write to Google Sheet: ' + err.message);
    }
  }

  const folderLink = `https://drive.google.com/drive/folders/${folderId}`;
  sendEvent('done', 'All certificates generated successfully!', { folderId, folderLink, total: participants.length, results });
  res.end();
});

module.exports = router;