const express = require('express');
const router = express.Router();
const { google } = require('googleapis');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const axios = require('axios');

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
        const imgData = template.backgroundBase64.replace(/^data:image\/(png|jpeg|jpg);base64,/, '');
        const imgBytes = Buffer.from(imgData, 'base64');
        const isJpg = template.backgroundBase64.includes('jpeg') || template.backgroundBase64.includes('jpg');
        const img = isJpg ? await pdfDoc.embedJpg(imgBytes) : await pdfDoc.embedPng(imgBytes);
        page.drawImage(img, { x: 0, y: 0, width: template.width, height: template.height });
      } else {
        // White background
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

        // TTF URLs — pdf-lib CANNOT embed woff2, only ttf/otf
        // Static TTF URLs — variable fonts [wght].ttf don't give pdf-lib real bold/italic
        const GOOGLE_FONT_URLS = {
          'Montserrat': {
            regular:    'https://raw.githubusercontent.com/google/fonts/main/ofl/montserrat/static/Montserrat-Regular.ttf',
            bold:       'https://raw.githubusercontent.com/google/fonts/main/ofl/montserrat/static/Montserrat-Bold.ttf',
            italic:     'https://raw.githubusercontent.com/google/fonts/main/ofl/montserrat/static/Montserrat-Italic.ttf',
            boldItalic: 'https://raw.githubusercontent.com/google/fonts/main/ofl/montserrat/static/Montserrat-BoldItalic.ttf',
          },
          'Raleway': {
            regular:    'https://raw.githubusercontent.com/google/fonts/main/ofl/raleway/static/Raleway-Regular.ttf',
            bold:       'https://raw.githubusercontent.com/google/fonts/main/ofl/raleway/static/Raleway-Bold.ttf',
            italic:     'https://raw.githubusercontent.com/google/fonts/main/ofl/raleway/static/Raleway-Italic.ttf',
            boldItalic: 'https://raw.githubusercontent.com/google/fonts/main/ofl/raleway/static/Raleway-BoldItalic.ttf',
          },
          'Plus Jakarta Sans': {
            regular:    'https://raw.githubusercontent.com/google/fonts/main/ofl/plusjakartasans/static/PlusJakartaSans-Regular.ttf',
            bold:       'https://raw.githubusercontent.com/google/fonts/main/ofl/plusjakartasans/static/PlusJakartaSans-Bold.ttf',
            italic:     'https://raw.githubusercontent.com/google/fonts/main/ofl/plusjakartasans/static/PlusJakartaSans-Italic.ttf',
            boldItalic: 'https://raw.githubusercontent.com/google/fonts/main/ofl/plusjakartasans/static/PlusJakartaSans-BoldItalic.ttf',
          },
          'EB Garamond': {
            regular:    'https://raw.githubusercontent.com/google/fonts/main/ofl/ebgaramond/static/EBGaramond-Regular.ttf',
            bold:       'https://raw.githubusercontent.com/google/fonts/main/ofl/ebgaramond/static/EBGaramond-Bold.ttf',
            italic:     'https://raw.githubusercontent.com/google/fonts/main/ofl/ebgaramond/static/EBGaramond-Italic.ttf',
            boldItalic: 'https://raw.githubusercontent.com/google/fonts/main/ofl/ebgaramond/static/EBGaramond-BoldItalic.ttf',
          },
          'Playfair Display': {
            regular:    'https://raw.githubusercontent.com/google/fonts/main/ofl/playfairdisplay/static/PlayfairDisplay-Regular.ttf',
            bold:       'https://raw.githubusercontent.com/google/fonts/main/ofl/playfairdisplay/static/PlayfairDisplay-Bold.ttf',
            italic:     'https://raw.githubusercontent.com/google/fonts/main/ofl/playfairdisplay/static/PlayfairDisplay-Italic.ttf',
            boldItalic: 'https://raw.githubusercontent.com/google/fonts/main/ofl/playfairdisplay/static/PlayfairDisplay-BoldItalic.ttf',
          },
          'Cormorant Garamond': {
            regular:    'https://raw.githubusercontent.com/google/fonts/main/ofl/cormorantgaramond/CormorantGaramond-Regular.ttf',
            bold:       'https://raw.githubusercontent.com/google/fonts/main/ofl/cormorantgaramond/CormorantGaramond-Bold.ttf',
            italic:     'https://raw.githubusercontent.com/google/fonts/main/ofl/cormorantgaramond/CormorantGaramond-Italic.ttf',
            boldItalic: 'https://raw.githubusercontent.com/google/fonts/main/ofl/cormorantgaramond/CormorantGaramond-BoldItalic.ttf',
          },
          'Dancing Script': {
            regular:    'https://raw.githubusercontent.com/google/fonts/main/ofl/dancingscript/static/DancingScript-Regular.ttf',
            bold:       'https://raw.githubusercontent.com/google/fonts/main/ofl/dancingscript/static/DancingScript-Bold.ttf',
          },
          'Cinzel': {
            regular:    'https://raw.githubusercontent.com/google/fonts/main/ofl/cinzel/static/Cinzel-Regular.ttf',
            bold:       'https://raw.githubusercontent.com/google/fonts/main/ofl/cinzel/static/Cinzel-Bold.ttf',
          },
          'JetBrains Mono': {
            regular:    'https://raw.githubusercontent.com/google/fonts/main/ofl/jetbrainsmono/static/JetBrainsMono-Regular.ttf',
            bold:       'https://raw.githubusercontent.com/google/fonts/main/ofl/jetbrainsmono/static/JetBrainsMono-Bold.ttf',
            italic:     'https://raw.githubusercontent.com/google/fonts/main/ofl/jetbrainsmono/static/JetBrainsMono-Italic.ttf',
            boldItalic: 'https://raw.githubusercontent.com/google/fonts/main/ofl/jetbrainsmono/static/JetBrainsMono-BoldItalic.ttf',
          },
        };

        let font;
        const isBold   = !!field.bold;
        const isItalic = !!field.italic;

        // Build variant suffix for standard font lookup
        const variantSuffix = (isBold && isItalic) ? '-BoldItalic' : isBold ? '-Bold' : isItalic ? '-Italic' : '';

        if (STANDARD_FONTS[field.fontFamily]) {
          const stdKey = field.fontFamily + variantSuffix;
          font = await pdfDoc.embedFont(STANDARD_FONTS[stdKey] || STANDARD_FONTS[field.fontFamily]);

        } else if (GOOGLE_FONT_URLS[field.fontFamily]) {
          try {
            const entry = GOOGLE_FONT_URLS[field.fontFamily];
            // Pick the best variant: boldItalic > bold/italic > regular
            let url = entry.regular;
            if (isBold && isItalic && entry.boldItalic) url = entry.boldItalic;
            else if (isBold && entry.bold)              url = entry.bold;
            else if (isItalic && entry.italic)          url = entry.italic;

            const fontResp = await axios.get(url, { responseType: 'arraybuffer' });
            font = await pdfDoc.embedFont(fontResp.data, { subset: true });
          } catch (e) {
            console.warn(`Font load failed for ${field.fontFamily}: ${e.message}, falling back to Helvetica`);
            font = await pdfDoc.embedFont(StandardFonts.Helvetica);
          }
        } else {
          font = await pdfDoc.embedFont(StandardFonts.Helvetica);
        }
        const col  = hexToRgb(field.color || '#000000');

        // Convert % positions to absolute (PDF y is from bottom)
        const x = (field.x / 100) * template.width;
        const y = template.height - (field.y / 100) * template.height - field.fontSize;

        const letterSpacing = field.letterSpacing || 0;
        const fieldWidth    = (field.width / 100) * template.width;

        if (letterSpacing > 0) {
          // pdf-lib has no native letter-spacing — draw char by char
          const chars    = text.split('');
          let totalWidth = chars.reduce((sum, ch) => sum + font.widthOfTextAtSize(ch, field.fontSize) + letterSpacing, -letterSpacing);
          let startX     = x;
          if (field.align === 'center') startX = x + (fieldWidth - totalWidth) / 2;
          else if (field.align === 'right') startX = x + fieldWidth - totalWidth;

          let cx = startX;
          for (const ch of chars) {
            page.drawText(ch, { x: cx, y, size: field.fontSize, font, color: rgb(col.r, col.g, col.b) });
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
          page.drawText(text, { x: drawX, y, size: field.fontSize, font, color: rgb(col.r, col.g, col.b) });
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