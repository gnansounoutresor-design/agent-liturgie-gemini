import 'dotenv/config';

import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { GoogleGenAI } from '@google/genai';
import {
  Document,
  Packer,
  Paragraph,
  HeadingLevel
} from 'docx';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const CORPUS_DIR = path.join(ROOT, 'corpus');
const HISTORY_DIR = path.join(ROOT, 'historique');

const MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
const PORT = Number(process.env.PORT) || 3000;

const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(express.static(PUBLIC_DIR));

const downloads = new Map();

function cleanText(value) {
  return String(value ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();
}

function safeFilename(value) {
  return String(value || 'travail_liturgique')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 70) || 'travail_liturgique';
}

function getField(body, name, maxLength = 12000) {
  const value = cleanText(body?.[name]);

  if (value.length > maxLength) {
    throw new Error(`Le champ "${name}" est trop long.`);
  }

  return value;
}

async function readTextFile(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return '';
  }
}

async function collectCorpus(directory, depth = 0) {
  if (depth > 3) return [];

  let entries;

  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }

  const files = [];

  for (const entry of entries) {
    if (
      entry.name.startsWith('.') ||
      entry.name === 'node_modules' ||
      entry.name === 'historique'
    ) {
      continue;
    }

    const fullPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...await collectCorpus(fullPath, depth + 1));
      continue;
    }

    if (!/\.(md|txt|json|jsonl)$/i.test(entry.name)) continue;

    if (entry.name === 'generations.jsonl' ||
        entry.name === 'valides.jsonl') {
      continue;
    }

    try {
      const stat = await fs.stat(fullPath);

      if (stat.size > 500_000) continue;

      const content = await fs.readFile(fullPath, 'utf8');

      if (content.trim()) {
        files.push({
          name: path.relative(CORPUS_DIR, fullPath),
          content: content.slice(0, 12000)
        });
      }
    } catch {
      // Ignore les fichiers illisibles.
    }

    if (files.length >= 15) break;
  }

  return files;
}

async function getStyleGuide() {
  return await readTextFile(
    path.join(CORPUS_DIR, 'guide_style_liturgique.md')
  );
}

async function getPreviousGenerations() {
  const file = path.join(HISTORY_DIR, 'generations.jsonl');
  const raw = await readTextFile(file);

  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-5)
    .map(line => {
      try {
        const entry = JSON.parse(line);
        return String(entry.text || '').slice(0, 2500);
      } catch {
        return '';
      }
    })
    .filter(Boolean);
}

function extractIntroductions(text) {
  const section = text.match(
    /(?:^|\n)\s*#{1,3}\s*(?:\d+[.)-]?\s*)?Introductions?\s+aux\s+lectures?\s*\n([\s\S]*?)(?=\n\s*#{1,3}\s*(?:\d+[.)-]?\s*)?Pri[eè]re\s+universelle|\s*$)/i
  );

  const source = section ? section[1] : text;

  const patterns = [
    /(?:\*\*)?\s*Premi[eè]re\s+lecture\s*(?:\*\*)?\s*[:：—-]\s*([\s\S]*?)(?=\n\s*(?:\*\*)?\s*Deuxi[eè]me\s+lecture|\n\s*#{1,3}\s|\s*$)/i,
    /(?:\*\*)?\s*Deuxi[eè]me\s+lecture\s*(?:\*\*)?\s*[:：—-]\s*([\s\S]*?)(?=\n\s*#{1,3}\s|\n\s*(?:\*\*)?\s*Pri[eè]re\s+universelle|\s*$)/i
  ];

  const results = patterns.map(pattern => {
    const match = source.match(pattern);
    return match ? cleanText(match[1]) : '';
  });

  if (results.every(Boolean)) return results;

  const lines = source.split(/\r?\n/).map(line => line.trim());

  const fallback = lines
    .filter(line =>
      line &&
      !/^#{1,3}\s/.test(line) &&
      !/^[-*]\s*$/.test(line)
    )
    .filter(line =>
      /Premi[eè]re\s+lecture|Deuxi[eè]me\s+lecture/i.test(line) ||
      /\([A-Za-zÀ-ÿ0-9 .,-]+\d+[, :]\s*\d+/i.test(line)
    )
    .slice(0, 2);

  return results.map((item, index) => {
    if (item) return item;

    const line = fallback[index] || '';
    return cleanText(
      line.replace(/^(?:[-*]\s*)?(?:\*\*)?\s*(?:Premi[eè]re|Deuxi[eè]me)\s+lecture\s*(?:\*\*)?\s*[:：—-]\s*/i, '')
    );
  });
}

function extractIntentions(text) {
  const section = text.match(
    /(?:^|\n)\s*#{1,3}\s*(?:\d+[.)-]?\s*)?Pri[eè]re\s+universelle\s*\n([\s\S]*)/i
  );

  const source = section ? section[1] : text;

  const matches = [
    ...source.matchAll(/(?:^|\n)\s*(?:\*\*)?\s*([1-4])[.)]\s+([\s\S]*?)(?=(?:\n\s*(?:\*\*)?\s*[1-4][.)]\s+)|\n\s*#{1,3}\s|$)/g)
  ];

  const results = matches.map(match => cleanText(match[2]));

  return results.slice(0, 4);
}

function normalizeIntroduction(value) {
  return cleanText(value)
    .replace(/^\s*[-*]\s*/, '')
    .replace(/^\*\*[^*]+\*\*\s*[:：—-]\s*/, '')
    .replace(/^\s*\d+[.)]\s*/, '')
    .trim();
}

function normalizeIntention(value) {
  return cleanText(value)
    .replace(/^\s*\d+[.)]\s*/, '')
    .replace(/^\s*[-*]\s*/, '')
    .replace(/\*\*/g, '')
    .trim();
}

async function createDocx(title, introductions, intentions) {
  const children = [
    new Paragraph({
      text: title,
      heading: HeadingLevel.TITLE
    }),
    new Paragraph({
      text: 'INTRODUCTIONS AUX LECTURES',
      heading: HeadingLevel.HEADING_1
    }),
    new Paragraph({
      text: 'Première lecture',
      heading: HeadingLevel.HEADING_2
    }),
    new Paragraph({ text: introductions[0] }),
    new Paragraph({
      text: 'Deuxième lecture',
      heading: HeadingLevel.HEADING_2
    }),
    new Paragraph({ text: introductions[1] }),
    new Paragraph({
      text: 'PRIÈRE UNIVERSELLE',
      heading: HeadingLevel.HEADING_1
    })
  ];

  intentions.forEach((intention, index) => {
    children.push(
      new Paragraph({
        text: `${index + 1}. ${intention}`
      }),
      new Paragraph({ text: '' })
    );
  });

  children.push(
    new Paragraph({
      text:
        'Note : vérifier les références bibliques et relire les textes ' +
        'avant leur utilisation pendant la célébration.'
    })
  );

  const doc = new Document({
    sections: [{ children }]
  });

  return await Packer.toBuffer(doc);
}

function extractErrorMessage(error) {
  const message = String(error?.message || 'Erreur inconnue');

  if (/API_KEY_INVALID|invalid api key|API key not valid/i.test(message)) {
    return 'La clé API Gemini est invalide. Vérifie la clé saisie.';
  }

  if (/quota|RESOURCE_EXHAUSTED/i.test(message)) {
    return 'Le quota Gemini est atteint. Réessaie plus tard ou vérifie ton quota.';
  }

  if (/503|UNAVAILABLE|high demand/i.test(message)) {
    return 'Gemini est momentanément indisponible. Réessaie dans quelques instants.';
  }

  if (/fetch failed|ECONNRESET|ETIMEDOUT/i.test(message)) {
    return 'Connexion à Gemini impossible. Vérifie ta connexion Internet.';
  }

  return message.slice(0, 500);
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'assistant-liturgique',
    model: MODEL
  });
});

app.post('/api/generate', async (req, res) => {
  try {
    const apiKey = String(req.get('X-Gemini-Api-Key') || '').trim();

    if (!apiKey || apiKey.length > 500) {
      return res.status(400).json({
        error: 'Saisis une clé API Gemini valide dans le formulaire.'
      });
    }

    const date = getField(req.body, 'date', 30);
    const celebration = getField(req.body, 'celebration', 300);
    const temps = getField(req.body, 'tempsLiturgique', 100);
    const annee = getField(req.body, 'anneeLiturgique', 10);
    const lecture1 = getField(req.body, 'premiereLecture', 1000);
    const lecture2 = getField(req.body, 'deuxiemeLecture', 1000);
    const evangile = getField(req.body, 'evangile', 1000);
    const textes = getField(req.body, 'textesBibliques', 12000);
    const consignes = getField(req.body, 'consignes', 4000);

    if (!celebration) {
      return res.status(400).json({
        error: 'Indique le nom de la célébration.'
      });
    }

    if (!lecture1 || !lecture2) {
      return res.status(400).json({
        error: 'Renseigne les références de la première et de la deuxième lecture.'
      });
    }

    const title = [
      celebration,
      temps,
      annee ? `Année ${annee}` : '',
      date
    ].filter(Boolean).join(' - ');

    const style = await getStyleGuide();
    const corpus = await collectCorpus(CORPUS_DIR);
    const history = await getPreviousGenerations();

    const corpusText = corpus.map(item =>
      `EXEMPLE : ${item.name}\n${item.content}`
    ).join('\n\n---\n\n').slice(0, 18000);

    const previousText = history.join('\n\n---\n\n').slice(0, 8000);

    const systemInstruction = `
Tu es un assistant de rédaction liturgique catholique francophone.

MISSION :
Produire exactement deux introductions aux lectures et quatre intentions
de prière universelle. Aucun autre contenu liturgique ne doit être ajouté.

STYLE :
${style || 'Français naturel, sobre, pastoral et facile à proclamer oralement.'}

RÈGLES :
- Les exemples locaux servent uniquement de références de style.
- N'invente aucune référence biblique.
- Respecte les références fournies par l'utilisateur.
- Ne prétends pas avoir vérifié une source si tu ne l'as pas consultée.
- Varie les constructions syntaxiques sans sacrifier la fidélité aux lectures.
- Chaque introduction doit être une seule phrase.
- Chaque intention doit être adressée explicitement à Dieu.
- Les quatre intentions doivent suivre cet ordre :
  1. L'Église : Pape, évêques, prêtres et mission de l'Église.
  2. Les dirigeants : justice, paix et bien commun.
  3. Les personnes souffrantes : malades, pauvres, opprimés et personnes éprouvées.
  4. L'assemblée : demande liée aux lectures.
- Chaque intention se termine exactement par « Seigneur, nous te prions. »
- Ne produis ni ouverture, ni chant, ni homélie, ni conclusion.
- Ne reprends pas mot pour mot les travaux antérieurs.
`.trim();

    const prompt = `
CÉLÉBRATION
Date : ${date || 'Non précisée'}
Nom : ${celebration}
Temps liturgique : ${temps || 'Non précisé'}
Année liturgique : ${annee || 'Non précisée'}

PREMIÈRE LECTURE :
${lecture1}

DEUXIÈME LECTURE :
${lecture2}

ÉVANGILE :
${evangile || 'Référence non fournie'}

TEXTES BIBLIQUES FOURNIS :
${textes || 'Aucun texte intégral fourni.'}

CONSIGNES LOCALES :
${consignes || 'Aucune.'}

EXEMPLES LOCAUX :
${corpusText || 'Aucun exemple disponible.'}

TRAVAUX ANTÉRIEURS À NE PAS COPIER :
${previousText || 'Aucun travail antérieur disponible.'}

PRODUIS EXACTEMENT CE FORMAT :

## Introductions aux lectures

**Première lecture** : Une seule phrase présentant le message central de la première lecture, suivie de sa référence biblique exacte entre parenthèses.

**Deuxième lecture** : Une seule phrase présentant le message central de la deuxième lecture, suivie de sa référence biblique exacte entre parenthèses.

## Prière universelle

1. [Intention pour l'Église, terminée par « Seigneur, nous te prions. »]

2. [Intention pour les dirigeants, terminée par « Seigneur, nous te prions. »]

3. [Intention pour les personnes souffrantes, terminée par « Seigneur, nous te prions. »]

4. [Intention pour l'assemblée, liée aux lectures et terminée par « Seigneur, nous te prions. »]

N'ajoute aucun commentaire avant ou après ce contenu.
`.trim();

    const ai = new GoogleGenAI({ apiKey });

    let response;

    try {
      response = await ai.models.generateContent({
        model: MODEL,
        contents: prompt,
        config: {
          systemInstruction,
          temperature: 0.75,
          maxOutputTokens: 3500
        }
      });
    } catch (error) {
      console.error('Erreur Gemini :', extractErrorMessage(error));

      return res.status(502).json({
        error: extractErrorMessage(error)
      });
    }

    const generated = cleanText(response.text);

    if (!generated) {
      return res.status(502).json({
        error: 'Gemini n’a renvoyé aucun texte. Réessaie.'
      });
    }

    let introductions = extractIntroductions(generated)
      .map(normalizeIntroduction)
      .filter(Boolean);

    let intentions = extractIntentions(generated)
      .map(normalizeIntention)
      .filter(Boolean);

    if (introductions.length !== 2 || intentions.length !== 4) {
      console.error(
        'Structure Gemini invalide :',
        introductions.length,
        'introductions ;',
        intentions.length,
        'intentions.'
      );

      return res.status(502).json({
        error:
          'Gemini a produit un format inattendu. Réessaie la génération.'
      });
    }

    intentions = intentions.map(intention => {
      if (!/Seigneur,\s*nous te prions\.?$/i.test(intention)) {
        return intention.replace(/\s*$/, '') +
          '\nSeigneur, nous te prions.';
      }

      return intention;
    });

    const buffer = await createDocx(title, introductions, intentions);

    const filename = `travail_liturgique_${safeFilename(title)}.docx`;
    const id = randomUUID();

    downloads.set(id, {
      buffer,
      filename,
      createdAt: Date.now()
    });

    // Les téléchargements temporaires expirent après 30 minutes.
    for (const [key, item] of downloads.entries()) {
      if (Date.now() - item.createdAt > 30 * 60 * 1000) {
        downloads.delete(key);
      }
    }

    try {
      await fs.mkdir(HISTORY_DIR, { recursive: true });

      const historyEntry = {
        date: new Date().toISOString(),
        title,
        celebration,
        temps,
        lecture1,
        lecture2,
        evangile,
        text: generated,
        source: 'interface_web'
      };

      await fs.appendFile(
        path.join(HISTORY_DIR, 'generations.jsonl'),
        JSON.stringify(historyEntry) + '\n',
        'utf8'
      );
    } catch (error) {
      console.error('Historique non enregistré :', error.message);
    }

    return res.json({
      introductions,
      intentions,
      qualityReport: {
        message:
          'Structure vérifiée : deux introductions et quatre intentions. ' +
          'La justesse biblique et théologique doit être relue.'
      },
      document: {
        filename,
        url: `/api/download/${id}`
      }
    });
  } catch (error) {
    console.error('Erreur serveur :', extractErrorMessage(error));

    return res.status(400).json({
      error: extractErrorMessage(error)
    });
  }
});

app.get('/api/download/:id', (req, res) => {
  const item = downloads.get(req.params.id);

  if (!item) {
    return res.status(404).json({
      error: 'Ce document a expiré ou n’existe plus. Génère-le à nouveau.'
    });
  }

  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  );

  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${item.filename}"`
  );

  return res.send(item.buffer);
});

app.get('*path', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('\n======================================');
  console.log('     ASSISTANT LITURGIQUE WEB');
  console.log('======================================');
  console.log(`Adresse : http://127.0.0.1:${PORT}`);
  console.log(`Modèle Gemini : ${MODEL}`);
  console.log('Arrêt : Ctrl+C');
  console.log('======================================\n');
});
