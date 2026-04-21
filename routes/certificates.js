const express = require('express');
const router = express.Router();
const { google } = require('googleapis');
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

// Generate certificates from custom template (no Slides needed)
router.post('/generate', async (req, res) => {
  const { campaignName, template, participants, nameCol, emailCol, sheetId, writeBack } = req.body;

  if (!template || !participants?.length) {
    return res.status(400).json({ error: 'Missing template or participants' });
  }

  const drive  = google.drive({ version: 'v3', auth: req.oauth2Client });
  const sheets = google.sheets({ version: 'v4', auth: req.oauth2Client });

  // Auto-create Drive folder
  let folderId;
  try {
    folderId = await getOrCreateFolder(drive, campaignName || 'Certificates');
  } catch (e) {
    return res.status(500).json({ error: 'Could not create Drive folder: ' + e.message });
  }

  const results = [];

  for (let i = 0; i < participants.length; i++) {
    const row = participants[i];
    const name = row[nameCol] || `Person ${i + 1}`;

    try {
      // 1. Create PDF from template
      const pdfDoc = await PDFDocument.create();
      pdfDoc.registerFontkit(fontkit);
      const page = pdfDoc.addPage([template.width, template.height]);

      // 2. Draw background image if present
      if (template.backgroundBase64) {
      // ✅ Extract MIME type cleanly from the prefix only
      const match = template.backgroundBase64.match(/^data:image\/(png|jpeg|jpg|webp);base64,/);
      
      if (!match) {
        return res.status(400).json({ error: 'Unsupported image format. Use PNG or JPEG.' });
      }

      const mimeType = match[1].toLowerCase(); // safely get 'jpeg', 'jpg', or 'png'
      const base64Data = template.backgroundBase64.replace(/^data:image\/\w+;base64,/, '');
      const imgBytes = Buffer.from(base64Data, 'base64');

      let img;
      if (mimeType === 'jpeg' || mimeType === 'jpg') {
        img = await pdfDoc.embedJpg(imgBytes);
      } else {
        img = await pdfDoc.embedPng(imgBytes);
      }

      page.drawImage(img, { x: 0, y: 0, width: template.width, height: template.height });

    } else {
      page.drawRectangle({ x: 0, y: 0, width: template.width, height: template.height, color: rgb(1, 1, 1) });
    }

      // 3. Draw each text field
      for (const field of template.fields) {
        let text = field.placeholder;
        // Replace placeholders with actual data
        Object.keys(row).forEach(col => {
          text = text.replace(new RegExp(`{{${col}}}`, 'gi'), row[col] || '');
        });
        // Also replace by mapped column name
        if (field.column && row[field.column]) {
          text = row[field.column];
        }

        const STANDARD_FONTS = {
          'Helvetica':              StandardFonts.Helvetica,
          'Helvetica-Bold':         StandardFonts.HelveticaBold,
          'Helvetica-Italic':       StandardFonts.HelveticaOblique,
          'Helvetica-BoldItalic':   StandardFonts.HelveticaBoldOblique,
          'Times New Roman':        StandardFonts.TimesRoman,
          'Times New Roman-Bold':   StandardFonts.TimesRomanBold,
          'Times New Roman-Italic': StandardFonts.TimesRomanItalic,
          'Times New Roman-BoldItalic': StandardFonts.TimesRomanBoldItalic,
          'Courier New':            StandardFonts.Courier,
          'Courier New-Bold':       StandardFonts.CourierBold,
          'Courier New-Italic':     StandardFonts.CourierOblique,
          'Courier New-BoldItalic': StandardFonts.CourierBoldOblique,
        };

        // Google Fonts that we support (just the family names — fetched dynamically)
        const GOOGLE_FONTS = [
          'Montserrat', 'Raleway', 'Plus Jakarta Sans', 'EB Garamond',
          'Playfair Display', 'Cormorant Garamond', 'Dancing Script',
          'Cinzel', 'JetBrains Mono',
        ];

        let font;
        const isBold   = !!field.bold;
        const isItalic = !!field.italic;
        const variantSuffix = (isBold && isItalic) ? '-BoldItalic'
                            : isBold               ? '-Bold'
                            : isItalic              ? '-Italic'
                            : '';

        if (STANDARD_FONTS[field.fontFamily] || STANDARD_FONTS[field.fontFamily + variantSuffix]) {
          // Standard PDF font — pick the right bold/italic variant
          const stdKey = field.fontFamily + variantSuffix;
          font = await pdfDoc.embedFont(STANDARD_FONTS[stdKey] || STANDARD_FONTS[field.fontFamily]);

        } else if (GOOGLE_FONTS.includes(field.fontFamily)) {
            try {
              const fontBytes = await fetchGoogleFontBytes(field.fontFamily, isBold, isItalic);

              // EB Garamond (and any variable-origin font with a STAT table) breaks
              // fontkit's subsetting. Use subset:false for these fonts.
              const STAT_TABLE_FONTS = ['EB Garamond', 'Cormorant Garamond'];
              const useSubset = !STAT_TABLE_FONTS.includes(field.fontFamily);

              font = await pdfDoc.embedFont(fontBytes, { subset: useSubset });
            } catch (e) {
            console.warn(`Google Font failed for ${field.fontFamily} (bold:${isBold}, italic:${isItalic}): ${e.message}`);
            // Fallback: try without bold/italic
            try {
              const fallbackBytes = await fetchGoogleFontBytes(field.fontFamily, false, false);
              font = await pdfDoc.embedFont(fallbackBytes, { subset: true });
            } catch (e2) {
              console.warn(`Google Font fallback also failed, using Helvetica: ${e2.message}`);
              const fallbackKey = 'Helvetica' + variantSuffix;
              font = await pdfDoc.embedFont(STANDARD_FONTS[fallbackKey] || StandardFonts.Helvetica);
            }
          }
        } else {
          // Unknown font — use Helvetica with correct bold/italic
          const fallbackKey = 'Helvetica' + variantSuffix;
          font = await pdfDoc.embedFont(STANDARD_FONTS[fallbackKey] || StandardFonts.Helvetica);
        }
        const col  = hexToRgb(field.color || '#000000');

        const x = (field.x / 100) * template.width;
        const topY = (field.y / 100) * template.height;
        const letterSpacing = field.letterSpacing || 0;
        const fieldWidth = (field.width / 100) * template.width;

         // pdf-lib draws text from the baseline.
        // We want top-of-text alignment (matching canvas textBaseline:'top').
        // Use the font's own ascent at the given size — consistent regardless of field size.
        const baseY = template.height - topY - (field.fontSize * 0.81);
        // Calculate the exact rotation offset to match the frontend's center-based rotation
        const rotDeg = -(field.rotation || 0); // Negative because PDF is bottom-up // Negative because PDF is bottom-up
        const theta = rotDeg * Math.PI / 180;
        const cosT = Math.cos(theta);
        const sinT = Math.sin(theta);
        const pivotX = x + fieldWidth / 2;
        const pivotY = template.height - (topY + (field.fontSize * 1.3) / 2);

        const getRotatedPoint = (px, py) => {
            return {
                x: pivotX + (px - pivotX) * cosT - (py - pivotY) * sinT,
                y: pivotY + (px - pivotX) * sinT + (py - pivotY) * cosT
            };
        };

        if (letterSpacing > 0) {
          // pdf-lib has no native letter-spacing — draw char by char
          const chars    = text.split('');
          let totalWidth = chars.reduce((sum, ch) => sum + font.widthOfTextAtSize(ch, field.fontSize) + letterSpacing, -letterSpacing);
          let startX     = x;
          if (field.align === 'center') startX = x + (fieldWidth - totalWidth) / 2;
          else if (field.align === 'right') startX = x + fieldWidth - totalWidth;

          let cx = startX;
          for (const ch of chars) {
            const pt = getRotatedPoint(cx, baseY);
            page.drawText(ch, { x: pt.x, y: pt.y, size: field.fontSize, font, color: rgb(col.r, col.g, col.b), rotate: degrees(rotDeg) });
            cx += font.widthOfTextAtSize(ch, field.fontSize) + letterSpacing;
          }
        } else {
          // No letter-spacing — use normal drawText with alignment
          let drawX = x;
          if (field.align === 'center') {
            const textWidth = font.widthOfTextAtSize(text, field.fontSize);
            drawX = x + (fieldWidth - textWidth) / 2;
          } else if (field.align === 'right') {
            const textWidth = font.widthOfTextAtSize(text, field.fontSize);
            drawX = x + fieldWidth - textWidth;
          }
          const pt = getRotatedPoint(drawX, baseY);
          page.drawText(text, { x: pt.x, y: pt.y, size: field.fontSize, font, color: rgb(col.r, col.g, col.b), rotate: degrees(rotDeg) });
        }
      }

      const pdfBytes = await pdfDoc.save();

      // 4. Upload PDF to Drive
      const { Readable } = require('stream');
      const stream = Readable.from(Buffer.from(pdfBytes));
      const uploaded = await drive.files.create({
        requestBody: { name: `${name}_Certificate.pdf`, parents: [folderId] },
        media: { mimeType: 'application/pdf', body: stream },
        fields: 'id, webViewLink',
      });

      // 5. Make shareable
      await drive.permissions.create({
        fileId: uploaded.data.id,
        requestBody: { role: 'reader', type: 'anyone' },
      });

      const link = uploaded.data.webViewLink;

      // 6. Write back to Sheet
      if (writeBack && sheetId) {
        await sheets.spreadsheets.values.update({
          spreadsheetId: sheetId,
          range: `Sheet1!Z${i + 2}`,
          valueInputOption: 'RAW',
          requestBody: { values: [[link]] },
        });
      }

      results.push({ name, email: row[emailCol] || '', link, status: 'success' });

    } catch (err) {
      console.error(`Failed for ${name}:`, err.message);
      results.push({ name, email: row[emailCol] || '', link: '', status: 'failed', error: err.message });
    }
  }

  const folderLink = `https://drive.google.com/drive/folders/${folderId}`;
  res.json({ results, folderId, folderLink, total: participants.length, success: results.filter(r => r.status === 'success').length });
});

module.exports = router;