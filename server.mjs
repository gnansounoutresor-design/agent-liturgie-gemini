import 'dotenv/config';

import express from 'express';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { GoogleGenAI } from '@google/genai';
import { getAelfLiturgy } from './aelf-calendar.mjs';
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
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const PORT = Number(process.env.PORT) || 3000;

const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(express.static(PUBLIC_DIR));


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

async function createDocx(title, introductions, intentions, extras = {}) {
  const children = [];
  if (extras.date) children.push(new Paragraph({ text: extras.date }));
  if (extras.tone) children.push(new Paragraph({ text: `Ton de l’assemblée : ${extras.tone}` }));
  children.push(
    new Paragraph({
      text: title,
      heading: HeadingLevel.TITLE
    })
  );
  if (extras.welcome) {
    children.push(
      new Paragraph({ text: 'MOT D’ACCUEIL', heading: HeadingLevel.HEADING_1 }),
      new Paragraph({ text: extras.welcome })
    );
  }
  if (Array.isArray(extras.readings) && extras.readings.length) {
    children.push(new Paragraph({ text: 'LECTURES DU JOUR', heading: HeadingLevel.HEADING_1 }));
    extras.readings.forEach((reading) => {
      children.push(new Paragraph({ text: `${reading.label} — ${reading.reference}`, heading: HeadingLevel.HEADING_2 }));
      if (reading.text) children.push(new Paragraph({ text: reading.text }));
    });
  }
  children.push(
    new Paragraph({ text: 'INTRODUCTIONS AUX LECTURES', heading: HeadingLevel.HEADING_1 }),
    new Paragraph({ text: 'Première lecture', heading: HeadingLevel.HEADING_2 }),
    new Paragraph({ text: introductions[0] })
  );
  if (extras.psalmIntro) children.push(
    new Paragraph({ text: 'Psaume', heading: HeadingLevel.HEADING_2 }),
    new Paragraph({ text: extras.psalmIntro })
  );
  children.push(
    new Paragraph({ text: 'Deuxième lecture', heading: HeadingLevel.HEADING_2 }),
    new Paragraph({ text: introductions[1] }),
    new Paragraph({ text: 'PRIÈRE UNIVERSELLE', heading: HeadingLevel.HEADING_1 })
  );

  intentions.forEach((intention, index) => {
    children.push(
      new Paragraph({
        text: `${index + 1}. ${intention}`
      }),
      new Paragraph({ text: '' })
    );
  });

  if (extras.conclusion) children.push(
    new Paragraph({ text: 'MOT DE CONCLUSION', heading: HeadingLevel.HEADING_1 }),
    new Paragraph({ text: extras.conclusion })
  );

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

function configuredProviders(personalGeminiKey = '') {
  const providers = [];
  const geminiKey = String(process.env.GEMINI_API_KEY || personalGeminiKey).trim();
  if (geminiKey) providers.push({ name: 'Gemini', run: (prompt, system) => callGemini(geminiKey, prompt, system) });
  if (process.env.DEEPSEEK_API_KEY) providers.push({ name: 'DeepSeek', run: (prompt, system) => callOpenAICompatible({
    key: process.env.DEEPSEEK_API_KEY, model: DEEPSEEK_MODEL,
    endpoint: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/chat/completions', prompt, system
  }) });
  if (process.env.OPENAI_API_KEY) providers.push({ name: 'OpenAI', run: (prompt, system) => callOpenAICompatible({
    key: process.env.OPENAI_API_KEY, model: OPENAI_MODEL,
    endpoint: 'https://api.openai.com/v1/chat/completions', prompt, system
  }) });
  return providers;
}

async function callGemini(apiKey, prompt, system) {
  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.generateContent({
    model: MODEL, contents: prompt,
    config: { systemInstruction: system, temperature: 0.7, maxOutputTokens: 3500, httpOptions: { timeout: 35000 } }
  });
  return cleanText(response.text);
}

async function callOpenAICompatible({ key, model, endpoint, prompt, system }) {
  const response = await fetch(endpoint, {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, temperature: 0.7, max_tokens: 3500, messages: [
      { role: 'system', content: system }, { role: 'user', content: prompt }
    ] }), signal: AbortSignal.timeout(35000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${model} HTTP ${response.status}: ${data?.error?.message || 'requête refusée'}`);
  return cleanText(data?.choices?.[0]?.message?.content);
}

function localDraft({ celebration, premiereLecture, deuxiemeLecture, evangile, ton }) {
  const tone = /festif|chaleureux|fraternel/i.test(ton || '') ? 'avec confiance et fraternité' : 'dans le recueillement';
  const one = premiereLecture || 'la première lecture';
  const two = deuxiemeLecture || 'la deuxième lecture';
  const gospel = evangile || celebration || 'l’Évangile du jour';
  return `## Introductions aux lectures\n\n**Première lecture** : Écoutons la Parole de Dieu dans ${one}, qui nous invite à accueillir son appel ${tone}.\n\n**Deuxième lecture** : Dans ${two}, laissons-nous éclairer par l’espérance et la fidélité que Dieu fait grandir en son peuple.\n\n## Prière universelle\n\n1. Pour l’Église, afin qu’elle annonce avec joie la Bonne Nouvelle de ${gospel}, et accompagne chacun sur le chemin de la foi. Seigneur, nous te prions.\n\n2. Pour les responsables des nations, afin qu’ils servent la justice, protègent les plus fragiles et travaillent à la paix. Seigneur, nous te prions.\n\n3. Pour les personnes malades, isolées, pauvres ou éprouvées, afin qu’elles trouvent réconfort, solidarité et espérance. Seigneur, nous te prions.\n\n4. Pour notre assemblée réunie aujourd’hui, afin que ${celebration || 'la Parole entendue'} porte des fruits dans nos vies et nos engagements. Seigneur, nous te prions.`;
}

function supabaseConfig() {
  return {
    url: String(process.env.SUPABASE_URL || '').replace(/\/$/, ''),
    anonKey: String(process.env.SUPABASE_ANON_KEY || '')
  };
}

async function supabaseFetch(url, anonKey, pathname, { method = 'GET', token = '', body } = {}) {
  const response = await fetch(`${url}${pathname}`, {
    method,
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${token || anonKey}`,
      'Content-Type': 'application/json',
      ...(method === 'POST' || method === 'PATCH' ? { Prefer: 'return=representation,resolution=merge-duplicates' } : {})
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(12000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data?.msg || data?.message || data?.error_description || data?.error || 'Service de bibliothèque indisponible.'), { status: response.status });
  return data;
}

async function authenticatedSupabaseUser(req) {
  const { url, anonKey } = supabaseConfig();
  if (!url || !anonKey) throw Object.assign(new Error('La synchronisation en ligne n’est pas configurée.'), { status: 503 });
  const token = String(req.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!token || token.length > 6000) throw Object.assign(new Error('Connectez-vous pour accéder aux travaux en ligne.'), { status: 401 });
  const user = await supabaseFetch(url, anonKey, '/auth/v1/user', { token });
  return { url, anonKey, token, user };
}

async function generateWithFallback(prompt, system, localText, personalGeminiKey = '') {
  const failures = [];
  for (const provider of configuredProviders(personalGeminiKey)) {
    try {
      const text = await provider.run(prompt, system);
      if (text) return { text, provider: provider.name, degraded: false };
      failures.push(`${provider.name}: réponse vide`);
    } catch (error) {
      failures.push(`${provider.name}: ${extractErrorMessage(error)}`);
      console.warn(`Fournisseur ${provider.name} indisponible, essai du secours.`);
    }
  }
  return { text: localText, provider: 'local', degraded: true, detail: failures.join(' | ') };
}

app.get('/api/liturgy', async (req, res) => {
  try {
    const date = String(req.query.date || '');
    const liturgy = await getAelfLiturgy(date);
    return res.json(liturgy);
  } catch (error) {
    return res.status(400).json({
      error: error instanceof Error
        ? error.message
        : 'Impossible de récupérer le calendrier liturgique.'
    });
  }
});

app.post('/api/auth/:action', async (req, res) => {
  const action = String(req.params.action || '');
  if (!['login', 'signup', 'refresh'].includes(action)) return res.status(404).json({ error: 'Action de connexion inconnue.' });
  try {
    const { url, anonKey } = supabaseConfig();
    if (!url || !anonKey) return res.status(503).json({ error: 'La connexion en ligne n’est pas encore configurée.' });
    if (action === 'refresh') {
      const refreshToken = getField(req.body, 'refreshToken', 6000);
      if (!refreshToken) return res.status(400).json({ error: 'Session expirée : reconnectez-vous.' });
      const refreshed = await supabaseFetch(url, anonKey, '/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: refreshToken } });
      return res.json({ accessToken: refreshed.access_token || '', refreshToken: refreshed.refresh_token || '', user: refreshed.user || null });
    }
    const email = getField(req.body, 'email', 254).toLowerCase();
    const password = getField(req.body, 'password', 200);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 8) {
      return res.status(400).json({ error: 'Saisissez une adresse e-mail valide et un mot de passe de huit caractères minimum.' });
    }
    const endpoint = action === 'login' ? '/auth/v1/token?grant_type=password' : '/auth/v1/signup';
    const result = await supabaseFetch(url, anonKey, endpoint, { method: 'POST', body: { email, password } });
    return res.json({ accessToken: result.access_token || '', refreshToken: result.refresh_token || '', user: result.user || null, confirmationRequired: !result.access_token });
  } catch (error) {
    const status = Number(error?.status) || 502;
    return res.status(status).json({ error: String(error?.message || 'Connexion au service impossible.').slice(0, 300) });
  }
});

app.get('/api/works', async (req, res) => {
  try {
    const { url, anonKey, token } = await authenticatedSupabaseUser(req);
    const rows = await supabaseFetch(url, anonKey, '/rest/v1/liturgical_works?select=id,title,work,updated_at&order=updated_at.desc&limit=80', { token });
    return res.json({ works: rows.map((row) => Object.assign({}, row.work, { id: row.id, title: row.title, updatedAt: row.updated_at })) });
  } catch (error) {
    return res.status(Number(error?.status) || 502).json({ error: String(error?.message || 'Impossible de charger les travaux en ligne.').slice(0, 300) });
  }
});

app.post('/api/works', async (req, res) => {
  try {
    const { url, anonKey, token } = await authenticatedSupabaseUser(req);
    const work = req.body?.work;
    if (!work || typeof work !== 'object' || typeof work.title !== 'string' || !Array.isArray(work.intros) || work.intros.length !== 2 || !Array.isArray(work.intentions) || work.intentions.length < 4 || work.intentions.length > 20) {
      return res.status(400).json({ error: 'Ce travail ne contient pas tous les textes nécessaires.' });
    }
    const id = String(work.id || randomUUID()).slice(0, 100);
    const updatedAt = new Date().toISOString();
    const row = { id, title: work.title.slice(0, 160), work: Object.assign({}, work, { id, updatedAt }), updated_at: updatedAt };
    await supabaseFetch(url, anonKey, '/rest/v1/liturgical_works?on_conflict=id', { method: 'POST', token, body: row });
    return res.json({ id, updatedAt });
  } catch (error) {
    return res.status(Number(error?.status) || 502).json({ error: String(error?.message || 'Impossible de synchroniser le travail.').slice(0, 300) });
  }
});

app.delete('/api/works/:id', async (req, res) => {
  try {
    const { url, anonKey, token } = await authenticatedSupabaseUser(req);
    await supabaseFetch(url, anonKey, `/rest/v1/liturgical_works?id=eq.${encodeURIComponent(String(req.params.id || '').slice(0, 100))}`, { method: 'DELETE', token });
    return res.json({ ok: true });
  } catch (error) {
    return res.status(Number(error?.status) || 502).json({ error: String(error?.message || 'Impossible de supprimer ce travail en ligne.').slice(0, 300) });
  }
});

app.post('/api/export-docx', async (req, res) => {
  try {
    const title = String(req.body?.title || 'Travail liturgique').slice(0, 160);
    const date = String(req.body?.date || '').slice(0, 30);
    const tone = String(req.body?.tone || '').slice(0, 120);
    const welcome = String(req.body?.welcome || '').slice(0, 6000);
    const psalmIntro = String(req.body?.psalmIntro || '').slice(0, 6000);
    const conclusion = String(req.body?.conclusion || '').slice(0, 6000);
    const introductions = Array.isArray(req.body?.introductions) ? req.body.introductions.slice(0, 2).map((item) => String(item || '').slice(0, 6000)) : [];
    const intentions = Array.isArray(req.body?.intentions) ? req.body.intentions.slice(0, 20).map((item) => String(item || '').slice(0, 4000)) : [];
    const readings = Array.isArray(req.body?.readings) ? req.body.readings.slice(0, 4).map((reading) => ({
      label: String(reading?.label || '').slice(0, 80),
      reference: String(reading?.reference || '').slice(0, 160),
      text: String(reading?.text || '').slice(0, 20000)
    })) : [];

    if (introductions.length !== 2 || intentions.length < 4) {
      return res.status(400).json({ error: 'Le document doit contenir deux introductions et au moins quatre intentions.' });
    }
    if (introductions.some((text) => !text.trim()) || intentions.some((text) => !text.trim())) {
      return res.status(400).json({ error: 'Complétez les deux introductions et les quatre intentions avant l’export.' });
    }
    const buffer = await createDocx(title, introductions, intentions, { date, tone, welcome, psalmIntro, conclusion, readings });
    const slug = title.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'travail-liturgique';
    return res.json({ document: {
      filename: `${slug}.docx`,
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      base64: buffer.toString('base64')
    } });
  } catch (error) {
    console.error('Erreur export Word :', extractErrorMessage(error));
    return res.status(500).json({ error: 'Impossible de préparer le document Word.' });
  }
});

app.get('/api/health', (_req, res) => {
  const providers = configuredProviders().map((provider) => provider.name);
  res.json({
    ok: true,
    service: 'assistant-liturgique',
    model: MODEL,
    geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
    providers,
    localFallback: true,
    cloudSyncConfigured: Boolean(supabaseConfig().url && supabaseConfig().anonKey)
  });
});

app.post('/api/rewrite', async (req, res) => {
  try {
    const personalKey = String(req.get('X-Gemini-Api-Key') || '').trim();
    if (personalKey.length > 500) return res.status(400).json({ error: 'Clé de dépannage trop longue.' });
    const kind = String(req.body?.kind || '');
    const isIntroduction = kind === 'introduction';
    const content = getField(req.body, 'content', 6000);
    const instruction = getField(req.body, 'instruction', 1000);
    const reference = getField(req.body, 'reference', 300);
    if (!content) return res.status(400).json({ error: 'Le texte à réécrire est vide.' });

    const system = 'Tu es un rédacteur liturgique catholique francophone. Réécris uniquement le passage demandé, avec un ton pastoral et facile à proclamer. Préserve fidèlement le sens. Une intention se termine exactement par « Seigneur, nous te prions. ». N’ajoute aucun titre ni commentaire.';
    const prompt = `Type : ${isIntroduction ? 'introduction à une lecture' : 'intention de prière universelle'}\nRéférence : ${reference || 'aucune'}\nConsigne : ${instruction || 'Rendre le texte plus clair et naturel à proclamer'}\n\nTexte à reprendre :\n${content}`;
    const result = await generateWithFallback(prompt, system, content, personalKey);
    let text = result.text;
    if (result.provider === 'local' && !isIntroduction && !/Seigneur,\s*nous te prions\.?$/i.test(text)) {
      text = `${text.replace(/[.!?\s]+$/, '')}. Seigneur, nous te prions.`;
    }
    return res.json({ text, provider: result.provider, degraded: result.degraded });
  } catch (error) {
    console.error('Erreur de réécriture Gemini :', extractErrorMessage(error));
    return res.status(502).json({ error: extractErrorMessage(error) });
  }
});

app.post('/api/generate', async (req, res) => {
  try {
    // La clé du déploiement reste côté serveur. Une clé personnelle peut
    // toujours être utilisée en local, sans jamais être conservée.
    const personalKey = String(req.get('X-Gemini-Api-Key') || '').trim();
    if (personalKey.length > 500) return res.status(400).json({ error: 'Clé de dépannage trop longue.' });

    const date = getField(req.body, 'date', 30);
    const celebration = getField(req.body, 'celebration', 300);
    const temps = getField(req.body, 'tempsLiturgique', 100);
    const annee = getField(req.body, 'anneeLiturgique', 10);
    const lecture1 = getField(req.body, 'premiereLecture', 1000);
    const lecture2 = getField(req.body, 'deuxiemeLecture', 1000);
    const evangile = getField(req.body, 'evangile', 1000);
    const textes = getField(req.body, 'textesBibliques', 12000);
    const consignes = getField(req.body, 'consignes', 4000);
    const ton = getField(req.body, 'ton', 120) || 'Paroissial, sobre';

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

TON DE L’ASSEMBLÉE :
${ton}

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

    const result = await generateWithFallback(prompt, systemInstruction, localDraft({ celebration, premiereLecture: lecture1, deuxiemeLecture: lecture2, evangile, ton }), personalKey);
    const generated = cleanText(result.text);

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

      // Un format fournisseur défectueux ne doit pas rendre l'application inutilisable.
      const local = cleanText(localDraft({ celebration, premiereLecture: lecture1, deuxiemeLecture: lecture2, evangile, ton }));
      introductions = extractIntroductions(local).map(normalizeIntroduction).filter(Boolean);
      intentions = extractIntentions(local).map(normalizeIntention).filter(Boolean);
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
        source: result.provider
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
          `Structure vérifiée : deux introductions et quatre intentions. Source : ${result.provider}${result.degraded ? ' (mode local hors API)' : ''}. ` +
          'La justesse biblique et théologique doit être relue.'
      },
      document: {
        filename,
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        base64: buffer.toString('base64')
      }
    });
  } catch (error) {
    console.error('Erreur serveur :', extractErrorMessage(error));

    return res.status(400).json({
      error: extractErrorMessage(error)
    });
  }
});

app.get('*path', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

export default app;

// Vercel importe l'application comme une fonction. En local, npm start
// démarre le même serveur Express de façon classique.
if (process.env.VERCEL !== '1') {
  const httpServer = app.listen(PORT, '0.0.0.0', () => {
    console.log('\n======================================');
    console.log('     ASSISTANT LITURGIQUE WEB');
    console.log('======================================');
    console.log(`Adresse : http://127.0.0.1:${PORT}`);
    console.log(`Modèle Gemini : ${MODEL}`);
    console.log('Arrêt : Ctrl+C');
    console.log('======================================\n');
  });
  httpServer.on('error', (error) => {
    console.error(`Impossible de démarrer le serveur sur le port ${PORT} : ${error.message}`);
    process.exitCode = 1;
  });
}
