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
          'Helvetica':      StandardFonts.Helvetica,
          'Times New Roman':StandardFonts.TimesRoman,
          'Courier New':    StandardFonts.Courier,
          'Helvetica Bold': StandardFonts.HelveticaBold,
          'Times Bold':     StandardFonts.TimesRomanBold,
        };

        const GOOGLE_FONT_URLS = {
          'Montserrat':         'https://fonts.gstatic.com/s/montserrat/v26/JTUSjIg1_i6t8kCHKm459Wlhyw.woff2',
          'Raleway':            'https://fonts.gstatic.com/s/raleway/v28/1Ptxg8zYS_SKggPN4iEgvnHyvveLxVvaorCIPrE.woff2',
          'Plus Jakarta Sans':  'https://fonts.gstatic.com/s/plusjakartasans/v8/LDIoaomQNQcsA88c7O9yZ4KMCoOg4Ko20yygg7c.woff2',
          'EB Garamond':        'https://fonts.gstatic.com/s/ebgaramond/v26/SlGDmQSNjdsmc35JDF1K5E55YMjF_7DPuGi-6_RUA4V-e6yHgQ.woff2',
          'Playfair Display':   'https://fonts.gstatic.com/s/playfairdisplay/v36/nuFvD-vYSZviVYUb_rj3ij__anPXJzDwcbmjWBN2PKdFvUDQ.woff2',
          'Cormorant Garamond': 'https://fonts.gstatic.com/s/cormorantgaramond/v16/co3WmX5slCNuHLi8bLeY9MK7whWMhyjYqXtK.woff2',
          'Dancing Script':     'https://fonts.gstatic.com/s/dancingscript/v25/If2cXTr6YS-zF4S-kcSWSVi_sxjsohD9F50Ruu7BMSo3Sup5.woff2',
          'Cinzel':             'https://fonts.gstatic.com/s/cinzel/v23/8vIU7ww63mVu7gt79mT7.woff2',
          'JetBrains Mono':     'https://fonts.gstatic.com/s/jetbrainsmono/v18/tDbY2o-flEEny0FZhsfKu5WU4zr3E_BX0PnT8RD8yKxTOlOV.woff2',
        };

        let font;
        if (STANDARD_FONTS[field.fontFamily]) {
          font = await pdfDoc.embedFont(STANDARD_FONTS[field.fontFamily]);
        } else if (GOOGLE_FONT_URLS[field.fontFamily]) {
          try {
            const fontResp = await axios.get(GOOGLE_FONT_URLS[field.fontFamily], { responseType: 'arraybuffer' });
            font = await pdfDoc.embedFont(fontResp.data);
          } catch (e) {
            console.warn(`Font load failed for ${field.fontFamily}, falling back to Helvetica`);
            font = await pdfDoc.embedFont(StandardFonts.Helvetica);
          }
        } else {
          font = await pdfDoc.embedFont(StandardFonts.Helvetica);
        }
        const col  = hexToRgb(field.color || '#000000');

        // Convert % positions to absolute (PDF y is from bottom)
        const x = (field.x / 100) * template.width;
        const y = template.height - (field.y / 100) * template.height - field.fontSize;

        // Center alignment
        if (field.align === 'center') {
          const textWidth = font.widthOfTextAtSize(text, field.fontSize);
          const fieldWidth = (field.width / 100) * template.width;
          const centeredX  = x + (fieldWidth - textWidth) / 2;
          page.drawText(text, { x: centeredX, y, size: field.fontSize, font, color: rgb(col.r, col.g, col.b) });
        } else {
          page.drawText(text, { x, y, size: field.fontSize, font, color: rgb(col.r, col.g, col.b) });
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